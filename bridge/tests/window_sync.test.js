import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { syncWindowWithLease, writeWindowClickWithLease } from '../window_sync.js';

function makeBot() {
  const bot = new EventEmitter();
  bot.supportFeature = () => true;
  const writes = [];
  bot._client = { write: (name, packet) => writes.push({ name, packet }) };
  return { bot, writes };
}

test('window sync uses Mineflayer no-op click protocol and removes listener after reply', async () => {
  const { bot, writes } = makeBot();
  const token = { cancelHooks: new Set() };
  const window = { id: 7, selectedItem: null };
  const pending = syncWindowWithLease(bot, window, token, () => ({ present: false }), 100);
  assert.deepEqual(writes, [{
    name: 'window_click',
    packet: {
      windowId: 7,
      stateId: -1,
      slot: -999,
      mouseButton: 2,
      mode: 5,
      changedSlots: [],
      cursorItem: { present: false },
    },
  }]);
  bot.emit('setWindowItems:7');
  assert.equal(await pending, true);
  assert.equal(bot.listenerCount('setWindowItems:7'), 0);
  assert.equal(token.cancelHooks.size, 0);
});

test('window sync timeout releases only its own listener and reports no synchronization', async () => {
  const { bot } = makeBot();
  const token = { cancelHooks: new Set() };
  const pending = syncWindowWithLease(bot, { id: 2, selectedItem: null }, token, () => ({ present: false }), 10);
  assert.equal(await pending, false);
  assert.equal(bot.listenerCount('setWindowItems:2'), 0);
  assert.equal(token.cancelHooks.size, 0);
});

test('window sync cancellation detaches the waiter so a late server packet cannot revive it', async () => {
  const { bot } = makeBot();
  const token = { cancelHooks: new Set() };
  const pending = syncWindowWithLease(bot, { id: 4, selectedItem: null }, token, () => ({ present: false }), 100);
  const [cancel] = token.cancelHooks;
  cancel();
  assert.equal(await pending, false);
  assert.equal(bot.listenerCount('setWindowItems:4'), 0);
  bot.emit('setWindowItems:4');
  assert.equal(token.cancelHooks.size, 0);
});

test('a cancelled craft token blocks the next click after the current packet settles', async () => {
  const { bot, writes } = makeBot();
  const token = { cancelled: false, cancelReason: 'cancelled' };
  let accepted = 0;
  const window = {
    id: 3,
    slots: [{ name: 'input' }],
    selectedItem: null,
    acceptClick() { accepted += 1; return [0]; },
  };
  await assert.rejects(writeWindowClickWithLease(bot, window, {
    slot: 0,
    mouseButton: 0,
    mode: 0,
    stateId: 11,
    toNotchSlot: () => ({ present: false }),
    token,
    wait: async () => { token.cancelled = true; },
  }), /cancelled/i);
  assert.equal(writes.length, 1);
  assert.equal(accepted, 1);

  await assert.rejects(writeWindowClickWithLease(bot, window, {
    slot: 0,
    mouseButton: 0,
    mode: 0,
    stateId: 11,
    toNotchSlot: () => ({ present: false }),
    token,
    wait: async () => {},
  }), /cancelled/i);
  assert.equal(writes.length, 1);
  assert.equal(accepted, 1);
});

test('cleanup click remains available under the same lease until its cleanup deadline', async () => {
  const { bot, writes } = makeBot();
  const token = { cancelled: true, cleanupDeadlineAt: Date.now() + 1000 };
  const window = { id: 5, slots: [], selectedItem: null, acceptClick: () => [] };
  await writeWindowClickWithLease(bot, window, {
    slot: 1,
    mouseButton: 0,
    mode: 0,
    stateId: 2,
    toNotchSlot: () => ({ present: false }),
    token,
    cleanup: true,
    wait: async () => {},
  });
  assert.equal(writes.length, 1);
});
