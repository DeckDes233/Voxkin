import assert from 'node:assert/strict';
import test from 'node:test';
import { Vec3 } from 'vec3';

import { createObservation, inspectShelter } from '../world_observation.js';
import { findObservedBlocks } from '../loaded_block_scan.js';

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

test('主世界取土威胁区分现场敌怪、确认安全和未观察', () => {
  const {bot} = makeWorld();
  for (const hostiles of [[], [{name: '苦力怕', distance: 5.2}]]) {
    assert.deepEqual(createObservation(bot, {executor: {}, overworldMiningHostiles: hostiles}).overworld_mining_hostiles, hostiles);
  }
  assert.equal(createObservation(bot, {executor: {}}).overworld_mining_hostiles, undefined);
});

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

test('连续快照复用门框坐标，填眼、遮挡和换世界立即生效', () => {
  const { bot } = makeWorld();
  bot.entity.position = new Vec3(0.5, 62, 0.5);
  bot.registry.blocksByName.end_portal_frame = { id: 42 };
  const pos = new Vec3(2, 62, 0);
  let searches = 0, filled = false, visible = true;
  bot.findBlocks = ({ matching, maxDistance }) => {
    assert.equal(matching, 42);
    assert.equal(maxDistance, 12);
    searches++;
    return [pos];
  };
  bot.blockAt = p => p === pos ? { name: 'end_portal_frame', getProperties: () => ({ eye: filled }) } : null;
  bot.canSeeBlock = () => visible;
  const room = sessionId => createObservation(bot, { sessionId }).end_portal_room;
  assert.equal(room('a').frames[0].filled, false);
  filled = true;
  assert.equal(room('a').frames[0].filled, true);
  visible = false;
  assert.equal(room('a'), null);
  assert.equal(searches, 1);
  visible = true;
  assert.equal(room('b').frames.length, 1);
  assert.equal(searches, 2);
  bot.game.dimension = 'minecraft:the_nether';
  assert.equal(room('b'), null);
  bot.game.dimension = 'minecraft:overworld';
  assert.equal(room('b').frames.length, 1);
  assert.equal(searches, 3);
});

test('已加载区块的坐标查询与逐格球形查找一致，包含不同方块状态与负高度', async () => {
  const Chunk = (await import('prismarine-chunk')).default('1.21.1');
  const {blocksByName: blocks} = (await import('prismarine-registry')).default('1.21.1');
  const center = new Vec3(-0.3, -1.2, -16.5), floor = center.floored();
  const columns = new Map();
  const entries = [blocks.end_portal_frame, blocks.red_bed, blocks.chest, blocks.crafting_table];
  for (const [dx, dy, dz, state] of [
    [-1, -3, -3, blocks.end_portal_frame.maxStateId], [2, 0, -1, blocks.red_bed.minStateId],
    [12, 0, 0, blocks.chest.maxStateId], [1, 9, 9, blocks.chest.minStateId],
    [0, 12, 1, blocks.end_portal_frame.minStateId], [-6, 1, 1, blocks.crafting_table.minStateId],
    [1, 1, 0, blocks.white_wool.minStateId],
  ]) {
    const p = floor.offset(dx, dy, dz);
    const key = `${p.x >> 4},${p.z >> 4}`;
    if (!columns.has(key)) columns.set(key, new Chunk());
    const chunk = columns.get(key);
    chunk.setBlockStateId(new Vec3(p.x & 15, p.y, p.z & 15), state);
    if (dx === 2) chunk.sections[(p.y >> 4) - (chunk.minY >> 4)].palette = null;
  }
  const bot = {entity: {position: center}, world: {getColumn: (cx, cz) => columns.get(`${cx},${cz}`)}};
  for (const [radius, count] of [[4, 1], [12, 12], [32, 2]]) {
    const expected = [];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dz = -radius; dz <= radius; dz++) {
          if (dx * dx + dy * dy + dz * dz > radius * radius) continue;
          const p = floor.offset(dx, dy, dz);
          const chunk = bot.world.getColumn(p.x >> 4, p.z >> 4);
          const state = chunk?.getBlockStateId(new Vec3(p.x & 15, p.y, p.z & 15));
          if (entries.some(b => b.minStateId <= state && state <= b.maxStateId)) expected.push(p);
        }
      }
    }
    expected.sort((a, b) => a.distanceSquared(floor) - b.distanceSquared(floor));
    assert.deepEqual(findObservedBlocks(bot, entries, radius, count), expected.slice(0, count));
  }
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

test('地下出口先检查支撑面，同一位置的地形变化立即可见', () => {
  const { bot } = makeWorld();
  bot.entity.position.y = 62;
  const blocks = bot.registry.blocksByName;
  for (const [id, name] of ['air', 'short_grass', 'tall_grass', 'stone'].entries()) blocks[name] = { id };
  let hasLedge = false;
  let headLoaded = true;
  let blockReads = 0;
  const atLedge = p => p.x === 4 && p.z === 0;
  const nameAt = p => hasLedge && atLedge(p) && p.y === 70 ? 'stone' : 'air';
  bot.world = { getBlockType: p => blocks[nameAt(p)].id };
  bot.blockAt = p => {
    blockReads++;
    if (!headLoaded && atLedge(p) && p.y === 72) return null;
    const name = nameAt(p);
    return { name, boundingBox: name === 'stone' ? 'block' : 'empty', skyLight: atLedge(p) && p.y > 70 ? 15 : 0 };
  };
  const exit = () => createObservation(bot, { executor: {} }).surface_access.exit;
  assert.equal(exit(), null);
  assert.ok(blockReads <= 10, `扫描无支撑的空气列读取了 ${blockReads} 个完整方块`);
  hasLedge = true;
  assert.deepEqual(exit(), { x: 4, y: 71, z: 0 });
  headLoaded = false;
  assert.equal(exit(), null);
  headLoaded = true;
  hasLedge = false;
  assert.equal(exit(), null);
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
