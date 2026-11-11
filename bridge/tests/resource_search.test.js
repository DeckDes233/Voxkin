import assert from 'node:assert/strict';
import test from 'node:test';
import { findBlocksWithExploration, resourceCandidates } from '../resource_search.js';

test('未找到方块时移动并在新位置重新搜索', async () => {
  let moved = 0;
  const position = { x: 18, y: 64, z: 0 };
  const ctx = {
    bot: { entity: {}, findBlocks: () => moved >= 2 ? [position] : [] },
    sleep: async () => {},
    exploreResource: async () => { moved += 1; return 'reached'; },
  };
  assert.deepEqual(await findBlocksWithExploration(ctx, 1, 64, 8), [position]);
  assert.equal(moved, 2);
});

test('探索途中取消后不再搜索或移动', async () => {
  let moved = 0;
  const ctx = {
    bot: { entity: {}, findBlocks: () => [] },
    sleep: async () => {},
    interrupted: false,
    exploreResource: async () => { moved += 1; ctx.interrupted = true; return 'cancelled'; },
  };
  await assert.rejects(findBlocksWithExploration(ctx, 1, 64, 8), /取消/);
  assert.equal(moved, 1);
});

test('探索无结果时有界结束且不伪造成功', async () => {
  let moved = 0;
  const ctx = {
    bot: { entity: {}, findBlocks: () => [] },
    sleep: async () => {},
    exploreResource: async () => { moved += 1; return 'reached'; },
  };
  assert.deepEqual(await findBlocksWithExploration(ctx, 1, 64, 8), []);
  assert.equal(moved, 5);
});

test('候选耗尽后的再次搜索共用五段预算，并且不重复已尝试坐标', async () => {
  let moved = 0;
  const ctx = {
    bot: { entity: {}, findBlocks: () => [{ x: moved, y: 0, z: 0 }] },
    sleep: async () => {},
    exploreResource: async () => { moved += 1; return 'reached'; },
  };
  const positions = [];
  for await (const position of resourceCandidates(ctx, 1, 64, 1)) positions.push(position.x);
  assert.deepEqual(positions, [0, 1, 2, 3, 4, 5]);
  assert.equal(moved, 5);
});

test('一个方向无安全路点时换向，未知移动结果不会被当成继续搜索', async () => {
  const headings = [];
  const ctx = {
    bot: { entity: {}, findBlocks: () => headings.length > 1 ? [{ x: 1, y: 0, z: 0 }] : [] },
    sleep: async () => {},
    exploreResource: async (step, heading) => { headings.push(heading); return step ? 'reached' : 'no_target'; },
  };
  assert.equal((await findBlocksWithExploration(ctx, 1, 64, 1)).length, 1);
  assert.notEqual(headings[0], headings[1]);
  ctx.bot.findBlocks = () => [];
  ctx.exploreResource = async () => 'low_health';
  await assert.rejects(findBlocksWithExploration(ctx, 1, 64, 1), /low_health/);
});
