import { dryMiningFooting, followDryGround, miningRouteExclusion, reachableDryGround } from '../dry_footing.js';
import { waterLike } from '../water_escape.js';
import { crossSurfaceWater, findSurfaceCrossing } from '../surface_crossing.js';
import { leaveCoveredMiningSite } from './gather.js';
export { dryMiningFooting, miningRouteExclusion } from '../dry_footing.js';
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const point = (p) => ({ x: p.x, y: p.y, z: p.z });

// 只从已加载地形选落脚点，必须实际到达才算换矿区。
export function miningSiteCandidates(bot, origin, minimum, avoid) {
  const candidates = [], seen = new Set();
  for (const radius of [...new Set([minimum + 2, Math.min(48, minimum + 10), 48])]) {
    for (let direction = 0; direction < 16; direction += 1) {
      const angle = direction * Math.PI / 8;
      const x = Math.floor(origin.x + Math.cos(angle) * radius) + 0.5;
      const z = Math.floor(origin.z + Math.sin(angle) * radius) + 0.5;
      const key = `${x},${z}`;
      if (seen.has(key) || avoid.some(p => horizontal(p, { x, z }) < 8)) continue;
      seen.add(key);
      // 优先同层和上坡，避免换位时进一步陷入深处。
      for (const dy of [0, ...Array.from({ length: 24 }, (_, i) => i + 1), ...Array.from({ length: 8 }, (_, i) => -i - 1)]) {
        const target = origin.offset(x - origin.x, Math.floor(origin.y) + dy - origin.y, z - origin.z);
        if (dryMiningFooting(bot, target)) { candidates.push(target); break; }
      }
    }
  }
  return candidates;
}

async function exploreMiningSite(args, ctx) {
  const bot = ctx.bot;
  if (!bot?.entity || !bot.pathfinder || typeof ctx.walkOnce !== 'function') throw new Error('换矿区需要已连接的角色与寻路器');
  const minimum = Number(args.min_distance ?? 16);
  if (!Number.isFinite(minimum) || minimum < 8 || minimum > 48) throw new Error('min_distance 必须在 8–48 之间');
  const avoid = Array.isArray(args.avoid_positions) ? args.avoid_positions : [];
  if (avoid.some(p => !p || !['x', 'y', 'z'].every(axis => Number.isFinite(p[axis])))) throw new Error('avoid_positions 必须是有效坐标列表');
  const toward = args.toward;
  if (toward != null && !['x', 'y', 'z'].every(axis => Number.isFinite(toward[axis]))) throw new Error('toward 必须是有效坐标');
  const origin = bot.entity.position.clone(), attempted = [];
  let extent;
  const relocation = () => ({origin: point(origin), min_distance: minimum, attempted_positions: attempted,
    ...(Number.isFinite(extent) ? {dry_ground_extent: extent} : {})});
  const fail = (detail) => { const error = new Error(detail); error.data = { relocation: relocation() }; throw error; };
  const check = () => {
    if (ctx.interrupted || !bot.entity) fail('换矿区已取消或断开连接');
    if (bot.health <= 10) fail('血量不足，先处理生存恢复');
    if (ctx.nearbyHostiles?.(10)?.length) fail('附近有敌对生物，先处理生存恢复');
  };
  // 近处敌人曾连续耗尽换区次数。先沿已验证的安全退路脱离，再检查能否开始探路。
  const threat = ctx.findHostile?.(10);
  if (threat && bot.health > 10 && !ctx.interrupted &&
      !waterLike(bot.blockAt(bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)))) {
    if (args.covered_escape === true) {
      try {
        await leaveCoveredMiningSite(ctx, threat, origin, minimum, attempted);
      } catch (error) { fail(error.message); }
      check();
      const actual = bot.entity.position;
      if (horizontal(actual, origin) >= minimum && dryMiningFooting(bot, actual) && avoid.every(p => horizontal(p, actual) >= 8)) {
        return {status: 'succeeded', detail: '已沿干燥通道撤离敌怪', data: {relocation: {...relocation(), destination: point(actual)}}};
      }
    } else {
      await ctx.retreatFrom(threat);
    }
  }
  check();
  if (waterLike(bot.blockAt(bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)))) {
    if (typeof ctx.swimToShore !== 'function' || !await ctx.swimToShore('换矿区前恢复呼吸', 25000, 8)) fail('换矿区前尚未恢复呼吸');
  }
  check();
  const movements = bot.pathfinder.movements;
  const previous = movements && {
    canDig: movements.canDig, allow1by1towers: movements.allow1by1towers,
    allowParkour: movements.allowParkour, maxDropDown: movements.maxDropDown, liquidCost: movements.liquidCost,
    exclusionAreasStep: movements.exclusionAreasStep,
    infiniteLiquidDropdownDistance: movements.infiniteLiquidDropdownDistance,
  };
  try {
    if (movements) Object.assign(movements, { canDig: false, allow1by1towers: false, allowParkour: false, maxDropDown: 2, liquidCost: 100 });
    if (movements) {
      movements.exclusionAreasStep = [...(movements.exclusionAreasStep || []), block => miningRouteExclusion(bot, block)];
      movements.infiniteLiquidDropdownDistance = false;
    }
    let candidates, parents;
    if (args.connected_route === true) {
      const ground = await reachableDryGround(ctx, 4000, Math.min(72, minimum + 32),
        String(bot.game?.dimension).endsWith('the_nether'));
      parents = ground.parents;
      extent = ground.points.reduce((d, p) => Math.max(d, horizontal(origin, p.offset(0.5, 0, 0.5))), 0);
      candidates = ground.points.filter(p => horizontal(origin, p.offset(0.5, 0, 0.5)) >= minimum + 1
        && avoid.every(previous => horizontal(previous, p.offset(0.5, 0, 0.5)) >= 9));
      if (toward) {
        candidates.sort((a, b) => horizontal(a, toward) - horizontal(b, toward));
        if (!candidates.length || horizontal(origin, toward) - horizontal(candidates[0], toward) < minimum) {
          const route = await findSurfaceCrossing(ctx, ground, toward, minimum, avoid);
          if (route) {
            attempted.push(point(route.bank));
            ctx.reportProgress?.('relocating', '已确认开阔水面和对岸落脚点，前往资源所在的河岸', 0,
              {relocation: relocation(), crossing: {departure: point(route.shore), bank: point(route.bank)}});
            const landed = await crossSurfaceWater(ctx, ground, route, check);
            const actual = bot.entity.position;
            if (landed && horizontal(origin, actual) >= minimum && avoid.every(p => horizontal(p, actual) >= 8)) {
              return {status: 'succeeded', detail: '已从水面渡到资源方向的干岸',
                data: {relocation: {...relocation(), destination: point(actual)}, crossing: {departure: point(route.shore), bank: point(route.bank)}}};
            }
            if (!ctx.interrupted && !dryMiningFooting(bot, actual)) await ctx.swimToShore?.('渡水中止，恢复呼吸并靠岸', 25000, 8);
            fail('未确认抵达对岸，从实际位置重新规划');
          }
        }
      }
    } else {
      candidates = miningSiteCandidates(bot, origin, minimum, avoid);
    }
    // 一次最多试十二条路线，上层保留失败点并负责恢复及总预算。
    for (const target of candidates.slice(0, 12)) {
      check();
      attempted.push(point(target));
      ctx.reportProgress?.('relocating', '离开失败矿点，寻找干燥的新落脚点', 0, { relocation: relocation() });
      let outcome;
      if (parents) {
        const start = bot.entity.position.floored();
        outcome = await followDryGround(ctx, parents, target, check);
        if (outcome !== 'cancelled' && outcome !== 'reached' && !bot.entity.position.floored().equals(start)) {
          const actual = bot.entity.position;
          if (horizontal(actual, origin) >= minimum && dryMiningFooting(bot, actual) && avoid.every(p => horizontal(p, actual) >= 8)) {
            check();
            return {status: 'succeeded', detail: '已实走到原矿区以外的干地', data: {relocation: {...relocation(), destination: point(actual)}}};
          }
          fail('沿干地移动后路线中断，从实际落脚点重新观察');
        }
      } else {
        outcome = await ctx.walkOnce(target.x, target.y, target.z, 0, 8000);
      }
      check();
      if (outcome === 'cancelled') fail('换矿区已取消');
      const actual = bot.entity.position;
      if (outcome === 'reached' && horizontal(actual, origin) >= minimum && dryMiningFooting(bot, actual)
        && !avoid.some(p => horizontal(p, actual) < 8)) {
        return { status: 'succeeded', detail: `已到新的干燥矿区，水平移动 ${horizontal(actual, origin).toFixed(1)} 格`,
          data: { relocation: { ...relocation(), destination: point(actual) } } };
      }
    }
    fail('当前候选没有完成安全换位，保留采矿目标和已尝试位置');
  } catch (error) {
    error.data = { ...error.data, relocation: relocation() };
    throw error;
  } finally {
    if (movements) Object.assign(movements, previous);
  }
}

export const skills = {
  explore_mining_site: {
    description: '避开失败矿点，走到新的干燥落脚点。步行撤离敌怪受阻时可开挖有支撑的侧向通道。',
    parameters: [
      {name: 'covered_escape', type: 'boolean', required: false, default: false, description: '步行撤退失败后允许背离敌怪开挖干燥通道。'},
      {name: 'connected_route', type: 'boolean', required: false, default: false, description: '从脚下搜索连通干地，沿观察到的路点分段行走。'},
      {name: 'toward', type: 'object', required: false, default: null, description: '已观测资源的 x/y/z 坐标，连通干地优先选靠近目标的落脚点。'},
      { name: 'min_distance', type: 'number', required: false, default: 16, description: '相对动作起点的最小水平位移，8–48 格。' },
      { name: 'avoid_positions', type: 'array', required: false, default: [], description: '已失败矿点和落点的 x/y/z 坐标列表，候选需远离其八格范围。',
        items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'], additionalProperties: false } },
    ],
    handler: exploreMiningSite,
  },
};
