// 生存模块：进食、封闭庇护所、安全过夜、低血撤退、落水自救。
// 契约见 docs/plans/SKILL_MODULE_CONTRACT.md，ctx 由 minecraft_bridge.js 的 buildSkillContext() 提供。
// 本模块只使用 ctx 上的能力，不 import 任何运行时依赖；ctx 里没有的可选能力一律 typeof 判断后再调用。

import { shaftFlowBarrier, shallowSurfaceExit, waterLike } from '../water_escape.js';

/* ============================ 纯逻辑：可以单独测试 ============================ */

// 食物优先级：熟肉 > 生肉 > 面包 > 任何其它有 food 值的物品。
const COOKED_MEATS = new Set([
  'cooked_beef',
  'cooked_porkchop',
  'cooked_chicken',
  'cooked_mutton',
  'cooked_rabbit',
  'cooked_cod',
  'cooked_salmon',
]);
const RAW_MEATS = new Set([
  'beef',
  'porkchop',
  'chicken',
  'mutton',
  'rabbit',
  'cod',
  'salmon',
]);
const BREAD_LIKE = new Set([
  'bread',
  'baked_potato',
  'cookie',
  'cake',
  'mushroom_stew',
  'suspicious_stew',
  'rabbit_stew',
  'beetroot_soup',
]);
// 有 food 值但会中毒或难以下咽的，直接排除。
const TOXIC_FOODS = new Set([
  'raw_chicken',
  'pufferfish',
  'rotten_flesh',
  'poisonous_potato',
  'spider_eye',
  'chorus_fruit',
]);
// 金苹果很贵，自动进食不主动吃，只有显式点名才用。
const GOLDEN_FOODS = new Set(['golden_apple', 'enchanted_golden_apple']);
// registry 不可用时的兜底 food 值表。
const FALLBACK_FOOD_POINTS = {
  bread: 5,
  baked_potato: 5,
  cookie: 2,
  cake: 14,
  apple: 4,
  carrot: 3,
  golden_apple: 4,
  melon_slice: 2,
  sweet_berries: 2,
  beetroot: 1,
  potato: 1,
  cooked_beef: 8,
  beef: 3,
  cooked_porkchop: 8,
  porkchop: 3,
  cooked_chicken: 6,
  chicken: 2,
  cooked_mutton: 6,
  mutton: 2,
  cooked_rabbit: 5,
  rabbit: 3,
  cooked_cod: 5,
  cod: 2,
  cooked_salmon: 6,
  salmon: 2,
  mushroom_stew: 6,
  rabbit_stew: 5,
  beetroot_soup: 6,
  suspicious_stew: 4,
  rotten_flesh: 4,
  melon: 2,
};
// 搭庇护所时不能用的方块：床、火把、门这类不是完整方块，以及工作台、熔炉、箱子这类要留着的设施。
const UNSUITABLE_SHELTER_BLOCKS = new Set([
  'bed',
  'torch',
  'redstone_torch',
  'soul_torch',
  'crafting_table',
  'furnace',
  'chest',
  'trapped_chest',
  'barrel',
  'ender_chest',
]);
// 附近的危险方块，找掩体时要避开。
const DANGER_BLOCKS = new Set([
  'cactus',
  'lava',
  'fire',
  'magma_block',
  'sweet_berry_bush',
  'powder_snow',
  'wither_rose',
  'campfire',
  'water',
]);
// 床的颜色顺序，合成床时按这个顺序挑手头有羊毛的颜色。
const BED_COLORS = [
  'white',
  'red',
  'blue',
  'yellow',
  'green',
  'light_blue',
  'orange',
  'black',
  'purple',
  'pink',
  'lime',
  'cyan',
  'gray',
  'brown',
  'magenta',
  'light_gray',
];

// 食物档位：数字越小越优先。-1 表示不能吃。
export function foodTier(name) {
  const key = String(name || '');
  if (TOXIC_FOODS.has(key)) return -1;
  if (COOKED_MEATS.has(key)) return 0;
  if (RAW_MEATS.has(key)) return 1;
  if (BREAD_LIKE.has(key)) return 2;
  return 3;
}

// 挑出当前最该吃的一种食物。
// candidates: [{ name, count, foodPoints }]，foodPoints 是吃一个能加多少饥饿值。
// threshold: 饥饿阈值；currentFood 不低于阈值说明还不需要吃，返回 null。
// 优先级：熟肉 > 生肉 > 面包 > 任何其它有 food 值的物品；同档按 foodPoints 降序、数量降序。
export function pickFood(candidates, threshold = 18, currentFood = 0) {
  if (Number(currentFood) >= Number(threshold)) return null;
  const usable = (candidates || []).filter((entry) => {
    if (!entry || typeof entry.name !== 'string') return false;
    if (!(Number(entry.foodPoints) > 0)) return false;
    const tier = foodTier(entry.name);
    if (tier < 0) return false;
    if (GOLDEN_FOODS.has(entry.name)) return false;
    return true;
  });
  if (!usable.length) return null;
  usable.sort((left, right) => {
    const tierDiff = foodTier(left.name) - foodTier(right.name);
    if (tierDiff !== 0) return tierDiff;
    const pointDiff = Number(right.foodPoints) - Number(left.foodPoints);
    if (pointDiff !== 0) return pointDiff;
    const countDiff = Number(right.count || 0) - Number(left.count || 0);
    if (countDiff !== 0) return countDiff;
    return String(left.name).localeCompare(String(right.name));
  });
  return usable[0];
}

// 庇护所蓝图。返回相对中心的方块清单，y=0 是脚下那一层地面。
// size 支持 3、4、5：用 4 时内部是 2×2，正好能放下一张床。
// 默认搭成没有门洞的全封闭结构：四面墙（2 格高）+ 完整屋顶。
// sealed=false 时只用于兼容旧调用，仍会在南面留下一个两格高的门洞。
export function shelterPlan(size = 3, options = {}) {
  const requested = Math.trunc(Number(size));
  const span = requested === 4 || requested === 5 ? requested : 3;
  const sealed = options.sealed !== false;
  const min = -Math.floor(span / 2);
  const max = min + span - 1;
  const blocks = [];
  let wallCount = 0;
  let roofCount = 0;
  // 四面墙：perimeter 格，y=1 与 y=2；默认不留门洞，入口在内部用挖掘打开。
  for (let dx = min; dx <= max; dx += 1) {
    for (let dz = min; dz <= max; dz += 1) {
      const edge = dx === min || dx === max || dz === min || dz === max;
      if (!edge) continue;
      const isDoor = !sealed && dz === max && dx === 0;
      for (let dy = 1; dy <= 2; dy += 1) {
        if (isDoor) continue;
        blocks.push({ x: dx, y: dy, z: dz, kind: 'wall' });
        wallCount += 1;
      }
    }
  }
  // 屋顶：由外向内摆放，保证每个方块都有依附可以放上去。
  const roofCells = [];
  for (let dx = min; dx <= max; dx += 1) {
    for (let dz = min; dz <= max; dz += 1) {
      roofCells.push({ x: dx, z: dz, ring: Math.max(Math.abs(dx), Math.abs(dz)) });
    }
  }
  roofCells.sort((left, right) => right.ring - left.ring);
  for (const cell of roofCells) {
    blocks.push({ x: cell.x, y: 3, z: cell.z, kind: 'roof' });
    roofCount += 1;
  }
  const footprintCells = [];
  const interiorCells = [];
  for (let dx = min; dx <= max; dx += 1) {
    for (let dz = min; dz <= max; dz += 1) {
      footprintCells.push({ x: dx, z: dz });
      const interior = dx > min && dx < max && dz > min && dz < max;
      if (interior) interiorCells.push({ x: dx, z: dz });
    }
  }
  return {
    size: span,
    min,
    max,
    sealed,
    doorSide: sealed ? null : 'south',
    doorOffset: sealed ? null : { x: 0, z: max },
    doorCells: sealed
      ? []
      : [
          { x: 0, y: 1, z: max },
          { x: 0, y: 2, z: max },
        ],
    blocks,
    footprintCells,
    interiorCells,
    wallCount,
    roofCount,
    blockCount: blocks.length,
  };
}

// 是不是夜晚（只看时间，不看雷暴）。
export function isNight(bot) {
  const time = Number(bot?.time?.timeOfDay ?? -1);
  if (!Number.isFinite(time) || time < 0) return false;
  return time >= 12541 && time <= 23458;
}

// 是不是雷暴天（可以打雷时睡觉）。
export function isThunderstorm(bot) {
  if (!bot) return false;
  return Boolean(bot.isRaining) && Number(bot.thunderState || 0) > 0;
}

// 现在能不能睡觉：夜晚或雷暴。
export function canSleep(bot) {
  return isNight(bot) || isThunderstorm(bot);
}

// 睡完之后时间有没有推进（跨天或推进 1000 tick 以上）。
export function timeAdvanced(beforeTime, beforeDay, bot) {
  if (!bot || !bot.time) return false;
  const previousDay = Number(beforeDay);
  const currentDay = Number(bot.time.day);
  const previousTime = Number(beforeTime);
  const currentTime = Number(bot.time.timeOfDay);
  if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) return false;
  if (Number.isFinite(previousDay) && Number.isFinite(currentDay)) {
    if (currentDay < previousDay) return false;
    return (currentDay - previousDay) * 24000 + currentTime - previousTime >= 1000;
  }
  return currentTime - previousTime >= 1000;
}

// 方块是不是水。
export function isWaterName(name) {
  return String(name || '').includes('water');
}

// 脚下的方块是不是水（脚下、脚下那一格、身体那一格都看一眼）。
export function isInWater(bot) {
  if (!bot || !bot.entity) return false;
  const position = bot.entity.position;
  const x = Math.floor(position.x);
  const y = Math.floor(position.y);
  const z = Math.floor(position.z);
  const below = blockAt(bot, x, y - 1, z);
  const feet = blockAt(bot, x, y, z);
  const head = blockAt(bot, x, y + 1, z);
  return (
    isWaterName(below?.name) || isWaterName(feet?.name) || isWaterName(head?.name)
  );
}

/* ============================ ctx 辅助 ============================ */

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function registryOf(ctx) {
  if (ctx.registry) return ctx.registry;
  return ctx.bot?.registry || null;
}

function botPosition(ctx) {
  const position = ctx.bot?.entity?.position;
  if (!position) return null;
  return {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
  };
}

function positionText(ctx) {
  const position = ctx.bot?.entity?.position;
  if (!position) return '位置未知';
  return `(${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)})`;
}

function clockText(ctx) {
  const ticks = Number(ctx.bot?.time?.timeOfDay ?? 0);
  const hours = (Math.floor(ticks / 1000) + 6) % 24;
  const minutes = Math.floor(((ticks % 1000) / 1000) * 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function itemLabelOf(ctx, name) {
  if (typeof ctx.itemLabel === 'function') return ctx.itemLabel(name);
  return String(name || '');
}

function blockLabelOf(ctx, name) {
  if (typeof ctx.blockLabel === 'function') return ctx.blockLabel(name);
  return String(name || '');
}

function entityLabelOf(ctx, entity) {
  if (entity && typeof ctx.entityDisplayName === 'function') {
    try {
      return ctx.entityDisplayName(entity);
    } catch (error) {
      return String(entity.name || '未知目标');
    }
  }
  return String(entity?.name || '未知目标');
}

function logOf(ctx, label, detail) {
  if (typeof ctx.log === 'function') ctx.log(label, detail);
}

// 造一个 Vec3，避免直接 import mineflayer；bot 上没有就用普通对象。
function makeVec(bot, x, y, z) {
  const sample = bot?.entity?.position;
  // 只有真正的 Vec3（带 offset/floored）才能照抄构造方法，普通对象退回 {x, y, z}。
  if (
    sample &&
    typeof sample.constructor === 'function' &&
    typeof sample.offset === 'function'
  ) {
    try {
      const built = new sample.constructor(x, y, z);
      // 构造结果必须真的带上坐标，否则说明这个 constructor 不能用。
      if (built && built.x === x && built.y === y && built.z === z) return built;
    } catch (error) {
      // 构造失败就退回普通对象，后面的读坐标逻辑一样能用。
    }
  }
  return { x, y, z };
}

// 两点距离，位置对象不一定带 distanceTo 时退回算术距离。
function distanceBetween(left, right) {
  if (!left || !right) return 0;
  if (typeof left.distanceTo === 'function') {
    const value = Number(left.distanceTo(right));
    if (Number.isFinite(value)) return value;
  }
  return Math.hypot(
    Number(left.x) - Number(right.x),
    Number(left.y) - Number(right.y),
    Number(left.z) - Number(right.z)
  );
}

function blockAt(bot, x, y, z) {
  if (!bot || typeof bot.blockAt !== 'function') return null;
  try {
    return bot.blockAt(makeVec(bot, x, y, z));
  } catch (error) {
    return null;
  }
}

function waitMs(ctx, ms) {
  if (typeof ctx.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertNotInterrupted(ctx, action) {
  if (ctx.interrupted) throw new Error(`${action}被新的指令打断`);
}

function inventoryItems(ctx) {
  const items = ctx.bot?.inventory?.items?.();
  return Array.isArray(items) ? items : [];
}

function countOf(ctx, name) {
  if (typeof ctx.countItem === 'function') {
    const value = Number(ctx.countItem(name));
    if (Number.isFinite(value)) return value;
  }
  return inventoryItems(ctx)
    .filter((item) => item.name === name)
    .reduce((total, item) => total + (Number(item.count) || 0), 0);
}

function foodPointsOf(ctx, name) {
  const foods = registryOf(ctx)?.foodsByName;
  const info = foods ? foods[name] : null;
  if (info && Number(info.foodPoints) > 0) return Number(info.foodPoints);
  const fallback = FALLBACK_FOOD_POINTS[name];
  return Number(fallback) > 0 ? Number(fallback) : 0;
}

// 背包里所有能吃的食物，合并同名物品的数量。
function listFoodCandidates(ctx) {
  const totals = new Map();
  for (const item of inventoryItems(ctx)) {
    const points = foodPointsOf(ctx, item.name);
    if (!(points > 0)) continue;
    const current = totals.get(item.name) || { name: item.name, count: 0, foodPoints: points };
    current.count += Number(item.count) || 0;
    totals.set(item.name, current);
  }
  return [...totals.values()];
}

// 判断背包里这个物品是不是能当墙用的完整方块。
function isShelterBlock(ctx, name) {
  if (UNSUITABLE_SHELTER_BLOCKS.has(name)) return false;
  if (/_bed$/.test(name)) return false;
  if (/_door$/.test(name) || /_sign$/.test(name)) return false;
  const registry = registryOf(ctx);
  const block = registry?.blocksByName ? registry.blocksByName[name] : null;
  if (block) {
    if (block.boundingBox && block.boundingBox !== 'block') return false;
  } else {
    // 没有 registry 的测试替身只接受这些常见的完整方块，避免把火把、台阶当墙。
    const known = /^(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|stone|cobblestone|cobbled_deepslate|deepslate|sand|red_sand|gravel|clay|terracotta|.*_terracotta|.*_planks|.*_log|.*_wood)$/;
    if (!known.test(String(name || ''))) return false;
  }
  if (registry?.itemsByName && !registry.itemsByName[name]) return false;
  return true;
}

// 搭墙时的材料优先级：先消耗土石，再消耗木板，最后才动原木和其余方块。
function shelterMaterialPriority(name) {
  if (name === 'dirt' || name === 'cobblestone' || name === 'stone') return 0;
  if (name === 'cobbled_deepslate' || name === 'deepslate' || name === 'sand' || name === 'gravel') {
    return 1;
  }
  if (/_planks$/.test(name)) return 2;
  if (/_log$/.test(name)) return 3;
  return 4;
}

function isAirBlock(block) {
  return !block || block.boundingBox === 'empty' || block.name === 'air';
}

function isSolidBlock(block) {
  return Boolean(block && block.boundingBox === 'block');
}

function isOpenSpace(block) {
  return Boolean(block) && isAirBlock(block) && !DANGER_BLOCKS.has(block.name);
}

function entityIntersectsBlock(entity, x, y, z) {
  const position = entity?.position;
  if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return false;
  const width = Number(entity.width) > 0 ? Number(entity.width) : 0.6;
  const height = Number(entity.height) > 0 ? Number(entity.height) : 1.8;
  const halfWidth = width / 2;
  return position.x + halfWidth > x
    && position.x - halfWidth < x + 1
    && position.y + height > y
    && position.y < y + 1
    && position.z + halfWidth > z
    && position.z - halfWidth < z + 1;
}

// 放置方块前先让出目标格；服务器会拒绝与玩家碰撞箱相交的方块。
async function moveClearOfShelterCell(ctx, plan, center, x, y, z, { force = false } = {}) {
  const bot = ctx.bot;
  if (!entityIntersectsBlock(bot?.entity, x, y, z) && !force) return false;
  if (typeof ctx.travelTo !== 'function') {
    throw new Error(`站位挡住庇护所目标 (${x}, ${y}, ${z})，桥接没有提供重新站位能力`);
  }

  const current = bot.entity.position;
  const candidates = plan.interiorCells
    .filter((cell) => center.x + cell.x !== x || center.z + cell.z !== z)
    .map((cell) => ({
      x: center.x + cell.x,
      y: center.y + 1,
      z: center.z + cell.z,
    }))
    .filter((spot) => {
      const floor = blockAt(bot, spot.x, center.y, spot.z);
      const feet = blockAt(bot, spot.x, spot.y, spot.z);
      const head = blockAt(bot, spot.x, spot.y + 1, spot.z);
      return isSolidBlock(floor) && !DANGER_BLOCKS.has(floor.name)
        && isOpenSpace(feet) && isOpenSpace(head);
    })
    .sort((left, right) => {
      const leftDistance = Math.hypot(left.x + 0.5 - current.x, left.z + 0.5 - current.z);
      const rightDistance = Math.hypot(right.x + 0.5 - current.x, right.z + 0.5 - current.z);
      return leftDistance - rightDistance;
    });

  if (force && candidates.length === 0 && !entityIntersectsBlock(bot.entity, x, y, z)) return false;

  const failures = [];
  for (const spot of candidates) {
    assertNotInterrupted(ctx, '搭建庇护所');
    try {
      await ctx.travelTo(spot.x + 0.5, spot.y, spot.z + 0.5, 0);
      assertNotInterrupted(ctx, '搭建庇护所');
    } catch (error) {
      if (ctx.interrupted || /被新的指令打断/.test(String(error?.message || ''))) throw error;
      failures.push(error.message);
      continue;
    }
    if (!entityIntersectsBlock(bot.entity, x, y, z)) return true;
    failures.push(`移动后仍与 (${x}, ${y}, ${z}) 相交`);
  }

  const location = `(${current.x.toFixed(2)}, ${current.y.toFixed(2)}, ${current.z.toFixed(2)})`;
  const reason = failures.length ? `；${failures.join('；')}` : '；没有可用的室内站位';
  throw new Error(`无法离开庇护所目标 (${x}, ${y}, ${z}) 的放置区域，当前位置 ${location}${reason}`);
}

/* ============================ 伤害监听 ============================ */

// 每个 bot 记录一次受伤时间和伤害来源，供低血撤退使用。
const damageTrackers = new WeakMap();

function trackDamage(bot) {
  if (!bot || typeof bot.on !== 'function') return null;
  const existing = damageTrackers.get(bot);
  if (existing) return existing;
  const tracker = { lastHurtAt: 0, lastSource: null, lastHealth: Number(bot.health ?? 20) };
  damageTrackers.set(bot, tracker);
  bot.on('health', () => {
    const health = Number(bot.health ?? 20);
    if (health < tracker.lastHealth - 0.01) tracker.lastHurtAt = Date.now();
    tracker.lastHealth = health;
  });
  bot.on('entityHurt', (entity, source) => {
    if (!bot.entity || !entity || entity.id !== bot.entity.id) return;
    tracker.lastHurtAt = Date.now();
    if (source) tracker.lastSource = source;
  });
  return tracker;
}

/* ============================ 进食 ============================ */

// 真正把食物吃掉：优先用 ctx.eatFood，没有就自己 consume。
async function performEat(ctx, name, count) {
  if (typeof ctx.eatFood === 'function') {
    const text = await ctx.eatFood({ item: name, count });
    return { eaten: null, detail: String(text || '') };
  }
  const bot = ctx.bot;
  let eaten = 0;
  for (let index = 0; index < count; index += 1) {
    if (Number(bot.food ?? 20) >= 20) break;
    const item = inventoryItems(ctx).find((entry) => entry.name === name);
    if (!item) break;
    const before = countOf(ctx, name);
    try {
      await bot.equip(item, 'hand');
      await bot.consume();
    } catch (error) {
      if (/food is full/i.test(String(error.message || ''))) break;
      throw new Error(`吃${itemLabelOf(ctx, name)}失败：${error.message}`);
    }
    await waitMs(ctx, 150);
    if (countOf(ctx, name) < before) eaten += 1;
  }
  if (eaten === 0) throw new Error(`吃了${itemLabelOf(ctx, name)}但没有检测到数量或饥饿值变化`);
  return { eaten, detail: '' };
}

/* ============================ 庇护所 ============================ */

// 找一块平地：footprint 里每一格的地面都要是实心方块，内部两格要空。
// 已经搭好的墙和屋顶可以是完整方块，方便超时重试时接着把缺口补完。
function footprintOk(ctx, plan, center) {
  const bot = ctx.bot;
  for (let dx = plan.min; dx <= plan.max; dx += 1) {
    for (let dz = plan.min; dz <= plan.max; dz += 1) {
      const x = center.x + dx;
      const z = center.z + dz;
      const ground = blockAt(bot, x, center.y, z);
      if (!isSolidBlock(ground) || DANGER_BLOCKS.has(ground.name)) return false;

      const interior = dx > plan.min && dx < plan.max && dz > plan.min && dz < plan.max;
      for (let dy = 1; dy <= 2; dy += 1) {
        const block = blockAt(bot, x, center.y + dy, z);
        if (!block) return false;
        if (interior) {
          if (!isOpenSpace(block)) return false;
        } else if (!isOpenSpace(block) && !isSolidBlock(block)) {
          return false;
        }
      }
      const roof = blockAt(bot, x, center.y + 3, z);
      if (!roof || (!isOpenSpace(roof) && !isSolidBlock(roof))) return false;
    }
  }
  return true;
}

// 选庇护所中心：先扫描已加载地面，再试脚下与四周偏移。
async function findShelterCenters(ctx, plan) {
  const base = botPosition(ctx);
  if (!base) return [];
  const bot = ctx.bot;
  if (typeof bot.findBlocks === 'function') {
    let supports = [];
    try {
      supports = bot.findBlocks({
        matching: (block) => isSolidBlock(block) && !DANGER_BLOCKS.has(block.name),
        // 先筛出头顶有空间的地面，避免取土坑里的地下石块占满候选。
        useExtraInfo: block => Math.abs(block.position.y - (base.y - 1)) <= 12 &&
          isOpenSpace(blockAt(bot, block.position.x, block.position.y + 1, block.position.z)),
        maxDistance: 40,
        count: 768,
      });
    } catch {
      supports = [];
    }
    const centers = [];
    const seen = new Set();
    const startLight = blockAt(bot, base.x, base.y + 1, base.z)?.skyLight;
    const previous = ctx.getRememberedShelter?.();
    for (const [index, support] of (supports || []).entries()) {
      if (index % 32 === 0) {
        await new Promise(resolve => setImmediate(resolve));
        assertNotInterrupted(ctx, '寻找庇护所平地');
      }
      const position = support?.position || support;
      if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) continue;
      const center = {
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z),
      };
      if (Math.abs(center.y - (base.y - 1)) > 12) continue;
      const key = `${center.x},${center.y},${center.z}`;
      if (seen.has(key) || !footprintOk(ctx, plan, center)) continue;
      seen.add(key);
      const reused = plan.blocks.reduce((count, cell) => {
        const block = blockAt(bot, center.x + cell.x, center.y + cell.y, center.z + cell.z);
        return count + Number(isSolidBlock(block) && !DANGER_BLOCKS.has(block.name));
      }, 0);
      const roofLight = blockAt(bot, center.x, center.y + 4, center.z)?.skyLight;
      const darkDescent = startLight >= 12 && base.y - 1 - center.y >= 4 && Number.isFinite(roofLight) && roofLight < 8;
      const repair = reused > 0 && previous?.size === plan.size && previous.position?.x === center.x &&
        previous.position.y === center.y && previous.position.z === center.z;
      const distance = Math.hypot(center.x - base.x, center.z - base.z) + Math.abs(center.y - (base.y - 1)) * 1.5;
      centers.push({center, repair, darkDescent, reused, distance});
    }
    // 从地表选址时，先修自己的棚屋，再看附近平地；地下天然石壁不能只靠省材料排在前面。
    centers.sort((a, b) => b.repair - a.repair || a.darkDescent - b.darkDescent || b.reused - a.reused || a.distance - b.distance);
    if (centers.length) return centers.map(site => site.center);
  }
  const groundY = base.y - 1;
  const offsets = [[0, 0]];
  for (let radius = 1; radius <= 3; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        offsets.push([dx, dz]);
      }
    }
  }
  return offsets
    .map(([dx, dz]) => ({ x: base.x + dx, y: groundY, z: base.z + dz }))
    .filter((center) => footprintOk(ctx, plan, center));
}

// 决定庇护所每一格用哪种方块；材料可以混用，不够时直接报错说明缺多少。
function resolveShelterMaterials(ctx, plan, requested, center) {
  const reused = plan.blocks.reduce((count, cell) => {
    const block = blockAt(ctx.bot, center.x + cell.x, center.y + cell.y, center.z + cell.z);
    return count + Number(isSolidBlock(block) && !DANGER_BLOCKS.has(block.name));
  }, 0);
  const needed = Math.max(0, plan.blockCount - reused);
  if (requested) {
    const have = countOf(ctx, requested);
    if (have < needed) {
      throw new Error(
        `材料不够，缺少 ${needed - have} 个${blockLabelOf(ctx, requested)}（背包里只有 ${have} 个，需要 ${needed} 个）`
      );
    }
    return [{ name: requested, count: needed }];
  }
  const totals = new Map();
  for (const item of inventoryItems(ctx)) {
    if (!isShelterBlock(ctx, item.name)) continue;
    totals.set(item.name, (totals.get(item.name) || 0) + (Number(item.count) || 0));
  }
  const options = [...totals.entries()]
    .filter(([, count]) => count > 0)
    .map(([name, count]) => ({ name, count }));
  options.sort((left, right) => {
    const priorityDiff = shelterMaterialPriority(left.name) - shelterMaterialPriority(right.name);
    if (priorityDiff !== 0) return priorityDiff;
    const countDiff = right.count - left.count;
    if (countDiff !== 0) return countDiff;
    return String(left.name).localeCompare(String(right.name));
  });
  const total = options.reduce((sum, item) => sum + item.count, 0);
  if (total < needed) {
    const stock = options.length
      ? options.map((item) => `${blockLabelOf(ctx, item.name)}×${item.count}`).join('、')
      : '没有可以搭墙的完整方块';
    throw new Error(`材料不够，缺少 ${needed - total} 个可搭方块（需要 ${needed} 个，背包里只有 ${total} 个：${stock}）`);
  }
  const materials = [];
  let left = needed;
  for (const item of options) {
    if (left <= 0) break;
    const take = Math.min(item.count, left);
    if (take > 0) materials.push({ name: item.name, count: take });
    left -= take;
  }
  return materials;
}

function materialSummary(ctx, materials) {
  return materials.map((item) => `${blockLabelOf(ctx, item.name)}×${item.count}`).join('、');
}

function materialQueue(materials) {
  const queue = [];
  for (const item of materials) {
    for (let index = 0; index < item.count; index += 1) queue.push(item.name);
  }
  return queue;
}

// 逐格验收：所有墙和屋顶都是完整方块，内部两格保持空气。
function assertShelterSealed(ctx, plan, center) {
  const bot = ctx.bot;
  const missing = [];
  for (const cell of plan.blocks) {
    const block = blockAt(bot, center.x + cell.x, center.y + cell.y, center.z + cell.z);
    if (!isSolidBlock(block) || DANGER_BLOCKS.has(block.name)) {
      missing.push(`${center.x + cell.x},${center.y + cell.y},${center.z + cell.z}`);
    }
  }
  for (const cell of plan.footprintCells) {
    const block = blockAt(bot, center.x + cell.x, center.y, center.z + cell.z);
    if (!isSolidBlock(block) || DANGER_BLOCKS.has(block.name)) {
      throw new Error(
        `庇护所地面 (${center.x + cell.x}, ${center.y}, ${center.z + cell.z}) 不安全或不完整`
      );
    }
  }
  if (missing.length) {
    throw new Error(`庇护所没有封闭，还缺 ${missing.length} 格：${missing.slice(0, 6).join('；')}`);
  }
  for (const cell of plan.interiorCells) {
    for (let dy = 1; dy <= 2; dy += 1) {
      const block = blockAt(bot, center.x + cell.x, center.y + dy, center.z + cell.z);
      if (!isOpenSpace(block)) {
        throw new Error(`庇护所内部 (${center.x + cell.x}, ${center.y + dy}, ${center.z + cell.z}) 被方块占住了`);
      }
    }
  }
}

/* ============================ 床 ============================ */

function findBed(ctx, range) {
  if (typeof ctx.findNearbyBed !== 'function') return null;
  try {
    return ctx.findNearbyBed(range) || null;
  } catch (error) {
    return null;
  }
}

// 背包里的床，或者用羊毛 + 木板能合成的床。
function pickBedPlan(ctx) {
  const bed = bedItemInInventory(ctx);
  if (bed) return { item: bed.name, craft: false };
  const planks = inventoryItems(ctx)
    .filter((item) => /_planks$/.test(item.name))
    .reduce((total, item) => total + (Number(item.count) || 0), 0);
  if (planks < 3) return null;
  for (const color of BED_COLORS) {
    if (countOf(ctx, `${color}_wool`) >= 3) return { item: `${color}_bed`, craft: true };
  }
  return null;
}

// 背包里现成的床。
function bedItemInInventory(ctx) {
  return inventoryItems(ctx).find((item) => /_bed$/.test(item.name)) || null;
}

function isBedBlock(block) {
  return Boolean(block && (block.name === 'bed' || /_bed$/.test(String(block.name))));
}

// 找床脚：床脚与床头两格都要空，床脚下面要有完整方块。
// 庇护所只有 2×2 内部空间时也能放床，不额外要求第三格空位。
function findBedSpot(ctx) {
  const bot = ctx.bot;
  if (!bot || !bot.entity || typeof bot.blockAt !== 'function') return null;
  const base = bot.entity.position;
  const bx = Math.floor(base.x);
  const bz = Math.floor(base.z);
  const y = Math.floor(base.y);
  const dirs = [
    { x: 1, z: 0 },
    { x: -1, z: 0 },
    { x: 0, z: 1 },
    { x: 0, z: -1 },
  ];
  const around = [
    { x: 1, z: 0 },
    { x: -1, z: 0 },
    { x: 0, z: 1 },
    { x: 0, z: -1 },
    { x: 1, z: 1 },
    { x: 1, z: -1 },
    { x: -1, z: 1 },
    { x: -1, z: -1 },
  ];
  for (const cell of around) {
    const foot = { x: bx + cell.x, y, z: bz + cell.z };
    if (!isSolidBlock(blockAt(bot, foot.x, foot.y - 1, foot.z))) continue;
    if (!isOpenSpace(blockAt(bot, foot.x, foot.y, foot.z))) continue;
    if (!isOpenSpace(blockAt(bot, foot.x, foot.y + 1, foot.z))) continue;
    for (const dir of dirs) {
      const head = { x: foot.x + dir.x, y: foot.y, z: foot.z + dir.z };
      if (!isOpenSpace(blockAt(bot, head.x, head.y, head.z))) continue;
      if (!isOpenSpace(blockAt(bot, head.x, head.y + 1, head.z))) continue;
      return { foot, head, dir };
    }
  }
  return null;
}

// 放床统一走桥接的已验证接口，处理朝向、玩家站位和床的两格回执。
async function placeBedItem(ctx, bedItem) {
  const bot = ctx.bot;
  if (!bot || !bot.entity) throw new Error('没有 bot 实例，不能放床');
  const item = inventoryItems(ctx).find((entry) => entry.name === bedItem);
  if (!item) throw new Error(`背包里没有${blockLabelOf(ctx, bedItem)}`);
  if (typeof ctx.placeBedAt !== 'function') throw new Error('桥接没有提供经过验证的放床接口');
  const spot = findBedSpot(ctx);
  if (!spot) {
    throw new Error('附近没有能放床的地方：床脚和床头都要两格空位，庇护所内部至少留出 2×2 空间');
  }
  const support = blockAt(bot, spot.foot.x, spot.foot.y - 1, spot.foot.z);
  if (!isSolidBlock(support)) throw new Error('床脚下面没有支撑方块');
  const placed = await ctx.placeBedAt(spot.foot, bedItem);
  const footBlock = blockAt(bot, placed.foot.x, placed.foot.y, placed.foot.z);
  const headBlock = blockAt(bot, placed.head.x, placed.head.y, placed.head.z);
  if (!isBedBlock(footBlock) || !isBedBlock(headBlock)) throw new Error('放床接口返回后没有观察到完整的床脚和床头');
  return {
    item: bedItem,
    foot: placed.foot,
    head: placed.head,
  };
}

// 保证附近有一张床：背包里有就放下；没有就用羊毛和木板合成一张再放。
async function ensureBed(ctx) {
  let bedItem = bedItemInInventory(ctx)?.name || '';
  if (!bedItem) {
    const plan = pickBedPlan(ctx);
    if (!plan) {
      throw new Error('附近没有床，背包里也没有 3 个羊毛和 3 个木板可以合成一张床');
    }
    if (typeof ctx.craftItem !== 'function') throw new Error('桥接没有提供合成接口');
    try {
      await ctx.craftItem({ item: plan.item, count: 1 });
    } catch (error) {
      throw new Error(`没有床，也合成不出来：${error.message}`);
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      bedItem = bedItemInInventory(ctx)?.name || '';
      if (bedItem) break;
      await waitMs(ctx, 100);
    }
    if (!bedItem) throw new Error(`合成${blockLabelOf(ctx, plan.item)}后背包里仍然没有床`);
  }
  try {
    const placed = await placeBedItem(ctx, bedItem);
    return placed.item;
  } catch (error) {
    throw new Error(`没有床，${blockLabelOf(ctx, bedItem)}也放不下去：${error.message}`);
  }
}

// 错误是不是跟床有关（床被破坏、床放不下之类）。
function isBedProblem(message) {
  return /床|bed/i.test(String(message || ''));
}

// 等到真的从床上起来。
async function waitLeaveBed(ctx, timeoutMs = 10000) {
  const bot = ctx.bot;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!bot.isSleeping) return true;
    if (ctx.interrupted) {
      if (typeof bot.wake === 'function') await bot.wake().catch(() => {});
      throw new Error('睡觉被新的指令打断');
    }
    await waitMs(ctx, 250);
  }
  return !bot.isSleeping;
}

async function waitForSleepTimeAdvance(ctx, beforeTime, beforeDay, timeoutMs = 5000) {
  let elapsed = 0;
  while (elapsed <= timeoutMs) {
    const advanced = typeof ctx.sleepAdvancedTime === 'function'
      ? Boolean(ctx.sleepAdvancedTime(beforeTime, beforeDay))
      : timeAdvanced(beforeTime, beforeDay, ctx.bot);
    if (advanced) return true;
    if (ctx.interrupted) throw new Error('睡觉被新的指令打断');
    if (elapsed === timeoutMs) return false;
    const interval = Math.min(100, timeoutMs - elapsed);
    await waitMs(ctx, interval);
    elapsed += interval;
  }
  return false;
}

/* ============================ 技能 ============================ */

export const skills = {
  equip_armor: {
    description:
      '检查背包并自动穿上更好的护甲；完成后读取头盔、胸甲、护腿和靴子槽验证实际装备，没有确认到任何已穿护甲时返回失败。',
    parameters: [],
    handler: async (_args, ctx) => {
      const bot = ctx.bot;
      if (!bot || !bot.entity) throw new Error('bot 还没进入世界，没有办法整理护甲');
      if (!bot.armorManager || typeof bot.armorManager.equipAll !== 'function') {
        throw new Error('护甲管理器不可用，无法整理护甲');
      }

      await bot.armorManager.equipAll();
      if (!bot.inventory || !Array.isArray(bot.inventory.slots)) {
        throw new Error('护甲整理后无法读取装备槽，不能确认是否穿上护甲');
      }

      const slotDefinitions = [
        ['helmet', '头盔', 5],
        ['chestplate', '胸甲', 6],
        ['leggings', '护腿', 7],
        ['boots', '靴子', 8],
      ];
      const equippedSlots = Object.fromEntries(
        slotDefinitions.map(([key, , index]) => {
          const item = bot.inventory.slots[index];
          return [key, item ? { name: item.name, count: Number(item.count) || 1 } : null];
        }),
      );
      const equipped = slotDefinitions
        .filter(([key]) => equippedSlots[key])
        .map(([key, label]) => `${label}：${equippedSlots[key].name}`);
      const empty = slotDefinitions
        .filter(([key]) => !equippedSlots[key])
        .map(([key]) => key);
      const emptyLabels = slotDefinitions
        .filter(([key]) => !equippedSlots[key])
        .map(([, label]) => label);

      if (!equipped.length) {
        const result = {
          equippedSlots,
          emptySlots: empty,
          status: 'failed',
          verified: false,
        };
        return {
          ...result,
          detail: '未确认到已装备护甲；结果=' + JSON.stringify(result),
        };
      }

      const result = {
        equippedSlots,
        emptySlots: empty,
        status: 'succeeded',
        verified: true,
      };
      return {
        ...result,
        detail: '已确认护甲槽：' + equipped.join('、') + (emptyLabels.length ? '；空槽：' + emptyLabels.join('、') : '；四个护甲槽均已装备') + '；结果=' + JSON.stringify(result),
      };
    },
  },

  eat_if_hungry: {
    description:
      '饥饿值低于阈值时自动进食：按熟肉 > 生肉 > 面包 > 其它有 food 值物品的优先级挑食物，吃完核对饥饿值真的上升。',
    parameters: [
      {
        name: 'threshold',
        type: 'number',
        required: false,
        default: 18,
        description: '饥饿值低于该阈值才吃，范围 1-20。',
      },
      {
        name: 'item',
        type: 'string',
        required: false,
        default: null,
        description: '指定食物物品 ID；省略时按优先级自动挑。',
      },
      {
        name: 'count',
        type: 'number',
        required: false,
        default: 0,
        description: '最多吃几个，0 表示按饥饿缺口自动算。',
      },
    ],
    handler: async (args, ctx) => {
      const bot = ctx.bot;
      if (!bot || !bot.entity) throw new Error('bot 还没进入世界，没有办法看饥饿值');
      const threshold = clampNumber(args.threshold, 18, 1, 20);
      const currentFood = Number(bot.food ?? 20);
      if (currentFood >= threshold) {
        return {
          detail: `饥饿值 ${currentFood}/20，不低于阈值 ${threshold}，不用进食`,
          status: 'succeeded',
        };
      }
      const candidates = listFoodCandidates(ctx);
      const requested = String(args.item || '').trim();
      let chosen = null;
      if (requested) {
        chosen = candidates.find((entry) => entry.name === requested) || null;
        if (!chosen) {
          if (foodPointsOf(ctx, requested) > 0) {
            throw new Error(`背包里没有${itemLabelOf(ctx, requested)}`);
          }
          throw new Error(`${itemLabelOf(ctx, requested)}不是能吃的食物`);
        }
      } else {
        chosen = pickFood(candidates, threshold, currentFood);
        if (!chosen) {
          throw new Error(
            `背包里没有能吃的食物，缺少熟肉、生肉或面包（饥饿值 ${currentFood}/20，阈值 ${threshold}）`
          );
        }
      }
      const points = Math.max(1, Number(chosen.foodPoints) || 1);
      const gap = Math.max(1, threshold - currentFood);
      const wanted = Number(args.count) > 0
        ? Math.min(Math.trunc(Number(args.count)), 16)
        : Math.min(Math.max(1, Math.ceil(gap / points)), 16);
      const beforeCount = countOf(ctx, chosen.name);
      const outcome = await performEat(ctx, chosen.name, wanted);
      const afterCount = countOf(ctx, chosen.name);
      const eaten = outcome.eaten === null ? Math.max(0, beforeCount - afterCount) : outcome.eaten;
      const afterFood = Number(bot.food ?? 20);
      if (!(afterFood > currentFood)) {
        throw new Error(
          `吃了${itemLabelOf(ctx, chosen.name)}但饥饿值没有上升，还是 ${afterFood}/20`
        );
      }
      return {
        detail: `吃了 ${eaten} 个${itemLabelOf(ctx, chosen.name)}，饥饿值从 ${currentFood} 升到 ${afterFood}，血量 ${Number(bot.health ?? 20)}/20`,
        status: 'succeeded',
      };
    },
  },

  make_shelter: {
    description:
      '在脚下的平地上搭一个四面墙加完整屋顶的全封闭庇护所，没有门洞；材料可以土石与木板混用，搭完逐格验收墙和屋顶，材料不够会报缺什么方块和数量。',
    parameters: [
      {
        name: 'size',
        type: 'number',
        required: false,
        default: 3,
        description: '庇护所边长，支持 3（内部 1×1）、4（内部 2×2，可放床）或 5（内部 3×3）。',
      },
      {
        name: 'block',
        type: 'string',
        required: false,
        default: null,
        description: '指定搭建材料方块 ID；省略时优先用泥土、圆石，再用木板和原木，允许混用。',
      },
    ],
    handler: async (args, ctx) => {
      const bot = ctx.bot;
      if (!bot || !bot.entity) throw new Error('bot 还没进入世界，没有办法搭庇护所');
      const requestedSize = Math.trunc(Number(args.size ?? 3));
      if (![3, 4, 5].includes(requestedSize)) {
        throw new Error(`庇护所边长只支持 3、4、5，收到 ${args.size}`);
      }
      const size = requestedSize;
      const plan = shelterPlan(size);
      const centers = await findShelterCenters(ctx, plan);
      if (centers.length === 0) throw new Error(`附近没有 ${size}×${size} 的平地，缺少可以搭庇护所的地面`);
      assertNotInterrupted(ctx, '搭建庇护所');
      const requestedBlock = String(args.block || '').trim();
      // 站到中心，保证所有格子都在够得到的距离内。
      let center = null;
      let lastTravelError = null;
      for (const candidate of centers.slice(0, 8)) {
        assertNotInterrupted(ctx, '搭建庇护所');
        const standing = botPosition(ctx);
        if (!standing || standing.x !== candidate.x || standing.z !== candidate.z || standing.y !== candidate.y + 1) {
          if (typeof ctx.travelTo !== 'function') {
            lastTravelError = new Error('桥接没有提供寻路能力');
            continue;
          }
          try {
            await ctx.travelTo(candidate.x, candidate.y + 1, candidate.z, 1);
          } catch (error) {
            if (ctx.interrupted || /被新的指令打断/.test(String(error?.message || ''))) throw error;
            lastTravelError = error;
            continue;
          }
          assertNotInterrupted(ctx, '搭建庇护所');
        }
        if (footprintOk(ctx, plan, candidate)) {
          center = candidate;
          break;
        }
      }
      if (!center) {
        const reason = lastTravelError ? `：${lastTravelError.message}` : '';
        throw new Error(`找到的 ${size}×${size} 平地无法安全到达或地形已变化${reason}`);
      }
      const shelterData = { position: { x: center.x, y: center.y, z: center.z }, size };
      if (typeof ctx.rememberShelter === 'function') ctx.rememberShelter(shelterData);
      if (typeof ctx.reportProgress === 'function') {
        ctx.reportProgress('building_shelter', `已选定庇护所坐标 (${center.x}, ${center.y}, ${center.z})，开始逐格施工`, 0, {
          shelter: shelterData,
          placed: 0,
          reused: 0,
          total: plan.blocks.length,
        });
      }
      const materials = resolveShelterMaterials(ctx, plan, requestedBlock, center);
      const queue = materialQueue(materials);
      let placed = 0;
      let reused = 0;
      const used = new Map();
      for (const cell of plan.blocks) {
        assertNotInterrupted(ctx, '搭建庇护所');
        const x = center.x + cell.x;
        const y = center.y + cell.y;
        const z = center.z + cell.z;
        const existing = blockAt(bot, x, y, z);
        if (isSolidBlock(existing) && !DANGER_BLOCKS.has(existing.name)) {
          reused += 1;
          if (typeof ctx.reportProgress === 'function') {
            const completed = placed + reused;
            ctx.reportProgress('building_shelter', `已逐格确认 ${completed}/${plan.blocks.length} 格`, completed / plan.blocks.length, {
              shelter: shelterData,
              placed,
              reused,
              total: plan.blocks.length,
            });
          }
          continue;
        }
        if (!isOpenSpace(existing)) {
          throw new Error(`庇护所目标位置 (${x}, ${y}, ${z}) 被${existing ? existing.name : '未知方块'}占住，不能继续搭`);
        }
        const material = queue.shift();
        if (!material) {
          throw new Error(`材料队列提前用完，无法补上 (${x}, ${y}, ${z}) 这一格`);
        }
        const clearedForPlacement = await moveClearOfShelterCell(ctx, plan, center, x, y, z);
        if (clearedForPlacement && typeof ctx.reportProgress === 'function') {
          const completed = placed + reused;
          ctx.reportProgress('building_shelter', `已移到安全站位，避开目标方块 (${x}, ${y}, ${z})`, completed / plan.blocks.length, {
            shelter: shelterData,
            placed,
            reused,
            total: plan.blocks.length,
            placement_clearance: {
              target: { x, y, z },
              position: { ...bot.entity.position },
            },
          });
        }
        try {
          await ctx.placeBlock({ block: material, x, y, z });
        } catch (error) {
          assertNotInterrupted(ctx, '搭建庇护所');
          const afterFailure = blockAt(bot, x, y, z);
          if (afterFailure?.name !== material && isOpenSpace(afterFailure) && typeof ctx.travelTo === 'function') {
            try {
              const cleared = await moveClearOfShelterCell(ctx, plan, center, x, y, z, { force: true });
              if (!cleared) await ctx.travelTo(x, y, z, 1);
              assertNotInterrupted(ctx, '搭建庇护所');
              await moveClearOfShelterCell(ctx, plan, center, x, y, z);
              await ctx.placeBlock({ block: material, x, y, z });
            } catch (retryError) {
              assertNotInterrupted(ctx, '搭建庇护所');
              const placedAfterRetry = blockAt(bot, x, y, z);
              if (placedAfterRetry?.name !== material) {
                throw new Error(
                  `在 (${x}, ${y}, ${z}) 放置${blockLabelOf(ctx, material)}失败：${error.message}；重新寻路后仍失败：${retryError.message}`
                );
              }
            }
          } else if (afterFailure?.name !== material) {
            throw new Error(
              `在 (${x}, ${y}, ${z}) 放置${blockLabelOf(ctx, material)}失败：${error.message}`
            );
          }
        }
        assertNotInterrupted(ctx, '搭建庇护所');
        const confirmed = blockAt(bot, x, y, z);
        if (!confirmed || confirmed.name !== material) {
          throw new Error(
            `在 (${x}, ${y}, ${z}) 放置${blockLabelOf(ctx, material)}失败：放完位置还是空的`
          );
        }
        placed += 1;
        used.set(material, (used.get(material) || 0) + 1);
        await waitMs(ctx, 500);
        assertNotInterrupted(ctx, '搭建庇护所');
        if (typeof ctx.reportProgress === 'function') {
          const completed = placed + reused;
          ctx.reportProgress('building_shelter', `已施工并确认 ${completed}/${plan.blocks.length} 格`, completed / plan.blocks.length, {
            shelter: shelterData,
            placed,
            reused,
            total: plan.blocks.length,
          });
        }
      }
      assertNotInterrupted(ctx, '搭建庇护所');
      assertShelterSealed(ctx, plan, center);
      if (typeof ctx.reportProgress === 'function') {
        ctx.reportProgress('shelter_verified', `庇护所 ${size}×${size} 已通过墙、地面、屋顶逐格验收`, 1, {
          shelter: shelterData,
          placed,
          reused,
          total: plan.blocks.length,
          sealed: true,
        });
      }
      const usedMaterials = [...used.entries()].map(([name, count]) => ({ name, count }));
      const usedText = usedMaterials.length ? materialSummary(ctx, usedMaterials) : '已有方块';
      logOf(ctx, '搭庇护所', `${size}×${size}，新放 ${placed} 格，复用 ${reused} 格：${usedText}`);
      return {
        detail: `在 (${center.x}, ${center.y}, ${center.z}) 搭好了 ${size}×${size} 全封闭庇护所，墙体与屋顶已逐格验收；新放 ${placed} 格，复用 ${reused} 格，材料：${usedText}`,
        status: 'succeeded',
        data: { shelter: shelterData, placed, reused, total: plan.blocks.length, sealed: true },
      };
    },
  },

  sleep_safe: {
    description:
      '安全过夜：确认夜晚或雷暴，找床（没有就合成一张），睡到天亮并确认已经离开床；床被破坏时重找或重建再试一次。',
    parameters: [
      {
        name: 'range',
        type: 'number',
        required: false,
        default: 16,
        description: '找床的搜索半径，范围 4-48 格。',
      },
    ],
    handler: async (args, ctx) => {
      const bot = ctx.bot;
      if (!bot || !bot.entity) throw new Error('bot 还没进入世界，没有办法睡觉');
      const dimension = String(bot.game?.dimension || '').toLowerCase();
      if (dimension.includes('nether')) throw new Error('这里是下界，不能正常睡觉，床会爆炸');
      if (dimension.includes('end')) throw new Error('这里是末地，不能正常睡觉');
      const range = clampNumber(args.range, 16, 4, 48);
      const canSleepNow = () => {
        const nightOk =
          typeof ctx.isSleepTime === 'function' ? Boolean(ctx.isSleepTime()) : isNight(bot);
        const stormOk =
          typeof ctx.isThunderstorm === 'function'
            ? Boolean(ctx.isThunderstorm())
            : isThunderstorm(bot);
        return nightOk || stormOk;
      };
      if (bot.isSleeping) {
        const beforeTime = Number(bot.time?.timeOfDay ?? 0);
        const beforeDay = Number(bot.time?.day ?? 0);
        const left = await waitLeaveBed(ctx, 15000);
        if (!left) throw new Error('已经在睡觉，但一直没有离开床');
        const advanced = await waitForSleepTimeAdvance(ctx, beforeTime, beforeDay);
        if (!advanced) throw new Error('已经离开床，但没有确认游戏时间向前推进');
        return {
          detail: `本来就在睡，现在已经醒在第 ${bot.time?.day ?? 0} 天 ${clockText(ctx)}`,
          status: 'succeeded',
        };
      }
      if (!canSleepNow()) {
        throw new Error(
          `现在是 ${clockText(ctx)}，不是夜晚也没有雷暴，不能睡觉`
        );
      }
      let bed = findBed(ctx, range);
      if (!bed) {
        await ensureBed(ctx);
        bed = findBed(ctx, range);
        if (!bed) throw new Error(`附近 ${range} 格内没有床，也没有办法放下一张床`);
      }
      const bedText = `(${bed.position.x}, ${bed.position.y}, ${bed.position.z})`;
      let lastError = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const beforeTime = Number(bot.time?.timeOfDay ?? 0);
        const beforeDay = Number(bot.time?.day ?? 0);
        try {
          const sleepResult = await ctx.sleepInBed(range);
          const left = await waitLeaveBed(ctx, 15000);
          if (!left) throw new Error('躺下后一直没有离开床');
          const advanced = await waitForSleepTimeAdvance(ctx, beforeTime, beforeDay);
          if (sleepResult?.bedSleepAcknowledged !== true) {
            throw new Error('没有收到床睡眠确认，不能确认已经过夜');
          }
          if (!advanced) {
            throw new Error('离开床后游戏时间没有推进，没有跳过这一夜');
          }
          const sleepDetail = typeof sleepResult === 'string'
            ? sleepResult
            : String(sleepResult?.detail || '床睡眠确认与时间推进均已确认');
          return {
            detail: `睡过去了：${sleepDetail}。床在 ${bedText}，现在是第 ${bot.time?.day ?? 0} 天 ${clockText(ctx)}，已经离开床`,
            status: 'succeeded',
          };
        } catch (error) {
          lastError = error;
          const message = String(error.message || error);
          if (!isBedProblem(message)) throw error;
          // 床可能被破坏：重新找一张，或者重新做一张。
          if (attempt === 1) break;
          logOf(ctx, '过夜失败', message);
          let repaired = findBed(ctx, range);
          if (!repaired) {
            await ensureBed(ctx);
            repaired = findBed(ctx, range);
          }
          if (!repaired) {
            throw new Error(`床出了问题：${message}，附近也没有可以重放的床`);
          }
        }
      }
      throw new Error(`两次都没能睡过去：${lastError ? lastError.message : '未知原因'}`);
    },
  },

  wait_for_day: {
    description:
      '在安全位置守到天亮：持续读取游戏时间，确认从夜晚/黄昏进入白天，期间每小时检查一次血量，超时会说明还没有天亮。',
    parameters: [
      {
        name: 'timeout_s',
        type: 'number',
        required: false,
        default: 240,
        description: '最长等待秒数，范围 10-280 秒；桥接单动作上限是 300 秒。',
      },
    ],
    handler: async (args, ctx) => {
      const bot = ctx.bot;
      if (!bot || !bot.entity) throw new Error('bot 还没进入世界，没有办法等天亮');
      assertNotInterrupted(ctx, '等待天亮');
      const timeoutS = clampNumber(args.timeout_s, 240, 10, 280);
      const startTime = Number(bot.time?.timeOfDay ?? -1);
      if (!Number.isFinite(startTime) || startTime < 0) throw new Error('读不到游戏时间，不能判断天亮');
      if (startTime < 12000) {
        return {
          detail: `现在已经是白天：第 ${bot.time?.day ?? 0} 天 ${clockText(ctx)}，血量 ${Number(bot.health ?? 20)}/20`,
          status: 'succeeded',
        };
      }
      const deadline = Date.now() + timeoutS * 1000;
      while (Date.now() < deadline) {
        assertNotInterrupted(ctx, '等待天亮');
        if (!bot.entity) throw new Error('等待天亮时 bot 掉出了世界');
        if (Number(bot.health ?? 20) <= 0) throw new Error('等待天亮时血量归零');
        const current = Number(bot.time?.timeOfDay ?? -1);
        if (!Number.isFinite(current) || current < 0) throw new Error('等待天亮时读不到游戏时间');
        if (current < 12000) {
          return {
            detail: `等到天亮：第 ${bot.time?.day ?? 0} 天 ${clockText(ctx)}，血量 ${Number(bot.health ?? 20)}/20，位置 ${positionText(ctx)}`,
            status: 'succeeded',
          };
        }
        await waitMs(ctx, 1000);
      }
      assertNotInterrupted(ctx, '等待天亮');
      const finalTime = Number(bot.time?.timeOfDay ?? -1);
      if (finalTime >= 0 && finalTime < 12000) {
        return {
          detail: `等到天亮：第 ${bot.time?.day ?? 0} 天 ${clockText(ctx)}，血量 ${Number(bot.health ?? 20)}/20`,
          status: 'succeeded',
        };
      }
      throw new Error(`等了 ${timeoutS} 秒还是夜晚（${clockText(ctx)}），没有等到天亮`);
    },
  },

  leave_shelter: {
    description:
      '从封闭庇护所里挖出一格宽、两格高的出口：先找一面外侧是空地的墙，挖掉脚下与头顶两格，再走到墙外并确认已经离开。',
    parameters: [
      {
        name: 'range',
        type: 'number',
        required: false,
        default: 3,
        description: '向外搜索墙面的最大距离，范围 1-3 格。',
      },
    ],
    handler: async (args, ctx) => {
      const bot = ctx.bot;
      if (!bot || !bot.entity) throw new Error('bot 还没进入世界，没有办法离开庇护所');
      const base = botPosition(ctx);
      if (!base) throw new Error('读不到 bot 的位置');
      const maxDistance = clampNumber(args.range, 3, 1, 3);
      const dirs = [
        { x: 1, z: 0 },
        { x: -1, z: 0 },
        { x: 0, z: 1 },
        { x: 0, z: -1 },
      ];
      let exit = null;
      for (const dir of dirs) {
        if (exit) break;
        for (let distance = 1; distance <= maxDistance; distance += 1) {
          const wallX = base.x + dir.x * distance;
          const wallZ = base.z + dir.z * distance;
          const wallFoot = blockAt(bot, wallX, base.y, wallZ);
          const wallHead = blockAt(bot, wallX, base.y + 1, wallZ);
          if (!isSolidBlock(wallFoot) || !isSolidBlock(wallHead)) continue;
          if (DANGER_BLOCKS.has(wallFoot.name) || DANGER_BLOCKS.has(wallHead.name)) continue;
          const outsideX = base.x + dir.x * (distance + 1);
          const outsideZ = base.z + dir.z * (distance + 1);
          const outsideFoot = blockAt(bot, outsideX, base.y, outsideZ);
          const outsideHead = blockAt(bot, outsideX, base.y + 1, outsideZ);
          const outsideGround = blockAt(bot, outsideX, base.y - 1, outsideZ);
          if (!isSolidBlock(outsideGround) || DANGER_BLOCKS.has(outsideGround.name)) continue;
          const clearable = [outsideFoot, outsideHead].every((block) =>
            isOpenSpace(block) || (isSolidBlock(block) && !DANGER_BLOCKS.has(block.name))
          );
          if (!clearable) continue;
          exit = {
            distance,
            dir,
            wallX,
            wallZ,
            outsideX,
            outsideZ,
            wallFoot,
            wallHead,
            outsideFoot,
            outsideHead,
          };
          break;
        }
      }
      if (!exit) {
        throw new Error(`附近 ${maxDistance} 格内没有找到外侧为空地的墙，可能不在庇护所里`);
      }
      if (typeof ctx.breakBlock !== 'function') throw new Error('桥接没有提供挖掘接口');
      assertNotInterrupted(ctx, '离开庇护所');
      for (const y of [base.y, base.y + 1]) {
        await ctx.breakBlock({ x: exit.wallX, y, z: exit.wallZ });
        assertNotInterrupted(ctx, '离开庇护所');
        for (let attempt = 0; attempt < 10; attempt += 1) {
          if (isOpenSpace(blockAt(bot, exit.wallX, y, exit.wallZ))) break;
          await waitMs(ctx, 100);
          assertNotInterrupted(ctx, '离开庇护所');
        }
        if (!isOpenSpace(blockAt(bot, exit.wallX, y, exit.wallZ))) {
          throw new Error(`挖开了 (${exit.wallX}, ${y}, ${exit.wallZ})，但方块还在`);
        }
      }
      for (const y of [base.y, base.y + 1]) {
        const block = blockAt(bot, exit.outsideX, y, exit.outsideZ);
        if (isOpenSpace(block)) continue;
        await ctx.breakBlock({ x: exit.outsideX, y, z: exit.outsideZ });
        assertNotInterrupted(ctx, '离开庇护所');
        for (let attempt = 0; attempt < 10; attempt += 1) {
          if (isOpenSpace(blockAt(bot, exit.outsideX, y, exit.outsideZ))) break;
          await waitMs(ctx, 100);
          assertNotInterrupted(ctx, '离开庇护所');
        }
        if (!isOpenSpace(blockAt(bot, exit.outsideX, y, exit.outsideZ))) {
          throw new Error(`清理墙外 (${exit.outsideX}, ${y}, ${exit.outsideZ}) 失败，方块仍然阻挡出口`);
        }
      }
      try {
        await ctx.travelTo(exit.outsideX, base.y, exit.outsideZ, 1);
      } catch (error) {
        throw new Error(`出口已经挖开，但从庇护所走到墙外失败：${error.message}`);
      }
      assertNotInterrupted(ctx, '离开庇护所');
      const finalPosition = botPosition(ctx);
      const outsideProgress = finalPosition
        ? (finalPosition.x - exit.wallX) * exit.dir.x + (finalPosition.z - exit.wallZ) * exit.dir.z
        : 0;
      const targetDistance = finalPosition
        ? Math.hypot(finalPosition.x - exit.outsideX, finalPosition.z - exit.outsideZ)
        : Infinity;
      if (outsideProgress < 1 || targetDistance > 2) {
        throw new Error('出口已经挖开，但没有验证到 bot 已经走到庇护所墙外');
      }
      if (
        !isOpenSpace(blockAt(bot, finalPosition.x, finalPosition.y, finalPosition.z)) ||
        !isOpenSpace(blockAt(bot, finalPosition.x, finalPosition.y + 1, finalPosition.z))
      ) {
        throw new Error('出口已经挖开，但 bot 墙外的位置没有通过两格净空检查');
      }
      return {
        detail: `在 (${exit.wallX}, ${base.y}, ${exit.wallZ}) 挖开两格高的出口，已走到墙外 (${exit.outsideX}, ${base.y}, ${exit.outsideZ})，位置 ${positionText(ctx)}`,
        status: 'succeeded',
      };
    },
  },

  flee_low_health: {
    description:
      '低血撤退：血量低于阈值或刚受伤时立刻远离威胁、找掩体、停下追击，并回报血量与位置。',
    parameters: [
      {
        name: 'threshold',
        type: 'number',
        required: false,
        default: 10,
        description: '血量低于该值就撤退，范围 1-20。',
      },
    ],
    handler: async (args, ctx) => {
      const bot = ctx.bot;
      if (!bot || !bot.entity) throw new Error('bot 还没进入世界，没有办法撤退');
      const threshold = clampNumber(args.threshold, 10, 1, 20);
      const tracker = trackDamage(bot);
      const health = Number(bot.health ?? 20);
      const hurtRecently = tracker ? Date.now() - tracker.lastHurtAt < 5000 : false;
      if (health >= threshold && !hurtRecently) {
        return {
          detail: `血量 ${health}/20，不低于阈值 ${threshold}，也没有刚受伤，不需要撤退`,
          status: 'succeeded',
        };
      }
      // 先停追击：把寻路和移动控制都松掉。
      try {
        if (bot.pathfinder && typeof bot.pathfinder.stop === 'function') bot.pathfinder.stop();
        if (typeof bot.clearControlStates === 'function') bot.clearControlStates();
      } catch (error) {
        logOf(ctx, '停下追击失败', error.message);
      }
      const threat = pickThreat(ctx, tracker);
      const notes = [];
      if (threat) {
        const before = distanceBetween(bot.entity.position, threat.position);
        await ctx.retreatFrom(threat);
        const after = distanceBetween(bot.entity.position, threat.position);
        notes.push(
          `已远离${entityLabelOf(ctx, threat)}（${before.toFixed(1)} 格 → ${after.toFixed(1)} 格）`
        );
      } else if (typeof ctx.escapeEnvironment === 'function') {
        await ctx.escapeEnvironment();
        notes.push('附近没有敌人，改为离开危险环境');
      } else {
        notes.push('附近没有敌人，也没有可用的避险动作');
      }
      const cover = await seekCover(ctx, threat);
      if (cover) notes.push(cover);
      if (typeof ctx.equipWeapon === 'function') {
        try {
          await ctx.equipWeapon();
          notes.push('已换上武器防身');
        } catch (error) {
          logOf(ctx, '换武器失败', error.message);
        }
      }
      const endHealth = Number(bot.health ?? 20);
      return {
        detail: `血量 ${endHealth}/20（阈值 ${threshold}），位置 ${positionText(ctx)}，${notes.join('，')}`,
        status: 'succeeded',
      };
    },
  },

  swim_out: {
    description: '落水自救：先恢复呼吸，再寻找并确认安全干地。',
    parameters: [
      { name: 'block_flow', type: 'boolean', required: false, default: false, description: '已确认矿道进水时，尝试在触及范围内用圆石封住单宽上游。' },
      {
        name: 'shallow_exit',
        type: 'boolean',
        required: false,
        default: false,
        description: '在干洞中复核浅水深度和近岸后，打开一格顶板上浮。',
      },
      {
        name: 'radius',
        type: 'number',
        required: false,
        default: 12,
        description: '局部出口搜索半径，最多搜索 8 格。',
      },
      {
        name: 'timeout',
        type: 'number',
        required: false,
        default: 30,
        description: '游上岸的超时秒数，范围 5-120 秒。',
      },
    ],
    handler: async (args, ctx) => {
      if (typeof ctx.swimToShore !== 'function') throw new Error('水中自救不可用');
      const timeoutMs = clampNumber(args.timeout, 25, 5, 120) * 1000;
      if (args.block_flow === true) {
        const bot = ctx.bot;
        const cells = shaftFlowBarrier(bot);
        if (cells.length && ctx.countItem('cobblestone') >= cells.length) {
          for (const p of cells) {
            const here = bot.entity.position;
            if (ctx.interrupted || here.distanceTo(p) >= 3.8 || (bot.oxygenLevel != null && bot.oxygenLevel < 12)
                || (Math.floor(here.x) === p.x && Math.floor(here.z) === p.z)) break;
            try {
              await ctx.placeBlock({block: 'cobblestone', x: p.x, y: p.y, z: p.z});
            } catch {
              if (ctx.interrupted) throw new Error('封水被打断');
              break;
            }
            if (bot.blockAt(p)?.name !== 'cobblestone') break;
          }
        }
      }
      if (args.shallow_exit === true && !waterLike(ctx.bot.blockAt(ctx.bot.entity.position))) {
        const bot = ctx.bot;
        const plan = shallowSurfaceExit(bot);
        if (!plan || ctx.interrupted || ctx.findHostile?.(10)) throw new Error('无法确认安全浅水出口和近岸');
        // 初次登录可能没有默认满氧的元数据包，使用服务端世界刻核对持续的干地呼吸。
        const startTick = bot.time.age;
        const started = Date.now();
        while (bot.oxygenLevel !== 20) {
          if (ctx.interrupted || !shallowSurfaceExit(bot) || ctx.findHostile?.(10) || Date.now() - started > 12000) {
            throw new Error('未确认有充足的空气上浮');
          }
          if (bot.oxygenLevel == null && Number.isFinite(startTick) && bot.time.age - startTick >= 100) break;
          await ctx.sleep(100);
        }
        const tool = bot.pathfinder?.bestHarvestTool(plan.roof);
        if (tool) await bot.equip(tool, 'hand');
        const fresh = shallowSurfaceExit(bot);
        if (!fresh || ctx.interrupted || !fresh.roof.position.equals(plan.roof.position)
            || fresh.surfaceY !== plan.surfaceY) throw new Error('浅水出口发生变化');
        await bot.dig(fresh.roof);
        const deadline = Date.now() + 8000;
        try {
          while (!ctx.interrupted && bot.entity && bot.health > 0 && Date.now() < deadline
                 && bot.entity.position.y < plan.surfaceY - 0.5) {
            bot.setControlState('jump', true);
            await ctx.sleep(100);
          }
        } finally {
          bot.setControlState('jump', false);
        }
        if (ctx.interrupted || !bot.entity || bot.health <= 0) throw new Error('浅水上行被打断');
      }
      if (!await ctx.swimToShore('主动水中自救', timeoutMs, clampNumber(args.radius, 12, 3, 32), args.shallow_exit === true)) {
        throw new Error('水中自救超时，未确认抵达安全岸边');
      }
      return { detail: '已确认抵达安全岸边', status: 'succeeded',
        data: {events: [args.shallow_exit === true ? 'connected_bank_reached' : 'dry_bank_reached']} };
    },
  },
};

/* ============================ 内部辅助 ============================ */

// 找最近的威胁：优先用刚才的伤害来源，其次找最近的敌对生物。
function pickThreat(ctx, tracker) {
  const source = tracker?.lastSource;
  if (source && source.position && source.isValid !== false) return source;
  if (typeof ctx.findHostile === 'function') {
    try {
      const hostile = ctx.findHostile(12);
      if (hostile) return hostile;
    } catch (error) {
      return null;
    }
  }
  return null;
}

// 找掩体：挑一块附近的实心方块，站到它背对威胁的一侧。
async function seekCover(ctx, threat) {
  const bot = ctx.bot;
  if (!bot || typeof bot.findBlocks !== 'function') return '';
  let blocks = [];
  try {
    blocks = bot.findBlocks({
      matching: (block) =>
        block && block.boundingBox === 'block' && !DANGER_BLOCKS.has(block.name),
      maxDistance: 8,
      count: 16,
    });
  } catch (error) {
    return '';
  }
  if (!blocks.length) return '附近没有可以躲的掩体';
  const block = blocks[0];
  const base = bot.entity.position;
  const from = threat && threat.position ? threat.position : base;
  const dx = block.position.x - from.x;
  const dz = block.position.z - from.z;
  const length = Math.hypot(dx, dz) || 1;
  const x = Math.floor(block.position.x + (dx / length) * 1.5);
  const z = Math.floor(block.position.z + (dz / length) * 1.5);
  const y = block.position.y + 1;
  try {
    await ctx.travelTo(x, y, z, 1);
    return `已躲到${blockLabelOf(ctx, block.name)}后面 (${x}, ${y}, ${z})`;
  } catch (error) {
    return `躲到掩体失败：${error.message}`;
  }
}

// 找最近的岸。
function findShore(ctx, radius) {
  if (typeof ctx.findShore === 'function') {
    try {
      const shore = ctx.findShore(radius);
      if (shore) return shore;
    } catch (error) {
      // 落到本地实现。
    }
  }
  const bot = ctx.bot;
  if (!bot || !bot.entity) return null;
  const base = bot.entity.position;
  for (let distance = 3; distance <= radius; distance += 2) {
    for (let step = 0; step < 8; step += 1) {
      const angle = (Math.PI * 2 * step) / 8;
      const x = Math.floor(base.x + Math.cos(angle) * distance);
      const z = Math.floor(base.z + Math.sin(angle) * distance);
      for (let dy = -1; dy <= 2; dy += 1) {
        const ground = blockAt(bot, x, Math.floor(base.y) + dy, z);
        if (!ground || ground.boundingBox !== 'block') continue;
        if (isWaterName(ground.name) || /lava/.test(ground.name)) continue;
        const above = blockAt(bot, x, Math.floor(base.y) + dy + 1, z);
        const above2 = blockAt(bot, x, Math.floor(base.y) + dy + 2, z);
        if (above?.boundingBox === 'empty' && above2?.boundingBox === 'empty') {
          return { position: { x, y: Math.floor(base.y) + dy + 1, z }, angle };
        }
      }
    }
  }
  return null;
}

// 往岸上划水。
async function swimOnce(ctx, shore, reason) {
  if (typeof ctx.swimToShore === 'function') {
    await ctx.swimToShore(reason);
    return;
  }
  const bot = ctx.bot;
  const base = bot.entity.position;
  const target = shore?.position || shore;
  const dx = (target?.x ?? base.x) - base.x;
  const dz = (target?.z ?? base.z) - base.z;
  try {
    await bot.look(Math.atan2(-dx, dz), 0, true);
    bot.setControlState('jump', true);
    bot.setControlState('forward', true);
    await waitMs(ctx, 1800);
  } catch (error) {
    logOf(ctx, '游泳失败', error.message);
  } finally {
    if (typeof bot.setControlState === 'function') bot.setControlState('forward', false);
  }
}
