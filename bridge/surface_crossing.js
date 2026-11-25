import { dryMiningFooting, followDryGround } from './dry_footing.js';
import { surfaceSkyLight, waterLike } from './water_escape.js';

const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const cardinal = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function openWater(bot, p) {
  const water = bot.blockAt(p, false);
  if (water?.name === 'water') {
    if (Number(water.getProperties?.()?.level ?? water.metadata) !== 0) return false;
  } else if (!['kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'].includes(water?.name) || water.boundingBox !== 'empty') return false;
  for (const dy of [1, 2]) {
    const air = bot.blockAt(p.offset(0, dy, 0), false);
    if (!air || air.boundingBox !== 'empty' || waterLike(air)) return false;
  }
  return surfaceSkyLight(bot, p.offset(0, 1, 0)) >= 12;
}

// 从脚下连通的干地寻找岸边。整段水面和对岸均可观察时，才把游泳纳入路线。
export async function findSurfaceCrossing(ctx, ground, toward, minimum, avoid) {
  const bot = ctx.bot, start = ground.here;
  if (!bot.time?.isDay || !['overworld', 'minecraft:overworld'].includes(bot.game?.dimension)
      || bot.health < 16 || bot.food < 10 || !dryMiningFooting(bot, start)) return null;
  const shores = [start, ...ground.points].sort((a, b) => distance(a, toward) - distance(b, toward));
  const lines = new Set();
  const cells = new Map();
  const isOpen = p => {
    const key = p.toString();
    if (!cells.has(key)) cells.set(key, openWater(bot, p));
    return cells.get(key);
  };
  let best = null, bestDistance = distance(start, toward) - minimum;
  for (let i = 0; i < shores.length && lines.size < 80; i++) {
    if (i % 16 === 0) {
      await new Promise(resolve => setImmediate(resolve));
      if (ctx.interrupted) return null;
    }
    const shore = shores[i];
    for (const [dx, dz] of cardinal) {
      const water = [-1, -2].map(dy => shore.offset(dx, dy, dz)).find(isOpen);
      if (!water) continue;
      // 沿水面按半格采样，两岸最多相隔 72 格。
      const heading = Math.atan2(toward.z - water.z, toward.x - water.x);
      for (const offset of [0, 0.3, -0.3, 0.6, -0.6]) {
        const ux = Math.cos(heading + offset), uz = Math.sin(heading + offset);
        if (dx * ux + dz * uz < 0.5) continue;
        const key = water.toString() + '/' + offset;
        if (lines.has(key) || lines.size >= 80) continue;
        lines.add(key);
        let last = water;
        for (let step = 0.5; step <= 72; step += 0.5) {
          const p = water.offset(Math.floor(0.5 + ux * step), 0, Math.floor(0.5 + uz * step));
          if (p.equals(last)) continue;
          if (isOpen(p)) { last = p; continue; }
          const groundAtWaterline = bot.blockAt(p, false);
          if (groundAtWaterline?.boundingBox !== 'block' || waterLike(groundAtWaterline)) break;
          const bank = [1, 2].map(dy => p.offset(0, dy, 0)).find(q => dryMiningFooting(bot, q));
          if (bank && step >= 3 && distance(start, bank) >= minimum + 1 && distance(bank, toward) < bestDistance
              && avoid.every(q => distance(q, bank) >= 9)) {
            bestDistance = distance(bank, toward);
            best = {shore, water, bank};
          }
          break;
        }
      }
    }
  }
  return best;
}

export async function crossSurfaceWater(ctx, ground, route, check) {
  const bot = ctx.bot, {shore, water, bank} = route;
  if (await followDryGround(ctx, ground.parents, shore, check) !== 'reached') return false;
  const target = bank.offset(0.5, 0, 0.5), entry = water.offset(0.5, 0, 0.5);
  let entered = false, bestDistance = Infinity, lastProgress = Date.now();
  try {
    for (let tick = 0; tick < 520; tick++) {
      check();
      const pos = bot.entity.position;
      const remaining = distance(pos, target);
      if (remaining <= 1 && bot.entity.onGround && dryMiningFooting(bot, pos)) return true;
      if (bot.health < 14 || (bot.oxygenLevel ?? 20) < 17 || !bot.time?.isDay
          || !dryMiningFooting(bot, bank) || Date.now() - lastProgress > 3500) break;
      if (entered && remaining > 1.5 && !openWater(bot, pos.floored().offset(0, water.y - Math.floor(pos.y), 0))) break;
      if (remaining < bestDistance - 0.4) { bestDistance = remaining; lastProgress = Date.now(); }
      if (distance(pos, entry) < 0.7) entered = true;
      const next = entered ? target : entry;
      await bot.look(Math.atan2(pos.x - next.x, pos.z - next.z), 0, true);
      if (ctx.interrupted) break;
      bot.setControlState('sprint', false);
      bot.setControlState('sneak', false);
      bot.setControlState('jump', true);
      bot.setControlState('forward', true);
      await ctx.sleep(100);
    }
  } finally {
    bot.setControlState('forward', false);
    bot.setControlState('jump', false);
  }
  return false;
}
