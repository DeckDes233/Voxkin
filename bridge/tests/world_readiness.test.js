import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectPositionTerrain } from '../world_readiness.js';

test('position terrain is not ready while any required block query is unknown', () => {
  const blocks = new Map([
    ['2,63,4', { name: 'stone', boundingBox: 'block' }],
    ['2,64,4', { name: 'air', boundingBox: 'empty' }],
  ]);
  const result = inspectPositionTerrain(
    { x: 2.5, y: 64, z: 4.5 },
    ({ x, y, z }) => blocks.get(`${x},${y},${z}`) || null,
  );

  assert.equal(result.readable, false);
  assert.deepEqual(result.floor, { x: 2, y: 64, z: 4 });
  assert.equal(result.blocks.ground.name, 'stone');
  assert.equal(result.blocks.feet.name, 'air');
  assert.equal(result.blocks.head.loaded, false);
});

test('known air is readable and does not get confused with an unloaded block', () => {
  const result = inspectPositionTerrain(
    { x: 2.5, y: 64, z: 4.5 },
    ({ y }) => y === 63
      ? { name: 'stone', boundingBox: 'block' }
      : { name: 'air', boundingBox: 'empty' },
  );

  assert.equal(result.readable, true);
  assert.equal(result.blocks.head.name, 'air');
  assert.equal(result.blocks.head.loaded, true);
});
