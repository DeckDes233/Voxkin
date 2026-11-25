import assert from 'node:assert/strict';
import test from 'node:test';

import { createObservation, inspectShelter } from '../world_observation.js';

function makeWorld() {
  const blocks = new Map();
  const setBlock = (x, y, z, name = 'cobblestone') => blocks.set(`${x},${y},${z}`, { name, boundingBox: 'block' });
  for (let dx = -2; dx <= 1; dx += 1) {
    for (let dz = -2; dz <= 1; dz += 1) {
      const edge = dx === -2 || dx === 1 || dz === -2 || dz === 1;
      setBlock(dx, 0, dz, 'stone');
      blocks.set(`${dx},1,${dz}`, { name: 'air', boundingBox: 'empty' });
      blocks.set(`${dx},2,${dz}`, { name: 'air', boundingBox: 'empty' });
      setBlock(dx, 3, dz, 'stone');
      if (edge) {
        setBlock(dx, 1, dz, 'cobblestone');
        setBlock(dx, 2, dz, 'cobblestone');
      }
    }
  }
  const bed = { x: 0, y: 1, z: 0 };
  setBlock(bed.x, bed.y, bed.z, 'red_bed');
  return {
    blocks,
    bed,
    bot: {
      username: 'Voxkin',
      health: 20,
      food: 16,
      game: { dimension: 'minecraft:overworld' },
      time: { timeOfDay: 18000, day: 2, isDay: false },
      entity: {
        position: { x: 0.5, y: 1, z: 0.5, distanceTo(other) { return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z); } },
        yaw: 0,
        pitch: 0,
      },
      inventory: { items: () => [{ name: 'oak_planks', count: 4 }] },
      players: {},
      registry: {
        blocksByName: {
          white_bed: { id: 355 },
          red_bed: { id: 26 },
        },
      },
      findBlocks() { throw new Error('observation must not scan loaded chunks globally'); },
      blockAt(point) { return blocks.get(`${point.x},${point.y},${point.z}`) || null; },
    },
  };
}

test('observation carries session revision and actual executor state', () => {
  const world = makeWorld();
  const state = createObservation(world.bot, {
    sessionId: 'session-a', revision: 17, ready: true,
    executor: { active_action_id: null, safety_active: false, epoch: 9 },
    shelter: { position: { x: 0, y: 0, z: 0 }, size: 4 },
  });
  assert.equal(state.session_id, 'session-a');
  assert.equal(state.revision, 17);
  assert.equal(state.ready, true);
  assert.equal(state.nearby_owned_crafting_table, false);
  assert.deepEqual(state.executor, { active_action_id: null, safety_active: false, epoch: 9 });
  assert.deepEqual(state.inventory, { oak_planks: 4 });
  assert.deepEqual(state.shelter, {
    position: { x: 0, y: 0, z: 0 }, size: 4,
    bounds: { min: { x: -2, y: 0, z: -2 }, max: { x: 1, y: 3, z: 1 } },
    sealed: true, inside: true, missing_blocks: 0, unsafe_blocks: 0,
  });
  assert.deepEqual(state.nearby_beds, [world.bed]);
});

test('observation reports a verified owned table without inventing an inventory item', () => {
  const world = makeWorld();
  const state = createObservation(world.bot, {
    sessionId: 'session-a', revision: 18, ready: true,
    executor: {}, nearbyOwnedCraftingTable: true,
  });
  assert.equal(state.nearby_owned_crafting_table, true);
  assert.equal(state.nearby_crafting_table, true);
  assert.equal(state.inventory.crafting_table, undefined);
  const nearby = createObservation(world.bot, { executor: {}, nearbyCraftingTable: true });
  assert.equal(nearby.nearby_crafting_table, true);
  assert.equal(nearby.nearby_owned_crafting_table, false);
  assert.equal(nearby.inventory.crafting_table, undefined);
});

test('an enclosed cave at Y=62 reports the dry sunlit turf above it', () => {
  const { bot } = makeWorld();
  bot.entity.position.y = 62;
  bot.blockAt = p => p.y >= 79 ? { name: 'air', skyLight: 15, boundingBox: 'empty' }
    : p.y === 78 ? { name: 'grass_block', skyLight: 0, boundingBox: 'block' }
    : { name: 'cave_air', skyLight: 0, boundingBox: 'empty' };
  const { surface_access } = createObservation(bot, { executor: {} });
  assert.deepEqual(surface_access, { sky_light: 0, exit: { x: 0, y: 79, z: 0 } });
});

test('水底洞穴的返程观察选取近岸干地，跳过亮度充足的水面', () => {
  const {bot} = makeWorld();
  bot.entity.position.y = 58;
  bot.blockAt = p => {
    if (p.y >= 63) return {name: 'air', skyLight: 15, boundingBox: 'empty'};
    if (p.y === 62 && p.z === 8) return {name: 'sand', boundingBox: 'block'};
    if (p.y >= 61) return {name: 'water', skyLight: 13, boundingBox: 'empty'};
    return {name: 'air', skyLight: 11, boundingBox: 'empty'};
  };
  assert.deepEqual(createObservation(bot, {executor: {}}).surface_access,
    {sky_light: 11, exit: {x: 0, y: 63, z: 8}});
});

test('副手盾计入装备持有数且不会重复统计，副手材料仍与合成库存分开', () => {
  const { bot } = makeWorld();
  const shield = { name: 'shield', count: 1, slot: 45 };
  bot.inventory.slots = [];
  bot.inventory.slots[45] = shield;
  bot.inventory.items = () => [{ name: 'shield', count: 1, slot: 9 }];
  const observe = () => createObservation(bot, { sessionId: 'shield-test', revision: 1, ready: true });
  assert.equal(observe().inventory.shield, 2);
  bot.inventory.items = () => [shield];
  assert.equal(observe().inventory.shield, 1);
  bot.inventory.items = () => [];
  bot.inventory.slots[45] = { name: 'oak_planks', count: 3, slot: 45 };
  assert.equal(observe().off_hand, 'oak_planks');
  assert.equal(observe().inventory.oak_planks, undefined);
});

test('shelter observation rechecks every wall and roof block on each snapshot', () => {
  const world = makeWorld();
  const shelter = { position: { x: 0, y: 0, z: 0 }, size: 4 };
  assert.equal(inspectShelter(world.bot, shelter).sealed, true);
  for (const [key, block] of [
    ['0,3,0', null], // 内部屋顶缺口
    ['0,0,0', null], // 地板缺口
    ['-2,1,0', { name: 'cactus', boundingBox: 'block' }], // 危险墙体
    ['0,1,0', { name: 'stone', boundingBox: 'block' }], // 床以外的内部实心占位
  ]) {
    const broken = makeWorld();
    if (block) broken.blocks.set(key, block);
    else broken.blocks.delete(key);
    const state = inspectShelter(broken.bot, shelter);
    assert.equal(state.sealed, false, `expected ${key} to invalidate the shelter`);
    assert.equal(state.inside, false);
  }
  const brokenRoof = makeWorld();
  brokenRoof.blocks.set('0,3,0', { name: 'air', boundingBox: 'empty' });
  assert.equal(inspectShelter(brokenRoof.bot, shelter).missing_blocks, 1);
  const unsafeWall = makeWorld();
  unsafeWall.blocks.set('-2,1,0', { name: 'cactus', boundingBox: 'block' });
  assert.equal(inspectShelter(unsafeWall.bot, shelter).missing_blocks, 0);
  assert.equal(inspectShelter(unsafeWall.bot, shelter).unsafe_blocks, 1);
  const unloaded = makeWorld();
  unloaded.blocks.delete('0,0,0');
  unloaded.bot.blockAt = (point) => unloaded.blocks.get(`${point.x},${point.y},${point.z}`) || null;
  assert.equal(Object.hasOwn(inspectShelter(unloaded.bot, shelter), 'missing_blocks'), false);
});

test('player standing in the roof block is not reported inside the shelter', () => {
  const world = makeWorld();
  world.bot.entity.position.y = 3;
  const state = inspectShelter(world.bot, { position: { x: 0, y: 0, z: 0 }, size: 4 });
  assert.equal(state.sealed, true);
  assert.equal(state.inside, false);
});

test('nearby beds only include current bed blocks inside the known shelter', () => {
  const world = makeWorld();
  const shelter = { position: { x: 0, y: 0, z: 0 }, size: 4 };
  world.blocks.set('20,1,20', { name: 'white_bed', boundingBox: 'block' });
  assert.deepEqual(createObservation(world.bot, { shelter }).nearby_beds, [world.bed]);
  world.blocks.delete('0,1,0');
  assert.deepEqual(createObservation(world.bot, { shelter }).nearby_beds, []);
  assert.deepEqual(createObservation(world.bot, { shelter: null }).nearby_beds, []);
});
