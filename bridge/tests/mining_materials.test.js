import assert from 'node:assert/strict';
import test from 'node:test';
import minecraftData from 'minecraft-data';
import blockFactory from 'prismarine-block';
import { correctMiningMaterials } from '../mining_materials.js';

test('1.21.1 uses pickaxe speed for obsidian and retains its harvest tier', () => {
  const registry = minecraftData('1.21.1');
  correctMiningMaterials(registry);
  const block = blockFactory('1.21.1').fromStateId(registry.blocksByName.obsidian.defaultState, 0);
  const diamond = registry.itemsByName.diamond_pickaxe.id;
  assert.equal(block.digTime(diamond, false, false, false, [], {}), 9400);
  assert.equal(block.canHarvest(diamond), true);
  assert.ok(!block.canHarvest(registry.itemsByName.iron_pickaxe.id));
  assert.equal(registry.blocksByName.oak_log.material, 'mineable/axe');
});
