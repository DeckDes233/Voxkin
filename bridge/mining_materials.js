export function correctMiningMaterials(registry) {
  if (registry?.version?.minecraftVersion !== '1.21.1') return;
  // 这一版数据把最低工具等级误作采掘类别。100 个受影响方块均在原版 mineable/pickaxe 标签内。
  for (const block of registry.blocksArray) {
    if (!block.material.startsWith('incorrect_for_') || !block.harvestTools) continue;
    const tools = Object.keys(block.harvestTools);
    if (tools.length && tools.every(id => registry.items[id]?.name.endsWith('_pickaxe'))) block.material = 'mineable/pickaxe';
  }
}
