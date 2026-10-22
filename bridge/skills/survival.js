// 生存模块：进食、封闭庇护所、安全过夜、低血撤退、落水自救。
// 契约见 docs/plans/SKILL_MODULE_CONTRACT.md，ctx 由 minecraft_bridge.js 的 buildSkillContext() 提供。
// 本模块只使用 ctx 上的能力，不 import 任何运行时依赖；ctx 里没有的可选能力一律 typeof 判断后再调用。

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
  if (Number(bot.time.day) !== Number(beforeDay)) return true;
  return Math.abs(Number(bot.time.timeOfDay) - Number(beforeTime)) >= 1000;
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

// 选庇护所中心：先试脚下，再试四周偏移。
function findShelterCenter(ctx, plan) {
  const base = botPosition(ctx);
  if (!base) return null;
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
  for (const [dx, dz] of offsets) {
    const center = { x: base.x + dx, y: groundY, z: base.z + dz };
    if (footprintOk(ctx, plan, center)) return center;
  }
  return null;
}

// 决定庇护所每一格用哪种方块；材料可以混用，不够时直接报错说明缺多少。
function resolveShelterMaterials(ctx, plan, requested) {
  const needed = plan.blockCount;
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
    if (!isSolidBlock(block)) missing.push(`${center.x + cell.x},${center.y + cell.y},${center.z + cell.z}`);
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
// 这张图要放在庇护所内部，所以周围九格都会检查，不会把床放到墙外。
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
      // 床头的朝向可能被服务端反向解释，两个方向都要空。
      const back = { x: foot.x - dir.x, y: foot.y, z: foot.z - dir.z };
      if (!isOpenSpace(blockAt(bot, back.x, back.y, back.z))) continue;
      if (!isOpenSpace(blockAt(bot, back.x, back.y + 1, back.z))) continue;
      return { foot, head, dir };
    }
  }
  return null;
}

// 水平放床：不能复用普通方块放置，床的朝向由视角决定，必须逐格验证床脚和床头。
async function placeBedItem(ctx, bedItem) {
  const bot = ctx.bot;
  if (!bot || !bot.entity) throw new Error('没有 bot 实例，不能放床');
  const item = inventoryItems(ctx).find((entry) => entry.name === bedItem);
  if (!item) throw new Error(`背包里没有${blockLabelOf(ctx, bedItem)}`);
  const spot = findBedSpot(ctx);
  if (!spot) {
    throw new Error('附近没有能放床的地方：床脚和床头都要两格空位，庇护所内部至少留出 2×2 空间');
  }
  const support = blockAt(bot, spot.foot.x, spot.foot.y - 1, spot.foot.z);
  if (!isSolidBlock(support)) throw new Error('床脚下面没有支撑方块');

  await bot.equip(item, 'hand');
  // 让床头朝向 dir；服务端也可能反向解释，下面会同时验收两个方向。
  const yaw = Math.atan2(spot.dir.x, -spot.dir.z);
  if (typeof ctx.placeBlockWithFacing === 'function') {
    await ctx.placeBlockWithFacing(bedItem, makeVec(bot, spot.foot.x, spot.foot.y, spot.foot.z), yaw);
  } else if (typeof ctx.placeBlock === 'function') {
    await ctx.placeBlock({ block: bedItem, x: spot.foot.x, y: spot.foot.y, z: spot.foot.z });
  } else {
    throw new Error('桥接没有提供放床接口');
  }

  let footBlock = null;
  let headBlock = null;
  let reverse = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    footBlock = blockAt(bot, spot.foot.x, spot.foot.y, spot.foot.z);
    headBlock = blockAt(bot, spot.head.x, spot.head.y, spot.head.z);
    reverse = blockAt(bot, spot.foot.x - spot.dir.x, spot.foot.y, spot.foot.z - spot.dir.z);
    if (isBedBlock(footBlock) && (isBedBlock(headBlock) || isBedBlock(reverse))) break;
    await waitMs(ctx, 100);
  }
  if (!isBedBlock(footBlock)) {
    throw new Error(`床放下后 (${spot.foot.x}, ${spot.foot.y}, ${spot.foot.z}) 不是床，而是${footBlock ? footBlock.name : '空气'}`);
  }
  if (!isBedBlock(headBlock) && !isBedBlock(reverse)) {
    throw new Error('床只放下了一半，床头那一格不是床');
  }
  return {
    item: bedItem,
    foot: spot.foot,
    head: isBedBlock(headBlock) ? headBlock : reverse,
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
    await waitMs(ctx, 250);
  }
  return !bot.isSleeping;
}

/* ============================ 技能 ============================ */

export const skills = {
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
      const center = findShelterCenter(ctx, plan);
      if (!center) {
        throw new Error(`附近没有 ${size}×${size} 的平地，缺少可以搭庇护所的地面`);
      }
      const requestedBlock = String(args.block || '').trim();
      const materials = resolveShelterMaterials(ctx, plan, requestedBlock);
      const queue = materialQueue(materials);
      // 站到中心，保证所有格子都在够得到的距离内。
      const standing = botPosition(ctx);
      if (!standing || standing.x !== center.x || standing.z !== center.z) {
        try {
          await ctx.travelTo(center.x, center.y + 1, center.z, 1);
        } catch (error) {
          throw new Error(`走不到庇护所中心 (${center.x}, ${center.y + 1}, ${center.z})：${error.message}`);
        }
      }
      let placed = 0;
      let reused = 0;
      const used = new Map();
      for (const cell of plan.blocks) {
        const x = center.x + cell.x;
        const y = center.y + cell.y;
        const z = center.z + cell.z;
        const existing = blockAt(bot, x, y, z);
        if (isSolidBlock(existing) && !DANGER_BLOCKS.has(existing.name)) {
          reused += 1;
          continue;
        }
        if (!isOpenSpace(existing)) {
          throw new Error(`庇护所目标位置 (${x}, ${y}, ${z}) 被${existing ? existing.name : '未知方块'}占住，不能继续搭`);
        }
        const material = queue.shift();
        if (!material) {
          throw new Error(`材料队列提前用完，无法补上 (${x}, ${y}, ${z}) 这一格`);
        }
        try {
          await ctx.placeBlock({ block: material, x, y, z });
        } catch (error) {
          throw new Error(
            `在 (${x}, ${y}, ${z}) 放置${blockLabelOf(ctx, material)}失败：${error.message}`
          );
        }
        const confirmed = blockAt(bot, x, y, z);
        if (!confirmed || confirmed.name !== material) {
          throw new Error(
            `在 (${x}, ${y}, ${z}) 放置${blockLabelOf(ctx, material)}失败：放完位置还是空的`
          );
        }
        placed += 1;
        used.set(material, (used.get(material) || 0) + 1);
      }
      assertShelterSealed(ctx, plan, center);
      const usedMaterials = [...used.entries()].map(([name, count]) => ({ name, count }));
      const usedText = usedMaterials.length ? materialSummary(ctx, usedMaterials) : '已有方块';
      logOf(ctx, '搭庇护所', `${size}×${size}，新放 ${placed} 格，复用 ${reused} 格：${usedText}`);
      return {
        detail: `在 (${center.x}, ${center.y}, ${center.z}) 搭好了 ${size}×${size} 全封闭庇护所，墙体与屋顶已逐格验收；新放 ${placed} 格，复用 ${reused} 格，材料：${usedText}`,
        status: 'succeeded',
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
      const nightOk =
        typeof ctx.isSleepTime === 'function' ? Boolean(ctx.isSleepTime()) : isNight(bot);
      const stormOk =
        typeof ctx.isThunderstorm === 'function' ? Boolean(ctx.isThunderstorm()) : isThunderstorm(bot);
      if (!nightOk && !stormOk) {
        throw new Error(
          `现在是 ${clockText(ctx)}，不是夜晚也没有雷暴，不能睡觉`
        );
      }
      if (bot.isSleeping) {
        const left = await waitLeaveBed(ctx, 15000);
        if (!left) throw new Error('已经在睡觉，但一直没有离开床');
        return {
          detail: `本来就在睡，现在已经醒在第 ${bot.time?.day ?? 0} 天 ${clockText(ctx)}`,
          status: 'succeeded',
        };
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
          const text = await ctx.sleepInBed();
          const advanced =
            typeof ctx.sleepAdvancedTime === 'function'
              ? Boolean(ctx.sleepAdvancedTime(beforeTime, beforeDay))
              : timeAdvanced(beforeTime, beforeDay, bot);
          if (!advanced) {
            throw new Error('躺下后游戏时间没有推进，没有跳过这一夜');
          }
          const left = await waitLeaveBed(ctx);
          if (!left) throw new Error('天亮了，但没有离开床，还在床上');
          return {
            detail: `睡过去了：${text}。床在 ${bedText}，现在是第 ${bot.time?.day ?? 0} 天 ${clockText(ctx)}，已经离开床`,
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
          if (!isOpenSpace(outsideFoot) || !isOpenSpace(outsideHead)) continue;
          exit = { distance, wallX, wallZ, outsideX, outsideZ, wallFoot, wallHead };
          break;
        }
      }
      if (!exit) {
        throw new Error(`附近 ${maxDistance} 格内没有找到外侧为空地的墙，可能不在庇护所里`);
      }
      if (typeof ctx.breakBlock !== 'function') throw new Error('桥接没有提供挖掘接口');
      for (const y of [base.y, base.y + 1]) {
        await ctx.breakBlock({ x: exit.wallX, y, z: exit.wallZ });
        for (let attempt = 0; attempt < 10; attempt += 1) {
          if (isOpenSpace(blockAt(bot, exit.wallX, y, exit.wallZ))) break;
          await waitMs(ctx, 100);
        }
        if (!isOpenSpace(blockAt(bot, exit.wallX, y, exit.wallZ))) {
          throw new Error(`挖开了 (${exit.wallX}, ${y}, ${exit.wallZ})，但方块还在`);
        }
      }
      try {
        await ctx.travelTo(exit.outsideX, base.y, exit.outsideZ, 1);
      } catch (error) {
        throw new Error(`出口已经挖开，但从庇护所走到墙外失败：${error.message}`);
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
    description: '落水自救：发现脚下是水就朝最近的岸边游，上岸后回报位置。',
    parameters: [
      {
        name: 'radius',
        type: 'number',
        required: false,
        default: 12,
        description: '找岸的搜索半径，范围 3-32 格。',
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
      const bot = ctx.bot;
      if (!bot || !bot.entity) throw new Error('bot 还没进入世界，没有办法判断有没有落水');
      const radius = clampNumber(args.radius, 12, 3, 32);
      const timeoutMs = clampNumber(args.timeout, 30, 5, 120) * 1000;
      if (!isInWater(bot)) {
        return {
          detail: `现在不在水里，位置 ${positionText(ctx)}`,
          status: 'succeeded',
        };
      }
      const shore = findShore(ctx, radius);
      if (!shore) throw new Error(`附近 ${radius} 格内没有岸，找不到能游过去的地方`);
      const oxygen = Number(bot.oxygenLevel ?? 20);
      const deadline = Date.now() + timeoutMs;
      let rounds = 0;
      while (Date.now() < deadline && isInWater(bot)) {
        rounds += 1;
        await swimOnce(ctx, shore, '落水自救');
      }
      if (isInWater(bot)) {
        throw new Error(
          `还在水里，没能上岸（游了 ${rounds} 轮，附近 ${radius} 格内没有岸）`
        );
      }
      return {
        detail: `游上岸了，用了 ${rounds} 轮，位置 ${positionText(ctx)}，上岸前氧气 ${oxygen}/20`,
        status: 'succeeded',
      };
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
