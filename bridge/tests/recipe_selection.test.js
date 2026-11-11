import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { pickCraftingRecipe } from '../recipe_selection.js';

const require = createRequire(import.meta.url);

test('pickCraftingRecipe skips unavailable dye recipes and selects the stocked bed recipe', () => {
  const mcData = require('minecraft-data')('1.21.1');
  const { Recipe } = require('prismarine-recipe')(mcData);
  const candidates = Recipe.find(mcData.itemsByName.white_bed.id, null);
  const inventory = new Map([
    [mcData.itemsByName.white_wool.id, 4],
    [mcData.itemsByName.oak_planks.id, 4],
  ]);
  const picked = pickCraftingRecipe(candidates, (recipe) =>
    recipe.delta.every((entry) => entry.count >= 0 || (inventory.get(entry.id) || 0) >= -entry.count),
  );

  assert.ok(picked);
  assert.equal(picked.requiresTable, true);
  assert.equal(picked.recipe.inShape[0][0].id, mcData.itemsByName.white_wool.id);
  assert.equal(picked.recipe.inShape[1][0].id, mcData.itemsByName.oak_planks.id);
});

test('pickCraftingRecipe prefers an available inventory recipe over a table recipe', () => {
  const inventoryRecipe = { requiresTable: false };
  const tableRecipe = { requiresTable: true };

  const selected = pickCraftingRecipe([tableRecipe, inventoryRecipe], () => true);

  assert.deepEqual(selected, { recipe: inventoryRecipe, requiresTable: false });
});

test('pickCraftingRecipe returns null when no candidate is craftable', () => {
  const recipes = [{ requiresTable: false }, { requiresTable: true }];

  assert.equal(pickCraftingRecipe(recipes, () => false), null);
});
