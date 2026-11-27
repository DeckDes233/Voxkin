// 战斗技能模块：狩猎被动生物、与烈焰人交战、猎取末影人、破坏末地水晶、举盾格挡。
import { assessCombatEncounter, combatEquipment } from '../combat_encounter.js';
import { dryMiningFooting, withDryGroundMovement } from '../dry_footing.js';
//
// 约束（见 docs/plans/SKILL_MODULE_CONTRACT.md）：
// - 只用 ctx 提供的能力，不 import 任何运行时依赖；bot 从 ctx.bot 取。
// - 战斗结果只根据真实读取的血量、实体状态与背包数量来写，不凭空说「已击杀」。
// - 纯逻辑（选目标、危险度、天色）单独导出，方便脱离游戏单测。
//
// 待接入（ctx 目前没有，集成阶段补）：
// - waitForCombat / waitForQuietAround / waitForHealth 不在 ctx 表里，本模块自己实现了 waitHealth。
// - 没有「格挡状态」的服务端回读，只能用副手槽位加 bot.usingHeldItem 判断盾有没有举起来。
// - 没有「末影人瞬移落点」的额外信息，只能靠重新扫描 bot.entities 追踪。
const HUNT_TIMEOUT_MS = 150000;
const HUNT_SEARCH_MAX_STEPS = 8;
const HUNT_SEARCH_STEP_TIMEOUT_MS = 12000;
const BLAZE_TIMEOUT_MS = 180000;
const ENDERMAN_TIMEOUT_MS = 180000;
const CRYSTAL_TIMEOUT_MS = 180000;
const ENDERMAN_SEARCH_MIN_HEALTH = 8;
// 搜索不到目标时最多空等的时长，超过就按失败收尾。
const SEARCH_WAIT_MS = 20000;
const SHEEP_SEARCH_MAX_STEPS = 48;
const SHEEP_SEARCH_STEP_TIMEOUT_MS = 18000;
const SHEEP_HOSTILE_RECOVERY_MAX_ATTEMPTS = 2;
const SHEEP_HOSTILE_RECHECK_ATTEMPTS = 4;
// 近战可命中的距离上限（格）。
const MELEE_RANGE = 3.0;
const MELEE_REACH = 3.6;
// 烈焰人：弓在 7 格以外打，6 格以内太近要后撤。
const BLAZE_RANGED_MIN = 7;
const BLAZE_RANGED_MAX = 14;
// 火球的有效躲避半径。
const PROJECTILE_ALERT_RANGE = 16;
// 爆炸安全距离：末地水晶炸开的伤害半径差不多这么大。
const BLAST_SAFE_DISTANCE = 6;
// 可狩猎的被动生物与对应掉落物（生肉）。
export const HUNTABLE = ['cow', 'pig', 'sheep', 'chicken', 'rabbit'];
export const MEAT_BY_MOB = {
  cow: 'beef',
  pig: 'porkchop',
  sheep: 'mutton',
  chicken: 'chicken',
  rabbit: 'rabbit',
};
// 生肉对应的熟肉，用于在结果里提示还差什么。
export const COOKED_BY_MEAT = {
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  mutton: 'cooked_mutton',
  chicken: 'cooked_chicken',
  rabbit: 'cooked_rabbit',
};
// 会朝 bot 飞过来的投射物。
export const BLAZE_PROJECTILES = [
  'fireball',
  'small_fireball',
  'large_fireball',
  'fire_charge',
  'dragon_fireball',
];
// ctx.blockLabel 不认识这些生物，这里自己给中文名。
const MOB_LABELS = {
  cow: '牛',
  pig: '猪',
  sheep: '羊',
  chicken: '鸡',
  rabbit: '兔子',
  blaze: '烈焰人',
  enderman: '末影人',
  spider: '蜘蛛',
};
const COMBAT_MATERIAL_SOURCES = {
  feather: 'chicken',
  string: 'spider',
};
const SHEEP_COLORS = [
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black',
];
// 远程怪：它们不用靠近就能打到 bot，威胁权重更高。
const RANGED_THREATS = new Set([
  'blaze',
  'ghast',
  'wither',
  'pillager',
  'skeleton',
  'stray',
  'crossbow_illager',
]);
const RANGED_THREAT_BONUS = 5;
// 正在靠近的目标按「快到了」折算成更近的距离。
const CLOSING_WEIGHT = 4;
// 一次战斗最多挥多少次，防止打不死时一直耗在同一个目标上。
const MAX_HUNT_ATTACKS = 8;
const MAX_BLAZE_ATTACKS = 40;
const MAX_ENDERMAN_ATTACKS = 40;
// 够不着目标时最多空试多少次，超过就换目标或收手。
const MAX_STUCK_STEPS = 20;
// 同一个目标最多交战几轮，超过就收手换目标。
const MAX_ENGAGEMENTS = 4;

function clamp(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function throwIfInterrupted(ctx, action) {
  if (ctx.interrupted) throw new Error(`${action}被新的指令打断`);
}

// 三维距离，纯函数，方便单测。
function distance3(from, to) {
  if (!from || !to) return Infinity;
  const dx = Number(to.x) - Number(from.x);
  const dy = Number(to.y) - Number(from.y);
  const dz = Number(to.z) - Number(from.z);
  if (![dx, dy, dz].every(Number.isFinite)) return Infinity;
  return Math.hypot(dx, dy, dz);
}

// 实体高度兜底：服务端没给 height 时不能拿它算瞄准点，否则会出现 NaN 坐标。
export function entityHeight(entity) {
  const height = Number(entity && entity.height);
  return Number.isFinite(height) && height > 0 ? height : 1.8;
}

// 候选目标每 tick 朝 bot 靠近的水平速度；没有速度就按 0 算。
function closingSpeed(candidate, botPos) {
  const velocity = candidate && candidate.velocity;
  if (!velocity) return 0;
  const vx = Number(velocity.x) || 0;
  const vz = Number(velocity.z) || 0;
  const length = Math.hypot(vx, vz);
  if (length < 0.0001) return 0;
  const dx = Number(botPos.x) - Number(candidate.position.x);
  const dz = Number(botPos.z) - Number(candidate.position.z);
  const norm = Math.hypot(dx, dz) || 1;
  return (vx * dx + vz * dz) / norm;
}

// 从候选目标里挑最危险的一个：距离近的、正在靠近的、远程怪优先。
// candidates: [{ name, position, velocity }]，botPos: { x, y, z }。
export function pickThreat(candidates, botPos) {
  if (!Array.isArray(candidates) || candidates.length === 0 || !botPos) return null;
  let best = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    if (!candidate || !candidate.position) continue;
    const distance = distance3(botPos, candidate.position);
    if (!Number.isFinite(distance)) continue;
    const bonus = RANGED_THREATS.has(candidate.name) ? RANGED_THREAT_BONUS : 0;
    const score = distance - closingSpeed(candidate, botPos) * CLOSING_WEIGHT - bonus;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

// 爆炸（末地水晶、恶魂火球）对 bot 的危险度。
export function blastDanger(targetPos, botPos) {
  const distance = distance3(botPos, targetPos);
  if (!Number.isFinite(distance)) {
    return { distance: Infinity, level: 'none', safe: true };
  }
  let level = 'danger';
  if (distance >= BLAST_SAFE_DISTANCE * 2) level = 'far';
  else if (distance >= BLAST_SAFE_DISTANCE) level = 'near';
  return { distance, level, safe: distance >= BLAST_SAFE_DISTANCE };
}

// 距离天黑还剩多少 tick；ctx 没给时间信息时返回 null。
export function daylightLeft(time) {
  const timeOfDay = Number(time && time.timeOfDay);
  if (!Number.isFinite(timeOfDay)) return null;
  if (timeOfDay < 12000) return Math.round(12000 - timeOfDay);
  if (timeOfDay > 23000) return Math.round(24000 - timeOfDay);
  return 0;
}

// 生物能不能打、掉什么肉。
export function meatFor(mobName) {
  return MEAT_BY_MOB[String(mobName || '').toLowerCase()] || null;
}

// 在候选被动生物里挑最近的、值得追的一个。
export function pickHuntTarget(candidates, botPos) {
  if (!Array.isArray(candidates) || candidates.length === 0 || !botPos) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    if (!candidate || !candidate.position) continue;
    const distance = distance3(botPos, candidate.position);
    if (!Number.isFinite(distance) || distance > bestDistance) continue;
    bestDistance = distance;
    best = candidate;
  }
  return best;
}

// 扫描 bot.entities，按名字与半径取最近的实体。
function findEntity(ctx, name, radius) {
  const bot = ctx.bot;
  const origin = bot.entity.position;
  let best = null;
  let bestDistance = Infinity;
  for (const entity of Object.values(bot.entities || {})) {
    if (!entity || !entity.position) continue;
    if (entity.isValid === false) continue;
    if (entity.name !== name) continue;
    const distance = origin.distanceTo(entity.position);
    if (distance > radius) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = entity;
    }
  }
  return best;
}

// 扫描全部可狩猎生物，返回最近的。
function findHuntable(ctx, speciesList, radius, dryOnly = false, unreachable) {
  const bot = ctx.bot;
  const origin = bot.entity.position;
  const candidates = [];
  for (const entity of Object.values(bot.entities || {})) {
    if (!entity || !entity.position || entity.isValid === false) continue;
    if (!speciesList.includes(entity.name) || unreachable?.has(entity)) continue;
    if (entity.type === 'player') continue;
    const distance = origin.distanceTo(entity.position);
    if (distance > radius) continue;
    if (dryOnly && !dryMiningFooting(bot, entity.position)) continue;
    candidates.push({ name: entity.name, entity, position: entity.position, distance });
  }
  const picked = pickHuntTarget(candidates, origin);
  return picked ? picked.entity : null;
}

export function nearbyFoodAnimal(bot) {
  const origin = bot?.entity?.position;
  if (!origin) return false;
  const needsRecovery = bot.health <= 10 && bot.food < 18;
  const canForage = bot.health > 10 && bot.food > 8 && bot.time?.isDay
    && ['overworld', 'minecraft:overworld'].includes(bot.game?.dimension);
  if (!needsRecovery && !canForage) return false;
  // 快照只需要猎物是否存在，发现第一只站在干地上的动物就返回。
  return Object.values(bot.entities || {}).some(entity =>
    entity?.position && entity.isValid !== false && entity.type !== 'player' && HUNTABLE.includes(entity.name)
    && origin.distanceTo(entity.position) <= 24 && dryMiningFooting(bot, entity.position));
}

function sheepWoolState(ctx, sheep) {
  const keys = ctx.registry?.entitiesByName?.sheep?.metadataKeys;
  if (!Array.isArray(keys)) return null;
  const woolIndex = keys.indexOf('wool');
  const babyIndex = keys.indexOf('baby');
  const metadata = sheep?.metadata;
  if (woolIndex < 0 || !metadata || typeof metadata !== 'object') return null;
  const wool = Number(metadata[woolIndex] ?? 0);
  if (!Number.isInteger(wool)) return null;
  return {
    color: SHEEP_COLORS[wool & 0x0f],
    sheared: (wool & 0x10) !== 0,
    baby: babyIndex >= 0 && metadata[babyIndex] === true,
  };
}

function sheepCandidates(ctx, radius, color, processed) {
  const origin = ctx.bot.entity.position;
  const candidates = [];
  for (const sheep of Object.values(ctx.bot.entities || {})) {
    if (!sheep || sheep.name !== 'sheep' || !sheep.position || sheep.isValid === false) continue;
    if (processed.has(sheep.id)) continue;
    const state = sheepWoolState(ctx, sheep);
    if (!state || state.sheared || state.baby || !state.color || (color && state.color !== color)) {
      continue;
    }
    const distance = origin.distanceTo(sheep.position);
    if (distance > radius) continue;
    candidates.push({ sheep, color: state.color, distance });
  }
  return candidates.sort((left, right) => left.distance - right.distance);
}

function assertSafeSheepSearchConditions(ctx, minFood) {
  const bot = ctx.bot;
  if (ctx.interrupted) throw new Error('寻找羊时被新的指令打断');
  const health = Number(bot.health);
  if (!Number.isFinite(health) || health <= 12) {
    throw new Error(`血量未知或不足（血量 ${Number.isFinite(health) ? health : '未知'}），停止寻找羊`);
  }
  const food = bot.food;
  if (!Number.isFinite(food) || food < minFood) {
    throw new Error(`饥饿值未知或过低（${Number.isFinite(food) ? food : '未知'}），停止寻找羊`);
  }
  if (typeof ctx.isSleepTime !== 'function' || ctx.isSleepTime()) {
    throw new Error('现在是夜晚或无法确认白天，停止外出寻找羊');
  }
  if (typeof ctx.isThunderstorm !== 'function' || ctx.isThunderstorm()) {
    throw new Error('雷暴或天气状态未知，停止外出寻找羊');
  }
  const timeOfDay = Number(bot.time?.timeOfDay);
  if (!Number.isFinite(timeOfDay) || timeOfDay < 0 || timeOfDay >= 12000) {
    throw new Error('无法确认当前处于白天，停止外出寻找羊');
  }
}

async function ensureSafeSheepSearch(ctx, recovery, minFood = 8) {
  assertSafeSheepSearchConditions(ctx, minFood);
  if (typeof ctx.nearbyHostiles !== 'function') {
    throw new Error('附近有敌对生物或无法确认安全，停止外出寻找羊');
  }
  const hostiles = ctx.nearbyHostiles(12);
  if (!hostiles) throw new Error('附近有敌对生物或无法确认安全，停止外出寻找羊');
  if (hostiles.length === 0) return;

  if (
    typeof ctx.findHostile !== 'function' ||
    typeof ctx.retreatFrom !== 'function' ||
    typeof ctx.sleep !== 'function'
  ) {
    throw new Error('附近有敌对生物或无法确认安全，停止外出寻找羊');
  }

  while (recovery.attempts < SHEEP_HOSTILE_RECOVERY_MAX_ATTEMPTS) {
    assertSafeSheepSearchConditions(ctx, minFood);
    const target = ctx.findHostile(16);
    if (!target || !target.position) {
      throw new Error('附近有敌对生物或无法确认安全，停止外出寻找羊');
    }
    recovery.attempts += 1;
    if (typeof ctx.log === 'function') {
      ctx.log('剪羊搜索遇到敌对生物', `${target.name || '未知'}；尝试撤离 ${recovery.attempts}/${SHEEP_HOSTILE_RECOVERY_MAX_ATTEMPTS}`);
    }
    await ctx.retreatFrom(target);
    for (let check = 0; check < SHEEP_HOSTILE_RECHECK_ATTEMPTS; check += 1) {
      if (ctx.interrupted) throw new Error('寻找羊时被新的指令打断');
      await ctx.sleep(750);
      assertSafeSheepSearchConditions(ctx, minFood);
      const remainingHostiles = ctx.nearbyHostiles(12);
      if (!remainingHostiles) {
        throw new Error('附近有敌对生物或无法确认安全，停止外出寻找羊');
      }
      if (remainingHostiles.length === 0) return;
    }
  }

  throw new Error('撤离后附近仍有敌对生物，停止外出寻找羊');
}

async function searchForSheep(
  ctx,
  radius,
  color,
  maxSteps,
  excluded = new Set(),
  targetWoolCount = 1,
  minimumSearchSteps = 1,
  safetyRecovery = { attempts: 0 },
) {
  if (typeof ctx.walkOnce !== 'function') return { candidates: [], stepsUsed: 0 };
  const origin = ctx.bot.entity.position;
  const originX = origin.x;
  const originZ = origin.z;
  const searchRadius = Math.min(radius, 96);
  const visited = new Set();
  const discovered = new Map();
  let stepsUsed = 0;
  const stepLimit = Math.min(SHEEP_SEARCH_MAX_STEPS, Math.max(0, maxSteps));
  const randomValue = typeof ctx.random === 'function' ? ctx.random : Math.random;
  const routeHeading = randomValue() * Math.PI * 2;
  for (let step = 0; step < stepLimit; step += 1) {
    await ensureSafeSheepSearch(ctx, safetyRecovery);
    const currentPosition = ctx.bot.entity.position;
    const waypoint = nextSheepSearchWaypoint(
      ctx,
      originX,
      originZ,
      currentPosition.x,
      currentPosition.z,
      searchRadius,
      step,
      stepLimit,
      routeHeading,
      visited,
    );
    if (!waypoint) break;
    stepsUsed += 1;
    if (typeof ctx.log === 'function') {
      ctx.log('剪羊搜索路线', `${step + 1}/${SHEEP_SEARCH_MAX_STEPS}`, `(${waypoint.x}, ${waypoint.y}, ${waypoint.z})`);
    }
    const outcome = await walkSheepSearchWaypoint(ctx, waypoint);
    if (outcome !== 'reached') {
      if (outcome === 'unreachable' || outcome === 'stopped') continue;
      throw new Error(`寻找羊时移动未完成（${outcome || '未知状态'}），停止探索`);
    }
    await ensureSafeSheepSearch(ctx, safetyRecovery);
    const candidates = sheepCandidates(ctx, radius, color, excluded);
    for (const candidate of candidates) {
      const offsetX = candidate.sheep.position.x - originX;
      const offsetZ = candidate.sheep.position.z - originZ;
      if (Math.hypot(offsetX, offsetZ) <= radius) {
        discovered.set(candidate.sheep.id, candidate);
      }
    }
    if (typeof ctx.log === 'function') {
      ctx.log('剪羊搜索观察', `${stepsUsed}/${stepLimit}`, `候选羊 ${discovered.size}`);
    }
    const candidateCounts = new Map();
    for (const candidate of discovered.values()) {
      candidateCounts.set(candidate.color, (candidateCounts.get(candidate.color) || 0) + 1);
    }
    const searchedColors = color ? [color] : SHEEP_COLORS;
    let colorCanMeetTarget = false;
    for (const searchedColor of searchedColors) {
      if (
        ctx.countItem(`${searchedColor}_wool`) +
          Math.min((candidateCounts.get(searchedColor) || 0) * 3, targetWoolCount) >= targetWoolCount
      ) {
        colorCanMeetTarget = true;
        break;
      }
    }
    if (
      colorCanMeetTarget &&
      (stepsUsed >= Math.min(stepLimit, minimumSearchSteps) || discovered.size >= targetWoolCount)
    ) {
      return { candidates: [...discovered.values()], stepsUsed };
    }
  }
  return {
    candidates: [...discovered.values()].sort((left, right) => left.distance - right.distance),
    stepsUsed,
  };
}

function nextSheepSearchWaypoint(
  ctx,
  originX,
  originZ,
  currentX,
  currentZ,
  radius,
  step,
  stepLimit,
  routeHeading,
  visited,
  forwardOnly = false,
  dryFallback = false,
) {
  const bot = ctx.bot;
  if (typeof bot.findBlocks !== 'function' || typeof bot.blockAt !== 'function') return null;
  const minStep = Math.min(10, radius * 0.45);
  const maxStep = Math.min(18, Math.max(minStep, radius * 0.75));
  const hop = Math.min(13, (minStep + maxStep) / 2);
  const firstRadius = Math.min(radius, hop);
  const coverageRadius = Math.min(radius, firstRadius + hop * Math.max(0, stepLimit - 1) * 0.75);
  const radialGrowth = stepLimit > 1
    ? (coverageRadius - firstRadius) / (stepLimit - 1)
    : 0;
  const currentOffsetX = currentX - originX;
  const currentOffsetZ = currentZ - originZ;
  const currentRadius = Math.hypot(currentOffsetX, currentOffsetZ);
  const nextRadius = Math.min(
    radius,
    Math.max(firstRadius, currentRadius) + (step === 0 ? 0 : radialGrowth),
  );
  const currentHeading = currentRadius > 0.001
    ? Math.atan2(currentOffsetZ, currentOffsetX)
    : routeHeading;
  const cosine = currentRadius > 0.001 && nextRadius > 0.001
    ? (currentRadius ** 2 + nextRadius ** 2 - hop ** 2) / (2 * currentRadius * nextRadius)
    : 1;
  const turn = Math.acos(Math.max(-1, Math.min(1, cosine)));
  const target = {
    x: forwardOnly ? currentX + Math.cos(routeHeading) * hop : originX + Math.cos(currentHeading + turn) * nextRadius,
    z: forwardOnly ? currentZ + Math.sin(routeHeading) * hop : originZ + Math.sin(currentHeading + turn) * nextRadius,
  };
  let supports;
  try {
    supports = bot.findBlocks({
      matching: (block) => {
        if (!block || block.boundingBox !== 'block' || isSheepSearchHazard(block.name)) return false;
        const position = block.position;
        if (!position) return true;
        const fromCurrent = Math.hypot(position.x - currentX, position.z - currentZ);
        if (fromCurrent < minStep || fromCurrent > maxStep) return false;
        if (Math.hypot(position.x - originX, position.z - originZ) > radius) return false;
        const key = `${Math.round(position.x)},${Math.round(position.z)}`;
        return !visited.has(key);
      },
      maxDistance: Math.min(radius, maxStep + 4),
      count: 192,
    });
  } catch {
    return null;
  }
  const candidates = [];
  for (const support of supports || []) {
    const position = support?.position || support;
    if (!position) continue;
    const x = position.x;
    const y = position.y + 1;
    const z = position.z;
    const fromCurrent = Math.hypot(x - currentX, z - currentZ);
    if (fromCurrent < minStep || fromCurrent > maxStep) continue;
    if (forwardOnly && (x - currentX) * Math.cos(routeHeading) + (z - currentZ) * Math.sin(routeHeading) < minStep * 0.4) continue;
    if (Math.hypot(x - originX, z - originZ) > radius) continue;
    const key = `${Math.round(x)},${Math.round(z)}`;
    if (visited.has(key)) continue;
    let feet;
    let head;
    try {
      feet = bot.blockAt(sheepBlockPosition(bot.entity.position, x, y, z));
      head = bot.blockAt(sheepBlockPosition(bot.entity.position, x, y + 1, z));
    } catch {
      continue;
    }
    if (!isSheepSearchAir(feet) || !isSheepSearchAir(head)) continue;
    candidates.push({ x, y, z, key });
  }
  if (candidates.length === 0) {
    if (typeof ctx.log === 'function') {
      ctx.log('剪羊搜索没有安全路点', `已加载支撑方块 ${supports?.length || 0}`);
    }
    const sideX = -Math.sin(currentHeading);
    const sideZ = Math.cos(currentHeading);
    const offsets = [
      [0, 0], [2, 0], [-2, 0], [0, 2], [0, -2],
      [3, 1], [-3, -1], [1, -3], [-1, 3],
      [4, 0], [-4, 0], [0, 4], [0, -4],
    ];
    for (const [forward, lateral] of offsets) {
      const x = Math.round(target.x + Math.cos(currentHeading) * forward + sideX * lateral);
      const z = Math.round(target.z + Math.sin(currentHeading) * forward + sideZ * lateral);
      const distance = Math.hypot(x - currentX, z - currentZ);
      if (distance < minStep || distance > maxStep) continue;
      if (forwardOnly && (x - currentX) * Math.cos(routeHeading) + (z - currentZ) * Math.sin(routeHeading) < minStep * 0.4) continue;
      if (Math.hypot(x - originX, z - originZ) > radius) continue;
      const key = `${Math.round(x)},${Math.round(z)}`;
      if (visited.has(key)) continue;
      if (dryFallback) {
        const y = Math.floor(bot.entity.position.y);
        const at = dy => bot.blockAt(sheepBlockPosition(bot.entity.position, x, y + dy, z));
        const floor = at(-1);
        if (floor?.boundingBox !== 'block' || isSheepSearchHazard(floor.name)
            || !isSheepSearchAir(at(0)) || !isSheepSearchAir(at(1))) continue;
      }
      visited.add(key);
      if (typeof ctx.log === 'function') {
        ctx.log('剪羊搜索改用寻路探索点', `(${x}, ${Math.floor(bot.entity.position.y)}, ${z})`);
      }
      return { x, y: Math.floor(bot.entity.position.y), z, key };
    }
    return null;
  }
  candidates.sort((left, right) => {
    const leftDistance = Math.hypot(left.x - target.x, left.z - target.z);
    const rightDistance = Math.hypot(right.x - target.x, right.z - target.z);
    return leftDistance - rightDistance;
  });
  const waypoint = candidates[0];
  visited.add(waypoint.key);
  return waypoint;
}

function sheepBlockPosition(origin, x, y, z) {
  if (typeof origin.offset === 'function') {
    return origin.offset(x - origin.x, y - origin.y, z - origin.z);
  }
  return { x, y, z };
}

function isSheepSearchAir(block) {
  return Boolean(block && block.boundingBox === 'empty' && !isSheepSearchHazard(block.name));
}

function isSheepSearchHazard(name) {
  return /water|bubble_column|lava|fire|cactus|magma_block|sweet_berry_bush|powder_snow|wither_rose|campfire/i.test(String(name || ''));
}

async function walkSheepSearchWaypoint(ctx, waypoint, timeoutMs = SHEEP_SEARCH_STEP_TIMEOUT_MS) {
  const movements = ctx.bot.pathfinder?.movements;
  const previousLiquidCost = movements && Number.isFinite(movements.liquidCost)
    ? movements.liquidCost
    : null;
  const avoidedWater = [];
  const blocksToAvoid = movements?.blocksToAvoid;
  const blocksByName = ctx.registry?.blocksByName || {};
  let startingInWater = false;
  try {
    const feet = ctx.bot.blockAt(ctx.bot.entity.position);
    startingInWater = Boolean(feet && /water/i.test(String(feet.name || '')));
  } catch {
    startingInWater = true;
  }
  if (!startingInWater && blocksToAvoid instanceof Set) {
    for (const name of ['water', 'flowing_water', 'bubble_column']) {
      const id = blocksByName[name]?.id;
      if (id !== undefined && !blocksToAvoid.has(id)) {
        blocksToAvoid.add(id);
        avoidedWater.push(id);
      }
    }
  }
  if (previousLiquidCost !== null) movements.liquidCost = Math.max(previousLiquidCost, 32);
  try {
    return await ctx.walkOnce(
      waypoint.x,
      waypoint.y,
      waypoint.z,
      3,
      timeoutMs,
      true,
    );
  } finally {
    if (previousLiquidCost !== null) movements.liquidCost = previousLiquidCost;
    for (const id of avoidedWater) blocksToAvoid.delete(id);
  }
}

function createCombatSearchState(ctx) {
  const randomValue = typeof ctx.random === 'function' ? ctx.random : Math.random;
  return {
    routeHeading: randomValue() * Math.PI * 2,
    visited: new Set(),
    steps: 0,
  };
}

function assertCombatSearchSafe(ctx, minHealth, action) {
  assertCombatSearchHealth(ctx, minHealth, action);
  if (typeof ctx.nearbyHostiles !== 'function') {
    throw new Error(`附近有敌对生物或无法确认安全，停止${action}`);
  }
  const hostiles = ctx.nearbyHostiles(12);
  if (!Array.isArray(hostiles) || hostiles.length > 0) {
    throw new Error(`附近有敌对生物或无法确认安全，停止${action}`);
  }
}

function assertCombatSearchHealth(ctx, minHealth, action) {
  throwIfInterrupted(ctx, action);
  const health = Number(ctx.bot.health);
  if (!Number.isFinite(health) || health <= minHealth) {
    throw new Error(`血量不足或未知（${Number.isFinite(health) ? health : '未知'}），停止${action}`);
  }
}

async function moveCombatSearchWaypoint(ctx, state, radius, minHealth, action) {
  if (state.steps >= HUNT_SEARCH_MAX_STEPS || typeof ctx.walkOnce !== 'function') {
    state.steps = HUNT_SEARCH_MAX_STEPS;
    return 'exhausted';
  }
  assertCombatSearchSafe(ctx, minHealth, action);
  const position = ctx.bot.entity.position;
  const waypoint = nextSheepSearchWaypoint(
    ctx,
    position.x,
    position.z,
    position.x,
    position.z,
    Math.min(radius, 96),
    0,
    HUNT_SEARCH_MAX_STEPS,
    state.routeHeading,
    state.visited,
    true,
  );
  if (!waypoint) {
    state.steps = HUNT_SEARCH_MAX_STEPS;
    return 'exhausted';
  }
  state.steps += 1;
  if (typeof ctx.log === 'function') {
    ctx.log('战斗材料搜索路线', `${state.steps}/${HUNT_SEARCH_MAX_STEPS}`, `(${waypoint.x}, ${waypoint.y}, ${waypoint.z})`);
  }
  const outcome = await walkSheepSearchWaypoint(ctx, waypoint, HUNT_SEARCH_STEP_TIMEOUT_MS);
  throwIfInterrupted(ctx, action);
  if (outcome === 'stopped' || outcome === 'cancelled') {
    throw new Error(`${action}移动被安全控制停止，结束搜索`);
  }
  assertCombatSearchSafe(ctx, minHealth, action);
  if (outcome === 'unreachable') return outcome;
  if (outcome !== 'reached') {
    throw new Error(`${action}移动未完成（${outcome || '未知状态'}），结束搜索`);
  }
  return outcome;
}

function pickSheepColor(ctx, candidates, requestedColor, count) {
  if (requestedColor !== 'auto') return requestedColor;
  const available = SHEEP_COLORS
    .map((color) => ({
      color,
      held: ctx.countItem(`${color}_wool`),
      sheep: candidates.filter((item) => item.color === color).length,
    }))
    .filter((item) => item.held > 0 || item.sheep > 0)
    .sort((left, right) =>
      Number(right.held >= count) - Number(left.held >= count) ||
      Number(right.held + right.sheep >= count) - Number(left.held + left.sheep >= count) ||
      right.held - left.held ||
      right.sheep - left.sheep,
    );
  return available[0]?.color || '';
}

async function shearSheep(args, ctx) {
  const bot = ctx.bot;
  if (!bot || !bot.entity) throw new Error('bot 还没进入世界，没有办法剪羊毛');
  const count = Math.max(1, Math.min(Math.floor(Number(args.count) || 3), 16));
  const radius = Math.max(4, Math.min(Number(args.radius) || 48, 96));
  const requestedColor = String(args.color || 'auto').trim().toLowerCase();
  if (requestedColor !== 'auto' && !SHEEP_COLORS.includes(requestedColor)) {
    throw new Error(`不知道羊毛颜色 ${requestedColor}`);
  }

  if (typeof ctx.log === 'function') {
    const sheepEntities = Object.values(bot.entities || {}).filter((entity) => entity?.name === 'sheep' && entity.position);
    const nearby = sheepEntities
      .map((sheep) => ({ sheep, distance: bot.entity.position.distanceTo(sheep.position) }))
      .filter(({ distance }) => distance <= radius)
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 6)
      .map(({ sheep, distance }) => {
        const state = sheepWoolState(ctx, sheep);
        return `${sheep.id}@${distance.toFixed(1)}(${sheep.position.x.toFixed(0)},${sheep.position.y.toFixed(0)},${sheep.position.z.toFixed(0)}) state=${state ? `${state.color}/${state.sheared ? 'shorn' : 'wool'}/${state.baby ? 'baby' : 'adult'}` : 'unknown'} metadata=${JSON.stringify(sheep.metadata)}`;
      });
    ctx.log('剪羊搜索初始羊实体', `加载 ${sheepEntities.length}，${radius} 格内 ${nearby.length}：${nearby.join(' | ') || '无'}`);
  }

  let initialCandidates = sheepCandidates(
    ctx,
    radius,
    requestedColor === 'auto' ? '' : requestedColor,
    new Set(),
  );
  let color = pickSheepColor(ctx, initialCandidates, requestedColor, count);
  const heldWool = color ? ctx.countItem(`${color}_wool`) : 0;
  const availableForColor = color
    ? heldWool + initialCandidates.filter((candidate) => candidate.color === color).length
    : 0;
  if (color && heldWool >= count) {
    const total = heldWool;
    return {
      detail: `背包里已经有 ${total} 个${ctx.itemLabel(`${color}_wool`)}，够 ${count} 个`,
      status: 'succeeded',
    };
  }
  let searchStepsUsed = 0;
  const safetyRecovery = { attempts: 0 };
  if (availableForColor < count) {
    const explored = await searchForSheep(
      ctx,
      radius,
      requestedColor === 'auto' ? '' : requestedColor,
      SHEEP_SEARCH_MAX_STEPS,
      new Set(),
      count,
      requestedColor === 'auto' ? 4 : 1,
      safetyRecovery,
    );
    searchStepsUsed += explored.stepsUsed;
    const combined = new Map(initialCandidates.map((candidate) => [candidate.sheep.id, candidate]));
    for (const candidate of explored.candidates) combined.set(candidate.sheep.id, candidate);
    initialCandidates = [...combined.values()];
  }
  color = pickSheepColor(ctx, initialCandidates, requestedColor, count);
  if (!color) {
    throw new Error(`附近 ${radius} 格内没有可剪的羊；已尝试有限白天搜索，或羊的颜色状态不可读`);
  }
  const itemName = `${color}_wool`;
  const initial = ctx.countItem(itemName);
  if (initial >= count) {
    return {
      detail: `背包里已经有 ${initial} 个${ctx.itemLabel(itemName)}，够 ${count} 个`,
      status: 'succeeded',
    };
  }
  const shears = bot.inventory.items().find((item) => item.name === 'shears');
  if (!shears) throw new Error('背包里没有剪刀，先合成剪刀再剪羊毛');
  if (typeof bot.activateEntity !== 'function') throw new Error('mineflayer 没有提供实体交互接口');

  const processed = new Set();
  const discoveredCandidates = initialCandidates.filter((candidate) => candidate.color === color);
  const deadline = Date.now() + 180000;
  let shorn = 0;
  while (ctx.countItem(itemName) < count && Date.now() < deadline) {
    if (ctx.interrupted) throw new Error('被新的指令打断');
    if (Number(bot.health ?? 20) <= 8) throw new Error(`血量不足（血量 ${bot.health}），已中止剪羊毛`);
    let candidates = sheepCandidates(ctx, radius, color, processed);
    const nearbyIds = new Set(candidates.map((candidate) => candidate.sheep.id));
    for (const candidate of discoveredCandidates) {
      const sheep = candidate.sheep;
      if (!sheep || sheep.isValid === false || processed.has(sheep.id) || nearbyIds.has(sheep.id)) continue;
      const state = sheepWoolState(ctx, sheep);
      if (!state || state.sheared || state.baby || state.color !== color) continue;
      candidates.push({
        sheep,
        color: state.color,
        distance: bot.entity.position.distanceTo(sheep.position),
      });
    }
    candidates.sort((left, right) => left.distance - right.distance);
    if (candidates.length === 0 && searchStepsUsed < SHEEP_SEARCH_MAX_STEPS) {
      const explored = await searchForSheep(
        ctx,
        radius,
        color,
        SHEEP_SEARCH_MAX_STEPS - searchStepsUsed,
        processed,
        count - ctx.countItem(`${color}_wool`),
      requestedColor === 'auto' ? 4 : 1,
        safetyRecovery,
      );
      searchStepsUsed += explored.stepsUsed;
      candidates = sheepCandidates(ctx, radius, color, processed);
      if (candidates.length === 0 && explored.candidates.length > 0) {
        candidates = explored.candidates
          .filter((candidate) => !processed.has(candidate.sheep.id))
          .sort((left, right) => left.distance - right.distance);
      }
    }
    const target = candidates[0]?.sheep;
    if (!target) {
      if (shorn === 0) throw new Error(`附近 ${radius} 格内没有可剪的${color}羊；安全随机搜索了 ${searchStepsUsed} 段`);
      throw new Error(`羊毛不够，还差 ${count - ctx.countItem(itemName)} 个${ctx.itemLabel(itemName)}，附近已没有可剪的${color}羊；安全随机搜索了 ${searchStepsUsed} 段`);
    }
    await ctx.approach(target);
    if (ctx.interrupted) throw new Error('被新的指令打断');
    if (Number(bot.health ?? 20) <= 8) throw new Error(`血量不足（血量 ${bot.health}），已中止剪羊毛`);
    if (target.isValid === false) continue;
    if (bot.entity.position.distanceTo(target.position) > 3.5) {
      processed.add(target.id);
      continue;
    }
    const before = ctx.countItem(itemName);
    const stateBefore = sheepWoolState(ctx, target);
    processed.add(target.id);
    await bot.equip(shears, 'hand');
    await bot.activateEntity(target);
    await ctx.sleep(600);
    if (typeof ctx.collectDrops === 'function') await ctx.collectDrops(6, itemName);
    if (ctx.interrupted) throw new Error('被新的指令打断');
    if (typeof ctx.syncInventory === 'function') await ctx.syncInventory();
    const gained = ctx.countItem(itemName) - before;
    if (gained <= 0) {
      const stateAfter = sheepWoolState(ctx, target);
      const result = stateBefore && stateAfter?.sheared
        ? '羊已经剪过，但背包没有增加羊毛'
        : '剪刀交互后羊毛数量没有增加';
      throw new Error(`${result}（检查剪刀耐久、背包空间和服务端状态）`);
    }
    shorn += 1;
  }

  const total = ctx.countItem(itemName);
  if (total < count) throw new Error(`剪羊毛超时，还差 ${count - total} 个${ctx.itemLabel(itemName)}`);
  return {
    detail: `剪了 ${shorn} 只羊，获得 ${total - initial} 个${ctx.itemLabel(itemName)}，背包共 ${total} 个`,
    status: 'succeeded',
  };
}

// 末地水晶实体在不同版本里名字可能带前缀。
function isCrystalName(name) {
  const text = String(name || '').toLowerCase();
  return text === 'end_crystal' || text === 'ender_crystal' || text === 'crystal';
}

function findCrystals(ctx, radius) {
  const bot = ctx.bot;
  const origin = bot.entity.position;
  const result = [];
  for (const entity of Object.values(bot.entities || {})) {
    if (!entity || !entity.position) continue;
    if (!isCrystalName(entity.name)) continue;
    const distance = origin.distanceTo(entity.position);
    if (distance > radius) continue;
    result.push({ entity, distance });
  }
  result.sort((left, right) => left.distance - right.distance);
  return result.map((entry) => entry.entity);
}

// 生物的中文名。
function mobLabel(ctx, name) {
  const key = String(name || '').toLowerCase();
  if (MOB_LABELS[key]) return MOB_LABELS[key];
  if (typeof ctx.blockLabel === 'function') return ctx.blockLabel(key);
  return key;
}

// 背包里现有多少块目标肉。
function countMeat(ctx, speciesList) {
  const total = { value: 0, parts: [] };
  for (const species of speciesList) {
    const meat = meatFor(species);
    if (!meat) continue;
    const count = ctx.countItem(meat);
    if (count > 0) {
      total.value += count;
      total.parts.push(`${ctx.itemLabel(meat)} x${count}`);
    }
  }
  return total;
}

// 身上是否在着火：脚下火方块，或实体的 on fire 标志位（0x01）。
function isBurning(ctx) {
  const bot = ctx.bot;
  const position = bot.entity.position;
  try {
    const feet = bot.blockAt(position);
    if (feet && (feet.name === 'fire' || feet.name === 'soul_fire')) return true;
  } catch (error) {
    ctx.log('读脚下方块失败', error.message);
  }
  const flags = bot.entity.metadata && bot.entity.metadata[0];
  if (typeof flags === 'number' && (flags & 0x01) !== 0) return true;
  return false;
}

async function retreatIfGroupOverwhelms(ctx, target, action) {
  const bot = ctx.bot;
  const encounter = assessCombatEncounter({
    entities: bot.entities,
    origin: bot.entity.position,
    registry: bot.registry,
    health: bot.health,
    radius: 16,
    currentTarget: target,
    equipment: combatEquipment(bot),
  });
  if (!encounter.should_retreat) return false;

  throwIfInterrupted(ctx, action);
  const threat = encounter.urgent?.entity || encounter.primary?.entity || target;
  let movedAway = false;
  if (typeof ctx.retreatFrom === 'function') movedAway = Boolean(await ctx.retreatFrom(threat));
  throwIfInterrupted(ctx, action);
  const movement = movedAway ? '已拉开距离' : '后撤未确认';
  throw new Error(`还差目标；${encounter.retreat_reason || '周围敌对生物威胁过高'}，${movement}，停止${action}`);
}

// 原版没有末影人抓起玩家的机制；仅兼容服务器插件明确设置的乘载关系。
function isGrabbedByEnderman(ctx, enderman) {
  if (!enderman || enderman.id === undefined) return false;
  if (typeof ctx.isGrabbedByEnderman === 'function') {
    return Boolean(ctx.isGrabbedByEnderman(enderman));
  }
  const entity = ctx.bot.entity;
  const vehicle = entity && entity.vehicle;
  return Boolean(
    vehicle && (vehicle === enderman || vehicle === enderman.id || vehicle.id === enderman.id) ||
    entity && entity.vehicleId === enderman.id
  );
}

// 血量恢复：等自然回血。ctx 没有 waitForHealth，这里自己等。
async function waitHealth(ctx, minHealth, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfInterrupted(ctx, '等待回血');
    if (Number(ctx.bot.health ?? 20) >= minHealth) return true;
    await ctx.sleep(500);
  }
  throwIfInterrupted(ctx, '等待回血');
  return Number(ctx.bot.health ?? 20) >= minHealth;
}

// 血量低时先吃点东西再等恢复。
async function recoverHealth(ctx, minHealth, timeoutMs) {
  throwIfInterrupted(ctx, '恢复血量');
  if (typeof ctx.eatFood === 'function' && Number(ctx.bot.food ?? 20) < 20) {
    try {
      await ctx.eatFood({ count: 2 });
    } catch (error) {
      throwIfInterrupted(ctx, '恢复血量');
      ctx.log('回血时吃东西失败', error.message);
    }
  }
  throwIfInterrupted(ctx, '恢复血量');
  const recovered = await waitHealth(ctx, minHealth, timeoutMs);
  throwIfInterrupted(ctx, '恢复血量');
  return recovered;
}

// 背包里的盾装到副手；没有盾返回 null。
async function equipShield(ctx) {
  const bot = ctx.bot;
  const shield = bot.inventory.items().find((item) => item.name === 'shield');
  if (!shield) return null;
  const offHand = bot.inventory.slots[45];
  if (offHand && offHand.name === 'shield') return shield;
  try {
    if (typeof bot.moveSlotItem === 'function') {
      await bot.moveSlotItem(shield.slot, 45);
    } else {
      await bot.equip(shield, 'hand');
    }
  } catch (error) {
    ctx.log('盾装到副手失败，退回主手', error.message);
    await bot.equip(shield, 'hand');
  }
  if (typeof ctx.syncInventory === 'function') await ctx.syncInventory();
  return shield;
}

// 举起盾牌格挡。
async function raiseShield(ctx) {
  const bot = ctx.bot;
  if (typeof bot.activateItem !== 'function') return false;
  try {
    bot.activateItem(true);
    await ctx.sleep(250);
    return true;
  } catch (error) {
    ctx.log('举盾失败', error.message);
    return false;
  }
}

// 放下盾牌。
async function lowerShield(ctx) {
  const bot = ctx.bot;
  if (typeof bot.deactivateItem !== 'function') return false;
  try {
    bot.deactivateItem();
    await ctx.sleep(150);
    return true;
  } catch (error) {
    ctx.log('收盾失败', error.message);
    return false;
  }
}

// 找到正在飞向 bot 的投射物。
function findIncomingProjectile(ctx) {
  const bot = ctx.bot;
  const botPos = bot.entity.position;
  const candidates = [];
  for (const entity of Object.values(bot.entities || {})) {
    if (!entity || !entity.position) continue;
    if (!BLAZE_PROJECTILES.includes(entity.name)) continue;
    const distance = botPos.distanceTo(entity.position);
    if (distance > PROJECTILE_ALERT_RANGE) continue;
    const velocity = entity.velocity;
    const speed = velocity ? Math.hypot(Number(velocity.x) || 0, Number(velocity.z) || 0) : 0;
    if (speed > 0.01) {
      const dx = botPos.x - entity.position.x;
      const dz = botPos.z - entity.position.z;
      const norm = Math.hypot(dx, dz) || 1;
      const towards = ((Number(velocity.x) || 0) * dx + (Number(velocity.z) || 0) * dz) / norm;
      if (towards <= 0) continue; // 不是冲 bot 来的
    } else if (distance > 3) {
      continue; // 静止的火球不算来袭
    }
    candidates.push({ name: entity.name, entity, position: entity.position, velocity });
  }
  const picked = pickThreat(candidates, botPos);
  return picked ? picked.entity : null;
}

// 横向躲开投射物：沿垂直于来袭方向的一侧平移。
async function dodgeProjectile(ctx, projectile) {
  const bot = ctx.bot;
  const botPos = bot.entity.position;
  const dx = botPos.x - projectile.position.x;
  const dz = botPos.z - projectile.position.z;
  const yaw = Number(bot.entity.yaw) || 0;
  // 朝向的右手方向：yaw 增大就是向右转。
  const rightX = -Math.cos(yaw);
  const rightZ = -Math.sin(yaw);
  const perpX = -dz;
  const perpZ = dx;
  const side = perpX * rightX + perpZ * rightZ >= 0 ? 'right' : 'left';
  try {
    bot.setControlState(side, true);
    bot.setControlState('back', true);
    // 火球贴脸时多躲一会儿。
    const danger = blastDanger(projectile.position, botPos);
    const dodgeMs = danger.level === 'danger' ? 420 : 300;
    await ctx.sleep(dodgeMs);
  } catch (error) {
    ctx.log('躲火球失败', error.message);
  } finally {
    try {
      bot.setControlState(side, false);
      bot.setControlState('back', false);
    } catch (error) {
      ctx.log('恢复移动状态失败', error.message);
    }
  }
}

// 走到某个坐标附近；走不到就留在原地。
async function moveTo(ctx, position, radius) {
  try {
    await ctx.travelTo(position.x, position.y, position.z, radius);
    return true;
  } catch (error) {
    ctx.log('走不过去', error.message);
    return false;
  }
}

// 走到离 fromPos 至少 distance 的位置；走不到就留在原地。
async function moveAwayFrom(ctx, fromPos, distance) {
  const bot = ctx.bot;
  const position = bot.entity.position;
  const dx = position.x - fromPos.x;
  const dz = position.z - fromPos.z;
  const length = Math.hypot(dx, dz) || 1;
  const x = Math.floor(position.x + (dx / length) * distance);
  const z = Math.floor(position.z + (dz / length) * distance);
  return moveTo(ctx, { x, y: position.y, z }, 2);
}

// 追到近战距离；返回 'reached' | 'gone' | 'failed'。
async function chaseTarget(ctx, target, range, deadline) {
  let steps = 0;
  let stalled = 0;
  let lastDistance = Infinity;
  while (steps < 40 && Date.now() < deadline) {
    if (target.isValid === false) return 'gone';
    const distance = ctx.bot.entity.position.distanceTo(target.position);
    if (distance <= range) return 'reached';
    if (distance >= lastDistance - 0.25) stalled += 1;
    else stalled = 0;
    if (stalled >= 3) return 'failed';
    lastDistance = distance;
    await ctx.approach(target);
    steps += 1;
    await ctx.sleep(200);
  }
  if (target.isValid === false) return 'gone';
  const distance = ctx.bot.entity.position.distanceTo(target.position);
  return distance <= range ? 'reached' : 'failed';
}

// 等掉落物出现并捡起来；返回这次新增的数量。
async function collectItem(ctx, itemName, range = 6) {
  await ctx.sleep(600);
  let picked = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await ctx.collectDrops(range, itemName);
    if (result && result.picked && result.picked[itemName]) {
      picked += result.picked[itemName];
      break;
    }
    await ctx.sleep(800);
  }
  return picked;
}

async function huntMaterial(args, ctx) {
  throwIfInterrupted(ctx, '收集战斗材料');
  let itemName = String(args.item || '').trim().toLowerCase();
  const wool = itemName === 'wool';
  let woolColor = '';
  const species = wool ? 'sheep' : COMBAT_MATERIAL_SOURCES[itemName];
  if (!species) throw new Error(`不支持收集 ${itemName || '未知物品'}；可收集 wool、string 或 feather`);

  const wanted = Math.trunc(clamp(args.count, 1, 32, 1));
  const radius = clamp(args.radius, 4, 64, 48);
  const minHealth = clamp(args.min_health, 4, 20, 10);
  if (wool) {
    woolColor = pickSheepColor(ctx, sheepCandidates(ctx, radius, '', new Set()), 'auto', wanted);
    itemName = woolColor ? `${woolColor}_wool` : 'wool';
  }
  const initial = ctx.countItem(itemName);
  if (initial >= wanted) {
    return { detail: `背包里已经有 ${initial} 个${ctx.itemLabel(itemName)}，够 ${wanted} 个`, status: 'succeeded' };
  }

  const deadline = Date.now() + HUNT_TIMEOUT_MS;
  const maxKills = Math.max(6, Math.min(40, (wanted - initial) * 8));
  let kills = 0;
  let attempts = 0;
  const searchState = createCombatSearchState(ctx);

  while (Date.now() < deadline && kills < maxKills) {
    assertCombatSearchHealth(ctx, minHealth, `猎取${mobLabel(ctx, species)}`);

    let target;
    if (wool) {
      const candidates = sheepCandidates(ctx, radius, woolColor, new Set());
      if (!woolColor) woolColor = pickSheepColor(ctx, candidates, 'auto', wanted);
      if (woolColor) itemName = `${woolColor}_wool`;
      target = candidates.find(candidate => candidate.color === woolColor)?.sheep;
    } else {
      target = findEntity(ctx, species, radius);
    }
    if (!target) {
      const moved = await moveCombatSearchWaypoint(
        ctx,
        searchState,
        radius,
        minHealth,
        '收集战斗材料',
      );
      if (moved === 'reached' || moved === 'unreachable') continue;
      break;
    }
    throwIfInterrupted(ctx, '收集战斗材料');
    attempts += 1;
    const chased = await chaseTarget(ctx, target, MELEE_RANGE, deadline);
    throwIfInterrupted(ctx, '收集战斗材料');
    if (chased === 'gone') continue;
    if (chased === 'failed') {
      await ctx.sleep(500);
      continue;
    }

    assertCombatSearchHealth(ctx, minHealth, `获取${mobLabel(ctx, species)}`);
    await ctx.attackEntity(target);
    throwIfInterrupted(ctx, '收集战斗材料');
    if (target.isValid === false) {
      kills += 1;
      await collectItem(ctx, itemName);
      if (typeof ctx.syncInventory === 'function') await ctx.syncInventory();
      throwIfInterrupted(ctx, '收集战斗材料');
      if (ctx.countItem(itemName) >= wanted) break;
    }

    if (Number(ctx.bot.health) <= minHealth + 2) {
      await ctx.retreatFrom(target);
      const recovered = await recoverHealth(ctx, minHealth + 4, 20000);
      if (!recovered) break;
    }
    if (attempts >= maxKills * 2) break;
  }

  throwIfInterrupted(ctx, '收集战斗材料');
  const total = ctx.countItem(itemName);
  if (total >= wanted) {
    return {
      detail: `猎到 ${kills} 只${mobLabel(ctx, species)}，${ctx.itemLabel(itemName)}共 ${total} 个，达到目标 ${wanted} 个`,
      status: 'succeeded',
    };
  }
  throw new Error(`还差 ${wanted - total} 个${ctx.itemLabel(itemName)}，目前 ${total} 个；猎到 ${kills} 只${mobLabel(ctx, species)}`);
}

// 这些生肉分别对应哪种熟肉，提示下一步要熔炼什么。
function cookedNames(ctx, speciesList) {
  const names = [];
  for (const species of speciesList) {
    const cooked = COOKED_BY_MEAT[meatFor(species)];
    if (cooked && !names.includes(cooked)) names.push(ctx.itemLabel(cooked));
  }
  return names;
}

// 狩猎：追上去挥剑，等掉落物，捡肉。
async function huntAnimal(args, ctx) {
  const nearbyOnly = args.nearby_only === true;
  const walking = args.walk_only === true || nearbyOnly;
  const movements = ctx.bot.pathfinder?.movements;
  if (!movements) {
    if (walking) throw new Error('缺少步行寻路设置，无法低消耗寻食');
    return huntForMeat(args, ctx, HUNT_SEARCH_MAX_STEPS, 8);
  }
  return withDryGroundMovement(ctx.bot, async () => {
    if (!walking) return await huntForMeat(args, ctx, HUNT_SEARCH_MAX_STEPS, 8);
    if (nearbyOnly) {
      return await huntForMeat({...args, radius: Math.min(Number(args.radius) || 24, 24)}, ctx, 0, 0);
    }
    return await huntForMeat({...args, radius: args.radius ?? 24}, ctx, 4, 0);
  }, walking);
}

async function huntForMeat(args, ctx, maxSearchSteps, minFood) {
  const wanted = clamp(args.count, 1, 64, 1);
  const wantedKills = Math.trunc(clamp(args.min_kills, 0, 64, 0));
  const radius = clamp(args.radius, 4, 64, 32);
  const minHealth = clamp(args.min_health, 2, 20, 8);
  const species = String(args.species || '').trim().toLowerCase();
  const excludedSpecies = new Set(
    Array.isArray(args.exclude_species)
      ? args.exclude_species.map((name) => String(name || '').trim().toLowerCase()).filter(Boolean)
      : [],
  );
  let speciesList = HUNTABLE;
  if (species) {
    if (!HUNTABLE.includes(species)) {
      throw new Error(`附近没有能狩猎的 ${species}，能打的是 ${HUNTABLE.join('、')}`);
    }
    speciesList = [species];
  }
  speciesList = speciesList.filter((name) => !excludedSpecies.has(name));
  if (speciesList.length === 0) throw new Error('狩猎目标被排除规则全部过滤');

  const start = countMeat(ctx, speciesList);
  if (wantedKills === 0 && start.value >= wanted) {
    return {
      detail: `背包里已经有 ${start.value} 块生肉（${start.parts.join('、')}），够 ${wanted} 块`,
      status: 'succeeded',
    };
  }

  const deadline = Date.now() + HUNT_TIMEOUT_MS;
  let killed = 0;
  let attempts = 0;
  let found = 0;
  let searchedSince = Date.now();
  let note = '';
  const visited = new Set();
  const unreachable = new Set();
  const randomValue = typeof ctx.random === 'function' ? ctx.random : Math.random;
  const routeHeading = randomValue() * Math.PI * 2;
  const safetyRecovery = { attempts: 0 };
  let searchSteps = 0;

  while (Date.now() < deadline) {
    throwIfInterrupted(ctx, '狩猎动物');
    const daylight = daylightLeft(ctx.bot.time);
    if (daylight !== null && daylight < 2000) {
      note = `，天快黑了（第 ${ctx.bot.time.day ?? '?'} 天），先回去`;
      break;
    }
    const target = findHuntable(ctx, speciesList, radius, args.nearby_only === true, unreachable);
    if (args.nearby_only === true) {
      assertCombatSearchSafe(ctx, minHealth, '就近寻食');
      if (!target || !dryMiningFooting(ctx.bot, ctx.bot.entity.position)) {
        note = '，附近没有可从干地接近的猎物';
        break;
      }
    }
    if (!target) {
      if (searchSteps < maxSearchSteps && typeof ctx.walkOnce === 'function') {
        await ensureSafeSheepSearch(ctx, safetyRecovery, minFood);
        const position = ctx.bot.entity.position;
        const waypoint = nextSheepSearchWaypoint(
          ctx,
          position.x,
          position.z,
          position.x,
          position.z,
          radius,
          0,
          maxSearchSteps,
          routeHeading,
          visited,
          true,
          true,
        );
        if (!waypoint) {
          searchSteps = maxSearchSteps;
        } else {
          searchSteps += 1;
          if (typeof ctx.log === 'function') {
            ctx.log('狩猎搜索路线', `${searchSteps}/${maxSearchSteps}`, `(${waypoint.x}, ${waypoint.y}, ${waypoint.z})`);
          }
          const outcome = await walkSheepSearchWaypoint(
            ctx,
            waypoint,
            HUNT_SEARCH_STEP_TIMEOUT_MS,
          );
          throwIfInterrupted(ctx, '搜索动物');
          if (outcome === 'stopped' || outcome === 'cancelled') {
            throw new Error(`搜索动物时移动已停止（${outcome}），停止搜索`);
          }
          if (outcome !== 'reached' && outcome !== 'unreachable') {
            throw new Error(`搜索动物时移动未完成（${outcome || '未知状态'}），停止搜索`);
          }
          await ensureSafeSheepSearch(ctx, safetyRecovery, minFood);
          if (outcome === 'reached') {
            searchedSince = Date.now();
            continue;
          }
        }
      }
      if (Date.now() - searchedSince > SEARCH_WAIT_MS) {
        note = '有限搜索等待时间已结束';
        break;
      }
      await ctx.sleep(1000);
      continue;
    }
    searchedSince = Date.now();
    found += 1;
    const label = mobLabel(ctx, target.name);
    const meat = meatFor(target.name);

    const chased = await chaseTarget(ctx, target, MELEE_RANGE, deadline);
    throwIfInterrupted(ctx, '狩猎动物');
    if (chased === 'gone') continue;
    if (chased === 'failed') {
      unreachable.add(target);
      ctx.log('追不上目标', label);
      await ctx.sleep(500);
      continue;
    }

    await ctx.attackEntity(target, {emergencyHunt: args.nearby_only === true});
    attempts += 1;
    const dead = target.isValid === false;
    if (dead) {
      killed += 1;
      ctx.log('猎到了', label);
      if (meat) await collectItem(ctx, meat);
    }

    if (Number(ctx.bot.health ?? 20) <= minHealth) {
      await ctx.retreatFrom(target);
      const recovered = await recoverHealth(ctx, minHealth + 4, 20000);
      if (!recovered) {
        note = `，血量只剩 ${ctx.bot.health}，先撤退`;
        break;
      }
    }

    const current = countMeat(ctx, speciesList);
    if ((wantedKills > 0 && killed >= wantedKills) || (wantedKills === 0 && current.value >= wanted)) {
      return {
        detail: `猎到 ${killed} 只动物，生肉一共 ${current.value} 块${current.parts.length ? `（${current.parts.join('、')}）` : ''}；${cookedNames(ctx, speciesList).join('、')}还要另外用 smelt 加工`,
        status: 'succeeded',
      };
    }
    if (attempts >= MAX_HUNT_ATTACKS) {
      note = '，打了几次都没能打死';
      break;
    }
  }

  const current = countMeat(ctx, speciesList);
  if ((wantedKills > 0 && killed >= wantedKills) || (wantedKills === 0 && current.value >= wanted)) {
    return {
      detail: `猎到 ${killed} 只动物，生肉一共 ${current.value} 块${current.parts.length ? `（${current.parts.join('、')}）` : ''}；${cookedNames(ctx, speciesList).join('、')}还要另外用 smelt 加工`,
      status: 'succeeded',
    };
  }
  if (found === 0) {
    const names = speciesList.map((name) => mobLabel(ctx, name)).join('、');
    const reason = note ? `${note.replace(/^，\s*/, '')}；` : '';
    throw new Error(`${reason}有限安全搜索未能确认附近有可猎的${names}`);
  }
  if (wantedKills > 0) {
    throw new Error(`还差 ${wantedKills - killed} 只动物，只猎到 ${killed} 只${note || ''}`);
  }
  throw new Error(`还差 ${wanted - current.value} 块生肉，只拿到 ${current.value} 块${note || ''}`);
}

// 与烈焰人战斗：保持距离、躲火球、被烧到就后撤。
async function fightBlaze(args, ctx) {
  if (ctx.interrupted) throw new Error('被新的指令打断');
  const wanted = clamp(args.count, 1, 64, 1);
  const radius = clamp(args.radius, 4, 64, 32);
  const minHealth = clamp(args.min_health, 2, 20, 6);
  const deadline = Date.now() + BLAZE_TIMEOUT_MS;

  let rods = ctx.countItem('blaze_rod');
  if (rods >= wanted) {
    return { detail: `背包里已经有 ${rods} 根烈焰棒，够 ${wanted} 根`, status: 'succeeded' };
  }

  let killed = 0;
  let burned = false;
  let engagements = 0;
  let found = 0;
  let searchedSince = Date.now();
  let note = '';

  while (rods < wanted && Date.now() < deadline) {
    if (ctx.interrupted) throw new Error('被新的指令打断');
    const blaze = findEntity(ctx, 'blaze', radius);
    if (!blaze) {
      if (Date.now() - searchedSince > SEARCH_WAIT_MS) {
        note = '，附近没有烈焰人';
        break;
      }
      await ctx.sleep(1000);
      continue;
    }
    searchedSince = Date.now();
    found += 1;

    const outcome = await engageBlaze(ctx, blaze, minHealth, deadline);
    if (ctx.interrupted || outcome.interrupted) throw new Error('被新的指令打断');
    engagements += 1;
    if (outcome.burned) burned = true;
    if (outcome.killed) killed += 1;
    if (outcome.killed && typeof ctx.collectDrops === 'function') {
      await ctx.collectDrops(6, 'blaze_rod');
      if (ctx.interrupted) throw new Error('收集烈焰棒时被新的指令打断');
      if (typeof ctx.syncInventory === 'function') await ctx.syncInventory();
      if (ctx.interrupted) throw new Error('同步烈焰棒背包时被新的指令打断');
    }
    rods = ctx.countItem('blaze_rod');
    if (outcome.retreated) {
      note = `，血量只剩 ${ctx.bot.health}，先撤出来了`;
      break;
    }
    if (!outcome.killed && engagements >= MAX_ENGAGEMENTS) {
      note = '，打了几次都没打死它';
      break;
    }
  }

  if (ctx.interrupted) throw new Error('被新的指令打断');
  rods = ctx.countItem('blaze_rod');
  if (rods >= wanted) {
    return {
      detail: `击败 ${killed} 只烈焰人，烈焰棒一共 ${rods} 根${burned ? '，中途被烧到过' : ''}`,
      status: 'succeeded',
    };
  }
  if (found === 0) {
    throw new Error(`附近 ${radius} 格内没有烈焰人`);
  }
  throw new Error(`还差 ${wanted - rods} 根烈焰棒，只拿到 ${rods} 根${note}`);
}

// 一次烈焰人交战。
async function engageBlaze(ctx, blaze, minHealth, deadline) {
  const bot = ctx.bot;
  const outcome = { killed: false, burned: false, retreated: false, hits: 0 };
  const ranged = ctx.findRangedWeapon();
  let shieldRaised = false;
  let stuck = 0;

  while (Date.now() < deadline && blaze.isValid !== false) {
    if (ctx.interrupted) {
      outcome.interrupted = true;
      break;
    }
    await retreatIfGroupOverwhelms(ctx, blaze, '打烈焰人');
    const incoming = findIncomingProjectile(ctx);
    if (incoming) {
      if (!shieldRaised) {
        shieldRaised = await raiseShield(ctx);
      }
      await dodgeProjectile(ctx, incoming);
      continue;
    }
    if (isBurning(ctx)) {
      outcome.burned = true;
      if (shieldRaised) {
        await lowerShield(ctx);
        shieldRaised = false;
      }
      await ctx.retreatFrom(blaze);
      await ctx.sleep(1500);
      continue;
    }
    if (Number(bot.health ?? 20) <= minHealth) {
      outcome.retreated = true;
      if (shieldRaised) {
        await lowerShield(ctx);
        shieldRaised = false;
      }
      await ctx.retreatFrom(blaze);
      const recovered = await recoverHealth(ctx, minHealth + 6, 20000);
      if (!recovered) break;
      continue;
    }

    const distance = bot.entity.position.distanceTo(blaze.position);
    if (ranged && distance >= BLAZE_RANGED_MIN) {
      if (shieldRaised) {
        await lowerShield(ctx);
        shieldRaised = false;
      }
      if (distance > BLAZE_RANGED_MAX) await ctx.approach(blaze);
      else if (distance < BLAZE_RANGED_MIN) await ctx.retreatFrom(blaze);
      if (ctx.interrupted) {
        outcome.interrupted = true;
        break;
      }
      await retreatIfGroupOverwhelms(ctx, blaze, '打烈焰人');
      if (await ctx.shootAt(blaze)) outcome.hits += 1;
      await ctx.sleep(700);
      continue;
    }

    // 近战贴脸：先把盾放下再挥剑。
    if (shieldRaised) {
      await lowerShield(ctx);
      shieldRaised = false;
    }
    if (distance > MELEE_RANGE) await ctx.approach(blaze);
    if (ctx.interrupted) {
      outcome.interrupted = true;
      break;
    }
    await retreatIfGroupOverwhelms(ctx, blaze, '打烈焰人');
    const reach = bot.entity.position.distanceTo(blaze.position);
    if (reach <= MELEE_REACH) {
      await bot.lookAt(blaze.position.offset(0, entityHeight(blaze) * 0.7, 0), true);
      if (ctx.interrupted) {
        outcome.interrupted = true;
        break;
      }
      await retreatIfGroupOverwhelms(ctx, blaze, '打烈焰人');
      bot.attack(blaze);
      outcome.hits += 1;
      stuck = 0;
    } else {
      // 够不着（悬得太高或被挡住），试多次还是不行就收手。
      stuck += 1;
      if (stuck >= MAX_STUCK_STEPS) break;
    }
    await ctx.sleep(500);
    if (outcome.hits >= MAX_BLAZE_ATTACKS) break;
  }
  if (shieldRaised) await lowerShield(ctx);
  outcome.killed = blaze.isValid === false;
  return outcome;
}

// 猎末影人：只用近战；只兼容服务器插件明确记录的乘载状态。
async function huntEnderman(args, ctx) {
  throwIfInterrupted(ctx, '猎末影人');
  const wanted = clamp(args.count, 1, 64, 1);
  const radius = clamp(args.radius, 4, 64, 48);
  const deadline = Date.now() + ENDERMAN_TIMEOUT_MS;

  let pearls = ctx.countItem('ender_pearl');
  if (pearls >= wanted) {
    return { detail: `背包里已经有 ${pearls} 颗末影珍珠，够 ${wanted} 颗`, status: 'succeeded' };
  }

  const searchState = createCombatSearchState(ctx);
  let killed = 0;
  let grabbed = 0;
  let engagements = 0;
  let found = 0;
  let note = '';

  while (pearls < wanted && Date.now() < deadline) {
    assertCombatSearchHealth(ctx, ENDERMAN_SEARCH_MIN_HEALTH, '猎末影人');
    const enderman = findEntity(ctx, 'enderman', radius);
    if (!enderman) {
      const moved = await moveCombatSearchWaypoint(
        ctx,
        searchState,
        radius,
        ENDERMAN_SEARCH_MIN_HEALTH,
        '猎末影人',
      );
      if (moved === 'reached' || moved === 'unreachable') continue;
      note = '有限安全搜索路线耗尽';
      break;
    }
    found += 1;

    const outcome = await engageEnderman(ctx, enderman, deadline);
    throwIfInterrupted(ctx, '猎末影人');
    engagements += 1;
    if (outcome.grabbed) grabbed += 1;
    if (outcome.killed) {
      killed += 1;
      ctx.log('打死一只末影人');
      await collectItem(ctx, 'ender_pearl');
      throwIfInterrupted(ctx, '收集末影珍珠');
    }
    pearls = ctx.countItem('ender_pearl');
    if (!outcome.killed && engagements >= MAX_ENGAGEMENTS) {
      note = '，末影人一直瞬移，没能打死';
      break;
    }
  }

  pearls = ctx.countItem('ender_pearl');
  if (pearls >= wanted) {
    return {
      detail: `猎到 ${killed} 只末影人，末影珍珠一共 ${pearls} 颗${grabbed ? '，服务器曾报告末影人乘载状态' : ''}`,
      status: 'succeeded',
    };
  }
  if (found === 0) {
    const reason = note ? `（${note.replace(/^，\s*/, '')}）` : '';
    throw new Error(`有限安全搜索未能确认附近有末影人${reason}`);
  }
  const extra = grabbed ? '，服务器曾报告末影人乘载状态' : '';
  throw new Error(`还差 ${wanted - pearls} 颗末影珍珠，只拿到 ${pearls} 颗${note}${extra}`);
}

// 一次末影人交战。投射物会被末影人瞬移躲开，因此只用近战。
async function engageEnderman(ctx, enderman, deadline) {
  const bot = ctx.bot;
  const outcome = { killed: false, grabbed: false, hits: 0 };
  let stuck = 0;

  while (Date.now() < deadline && enderman.isValid !== false) {
    assertCombatSearchHealth(ctx, ENDERMAN_SEARCH_MIN_HEALTH, '猎末影人');
    await retreatIfGroupOverwhelms(ctx, enderman, '猎末影人');
    if (isGrabbedByEnderman(ctx, enderman)) {
      outcome.grabbed = true;
      ctx.log('服务器报告末影人乘载状态，先尝试脱离');
      await releaseFromEnderman(ctx, enderman);
      throwIfInterrupted(ctx, '猎末影人');
      continue;
    }
    const distance = bot.entity.position.distanceTo(enderman.position);

    if (distance > MELEE_RANGE) {
      await ctx.approach(enderman);
      throwIfInterrupted(ctx, '猎末影人');
      assertCombatSearchHealth(ctx, ENDERMAN_SEARCH_MIN_HEALTH, '猎末影人');
      await retreatIfGroupOverwhelms(ctx, enderman, '猎末影人');
    }
    const reach = bot.entity.position.distanceTo(enderman.position);
    if (reach <= MELEE_REACH) {
      await bot.lookAt(enderman.position.offset(0, entityHeight(enderman) * 0.7, 0), true);
      throwIfInterrupted(ctx, '猎末影人');
      assertCombatSearchHealth(ctx, ENDERMAN_SEARCH_MIN_HEALTH, '猎末影人');
      await retreatIfGroupOverwhelms(ctx, enderman, '猎末影人');
      bot.attack(enderman);
      outcome.hits += 1;
      if (outcome.hits >= MAX_ENDERMAN_ATTACKS) break;
      stuck = 0;
      await ctx.sleep(400);
      throwIfInterrupted(ctx, '猎末影人');
      continue;
    }
    stuck += 1;
    if (stuck >= MAX_STUCK_STEPS) break;
    await ctx.sleep(300);
  }
  outcome.killed = enderman.isValid === false;
  return outcome;
}

// 被抓住时打它，它会松手。
async function releaseFromEnderman(ctx, enderman) {
  const bot = ctx.bot;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    throwIfInterrupted(ctx, '打末影人脱身');
    if (enderman.isValid === false) return true;
    if (!isGrabbedByEnderman(ctx, enderman)) return true;
    await retreatIfGroupOverwhelms(ctx, enderman, '打末影人脱身');
    try {
      await bot.lookAt(enderman.position.offset(0, entityHeight(enderman) * 0.7, 0), true);
      throwIfInterrupted(ctx, '打末影人脱身');
      bot.attack(enderman);
    } catch (error) {
      throwIfInterrupted(ctx, '打末影人脱身');
      ctx.log('打末影人脱身失败', error.message);
    }
    await ctx.sleep(350);
    throwIfInterrupted(ctx, '打末影人脱身');
  }
  let movementStarted = false;
  try {
    bot.setControlState('forward', true);
    movementStarted = true;
    await ctx.sleep(600);
    throwIfInterrupted(ctx, '打末影人脱身');
  } catch (error) {
    throwIfInterrupted(ctx, '打末影人脱身');
    ctx.log('走动脱身失败', error.message);
  } finally {
    if (movementStarted) bot.setControlState('forward', false);
  }
  return !isGrabbedByEnderman(ctx, enderman);
}

// 逐个打碎末地水晶：先退到安全距离，射完躲开爆炸，再留安全间隔。
async function breakCrystal(args, ctx) {
  throwIfInterrupted(ctx, '清除末地水晶');
  const rawCount = Number(args.count);
  const limit = Number.isFinite(rawCount) && rawCount > 0 ? Math.min(Math.trunc(rawCount), 64) : 0;
  const radius = clamp(args.radius, 8, 128, 64);
  const safeDistance = clamp(args.safe_distance, 4, 32, 9);
  const interval = clamp(args.interval, 1000, 20000, 4000);
  const deadline = Date.now() + CRYSTAL_TIMEOUT_MS;

  const crystals = findCrystals(ctx, radius);
  if (crystals.length === 0) {
    throw new Error('附近没有末地水晶');
  }
  if (!ctx.findRangedWeapon()) {
    throw new Error('没有弓，不能远程破坏末地水晶');
  }

  const list = limit > 0 ? crystals.slice(0, limit) : crystals;
  const dimension = ctx.bot.game?.dimension;
  if (ctx.bot.world?.raycast) {
    const visible = new Set();
    for (const crystal of list) {
      await ctx.sleep(0);
      throwIfInterrupted(ctx, '选择可见水晶');
      if (visibleCrystalAim(ctx.bot, crystal)) visible.add(crystal);
    }
    list.sort((a,b) => Number(visible.has(b)) - Number(visible.has(a)));
  }
  let broken = 0;
  let hurt = 0;
  const notes = [];

  for (const crystal of list) {
    throwIfInterrupted(ctx, '清除末地水晶');
    if (ctx.bot.game?.dimension !== dimension) throw new Error('清除水晶期间已切换维度');
    if (Date.now() > deadline) {
      notes.push('时间不够');
      break;
    }
    if (crystal.isValid === false) continue;
    const startHealth = Number(ctx.bot.health ?? 20);

    // 太近就先退到安全距离，避免被水晶的爆炸直接炸死。
    const danger = blastDanger(crystal.position, ctx.bot.entity.position);
    if (danger.distance < safeDistance) {
      await moveAwayFrom(ctx, crystal.position, safeDistance + 4);
    }
    throwIfInterrupted(ctx, '清除末地水晶');
    let shot = await shootCrystal(ctx, crystal);
    if (!shot && ctx.walkOnce && ctx.bot.world?.raycast && Date.now() < deadline) {
      if (await reachCrystalVantage(ctx, crystal, deadline)) shot = await shootCrystal(ctx, crystal);
    }
    throwIfInterrupted(ctx, '清除末地水晶');
    if (!shot) {
      notes.push('弓射失败');
      continue;
    }
    const gone = await waitCrystalGone(ctx, crystal, 6000);
    throwIfInterrupted(ctx, '清除末地水晶');
    if (ctx.bot.game?.dimension !== dimension) throw new Error('清除水晶期间已切换维度');
    if (gone) {
      broken += 1;
    } else {
      notes.push('射击后仍能观察到水晶');
    }

    const endHealth = Number(ctx.bot.health ?? 20);
    if (endHealth < startHealth) hurt += startHealth - endHealth;

    // 躲开爆炸，再等一段安全间隔再打下一个。
    if (distance3(crystal.position, ctx.bot.entity.position) < safeDistance) {
      await moveAwayFrom(ctx, crystal.position, safeDistance + 4);
    }
    throwIfInterrupted(ctx, '清除末地水晶');
    if (Number(ctx.bot.health ?? 20) <= 8) {
      await recoverHealth(ctx, 12, 20000);
      throwIfInterrupted(ctx, '清除末地水晶');
    }
    await ctx.sleep(interval);
    throwIfInterrupted(ctx, '清除末地水晶');
  }

  throwIfInterrupted(ctx, '清除末地水晶');
  if (broken <= 0) {
    throw new Error(
      `附近 ${radius} 格内有 ${list.length} 个末地水晶，一个都没打碎${notes.length ? `（${notes.join('、')}）` : ''}`
    );
  }
  const left = list.filter(crystal => crystal.isValid !== false).length;
  if (left > 0) {
    const error = new Error(`还差 ${left} 个末地水晶，只打碎了 ${broken} 个${notes.length ? `（${notes.join('、')}）` : ''}`);
    error.data = { crystal_progress: { broken, remaining_visible: left } };
    throw error;
  }
  return {
    detail: `用弓打碎了 ${broken} 个末地水晶${hurt > 0 ? `，被爆炸炸掉 ${hurt} 点血` : '，没被炸到'}`,
    status: 'succeeded',
  };
}

// 根据 Java 版箭矢逐 tick 的空气阻力和下落量，求满弓时能到达静止水晶的低角度。
export function crystalAimPoint(bot, crystal, target = crystal.position.offset(0, entityHeight(crystal) * 0.5, 0), eye = bot.entity.position) {
  const eyeY = eye.y + (bot.entity.eyeHeight ?? 1.62) - 0.1;
  const horizontal = Math.hypot(target.x - eye.x, target.z - eye.z);
  const rangeAt = ticks => (1 - 0.99 ** ticks) / 0.01;
  const dropAt = ticks => 5 * (ticks - rangeAt(ticks));
  const speedAt = ticks => Math.hypot(horizontal, target.y - eyeY + dropAt(ticks)) / rangeAt(ticks);
  for (let tick = 1; tick <= 100; tick++) {
    if (speedAt(tick) > 3) continue;
    let low = tick - 1, high = tick;
    for (let i = 0; i < 8; i++) {
      const mid = (low + high) / 2;
      if (speedAt(mid) > 3) low = mid;
      else high = mid;
    }
    return crystal.position.offset(target.x - crystal.position.x, target.y - crystal.position.y + dropAt(high) + 0.1, target.z - crystal.position.z);
  }
  return null;
}

// 一次运动与水晶碰撞箱的首次交点，用同一段内的距离比较先碰方块还是实体。
function crystalEntry(position, velocity, center) {
  let enter = 0, leave = 1;
  for (const axis of ['x', 'y', 'z']) {
    const min = center[axis] - (axis === 'y' ? 0 : 0.95);
    const max = center[axis] + (axis === 'y' ? 2 : 0.95);
    if (Math.abs(velocity[axis]) < 1e-9) {
      if (position[axis] < min || position[axis] > max) return null;
      continue;
    }
    const a = (min - position[axis]) / velocity[axis], b = (max - position[axis]) / velocity[axis];
    enter = Math.max(enter, Math.min(a, b));
    leave = Math.min(leave, Math.max(a, b));
    if (enter > leave) return null;
  }
  return enter;
}

export function visibleCrystalAim(bot, crystal, feet = bot.entity.position) {
  if (!bot.world?.raycast) return crystalAimPoint(bot, crystal);
  const eye = feet.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
  // 水晶碰撞箱宽 2 格，高 2 格。从中心和上缘选一个能先碰到水晶的角度。
  const edgeX = Math.sign(eye.x - crystal.position.x) * 0.85, edgeZ = Math.sign(eye.z - crystal.position.z) * 0.85;
  for (const [dx, dy, dz] of [[0,1,0], [edgeX,0.25,edgeZ], [edgeX,1.8,edgeZ], [0,1.8,0], [0.7,1.7,0], [-0.7,1.7,0], [0,1.7,0.7], [0,1.7,-0.7]]) {
    const target = crystal.position.offset(dx, dy, dz);
    const aim = crystalAimPoint(bot, crystal, target, feet);
    if (!aim) continue;
    let p = eye.offset(0,-0.1,0), velocity = aim.minus(eye).normalize().scaled(3);
    for (let tick = 0; tick < 100; tick++) {
      const length = velocity.norm(), direction = velocity.scaled(1 / length);
      const entry = crystalEntry(p, velocity, crystal.position);
      const range = (entry ?? 1) * length;
      const blocked = bot.world.raycast(p, direction, range, (block, iterator) => {
        const hit = iterator.intersect(block.shapes, block.position);
        if (!hit) return false;
        const along = hit.pos.minus(p).dot(direction);
        return along >= 0 && along <= range;
      });
      if (blocked) break;
      if (entry !== null) return aim;
      p = p.plus(velocity);
      if (velocity.y < 0 && p.y < target.y - 2) break;
      velocity = velocity.scaled(0.99).offset(0,-0.05,0);
    }
  }
  return null;
}

async function reachCrystalVantage(ctx, crystal, deadline) {
  const bot = ctx.bot, origin = bot.entity.position.floored();
  const columns = [];
  const base = crystal.position.floored();
  const caged = [[2,0],[-2,0],[0,2],[0,-2]].some(([dx,dz]) => bot.blockAt(base.offset(dx,0,dz))?.name === 'iron_bars');
  if (caged) {
    for (const gap of [3,4,5,6,8,10,12]) {
      for (const [dx,dz] of [[1,1],[-1,1],[1,-1],[-1,-1]]) columns.push(base.offset(dx * gap, origin.y - base.y, dz * gap));
    }
  }
  for (const radius of [12,24,36]) {
    for (const [dx,dz] of [[-1,0],[0,-1],[0,1],[1,0],[-0.7,-0.7],[-0.7,0.7],[0.7,-0.7],[0.7,0.7]]) {
      columns.push(origin.offset(Math.round(radius * dx), 0, Math.round(radius * dz)));
    }
  }
  columns.sort((a,b) => a.distanceTo(origin) - b.distanceTo(origin));
  for (const column of columns) {
    await ctx.sleep(0);
    throwIfInterrupted(ctx, '寻找能射到水晶的落脚点');
    if (Date.now() >= deadline) return false;
    if (Math.hypot(column.x, column.z) > 70) continue;
    for (let y = 6; y >= -6; y--) {
      const stand = column.offset(0, y, 0);
      if (bot.blockAt(stand.offset(0, -1, 0))?.name !== 'end_stone' || !dryMiningFooting(bot, stand)) continue;
      const feet = stand.offset(0.5, 0, 0.5);
      if (feet.distanceTo(crystal.position) < 15 || !visibleCrystalAim(bot, crystal, feet)) break;
      await ctx.walkOnce(stand.x, stand.y, stand.z, 0, Math.min(8000, Math.max(1, deadline - Date.now())));
      if (visibleCrystalAim(bot, crystal)) return true;
      break;
    }
  }
  return false;
}

async function shootCrystal(ctx, crystal) {
  throwIfInterrupted(ctx, '射击末地水晶');
  const bot = ctx.bot;
  const ranged = ctx.findRangedWeapon();
  if (!ranged) return false;
  try {
    await bot.equip(ranged.bow, 'hand');
    throwIfInterrupted(ctx, '射击末地水晶');
    const aim = ranged.bow.name === 'bow' ? visibleCrystalAim(bot, crystal) : crystal.position.offset(0, entityHeight(crystal) * 0.5, 0);
    if (!aim) return false;
    await bot.lookAt(aim, true);
    throwIfInterrupted(ctx, '射击末地水晶');
    bot.activateItem();
    try {
      await ctx.sleep(ranged.bow.name === 'crossbow' ? 1250 : 1100);
    } finally {
      bot.deactivateItem();
    }
    throwIfInterrupted(ctx, '射击末地水晶');
    return true;
  } catch (error) {
    throwIfInterrupted(ctx, '射击末地水晶');
    ctx.log('射水晶失败', error.message);
    return false;
  }
}

// 等水晶炸掉（实体被销毁）。
async function waitCrystalGone(ctx, crystal, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfInterrupted(ctx, '等待水晶爆炸');
    if (crystal.isValid === false) return true;
    await ctx.sleep(200);
  }
  throwIfInterrupted(ctx, '等待水晶爆炸');
  return crystal.isValid === false;
}

// 装备盾牌并进入格挡姿态。
async function equipShieldSkill(args, ctx) {
  const keep = args.keep === false ? false : true;
  const shield = await equipShield(ctx);
  if (!shield) {
    throw new Error('背包里没有盾，先做一面盾再格挡');
  }
  const offHand = ctx.bot.inventory.slots[45];
  const inOffHand = Boolean(offHand && offHand.name === 'shield');
  const inHand = Boolean(ctx.bot.heldItem && ctx.bot.heldItem.name === 'shield');
  if (!inOffHand && !inHand) {
    throw new Error('盾没有装上，背包里也找不到多余的盾');
  }
  const raised = await raiseShield(ctx);
  if (keep && !raised) {
    throw new Error('盾已经装上，但举盾动作没有生效');
  }
  if (!keep) await lowerShield(ctx);
  const where = inOffHand ? '副手' : '主手';
  return {
    detail: `已把盾装到${where}并${keep ? '举起格挡' : '装好备用'}${ctx.bot.usingHeldItem ? '（格挡中）' : ''}`,
    status: 'succeeded',
  };
}

export const skills = {
  shear_sheep: {
    description:
      '用剪刀从成年且未剪过的羊身上剪取同色羊毛；逐只验证背包增量，按需靠近并跳过幼羊和已剪过的羊。',
    parameters: [
      { name: 'count', type: 'number', required: false, default: 3, description: '目标颜色羊毛总数，范围 1-16。' },
      { name: 'radius', type: 'number', required: false, default: 48, minimum: 4, maximum: 96, description: '搜索羊的半径，范围 4-96 格。' },
      { name: 'color', type: 'string', required: false, default: 'auto', description: '羊毛颜色；auto 会优先补齐背包已有颜色，否则选择附近数量最多的颜色。' },
    ],
    handler: shearSheep,
  },
  hunt_animal: {
    description:
      '狩猎牛、猪、羊等被动生物拿生肉：追到近战距离挥剑，等它掉落肉再走过去捡；血量太低会撤退，天快黑会先提醒回去。',
    parameters: [
      { name: 'count', type: 'number', required: false, default: 1, description: '需要多少块生肉。' },
      { name: 'min_kills', type: 'number', required: false, default: 0, description: '至少击杀多少只目标动物；大于 0 时按击杀数收手。' },
      { name: 'walk_only', type: 'boolean', required: false, default: false, description: '缺粮时步行就近搜索，禁用疾跑、跑酷和开挖。' },
      { name: 'nearby_only', type: 'boolean', required: false, default: false, description: '只步行接近附近干地上已感知的猎物，附近无目标时立即返回。' },
      { name: 'species', type: 'string', required: false, default: null, description: '指定生物，例如 cow、pig、sheep。' },
      { name: 'exclude_species', type: 'array', required: false, default: [], description: '排除的生物名称，避免猎取羊等保留资源。' },
      { name: 'radius', type: 'number', required: false, default: 32, description: '搜索半径。' },
      { name: 'min_health', type: 'number', required: false, default: 8, description: '血量低于这个值就撤退。' },
    ],
    handler: huntAnimal,
  },
  hunt_material: {
    description:
      '有限猎取成年羊、鸡或蜘蛛来收集同色羊毛、羽毛或线；会移动搜索、拾取并核对背包。',
    parameters: [
      { name: 'item', type: 'string', required: true, enum: ['wool', 'feather', 'string'], description: '目标材料：wool（成年未剪毛羊，同色）、feather（鸡）或 string（蜘蛛）。' },
      { name: 'count', type: 'number', required: false, default: 1, description: '需要的材料数量，范围 1-32。' },
      { name: 'radius', type: 'number', required: false, default: 48, description: '目标生物搜索半径，范围 4-64 格。' },
      { name: 'min_health', type: 'number', required: false, default: 10, description: '血量不高于此值时停止猎取。' },
    ],
    handler: huntMaterial,
  },
  fight_blaze: {
    description:
      '与烈焰人战斗：保持距离、来袭火球就横移躲开、被烧到就后撤，优先用弓打，没有弓就贴脸砍并用盾挡。',
    parameters: [
      { name: 'count', type: 'number', required: false, default: 1, description: '需要多少根烈焰棒。' },
      { name: 'radius', type: 'number', required: false, default: 32, description: '搜索半径。' },
      { name: 'min_health', type: 'number', required: false, default: 6, description: '血量低于这个值就撤退。' },
    ],
    handler: fightBlaze,
  },
  hunt_enderman: {
    description:
      '猎取末影人拿末影珍珠：使用近战攻击，逐轮评估周围威胁并在压力过高时撤退；投射物会被末影人瞬移躲开，结束后核验背包数量。',
    parameters: [
      { name: 'count', type: 'number', required: false, default: 1, description: '需要多少颗末影珍珠。' },
      { name: 'radius', type: 'number', required: false, default: 48, description: '搜索半径。' },
    ],
    handler: huntEnderman,
  },
  break_crystal: {
    description:
      '用弓逐个打碎末地水晶：先退到安全距离再射，打碎一个就躲开爆炸并留出安全间隔，避免被连环爆炸。',
    parameters: [
      { name: 'count', type: 'number', required: false, default: 0, description: '最多打碎几个，0 表示全部。' },
      { name: 'radius', type: 'number', required: false, default: 64, description: '搜索半径。' },
      { name: 'safe_distance', type: 'number', required: false, default: 9, description: '射击时与水晶保持的安全距离。' },
      { name: 'interval', type: 'number', required: false, default: 4000, description: '两个水晶之间的安全间隔毫秒数。' },
    ],
    handler: breakCrystal,
  },
  equip_shield: {
    description: '把背包里的盾装到副手并举起格挡；背包里没有盾就直接报错。',
    parameters: [
      { name: 'keep', type: 'boolean', required: false, default: true, description: '是否保持举盾姿态。' },
    ],
    handler: equipShieldSkill,
  },
};
