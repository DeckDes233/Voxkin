import assert from 'node:assert/strict';
import test from 'node:test';

import { shelterPlan, skills } from '../skills/survival.js';

function makeBlock(name) {
  return { name, boundingBox: name === 'air' ? 'empty' : 'block' };
}

function makeWorld({ position = { x: 0, y: 1, z: 0 }, inventory = 25 } = {}) {
  const blocks = new Map();
  const progress = [];
  let rememberedShelter = null;
  const keyOf = ({ x, y, z }) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
  const air = makeBlock('air');
  for (let x = -5; x <= 5; x += 1) {
    for (let z = -5; z <= 5; z += 1) blocks.set(`${x},0,${z}`, makeBlock('stone'));
  }
  const bot = {
    entity: { position: { ...position } },
    inventory: { items: () => [{ name: 'cobblestone', count: inventory }] },
    blockAt: (point) => blocks.get(keyOf(point)) || air,
  };
  const ctx = {
    bot,
    countItem: (name) => name === 'cobblestone' ? inventory : 0,
    blockLabel: (name) => name,
    async sleep() {},
    async travelTo(x, y, z) {
      bot.entity.position = { x, y, z };
    },
    async placeBlock({ block, x, y, z }) {
      blocks.set(`${x},${y},${z}`, makeBlock(block));
    },
    async breakBlock({ x, y, z }) {
      blocks.delete(`${x},${y},${z}`);
    },
    reportProgress(phase, detail, value, data) {
      progress.push({ phase, detail, value, data });
    },
    rememberShelter(shelter) {
      rememberedShelter = shelter;
    },
  };
  return {
    blocks,
    bot,
    ctx,
    progress,
    get rememberedShelter() { return rememberedShelter; },
    getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) || air,
  };
}

function assertShelterStructure(world, center = { x: 0, y: 0, z: 0 }, size = 3) {
  const plan = shelterPlan(size);
  for (const cell of plan.blocks) {
    assert.equal(
      world.getBlock(center.x + cell.x, center.y + cell.y, center.z + cell.z).boundingBox,
      'block',
      `missing ${cell.kind} at ${cell.x},${cell.y},${cell.z}`,
    );
  }
  for (const cell of plan.interiorCells) {
    for (const y of [1, 2]) {
      assert.equal(
        world.getBlock(center.x + cell.x, center.y + y, center.z + cell.z).name,
        'air',
        `interior blocked at ${cell.x},${y},${cell.z}`,
      );
    }
  }
  for (const cell of plan.footprintCells) {
    assert.equal(world.getBlock(center.x + cell.x, center.y, center.z + cell.z).name, 'stone');
  }
}

function seedShelter(world, center = { x: 0, y: 0, z: 0 }, size = 3) {
  const plan = shelterPlan(size);
  for (const cell of plan.blocks) {
    world.blocks.set(
      `${center.x + cell.x},${center.y + cell.y},${center.z + cell.z}`,
      makeBlock('cobblestone'),
    );
  }
}

test('make_shelter verifies the complete walls, roof, floor, and clear interior', async () => {
  const world = makeWorld();

  const result = await skills.make_shelter.handler({ size: 3 }, world.ctx);

  assert.equal(result.status, 'succeeded');
  assertShelterStructure(world);
  assert.deepEqual(result.data.shelter, { position: { x: 0, y: 0, z: 0 }, size: 3 });
  assert.equal(result.data.sealed, true);
  assert.equal(world.progress.at(-1).phase, 'shelter_verified');
  assert.equal(world.progress.at(-1).value, 1);
  assert.deepEqual(world.rememberedShelter, result.data.shelter);
});

test('sleep_safe delegates new bed placement to the shared bridge bed helper', async () => {
  const world = makeWorld();
  let placed = false;
  let placementCalls = 0;
  world.bot.inventory.items = () => [{ name: 'white_bed', count: 1 }];
  world.bot.game = { dimension: 'overworld' };
  world.bot.time = { timeOfDay: 18000, day: 0 };
  world.ctx.isSleepTime = () => true;
  world.ctx.findNearbyBed = () => placed ? { name: 'white_bed', position: { x: 1, y: 1, z: 0 } } : null;
  world.ctx.sleepInBed = async () => ({ detail: '已经睡过一夜', bedSleepAcknowledged: true });
  world.ctx.sleepAdvancedTime = () => true;
  world.ctx.placeBlockWithFacing = async () => { throw new Error('床不能绕过共享放置接口'); };
  world.ctx.placeBedAt = async (foot, item) => {
    placementCalls += 1;
    assert.equal(item, 'white_bed');
    const head = { x: foot.x + 1, y: foot.y, z: foot.z };
    world.blocks.set(`${foot.x},${foot.y},${foot.z}`, makeBlock(item));
    world.blocks.set(`${head.x},${head.y},${head.z}`, makeBlock(item));
    placed = true;
    return { foot, head, item };
  };

  const result = await skills.sleep_safe.handler({}, world.ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(placementCalls, 1);
  assert.equal(world.getBlock(1, 1, 0).name, 'white_bed');
  assert.equal(world.getBlock(2, 1, 0).name, 'white_bed');
});

test('make_shelter can reach a flat site five blocks above an excavated pit', async () => {
  const world = makeWorld({ inventory: 64 });
  for (let x = -5; x <= 5; x += 1) {
    for (let z = -5; z <= 5; z += 1) world.blocks.delete(`${x},0,${z}`);
  }
  for (let x = 6; x <= 10; x += 1) {
    for (let z = -2; z <= 2; z += 1) world.blocks.set(`${x},5,${z}`, makeBlock('stone'));
  }
  world.bot.findBlocks = ({useExtraInfo}) => {
    const position = { x: 8, y: 5, z: 0 };
    assert.ok(useExtraInfo({...makeBlock('stone'), position}));
    return [position];
  };

  const result = await skills.make_shelter.handler({ size: 4 }, world.ctx);

  assert.equal(result.status, 'succeeded');
  assert.match(result.detail, /\(8, 5, 0\)/);
  assert.deepEqual(world.bot.entity.position, { x: 8, y: 6, z: 0 });
  assertShelterStructure(world, { x: 8, y: 5, z: 0 }, 4);
});

test('make_shelter tries the next safe footprint when pathfinding cannot reach the nearest one', async () => {
  const world = makeWorld({ inventory: 64 });
  world.bot.findBlocks = () => [{ x: 2, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }];
  const targets = [];
  world.ctx.travelTo = async (x, y, z) => {
    targets.push({ x, y, z });
    if (x === 2) throw new Error('blocked route');
    world.bot.entity.position = { x, y, z };
  };

  const result = await skills.make_shelter.handler({ size: 4 }, world.ctx);

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(targets, [{ x: 2, y: 1, z: 0 }, { x: 4, y: 1, z: 0 }]);
  assertShelterStructure(world, { x: 4, y: 0, z: 0 }, 4);
});

test('地表建棚优先平地，确认属于自己的地下半成品仍可续建', async () => {
  const cave = {x: 10, y: -6, z: 0};
  const surface = {x: 0, y: 0, z: 0};
  for (const repair of [false, true]) {
    const world = makeWorld({inventory: 64});
    const plan = shelterPlan(3);
    for (const p of plan.footprintCells) {
      world.blocks.set(`${cave.x + p.x},${cave.y},${p.z}`, makeBlock('stone'));
    }
    const wall = plan.blocks[0];
    world.blocks.set(`${cave.x + wall.x},${cave.y + wall.y},${wall.z}`, makeBlock('stone'));
    world.blocks.set('0,2,0', {...makeBlock('air'), skyLight: 15});
    world.blocks.set('10,-2,0', {...makeBlock('air'), skyLight: 0});
    world.bot.findBlocks = () => [cave, surface];
    world.ctx.getRememberedShelter = () => repair ? {position: cave, size: 3} : null;
    const result = await skills.make_shelter.handler({size: 3}, world.ctx);
    assert.deepEqual(result.data.shelter.position, repair ? cave : surface);
    assert.equal(result.data.sealed, true);
  }
});

test('make_shelter resumes a partial build using only the remaining inventory', async () => {
  const world = makeWorld({ inventory: 64 });
  let stock = 64;
  let placements = 0;
  world.bot.inventory.items = () => [{ name: 'cobblestone', count: stock }];
  world.ctx.countItem = (name) => name === 'cobblestone' ? stock : 0;
  world.ctx.placeBlock = async ({ block, x, y, z }) => {
    placements += 1;
    if (placements === 8) throw new Error('temporary placement failure');
    world.blocks.set(`${x},${y},${z}`, makeBlock(block));
    stock -= 1;
  };
  world.ctx.travelTo = async () => {
    throw new Error('route unavailable');
  };

  await assert.rejects(skills.make_shelter.handler({ size: 4 }, world.ctx), /重新寻路后仍失败/);
  assert.equal(stock, 57);
  assert.deepEqual(world.rememberedShelter, { position: { x: 0, y: 0, z: 0 }, size: 4 });
  assert.ok(world.progress.at(-1).data.placed > 0);
  world.ctx.placeBlock = async ({ block, x, y, z }) => {
    world.blocks.set(`${x},${y},${z}`, makeBlock(block));
    stock -= 1;
  };

  const result = await skills.make_shelter.handler({ size: 4 }, world.ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(stock, 24);
  assertShelterStructure(world, { x: 0, y: 0, z: 0 }, 4);
});

test('make_shelter repositions and retries a placement rejected by the server', async () => {
  const world = makeWorld({ inventory: 64 });
  const originalPlaceBlock = world.ctx.placeBlock;
  let failedOnce = false;
  let travelCalls = 0;
  world.ctx.travelTo = async (x, y, z) => {
    travelCalls += 1;
    world.bot.entity.position = { x, y, z };
  };
  world.ctx.placeBlock = async (placement) => {
    if (!failedOnce) {
      failedOnce = true;
      throw new Error('server refused placement');
    }
    return originalPlaceBlock(placement);
  };

  const result = await skills.make_shelter.handler({ size: 4 }, world.ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(travelCalls, 1);
  assertShelterStructure(world, { x: 0, y: 0, z: 0 }, 4);
});

test('make_shelter leaves a roof cell before placing when the bot hitbox overlaps it', async () => {
  const world = makeWorld({ position: { x: 8.5, y: 5, z: 8.5 }, inventory: 64 });
  for (let x = -5; x <= 5; x += 1) {
    for (let z = -5; z <= 5; z += 1) world.blocks.set(`${x},3,${z}`, makeBlock('stone'));
  }
  world.bot.findBlocks = () => [{ x: 0, y: 3, z: 0 }];
  const travelTargets = [];
  const blockedPlacements = [];
  world.ctx.travelTo = async (x, y, z) => {
    travelTargets.push({ x, y, z });
    if (travelTargets.length === 1) {
      // 模拟寻路接受了 GoalNear 的一格垂直容差，角色停在屋顶放置高度。
      world.bot.entity.position = { x: 0.5, y: 5, z: 0.5 };
      return;
    }
    world.bot.entity.position = { x, y, z };
  };
  world.ctx.placeBlock = async ({ block, x, y, z }) => {
    const position = world.bot.entity.position;
    const halfWidth = 0.3;
    const intersects = position.x + halfWidth > x
      && position.x - halfWidth < x + 1
      && position.y + 1.8 > y
      && position.y < y + 1
      && position.z + halfWidth > z
      && position.z - halfWidth < z + 1;
    if (intersects) {
      blockedPlacements.push({ x, y, z, bot: { ...position } });
      throw new Error('Server refused placement because the player occupies the target cell');
    }
    world.blocks.set(`${x},${y},${z}`, makeBlock(block));
  };

  const result = await skills.make_shelter.handler({ size: 4 }, world.ctx);

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(blockedPlacements, []);
  assert.ok(travelTargets.length > 1, '施工期间应离开被屋顶覆盖的站位');
  assert.ok(world.progress.some((entry) => entry.data?.placement_clearance?.target?.y === 6));
  assertShelterStructure(world, { x: 0, y: 3, z: 0 }, 4);
});

test('make_shelter fails when placement does not produce a complete structure', async () => {
  const world = makeWorld();
  world.ctx.placeBlock = async ({ block, x, y, z }) => {
    world.blocks.set(`${x},${y},${z}`, makeBlock(block));
    if (x === -1 && y === 1 && z === 0) world.blocks.delete('-1,1,-1');
  };

  await assert.rejects(
    skills.make_shelter.handler({ size: 3 }, world.ctx),
    /庇护所没有封闭，还缺/,
  );
  assert.equal(world.getBlock(-1, 1, -1).name, 'air');
});

test('make_shelter rejects an unsafe floor even when every wall and roof block exists', async () => {
  const world = makeWorld();
  const placeBlock = world.ctx.placeBlock;
  world.ctx.placeBlock = async (placement) => {
    await placeBlock(placement);
    if (placement.x === 1 && placement.y === 3 && placement.z === 1) {
      world.blocks.set('-1,0,-1', makeBlock('magma_block'));
    }
  };

  await assert.rejects(
    skills.make_shelter.handler({ size: 3 }, world.ctx),
    /地面 .*不安全或不完整/,
  );
  for (const cell of shelterPlan(3).blocks) {
    assert.equal(world.getBlock(cell.x, cell.y, cell.z).boundingBox, 'block');
  }
});

test('make_shelter stops placing blocks after cancellation and does not report success', async () => {
  const world = makeWorld();
  let placements = 0;
  world.ctx.placeBlock = async ({ block, x, y, z }) => {
    world.blocks.set(`${x},${y},${z}`, makeBlock(block));
    placements += 1;
    world.ctx.interrupted = true;
  };

  await assert.rejects(
    skills.make_shelter.handler({ size: 3 }, world.ctx),
    /搭建庇护所被新的指令打断/,
  );
  assert.equal(placements, 1);
  assert.equal(world.getBlock(-1, 1, -1).name, 'cobblestone');
  assert.equal(world.getBlock(1, 3, 1).name, 'air');
});

test('leave_shelter verifies that the bot reached open space outside', async () => {
  const world = makeWorld();
  seedShelter(world);

  const result = await skills.leave_shelter.handler({}, world.ctx);

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(world.bot.entity.position, { x: 2, y: 1, z: 0 });
  assert.equal(world.getBlock(1, 1, 0).name, 'air');
  assert.equal(world.getBlock(1, 2, 0).name, 'air');
});

test('leave_shelter clears safe blocks outside before walking out', async () => {
  const world = makeWorld();
  seedShelter(world);
  let breaks = 0;
  world.ctx.breakBlock = async (position) => {
    breaks += 1;
    world.blocks.delete(`${position.x},${position.y},${position.z}`);
  };

  world.blocks.set('2,1,0', makeBlock('stone'));
  world.blocks.set('2,2,0', makeBlock('stone'));
  const result = await skills.leave_shelter.handler({ range: 1 }, world.ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(breaks, 4);
  assert.deepEqual(world.bot.entity.position, { x: 2, y: 1, z: 0 });
  assert.equal(world.getBlock(2, 1, 0).name, 'air');
  assert.equal(world.getBlock(2, 2, 0).name, 'air');
});

test('leave_shelter rejects hazardous outside positions without breaking walls', async () => {
  const world = makeWorld();
  seedShelter(world);
  for (const [x, z] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
    world.blocks.set(`${x},1,${z}`, makeBlock('lava'));
    world.blocks.set(`${x},2,${z}`, makeBlock('lava'));
  }
  let breaks = 0;
  world.ctx.breakBlock = async () => {
    breaks += 1;
  };

  await assert.rejects(skills.leave_shelter.handler({ range: 1 }, world.ctx), /没有找到外侧为空地的墙/);
  assert.equal(breaks, 0);
  assert.equal(world.getBlock(1, 1, 0).name, 'cobblestone');
});

test('leave_shelter stops after cancellation and reports its partial opening', async () => {
  const world = makeWorld();
  seedShelter(world);
  let breaks = 0;
  world.ctx.breakBlock = async ({ x, y, z }) => {
    world.blocks.delete(`${x},${y},${z}`);
    breaks += 1;
    world.ctx.interrupted = true;
  };

  await assert.rejects(
    skills.leave_shelter.handler({}, world.ctx),
    /离开庇护所被新的指令打断/,
  );
  assert.equal(breaks, 1);
  assert.equal(world.getBlock(1, 1, 0).name, 'air');
  assert.equal(world.getBlock(1, 2, 0).name, 'cobblestone');
});

test('equip_armor reports verified equipped slots and any remaining empty slots', async () => {
  const slots = [];
  const world = makeWorld();
  world.bot.inventory.slots = slots;
  world.bot.armorManager = {
    async equipAll() {
      slots[5] = { name: 'iron_helmet', count: 1 };
      slots[6] = { name: 'iron_chestplate', count: 1 };
    },
  };

  const result = await skills.equip_armor.handler({}, world.ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(result.verified, true);
  assert.deepEqual(result.equippedSlots, {
    helmet: { name: 'iron_helmet', count: 1 },
    chestplate: { name: 'iron_chestplate', count: 1 },
    leggings: null,
    boots: null,
  });
  assert.deepEqual(JSON.parse(result.detail.match(/结果=(\{.*\})$/)[1]), {
    equippedSlots: result.equippedSlots,
    emptySlots: ['leggings', 'boots'],
    status: 'succeeded',
    verified: true,
  });
  assert.match(result.detail, /头盔：iron_helmet、胸甲：iron_chestplate/);
  assert.match(result.detail, /空槽：护腿、靴子/);
});

test('equip_armor does not claim success when no armor is present after equipping', async () => {
  const world = makeWorld();
  world.bot.inventory.slots = [];
  world.bot.armorManager = { async equipAll() {} };

  const result = await skills.equip_armor.handler({}, world.ctx);

  assert.equal(result.status, 'failed');
  assert.equal(result.verified, false);
  assert.deepEqual(result.equippedSlots, {
    helmet: null,
    chestplate: null,
    leggings: null,
    boots: null,
  });
  assert.deepEqual(JSON.parse(result.detail.match(/结果=(\{.*\})$/)[1]), {
    equippedSlots: result.equippedSlots,
    emptySlots: ['helmet', 'chestplate', 'leggings', 'boots'],
    status: 'failed',
    verified: false,
  });
  assert.match(result.detail, /未确认到已装备护甲/);
});
