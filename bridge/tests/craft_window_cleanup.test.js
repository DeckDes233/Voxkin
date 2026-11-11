import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { cleanupCraftWindowForSafety } from '../craft_window_cleanup.js';
import { ExecutionController } from '../execution_controller.js';
import { writeWindowClickWithLease } from '../window_sync.js';

function safetyToken() {
  return {
    cancelled: true,
    cancelStatus: 'preempted',
    cancelCause: 'safety_priority',
  };
}

test('urgent craft preemption returns only the cursor and proceeds when inventory sync misses its short deadline', async () => {
  const token = safetyToken();
  const inventoryWindow = {};
  let restoredCursor = false;
  let requestedTimeout = 0;
  const start = Date.now();
  const result = await cleanupCraftWindowForSafety({
    token,
    window: inventoryWindow,
    inventoryWindow,
    restoreCursor: async () => { restoredCursor = true; },
    closeContainer: async () => assert.fail('inventory window has no container to close'),
    synchronize: async (_window, timeoutMs) => {
      requestedTimeout = timeoutMs;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return false;
    },
  });

  assert.equal(restoredCursor, true);
  assert.equal(requestedTimeout, 300);
  assert.equal(Date.now() - start < 250, true);
  assert.deepEqual(result, { handled: true, unknown: true, mode: 'cursor_only' });
  assert.equal(token.cancelStatus, 'unknown');
  assert.equal(token.progressData.window_state_unknown, true);
});

test('urgent craft preemption closes a container without restoring its grid cell by cell', async () => {
  const token = safetyToken();
  const inventoryWindow = {};
  const tableWindow = {};
  let closed = false;
  const result = await cleanupCraftWindowForSafety({
    token,
    window: tableWindow,
    inventoryWindow,
    restoreCursor: async () => assert.fail('open crafting container should be closed'),
    closeContainer: async () => { closed = true; },
    synchronize: async () => assert.fail('container inventory sync happens after close'),
  });

  assert.equal(closed, true);
  assert.equal(token.craftWindowClosed, true);
  assert.deepEqual(result, { handled: true, unknown: false, mode: 'close_container' });
});

test('player cancellation keeps the normal cleanup policy', async () => {
  const token = { cancelled: true, cancelStatus: 'cancelled', cancelCause: '' };
  const result = await cleanupCraftWindowForSafety({
    token,
    window: {},
    inventoryWindow: {},
    restoreCursor: async () => assert.fail('safety cleanup must not run for player stop'),
    closeContainer: async () => assert.fail('safety cleanup must not run for player stop'),
    synchronize: async () => assert.fail('safety cleanup must not run for player stop'),
  });
  assert.deepEqual(result, { handled: false, unknown: false });
});

test('safety takes the execution lease shortly after craft cleanup becomes unknown', async () => {
  const controller = new ExecutionController();
  const bot = new EventEmitter();
  const writes = [];
  bot._client = { write: (name, packet) => writes.push({ name, packet }) };
  const inventoryWindow = { id: 0, slots: [], selectedItem: null, acceptClick: () => [] };
  let signalFirstClick;
  const firstClick = new Promise((resolve) => { signalFirstClick = resolve; });
  let releaseCraft;
  const cleanupFinished = new Promise((resolve) => { releaseCraft = resolve; });
  const events = [];

  controller.enqueue({
    id: 'craft',
    run: async (token) => {
      try {
        await writeWindowClickWithLease(bot, inventoryWindow, {
          slot: 4, mouseButton: 1, mode: 0, stateId: 1,
          toNotchSlot: () => ({ present: false }), token,
          wait: async () => {
            signalFirstClick();
            await new Promise((resolve) => setTimeout(resolve, 25));
          },
        });
        await writeWindowClickWithLease(bot, inventoryWindow, {
          slot: 5, mouseButton: 1, mode: 0, stateId: 1,
          toNotchSlot: () => ({ present: false }), token,
          wait: async () => {},
        });
      } catch {
        events.push('craft-stopped');
      }
      await cleanupFinished;
      return { status: 'succeeded' };
    },
    onCancel: (_reason, _status, token) => {
      void cleanupCraftWindowForSafety({
        token,
        window: inventoryWindow,
        inventoryWindow,
        restoreCursor: () => writeWindowClickWithLease(bot, inventoryWindow, {
          slot: 8, mouseButton: 0, mode: 0, stateId: 1,
          toNotchSlot: () => ({ present: false }), token, cleanup: true,
          wait: () => new Promise((resolve) => setTimeout(resolve, 10)),
        }),
        closeContainer: async () => assert.fail('inventory window is not a container'),
        synchronize: async (_window, timeoutMs) => {
          assert.equal(timeoutMs, 300);
          return false;
        },
      }).then(() => releaseCraft());
    },
    onResult: (result) => events.push(`craft:${result.status}`),
  });
  await firstClick;
  const start = Date.now();
  controller.enqueue({
    id: 'safety',
    kind: 'safety',
    priority: 0,
    run: async () => { events.push('safety-started'); return { status: 'succeeded' }; },
  });
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(Date.now() - start < 1000, true);
  assert.deepEqual(writes.map(({ packet }) => packet.slot), [4, 8]);
  assert.deepEqual(events, ['craft-stopped', 'craft:unknown', 'safety-started']);
});
