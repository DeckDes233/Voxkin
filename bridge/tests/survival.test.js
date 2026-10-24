import assert from 'node:assert/strict';
import test from 'node:test';

import { shelterPlan, skills } from '../skills/survival.js';

function makeBlock(name) {
  return { name, boundingBox: name === 'air' ? 'empty' : 'block' };
}

function makeWorld({ position = { x: 0, y: 1, z: 0 }, inventory = 25 } = {}) {
  const blocks = new Map();
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
  };
  return { blocks, bot, ctx, getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) || air };
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

test('leave_shelter rejects an obstructed outside position without breaking the wall', async () => {
  const world = makeWorld();
  seedShelter(world);
  for (const [x, z] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
    world.blocks.set(`${x},1,${z}`, makeBlock('stone'));
    world.blocks.set(`${x},2,${z}`, makeBlock('stone'));
  }
  let breaks = 0;
  world.ctx.breakBlock = async (position) => {
    breaks += 1;
    world.blocks.delete(`${position.x},${position.y},${position.z}`);
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
