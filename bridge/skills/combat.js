// 战斗技能模块：狩猎被动生物、与烈焰人交战、猎取末影人、破坏末地水晶、举盾格挡。
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
const BLAZE_TIMEOUT_MS = 180000;
const ENDERMAN_TIMEOUT_MS = 180000;
const CRYSTAL_TIMEOUT_MS = 180000;
// 搜索不到目标时最多空等的时长，超过就按失败收尾。
const SEARCH_WAIT_MS = 20000;
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
};
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
function findHuntable(ctx, speciesList, radius) {
  const bot = ctx.bot;
  const origin = bot.entity.position;
  const candidates = [];
  for (const entity of Object.values(bot.entities || {})) {
    if (!entity || !entity.position) continue;
    if (!speciesList.includes(entity.name)) continue;
    if (entity.type === 'player') continue;
    const distance = origin.distanceTo(entity.position);
    if (distance > radius) continue;
    candidates.push({ name: entity.name, entity, position: entity.position, distance });
  }
  const picked = pickHuntTarget(candidates, origin);
  return picked ? picked.entity : null;
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

// 末影人是否站在水边：它在水里不会瞬移，可以放心贴脸砍。
function nearWater(ctx, entity) {
  const bot = ctx.bot;
  const position = entity.position;
  const spots = [
    position,
    position.offset(1, 0, 0),
    position.offset(-1, 0, 0),
    position.offset(0, 0, 1),
    position.offset(0, 0, -1),
  ];
  for (const spot of spots) {
    let block = null;
    try {
      block = bot.blockAt(spot);
    } catch (error) {
      continue;
    }
    if (block && ctx.blockIsWater(block)) return true;
  }
  return false;
}

// 附近有没有水源，用来判断能不能把末影人引到水边打。
function waterNearby(ctx, radius) {
  const bot = ctx.bot;
  const origin = bot.entity.position;
  for (let distance = 2; distance <= radius; distance += 2) {
    for (let step = 0; step < 8; step += 1) {
      const angle = (Math.PI * 2 * step) / 8;
      const x = Math.floor(origin.x + Math.cos(angle) * distance);
      const z = Math.floor(origin.z + Math.sin(angle) * distance);
      for (let dy = -3; dy <= 1; dy += 1) {
        let block = null;
        try {
          block = bot.blockAt({ x, y: Math.floor(origin.y) + dy, z });
        } catch (error) {
          continue;
        }
        if (block && ctx.blockIsWater(block)) {
          return { x, y: Math.floor(origin.y) + dy, z };
        }
      }
    }
  }
  return null;
}

// 被末影人抓起：身体悬空且末影人就在旁边。
function isGrabbedByEnderman(ctx, enderman) {
  const bot = ctx.bot;
  const position = bot.entity.position;
  const target = enderman || findEntity(ctx, 'enderman', 3);
  if (!target) return false;
  let solidBelow = false;
  let solidInside = false;
  try {
    const below = bot.blockAt(position.offset(0, -1, 0));
    solidBelow = Boolean(below && below.boundingBox === 'block');
    const inside = bot.blockAt(position);
    solidInside = Boolean(inside && inside.boundingBox === 'block');
  } catch (error) {
    return false;
  }
  if (solidBelow || solidInside) return false;
  return position.y >= target.position.y - 1;
}

// 血量恢复：等自然回血。ctx 没有 waitForHealth，这里自己等。
async function waitHealth(ctx, minHealth, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (Number(ctx.bot.health ?? 20) >= minHealth) return true;
    await ctx.sleep(500);
  }
  return Number(ctx.bot.health ?? 20) >= minHealth;
}

// 血量低时先吃点东西再等恢复。
async function recoverHealth(ctx, minHealth, timeoutMs) {
  if (typeof ctx.eatFood === 'function' && Number(ctx.bot.food ?? 20) < 20) {
    try {
      await ctx.eatFood({ count: 2 });
    } catch (error) {
      ctx.log('回血时吃东西失败', error.message);
    }
  }
  return waitHealth(ctx, minHealth, timeoutMs);
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
  const wanted = clamp(args.count, 1, 64, 1);
  const wantedKills = Math.trunc(clamp(args.min_kills, 0, 64, 0));
  const radius = clamp(args.radius, 4, 64, 32);
  const minHealth = clamp(args.min_health, 2, 20, 8);
  const species = String(args.species || '').trim().toLowerCase();
  let speciesList = HUNTABLE;
  if (species) {
    if (!HUNTABLE.includes(species)) {
      throw new Error(`附近没有能狩猎的 ${species}，能打的是 ${HUNTABLE.join('、')}`);
    }
    speciesList = [species];
  }

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

  while (Date.now() < deadline) {
    const daylight = daylightLeft(ctx.bot.time);
    if (daylight !== null && daylight < 2000) {
      note = `，天快黑了（第 ${ctx.bot.time.day ?? '?'} 天），先回去`;
      break;
    }
    const target = findHuntable(ctx, speciesList, radius);
    if (!target) {
      if (Date.now() - searchedSince > SEARCH_WAIT_MS) {
        note = '，附近没有可以狩猎的动物';
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
    if (chased === 'gone') continue;
    if (chased === 'failed') {
      ctx.log('追不上目标', label);
      await ctx.sleep(500);
      continue;
    }

    await ctx.attackEntity(target);
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
    throw new Error(`附近没有可以狩猎的${names}`);
  }
  if (wantedKills > 0) {
    throw new Error(`还差 ${wantedKills - killed} 只动物，只猎到 ${killed} 只${note || ''}`);
  }
  throw new Error(`还差 ${wanted - current.value} 块生肉，只拿到 ${current.value} 块${note || ''}`);
}

// 与烈焰人战斗：保持距离、躲火球、被烧到就后撤。
async function fightBlaze(args, ctx) {
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
    engagements += 1;
    if (outcome.burned) burned = true;
    if (outcome.killed) killed += 1;
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
    const reach = bot.entity.position.distanceTo(blaze.position);
    if (reach <= MELEE_REACH) {
      await bot.lookAt(blaze.position.offset(0, entityHeight(blaze) * 0.7, 0), true);
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

// 猎末影人：贴身补刀拿珍珠，被抓住先脱身。
async function huntEnderman(args, ctx) {
  const wanted = clamp(args.count, 1, 64, 1);
  const radius = clamp(args.radius, 4, 64, 48);
  const deadline = Date.now() + ENDERMAN_TIMEOUT_MS;

  let pearls = ctx.countItem('ender_pearl');
  if (pearls >= wanted) {
    return { detail: `背包里已经有 ${pearls} 颗末影珍珠，够 ${wanted} 颗`, status: 'succeeded' };
  }

  const water = waterNearby(ctx, 16);
  let killed = 0;
  let grabbed = 0;
  let engagements = 0;
  let found = 0;
  let searchedSince = Date.now();
  let note = '';

  while (pearls < wanted && Date.now() < deadline) {
    const enderman = findEntity(ctx, 'enderman', radius);
    if (!enderman) {
      if (Date.now() - searchedSince > SEARCH_WAIT_MS) {
        note = '，附近没有末影人';
        break;
      }
      await ctx.sleep(1000);
      continue;
    }
    searchedSince = Date.now();
    found += 1;

    const outcome = await engageEnderman(ctx, enderman, water, deadline);
    engagements += 1;
    if (outcome.grabbed) grabbed += 1;
    if (outcome.killed) {
      killed += 1;
      ctx.log('打死一只末影人');
      await collectItem(ctx, 'ender_pearl');
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
      detail: `猎到 ${killed} 只末影人，末影珍珠一共 ${pearls} 颗${grabbed ? '，被抓起来过' : ''}`,
      status: 'succeeded',
    };
  }
  if (found === 0) {
    throw new Error(`附近 ${radius} 格内没有末影人`);
  }
  const extra = grabbed ? '，被末影人抓起来过' : water ? '' : '，附近没有水源，只能硬追';
  throw new Error(`还差 ${wanted - pearls} 颗末影珍珠，只拿到 ${pearls} 颗${note}${extra}`);
}

// 一次末影人交战。它在水里不会瞬移，此时可以放心连砍。
async function engageEnderman(ctx, enderman, waterEdge, deadline) {
  const bot = ctx.bot;
  const outcome = { killed: false, grabbed: false, hits: 0, shots: 0 };
  const ranged = ctx.findRangedWeapon();
  let waited = 0;
  let stuck = 0;

  while (Date.now() < deadline && enderman.isValid !== false) {
    if (isGrabbedByEnderman(ctx, enderman)) {
      outcome.grabbed = true;
      ctx.log('被末影人抓起来了，先打它脱身');
      await releaseFromEnderman(ctx, enderman);
      continue;
    }
    const distance = bot.entity.position.distanceTo(enderman.position);
    const inWater = nearWater(ctx, enderman);

    // 有水源就守在水边，等它靠近；它进水里就不会瞬移。
    if (waterEdge && !inWater && distance > MELEE_RANGE + 2 && waited < 20) {
      const edgeDistance = Math.hypot(
        bot.entity.position.x - waterEdge.x,
        bot.entity.position.z - waterEdge.z
      );
      if (edgeDistance > 3) await moveTo(ctx, waterEdge, 2);
      waited += 1;
      await ctx.sleep(500);
      continue;
    }

    // 够不着又追不上时用弓压制，但不让它把箭全耗光。
    if (ranged && !inWater && distance > 8 && outcome.shots < 6) {
      if (await ctx.shootAt(enderman)) outcome.shots += 1;
      await ctx.sleep(500);
      continue;
    }

    if (distance > MELEE_RANGE) await ctx.approach(enderman);
    const reach = bot.entity.position.distanceTo(enderman.position);
    if (reach <= MELEE_REACH) {
      await bot.lookAt(enderman.position.offset(0, entityHeight(enderman) * 0.7, 0), true);
      bot.attack(enderman);
      outcome.hits += 1;
      if (outcome.hits >= MAX_ENDERMAN_ATTACKS) break;
      stuck = 0;
      await ctx.sleep(400);
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
    if (enderman.isValid === false) return true;
    if (!isGrabbedByEnderman(ctx, enderman)) return true;
    try {
      await bot.lookAt(enderman.position.offset(0, entityHeight(enderman) * 0.7, 0), true);
      bot.attack(enderman);
    } catch (error) {
      ctx.log('打末影人脱身失败', error.message);
    }
    await ctx.sleep(350);
  }
  try {
    bot.setControlState('forward', true);
    await ctx.sleep(600);
    bot.setControlState('forward', false);
  } catch (error) {
    ctx.log('走动脱身失败', error.message);
  }
  return !isGrabbedByEnderman(ctx, enderman);
}

// 逐个打碎末地水晶：先退到安全距离，射完躲开爆炸，再留安全间隔。
async function breakCrystal(args, ctx) {
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
  let broken = 0;
  let failed = 0;
  let hurt = 0;
  const notes = [];

  for (const crystal of list) {
    if (Date.now() > deadline) {
      notes.push('时间不够');
      failed += 1;
      break;
    }
    if (crystal.isValid === false) continue;
    const startHealth = Number(ctx.bot.health ?? 20);

    // 太近就先退到安全距离，避免被水晶的爆炸直接炸死。
    const danger = blastDanger(crystal.position, ctx.bot.entity.position);
    if (danger.distance < safeDistance) {
      await moveAwayFrom(ctx, crystal.position, safeDistance + 4);
    }
    const shot = await shootCrystal(ctx, crystal);
    if (!shot) {
      failed += 1;
      notes.push('弓射失败');
      continue;
    }
    const gone = await waitCrystalGone(ctx, crystal, 6000);
    if (gone) {
      broken += 1;
    } else {
      failed += 1;
      notes.push('水晶没碎，可能被玻璃挡住');
    }

    const endHealth = Number(ctx.bot.health ?? 20);
    if (endHealth < startHealth) hurt += startHealth - endHealth;

    // 躲开爆炸，再等一段安全间隔再打下一个。
    await moveAwayFrom(ctx, crystal.position, safeDistance + 4);
    if (Number(ctx.bot.health ?? 20) <= 8) {
      await recoverHealth(ctx, 12, 20000);
    }
    await ctx.sleep(interval);
  }

  if (broken <= 0) {
    throw new Error(
      `附近 ${radius} 格内有 ${list.length} 个末地水晶，一个都没打碎${notes.length ? `（${notes.join('、')}）` : ''}`
    );
  }
  const left = list.length - broken - failed;
  if (left > 0) {
    throw new Error(
      `还差 ${left} 个末地水晶，只打碎了 ${broken} 个${notes.length ? `（${notes.join('、')}）` : ''}`
    );
  }
  return {
    detail: `用弓打碎了 ${broken} 个末地水晶${hurt > 0 ? `，被爆炸炸掉 ${hurt} 点血` : '，没被炸到'}`,
    status: 'succeeded',
  };
}

// 射水晶：瞄准点自己算，避免服务端没给 height 时算出 NaN 坐标。
async function shootCrystal(ctx, crystal) {
  const bot = ctx.bot;
  const ranged = ctx.findRangedWeapon();
  if (!ranged) return false;
  try {
    await bot.equip(ranged.bow, 'hand');
    const aim = crystal.position.offset(0, entityHeight(crystal) * 0.5, 0);
    await bot.lookAt(aim, true);
    bot.activateItem();
    await ctx.sleep(ranged.bow.name === 'crossbow' ? 1250 : 900);
    bot.deactivateItem();
    return true;
  } catch (error) {
    ctx.log('射水晶失败', error.message);
    return false;
  }
}

// 等水晶炸掉（实体被销毁）。
async function waitCrystalGone(ctx, crystal, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (crystal.isValid === false) return true;
    await ctx.sleep(200);
  }
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
  hunt_animal: {
    description:
      '狩猎牛、猪、羊等被动生物拿生肉：追到近战距离挥剑，等它掉落肉再走过去捡；血量太低会撤退，天快黑会先提醒回去。',
    parameters: [
      { name: 'count', type: 'number', required: false, default: 1, description: '需要多少块生肉。' },
      { name: 'min_kills', type: 'number', required: false, default: 0, description: '至少击杀多少只目标动物；大于 0 时按击杀数收手。' },
      { name: 'species', type: 'string', required: false, default: null, description: '指定生物，例如 cow、pig、sheep。' },
      { name: 'radius', type: 'number', required: false, default: 32, description: '搜索半径。' },
      { name: 'min_health', type: 'number', required: false, default: 8, description: '血量低于这个值就撤退。' },
    ],
    handler: huntAnimal,
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
      '猎取末影人拿末影珍珠：末影人会瞬移，被抓住就先打它脱身，在水边或下雨时贴脸快砍，优先近战补最后一刀。',
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
