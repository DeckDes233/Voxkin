// 合成与冶炼模块：批量熔炼、按套装合成工具、成组放火把、合成与放置床。
// 契约见 docs/plans/SKILL_MODULE_CONTRACT.md。
//
// 设计原则：合成窗口协议由 ctx.craftItem / ctx.smeltItem 负责（已在真实服务器验证过），
// 本模块只做编排：材料核算 → 中间件 → 成品 → 放置 → 校验。
//
// 待接入（集成阶段补进 ctx，模块里已做降级）：
// - placeBlockWithFacing(x, y, z, dir)：带朝向放置方块。床必须水平放置，
//   ctx.placeBlock 没有朝向参数，这里退化成直接用 ctx.bot 的放置接口。
// - lookAt：转向能力。床的床头朝向取决于 bot 的朝向，这里直接用 ctx.bot.lookAt。
//
// 错误关键词与状态映射（对应 minecraft_bridge.js 的 statusForError）：
// - 「材料不够，还差 N 个 X」→ partial
// - 「没有 X」「不知道 X」→ blocked
// - 「被新的指令打断」→ cancelled

// 熔炼配方：原料 id → 产物 id。
// 原版里 iron_ore 与 deepslate_iron_ore 挖出来的是 raw_iron，
// 熔炉只收 raw_iron，所以表里只登记 raw_iron。
export const SMELT_MAP = {
  raw_iron: 'iron_ingot',
  raw_gold: 'gold_ingot',
  raw_copper: 'copper_ingot',
  cobblestone: 'stone',
  sand: 'glass',
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  mutton: 'cooked_mutton',
  chicken: 'cooked_chicken',
  potato: 'baked_potato',
  clay_ball: 'brick',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
};

// 1 个燃料能烧几个物品。煤与木炭烧 8 个，木板烧 1.5 个。
// 木棍不在这张表里：ctx.smeltItem 对木棍用的还是 1.5 的算法，
// 而原版木棍只烧 0.5 个，算出来的燃料量不够烧完一轮，会白白等 90 秒。
export const FUEL_BURN = {
  coal: 8,
  charcoal: 8,
  oak_planks: 1.5,
  spruce_planks: 1.5,
  birch_planks: 1.5,
  jungle_planks: 1.5,
  acacia_planks: 1.5,
  dark_oak_planks: 1.5,
  mangrove_planks: 1.5,
  cherry_planks: 1.5,
  bamboo_planks: 1.5,
  crimson_planks: 1.5,
  warped_planks: 1.5,
};

// 熔炼一轮最多烧几个。熔炉每 10 秒烧一个，8 个约 80 秒，
// 压在 ctx.smeltItem 的 90 秒等待上限之内。
export const SMELT_ROUND_LIMIT = 8;

// 中间件的折算关系：原木 → 木板 → 木棍。
// consume 是 1 次合成要几个直接原料，yield 是 1 次合成出几个成品，
// rawYield 是 1 个原木能折出几个直接原料，rawPer 是 1 次原木合成要几个原木。
export const CRAFT_CHAINS = {
  planks: {
    consume: 1,
    yield: 4,
    rawYield: 1,
    rawPer: 1,
    sources: [
      { plank: 'oak_planks', log: 'oak_log' },
      { plank: 'spruce_planks', log: 'spruce_log' },
      { plank: 'birch_planks', log: 'birch_log' },
      { plank: 'jungle_planks', log: 'jungle_log' },
      { plank: 'acacia_planks', log: 'acacia_log' },
      { plank: 'dark_oak_planks', log: 'dark_oak_log' },
      { plank: 'mangrove_planks', log: 'mangrove_log' },
      { plank: 'cherry_planks', log: 'cherry_log' },
    ],
  },
  stick: {
    consume: 2,
    yield: 4,
    rawYield: 4,
    rawPer: 1,
    sources: [
      { plank: 'oak_planks', log: 'oak_log' },
      { plank: 'spruce_planks', log: 'spruce_log' },
      { plank: 'birch_planks', log: 'birch_log' },
      { plank: 'jungle_planks', log: 'jungle_log' },
      { plank: 'acacia_planks', log: 'acacia_log' },
      { plank: 'dark_oak_planks', log: 'dark_oak_log' },
      { plank: 'mangrove_planks', log: 'mangrove_log' },
      { plank: 'cherry_planks', log: 'cherry_log' },
    ],
  },
};

// 套装定义：成品 → 基础原料。chain 标出来的是要现做出来的中间件。
export const TOOL_SETS = {
  stone: {
    label: '石制套件',
    items: [
      {
        item: 'stone_pickaxe',
        count: 1,
        inputs: [
          { item: 'cobblestone', count: 3 },
          { item: 'stick', count: 2, chain: 'stick' },
        ],
      },
      {
        item: 'stone_sword',
        count: 1,
        inputs: [
          { item: 'cobblestone', count: 2 },
          { item: 'stick', count: 1, chain: 'stick' },
        ],
      },
      {
        item: 'furnace',
        count: 1,
        inputs: [{ item: 'cobblestone', count: 8 }],
      },
    ],
  },
  iron: {
    label: '铁制套件',
    items: [
      {
        item: 'iron_pickaxe',
        count: 1,
        inputs: [
          { item: 'iron_ingot', count: 3 },
          { item: 'stick', count: 2, chain: 'stick' },
        ],
      },
      {
        item: 'iron_sword',
        count: 1,
        inputs: [
          { item: 'iron_ingot', count: 2 },
          { item: 'stick', count: 1, chain: 'stick' },
        ],
      },
      {
        item: 'shield',
        count: 1,
        inputs: [
          { item: 'iron_ingot', count: 6 },
          { item: 'planks', count: 1, chain: 'planks' },
        ],
      },
    ],
  },
  diamond: {
    label: '钻石套件',
    items: [
      {
        item: 'diamond_pickaxe',
        count: 1,
        inputs: [
          { item: 'diamond', count: 3 },
          { item: 'stick', count: 2, chain: 'stick' },
        ],
      },
    ],
  },
  shield: {
    label: '盾牌',
    items: [
      {
        item: 'shield',
        count: 1,
        inputs: [
          { item: 'iron_ingot', count: 6 },
          { item: 'planks', count: 1, chain: 'planks' },
        ],
      },
    ],
  },
  furnace: {
    label: '熔炉',
    items: [
      {
        item: 'furnace',
        count: 1,
        inputs: [{ item: 'cobblestone', count: 8 }],
      },
    ],
  },
};

// 床的颜色。床与羊毛都是方块物品，id 由颜色拼出来。
export const BED_COLORS = [
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black',
];

// 熔炼 count 个物品需要多少个燃料。
export function fuelNeeded(count, fuelName = 'coal') {
  const burn = FUEL_BURN[fuelName] || FUEL_BURN.coal;
  const amount = Math.max(1, Number(count) || 1);
  return Math.max(1, Math.ceil(amount / burn));
}

// 批量熔炼时每一轮都要单独加一次燃料，燃料量要按轮累加。
export function fuelNeededForRounds(rounds, fuelName = 'coal') {
  let total = 0;
  for (const size of rounds) total += fuelNeeded(size, fuelName);
  return total;
}

// 把熔炼数量拆成若干轮，每轮不超过 limit 个。
export function smeltRounds(count, limit = SMELT_ROUND_LIMIT) {
  const total = Math.max(1, Number(count) || 1);
  const size = Math.max(1, Number(limit) || SMELT_ROUND_LIMIT);
  const rounds = [];
  let left = total;
  while (left > 0) {
    const take = Math.min(left, size);
    rounds.push(take);
    left -= take;
  }
  return rounds;
}

// 折算一条中间件链要多少原料。
// crafts 是要合成几次，inputs 是直接原料个数，raws 是最基础原料个数。
export function chainCost(chain, need) {
  const amount = Math.max(1, Number(need) || 1);
  const crafts = Math.ceil(amount / (chain.yield || 1));
  const inputs = crafts * (chain.consume || 1);
  const rawCrafts = Math.ceil(inputs / (chain.rawYield || 1));
  return { crafts, inputs, raws: rawCrafts * (chain.rawPer || 1) };
}

// 对照库存算一份材料还差什么。
// recipe 可以是 { inputs: [...] } 或直接的数组；have 是 { 物品 id: 数量 }，也接受 Map。
export function missingFor(recipe, have) {
  const list = Array.isArray(recipe) ? recipe : (recipe && recipe.inputs) || [];
  const stock = (name) => {
    if (!have) return 0;
    if (typeof have.get === 'function') return Number(have.get(name)) || 0;
    return Number(have[name]) || 0;
  };
  const missing = [];
  for (const entry of list) {
    if (!entry || !entry.item) continue;
    const need = Math.max(1, Number(entry.count) || 1);
    const owned = stock(entry.item);
    if (owned < need) {
      missing.push({ item: entry.item, need, have: owned, missing: need - owned });
    }
  }
  return missing;
}

// 缺料时拼一句中文，带「还差」关键词，状态会映射成 partial。
export function shortageText(ctx, entry) {
  return `还差 ${entry.missing} 个${labelOf(ctx, entry.item)}`;
}

// ===== 内部工具 =====

// 物品中文名：先问 itemLabel，再退到 blockLabel，最后用原 id。
function labelOf(ctx, name) {
  const text = String(name || '');
  if (typeof ctx.itemLabel === 'function') {
    const label = ctx.itemLabel(text);
    if (label && label !== text) return label;
  }
  if (typeof ctx.blockLabel === 'function') {
    const label = ctx.blockLabel(text);
    if (label && label !== text) return label;
  }
  return text;
}

// 背包里某物品的数量。
function countOf(ctx, name) {
  if (typeof ctx.countItem !== 'function') return 0;
  const value = Number(ctx.countItem(name));
  return Number.isFinite(value) ? value : 0;
}

// registry 快捷访问，拿不到就退到 bot.registry。
function registryOf(ctx) {
  if (ctx.registry) return ctx.registry;
  if (ctx.bot && ctx.bot.registry) return ctx.bot.registry;
  return null;
}

// registry 里的物品条目。
function registryItem(ctx, name) {
  const registry = registryOf(ctx);
  if (!registry || !registry.itemsByName) return null;
  return registry.itemsByName[name] || null;
}

// 桥接日志，ctx 里没有 log 时就安静跳过。
function logOf(ctx, ...args) {
  if (typeof ctx.log === 'function') ctx.log(...args);
}

// 延时，ctx 里没有 sleep 时退到 setTimeout。
function sleepOf(ctx, ms) {
  if (typeof ctx.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 参数取正整数。
function toCount(value, fallback = 1, max = 64) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

// 参数取布尔值，字符串 'false' 也要当假。
function toBool(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  return fallback;
}

// 空气方块判定：火把这类小方块在 prismarine 里也是 empty，只能按名字判。
function isAir(block) {
  if (!block) return true;
  return block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
}

// 完整方块判定，火把要站在这样的方块上。
function isSolid(block) {
  return Boolean(block) && block.boundingBox === 'block';
}

// 床家族判定：bed 与各种颜色变体 red_bed 都算。
function isBedBlock(block) {
  if (!block || !block.name) return false;
  return block.name === 'bed' || block.name.endsWith('_bed');
}

// 放置接口要的是「单位方向向量」，不是绝对坐标。
// prismarine 的 Block.position 是 Vec3，用 offset 减原位就能拿到方向向量。
function faceVector(reference, dx, dy, dz) {
  const position = reference && reference.position;
  if (position && typeof position.offset === 'function' && typeof position.minus === 'function') {
    return position.offset(dx, dy, dz).minus(position);
  }
  return { x: dx, y: dy, z: dz };
}

// 找一把最顺手的燃料。必须跟 ctx.smeltItem 里的 findFuelItem 选到同一个，
// 否则核算出来的燃料量和熔炉真正烧的燃料对不上。
function pickFuel(ctx) {
  if (typeof ctx.findFuelItem !== 'function') return null;
  const fuel = ctx.findFuelItem();
  if (!fuel || !fuel.name || !FUEL_BURN[fuel.name]) return null;
  return { name: fuel.name, burn: FUEL_BURN[fuel.name] };
}

// 木板需求怎么补：先用现成木板，不够就用原木换。
// 合成窗口是按配方逐种摆材料的，所以同一种木板要一次凑齐，不能几种木头凑数。
function resolvePlanks(ctx, need) {
  if (need <= 0) return { plank: null, planks: 0, log: null, logs: 0 };
  const chain = CRAFT_CHAINS.planks;
  let bestPlank = null;
  let bestPlankCount = 0;
  for (const entry of chain.sources) {
    const stock = countOf(ctx, entry.plank);
    if (stock > bestPlankCount) {
      bestPlankCount = stock;
      bestPlank = entry.plank;
    }
  }
  if (bestPlankCount >= need) {
    return { plank: bestPlank, planks: need, log: null, logs: 0 };
  }
  const logs = chainCost(chain, need).raws;
  let bestLog = null;
  let bestLogCount = 0;
  for (const entry of chain.sources) {
    const stock = countOf(ctx, entry.log);
    if (stock > bestLogCount) {
      bestLogCount = stock;
      bestLog = entry.log;
    }
  }
  if (bestLogCount >= logs) {
    return { plank: bestLog.replace('_log', '_planks'), planks: need, log: bestLog, logs };
  }
  return null;
}

// 木棍需求怎么补：现成木棍 → 现成木板 → 原木。
function resolveSticks(ctx, need) {
  if (need <= 0) return { sticks: 0, planks: 0, plank: null, logs: 0, log: null };
  const chain = CRAFT_CHAINS.stick;
  const have = countOf(ctx, 'stick');
  const missing = Math.max(0, need - have);
  if (missing === 0) {
    return { sticks: 0, planks: 0, plank: null, logs: 0, log: null, have };
  }
  const planks = chainCost(chain, missing).inputs;
  const logs = chainCost(chain, missing).raws;
  for (const entry of chain.sources) {
    if (countOf(ctx, entry.plank) >= planks) {
      return { sticks: missing, planks, plank: entry.plank, logs: 0, log: null, have };
    }
  }
  for (const entry of chain.sources) {
    if (countOf(ctx, entry.log) >= logs) {
      return { sticks: missing, planks, plank: entry.plank, logs, log: entry.log, have };
    }
  }
  return null;
}

// 做中间件：原木 → 木板 → 木棍。顺序不能反，木棍要先有木板。
// 注意 count 给的是「要几个成品」而不是「要几个原料」：
// 合成原木出木板时给 5 个木板，桥接会合成两次，够 8 个木板出来，
// 用的原木数正好是 ceil(5 / 4)，和 resolvePlanks 核过的原木数一致。
async function buildWood(ctx, plan) {
  const made = [];
  if (plan.log && plan.logs > 0) {
    made.push(await ctx.craftItem({ item: plan.log, count: plan.planks }));
  }
  if (plan.sticks > 0) {
    made.push(await ctx.craftItem({ item: 'stick', count: plan.sticks }));
  }
  return made;
}

// 背包里最多的那种木板与原木各有多少，缺料时用来说清数字。
function bestWoodStock(ctx) {
  let plank = 0;
  let log = 0;
  for (const entry of CRAFT_CHAINS.planks.sources) {
    plank = Math.max(plank, countOf(ctx, entry.plank));
    log = Math.max(log, countOf(ctx, entry.log));
  }
  return { plank, log };
}

// 木板与木棍一起规划：直接要用的木板加上折木棍要用的木板，要一次凑齐同一种。
// 合成窗口是按配方逐种摆材料的，混着几种木头凑数是凑不出来的。
function planWood(ctx, plankNeed, stickNeed) {
  const haveStick = countOf(ctx, 'stick');
  const stickMissing = Math.max(0, stickNeed - haveStick);
  const stickCost = stickMissing
    ? chainCost(CRAFT_CHAINS.stick, stickMissing)
    : { crafts: 0, inputs: 0, raws: 0 };
  const totalPlanks = plankNeed + stickCost.inputs;
  return {
    haveStick,
    stickMissing,
    stickCost,
    plankNeed,
    totalPlanks,
    plankPlan: resolvePlanks(ctx, totalPlanks),
  };
}

// 把套装展开成原料需求，顺便算清中间件怎么补、还差什么。
function planSet(ctx, steps) {
  const direct = new Map();
  let stickNeed = 0;
  let plankNeed = 0;
  for (const step of steps) {
    for (const input of step.inputs) {
      const total = input.count * step.count;
      if (input.chain === 'stick') stickNeed += total;
      else if (input.chain === 'planks') plankNeed += total;
      else direct.set(input.item, (direct.get(input.item) || 0) + total);
    }
  }

  const shortages = [];
  const have = {};
  for (const [item, need] of direct) {
    have[item] = countOf(ctx, item);
  }
  const directInputs = [...direct.entries()].map(([item, count]) => ({ item, count }));
  for (const entry of missingFor({ inputs: directInputs }, have)) {
    shortages.push(shortageText(ctx, entry));
  }

  const wood = planWood(ctx, plankNeed, stickNeed);
  if (!wood.plankPlan) {
    const stock = bestWoodStock(ctx);
    if (plankNeed > 0) {
      shortages.push(
        `还差 ${Math.max(1, wood.totalPlanks - stock.plank)} 个木板` +
        `（要 ${wood.totalPlanks} 个同种木板或 ${chainCost(CRAFT_CHAINS.planks, wood.totalPlanks).raws} 个原木）`
      );
    }
    if (wood.stickMissing > 0) {
      shortages.push(
        `还差 ${wood.stickMissing} 个木棍` +
        `（要 ${wood.stickCost.inputs} 个木板或 ${wood.stickCost.raws} 个原木）`
      );
    }
  }
  return { shortages, wood, direct };
}

// 回收自己放下的熔炉：挖掉并捡回来。
async function recoverFurnace(ctx, furnace) {
  const position = furnace.position;
  try {
    if (typeof ctx.breakBlock === 'function') {
      await ctx.breakBlock({ x: position.x, y: position.y, z: position.z });
    } else if (ctx.bot && typeof ctx.bot.dig === 'function') {
      await ctx.bot.dig(furnace);
    } else {
      return;
    }
  } catch (error) {
    logOf(ctx, '回收熔炉失败', error.message);
    return;
  }
  if (typeof ctx.collectDrops === 'function') {
    try {
      await ctx.collectDrops(4, 'furnace');
    } catch (error) {
      logOf(ctx, '捡熔炉失败', error.message);
    }
  }
}

// ===== 技能 =====

// 火把要站在完整方块上：找一格既能放火把、脚下又有支撑的位置。
function torchHeight(ctx, x, z, feetY) {
  const bot = ctx.bot;
  if (!bot || typeof bot.blockAt !== 'function') return null;
  for (const y of [feetY, feetY + 1]) {
    if (!isSolid(bot.blockAt(x, y - 1, z))) continue;
    if (!isAir(bot.blockAt(x, y, z))) continue;
    if (!isAir(bot.blockAt(x, y + 1, z))) continue;
    return y;
  }
  return null;
}

// 按间距在面前排一排火把位，从近到远排，放置时不用来回跑。
function torchSpots(ctx, need, spacing) {
  const bot = ctx.bot;
  if (!bot || !bot.entity || typeof bot.blockAt !== 'function') return [];
  const base = bot.entity.position;
  const feetY = Math.floor(base.y);
  const yaw = Number(bot.entity.yaw) || 0;
  const forwardX = -Math.sin(yaw);
  const forwardZ = Math.cos(yaw);
  const axis =
    Math.abs(forwardX) >= Math.abs(forwardZ)
      ? { x: Math.sign(forwardX) || 1, z: 0 }
      : { x: 0, z: Math.sign(forwardZ) || 1 };
  const sides =
    axis.x !== 0 ? [{ x: 0, z: 1 }, { x: 0, z: -1 }] : [{ x: 1, z: 0 }, { x: -1, z: 0 }];
  const spots = [];
  for (const side of sides) {
    for (let step = 1; step <= need + 2 && spots.length < need; step += 1) {
      const x = Math.floor(base.x) + axis.x * step * spacing + side.x;
      const z = Math.floor(base.z) + axis.z * step * spacing + side.z;
      const y = torchHeight(ctx, x, z, feetY);
      if (y !== null) spots.push({ x, y, z });
    }
    if (spots.length >= need) break;
  }
  return spots;
}

// 放一个火把：火把只能贴在下方方块的顶面上。
// ctx.placeBlock 没有朝向参数，会按六面依次试，贴错面会被服务端拒绝还要等超时，
// 这里直接用 ctx.bot 贴顶面，位置与支撑方块都是算好的。
async function placeTorch(ctx, spot) {
  const bot = ctx.bot;
  if (!bot || typeof bot.blockAt !== 'function') {
    throw new Error('没有 bot 实例，不能放火把');
  }
  const support = bot.blockAt(spot.x, spot.y - 1, spot.z);
  if (!isSolid(support)) throw new Error('火把下面没有支撑方块');

  // 太远够不着，先走过去。
  const distance = bot.entity.position.distanceTo
    ? bot.entity.position.distanceTo(support.position)
    : 0;
  if (distance > 3.5 && typeof ctx.travelTo === 'function') {
    await ctx.travelTo(spot.x, spot.y, spot.z, 2);
  }

  if (typeof bot.placeBlock !== 'function') {
    if (typeof ctx.placeBlock !== 'function') throw new Error('桥接没有提供放置方块的接口');
    await ctx.placeBlock({ block: 'torch', x: spot.x, y: spot.y, z: spot.z });
    return;
  }
  const item = bot.inventory.items().find((entry) => entry.name === 'torch');
  if (item && typeof bot.equip === 'function') await bot.equip(item, 'hand');
  await bot.placeBlock(support, faceVector(support, 0, 1, 0));
  const placed = bot.blockAt(spot.x, spot.y, spot.z);
  if (!placed || placed.name !== 'torch') throw new Error('放下去的位置看不到火把');
}

// 找一个能放床的位置：床脚与床头两格都要空，床脚下面要有完整方块。
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
    if (!isSolid(bot.blockAt(foot.x, foot.y - 1, foot.z))) continue;
    if (!isAir(bot.blockAt(foot.x, foot.y, foot.z))) continue;
    if (!isAir(bot.blockAt(foot.x, foot.y + 1, foot.z))) continue;
    for (const dir of dirs) {
      const head = { x: foot.x + dir.x, y: foot.y, z: foot.z + dir.z };
      if (!isAir(bot.blockAt(head.x, head.y, head.z))) continue;
      if (!isAir(bot.blockAt(head.x, head.y + 1, head.z))) continue;
      // 床头最终落在哪一侧取决于 bot 的朝向，两侧都得留空，
      // 不然服务端会因为放不下床头而拒绝这次放置。
      const back = { x: foot.x - dir.x, y: foot.y, z: foot.z - dir.z };
      if (!isAir(bot.blockAt(back.x, back.y, back.z))) continue;
      if (!isAir(bot.blockAt(back.x, back.y + 1, back.z))) continue;
      return { foot, head, dir };
    }
  }
  return null;
}

// 水平放一张床：床是方块物品，必须横着放，放完还要确认那两格确实是床。
async function placeBed(ctx, bedItem) {
  const bot = ctx.bot;
  if (!bot || !bot.entity) throw new Error('没有 bot 实例，不能放床');
  const item = bot.inventory.items().find((entry) => entry.name === bedItem);
  if (!item) throw new Error(`背包里没有${labelOf(ctx, bedItem)}`);
  const spot = findBedSpot(ctx);
  if (!spot) {
    throw new Error('附近没有能放床的地方：床脚和床头都要空，床脚下面还要有支撑方块');
  }
  const support = bot.blockAt(spot.foot.x, spot.foot.y - 1, spot.foot.z);
  if (!support) throw new Error('床脚下面没有支撑方块');

  await bot.equip(item, 'hand');
  // 原版把床头放在朝向的反方向，所以先转向 -(dir)，床头才落在 dir 上。
  const yaw = Math.atan2(spot.dir.x, -spot.dir.z);
  bot.entity.yaw = yaw;
  bot.entity.pitch = 0;
  if (typeof bot.lookAt === 'function') {
    await bot.lookAt(bot.entity.position.offset(-spot.dir.x * 3, 0, -spot.dir.z * 3), true);
  }
  await sleepOf(ctx, 150);
  const face = faceVector(support, 0, 1, 0);
  if (typeof bot._placeBlockWithOptions === 'function') {
    await bot._placeBlockWithOptions(support, face, { swingArm: 'right', forceLook: 'ignore' });
  } else {
    bot.entity.yaw = yaw;
    await bot.placeBlock(support, face);
  }

  const footBlock = bot.blockAt(spot.foot.x, spot.foot.y, spot.foot.z);
  if (!isBedBlock(footBlock)) {
    throw new Error(
      `床放下后 (${spot.foot.x}, ${spot.foot.y}, ${spot.foot.z}) 不是床，而是${footBlock ? footBlock.name : '空气'}`
    );
  }
  // 床头的方块更新比床脚晚到一点，等它下发完再校验。
  let headBlock = null;
  let reverse = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    headBlock = bot.blockAt(spot.head.x, spot.head.y, spot.head.z);
    reverse = bot.blockAt(spot.foot.x - spot.dir.x, spot.foot.y, spot.foot.z - spot.dir.z);
    if (isBedBlock(headBlock) || isBedBlock(reverse)) break;
    await sleepOf(ctx, 100);
  }
  if (!isBedBlock(headBlock) && !isBedBlock(reverse)) {
    throw new Error('床只放下了一半，床头那一格不是床');
  }
  const headOk = isBedBlock(headBlock) ? headBlock : reverse;
  return {
    foot: footBlock,
    head: headOk,
    position: `${spot.foot.x}, ${spot.foot.y}, ${spot.foot.z}`,
  };
}

export const skills = {
  smelt_batch: {
    description:
      '批量熔炼矿石或生食：先算燃料够不够，再放熔炉、投料、等进度、取出产物，结束后回收熔炉。',
    parameters: [
      {
        name: 'item',
        type: 'string',
        required: true,
        default: null,
        description: '原料 ID，例如 raw_iron、raw_gold、raw_copper、cobblestone、sand、beef。',
      },
      {
        name: 'count',
        type: 'number',
        required: false,
        default: 1,
        description: '要熔炼的数量。',
      },
      {
        name: 'output',
        type: 'string',
        required: false,
        default: null,
        description: '期望的产物 ID，缺省按内置熔炼表推导。',
      },
    ],
    handler: async (args, ctx) => {
      const name = String(args.item || '').trim();
      if (!name) throw new Error('要熔炼什么？请给出原料 ID');
      const count = toCount(args.count, 1, 64);
      const outputName = String(args.output || '').trim() || SMELT_MAP[name];
      if (!outputName) throw new Error(`没有 ${labelOf(ctx, name)} 的熔炼配方`);
      if (typeof ctx.smeltItem !== 'function') throw new Error('桥接没有提供熔炉接口');

      // 1) 原料够不够
      const have = countOf(ctx, name);
      if (have <= 0) throw new Error(`背包里没有${labelOf(ctx, name)}`);
      if (have < count) {
        throw new Error(`材料不够，还差 ${count - have} 个${labelOf(ctx, name)}`);
      }

      // 2) 燃料核算：每一轮都要单独加一次燃料，燃料量按轮累加
      const rounds = smeltRounds(count);
      const fuel = pickFuel(ctx);
      if (!fuel) throw new Error('没有燃料（煤、木炭或木板）');
      const needFuel = fuelNeededForRounds(rounds, fuel.name);
      const haveFuel = countOf(ctx, fuel.name);
      if (haveFuel < needFuel) {
        throw new Error(
          `燃料不够，还差 ${needFuel - haveFuel} 个${labelOf(ctx, fuel.name)}` +
          `（熔炼 ${count} 个${labelOf(ctx, name)} 需要 ${needFuel} 个，背包里只有 ${haveFuel} 个）`
        );
      }

      // 3) 熔炉：附近有就直接用，没有就自己放一个，结束时回收
      let furnace = typeof ctx.nearbyBlock === 'function' ? ctx.nearbyBlock('furnace', 16) : null;
      let placed = false;
      if (!furnace) {
        if (countOf(ctx, 'furnace') <= 0) throw new Error('附近没有熔炉，背包里也没有熔炉');
        if (typeof ctx.placeInventoryBlock !== 'function') {
          throw new Error('附近没有熔炉，背包里也没有熔炉');
        }
        furnace = await ctx.placeInventoryBlock('furnace', '熔炉');
        placed = true;
      }

      const produced = [];
      try {
        for (const size of rounds) {
          // 上一轮烧掉了燃料，每轮都要重新核对
          const nowFuel = pickFuel(ctx);
          if (!nowFuel) throw new Error('没有燃料（煤、木炭或木板）');
          const need = fuelNeeded(size, nowFuel.name);
          const stock = countOf(ctx, nowFuel.name);
          if (stock < need) {
            throw new Error(`燃料不够，还差 ${need - stock} 个${labelOf(ctx, nowFuel.name)}`);
          }
          const before = countOf(ctx, outputName);
          const detail = await ctx.smeltItem({ item: name, count: size });
          const after = countOf(ctx, outputName);
          if (after <= before) {
            throw new Error(`熔炼了 ${labelOf(ctx, name)}，但没有取到${labelOf(ctx, outputName)}`);
          }
          produced.push(detail);
        }
      } finally {
        if (placed && furnace) await recoverFurnace(ctx, furnace);
      }

      return {
        detail:
          `熔炼出 ${count} 个${labelOf(ctx, outputName)}，背包共 ${countOf(ctx, outputName)} 个` +
          `（这批用了 ${needFuel} 个${labelOf(ctx, fuel.name)}）；${produced.join('；')}`,
        status: 'succeeded',
      };
    },
  },

  craft_tool_set: {
    description:
      '按套装合成工具：先核对基础原料，中间件（木棍、木板）不够就现做出来，最后逐件合成成品。',
    parameters: [
      {
        name: 'set',
        type: 'string',
        required: false,
        default: 'stone',
        description:
          '套装名：stone（石镐石剑熔炉）、iron（铁镐铁剑盾）、diamond（钻石镐）、shield、furnace。',
      },
      {
        name: 'count',
        type: 'number',
        required: false,
        default: 1,
        description: '每件成品做几个。',
      },
    ],
    handler: async (args, ctx) => {
      const setName = String(args.set || '').trim().toLowerCase() || 'stone';
      const count = toCount(args.count, 1, 16);
      const set = TOOL_SETS[setName];
      if (!set) {
        throw new Error(`不知道套装 ${setName}，可选：${Object.keys(TOOL_SETS).join('、')}`);
      }
      if (typeof ctx.craftItem !== 'function') throw new Error('桥接没有提供合成接口');

      const steps = set.items.map((entry) => ({
        item: entry.item,
        count: entry.count * count,
        inputs: entry.inputs,
      }));

      // 1) 先把整套要用的原料核对一遍，缺料就一个都不动
      const plan = planSet(ctx, steps);
      if (plan.shortages.length) {
        throw new Error(`材料不够，${plan.shortages.join('、')}`);
      }

      // 2) 中间件：原木 → 木板 → 木棍
      const wood = plan.wood;
      const made = wood.plankPlan
        ? await buildWood(ctx, {
            log: wood.plankPlan.log,
            logs: wood.plankPlan.logs,
            planks: wood.plankPlan.planks,
            sticks: wood.stickMissing,
          })
        : [];

      // 3) 成品
      const done = [];
      for (const step of steps) {
        done.push(await ctx.craftItem({ item: step.item, count: step.count }));
      }

      const parts = done.map((detail, index) => `${labelOf(ctx, steps[index].item)}：${detail}`);
      if (made.length) parts.unshift(`中间件：${made.join('；')}`);
      return {
        detail: `已做好${set.label}（${done.length} 件）：${parts.join('；')}`,
        status: 'succeeded',
      };
    },
  },

  craft_torch: {
    description:
      '做火把并按间距成排放好：木棍不够先从木板或原木折出来，放每个火把前都确认脚下有支撑方块。',
    parameters: [
      {
        name: 'count',
        type: 'number',
        required: false,
        default: 4,
        description: '要做并放置多少个火把。',
      },
      {
        name: 'spacing',
        type: 'number',
        required: false,
        default: 2,
        description: '相邻火把之间的间距，单位是格。',
      },
      {
        name: 'place',
        type: 'boolean',
        required: false,
        default: true,
        description: '做完后是否把火把摆出去。',
      },
    ],
    handler: async (args, ctx) => {
      const count = toCount(args.count, 4, 32);
      const spacing = toCount(args.spacing, 2, 8);
      const shouldPlace = toBool(args.place, true);
      if (typeof ctx.craftItem !== 'function') throw new Error('桥接没有提供合成接口');
      const canPlace =
        typeof ctx.placeBlock === 'function' ||
        (ctx.bot && typeof ctx.bot.placeBlock === 'function');
      if (shouldPlace && !canPlace) {
        throw new Error('桥接没有提供放置方块的接口');
      }

      // 火把的配方是 1 个煤加 1 个木棍出 4 个，按次数算材料。
      const crafts = Math.ceil(count / 4);
      const coal = Math.max(countOf(ctx, 'coal'), countOf(ctx, 'charcoal'));
      if (coal < crafts) {
        throw new Error(`材料不够，还差 ${crafts - coal} 个煤或木炭`);
      }
      const stickPlan = resolveSticks(ctx, crafts);
      if (!stickPlan) {
        const have = countOf(ctx, 'stick');
        const cost = chainCost(CRAFT_CHAINS.stick, Math.max(1, crafts - have));
        throw new Error(
          `材料不够，还差 ${crafts - have} 个木棍` +
          `（要 ${cost.inputs} 个木板或 ${cost.raws} 个原木）`
        );
      }

      // 中间件先做出来
      const made = await buildWood(ctx, {
        log: stickPlan.log,
        logs: stickPlan.logs,
        planks: stickPlan.planks,
        sticks: stickPlan.sticks,
      });

      const before = countOf(ctx, 'torch');
      const detail = await ctx.craftItem({ item: 'torch', count });
      const crafted = countOf(ctx, 'torch') - before;
      if (crafted <= 0) throw new Error('火把没有做出来');

      if (!shouldPlace) {
        return {
          detail: `做好了 ${crafted} 个火把，背包里还有 ${countOf(ctx, 'torch')} 个`,
          status: 'succeeded',
        };
      }

      // 按间距找位置，逐个放
      const spots = torchSpots(ctx, count, spacing);
      if (!spots.length) {
        throw new Error(
          `火把已经做好 ${crafted} 个，但附近没有脚下带支撑方块的位置，还差一个能摆火把的地方`
        );
      }
      let placed = 0;
      const failed = [];
      for (const spot of spots) {
        if (placed >= count) break;
        try {
          await placeTorch(ctx, spot);
          placed += 1;
        } catch (error) {
          failed.push(error.message);
          logOf(ctx, '火把没放上', `${spot.x},${spot.y},${spot.z} ${error.message}`);
        }
      }
      if (placed <= 0) {
        throw new Error(
          `火把已经做好 ${crafted} 个，但一个都没放出去，还差能放火把的支撑位置`
        );
      }

      // M3.5 的验收条件：8 格内要有火把
      const nearby = typeof ctx.nearbyBlock === 'function' ? ctx.nearbyBlock('torch', 8) : null;
      const lit = nearby
        ? `8 格内已经有火把（${nearby.position.x}, ${nearby.position.y}, ${nearby.position.z}）`
        : '还没确认到 8 格内的火把';
      const tail = failed.length ? `；有 ${failed.length} 个位置没放成` : '';
      return {
        detail:
          `做好了 ${crafted} 个火把，放出去 ${placed} 个，${lit}${tail}；${detail}`,
        status: 'succeeded',
      };
    },
  },

  craft_bed: {
    description:
      '合成床并水平放置：3 个羊毛加 3 个木板，羊毛不够会提示先养羊，放置后校验那两格确实是床。',
    parameters: [
      {
        name: 'color',
        type: 'string',
        required: false,
        default: 'auto',
        description: '床的颜色，例如 red、white、blue；auto 或省略时自动选背包里羊毛够 3 个的颜色。',
      },
      {
        name: 'count',
        type: 'number',
        required: false,
        default: 1,
        description: '要做几张床。',
      },
      {
        name: 'place',
        type: 'boolean',
        required: false,
        default: true,
        description: '做完后是否把床摆出来。',
      },
    ],
    handler: async (args, ctx) => {
      const count = toCount(args.count, 1, 8);
      const shouldPlace = toBool(args.place, true);
      const requestedColor = String(args.color || '').trim().toLowerCase();
      let color = requestedColor;
      if (!color || color === 'auto') {
        color = BED_COLORS.find((candidate) => countOf(ctx, `${candidate}_wool`) >= 3 * count) || '';
        if (!color) {
          const stock = BED_COLORS.map((candidate) => ({
            name: `${candidate}_wool`,
            count: countOf(ctx, `${candidate}_wool`),
          }))
            .filter((item) => item.count > 0)
            .map((item) => `${labelOf(ctx, item.name)}×${item.count}`)
            .join('、');
          throw new Error(
            `材料不够，找不到 3 个同色羊毛来合成床${stock ? `；背包里的羊毛：${stock}` : '；背包里没有羊毛'}`
          );
        }
      }
      if (!BED_COLORS.includes(color)) {
        throw new Error(`不知道床的颜色 ${color}，可选：${BED_COLORS.join('、')}`);
      }
      if (typeof ctx.craftItem !== 'function') throw new Error('桥接没有提供合成接口');

      const bedItem = `${color}_bed`;
      const woolItem = `${color}_wool`;
      const woolBlockItem = `${color}_wool_block`;
      if (registryOf(ctx) && !registryItem(ctx, bedItem)) {
        throw new Error(`这个服务器没有 ${bedItem} 这个物品`);
      }

      // 1) 羊毛：只能从羊身上剪，羊毛块是 4 个羊毛合出来的，不能反着换
      const needWool = 3 * count;
      const haveWool = countOf(ctx, woolItem);
      if (haveWool < needWool) {
        const blocks = countOf(ctx, woolBlockItem);
        const extra =
          blocks > 0
            ? `；背包里有 ${blocks} 个${labelOf(ctx, woolBlockItem)}，但羊毛块换不回羊毛` +
              '（配方是 4 个羊毛合 1 个块），要羊毛只能先养羊剪毛'
            : '；要羊毛只能先养羊剪毛';
        throw new Error(
          `材料不够，还差 ${needWool - haveWool} 个${labelOf(ctx, woolItem)}${extra}`
        );
      }

      // 2) 木板：现成木板不够就用原木换
      const wood = planWood(ctx, 3 * count, 0);
      if (!wood.plankPlan) {
        const stock = bestWoodStock(ctx);
        throw new Error(
          `材料不够，还差 ${Math.max(1, wood.totalPlanks - stock.plank)} 个木板` +
          `（要 ${wood.totalPlanks} 个同种木板或 ${chainCost(CRAFT_CHAINS.planks, wood.totalPlanks).raws} 个原木）`
        );
      }

      const made = await buildWood(ctx, {
        log: wood.plankPlan.log,
        logs: wood.plankPlan.logs,
        planks: wood.plankPlan.planks,
        sticks: 0,
      });

      // 3) 床
      const beds = [];
      for (let index = 0; index < count; index += 1) {
        beds.push(await ctx.craftItem({ item: bedItem, count: 1 }));
      }
      if (countOf(ctx, bedItem) < count) {
        throw new Error(`床没有做够，背包里只有 ${countOf(ctx, bedItem)} 张`);
      }

      if (!shouldPlace) {
        return {
          detail:
            `做好了 ${count} 张${labelOf(ctx, bedItem)}，背包里还有 ${countOf(ctx, bedItem)} 张` +
            (made.length ? `；${made.join('；')}` : ''),
          status: 'succeeded',
        };
      }

      // 4) 水平放置：床是方块物品，只能横着放，放完要确认两格都是床
      const placed = [];
      for (let index = 0; index < count; index += 1) {
        const spot = await placeBed(ctx, bedItem);
        placed.push(`${spot.foot.name} 在 (${spot.position})`);
      }
      const nearby = typeof ctx.nearbyBlock === 'function' ? ctx.nearbyBlock('bed', 16) : null;
      const tail = nearby ? '，附近已经能找到床' : '';
      return {
        detail: `做好了 ${count} 张${labelOf(ctx, bedItem)}并放置：${placed.join('；')}${tail}`,
        status: 'succeeded',
      };
    },
  },
};
