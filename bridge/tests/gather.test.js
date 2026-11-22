import assert from 'node:assert/strict';
import test from 'node:test';

import { skills } from '../skills/gather.js';

class Vec3 {
  constructor(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  offset(dx, dy, dz) {
    return new Vec3(this.x + dx, this.y + dy, this.z + dz);
  }

  distanceTo(other) {
    return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
  }
}

function makeContext({ position = { x: 0, y: 10, z: 0 }, health = 20, blocks = new Map() } = {}) {
  const inventory = {};
  const digs = [];
  const botPosition = new Vec3(position.x, position.y, position.z);
  const bot = {
    entity: { position: botPosition, yaw: 0 },
    health,
    registry: {
      blocksByName: {
        iron_ore: { id: 1, drops: [2] },
        gravel: { id: 6, drops: [7] },
        diamond_ore: { id: 3, drops: [4] },
        deepslate_diamond_ore: { id: 5, drops: [4] },
      },
      items: {
        2: { id: 2, name: 'raw_iron' },
        7: { id: 7, name: 'gravel' },
        8: { id: 8, name: 'flint' },
        4: { id: 4, name: 'diamond' },
      },
    },
    blockAt(point) {
      return blocks.get(`${point.x},${point.y},${point.z}`) || {
        name: 'stone',
        boundingBox: 'block',
        position: new Vec3(point.x, point.y, point.z),
      };
    },
    findBlocks() {
      return [];
    },
    canDigBlock: () => true,
    async dig(block) {
      digs.push({ x: block.position.x, y: block.position.y, z: block.position.z });
      blocks.set(`${block.position.x},${block.position.y},${block.position.z}`, {
        name: 'air',
        boundingBox: 'empty',
        position: block.position,
      });
    },
  };
  const ctx = {
    bot,
    digs,
    inventory,
    blocks,
    registry: bot.registry,
    interrupted: false,
    countItem: (name) => inventory[name] || 0,
    async equipToolFor() {},
    async sleep() {},
    async collectDrops() {
      return { missed: [] };
    },
    async walkOnce(x, y, z) {
      bot.entity.position.x = x;
      bot.entity.position.y = y;
      bot.entity.position.z = z;
      return 'reached';
    },
  };
  return ctx;
}

test('bulk iron accepts the explicit minimum after a finite search, while the strict target still fails', async () => {
  for (const soft of [true, false]) {
    const ctx = makeContext();
    const position = new Vec3(1, 10, 0);
    ctx.blocks.set('1,10,0', { name: 'iron_ore', position, boundingBox: 'block' });
    ctx.bot.findBlocks = () => ctx.blocks.get('1,10,0').name === 'iron_ore' ? [position] : [];
    ctx.collectDrops = async () => { ctx.inventory.raw_iron = 1; };
    const call = skills.mine_collect.handler({ block: 'iron_ore', count: 8, ...(soft ? { minimum_count: 1 } : {}) }, ctx);
    if (soft) {
      const result = await call;
      assert.equal(result.status, 'succeeded');
      assert.equal(result.data.reserve_met, false);
      assert.equal(result.data.inventory_count, 1);
    } else await assert.rejects(call, /还差/);
  }
});

test('粗铁达到最低库存后顺手挖近矿，不再为储备远行', async () => {
  const ctx = makeContext();
  ctx.inventory.raw_iron = 8;
  const veins = [1, 2, 24].map(x => new Vec3(x, 10, 0));
  for (const position of veins) {
    ctx.blocks.set(`${position.x},10,0`, { name: 'iron_ore', position, boundingBox: 'block' });
  }
  ctx.bot.findBlocks = () => veins.filter(p => ctx.bot.blockAt(p).name === 'iron_ore');
  ctx.collectDrops = async () => { ctx.inventory.raw_iron++; };
  ctx.travelToBlock = async () => assert.fail('满足最低库存后不应向远处矿点寻路');
  ctx.exploreResource = async () => assert.fail('满足最低库存后不应换区');
  const args = { block: 'iron_ore', count: 24, minimum_count: 9 };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await skills.mine_collect.handler(args, ctx);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.data.inventory_count, 10);
    assert.equal(result.data.reserve_met, false);
  }
  assert.deepEqual(ctx.digs.map(p => p.x), [1, 2]);
});

test('换区采矿排除之前低氧的矿点，继续采集其他候选', async () => {
  const ctx = makeContext({ position: { x: 20, y: 10, z: 0 } });
  const dangerous = new Vec3(0, 10, 0), safe = new Vec3(21, 10, 0);
  for (const position of [dangerous, safe]) ctx.blocks.set(`${position.x},10,0`, { name: 'iron_ore', position, boundingBox: 'block' });
  ctx.bot.findBlocks = () => [dangerous, safe];
  ctx.collectDrops = async () => { ctx.inventory.raw_iron = 1; };
  const result = await skills.mine_collect.handler({ block: 'iron_ore', count: 1, avoid_positions: [{ x: 0, y: 10, z: 0 }] }, ctx);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(ctx.digs, [{ x: 21, y: 10, z: 0 }]);
});

test('wood_log collects mixed available species and verifies their combined actual drops', async () => {
  const ctx = makeContext();
  for (const [index, name] of ['spruce_log', 'birch_log'].entries()) {
    ctx.registry.blocksByName[name] = { id: 20 + index, name, drops: [40 + index] };
    ctx.registry.items[40 + index] = { id: 40 + index, name };
    ctx.blocks.set(`${index},10,0`, { name, position: new Vec3(index, 10, 0), boundingBox: 'block' });
  }
  ctx.bot.findBlocks = ({ matching }) => {
    assert.deepEqual(matching, [20, 21]);
    return [new Vec3(0, 10, 0), new Vec3(1, 10, 0)];
  };
  ctx.collectDrops = async (_range, name) => { ctx.inventory[name] = (ctx.inventory[name] || 0) + 1; };
  const result = await skills.mine_collect.handler({ block: 'wood_log', count: 2 }, ctx);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(ctx.inventory, { spruce_log: 1, birch_log: 1 });
  assert.equal(ctx.digs.length, 2);
});

test('iron search accepts deepslate iron even above zero and counts raw iron', async () => {
  const ctx = makeContext();
  ctx.registry.blocksByName.deepslate_iron_ore = { id: 20, drops: [2] };
  ctx.blocks.set('0,10,0', { name: 'deepslate_iron_ore', position: new Vec3(0, 10, 0), boundingBox: 'block' });
  ctx.bot.findBlocks = ({ matching }) => { assert.deepEqual(matching, [1, 20]); return [new Vec3(0, 10, 0)]; };
  ctx.collectDrops = async (_range, name) => { assert.equal(name, 'raw_iron'); ctx.inventory.raw_iron = 1; };
  assert.equal((await skills.mine_collect.handler({ block: 'iron_ore', count: 1 }, ctx)).status, 'succeeded');
});

test('mining does not destroy ore when held tool cannot harvest its drop', async () => {
  const ctx = makeContext();
  ctx.blocks.set('0,10,0', { name: 'iron_ore', position: new Vec3(0, 10, 0), boundingBox: 'block', canHarvest: () => false });
  ctx.bot.findBlocks = () => [new Vec3(0, 10, 0)];
  await assert.rejects(skills.mine_collect.handler({ block: 'iron_ore', count: 1 }, ctx), /工具不能采得/);
  assert.equal(ctx.digs.length, 0);
});

test('mine_collect stops after a dig is interrupted and does not continue collection', async () => {
  const ctx = makeContext({ position: { x: 0, y: 0, z: 0 } });
  const orePosition = new Vec3(0, 0, 0);
  ctx.bot.findBlocks = () => [orePosition];
  ctx.blocks.set('0,0,0', {
    name: 'iron_ore',
    boundingBox: 'block',
    position: orePosition,
  });
  ctx.bot.dig = async (block) => {
    ctx.digs.push({ x: block.position.x, y: block.position.y, z: block.position.z });
    ctx.interrupted = true;
  };

  await assert.rejects(
    skills.mine_collect.handler({ block: 'iron_ore', count: 1 }, ctx),
    /挖矿被取消/,
  );
  assert.equal(ctx.digs.length, 1);
  assert.equal(ctx.countItem('raw_iron'), 0);
});

test('mine_collect reports success only after the requested drops enter inventory', async () => {
  const ctx = makeContext({ position: { x: 0, y: 0, z: 0 } });
  const orePosition = new Vec3(0, 0, 0);
  ctx.bot.findBlocks = () => [orePosition];
  ctx.blocks.set('0,0,0', {
    name: 'iron_ore',
    boundingBox: 'block',
    position: orePosition,
  });
  ctx.collectDrops = async () => {
    ctx.inventory.raw_iron = (ctx.inventory.raw_iron || 0) + 1;
    return { missed: [] };
  };

  const result = await skills.mine_collect.handler({ block: 'iron_ore', count: 1 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(ctx.countItem('raw_iron'), 1);
  assert.match(result.detail, /获得 1 个/);
});

test('mine_collect searches from a new position when the first area has no ore', async () => {
  const ctx = makeContext({ position: { x: 0, y: 0, z: 0 } });
  const orePosition = new Vec3(10, 0, 0);
  ctx.blocks.set('10,0,0', { name: 'iron_ore', boundingBox: 'block', position: orePosition });
  let explorationSteps = 0;
  ctx.bot.findBlocks = () => explorationSteps ? [orePosition] : [];
  ctx.exploreResource = async () => {
    explorationSteps += 1;
    ctx.bot.entity.position.x = 10;
    return 'reached';
  };
  ctx.collectDrops = async () => {
    ctx.inventory.raw_iron = 1;
    return { missed: [] };
  };

  const result = await skills.mine_collect.handler({ block: 'iron_ore', count: 1 }, ctx);
  assert.equal(result.status, 'succeeded');
  assert.equal(explorationSteps, 1);
  assert.equal(ctx.countItem('raw_iron'), 1);
});

test('mine_collect skips unreachable ore and explores for a replacement in the same action', async () => {
  const ctx = makeContext({ position: { x: 0, y: 0, z: 0 } });
  const blocked = new Vec3(8, 0, 0);
  const found = new Vec3(20, 0, 0);
  for (const p of [blocked, found]) ctx.blocks.set(`${p.x},0,0`, { name: 'iron_ore', boundingBox: 'block', position: p });
  let moved = 0;
  let approaches = 0;
  ctx.bot.findBlocks = () => moved ? [blocked, found] : [blocked];
  ctx.travelToBlock = async () => { approaches += 1; return 'unreachable'; };
  ctx.exploreResource = async () => { moved += 1; ctx.bot.entity.position.x = 20; return 'reached'; };
  ctx.collectDrops = async () => { ctx.inventory.raw_iron = 1; return {}; };
  const result = await skills.mine_collect.handler({ block: 'iron_ore', count: 1 }, ctx);
  assert.equal(result.status, 'succeeded');
  assert.equal(approaches, 1);
  assert.equal(moved, 1);
  assert.deepEqual(ctx.digs, [{ x: 20, y: 0, z: 0 }]);
});

test('mine_collect continues searching when one deposit is exhausted before the inventory target', async () => {
  const ctx = makeContext({ position: { x: 0, y: 0, z: 0 } });
  const first = new Vec3(0, 0, 0);
  const next = new Vec3(20, 0, 0);
  for (const p of [first, next]) ctx.blocks.set(`${p.x},0,0`, { name: 'iron_ore', boundingBox: 'block', position: p });
  let moved = 0;
  ctx.bot.findBlocks = () => moved ? [next] : [first];
  ctx.exploreResource = async () => { moved += 1; ctx.bot.entity.position.x = 20; return 'reached'; };
  ctx.collectDrops = async () => { ctx.inventory.raw_iron = (ctx.inventory.raw_iron || 0) + 1; return {}; };
  const result = await skills.mine_collect.handler({ block: 'iron_ore', count: 2 }, ctx);
  assert.equal(result.status, 'succeeded');
  assert.equal(ctx.countItem('raw_iron'), 2);
  assert.equal(moved, 1);
  assert.equal(ctx.digs.length, 2);
});

test('mine_collect mines adjacent ore before traveling to a distant deposit', async () => {
  const ctx = makeContext({ position: { x: 0, y: 0, z: 0 } });
  const vein = [new Vec3(0, 0, 0), new Vec3(1, 0, 0)];
  const distant = new Vec3(12, 0, 0);
  for (const position of [...vein, distant]) {
    ctx.blocks.set(`${position.x},${position.y},${position.z}`, { name: 'iron_ore', boundingBox: 'block', position });
  }
  ctx.bot.findBlocks = () => [...vein, distant].filter((position) => ctx.blocks.get(`${position.x},${position.y},${position.z}`)?.name === 'iron_ore');
  ctx.collectDrops = async () => { ctx.inventory.raw_iron = (ctx.inventory.raw_iron || 0) + 1; return {}; };

  const result = await skills.mine_collect.handler({ block: 'iron_ore', count: 2 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(ctx.digs, [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]);
});

test('mine_collect does not explore after an explicit path stop or dig after losing health', async () => {
  for (const stopped of [true, false]) {
    const ctx = makeContext({ position: { x: 0, y: 0, z: 0 } });
    const ore = new Vec3(8, 0, 0);
    ctx.blocks.set('8,0,0', { name: 'iron_ore', boundingBox: 'block', position: ore });
    ctx.bot.findBlocks = () => [ore];
    ctx.travelToBlock = async () => { ctx.bot.health = 4; return stopped ? 'stopped' : 'reached'; };
    ctx.exploreResource = async () => { assert.fail('中止后不能继续探索'); };
    await assert.rejects(skills.mine_collect.handler({ block: 'iron_ore', count: 1 }, ctx), /取消|血量不足/);
    assert.equal(ctx.digs.length, 0);
  }
});

test('mine_collect refuses to dig when a hostile is already nearby', async () => {
  const ctx = makeContext({ position: { x: 0, y: 0, z: 0 } });
  const orePosition = new Vec3(0, 0, 0);
  ctx.bot.findBlocks = () => [orePosition];
  ctx.blocks.set('0,0,0', {
    name: 'iron_ore',
    boundingBox: 'block',
    position: orePosition,
  });
  ctx.nearbyHostiles = (radius) => {
    assert.equal(radius, 8);
    return [{ name: '骷髅' }];
  };

  await assert.rejects(
    skills.mine_collect.handler({ block: 'iron_ore', count: 1 }, ctx),
    /附近 8 格内有敌对生物（骷髅），停止采矿/,
  );
  assert.equal(ctx.digs.length, 0);
});

test('mine_collect rechecks hostile mobs after approaching a block', async () => {
  const ctx = makeContext({ position: { x: 0, y: 0, z: 0 } });
  const orePosition = new Vec3(8, 0, 0);
  ctx.bot.entity.position.x = -8;
  ctx.bot.findBlocks = () => [orePosition];
  ctx.blocks.set('8,0,0', {
    name: 'iron_ore',
    boundingBox: 'block',
    position: orePosition,
  });
  ctx.travelToBlock = async () => {
    ctx.bot.entity.position.x = 4;
    ctx.nearbyHostiles = () => [{ name: '骷髅' }];
    return 'reached';
  };

  await assert.rejects(
    skills.mine_collect.handler({ block: 'iron_ore', count: 1 }, ctx),
    /附近 8 格内有敌对生物（骷髅），停止采矿/,
  );
  assert.equal(ctx.digs.length, 0);
});

test('collect_flint mines only as much gravel as needed and verifies flint inventory', async () => {
  const ctx = makeContext({ position: { x: 0, y: 0, z: 0 } });
  const positions = [0, 1, 2, 3].map((x) => new Vec3(x, 0, 0));
  for (const position of positions) {
    ctx.blocks.set(`${position.x},${position.y},${position.z}`, {
      name: 'gravel',
      boundingBox: 'block',
      position,
    });
  }
  ctx.bot.findBlocks = () => positions;
  let pickups = 0;
  ctx.collectDrops = async () => {
    pickups += 1;
    if (pickups === 3) ctx.inventory.flint = 1;
    return { missed: [] };
  };

  const result = await skills.collect_flint.handler({ count: 1, range: 16 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(ctx.countItem('flint'), 1);
  assert.equal(ctx.digs.length, 3);
  assert.match(result.detail, /挖了 3 块砂砾，获得 1 个燧石/);
});

test('collect_flint fails when the bounded gravel search yields no flint', async () => {
  const ctx = makeContext({ position: { x: 0, y: 0, z: 0 } });
  const positions = [0, 1].map((x) => new Vec3(x, 0, 0));
  for (const position of positions) {
    ctx.blocks.set(`${position.x},${position.y},${position.z}`, {
      name: 'gravel',
      boundingBox: 'block',
      position,
    });
  }
  ctx.bot.findBlocks = () => positions;

  await assert.rejects(
    skills.collect_flint.handler({ count: 1, range: 16 }, ctx),
    /只获得 0 个燧石，还差 1 个/,
  );
  assert.equal(ctx.digs.length, 2);
});

test('collect_flint expands its bounded search for a 16-flint batch', async () => {
  const ctx = makeContext({ position: { x: 0, y: 0, z: 0 } });
  const positions = Array.from({ length: 180 }, (_, index) => {
    const x = (index % 18) - 9;
    const z = Math.floor(index / 18) - 5;
    const position = new Vec3(x, 0, z);
    ctx.blocks.set(`${position.x},${position.y},${position.z}`, {
      name: 'gravel',
      boundingBox: 'block',
      position,
    });
    return position;
  });
  let requested = 0;
  ctx.bot.findBlocks = (options) => {
    requested = options.count;
    return positions;
  };
  ctx.travelToBlock = async (position) => {
    ctx.bot.entity.position.x = position.x;
    ctx.bot.entity.position.y = position.y;
    ctx.bot.entity.position.z = position.z;
    return 'reached';
  };
  let pickups = 0;
  ctx.collectDrops = async () => {
    pickups += 1;
    if (pickups % 10 === 0) ctx.inventory.flint = (ctx.inventory.flint || 0) + 1;
    return { missed: [] };
  };

  const result = await skills.collect_flint.handler({ count: 16, range: 32 }, ctx);

  assert.equal(requested, 256);
  assert.equal(result.status, 'succeeded');
  assert.equal(ctx.countItem('flint'), 16);
  assert.equal(ctx.digs.length, 160);
});

test('collect_flint does not mine when the requested amount is already carried', async () => {
  const ctx = makeContext({ position: { x: 0, y: 0, z: 0 } });
  ctx.inventory.flint = 2;
  let searches = 0;
  ctx.bot.findBlocks = () => {
    searches += 1;
    return [];
  };

  const result = await skills.collect_flint.handler({ count: 2 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(ctx.digs.length, 0);
  assert.equal(searches, 0);
});

function makeBucketContext({ flowingWater = false } = {}) {
  const inventory = { bucket: 1, water_bucket: 1, diamond_pickaxe: 1, obsidian: 0 };
  const blocks = new Map();
  const sourceWater = new Vec3(2, 1, 0);
  const lavaSource = new Vec3(4, 1, 0);
  const positionKey = (position) => `${position.x},${position.y},${position.z}`;
  const makeBlock = (name, position, level = 0) => ({
    name,
    metadata: level,
    position: new Vec3(position.x, position.y, position.z),
    boundingBox: name === 'air' || name === 'water' || name === 'lava' ? 'empty' : 'block',
    getProperties: () => ({ level }),
  });
  blocks.set(positionKey(sourceWater), makeBlock('water', sourceWater, flowingWater ? 1 : 0));
  blocks.set(positionKey(lavaSource), makeBlock('lava', lavaSource));
  blocks.set('4,2,0', makeBlock('air', { x: 4, y: 2, z: 0 }));
  blocks.set('4,3,0', makeBlock('stone', { x: 4, y: 3, z: 0 }));
  let heldItem = null;
  const items = () => Object.entries(inventory)
    .filter(([, count]) => count > 0)
    .map(([name, count], index) => ({ name, count, type: index + 1 }));
  const bot = {
    entity: { position: new Vec3(0, 1, 0), yaw: 0 },
    game: { dimension: 'minecraft:overworld' },
    health: 20,
    registry: {
      blocksByName: {
        water: { id: 1, drops: [] },
        lava: { id: 2, drops: [] },
        obsidian: { id: 3, drops: [4] },
      },
      items: { 4: { id: 4, name: 'obsidian' } },
    },
    inventory: { items },
    async equip(item) { heldItem = item.name; },
    async activateBlock(block, face) {
      if (heldItem === 'bucket' && block.name === 'water') {
        inventory.bucket -= 1;
        inventory.water_bucket += 1;
        blocks.set(positionKey(block.position), makeBlock('air', block.position));
        return;
      }
      if (heldItem === 'water_bucket' && block.position.x === 4 && face?.y === -1) {
        inventory.water_bucket -= 1;
        inventory.bucket += 1;
        blocks.set('4,2,0', makeBlock('water', { x: 4, y: 2, z: 0 }));
        blocks.set('4,1,0', makeBlock('obsidian', { x: 4, y: 1, z: 0 }));
        return;
      }
      if (heldItem === 'bucket' && block.position.x === 4 && block.position.y === 2) {
        inventory.bucket -= 1;
        inventory.water_bucket += 1;
        blocks.set('4,2,0', makeBlock('air', { x: 4, y: 2, z: 0 }));
      }
    },
    blockAt(position) {
      return blocks.get(positionKey(position)) || makeBlock('air', position);
    },
    findBlocks({ matching, maxDistance }) {
      return [...blocks.values()]
        .filter((block) => bot.registry.blocksByName[block.name]?.id === matching)
        .filter((block) => block.position.distanceTo(bot.entity.position) <= maxDistance)
        .map((block) => block.position);
    },
    async waitForChunksToLoad() {},
    canDigBlock: () => true,
    async dig(block) {
      blocks.set(positionKey(block.position), makeBlock('air', block.position));
    },
  };
  const ctx = {
    bot,
    registry: bot.registry,
    interrupted: false,
    inventory,
    countItem: (name) => inventory[name] || 0,
    async equipToolFor() {},
    async syncInventory() {},
    async sleep() {},
    nearbyHostiles: () => [],
    async travelToBlock() { return 'unreachable'; },
    async collectDrops() {
      inventory.obsidian += 1;
      return { missed: [] };
    },
  };
  return { ctx, blocks, inventory, sourceWater, lavaSource };
}

test('fill_water_bucket rejects flowing water instead of claiming a filled bucket', async () => {
  const { ctx } = makeBucketContext({ flowingWater: true });
  ctx.inventory.bucket = 1;
  ctx.inventory.water_bucket = 0;

  await assert.rejects(
    skills.fill_water_bucket.handler({ range: 16 }, ctx),
    /没有已加载的静止水源/,
  );
  assert.equal(ctx.countItem('bucket'), 1);
  assert.equal(ctx.countItem('water_bucket'), 0);
});

test('fill_water_bucket verifies the inventory change after using a still source', async () => {
  const { ctx } = makeBucketContext();
  ctx.inventory.bucket = 1;
  ctx.inventory.water_bucket = 0;

  const result = await skills.fill_water_bucket.handler({ range: 16 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(ctx.countItem('water_bucket'), 1);
  assert.equal(ctx.countItem('bucket'), 0);
});

test('fill_water_bucket explores again after the first still source is unreachable', async () => {
  const { ctx, blocks } = makeBucketContext();
  ctx.inventory.bucket = 1;
  ctx.inventory.water_bucket = 0;
  blocks.delete('2,1,0');
  const distantWater = (x) => ({
    name: 'water',
    metadata: 0,
    position: new Vec3(x, 1, 0),
    boundingBox: 'empty',
    getProperties: () => ({ level: 0 }),
  });
  blocks.set('8,1,0', distantWater(8));
  const attempts = [];
  let explorations = 0;
  let explorationState;
  ctx.travelToBlock = async (position) => {
    attempts.push(position.x);
    if (position.x === 8) return 'unreachable';
    ctx.bot.entity.position.x = position.x - 2;
    return 'reached';
  };
  ctx.exploreResource = async (step, _heading, search) => {
    assert.ok(search.visited instanceof Set);
    explorationState = search;
    search.visited.add(`fluid-search-${step}`);
    explorations += 1;
    if (explorations === 1) {
      blocks.set('12,1,0', distantWater(12));
      return 'reached';
    }
    return 'no_target';
  };

  const result = await skills.fill_water_bucket.handler({ range: 16 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(attempts, [8, 12]);
  assert.equal(explorations, 1);
  assert.ok(explorationState.visited.has('fluid-search-0'));
  assert.equal(ctx.countItem('water_bucket'), 1);
});

test('collect_obsidian casts one still lava source, reclaims water, and verifies the mined drop', async () => {
  const { ctx, blocks } = makeBucketContext();
  ctx.inventory.water_bucket = 0;

  const result = await skills.collect_obsidian.handler({ count: 1, range: 16 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(ctx.countItem('obsidian'), 1);
  assert.equal(ctx.countItem('water_bucket'), 1);
  assert.equal(ctx.countItem('bucket'), 0);
  assert.equal(blocks.get('4,1,0').name, 'air');
  assert.match(result.detail, /安全浇铸后采集/);
});

test('collect_obsidian explores again after its initial lava source cannot be reached', async () => {
  const { ctx, blocks, inventory } = makeBucketContext();
  ctx.inventory.water_bucket = 0;
  blocks.delete('4,1,0');
  const makeBlock = (name, position) => ({
    name,
    metadata: 0,
    position: new Vec3(position.x, position.y, position.z),
    boundingBox: name === 'air' || name === 'water' || name === 'lava' ? 'empty' : 'block',
    getProperties: () => ({ level: 0 }),
  });
  blocks.set('8,1,0', makeBlock('lava', { x: 8, y: 1, z: 0 }));
  const activateBlock = ctx.bot.activateBlock;
  ctx.bot.activateBlock = async (block, face) => {
    if (block.position.x === 12 && face?.y === -1) {
      inventory.water_bucket -= 1;
      inventory.bucket += 1;
      blocks.set('12,2,0', makeBlock('water', { x: 12, y: 2, z: 0 }));
      blocks.set('12,1,0', makeBlock('obsidian', { x: 12, y: 1, z: 0 }));
      return;
    }
    if (block.position.x === 12 && block.position.y === 2 && block.name === 'water') {
      inventory.bucket -= 1;
      inventory.water_bucket += 1;
      blocks.set('12,2,0', makeBlock('air', { x: 12, y: 2, z: 0 }));
      return;
    }
    return activateBlock(block, face);
  };
  const attempts = [];
  let inLavaSearch = false;
  let lavaExplorations = 0;
  ctx.travelToBlock = async (position) => {
    attempts.push(position.x);
    if (position.x === 8) {
      inLavaSearch = true;
      return 'unreachable';
    }
    ctx.bot.entity.position.x = position.x - 2;
    return 'reached';
  };
  ctx.exploreResource = async () => {
    if (!inLavaSearch) return 'no_target';
    lavaExplorations += 1;
    if (lavaExplorations === 1) {
      blocks.set('12,1,0', makeBlock('lava', { x: 12, y: 1, z: 0 }));
      blocks.set('12,2,0', makeBlock('air', { x: 12, y: 2, z: 0 }));
      blocks.set('12,3,0', makeBlock('stone', { x: 12, y: 3, z: 0 }));
      return 'reached';
    }
    return 'no_target';
  };

  const result = await skills.collect_obsidian.handler({ count: 1, range: 16 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(attempts, [8, 12]);
  assert.equal(lavaExplorations, 1);
  assert.equal(ctx.countItem('obsidian'), 1);
  assert.equal(ctx.countItem('water_bucket'), 1);
});

test('collect_obsidian refuses to approach lava with low health', async () => {
  const { ctx } = makeBucketContext();
  ctx.bot.health = 10;

  await assert.rejects(
    skills.collect_obsidian.handler({ count: 1, range: 16 }, ctx),
    /血量不足/,
  );
  assert.equal(ctx.countItem('obsidian'), 0);
});

test('collect_obsidian rechecks hostile mobs after approaching lava', async () => {
  const { ctx, blocks } = makeBucketContext();
  ctx.inventory.water_bucket = 0;
  ctx.bot.entity.position.x = -2;
  ctx.travelToBlock = async (position) => {
    ctx.bot.entity.position.x = position.x - 2;
    ctx.bot.entity.position.y = position.y;
    ctx.bot.entity.position.z = position.z;
    ctx.nearbyHostiles = () => [{ name: 'zombie' }];
    return 'reached';
  };

  await assert.rejects(
    skills.collect_obsidian.handler({ count: 1, range: 16 }, ctx),
    /靠近岩浆后发现敌对生物/,
  );
  assert.equal(blocks.get('4,1,0').name, 'lava');
  assert.equal(ctx.countItem('water_bucket'), 1);
  assert.equal(ctx.countItem('obsidian'), 0);
});

test('collect_obsidian does not try another lava source after health drops while approaching', async () => {
  const { ctx, blocks } = makeBucketContext();
  ctx.inventory.water_bucket = 0;
  ctx.bot.entity.position.x = -2;
  const secondLava = new Vec3(8, 1, 0);
  blocks.set('8,1,0', {
    ...blocks.get('4,1,0'),
    position: secondLava,
  });
  const attemptedLava = [];
  ctx.travelToBlock = async (position) => {
    attemptedLava.push(position.x);
    if (position.x === 4) {
      ctx.bot.health = 10;
      return 'unreachable';
    }
    return 'reached';
  };

  await assert.rejects(
    skills.collect_obsidian.handler({ count: 1, range: 16 }, ctx),
    /血量不足/,
  );
  assert.deepEqual(attemptedLava, [4]);
  assert.equal(blocks.get('4,1,0').name, 'lava');
  assert.equal(blocks.get('8,1,0').name, 'lava');
  assert.equal(ctx.countItem('obsidian'), 0);
});

test('collect_obsidian does not try another lava source after a cancelled approach', async () => {
  const { ctx, blocks } = makeBucketContext();
  ctx.inventory.water_bucket = 0;
  ctx.bot.entity.position.x = -2;
  const secondLava = new Vec3(8, 1, 0);
  blocks.set('8,1,0', {
    ...blocks.get('4,1,0'),
    position: secondLava,
  });
  const attemptedLava = [];
  ctx.travelToBlock = async (position) => {
    attemptedLava.push(position.x);
    return position.x === 4 ? 'cancelled' : 'reached';
  };

  await assert.rejects(
    skills.collect_obsidian.handler({ count: 1, range: 16 }, ctx),
    /被取消/,
  );
  assert.deepEqual(attemptedLava, [4]);
  assert.equal(blocks.get('4,1,0').name, 'lava');
  assert.equal(blocks.get('8,1,0').name, 'lava');
  assert.equal(ctx.countItem('obsidian'), 0);
});

test('deep_mine applies its low-health threshold before entering a vertical shaft', async () => {
  const ctx = makeContext({ position: { x: 0, y: 2, z: 0 }, health: 9 });

  await assert.rejects(
    skills.deep_mine.handler({ y: -56, lowHealth: 10, length: 1, branches: 0 }, ctx),
    /血量不足/,
  );
  assert.equal(ctx.digs.length, 0);
});

test('deep_mine descends by a supported stair instead of stepping into a cave opening', async () => {
  const ctx = makeContext({ position: { x: 0, y: 2, z: 0 } });
  ctx.blocks.set('0,0,0', {
    name: 'air',
    boundingBox: 'empty',
    position: new Vec3(0, 0, 0),
  });

  const result = await skills.deep_mine.handler({
    y: 0,
    length: 1,
    branches: 0,
    direction: 'east',
  }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(ctx.digs.slice(0, 2).map(({ x, y, z }) => [x, y, z]), [[0, 2, 1], [0, 1, 1]]);
  assert.equal(ctx.bot.entity.position.y, 0);
});

test('deep_mine refuses to descend when no adjacent stair has solid support', async () => {
  const ctx = makeContext({ position: { x: 0, y: 2, z: 0 } });
  const blockAt = ctx.bot.blockAt;
  let walks = 0;
  ctx.bot.blockAt = (point) => {
    if (point.y === 0) {
      return { name: 'air', boundingBox: 'empty', position: new Vec3(point.x, point.y, point.z) };
    }
    return blockAt(point);
  };
  ctx.walkOnce = async () => {
    walks += 1;
    return 'reached';
  };

  let error;
  await assert.rejects(
    skills.deep_mine.handler({ y: 0, length: 1, branches: 0 }, ctx),
    (caught) => {
      error = caught;
      return /没有安全的阶梯落点/.test(caught.message);
    },
  );
  assert.equal(ctx.digs.length, 0);
  assert.equal(walks, 0);
  assert.equal(ctx.bot.entity.position.y, 2);
  assert.equal(error.data.phase, 'safe_stop');
  assert.equal(error.data.reason, 'no_safe_stair');
  assert.deepEqual(error.data.position, { x: 0, y: 2, z: 0 });
  assert.equal(error.data.target_y, 0);
  assert.equal(error.data.candidates.length, 4);
  assert.ok(error.data.candidates.every((candidate) =>
    candidate.reason === 'unsupported' &&
    candidate.loaded === true &&
    candidate.name === 'air' &&
    candidate.bounding_box === 'empty' &&
    candidate.ground_position.y === 0,
  ));
});

test('deep_mine rejects an actual pathfinding landing in fluid or an unloaded cell', async (t) => {
  const cases = [
    {
      name: 'water at the feet',
      position: '1,1,1',
      block: { name: 'water', boundingBox: 'empty' },
    },
    {
      name: 'lava at the head',
      position: '1,2,1',
      block: { name: 'lava', boundingBox: 'empty' },
    },
    {
      name: 'unloaded support',
      position: '1,0,1',
      block: null,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const ctx = makeContext({ position: { x: 0, y: 2, z: 0 } });
      const blockAt = ctx.bot.blockAt;
      ctx.bot.blockAt = (point) => {
        const key = `${point.x},${point.y},${point.z}`;
        if (key === scenario.position) {
          return scenario.block && {
            ...scenario.block,
            position: new Vec3(point.x, point.y, point.z),
          };
        }
        return blockAt(point);
      };
      ctx.walkOnce = async (x, y) => {
        ctx.bot.entity.position.x = 1;
        ctx.bot.entity.position.y = y;
        ctx.bot.entity.position.z = 1;
        return 'reached';
      };

      await assert.rejects(
        skills.deep_mine.handler({ y: 1, length: 1, branches: 0 }, ctx),
        /挖阶梯后落点未确认安全/,
      );
      assert.equal(ctx.digs.length, 2);
    });
  }
});

test('mine_collect treats regular and deepslate diamond ore as interchangeable targets', async () => {
  const ctx = makeContext({ position: { x: 0, y: -56, z: 0 } });
  const regular = new Vec3(0, -56, 0);
  const deepslate = new Vec3(1, -56, 0);
  ctx.blocks.set('0,-56,0', { name: 'diamond_ore', position: regular });
  ctx.blocks.set('1,-56,0', { name: 'deepslate_diamond_ore', position: deepslate });
  ctx.bot.findBlocks = ({ matching }) => {
    assert.deepEqual(matching, [3, 5]);
    return [regular, deepslate];
  };
  ctx.collectDrops = async () => {
    ctx.inventory.diamond = (ctx.inventory.diamond || 0) + 1;
    return { missed: [] };
  };

  const result = await skills.mine_collect.handler({ block: 'deepslate_diamond_ore', count: 2 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(ctx.countItem('diamond'), 2);
  assert.equal(ctx.digs.length, 2);
});

test('deep_mine completes its requested tunnel length at the target depth', async () => {
  const ctx = makeContext({ position: { x: 0, y: -56, z: 0 } });
  ctx.bot.blockAt = (point) => {
    const key = `${point.x},${point.y},${point.z}`;
    if (ctx.blocks.has(key)) return ctx.blocks.get(key);
    return point.y > -56
      ? { name: 'air', boundingBox: 'empty', position: new Vec3(point.x, point.y, point.z) }
      : { name: 'stone', boundingBox: 'block', position: new Vec3(point.x, point.y, point.z) };
  };

  const result = await skills.deep_mine.handler({
    y: -56,
    length: 1,
    branches: 0,
    direction: 'east',
  }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.match(result.detail, /Y=-56/);
  assert.match(result.detail, /挖了 1 格长度/);
});

test('strip_mine does not continue after its safe-path capability is unavailable', async () => {
  const ctx = makeContext({ position: { x: 0, y: 0, z: 0 } });
  delete ctx.walkOnce;

  await assert.rejects(
    skills.strip_mine.handler({
      length: 1,
      branches: 0,
      direction: 'east',
      torchInterval: 0,
    }, ctx),
    /位置未确认/,
  );
});

test('strip_mine aborts when a branch cannot return to the main tunnel', async () => {
  const ctx = makeContext({ position: { x: 0, y: 0, z: 0 } });
  const mainPath = [];
  ctx.bot.blockAt = (point) => {
    const key = `${point.x},${point.y},${point.z}`;
    if (point.y > 0) return { name: 'air', boundingBox: 'empty', position: new Vec3(point.x, point.y, point.z) };
    if (ctx.blocks.has(key)) return ctx.blocks.get(key);
    return { name: 'stone', boundingBox: 'block', position: new Vec3(point.x, point.y, point.z) };
  };
  ctx.walkOnce = async (x, y, z) => {
    if (x === 2 && z === 0 && ctx.digs.some((dig) => dig.x === 2 && dig.z === 1)) {
      return 'unreachable';
    }
    ctx.bot.entity.position.x = x;
    ctx.bot.entity.position.y = y;
    ctx.bot.entity.position.z = z;
    if (z === 0) mainPath.push(x);
    return 'reached';
  };

  await assert.rejects(
    skills.strip_mine.handler({
      length: 4,
      branches: 1,
      branchLength: 1,
      direction: 'east',
      torchInterval: 0,
    }, ctx),
    /支巷没能返回主巷/,
  );
  assert.deepEqual(mainPath, [1, 2]);
  assert.equal(ctx.digs.some((dig) => dig.x === 3 && dig.z === 0), false);
});

test('strip_mine does not claim success when movement prevents the requested length', async () => {
  const ctx = makeContext({ position: { x: 0, y: 0, z: 0 } });
  ctx.walkOnce = async () => 'unreachable';

  await assert.rejects(
    skills.strip_mine.handler({
      length: 1,
      branches: 0,
      direction: 'east',
      torchInterval: 0,
    }, ctx),
    /位置未确认/,
  );
});

test('strip_mine reports success after reaching the full requested length', async () => {
  const ctx = makeContext({ position: { x: 0, y: 0, z: 0 } });
  ctx.bot.blockAt = (point) => {
    const key = `${point.x},${point.y},${point.z}`;
    if (ctx.blocks.has(key)) return ctx.blocks.get(key);
    return point.y > 0
      ? { name: 'air', boundingBox: 'empty', position: new Vec3(point.x, point.y, point.z) }
      : { name: 'stone', boundingBox: 'block', position: new Vec3(point.x, point.y, point.z) };
  };

  const result = await skills.strip_mine.handler({
    length: 2,
    branches: 0,
    direction: 'east',
    torchInterval: 0,
  }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.match(result.detail, /挖了 2 格长度/);
});

test('find_diamond excludes stale positions that no longer contain diamond ore', async () => {
  const ctx = makeContext({ position: { x: 0, y: -56, z: 0 } });
  const stale = new Vec3(1, -56, 0);
  const valid = new Vec3(2, -56, 0);
  ctx.bot.findBlocks = () => [stale, valid];
  ctx.blocks.set('1,-56,0', {
    name: 'stone',
    boundingBox: 'block',
    position: stale,
  });
  ctx.blocks.set('2,-56,0', {
    name: 'deepslate_diamond_ore',
    boundingBox: 'block',
    position: valid,
  });

  const result = await skills.find_diamond.handler({ yMin: -59, yMax: -54 }, ctx);

  assert.match(result.detail, /deepslate_diamond_ore \(2, -56, 0\)/);
  assert.doesNotMatch(result.detail, /\(1, -56, 0\)/);
});
test('mine_collect 的总库存目标跨越 64 堆叠边界', async () => {
  const ctx = makeContext();
  const position = new Vec3(1,10,0);
  ctx.registry.blocksByName.dirt = {id: 31, name:'dirt', drops:[32]};
  ctx.registry.items[32] = {id:32,name:'dirt'};
  ctx.inventory.dirt = 64;
  ctx.blocks.set('1,10,0',{name:'dirt',position,boundingBox:'block'});
  ctx.bot.findBlocks = () => ctx.blocks.get('1,10,0').name === 'dirt' ? [position] : [];
  ctx.collectDrops = async () => {ctx.inventory.dirt += 1;};
  const result = await skills.mine_collect.handler({block:'dirt',count:65},ctx);
  assert.equal(result.status,'succeeded'); assert.equal(ctx.inventory.dirt,65); assert.equal(ctx.digs.length,1);
  await skills.mine_collect.handler({block:'dirt',count:65},ctx);
  assert.equal(ctx.digs.length,1);
  await assert.rejects(skills.mine_collect.handler({block:'dirt',count:2305},ctx), /1-2304/);
});
test('mine_collect 拒绝越界最低门槛且未达门槛不报成功', async () => {
  const ctx = makeContext();
  await assert.rejects(skills.mine_collect.handler({block:'iron_ore',count:2,minimum_count:3},ctx), /minimum_count/);
  const position = new Vec3(1,10,0);
  ctx.blocks.set('1,10,0',{name:'iron_ore',position,boundingBox:'block'});
  ctx.bot.findBlocks = () => ctx.blocks.get('1,10,0').name === 'iron_ore' ? [position] : [];
  ctx.collectDrops = async () => {ctx.inventory.raw_iron = 1;};
  await assert.rejects(skills.mine_collect.handler({block:'iron_ore',count:4,minimum_count:2},ctx), /还差/);
});
