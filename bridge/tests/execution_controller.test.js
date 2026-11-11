import assert from 'node:assert/strict';
import test from 'node:test';

import { ExecutionController } from '../execution_controller.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('concurrent requests execute serially and priority only orders queued work', async () => {
  const events = [];
  const controller = new ExecutionController();
  let release;
  const firstGate = new Promise((resolve) => { release = resolve; });
  const submit = (id, priority, run) => controller.enqueue({ id, priority, run });

  submit('first', 3, async () => { events.push('first:start'); await firstGate; events.push('first:end'); return { status: 'succeeded' }; });
  submit('late', 5, async () => { events.push('late'); return { status: 'succeeded' }; });
  submit('urgent', 0, async () => { events.push('urgent'); return { status: 'succeeded' }; });
  await pause(10);
  assert.deepEqual(events, ['first:start']);
  release();
  await pause(20);
  assert.deepEqual(events, ['first:start', 'first:end', 'urgent', 'late']);
});

test('cancellation timeout does not release ownership while the old action is still running', async () => {
  const events = [];
  const controller = new ExecutionController();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  controller.enqueue({
    id: 'slow', priority: 3,
    run: async (token) => {
      events.push('slow:start');
      setTimeout(() => controller.cancel('slow', 'timeout', 'cancelled'), 5);
      await gate;
      events.push('slow:stopped');
      return { status: 'succeeded' };
    },
  });
  controller.enqueue({ id: 'next', priority: 3, run: async () => { events.push('next'); return { status: 'succeeded' }; } });
  await pause(20);
  assert.deepEqual(events, ['slow:start']);
  assert.equal(controller.snapshot().active_action_id, 'slow');
  assert.equal(controller.status('slow').status, 'cancelling');
  release();
  await pause(20);
  assert.deepEqual(events, ['slow:start', 'slow:stopped', 'next']);
  assert.equal(controller.status('slow').status, 'cancelled');
});

test('local safety preempts the current action and the original result remains preempted', async () => {
  const controller = new ExecutionController();
  const results = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  controller.enqueue({
    id: 'goal', priority: 3,
    onCancel: (_reason, status) => results.push(['cancel-hook', status]),
    run: async () => { await gate; return { status: 'succeeded', detail: 'goal had a partial effect' }; },
    onResult: (result) => results.push(['goal', result.status]),
  });
  controller.enqueue({
    id: 'safety', priority: 0, kind: 'safety',
    run: async () => { results.push(['safety-run']); return { status: 'succeeded' }; },
    onResult: (result) => results.push(['safety', result.status]),
  });
  assert.equal(controller.snapshot().safety_active, true);
  assert.equal(controller.status('goal').status, 'preempting');
  assert.deepEqual(results, [['cancel-hook', 'preempted']]);
  release();
  await pause(20);
  assert.deepEqual(results, [
    ['cancel-hook', 'preempted'],
    ['goal', 'preempted'],
    ['safety-run'],
    ['safety', 'succeeded'],
  ]);
  assert.equal(controller.status('goal').data.preempt_cause, 'safety_priority');
  assert.equal(controller.snapshot().safety_active, false);
});

test('higher-priority player action reports preempted while explicit stop remains cancelled', async () => {
  const controller = new ExecutionController();
  const results = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  controller.enqueue({
    id: 'goal', priority: 5,
    run: async () => { await gate; return { status: 'succeeded' }; },
    onResult: (result) => results.push(['goal', result.status, result.data?.preempt_cause]),
  });
  controller.enqueue({
    id: 'player-action', priority: 1,
    run: async () => ({ status: 'succeeded' }),
  });
  release();
  await pause(20);
  assert.deepEqual(results, [['goal', 'preempted', 'player_priority']]);

  let releaseStop;
  const stopGate = new Promise((resolve) => { releaseStop = resolve; });
  const stopped = [];
  controller.enqueue({ id: 'stop-goal', run: async () => { await stopGate; return { status: 'succeeded' }; }, onResult: (result) => stopped.push(result.status) });
  controller.stop('player stop');
  releaseStop();
  await pause(20);
  assert.deepEqual(stopped, ['cancelled']);
});

test('a lower priority safety signal cannot interrupt an active emergency; a higher one can', async () => {
  const controller = new ExecutionController();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const events = [];
  controller.enqueue({ id: 'hunger', kind: 'safety', priority: 4, dedupeKey: 'hunger', run: async () => { await gate; return { status: 'succeeded' }; }, onResult: (r) => events.push(['hunger', r.status]) });
  controller.enqueue({ id: 'hostile', kind: 'safety', priority: 3, dedupeKey: 'hostile', run: async () => { events.push(['hostile']); return { status: 'succeeded' }; } });
  assert.equal(controller.status('hunger').status, 'preempting');
  controller.enqueue({ id: 'same-hostile', kind: 'safety', priority: 3, dedupeKey: 'hostile', run: async () => assert.fail('duplicate reflex ran') });
  assert.equal(controller.status('same-hostile'), null);
  release();
  await pause(20);
  assert.deepEqual(events, [['hunger', 'preempted'], ['hostile']]);
});

test('a safety task jumps ahead of an already queued ordinary goal', async () => {
  const controller = new ExecutionController();
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  controller.enqueue({ id: 'active-goal', priority: 3, run: async () => { await gate; return { status: 'succeeded' }; }, onResult: (r) => events.push(`active:${r.status}`) });
  controller.enqueue({ id: 'queued-goal', priority: 3, run: async () => { events.push('queued-goal'); return { status: 'succeeded' }; } });
  controller.enqueue({ id: 'hunger', kind: 'safety', priority: 4, run: async () => { events.push('hunger'); return { status: 'succeeded' }; } });
  release();
  await pause(20);
  assert.deepEqual(events, ['active:preempted', 'hunger', 'queued-goal']);
});

test('stop clears queued actions and cancels the active action as player cancellation', async () => {
  const controller = new ExecutionController();
  const results = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  controller.enqueue({ id: 'active', run: async () => { await gate; return { status: 'succeeded' }; }, onResult: (r) => results.push(['active', r.status]) });
  controller.enqueue({ id: 'queued', run: async () => assert.fail('queued action ran'), onResult: (r) => results.push(['queued', r.status]) });
  assert.equal(controller.stop('player stop'), 1);
  assert.deepEqual(results, [['queued', 'cancelled']]);
  release();
  await pause(20);
  assert.deepEqual(results, [['queued', 'cancelled'], ['active', 'cancelled']]);
});

test('blocked lifecycle rejects queued work and duplicate ids never execute twice', async () => {
  const controller = new ExecutionController();
  let runs = 0;
  controller.enqueue({ id: 'once', run: async () => { runs += 1; return { status: 'succeeded' }; } });
  assert.equal(controller.enqueue({ id: 'once', run: async () => { runs += 1; } }).duplicate, true);
  await pause(15);
  controller.block('dead', 'death');
  assert.equal(controller.enqueue({ id: 'after-death', run: async () => { runs += 1; } }).accepted, false);
  assert.equal(controller.status('once').status, 'succeeded');
  assert.equal(controller.status('missing'), null);
  assert.equal(runs, 1);
});

test('an async result callback rejection for a cancelled queued action does not poison the executor', async () => {
  const controller = new ExecutionController();
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  controller.enqueue({ id: 'active', run: async () => { await gate; return { status: 'succeeded' }; } });
  controller.enqueue({ id: 'removed', run: async () => assert.fail('cancelled task ran'), onResult: async () => { throw new Error('callback rejected'); } });
  controller.enqueue({ id: 'tail', run: async () => { events.push('tail'); return { status: 'succeeded' }; } });
  assert.equal(controller.cancel('removed'), true);
  release();
  await pause(25);
  assert.deepEqual(events, ['tail']);
  assert.equal(controller.status('removed').status, 'cancelled');
});
