import assert from 'node:assert/strict';
import test from 'node:test';

import { placementHeightOffsets, placementOffsets } from '../placement.js';

test('placement offsets search nearest candidates first across the requested radius', () => {
  const offsets = placementOffsets(1);

  assert.equal(offsets.length, 8);
  assert.deepEqual(offsets.slice(0, 4), [
    [-1, 0],
    [0, -1],
    [0, 1],
    [1, 0],
  ]);
  const extended = placementOffsets(4);
  assert.equal(extended.length, 80);
  assert.ok(extended.some(([x, z]) => Math.max(Math.abs(x), Math.abs(z)) === 4));
});

test('placement heights cover uneven terrain and try the nearest floor first', () => {
  const offsets = placementHeightOffsets();

  assert.equal(offsets.length, 25);
  assert.equal(offsets[0], -1);
  assert.ok(offsets.includes(-16));
  assert.ok(offsets.includes(8));
});
