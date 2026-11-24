export function validateActionState(message, current) {
  if (message.session_id && String(message.session_id) !== String(current.sessionId || '')) {
    return {
      status: 'blocked',
      detail: '动作基于过期的 Minecraft session',
      data: {
        expected_session_id: current.sessionId,
        admission: { started: false, retryable: false, reason: 'session_mismatch' },
      },
    };
  }
  const requestedRevision = message.state_revision ?? message.revision;
  const readLatest = current.readLatest && message.session_id && message.session_id === current.sessionId
    && Number.isSafeInteger(Number(requestedRevision)) && Number(requestedRevision) >= 0
    && Number(requestedRevision) <= Number(current.revision);
  if (requestedRevision !== undefined && requestedRevision !== null && Number(requestedRevision) !== Number(current.revision) && !readLatest) {
    return {
      status: 'blocked',
      detail: '动作基于过期的 Bridge state revision，动作未启动；请基于新观察重新准入',
      data: {
        expected_revision: current.revision,
        requested_revision: Number(requestedRevision),
        admission: {
          started: false,
          retryable: true,
          reason: 'stale_observation',
        },
      },
    };
  }
  if (!current.ready) {
    return { status: 'blocked', detail: current.reason || 'Bridge 尚未准备好接收普通动作', data: {} };
  }
  return null;
}

export function buildActionResult(message, { ok, detail, status, data = {} }, observation = null) {
  const resultData = { ...data, ...(observation ? { observation } : {}) };
  return {
    type: 'action_result',
    action_id: message.action_id,
    skill_id: message.skill_id || message.tool,
    ok: Boolean(ok),
    status: status || (ok ? 'succeeded' : 'failed'),
    detail: String(detail || '').slice(0, 500),
    data: resultData,
  };
}

export function mergeActionErrorData(error, progressData = {}, outcomeData = {}) {
  const errorData =
    error && error.data && typeof error.data === 'object' && !Array.isArray(error.data)
      ? error.data
      : {};
  return { ...progressData, ...outcomeData, ...errorData };
}
