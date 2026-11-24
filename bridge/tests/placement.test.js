import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findSupportedPlacementTargets,
  inspectSupportedPlacementTargets,
  placementHeightOffsets,
  placementOffsets,
} from '../placement.js';

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

test('supported placement search finds a valid nearby surface beyond the immediate ring', () => {
  const blocks = new Map();
  const key = ({ x, y, z }) => `${x},${y},${z}`;
  blocks.set('3,63,0', { name: 'stone', boundingBox: 'block' });
  blocks.set('3,64,0', { name: 'air', boundingBox: 'empty' });
  blocks.set('3,65,0', { name: 'air', boundingBox: 'empty' });
  const getBlock = (position) => blocks.get(key(position)) || null;
  const base = { x: 0.5, y: 64, z: 0.5 };

  assert.deepEqual(findSupportedPlacementTargets({ base, searchRadius: 1, getBlock }), []);
  const expanded = findSupportedPlacementTargets({ base, searchRadius: 4, getBlock });
  assert.ok(expanded.some(({ target }) => key(target) === '3,64,0'));
});

test('placement diagnostics distinguish unloaded blocks from known empty terrain', () => {
  const base = { x: 0.5, y: 64, z: 0.5 };
  const unloaded = inspectSupportedPlacementTargets({
    base,
    searchRadius: 1,
    getBlock: () => null,
  });
  assert.equal(unloaded.targets.length, 0);
  assert.ok(unloaded.diagnostics.unknown_count > 0);
  assert.deepEqual(unloaded.diagnostics.bot_floor, { x: 0, y: 64, z: 0 });
  assert.ok(unloaded.diagnostics.columns[0].ground.query);
  assert.equal(unloaded.diagnostics.columns[0].ground.name, null);

  const knownAir = inspectSupportedPlacementTargets({
    base,
    searchRadius: 1,
    getBlock: () => ({ name: 'air', boundingBox: 'empty' }),
  });
  assert.equal(knownAir.targets.length, 0);
  assert.equal(knownAir.diagnostics.unknown_count, 0);
});

test('placement scan sees support on a loaded 7x7 stone platform at the bot position', () => {
  const base = { x: 18.5, y: 76, z: 75.5 };
  const getBlock = ({ x, y, z }) => {
    if (y === 75 && x >= 15 && x <= 21 && z >= 72 && z <= 78) {
      return { name: 'stone', boundingBox: 'block' };
    }
    if (y === 76 || y === 77) return { name: 'air', boundingBox: 'empty' };
    return { name: 'stone', boundingBox: 'block' };
  };

  const scan = inspectSupportedPlacementTargets({ base, searchRadius: 4, getBlock });
  assert.ok(scan.targets.length > 0);
  assert.equal(scan.diagnostics.unknown_count, 0);
  assert.equal(scan.diagnostics.columns[0].ground.name, 'stone');
  assert.equal(scan.diagnostics.columns[0].above.name, 'air');
  assert.equal(scan.diagnostics.columns[0].body.name, 'air');
});
