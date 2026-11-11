import assert from 'node:assert/strict';
import test from 'node:test';
import { FUEL_BURN, selectFuel } from '../fuel.js';

test('fuel selection skips insufficient coal and uses enough spruce across rounds', () => {
  const items = [{ name: 'coal', count: 1 }, { name: 'spruce_planks', count: 7 }];
  assert.equal(selectFuel(items, [8, 1]).name, 'spruce_planks');
  assert.equal(selectFuel(items, [8, 1], 'coal'), null);
});

test('all overworld planks burn but Nether wood and sticks are not batch fuels', () => {
  for (const name of ['spruce', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo']) {
    assert.equal(selectFuel([{ name: `${name}_planks`, count: 2 }], [3]).name, `${name}_planks`);
  }
  for (const name of ['crimson_planks', 'warped_planks', 'stick']) {
    assert.equal(FUEL_BURN[name], undefined);
    assert.equal(selectFuel([{ name, count: 64 }], [1]), null);
  }
});
