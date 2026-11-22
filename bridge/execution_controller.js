import { setTimeout as delay } from 'node:timers/promises';

const TERMINAL_STATUSES = new Set([
  'succeeded',
  'partial',
  'failed',
  'cancelled',
  'preempted',
  'dead',
  'disconnected',
  'blocked',
  'unknown',
]);

export class ExecutionController {
  constructor({ onChange = () => {}, ledgerLimit = 256 } = {}) {
    this.onChange = onChange;
    this.ledgerLimit = Math.max(8, Number(ledgerLimit) || 256);
    this.queue = [];
    this.active = null;
    this.epoch = 0;
    this.sequence = 0;
    this.records = new Map();
    this.pumping = false;
    this.closedStatus = '';
  }

  get safetyActive() {
    return this.active?.kind === 'safety' || this.queue.some((task) => task.kind === 'safety');
  }

  snapshot() {
    return {
      active_action_id: this.active?.id || null,
      safety_active: this.safetyActive,
      epoch: this.epoch,
    };
  }

  enqueue(task) {
    if (!task || typeof task.run !== 'function') throw new TypeError('execution task requires run()');
    const id = String(task.id || `bridge-${Date.now()}-${++this.sequence}`);
    const existing = this.records.get(id);
    if (existing) return { accepted: false, duplicate: true, record: { ...existing } };
    if (task.dedupeKey) {
      const duplicate = [this.active, ...this.queue].find((candidate) => candidate?.dedupeKey === task.dedupeKey);
      if (duplicate) {
        return { accepted: false, duplicate: true, record: { ...this.records.get(duplicate.id) } };
      }
    }
    if (this.closedStatus && task.kind !== 'safety') {
      const record = this._remember(id, 'blocked', task, { detail: this.closedStatus });
      this._emit('rejected');
      return { accepted: false, record: { ...record } };
    }

    const entry = {
      ...task,
      id,
      priority: Number.isFinite(Number(task.priority)) ? Number(task.priority) : 3,
      sequence: this.sequence++,
      kind: task.kind || 'action',
    };
    this.queue.push(entry);
    this.queue.sort((left, right) => {
      const leftKind = left.kind === 'safety' ? 0 : 1;
      const rightKind = right.kind === 'safety' ? 0 : 1;
      return leftKind - rightKind || left.priority - right.priority || left.sequence - right.sequence;
    });
    this._remember(id, 'queued', entry);
    if (entry.kind === 'safety' && this.active?.kind !== 'safety') {
      this._cancelActive('临时安全避险抢占', 'preempted', 'safety_priority');
    } else if (entry.kind === 'safety' && this.active?.kind === 'safety' && entry.priority < this.active.priority) {
      this._cancelActive('更高优先级的安全动作接管', 'preempted', 'safety_priority');
    } else if (
      this.active && entry.priority < this.active.priority && this.active.cancellable !== false &&
      this.active.kind !== 'safety'
    ) {
      this._cancelActive('被更高优先级动作抢占', 'preempted');
    }
    this._emit('queued');
    this._pump();
    return { accepted: true, record: { ...this.records.get(id) } };
  }

  cancel(id, reason = '已取消', status = 'cancelled') {
    const target = String(id || '');
    const index = this.queue.findIndex((task) => task.id === target);
    if (index >= 0) {
      const [task] = this.queue.splice(index, 1);
      this._finishQueued(task, status, reason);
      this._emit('queue_cancelled');
      return true;
    }
    if (this.active?.id === target) {
      this._cancelActive(reason, status);
      return true;
    }
    return false;
  }

  stop(reason = '收到停止指令', status = 'cancelled') {
    const queued = this.queue.splice(0, this.queue.length);
    for (const task of queued) this._finishQueued(task, status, reason);
    this._cancelActive(reason, status);
    this._emit('stopped');
    return queued.length;
  }

  block(status, reason = '') {
    this.closedStatus = status || 'disconnected';
    const queued = this.queue.splice(0, this.queue.length);
    for (const task of queued) this._finishQueued(task, this.closedStatus, reason || this.closedStatus);
    this._cancelActive(reason || this.closedStatus, this.closedStatus);
    this._emit('blocked');
  }

  unblock() {
    if (!this.closedStatus) return;
    this.closedStatus = '';
    this._emit('unblocked');
    this._pump();
  }

  status(id) {
    const record = this.records.get(String(id || ''));
    return record ? { ...record, data: record.data ? structuredCloneSafe(record.data) : undefined } : null;
  }

  // 同步读取当前世界，只记回执；移动和交互仍由活动动作持有。
  read(id, tool, reader, statusForError) {
    const existing = this.records.get(id);
    if (existing) return existing;
    let result;
    try {
      result = { status: 'succeeded', detail: reader() };
    } catch (error) {
      result = { status: statusForError(error), detail: String(error?.message || error) };
    }
    return this._remember(id, result.status, { tool }, result);
  }

  updateRecord(id, result) {
    const record = this.records.get(String(id || ''));
    if (!record || !result || typeof result !== 'object') return false;
    if (result.status) record.status = result.status;
    if (result.detail !== undefined) record.detail = String(result.detail);
    if (result.data && typeof result.data === 'object') record.data = structuredCloneSafe(result.data);
    record.updated_at = Date.now();
    return true;
  }

  _cancelActive(reason, status, cause = '') {
    const task = this.active;
    if (!task) return false;
    const token = task.token;
    if (!token.cancelled || status === 'cancelled' || status === 'dead' || status === 'disconnected') {
      token.cancelled = true;
      token.cancelReason = String(reason || status);
      token.cancelStatus = status;
      token.cancelCause = status === 'preempted'
        ? (cause || (task.kind === 'safety' ? 'safety_priority' : 'player_priority'))
        : '';
      task.abortController.abort();
      if (!token.cancelHookCalled && typeof task.onCancel === 'function') {
        token.cancelHookCalled = true;
        try {
          task.onCancel(token.cancelReason, status, token);
        } catch (error) {
          token.cancelHookError = String(error?.message || error);
        }
      }
      const record = this.records.get(task.id);
      if (record) {
        record.status = status === 'preempted' ? 'preempting' : 'cancelling';
        record.requested_status = status;
        record.detail = token.cancelReason;
      }
      this._emit('active_cancelled');
      return true;
    }
    return false;
  }

  _pump() {
    if (this.pumping) return;
    this.pumping = true;
    void this._runQueue();
  }

  async _runQueue() {
    try {
      while (!this.active && this.queue.length > 0) {
        const task = this.queue.shift();
        if (this.closedStatus && task.kind !== 'safety') {
          this._finishQueued(task, this.closedStatus, this.closedStatus);
          continue;
        }
        const abortController = new AbortController();
        task.abortController = abortController;
        const token = {
          wait: ms => delay(ms, undefined, { signal: abortController.signal }),
          actionId: task.id,
          deadlineAt: Number.isFinite(task.deadlineAt) ? task.deadlineAt : null,
          progress: 0,
          phase: 'running',
          cancelled: false,
          cancelReason: '',
          cancelStatus: '',
          cancelCause: '',
          cancelHookCalled: false,
        };
        task.token = token;
        this.active = task;
        this._remember(task.id, 'running', task, { phase: token.phase });
        this._emit('started');

        let result;
        try {
          result = await task.run(token);
          if (!result || typeof result !== 'object') result = { status: 'succeeded', detail: String(result || '') };
        } catch (error) {
          result = { status: 'failed', detail: String(error?.message || error) };
        }
        if (token.cancelled) {
          result = {
            ...result,
            status: token.cancelStatus || 'cancelled',
            detail: token.cancelReason || result.detail || '已取消',
            data: token.cancelCause
              ? { ...(result.data || {}), preempt_cause: token.cancelCause,
                ...(token.safetyInterruption ? { safety_interruption: token.safetyInterruption } : {}) }
              : result.data,
          };
        }
        this.active = null;
        const status = TERMINAL_STATUSES.has(result.status) ? result.status : 'failed';
        this._remember(task.id, status, task, result);
        this._emit('finished');
        try {
          if (typeof task.onResult === 'function') await task.onResult(result, task);
        } catch {
          // 结果投递失败不改变已完成的游戏动作，也不占用执行权。
        }
      }
    } finally {
      this.pumping = false;
      if (!this.active && this.queue.length > 0) this._pump();
    }
  }

  _finishQueued(task, status, detail) {
    this._remember(task.id, status, task, { status, detail });
    try {
      if (typeof task.onResult === 'function') {
        void Promise.resolve(task.onResult({ status, ok: false, detail }, task)).catch(() => {});
      }
    } catch {
      // 已取消的排队任务不持有执行权。
    }
  }

  _remember(id, status, task, result = {}) {
    const record = {
      action_id: id,
      status,
      tool: task?.tool || '',
      detail: String(result.detail || ''),
      data: result.data && typeof result.data === 'object' ? structuredCloneSafe(result.data) : undefined,
      updated_at: Date.now(),
    };
    this.records.delete(id);
    this.records.set(id, record);
    if (this.records.size > this.ledgerLimit) {
      for (const [key, entry] of this.records) {
        if (TERMINAL_STATUSES.has(entry.status) && key !== id) this.records.delete(key);
        if (this.records.size <= this.ledgerLimit) break;
      }
    }
    return record;
  }

  _emit(reason) {
    this.epoch += 1;
    try {
      this.onChange({ ...this.snapshot(), reason });
    } catch {
      // 状态回报失败不打断动作队列。
    }
  }
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
