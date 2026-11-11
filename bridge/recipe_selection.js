export function pickCraftingRecipe(recipes, canCraft) {
  const candidates = Array.isArray(recipes) ? recipes : [];
  for (const requiresTable of [false, true]) {
    for (const recipe of candidates) {
      if (Boolean(recipe.requiresTable) !== requiresTable || !canCraft(recipe)) continue;
      return { recipe, requiresTable };
    }
  }
  return null;
}
