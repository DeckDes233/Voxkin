// 只暴露当前已加载区块内的资源线索，执行技能仍须重读方块和容器。
export function inspectResourceSites(bot, shelter = null) {
  const result = { beds: [], hay: [], chests: [], golems: [], village_evidence: false };
  const origin = bot?.entity?.position;
  if (!origin || !['overworld', 'minecraft:overworld'].includes(bot.game?.dimension)) return result;
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const entities = Object.values(bot.entities || {}).filter(e => e?.position && e.isValid !== false);
  const anchors = entities.filter(e => e.name === 'villager' && distance(e.position, origin) <= 48).map(e => e.position);
  const protectedSite = p => shelter?.position && Math.hypot(p.x - shelter.position.x, p.z - shelter.position.z) <= 8;
  if (typeof bot.findBlocks === 'function') {
    const ids = Object.values(bot.registry?.blocksByName || {})
      .filter(b => b.name === 'bell' || b.name === 'hay_block' || b.name === 'chest' || /_bed$/.test(b.name))
      .map(b => b.id);
    if (ids.length) {
      const positions = bot.findBlocks({ matching: ids, maxDistance: 32, count: 64 });
      const blocks = positions.map(p => bot.blockAt(p)).filter(Boolean);
      anchors.push(...blocks.filter(b => b.name === 'bell').map(b => b.position));
      for (const block of blocks) {
        const p = block.position;
        if (!p) continue;
        const site = { name: block.name, x: p.x, y: p.y, z: p.z };
        const village = anchors.some(anchor => distance(anchor, p) <= 48);
        if (block.name === 'hay_block') result.hay.push(site);
        if (protectedSite(p)) continue;
        if (block.name === 'chest' && village) result.chests.push(site);
        if (/_bed$/.test(block.name) && village) {
          const properties = block.getProperties?.() || {};
          if (properties.occupied !== true && properties.occupied !== 'true' && properties.part !== 'head') result.beds.push(site);
        }
      }
    }
  }
  result.village_evidence = anchors.length > 0;
  result.golems = entities.filter(e => e.name === 'iron_golem' && distance(e.position, origin) <= 32)
    .map(e => ({ id: e.id, x: e.position.x, y: e.position.y, z: e.position.z }));
  return result;
}
