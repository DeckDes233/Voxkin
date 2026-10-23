export function rejectBlockedAction(status, message, reply) {
  if (!status) return false;
  const detail = status === 'dead' ? '角色死亡，动作未执行' : 'Minecraft bridge is disconnected';
  reply(message, false, detail, status);
  return true;
}

export function drainActions(queue, reply, detail, status) {
  const queued = queue.splice(0, queue.length);
  for (const message of queued) reply(message, false, detail, status);
  return queued.length;
}

export function queueLifecycleEvent(pending, type, lifecycleId, data) {
  if (!pending.some((event) => event.type === type && event.lifecycle_id === lifecycleId)) {
    pending.push({ type, lifecycle_id: lifecycleId, data: { ...data } });
  }
  return pending;
}

export function acknowledgeLifecycleEvent(pending, type, lifecycleId) {
  const index = pending.findIndex(
    (event) => event.type === type && event.lifecycle_id === lifecycleId,
  );
  if (index < 0) return false;
  pending.splice(index, 1);
  return true;
}
