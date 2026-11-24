import assert from 'node:assert/strict';
import test from 'node:test';

import { skills } from '../skills/scavenge.js';

const bedName = 'white_bed';

function key(position) {
  return `${position.x},${position.y},${position.z}`;
}

function makeContext({
  inventory = {},
  sites = { beds: [], hay: [], chests: [], golems: [], village_evidence: false },
  blocks = new Map(),
  chestContents = new Map(),
  shelter = null,
  craftingTable = false,
  travelOutcome = 'reached',
  syncWindowError = null,
} = {}) {
  const ctxInventory = { ...inventory };
  const digs = [];
  const opened = [];
  const closed = [];
  const drops = [];
  const crafts = [];
  const explores = [];
  const position = { x: 0, y: 10, z: 0 };
  let currentWindow = null;

  const stackSize = (name) => ['white_bed', 'iron_pickaxe', 'iron_sword', 'iron_helmet'].includes(name) ? 1 : 64;
  const item = (name, count) => ({ name, count, stackSize: stackSize(name) });
  const inventoryItems = () => Object.entries(ctxInventory)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => item(name, count));
  const syncBag = (window) => {
    for (const name of Object.keys(ctxInventory)) delete ctxInventory[name];
    for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot += 1) {
      const stack = window.slots[slot];
      if (stack?.name && stack.count > 0) ctxInventory[stack.name] = (ctxInventory[stack.name] || 0) + stack.count;
    }
  };
  const makeWindow = (contents) => {
    const slots = Array(63).fill(null);
    for (let slot = 0; slot < 27; slot += 1) slots[slot] = null;
    let slot = 0;
    for (const [name, count] of Object.entries(contents || {})) {
      if (count > 0) slots[slot++] = item(name, count);
    }
    let inventorySlot = 27;
    for (const stack of inventoryItems()) slots[inventorySlot++] = { ...stack };
    return { slots, inventoryStart: 27, inventoryEnd: 63, selectedItem: null };
  };
  const bot = {
    entity: { position },
    inventory: { items: inventoryItems },
    currentWindow: null,
    blockAt(point) {
      return blocks.get(key(point)) || null;
    },
    async openBlock(block) {
      opened.push(key(block.position));
      const window = makeWindow(chestContents.get(key(block.position)) || {});
      currentWindow = window;
      bot.currentWindow = window;
      return window;
    },
    async closeWindow(window) {
      closed.push(window);
      if (currentWindow === window) currentWindow = null;
      bot.currentWindow = currentWindow;
    },
  };

  const ctx = {
    bot,
    registry: { itemsByName: {} },
    digs,
    opened,
    closed,
    drops,
    crafts,
    explores,
    interrupted: false,
    countItem: (name) => ctxInventory[name] || 0,
    getResourceSites: () => structuredClone(typeof sites === 'function' ? sites() : sites),
    getRememberedShelter: () => shelter,
    async travelToBlock(target) {
      if (travelOutcome !== 'reached') return travelOutcome;
      position.x = target.x;
      position.y = target.y;
      position.z = target.z;
      return 'reached';
    },
    async breakBlock(target) {
      digs.push({ ...target });
      blocks.delete(key(target));
    },
    async collectDrops(_range, itemName) {
      drops.push(itemName);
      ctxInventory[itemName] = (ctxInventory[itemName] || 0) + (itemName === 'hay_block' ? 1 : 1);
    },
    async craftItem({ item: name, count }) {
      crafts.push({ item: name, count });
      if (name === 'wheat') {
        const operations = Math.ceil(count / 9);
        assert.ok((ctxInventory.hay_block || 0) >= operations, '每 9 wheat 必须消耗 1 个实际掉落的 hay_block');
        ctxInventory.hay_block -= operations;
        if (!ctxInventory.hay_block) delete ctxInventory.hay_block;
        ctxInventory.wheat = (ctxInventory.wheat || 0) + operations * 9;
      } else if (name === 'bread') {
        assert.ok((ctxInventory.wheat || 0) >= count * 3, '每个 bread 必须消耗 3 wheat');
        ctxInventory.wheat -= count * 3;
        if (!ctxInventory.wheat) delete ctxInventory.wheat;
        ctxInventory.bread = (ctxInventory.bread || 0) + count;
      } else {
        throw new Error(`unexpected recipe ${name}`);
      }
    },
    nearbyBlock(name) {
      return name === 'crafting_table' && craftingTable;
    },
    async syncWindow() {
      if (syncWindowError) throw syncWindowError;
      return true;
    },
    async syncInventory() {},
    async clickWindowSlot(window, slot, mouseButton, mode) {
      if (mode === 1) {
        const source = window.slots[slot];
        if (!source) return;
        let remaining = source.count;
        for (let target = window.inventoryStart; target < window.inventoryEnd && remaining > 0; target += 1) {
          const stack = window.slots[target];
          if (stack?.name === source.name && stack.count < stack.stackSize) {
            const moved = Math.min(remaining, stack.stackSize - stack.count);
            stack.count += moved;
            remaining -= moved;
          }
        }
        for (let target = window.inventoryStart; target < window.inventoryEnd && remaining > 0; target += 1) {
          if (!window.slots[target]) {
            const moved = Math.min(remaining, source.stackSize);
            window.slots[target] = item(source.name, moved);
            remaining -= moved;
          }
        }
        window.slots[slot] = remaining ? item(source.name, remaining) : null;
      } else if (mouseButton === 0) {
        if (!window.selectedItem && window.slots[slot]) {
          window.selectedItem = window.slots[slot];
          window.slots[slot] = null;
        } else if (window.selectedItem) {
          const stack = window.slots[slot];
          if (!stack) {
            window.slots[slot] = window.selectedItem;
            window.selectedItem = null;
          } else if (stack.name === window.selectedItem.name) {
            const moved = Math.min(window.selectedItem.count, stack.stackSize - stack.count);
            stack.count += moved;
            window.selectedItem.count -= moved;
            if (!window.selectedItem.count) window.selectedItem = null;
          }
        }
      } else if (mouseButton === 1 && window.selectedItem) {
        const stack = window.slots[slot];
        if (!stack) window.slots[slot] = item(window.selectedItem.name, 1);
        else if (stack.name === window.selectedItem.name && stack.count < stack.stackSize) stack.count += 1;
        else return;
        window.selectedItem.count -= 1;
        if (!window.selectedItem.count) window.selectedItem = null;
      }
      syncBag(window);
    },
    async sleep() {},
    exploreResource(step, heading, state) {
      assert.ok(state.visited instanceof Set, 'exploreResource 必须收到含 visited:Set 的共享搜索状态');
      state.visited.add(`scavenge:${step}`);
      explores.push({ step, heading });
      return 'no_target';
    },
  };

  for (const block of blocks.values()) {
    if (!block.position) block.position = { x: 0, y: 0, z: 0 };
  }
  ctx.ctxInventory = ctxInventory;
  ctx.makeBlock = (name, x, y = 10, z = 0, properties = {}) => {
    const block = { name, position: { x, y, z }, getProperties: () => properties };
    blocks.set(key(block.position), block);
    return block;
  };
  ctx.addChest = (x, contents, z = 0) => {
    const block = ctx.makeBlock('chest', x, 10, z);
    chestContents.set(key(block.position), contents);
    return block;
  };
  return ctx;
}

test('loot_village takes only whitelisted items up to final inventory targets and reports measured deltas', async () => {
  const ctx = makeContext({
    inventory: { iron_ingot: 14 },
    sites: {
      beds: [], hay: [],
      chests: [{ name: 'chest', x: 2, y: 10, z: 0 }],
      golems: [], village_evidence: true,
    },
  });
  ctx.addChest(2, { iron_ingot: 10, diamond: 5, bread: 4, dirt: 64 });

  const result = await skills.loot_village.handler({
    targets: { iron_ingot: 16, diamond: 3 }, bed_count: 0, food_target: 8, max_search_steps: 0,
  }, ctx);

  assert.equal(result.status, 'partial');
  assert.deepEqual(ctx.ctxInventory, { iron_ingot: 16, diamond: 3, bread: 4 });
  assert.deepEqual(result.data.delta, { iron_ingot: 2, diamond: 3, bread: 4 });
  assert.deepEqual(result.data.visited_sites, ['2,10,0']);
  assert.equal(ctx.opened.length, 1);
  assert.equal(ctx.closed.length, 1);
});

test('loot_village does not treat a chest as village loot without village evidence', async () => {
  const ctx = makeContext({
    sites: { beds: [], hay: [], chests: [{ name: 'chest', x: 2, y: 10, z: 0 }], golems: [], village_evidence: false },
  });
  ctx.addChest(2, { iron_ingot: 16 });

  const result = await skills.loot_village.handler({ targets: { iron_ingot: 1 }, bed_count: 0, food_target: 0, max_search_steps: 0 }, ctx);

  assert.equal(result.status, 'partial');
  assert.equal(ctx.opened.length, 0);
  assert.equal(ctx.ctxInventory.iron_ingot || 0, 0);
});

test('loot_village takes one village bed but never breaks a bed inside the remembered shelter', async () => {
  const ctx = makeContext({
    shelter: { position: { x: 0, y: 10, z: 0 }, size: 3 },
    sites: {
      beds: [
        { name: bedName, x: 0, y: 12, z: 0 },
        { name: bedName, x: 5, y: 10, z: 0 },
      ],
      hay: [], chests: [], golems: [], village_evidence: true,
    },
  });
  ctx.makeBlock(bedName, 0, 12, 0, { part: 'foot', occupied: false });
  ctx.makeBlock(bedName, 5, 10, 0, { part: 'foot', occupied: false });

  const result = await skills.loot_village.handler({ bed_count: 1, food_target: 0, max_search_steps: 0 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(ctx.digs, [{ x: 5, y: 10, z: 0 }]);
  assert.equal(ctx.ctxInventory[bedName], 1);
  assert.deepEqual(result.data.visited_sites, ['5,10,0']);
});

test('hay block is collected first, then converted through 9 wheat and 3 wheat per bread recipes', async () => {
  const ctx = makeContext({
    craftingTable: true,
    sites: { beds: [], hay: [{ name: 'hay_block', x: 2, y: 10, z: 0 }], chests: [], golems: [], village_evidence: false },
  });
  ctx.makeBlock('hay_block', 2);

  const result = await skills.loot_village.handler({ bed_count: 0, food_target: 3, max_search_steps: 0 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(ctx.drops, ['hay_block']);
  assert.deepEqual(ctx.crafts, [{ item: 'wheat', count: 9 }, { item: 'bread', count: 3 }]);
  assert.deepEqual(ctx.ctxInventory, { bread: 3 });
  assert.deepEqual(result.data.delta, { bread: 3 });
});

test('large food targets craft only wheat backed by hay blocks already in the inventory', async () => {
  const ctx = makeContext({
    craftingTable: true,
    sites: { beds: [], hay: [{ name: 'hay_block', x: 2, y: 10, z: 0 }], chests: [], golems: [], village_evidence: false },
  });
  ctx.makeBlock('hay_block', 2);

  const result = await skills.loot_village.handler({ bed_count: 0, food_target: 16, max_search_steps: 0 }, ctx);

  assert.equal(result.status, 'partial');
  assert.deepEqual(ctx.crafts, [{ item: 'wheat', count: 9 }, { item: 'bread', count: 3 }]);
  assert.deepEqual(ctx.ctxInventory, { bread: 3 });
  assert.deepEqual(result.data.delta, { bread: 3 });
});

test('without a crafting table, hay remains in inventory for later and the result stays partial', async () => {
  const ctx = makeContext({
    sites: { beds: [], hay: [{ name: 'hay_block', x: 2, y: 10, z: 0 }], chests: [], golems: [], village_evidence: false },
  });
  ctx.makeBlock('hay_block', 2);

  const result = await skills.loot_village.handler({ bed_count: 0, food_target: 3, max_search_steps: 0 }, ctx);

  assert.equal(result.status, 'partial');
  assert.deepEqual(ctx.drops, ['hay_block']);
  assert.deepEqual(ctx.crafts, []);
  assert.deepEqual(result.data.delta, { hay_block: 1 });
  assert.match(result.detail, /没有工作台/);
});

test('an empty chest is opened at most once during a bounded resource search', async () => {
  const ctx = makeContext({
    sites: { beds: [], hay: [], chests: [{ name: 'chest', x: 2, y: 10, z: 0 }], golems: [], village_evidence: true },
  });
  ctx.addChest(2, { dirt: 64 });

  const result = await skills.loot_village.handler({ targets: { iron_ingot: 1 }, bed_count: 0, food_target: 0, max_search_steps: 0 }, ctx);

  assert.equal(result.status, 'partial');
  assert.equal(ctx.opened.length, 1);
  assert.equal(ctx.closed.length, 1);
  assert.deepEqual(result.data.visited_sites, ['2,10,0']);
});

test('a full inventory leaves targeted chest items untouched and reports no false gain', async () => {
  const fullInventory = Object.fromEntries(Array.from({ length: 36 }, (_, index) => [`junk_${index}`, 1]));
  const ctx = makeContext({
    inventory: fullInventory,
    sites: { beds: [], hay: [], chests: [{ name: 'chest', x: 2, y: 10, z: 0 }], golems: [], village_evidence: true },
  });
  ctx.addChest(2, { iron_ingot: 3 });

  const result = await skills.loot_village.handler({ targets: { iron_ingot: 1 }, bed_count: 0, food_target: 0, max_search_steps: 0 }, ctx);

  assert.equal(result.status, 'partial');
  assert.equal(ctx.ctxInventory.iron_ingot || 0, 0);
  assert.deepEqual(result.data.delta, {});
  assert.equal(ctx.closed.length, 1);
});

test('unknown chest-window state is propagated after closing the chest and stops further looting', async () => {
  const unknownState = Object.assign(new Error('inventory state unknown'), { code: 'UNKNOWN_WINDOW_STATE' });
  const ctx = makeContext({
    syncWindowError: unknownState,
    sites: {
      beds: [], hay: [],
      chests: [
        { name: 'chest', x: 2, y: 10, z: 0 },
        { name: 'chest', x: 3, y: 10, z: 0 },
      ],
      golems: [], village_evidence: true,
    },
  });
  ctx.addChest(2, { iron_ingot: 5 });
  ctx.addChest(3, { iron_ingot: 5 });

  await assert.rejects(
    skills.loot_village.handler({ targets: { iron_ingot: 1 }, bed_count: 0, food_target: 0, max_search_steps: 0 }, ctx),
    (error) => error === unknownState,
  );
  assert.equal(ctx.opened.length, 1);
  assert.equal(ctx.closed.length, 1);
});

test('cancelled travel is propagated instead of being treated as a failed candidate', async () => {
  const ctx = makeContext({
    travelOutcome: 'cancelled',
    sites: { beds: [], hay: [], chests: [{ name: 'chest', x: 2, y: 10, z: 0 }], golems: [], village_evidence: true },
  });
  ctx.addChest(2, { iron_ingot: 5 });

  await assert.rejects(
    skills.loot_village.handler({ targets: { iron_ingot: 1 }, bed_count: 0, food_target: 0, max_search_steps: 0 }, ctx),
    /cancelled/,
  );
  assert.equal(ctx.opened.length, 0);
});

test('loot_village rejects undeclared item targets before opening containers', async () => {
  const ctx = makeContext();
  await assert.rejects(
    skills.loot_village.handler({ targets: { dirt: 1 } }, ctx),
    /不允许取得物品 dirt/,
  );
  assert.equal(ctx.opened.length, 0);
});
