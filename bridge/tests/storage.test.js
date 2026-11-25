import assert from 'node:assert/strict';
import test from 'node:test';
import { skills } from '../skills/storage.js';

test('下界清理只丢多余的整组石料，每次重新读取背包并保留两组', async () => {
  const stacks = Array.from({length: 4}, () => ({name: 'basalt', count: 64}));
  stacks.push({name: 'diamond', count: 64});
  let syncs = 0;
  const bot = {inventory: {items: () => stacks, emptySlotCount: () => 5 - stacks.length},
    tossStack: async stack => { stacks.splice(stacks.indexOf(stack), 1); }};
  const ctx = {bot, sleep: async () => {}, syncInventory: async () => { syncs++; }};
  await assert.rejects(skills.discard_rubble.handler({item: 'diamond'}, ctx));
  const result = await skills.discard_rubble.handler({item: 'basalt'}, ctx);
  assert.equal(result.status, 'succeeded');
  assert.equal(syncs, 3);
  assert.equal(result.data.inventory_free_slots, 2);
  assert.deepEqual(stacks.map(s => s.name), ['basalt', 'basalt', 'diamond']);
});

test('石料回到背包后按稳定空格报告结果', async () => {
  const stack = {name: 'netherrack', count: 64};
  let count = 4;
  const bot = {inventory: {items: () => Array(count).fill(stack), emptySlotCount: () => 4 - count},
    tossStack: async () => { count--; }};
  const ctx = {bot, sleep: async () => { count = 4; }, syncInventory: async () => {}};
  const result = await skills.discard_rubble.handler({item: 'netherrack'}, ctx);
  assert.equal(result.status, 'blocked');
  assert.equal(result.data.inventory_free_slots, 0);
});

test('存箱与取回多叠圆石按窗口确认的数量继续，留足指定的随身储备', async () => {
  const window = {inventoryStart: 27, inventoryEnd: 63, slots: Array(63).fill(null)};
  for (let slot = 27; slot < 32; slot++) window.slots[slot] = {name: 'cobblestone', count: 64};
  const count = start => window.slots.slice(start, start ? 63 : 27).reduce((n, stack) => n + (stack?.count || 0), 0);
  const ctx = {
    bot: {openBlock: async () => window, closeWindow: async () => {}},
    nearbyBlock: () => ({position: {x: 1, y: 50, z: 0}}),
    travelToBlock: async () => 'reached',
    countItem: () => count(27),
    syncWindow: async () => {},
    async clickWindowSlot(w, slot, button, mode) {
      assert.equal(w, window);
      assert.equal(mode, 1);
      const dest = window.slots.findIndex((stack, i) => !stack && (slot < 27 ? i >= 27 : i < 27));
      window.slots[dest] = window.slots[slot];
      window.slots[slot] = null;
    },
  };
  await skills.store_items.handler({item: 'cobblestone', count: 192}, ctx);
  assert.deepEqual([count(0), count(27)], [192, 128]);
  await skills.withdraw_items.handler({item: 'cobblestone', count: 128}, ctx);
  assert.deepEqual([count(0), count(27)], [64, 256]);
});
