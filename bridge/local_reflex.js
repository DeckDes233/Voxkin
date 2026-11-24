const PRIORITIES = Object.freeze({
  low_oxygen: 0,
  low_health: 1,
  damage: 2,
  hostile_nearby: 3,
  critical_hunger: 4,
});

export function canRunLocalSafety({ botPresent, botReady, health, deathPending, respawnReady }) {
  return Boolean(botPresent && botReady && Number(health) > 0 && (!deathPending || respawnReady));
}

export function shouldInterruptForHunger(food, edibleItem) {
  return Number.isFinite(food) && food <= 8 && Boolean(edibleItem);
}

export class LocalReflexScheduler {
  constructor({ executor, isReady, run, onCancel = () => {}, idFactory = null }) {
    if (!executor || typeof executor.enqueue !== 'function') throw new TypeError('reflex scheduler requires an executor');
    if (typeof run !== 'function') throw new TypeError('reflex scheduler requires run()');
    this.executor = executor;
    this.isReady = isReady || (() => true);
    this.runReflex = run;
    this.onCancel = onCancel;
    this.idFactory = idFactory || ((event) => `reflex-${event}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  dispatch(event, data = {}) {
    const priority = PRIORITIES[event];
    if (priority === undefined || !this.isReady()) return null;
    if (this.executor.active?.kind === 'safety' && priority >= this.executor.active.priority) return null;
    const id = this.idFactory(event);
    const interrupted = this.executor.active;
    const queued = this.executor.enqueue({
      id,
      tool: `local_${event}`,
      kind: 'safety',
      priority,
      dedupeKey: `safety:${event}`,
      onCancel: this.onCancel,
      run: async (token) => {
        token.phase = `safety:${event}`;
        return this.runReflex(event, data, token);
      },
    });
    if (queued.accepted && interrupted?.token?.cancelStatus === 'preempted') {
      const previous = interrupted.token.safetyInterruption;
      if (!previous || priority < PRIORITIES[previous.event]) {
        // 把实际危险原因和坐标留在被打断动作的回执里，恢复时不能丢失。
        interrupted.token.safetyInterruption = { ...data, event, safety_action_id: id };
      }
    }
    return queued.accepted ? id : (queued.duplicate ? queued.record?.action_id || null : null);
  }
}
