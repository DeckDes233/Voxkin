import assert from 'node:assert/strict';
import test from 'node:test';

import {
  drainActions,
  inventoryItemType,
  queueLifecycleEvent,
  rejectBlockedAction,
  acknowledgeLifecycleEvent,
  closeWindowAndSyncInventory,
  worldHealthSnapshot,
} from '../action_lifecycle.js';

test('blocked actions are rejected before entering the execution queue', () => {
  const replies = [];
  const message = { action_id: 'a1', tool: 'collect_blocks' };

  assert.equal(rejectBlockedAction('dead', message, (...args) => replies.push(args)), true);
  assert.deepEqual(replies, [[message, false, '角色死亡，动作未执行', 'dead']]);
});

test('unblocked actions continue through the normal queue', () => {
  assert.equal(rejectBlockedAction('', { tool: 'observe' }, () => assert.fail()), false);
});

test('lifecycle changes reject all queued actions with the selected status', () => {
  const queue = [{ action_id: 'a1' }, { action_id: 'a2' }];
  const replies = [];

  assert.equal(drainActions(queue, (...args) => replies.push(args), 'connection lost', 'disconnected'), 2);
  assert.deepEqual(queue, []);
  assert.deepEqual(replies.map((reply) => [reply[0].action_id, reply[3]]), [
    ['a1', 'disconnected'],
    ['a2', 'disconnected'],
  ]);
});

test('lifecycle events remain pending until acknowledged and can be replayed', () => {
  const pending = [];
  const sent = [];

  queueLifecycleEvent(pending, 'death', 'death-1', { health: 0 });
  queueLifecycleEvent(pending, 'respawn', 'death-1', { health: 20 });
  assert.equal(pending.length, 2);

  for (const event of pending) sent.push({ ...event });
  assert.deepEqual(sent.map((event) => event.type), ['death', 'respawn']);
  assert.equal(acknowledgeLifecycleEvent(pending, 'death', 'death-1'), true);
  assert.equal(pending.length, 1);
  assert.equal(acknowledgeLifecycleEvent(pending, 'respawn', 'death-1'), true);
  assert.equal(pending.length, 0);
});

test('world health snapshot rejects unknown values and reports alive state', () => {
  assert.equal(worldHealthSnapshot(undefined), null);
  assert.equal(worldHealthSnapshot(Number.NaN), null);
  assert.equal(worldHealthSnapshot(Number.POSITIVE_INFINITY), null);
  assert.deepEqual(worldHealthSnapshot(20), { health: 20, alive: true });
  assert.deepEqual(worldHealthSnapshot(0), { health: 0, alive: false });
});

test('inventory stack IDs use the Mineflayer item type field', () => {
  assert.equal(inventoryItemType({ type: 803, name: 'coal', count: 1 }), 803);
  assert.equal(inventoryItemType({ id: 803, name: 'coal', count: 1 }), null);
  assert.equal(inventoryItemType(null), null);
});

test('furnace inventory is copied after closing its container and before syncing', async () => {
  const inventory = { cooked_beef: 0 };
  const events = [];
  const window = {
    async close() {
      events.push('close');
      inventory.cooked_beef = 3;
    },
  };

  await closeWindowAndSyncInventory(window, async () => {
    events.push(`sync:${inventory.cooked_beef}`);
  });

  assert.deepEqual(events, ['close', 'sync:3']);
});
