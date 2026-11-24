import assert from 'node:assert/strict';
import test from 'node:test';

import conversions from '../node_modules/mineflayer/lib/conversions.js';
import { placeBedAt } from '../bed_placement.js';

// Mineflayer 先用 toNotchianYaw 转为服务端角度；本机 Paper 1.21.1 的 Direction.fromYRot 顺序为南、西、北、东。
const VANILLA_HORIZONTAL_DIRECTIONS = ['south', 'west', 'north', 'east'];
const DIRECTION_OFFSETS = {
  north: { x: 0, z: -1 },
  east: { x: 1, z: 0 },
  south: { x: 0, z: 1 },
  west: { x: -1, z: 0 },
};

function serverFacingFromYaw(yaw) {
  const serverYaw = conversions.toNotchianYaw(yaw);
  const directionIndex = Math.floor(serverYaw / 90 + 0.5) & 3;
  return VANILLA_HORIZONTAL_DIRECTIONS[directionIndex];
}

function headPositionFromYaw(yaw, foot) {
  const offset = DIRECTION_OFFSETS[serverFacingFromYaw(yaw)];
  return { x: foot.x + offset.x, y: foot.y, z: foot.z + offset.z };
}

function makeTwoCellShelter(headOffset = { x: 1, z: 0 }, entityPosition = { x: -2.5, y: 1, z: -2.5 }) {
  const blocks = new Map();
  const put = (x, y, z, name, boundingBox = 'block') => blocks.set(`${x},${y},${z}`, { name, boundingBox });
  const air = (x, y, z) => put(x, y, z, 'air', 'empty');
  // 庇护所内只给床脚与床头两格空间，周围其余格子都是墙。
  put(0, 0, 0, 'stone');
  put(headOffset.x, 0, headOffset.z, 'stone');
  air(0, 1, 0);
  air(headOffset.x, 1, headOffset.z);
  return {
    blocks,
    bot: {
      entity: { yaw: 0, pitch: 0, position: { ...entityPosition }, width: 0.6, height: 1.8 },
      inventory: { items: () => [{ name: 'red_bed', type: 1 }] },
      blockAt: (position) => blocks.get(`${position.x},${position.y},${position.z}`) || null,
      async equip(item, destination) { assert.equal(item.name, 'red_bed'); assert.equal(destination, 'hand'); },
      async look(yaw, pitch, force) { this.entity.yaw = yaw; this.entity.pitch = pitch; assert.equal(force, true); },
      async _placeBlockWithOptions(support, face, options) {
        assert.equal(support.name, 'stone');
        assert.deepEqual(face, { x: 0, y: 1, z: 0 });
        assert.equal(options.forceLook, 'ignore');
        const foot = { x: 0, y: 1, z: 0 };
        const head = headPositionFromYaw(this.entity.yaw, foot);
        const headBlock = blocks.get(`${head.x},${head.y},${head.z}`);
        if (!headBlock
          || (headBlock.name !== 'air' && headBlock.boundingBox !== 'empty')
          || playerOverlapsBlock(this.entity, foot)
          || playerOverlapsBlock(this.entity, head)) return;
        blocks.set('0,1,0', { name: 'red_bed', boundingBox: 'empty' });
        blocks.set(`${head.x},${head.y},${head.z}`, { name: 'red_bed', boundingBox: 'empty' });
      },
    },
  };
}

function playerOverlapsBlock(entity, block) {
  const { x, y, z } = entity.position;
  const halfWidth = entity.width / 2;
  return x + halfWidth > block.x
    && x - halfWidth < block.x + 1
    && y + entity.height > block.y
    && y < block.y + 1
    && z + halfWidth > block.z
    && z - halfWidth < block.z + 1;
}

test('bed placement succeeds in a 2x2 shelter using only foot and head cells', async () => {
  const { bot } = makeTwoCellShelter();
  const placed = await placeBedAt(bot, { x: 0, y: 1, z: 0 }, 'red_bed', {
    wait: async () => {},
  });
  assert.deepEqual(placed, {
    foot: { x: 0, y: 1, z: 0 },
    head: { x: 1, y: 1, z: 0 },
    item: 'red_bed',
  });
});

test('bed placement moves the player out of the foot cell before the server placement packet', async () => {
  const { bot, blocks } = makeTwoCellShelter({ x: 1, z: 0 }, { x: 0.5, y: 1, z: 0.5 });
  blocks.set('0,0,1', { name: 'stone', boundingBox: 'block' });
  blocks.set('0,1,1', { name: 'air', boundingBox: 'empty' });
  blocks.set('0,2,1', { name: 'air', boundingBox: 'empty' });
  const moves = [];
  let packetPosition = null;
  const place = bot._placeBlockWithOptions;
  bot._placeBlockWithOptions = async function (...args) {
    packetPosition = { ...this.entity.position };
    await place.apply(this, args);
  };

  const placed = await placeBedAt(bot, { x: 0, y: 1, z: 0 }, 'red_bed', {
    wait: async () => {},
    moveTo: async (spot) => {
      moves.push(spot);
      bot.entity.position = { x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5 };
    },
  });

  assert.deepEqual(moves, [{ x: 0, y: 1, z: 1 }]);
  assert.ok(packetPosition);
  assert.equal(playerOverlapsBlock({ ...bot.entity, position: packetPosition }, placed.foot), false);
  assert.equal(playerOverlapsBlock({ ...bot.entity, position: packetPosition }, placed.head), false);
  assert.deepEqual(placed.head, { x: 1, y: 1, z: 0 });
  assert.equal(blocks.get('0,1,0').name, 'red_bed');
  assert.equal(blocks.get('1,1,0').name, 'red_bed');
});

test('bed placement cancellation during the clearing move prevents the placement packet', async () => {
  const { bot, blocks } = makeTwoCellShelter({ x: 1, z: 0 }, { x: 0.5, y: 1, z: 0.5 });
  blocks.set('0,0,1', { name: 'stone', boundingBox: 'block' });
  blocks.set('0,1,1', { name: 'air', boundingBox: 'empty' });
  blocks.set('0,2,1', { name: 'air', boundingBox: 'empty' });
  const token = { cancelled: false };
  let packets = 0;
  bot._placeBlockWithOptions = async () => { packets += 1; };

  await assert.rejects(
    placeBedAt(bot, { x: 0, y: 1, z: 0 }, 'red_bed', {
      wait: async () => {},
      token,
      moveTo: async () => { token.cancelled = true; },
    }),
    /放床动作被取消/,
  );
  assert.equal(packets, 0);
});

test('bed placement maps every narrow horizontal direction through client and vanilla yaw conventions', async () => {
  for (const offset of [
    { x: 0, z: -1 },
    { x: 1, z: 0 },
    { x: 0, z: 1 },
    { x: -1, z: 0 },
  ]) {
    const { bot } = makeTwoCellShelter(offset);
    const placed = await placeBedAt(bot, { x: 0, y: 1, z: 0 }, 'red_bed', {
      wait: async () => {},
    });
    assert.deepEqual(placed.head, { x: offset.x, y: 1, z: offset.z });
  }
});

test('bed placement rejects missing head space before sending a place packet', async () => {
  const { bot, blocks } = makeTwoCellShelter();
  blocks.set('1,1,0', { name: 'wall', boundingBox: 'block' });
  let placed = false;
  bot._placeBlockWithOptions = async () => { placed = true; };
  await assert.rejects(
    placeBedAt(bot, { x: 0, y: 1, z: 0 }, 'red_bed', { wait: async () => {} }),
    /床脚与床头/,
  );
  assert.equal(placed, false);
});

test('bed placement does not report success when the server only places the foot half', async () => {
  const { bot, blocks } = makeTwoCellShelter();
  bot._placeBlockWithOptions = async () => {
    blocks.set('0,1,0', { name: 'red_bed', boundingBox: 'empty' });
  };
  await assert.rejects(
    placeBedAt(bot, { x: 0, y: 1, z: 0 }, 'red_bed', {
      wait: async () => {},
      verifyAttempts: 2,
    }),
    /床未完整放置/,
  );
});

test('bed placement verifies the observed second half when the server reverses orientation', async () => {
  const { bot, blocks } = makeTwoCellShelter();
  blocks.set('-1,0,0', { name: 'stone', boundingBox: 'block' });
  blocks.set('-1,1,0', { name: 'air', boundingBox: 'empty' });
  bot._placeBlockWithOptions = async () => {
    const foot = { x: 0, y: 1, z: 0 };
    const expectedHead = headPositionFromYaw(bot.entity.yaw, foot);
    const reversedHead = { x: 2 * foot.x - expectedHead.x, y: foot.y, z: 2 * foot.z - expectedHead.z };
    blocks.set('0,1,0', { name: 'red_bed', boundingBox: 'empty' });
    blocks.set(`${reversedHead.x},${reversedHead.y},${reversedHead.z}`, { name: 'red_bed', boundingBox: 'empty' });
  };
  const placed = await placeBedAt(bot, { x: 0, y: 1, z: 0 }, 'red_bed', {
    wait: async () => {},
  });
  assert.deepEqual(placed.head, { x: -1, y: 1, z: 0 });
});
