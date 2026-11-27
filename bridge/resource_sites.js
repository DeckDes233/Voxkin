import {dryMiningFooting} from './dry_footing.js';
import {surfaceSkyLight} from './water_escape.js';
import {findObservedBlocks} from './loaded_block_scan.js';

const observedSites = new WeakMap();

function candidatePositions(bot, origin, sessionId) {
  const now = performance.now();
  const previous = sessionId && observedSites.get(bot);
  if (previous && previous.sessionId === sessionId && previous.dimension === bot.game.dimension && previous.world === bot.world
      && now - previous.at < 2000 && Math.hypot(origin.x - previous.x, origin.y - previous.y, origin.z - previous.z) < 4) {
    return previous.positions;
  }
  const blocks = Object.values(bot.registry?.blocksByName || {})
    .filter(b => b.name === 'bell' || b.name === 'hay_block' || b.name === 'chest' || /_bed$/.test(b.name));
  const positions = findObservedBlocks(bot, blocks, 32, 64);
  if (sessionId) observedSites.set(bot, { sessionId, dimension: bot.game.dimension, world: bot.world, at: now,
    x: origin.x, y: origin.y, z: origin.z, positions });
  return positions;
}

// 状态广播共用候选坐标，每次重读方块、占用状态与实体。技能调用仍直接搜索。
export function inspectResourceSites(bot, shelter = null, sessionId = null) {
  const result = { beds: [], hay: [], chests: [], golems: [], village_evidence: false };
  const origin = bot?.entity?.position;
  if (!origin || !['overworld', 'minecraft:overworld'].includes(bot.game?.dimension)) {
    if (bot) observedSites.delete(bot);
    return result;
  }
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const items = bot.inventory?.items?.() ?? [];
  const carryingBucket = items.some(item => item.name === 'bucket');
  if (bot.time?.isDay && items.some(item => item.name === 'oak_sapling') && dryMiningFooting(bot, origin)) {
    const feet = origin.floored();
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
      const at = feet.offset(dx, 0, dz);
      const soil = bot.blockAt(at.offset(0, -1, 0));
      if (!['dirt', 'grass_block'].includes(soil?.name) || (bot.canSeeBlock && !bot.canSeeBlock(soil))
          || bot.blockAt(at)?.name !== 'air' || !(surfaceSkyLight(bot, at.offset(0, 1, 0)) >= 12)
          || (shelter?.position && distance(at, shelter.position) < 8)) continue;
      if ([1, 2, 3, 4, 5].every(h => bot.blockAt(at.offset(0, h, 0))?.name === 'air')) {
        result.oak_planting_site = {x: at.x, y: at.y, z: at.z};
        break;
      }
    }
  }
  if (carryingBucket && origin.floored && bot.world?.raycast && dryMiningFooting(bot, origin)) {
    const feet = origin.floored(), eye = origin.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      for (const dy of [-1, 0]) {
        const p = feet.offset(dx, dy, dz), water = bot.blockAt(p);
        if (water?.name !== 'water' || Number(water.getProperties?.().level ?? water.metadata) !== 0) continue;
        const ray = p.offset(0.5, 0.85, 0.5).minus(eye), length = ray.norm();
        if (!length || bot.world.raycast(eye, ray.scaled(1 / length), length)) continue;
        result.water_source = {x: p.x, y: p.y, z: p.z};
        break;
      }
      if (result.water_source) break;
    }
  }
  const entities = Object.values(bot.entities || {}).filter(e => e?.position && e.isValid !== false);
  const anchors = entities.filter(e => e.name === 'villager' && distance(e.position, origin) <= 48).map(e => e.position);
  const protectedSite = p => shelter?.position && Math.hypot(p.x - shelter.position.x, p.z - shelter.position.z) <= 8;
  if (typeof bot.findBlocks === 'function') {
    const positions = candidatePositions(bot, origin, sessionId);
    const blocks = positions.filter(p => distance(p, origin) <= 32).map(p => bot.blockAt(p)).filter(Boolean);
    anchors.push(...blocks.filter(b => b.name === 'bell').map(b => b.position));
    for (const block of blocks) {
      const p = block.position;
      if (!p) continue;
      const site = { name: block.name, x: p.x, y: p.y, z: p.z };
      const village = anchors.some(anchor => distance(anchor, p) <= 48);
      if (block.name === 'hay_block') result.hay.push(site);
      if (/_bed$/.test(block.name)) {
        const properties = block.getProperties?.() || {};
        if (properties.occupied !== true && properties.occupied !== 'true' && properties.part !== 'head') {
          result.sleep_bed ??= site;
          if (village && !protectedSite(p)) result.beds.push(site);
        }
      }
      if (protectedSite(p)) continue;
      if (block.name === 'chest' && village) result.chests.push(site);
    }
  }
  result.village_evidence = anchors.length > 0;
  result.golems = entities.filter(e => e.name === 'iron_golem' && distance(e.position, origin) <= 32)
    .map(e => ({ id: e.id, x: e.position.x, y: e.position.y, z: e.position.z }));
  return result;
}
