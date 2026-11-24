import assert from 'node:assert/strict';
import test from 'node:test';

import { buildActionResult, mergeActionErrorData, validateActionState } from '../action_response.js';

test('a latest-state read can cross revisions only within a ready matching session', () => {
  const current = { sessionId: 'world', revision: 4, ready: true, readLatest: true };
  const query = { tool: 'inventory', session_id: 'world', state_revision: 2 };
  assert.equal(validateActionState(query, current), null);
  assert.equal(validateActionState({ ...query, state_revision: 5 }, current).status, 'blocked');
  assert.equal(validateActionState({ ...query, session_id: 'other' }, current).status, 'blocked');
  assert.equal(validateActionState(query, { ...current, ready: false }).status, 'blocked');
  assert.equal(validateActionState(query, { ...current, readLatest: false }).status, 'blocked');
});

test('action admission rejects mismatched sessions and revisions, and waits for ready lifecycle state', () => {
  const current = { sessionId: 'session-b', revision: 12, ready: true };
  const wrongSession = validateActionState({ session_id: 'session-a', state_revision: 12 }, current);
  assert.equal(wrongSession.status, 'blocked');
  assert.deepEqual(wrongSession.data.admission, {
    started: false,
    retryable: false,
    reason: 'session_mismatch',
  });
  const staleObservation = validateActionState({ session_id: 'session-b', state_revision: 11 }, current);
  assert.equal(staleObservation.status, 'blocked');
  assert.equal(staleObservation.data.expected_revision, 12);
  assert.equal(staleObservation.data.requested_revision, 11);
  assert.deepEqual(staleObservation.data.admission, {
    started: false,
    retryable: true,
    reason: 'stale_observation',
  });
  assert.equal(validateActionState({ session_id: 'session-b', state_revision: 12 }, { ...current, ready: false }).detail,
    'Bridge 尚未准备好接收普通动作');
  assert.equal(validateActionState({ session_id: 'session-b', state_revision: 12 }, current), null);
  assert.equal(validateActionState({}, current), null); // 旧客户端兼容
});

test('stale revision rejection carries the fresh observation for a new admission attempt', () => {
  const rejection = validateActionState(
    { action_id: 'craft-old', session_id: 'session-b', state_revision: 20 },
    { sessionId: 'session-b', revision: 21, ready: true },
  );
  const observation = { session_id: 'session-b', revision: 22, ready: true };
  const result = buildActionResult(
    { action_id: 'craft-old', tool: 'craft', arguments: { item: 'oak_planks' } },
    { ok: false, ...rejection },
    observation,
  );

  assert.equal(result.status, 'blocked');
  assert.equal(result.data.admission.started, false);
  assert.equal(result.data.admission.retryable, true);
  assert.equal(result.data.admission.reason, 'stale_observation');
  assert.equal(result.data.observation.revision, 22);
});

test('action results preserve progress events and attach the exact final observation', () => {
  const observation = {
    session_id: 'session-b', revision: 13, ready: false,
    executor: { active_action_id: null, safety_active: true, epoch: 24 },
  };
  const payload = buildActionResult(
    { action_id: 'goal-1', skill_id: 'mine_collect', tool: 'mine_collect' },
    { ok: false, status: 'preempted', detail: '危机抢占', data: { events: [{ type: 'block_mined' }], partial_count: 1 } },
    observation,
  );
  assert.equal(payload.status, 'preempted');
  assert.deepEqual(payload.data.events, [{ type: 'block_mined' }]);
  assert.equal(payload.data.observation, observation);
  assert.equal(payload.data.observation.revision, 13);
});

test('action error results preserve structured safe-stop evidence over progress data', () => {
  const error = new Error('没有安全的阶梯落点，已停止下探');
  error.data = {
    phase: 'safe_stop',
    reason: 'no_safe_stair',
    position: { x: -6, y: 59, z: 151 },
    target_y: 16,
    candidates: [{ direction: 'west', support: { name: 'air', bounding_box: 'empty' } }],
  };
  const data = mergeActionErrorData(error, { phase: 'running', progress: 0 }, {});
  const observation = { revision: 82, position: { x: -5.5, y: 59.92, z: 151.3 } };
  const payload = buildActionResult(
    { action_id: 'mine-1', tool: 'strip_mine' },
    { ok: false, status: 'blocked', detail: error.message, data },
    observation,
  );

  assert.equal(payload.status, 'blocked');
  assert.equal(payload.data.phase, 'safe_stop');
  assert.equal(payload.data.reason, 'no_safe_stair');
  assert.equal(payload.data.target_y, 16);
  assert.equal(payload.data.candidates[0].support.bounding_box, 'empty');
  assert.equal(payload.data.observation.revision, 82);
});
