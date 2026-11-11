import { waterLike } from '../water_escape.js';

const HAZARDS = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire', 'cactus', 'sweet_berry_bush', 'powder_snow', 'wither_rose']);
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const point = (p) => ({ x: p.x, y: p.y, z: p.z });

export function miningRouteExclusion(bot, block) {
  if (!block?.position) return 100;
  // 液体代价只是偏好；换区路线必须直接排除水、含水方块和未知空间。
  for (const dy of [0, 1]) {
    const cell = bot.blockAt(block.position.offset(0, dy, 0));
    if (!cell || waterLike(cell) || HAZARDS.has(cell.name)) return 100;
  }
  return 0;
}

export function dryMiningFooting(bot, position) {
  const feet = position.floored();
  const ground = bot.blockAt(feet.offset(0, -1, 0));
  if (!ground || ground.boundingBox !== 'block' || waterLike(ground) || HAZARDS.has(ground.name)) return false;
  for (const dy of [0, 1]) {
    const block = bot.blockAt(feet.offset(0, dy, 0));
    if (!block || block.boundingBox !== 'empty' || waterLike(block) || HAZARDS.has(block.name)) return false;
  }
  return true;
}

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
  const origin = bot.entity.position.clone(), attempted = [];
  const relocation = () => ({ origin: point(origin), min_distance: minimum, attempted_positions: attempted });
  const fail = (detail) => { const error = new Error(detail); error.data = { relocation: relocation() }; throw error; };
  const check = () => {
    if (ctx.interrupted || !bot.entity) fail('换矿区已取消或断开连接');
    if (bot.health <= 10) fail('血量不足，先处理生存恢复');
    if (ctx.nearbyHostiles?.(10)?.length) fail('附近有敌对生物，先处理生存恢复');
  };
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
    const candidates = miningSiteCandidates(bot, origin, minimum, avoid);
    // 一次最多试十二条路线，上层保留失败点并负责恢复及总预算。
    for (const target of candidates.slice(0, 12)) {
      check();
      attempted.push(point(target));
      ctx.reportProgress?.('relocating', '离开失败矿点，寻找干燥的新落脚点', 0, { relocation: relocation() });
      const outcome = await ctx.walkOnce(target.x, target.y, target.z, 0, 8000);
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
    description: '局部采矿受阻后，避开已尝试区域，实际走到新的干燥落脚点；不挖路、不搭柱，按真实位置变化验收。',
    parameters: [
      { name: 'min_distance', type: 'number', required: false, default: 16, description: '相对动作起点的最小水平位移，8–48 格。' },
      { name: 'avoid_positions', type: 'array', required: false, default: [], description: '已失败矿点和落点的 x/y/z 坐标列表，候选需远离其八格范围。',
        items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'], additionalProperties: false } },
    ],
    handler: exploreMiningSite,
  },
};
