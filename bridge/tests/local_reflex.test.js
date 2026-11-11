import assert from 'node:assert/strict';
import test from 'node:test';

import { ExecutionController } from '../execution_controller.js';
import { canRunLocalSafety, LocalReflexScheduler, shouldInterruptForHunger } from '../local_reflex.js';

test('hunger interrupts an action only when the local reflex can eat', () => {
  assert.equal(shouldInterruptForHunger(8, null), false);
  assert.equal(shouldInterruptForHunger(0, null), false);
  assert.equal(shouldInterruptForHunger(8, { name: 'bread' }), true);
  assert.equal(shouldInterruptForHunger(9, { name: 'bread' }), false);
  assert.equal(shouldInterruptForHunger(undefined, { name: 'bread' }), false);
});

test('local reflex runs through the controller with no Core notification channel', async () => {
  const controller = new ExecutionController();
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  controller.enqueue({
    id: 'goal-action', priority: 3,
    run: async () => { events.push('goal-start'); await gate; return { status: 'succeeded' }; },
    onResult: (result) => events.push(`goal-${result.status}`),
  });
  const reflex = new LocalReflexScheduler({
    executor: controller,
    isReady: () => true,
    idFactory: (event) => `local-${event}`,
    run: async (event) => { events.push(`local-${event}`); return { status: 'succeeded' }; },
  });
  assert.equal(reflex.dispatch('low_oxygen', { oxygen: 4, position: { x: 20, y: 55, z: 62 } }), 'local-low_oxygen');
  assert.equal(controller.snapshot().safety_active, true);
  assert.deepEqual(events, ['goal-start']);
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ['goal-start', 'goal-preempted', 'local-low_oxygen']);
  assert.equal(controller.status('local-low_oxygen').status, 'succeeded');
  assert.deepEqual(controller.status('goal-action').data.safety_interruption, {
    event: 'low_oxygen', oxygen: 4, position: { x: 20, y: 55, z: 62 }, safety_action_id: 'local-low_oxygen',
  });
  assert.equal(controller.status('goal-action').data.preempt_cause, 'safety_priority');
});

test('local reflex remains available after respawn before Core lifecycle acknowledgement', () => {
  assert.equal(canRunLocalSafety({
    botPresent: true, botReady: true, health: 20, deathPending: true, respawnReady: false,
  }), false);
  assert.equal(canRunLocalSafety({
    botPresent: true, botReady: true, health: 20, deathPending: true, respawnReady: true,
    coreConnected: false,
  }), true);
  assert.equal(canRunLocalSafety({
    botPresent: true, botReady: true, health: 0, deathPending: true, respawnReady: true,
  }), false);
});
