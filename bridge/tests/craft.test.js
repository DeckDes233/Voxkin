import assert from 'node:assert/strict';
import test from 'node:test';

import { skills } from '../skills/craft.js';

const WOOD_SOURCES = [
  ['oak_log', 'oak_planks'],
  ['spruce_log', 'spruce_planks'],
  ['birch_log', 'birch_planks'],
  ['jungle_log', 'jungle_planks'],
  ['acacia_log', 'acacia_planks'],
  ['dark_oak_log', 'dark_oak_planks'],
  ['mangrove_log', 'mangrove_planks'],
  ['cherry_log', 'cherry_planks'],
];

function makeBowContext({ inventory = {}, availableLogs = [], interruptDuringMine = false } = {}) {
  const held = { ...inventory };
  const blocksByName = Object.fromEntries(
    WOOD_SOURCES.map(([log], index) => [log, { id: index + 1 }]),
  );
  const craftCalls = [];
  const mineCalls = [];
  const bot = {
    registry: { blocksByName },
    findBlocks({ matching, maxDistance }) {
      return availableLogs.includes(matching) && maxDistance >= 8 ? [{}] : [];
    },
  };
  const ctx = {
    bot,
    registry: bot.registry,
    interrupted: false,
    craftCalls,
    mineCalls,
    countItem: (name) => held[name] || 0,
    async runSkill(id, args) {
      mineCalls.push({ id, args });
      held[args.block] = Math.max(held[args.block] || 0, args.count);
      if (interruptDuringMine) ctx.interrupted = true;
      return { status: 'succeeded', detail: `采集了 ${args.block}` };
    },
    async craftItem({ item, count }) {
      craftCalls.push({ item, count });
      if (item.endsWith('_planks')) {
        const log = item.replace('_planks', '_log');
        const operations = Math.ceil(count / 4);
        if (log in held) held[log] -= operations;
        held[item] = (held[item] || 0) + operations * 4;
      } else if (item === 'stick') {
        const planks = [
          ...WOOD_SOURCES.map(([, plank]) => plank),
          'bamboo_planks',
          'crimson_planks',
          'warped_planks',
        ].find((name) => (held[name] || 0) >= 2);
        if (!planks) throw new Error('没有木板');
        const operations = Math.ceil(count / 4);
        held[planks] -= operations * 2;
        held.stick = (held.stick || 0) + operations * 4;
      } else if (item === 'crafting_table') {
        const planks = WOOD_SOURCES.map(([, plank]) => plank).find((name) => (held[name] || 0) >= 4);
        if (!planks) throw new Error('没有足够木板制作工作台');
        held[planks] -= 4;
        held.crafting_table = (held.crafting_table || 0) + 1;
      } else if (item === 'bow') {
        held.string -= 3;
        held.stick -= 3;
        held.bow = (held.bow || 0) + 1;
      } else if (item === 'arrow') {
        const operations = Math.ceil(count / 4);
        held.flint -= operations;
        held.feather -= operations;
        held.stick -= operations;
        held.arrow = (held.arrow || 0) + operations * 4;
      }
      return `合成 ${item}`;
    },
  };
  return ctx;
}

test('smelt_batch synchronizes inventory before verifying furnace output', async () => {
  const inventory = { beef: 3, coal: 1, cooked_beef: 0 };
  let pendingOutput = false;
  let syncCount = 0;
  const result = await skills.smelt_batch.handler(
    { item: 'beef', count: 3, output: 'cooked_beef' },
    {
      countItem: (name) => inventory[name] || 0,
      findFuelItem: () => ({ name: 'coal', type: 803, count: inventory.coal }),
      nearbyBlock: () => ({ name: 'furnace' }),
      async smeltItem() {
        inventory.beef = 0;
        inventory.coal = 0;
        pendingOutput = true;
        return '熔炼出 3 个 cooked_beef';
      },
      async syncInventory() {
        syncCount += 1;
        if (pendingOutput) {
          inventory.cooked_beef = 3;
          pendingOutput = false;
        }
      },
    },
  );

  assert.equal(syncCount, 1);
  assert.equal(result.status, 'succeeded');
  assert.match(result.detail, /cooked_beef，背包共 3 个/);
});

test('prepare_bow_arrows uses available non-oak wood and verifies actual inventory', async () => {
  const ctx = makeBowContext({
    inventory: { spruce_log: 4, string: 3, feather: 16, flint: 16 },
  });

  const result = await skills.prepare_bow_arrows.handler({ count: 64, range: 64 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(ctx.countItem('bow'), 1);
  assert.equal(ctx.countItem('arrow'), 64);
  assert.deepEqual(ctx.mineCalls, []);
  assert.equal(ctx.craftCalls[0].count, 14);
  assert.deepEqual(ctx.craftCalls.map((call) => call.item), [
    'spruce_planks', 'crafting_table', 'stick', 'bow', 'arrow',
  ]);
});

test('prepare_bow_arrows selects a nearby wood species and composes mine_collect', async () => {
  const ctx = makeBowContext({
    inventory: { string: 3, feather: 16, flint: 16 },
    availableLogs: [3],
  });

  const result = await skills.prepare_bow_arrows.handler({ count: 64, range: 32 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(ctx.mineCalls, [{
    id: 'mine_collect',
    args: { block: 'birch_log', count: 4, range: 32 },
  }]);
  assert.equal(ctx.craftCalls[0].count, 14);
  assert.equal(ctx.countItem('bow'), 1);
  assert.equal(ctx.countItem('arrow'), 64);
});

test('prepare_bow_arrows accepts bamboo planks and an existing crafting table', async () => {
  const ctx = makeBowContext({
    inventory: {
      bamboo_planks: 10,
      crafting_table: 1,
      string: 3,
      feather: 16,
      flint: 16,
    },
  });

  const result = await skills.prepare_bow_arrows.handler({ count: 64 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(ctx.countItem('bow'), 1);
  assert.equal(ctx.countItem('arrow'), 64);
  assert.deepEqual(ctx.craftCalls.map((call) => call.item), ['stick', 'bow', 'arrow']);
});

test('prepare_bow_arrows fails closed when required arrow materials are missing', async () => {
  const ctx = makeBowContext({ inventory: { string: 3, feather: 15, flint: 16 } });

  await assert.rejects(
    skills.prepare_bow_arrows.handler({ count: 64 }, ctx),
    /还差 1 根羽毛/,
  );
  assert.deepEqual(ctx.craftCalls, []);
  assert.deepEqual(ctx.mineCalls, []);
});

test('prepare_bow_arrows does not craft after its nested collection is interrupted', async () => {
  const ctx = makeBowContext({
    inventory: { string: 3, feather: 16, flint: 16 },
    availableLogs: [2],
    interruptDuringMine: true,
  });

  await assert.rejects(
    skills.prepare_bow_arrows.handler({ count: 64, range: 32 }, ctx),
    /被新的指令打断/,
  );
  assert.deepEqual(ctx.craftCalls, []);
  assert.equal(ctx.mineCalls.length, 1);
});
