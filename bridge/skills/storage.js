// 沃心的物资暂存模块：把箱子当成长程任务的物资暂存点。
// 契约见 docs/plans/SKILL_MODULE_CONTRACT.md：只从 ctx 取能力，不 import 任何运行时依赖。
//
// ctx 依赖：
//   bot、log、sleep、itemLabel、blockLabel、nearbyBlock、travelToBlock、countItem、syncInventory
// 可选能力（缺失时走退化路径，并在返回里说明走的哪条路径）：
//   clickWindowSlot：容器格子点击，优先使用；
//   bot.clickWindow / bot.openBlock / bot.closeWindow / bot.containerItems：mineflayer 标准 API 兜底。
// 待接入：ctx 里没有 openWindow / readContainer / quickMove 这类封装，
// 本模块直接用 ctx.bot 的窗口模型读格子，并自己实现「拿起—逐个放入—放回」的精确搬运，
// 免得 shift 快速移动把整叠都搬走，导致存取数量对不上。

export const skills = {
  store_items: {
    description: '把背包里的物资存进附近的箱子，箱子满了会报只放进多少个。',
    parameters: [
      { name: 'item', type: 'string', required: false, default: null, description: '要存的物品 id，例如 cobblestone。' },
      { name: 'count', type: 'number', required: false, default: 0, description: '要存的数量，0 表示背包里有多少存多少。' },
      { name: 'items', type: 'string|array|object', required: false, default: null, description: '物资清单，例如 "cobblestone 16, iron_ingot 6"。' },
      { name: 'range', type: 'number', required: false, default: 16, description: '搜索箱子的半径。' },
      { name: 'place_if_missing', type: 'boolean', required: false, default: false, description: '附近没有箱子时，先从背包里放一个出来。' },
    ],
    handler: async (args, ctx) => storeItems(args, ctx),
  },
  withdraw_items: {
    description: '从附近的箱子取回物资，可以只取还差的数量，箱子里不够会报只拿到多少个。',
    parameters: [
      { name: 'item', type: 'string', required: false, default: null, description: '要取的物品 id，例如 cobblestone。' },
      { name: 'count', type: 'number', required: false, default: 0, description: '要从箱子里取的数量，0 表示箱子里有多少取多少。' },
      { name: 'target', type: 'number', required: false, default: 0, description: '背包里最终要有的数量，按还差的数量取。' },
      { name: 'items', type: 'string|array|object', required: false, default: null, description: '物资清单，例如 "cobblestone 16, iron_ingot 6"。' },
      { name: 'range', type: 'number', required: false, default: 16, description: '搜索箱子的半径。' },
    ],
    handler: async (args, ctx) => withdrawItems(args, ctx),
  },
  checkpoint_stock: {
    description: '按物资清单把箱子当检查点存放点，逐项存取后回报每种物资最终在箱子还是在背包。',
    parameters: [
      { name: 'items', type: 'string|array|object', required: true, default: null, description: '物资清单，例如 "cobblestone 16, iron_ingot 6"。' },
      { name: 'mode', type: 'string', required: false, default: 'store', description: 'store：让箱子里的数量等于清单；withdraw：让背包里的数量等于清单；report：只报告不动手。' },
      { name: 'range', type: 'number', required: false, default: 16, description: '搜索箱子的半径。' },
    ],
    handler: async (args, ctx) => checkpointStock(args, ctx),
  },
  list_chest: {
    description: '列出附近箱子的内容摘要，给上层决策用。',
    parameters: [
      { name: 'range', type: 'number', required: false, default: 16, description: '搜索箱子的半径。' },
      { name: 'item', type: 'string', required: false, default: null, description: '只看某一种物品的数量。' },
    ],
    handler: async (args, ctx) => listChest(args, ctx),
  },
};

// 容器方块 id：普通箱子与陷阱箱子都能装物资。
const CHEST_BLOCK_NAMES = ['chest', 'trapped_chest'];
const DEFAULT_SEARCH_RANGE = 16;
const DEFAULT_MAX_STACK = 64;
// 单箱 27 格；双箱会由窗口模型给出更大的 inventoryStart，这里只作兜底。
const CONTAINER_SLOT_COUNT = 27;
// 玩家主背包 27 格 + 快捷栏 9 格。
const INVENTORY_SLOT_COUNT = 36;
// 两次容器点击之间的间隔：服务端处理上一个 window_click 需要时间。
const CLICK_GAP_MS = 120;
// 等服务端重发整个窗口的上限。
const RESYNC_TIMEOUT_MS = 1500;

// 常见物资的中文别名：上层说「圆石 16」也能落到 1.21.1 的物品 id 上。
const ITEM_ALIASES = {
  圆石: 'cobblestone',
  石头: 'stone',
  深板岩: 'deepslate',
  铁锭: 'iron_ingot',
  金锭: 'gold_ingot',
  钻石: 'diamond',
  绿宝石: 'emerald',
  红石: 'redstone',
  青金石: 'lapis_lazuli',
  煤炭: 'coal',
  木炭: 'charcoal',
  木棍: 'stick',
  铁块: 'iron_block',
  金块: 'gold_block',
  钻石块: 'diamond_block',
  下界合金锭: 'netherite_ingot',
  下界合金: 'netherite_ingot',
  橡木原木: 'oak_log',
  橡木: 'oak_log',
  橡木木板: 'oak_planks',
  木板: 'oak_planks',
  工作台: 'crafting_table',
  熔炉: 'furnace',
  箱子: 'chest',
  梯子: 'ladder',
  火把: 'torch',
  面包: 'bread',
  熟牛肉: 'cooked_beef',
  生牛肉: 'beef',
  熟猪排: 'cooked_porkchop',
  黑曜石: 'obsidian',
  烈焰棒: 'blaze_rod',
  末影珍珠: 'ender_pearl',
  末影之眼: 'ender_eye',
  石镐: 'stone_pickaxe',
  铁镐: 'iron_pickaxe',
  钻石镐: 'diamond_pickaxe',
  石剑: 'stone_sword',
  铁剑: 'iron_sword',
  钻石剑: 'diamond_sword',
  盾牌: 'shield',
};

// 桥接的 blockLabel / itemLabel 覆盖不到的物品，用这里的本地中文名兜底。
const LOCAL_LABELS = {
  iron_ingot: '铁锭',
  gold_ingot: '金锭',
  diamond: '钻石',
  coal: '煤炭',
  charcoal: '木炭',
  stick: '木棍',
  chest: '箱子',
  trapped_chest: '陷阱箱子',
  furnace: '熔炉',
  crafting_table: '工作台',
  oak_planks: '橡木木板',
  deepslate: '深板岩',
  lapis_lazuli: '青金石',
  redstone: '红石',
  emerald: '绿宝石',
  iron_block: '铁块',
  gold_block: '金块',
  diamond_block: '钻石块',
  netherite_ingot: '下界合金锭',
  obsidian: '黑曜石',
  blaze_rod: '烈焰棒',
  ender_pearl: '末影珍珠',
  ender_eye: '末影之眼',
  shield: '盾牌',
  ladder: '梯子',
  torch: '火把',
};

// 物品名归一到 1.21.1 的物品 id：中文别名走 ITEM_ALIASES，其余必须是英文 id。
export function normalizeItemName(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return '';
  if (ITEM_ALIASES[raw]) return ITEM_ALIASES[raw];
  const lower = raw.toLowerCase();
  if (ITEM_ALIASES[lower]) return ITEM_ALIASES[lower];
  return /^[a-z0-9_]+$/.test(lower) ? lower : '';
}

// 解析物资清单，支持三种写法：
//   "cobblestone 16, iron_ingot 6" / "圆石16、铁锭6"
//   [{ item: 'cobblestone', count: 16 }]
//   { cobblestone: 16, iron_ingot: 6 }
export function parseItemSpec(spec) {
  const list = [];
  const push = (rawName, rawCount) => {
    const item = normalizeItemName(rawName);
    if (!item) throw new Error(`未知物品 ${String(rawName)}`);
    const count = Math.floor(Number(rawCount) || 0);
    if (count <= 0) return;
    const found = list.find((entry) => entry.item === item);
    if (found) found.count += count;
    else list.push({ item, count });
  };
  const pushText = (text) => {
    const chunk = String(text || '').trim();
    if (!chunk) return;
    const parts = chunk.split(/\s+/);
    if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
      push(parts[0], parts[1]);
      return;
    }
    const matched = chunk.match(/^(.*?)(\d+)$/);
    if (matched) {
      push(matched[1], matched[2]);
      return;
    }
    push(chunk, 1);
  };
  if (Array.isArray(spec)) {
    for (const entry of spec) {
      if (typeof entry === 'string') {
        pushText(entry);
      } else if (entry && typeof entry === 'object') {
        push(entry.item ?? entry.name, entry.count ?? entry.amount ?? entry.quantity);
      }
    }
  } else if (spec && typeof spec === 'object') {
    for (const [name, count] of Object.entries(spec)) push(name, count);
  } else if (typeof spec === 'string') {
    for (const chunk of spec.split(/[,，、;；\n]+/)) pushText(chunk);
  }
  return list;
}
// 把「想要搬多少」翻译成「实际能搬多少」。
// plan：[{ item, count }]，count 是希望搬走的数量。
// have：源侧现有数量，形如 { cobblestone: 16 }。
// capacity：目标侧容量，形如 { freeSlots, maxStack, existing }；
//   freeSlots 是还能用的空格子数，maxStack 是单叠上限（可以是数字、每物品表或函数），
//   existing 是目标侧同名物品已有多少（可以并进已有叠，不占新格子）。
// 返回 { moves, shortages, overflow }：moves 是实际能搬的量，
//   shortages 是源侧不够的部分，overflow 是目标侧放不下的部分。
export function planTransfer(plan, have, capacity) {
  const cap = normalizeCapacity(capacity);
  const moves = [];
  const shortages = [];
  const overflow = [];
  let slotsLeft = cap.freeSlots;
  for (const entry of normalizePlan(plan)) {
    const item = entry.item;
    const requested = entry.count;
    if (requested <= 0) continue;
    const available = toCount(have && have[item]);
    if (available < requested) {
      shortages.push({ item, requested, available, missing: requested - available });
    }
    let want = Math.min(requested, available);
    if (want <= 0) continue;
    const maxStack = resolveMaxStack(cap, item);
    const existing = toCount(cap.existing && cap.existing[item]);
    const roomInExisting = existing > 0 ? Math.max(0, maxStack - existing) : 0;
    let count = 0;
    let newSlots = 0;
    if (roomInExisting > 0) {
      count = Math.min(want, roomInExisting);
      want -= count;
    }
    if (want > 0) {
      const stacksNeeded = Math.ceil(want / maxStack);
      const affordable = Math.min(stacksNeeded, Math.max(0, slotsLeft));
      if (affordable > 0) {
        const take = Math.min(want, affordable * maxStack);
        count += take;
        want -= take;
        newSlots = affordable;
        slotsLeft -= affordable;
      }
    }
    if (count > 0) moves.push({ item, count, newSlots });
    if (want > 0) overflow.push({ item, count: want, missing: want });
  }
  return { moves, shortages, overflow };
}

// 箱子内容摘要。chestItems 可以是 [{ name, count }] 或 { name: count }。
// labelFn 可选：把物品 id 翻成中文名。
export function summarize(chestItems, labelFn) {
  const list = normalizeItemList(chestItems);
  if (!list.length) return '箱子是空的';
  const total = list.reduce((sum, entry) => sum + entry.count, 0);
  const parts = list.map((entry) => `${labelFn ? labelFn(entry.name) : entry.name} x${entry.count}`);
  return `箱子里有 ${parts.join('、')}，共 ${list.length} 种 ${total} 个`;
}

// 两个数量表相减，返回每种物品的差值（后减前）。
export function diffCounts(before, after) {
  const diff = {};
  const names = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const name of names) {
    const delta = toCount(after && after[name]) - toCount(before && before[name]);
    if (delta !== 0) diff[name] = delta;
  }
  return diff;
}

// 从候选位置里挑一个能放箱子的地方：脚下是实心方块、上面两格是空的。
export function pickChestSpot(candidates) {
  for (const candidate of candidates || []) {
    if (!candidate) continue;
    if (candidate.spaceFree === false) continue;
    if (![candidate.x, candidate.y, candidate.z].every(Number.isFinite)) continue;
    return { x: candidate.x, y: candidate.y, z: candidate.z };
  }
  return null;
}

// ---------- 内部辅助 ----------

function toCount(value) {
  const count = Math.floor(Number(value) || 0);
  return count > 0 ? count : 0;
}

function normalizePlan(plan) {
  if (!Array.isArray(plan)) return [];
  return plan
    .map((entry) => ({ item: entry && entry.item, count: toCount(entry && entry.count) }))
    .filter((entry) => entry.item && entry.count > 0);
}

function normalizeCapacity(capacity) {
  const raw = capacity && typeof capacity === 'object' ? capacity : { freeSlots: capacity };
  const maxStack = raw.maxStack === undefined ? DEFAULT_MAX_STACK : raw.maxStack;
  const freeSlots = toCount(raw.freeSlots === undefined ? raw.slots : raw.freeSlots);
  return { maxStack, freeSlots, existing: raw.existing || {} };
}

function resolveMaxStack(cap, item) {
  const raw = cap.maxStack;
  let value = raw;
  if (typeof raw === 'function') value = raw(item);
  else if (raw && typeof raw === 'object') value = raw[item];
  const count = Math.floor(Number(value) || 0);
  return count > 0 ? count : DEFAULT_MAX_STACK;
}

function normalizeItemList(items) {
  if (!items) return [];
  if (Array.isArray(items)) {
    return items
      .map((entry) => ({ name: entry && (entry.name ?? entry.item), count: toCount(entry && (entry.count ?? entry.amount)) }))
      .filter((entry) => entry.name && entry.count > 0);
  }
  if (typeof items !== 'object') return [];
  return Object.entries(items)
    .map(([name, count]) => ({ name, count: toCount(count) }))
    .filter((entry) => entry.count > 0);
}

// 物品中文名：方块物品（箱子本身就是 chest）先按方块名翻，其余按物品名翻，
// 桥接翻译不了的再用本地表兜底。
function labelOf(ctx, name) {
  const order = isBlockItem(ctx, name) ? ['blockLabel', 'itemLabel'] : ['itemLabel', 'blockLabel'];
  for (const key of order) {
    const label = ctx[key];
    if (typeof label !== 'function') continue;
    const text = label.call(ctx, name);
    if (text && text !== name) return text;
  }
  return LOCAL_LABELS[name] || String(name);
}

// 物品本身是方块（箱子就是 chest），标签口径与普通物品不同，这里只做标记。
function isBlockItem(ctx, name) {
  const registry = ctx.registry;
  return Boolean(registry && registry.blocksByName && registry.blocksByName[name]);
}

// 单叠上限：注册表优先，再从窗口里的物品实例读，最后按 64 兜底。
function maxStackOf(ctx, window, name) {
  const registry = ctx.registry;
  const entry = registry && registry.itemsByName ? registry.itemsByName[name] : null;
  if (entry && Number.isFinite(entry.maxStack) && entry.maxStack > 0) return entry.maxStack;
  for (const item of allWindowItems(window)) {
    if (item && item.name === name && Number.isFinite(item.stackSize) && item.stackSize > 0) return item.stackSize;
  }
  return DEFAULT_MAX_STACK;
}

function allWindowItems(window) {
  if (!window || !Array.isArray(window.slots)) return [];
  return window.slots.filter(Boolean);
}

// 背包里某物品的数量：优先 ctx.countItem，再退回 bot.inventory。
function countItem(ctx, name) {
  if (typeof ctx.countItem === 'function') return toCount(ctx.countItem(name));
  const bot = ctx.bot;
  if (!bot || !bot.inventory || typeof bot.inventory.items !== 'function') return 0;
  return toCount(
    bot.inventory
      .items()
      .filter((item) => item.name === name)
      .reduce((sum, item) => sum + item.count, 0),
  );
}

function clampRange(value) {
  const range = Math.floor(Number(value) || 0);
  if (range > 0) return Math.min(64, range);
  return DEFAULT_SEARCH_RANGE;
}

function sleepCtx(ctx, ms) {
  if (typeof ctx.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
// 找附近的箱子：优先 ctx.nearbyBlock，没有就退回 bot.findBlock。
function findChestBlock(ctx, range) {
  for (const name of CHEST_BLOCK_NAMES) {
    if (typeof ctx.nearbyBlock === 'function') {
      const block = ctx.nearbyBlock(name, range);
      if (block && block.position) return block;
      continue;
    }
    const bot = ctx.bot;
    const registry = bot && bot.registry;
    if (!bot || typeof bot.findBlock !== 'function' || !registry || !registry.blocksByName[name]) continue;
    const block = bot.findBlock({ matching: registry.blocksByName[name].id, maxDistance: range });
    if (block && block.position) return block;
  }
  return null;
}

// 收集适合放箱子的候选位置：脚下是实心方块、上面两格是空的。
function collectChestSpots(ctx) {
  const bot = ctx.bot;
  if (!bot || typeof bot.blockAt !== 'function' || !bot.entity) return [];
  const base = bot.entity.position;
  const offsets = [
    [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2],
    [1, 1], [-1, -1], [1, -1], [-1, 1],
  ];
  const spots = [];
  for (const [dx, dz] of offsets) {
    const x = Math.floor(base.x) + dx;
    const z = Math.floor(base.z) + dz;
    for (let dy = 1; dy >= -2; dy -= 1) {
      const ground = bot.blockAt({ x, y: Math.floor(base.y) + dy, z });
      if (!ground || ground.boundingBox !== 'block') continue;
      const above = bot.blockAt({ x, y: ground.position.y + 1, z });
      const above2 = bot.blockAt({ x, y: ground.position.y + 2, z });
      const spaceFree = (!above || above.boundingBox === 'empty') && (!above2 || above2.boundingBox === 'empty');
      spots.push({ x: ground.position.x, y: ground.position.y + 1, z: ground.position.z, spaceFree });
      break;
    }
  }
  return spots;
}

// 找一个箱子；允许先从背包里放一个出来。找不到就报错并给出建议坐标。
async function ensureChest(ctx, range, placeIfMissing) {
  const chest = findChestBlock(ctx, range);
  if (chest) return chest;
  if (placeIfMissing && countItem(ctx, 'chest') > 0 && typeof ctx.placeInventoryBlock === 'function') {
    const placed = await ctx.placeInventoryBlock('chest', '箱子');
    if (placed) {
      const again = findChestBlock(ctx, range);
      if (again) return again;
    }
  }
  const spot = pickChestSpot(collectChestSpots(ctx)) || fallbackChestSpot(ctx);
  const tip = spot ? `建议在 (${spot.x}, ${spot.y}, ${spot.z}) 放一个箱子` : '建议先从背包里放一个箱子再存物资';
  throw new Error(`附近 ${range} 格内没有箱子，${tip}`);
}

// 没有找到空位时，至少给一个自身旁边的建议坐标。
function fallbackChestSpot(ctx) {
  const bot = ctx.bot;
  if (!bot || !bot.entity) return null;
  const base = bot.entity.position;
  if (![base.x, base.y, base.z].every(Number.isFinite)) return null;
  return { x: Math.floor(base.x) + 1, y: Math.floor(base.y) + 1, z: Math.floor(base.z) };
}

async function travelToChest(ctx, chest) {
  const position = chest.position;
  if (typeof ctx.travelToBlock === 'function') {
    const outcome = await ctx.travelToBlock(position);
    if (outcome === 'reached') return;
    if (String(outcome).includes('cancel')) throw new Error('走到箱子的动作被取消');
    throw new Error(`没有走到箱子旁边（${outcome}）`);
  }
  if (typeof ctx.travelTo === 'function') {
    await ctx.travelTo(position.x, position.y, position.z, 2);
    return;
  }
  throw new Error('没有走到箱子旁边的能力');
}

async function openChest(ctx, chest) {
  if (!ctx.bot || typeof ctx.bot.openBlock !== 'function') throw new Error('没有打开箱子的能力');
  const window = await ctx.bot.openBlock(chest);
  if (!window) throw new Error('没有打开箱子');
  return window;
}

async function closeChest(ctx, window) {
  if (!ctx.bot || typeof ctx.bot.closeWindow !== 'function' || !window) return;
  try {
    await ctx.bot.closeWindow(window);
  } catch (error) {
    if (typeof ctx.log === 'function') ctx.log('关箱子失败', error.message);
  }
}

// 关闭窗口后让背包与服务端对齐一次。
async function syncInventory(ctx) {
  if (typeof ctx.syncInventory !== 'function') return;
  try {
    await ctx.syncInventory();
  } catch (error) {
    if (typeof ctx.log === 'function') ctx.log('同步背包失败', error.message);
  }
}

function containerRange(window) {
  const start = Number.isFinite(window && window.inventoryStart) ? window.inventoryStart : CONTAINER_SLOT_COUNT;
  return { start: 0, end: start };
}

function inventoryRange(window) {
  const start = Number.isFinite(window && window.inventoryStart) ? window.inventoryStart : CONTAINER_SLOT_COUNT;
  const end = Number.isFinite(window && window.inventoryEnd) ? window.inventoryEnd : start + INVENTORY_SLOT_COUNT;
  return { start, end: Math.max(start, end) };
}

// 读一段窗口格子，返回 { 物品id: 数量 }。
function readRange(window, range) {
  const counts = {};
  const slots = (window && window.slots) || [];
  for (let slot = range.start; slot < range.end; slot += 1) {
    const item = slots[slot];
    if (!item || !item.name || !item.count) continue;
    counts[item.name] = (counts[item.name] || 0) + item.count;
  }
  return counts;
}

function freeSlots(window, range) {
  const slots = (window && window.slots) || [];
  let free = 0;
  for (let slot = range.start; slot < range.end; slot += 1) {
    if (!slots[slot]) free += 1;
  }
  return free;
}

// 箱子内容的读取路径说明：能走容器 API 就走 API，否则读窗口槽位。
function describeReadPath(ctx, window) {
  if (window && typeof window.containerItems === 'function') return 'window.containerItems';
  const bot = ctx.bot;
  if (bot && bot.currentWindow && typeof bot.currentWindow.containerItems === 'function') return 'bot.currentWindow.containerItems';
  if (bot && Array.isArray(bot.containerItems)) return 'bot.containerItems';
  return '窗口槽位';
}

// 让服务端把整个窗口重发一遍：本地模型这时才是服务端认可的状态。
async function resyncWindow(ctx, window) {
  const bot = ctx.bot;
  if (!bot || typeof bot._syncWindow !== 'function' || !window) return false;
  try {
    await Promise.race([bot._syncWindow(window).catch(() => {}), sleepCtx(ctx, RESYNC_TIMEOUT_MS)]);
    return true;
  } catch {
    return false;
  }
}

// 点容器格子。优先 ctx.clickWindowSlot，没有就退回 mineflayer 的 bot.clickWindow。
// prefer 可以指定先试哪条路径；返回实际走通的路径名。
async function clickSlot(ctx, window, slot, mouseButton, mode, prefer) {
  const useCtx = typeof ctx.clickWindowSlot === 'function';
  const useBot = Boolean(ctx.bot && typeof ctx.bot.clickWindow === 'function');
  if (!useCtx && !useBot) throw new Error('没有点击箱子的能力');
  const order = prefer === 'bot.clickWindow'
    ? ['bot.clickWindow', 'ctx.clickWindowSlot']
    : ['ctx.clickWindowSlot', 'bot.clickWindow'];
  let lastError = null;
  for (const path of order) {
    if (path === 'ctx.clickWindowSlot' && !useCtx) continue;
    if (path === 'bot.clickWindow' && !useBot) continue;
    try {
      if (path === 'ctx.clickWindowSlot') await ctx.clickWindowSlot(window, slot, mouseButton, mode);
      else await ctx.bot.clickWindow(slot, mouseButton, mode);
      return path;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('没有点击箱子的能力');
}

// 选一个源格：优先挑数量不超过目标的整叠（一次快速移动就够），否则挑最大的那叠。
function pickSourceStack(window, range, itemName, want) {
  const slots = (window && window.slots) || [];
  let best = null;
  let largest = null;
  for (let slot = range.start; slot < range.end; slot += 1) {
    const item = slots[slot];
    if (!item || item.name !== itemName || !item.count) continue;
    const entry = { slot, count: item.count };
    if (item.count <= want) {
      if (!best || item.count > best.count) best = entry;
    }
    if (!largest || item.count > largest.count) largest = entry;
  }
  return best || largest;
}

// 选目标格：优先选同名且没满的格子（能并进去），否则选空格。
function pickTargetSlot(window, range, itemName) {
  const slots = (window && window.slots) || [];
  let fallback = null;
  for (let slot = range.start; slot < range.end; slot += 1) {
    const item = slots[slot];
    if (!item) {
      if (fallback === null) fallback = slot;
      continue;
    }
    if (item.name === itemName && item.count < (item.stackSize || DEFAULT_MAX_STACK)) return slot;
  }
  return fallback;
}
// 把 count 个 item 从源侧搬到目标侧。
// direction：'deposit'（背包→箱子）| 'withdraw'（箱子→背包）。
// 返回 { moved, path }：moved 是服务端确认搬走的数量。
async function moveExact(ctx, window, itemName, count, direction) {
  const paths = [];
  if (typeof ctx.clickWindowSlot === 'function') paths.push('ctx.clickWindowSlot');
  if (ctx.bot && typeof ctx.bot.clickWindow === 'function') paths.push('bot.clickWindow');
  if (!paths.length) throw new Error('没有点击箱子的能力');
  let last = { moved: 0, path: '' };
  for (const path of paths) {
    const result = await attemptMove(ctx, window, itemName, count, direction, path);
    last = result;
    if (result.moved > 0) return result;
    // 这次点击没生效（服务端可能因状态编号不符忽略了它）：先同步窗口，再换一条路径。
    await resyncWindow(ctx, window);
  }
  return last;
}

async function attemptMove(ctx, window, itemName, count, direction, path) {
  const source = direction === 'deposit' ? inventoryRange(window) : containerRange(window);
  const target = direction === 'deposit' ? containerRange(window) : inventoryRange(window);
  const before = toCount(readRange(window, source)[itemName]);
  if (before <= 0 || count <= 0) return { moved: 0, path };
  const want = Math.min(count, before);
  const stack = pickSourceStack(window, source, itemName, want);
  if (!stack) return { moved: 0, path };
  const destSlot = pickTargetSlot(window, target, itemName);
  if (destSlot === null) return { moved: 0, path };
  try {
    if (stack.count <= want) {
      // 整叠刚好够：一次 shift 快速移动就搬完。
      await clickSlot(ctx, window, stack.slot, 0, 1, path);
    } else {
      // 只要一部分：拿起整叠，逐个放进目标格，再把剩下的放回原格。
      await clickSlot(ctx, window, stack.slot, 0, 0, path);
      for (let i = 0; i < want; i += 1) {
        await clickSlot(ctx, window, destSlot, 1, 0, path);
        await sleepCtx(ctx, CLICK_GAP_MS);
      }
      await clickSlot(ctx, window, stack.slot, 0, 0, path);
    }
  } catch (error) {
    if (typeof ctx.log === 'function') ctx.log('点箱子格子失败', path, error.message);
  }
  await resyncWindow(ctx, window);
  const after = toCount(readRange(window, source)[itemName]);
  return { moved: Math.max(0, before - after), path };
}

// 逐项执行搬运。moves：[{ item, count, requested, direction }]。
// requested 是上层真正想要的量，count 是这一步打算搬的量（为 0 表示没搬成）。
async function runMoves(ctx, window, moves) {
  const results = [];
  const paths = [];
  for (const move of moves) {
    const result = await moveExact(ctx, window, move.item, move.count, move.direction);
    if (result.path && !paths.includes(result.path)) paths.push(result.path);
    results.push({
      item: move.item,
      requested: Number.isFinite(move.requested) ? move.requested : move.count,
      planned: move.count,
      moved: result.moved,
      direction: move.direction,
    });
  }
  return { results, paths };
}

// 从参数里凑出要搬的物品清单。
function collectWanted(args) {
  if (args.items) return parseItemSpec(args.items);
  if (args.item) {
    const item = normalizeItemName(args.item);
    if (!item) throw new Error(`未知物品 ${args.item}`);
    return [{ item, count: Math.max(0, Math.floor(Number(args.count) || 0)) }];
  }
  return [];
}

// 把每项的搬运量对上计划：计划里没有的说明目标侧放不下，requested 仍按上层的期望记。
function alignPlan(wanted, plan, direction) {
  return wanted.map((entry) => {
    const planned = plan.moves.find((candidate) => candidate.item === entry.item);
    return {
      item: entry.item,
      count: planned ? planned.count : 0,
      requested: entry.count,
      direction,
    };
  });
}

// ---------- 技能实现 ----------

async function storeItems(args, ctx) {
  const wanted = collectWanted(args);
  if (!wanted.length) throw new Error('没有指定要存的物品');
  const range = clampRange(args.range);
  const chest = await ensureChest(ctx, range, args.place_if_missing);
  // 背包里一个都没有就不要开箱子了。
  const available = wanted.map((entry) => ({ item: entry.item, count: countItem(ctx, entry.item) }));
  if (!available.some((entry) => entry.count > 0)) {
    const names = wanted.map((entry) => labelOf(ctx, entry.item)).join('、');
    throw new Error(`背包里没有${names}`);
  }
  await travelToChest(ctx, chest);
  const window = await openChest(ctx, chest);
  try {
    const chestCounts = readRange(window, containerRange(window));
    const invCounts = readRange(window, inventoryRange(window));
    // count 为 0 表示背包里有多少存多少。
    const effective = wanted.map((entry) => ({
      item: entry.item,
      count: entry.count > 0 ? entry.count : toCount(invCounts[entry.item]),
    }));
    const plan = planTransfer(effective, invCounts, {
      freeSlots: freeSlots(window, containerRange(window)),
      maxStack: (item) => maxStackOf(ctx, window, item),
      existing: chestCounts,
    });
    const { results, paths } = await runMoves(ctx, window, alignPlan(effective, plan, 'deposit'));
    await resyncWindow(ctx, window);
    const finalChest = readRange(window, containerRange(window));
    const finalInv = readRange(window, inventoryRange(window));
    const parts = results.map((result) => {
      const label = labelOf(ctx, result.item);
      return `${label} ${result.moved}/${result.requested} 个（箱子里 ${toCount(finalChest[result.item])} 个，背包里 ${toCount(finalInv[result.item])} 个）`;
    });
    const detail = `存进箱子：${parts.join('；')}。走的 ${paths.join(' → ') || '无'} 路径，箱子内容用 ${describeReadPath(ctx, window)} 读。`;
    const short = results.filter((result) => result.moved < result.requested);
    if (short.length) {
      const reasons = short
        .map((result) => `${labelOf(ctx, result.item)}只放进 ${result.moved} 个，还差 ${result.requested - result.moved} 个`)
        .join('；');
      throw new Error(`${detail} ${reasons}`);
    }
    return { detail, status: 'succeeded' };
  } finally {
    await closeChest(ctx, window);
  }
}

async function withdrawItems(args, ctx) {
  const wanted = collectWanted(args);
  if (!wanted.length) throw new Error('没有指定要取的物品');
  const range = clampRange(args.range);
  const target = Math.max(0, Math.floor(Number(args.target) || 0));
  const chest = await ensureChest(ctx, range, false);
  await travelToChest(ctx, chest);
  const window = await openChest(ctx, chest);
  try {
    const chestCounts = readRange(window, containerRange(window));
    const invCounts = readRange(window, inventoryRange(window));
    // target 表示背包里最终要有的数量：只取还差的那部分。
    const needs = wanted.map((entry) => {
      let need = entry.count;
      if (target > 0) need = Math.max(0, target - toCount(invCounts[entry.item]));
      else if (need <= 0) need = toCount(chestCounts[entry.item]);
      return { item: entry.item, count: need };
    });
    if (!needs.some((entry) => entry.count > 0)) {
      const names = wanted.map((entry) => labelOf(ctx, entry.item)).join('、');
      throw new Error(`箱子里没有${names}`);
    }
    const plan = planTransfer(needs, chestCounts, {
      freeSlots: freeSlots(window, inventoryRange(window)),
      maxStack: (item) => maxStackOf(ctx, window, item),
      existing: invCounts,
    });
    const { results, paths } = await runMoves(ctx, window, alignPlan(needs, plan, 'withdraw'));
    await resyncWindow(ctx, window);
    const finalChest = readRange(window, containerRange(window));
    const finalInv = readRange(window, inventoryRange(window));
    const parts = results.map((result) => {
      const label = labelOf(ctx, result.item);
      return `${label} 取回 ${result.moved}/${result.requested} 个（背包里 ${toCount(finalInv[result.item])} 个，箱子里 ${toCount(finalChest[result.item])} 个）`;
    });
    const detail = `从箱子里取回：${parts.join('；')}。走的 ${paths.join(' → ') || '无'} 路径，箱子内容用 ${describeReadPath(ctx, window)} 读。`;
    const short = results.filter((result) => result.moved < result.requested);
    if (short.length) {
      const reasons = short
        .map((result) => `${labelOf(ctx, result.item)}只拿到 ${result.moved} 个，还差 ${result.requested - result.moved} 个`)
        .join('；');
      throw new Error(`${detail} ${reasons}`);
    }
    return { detail, status: 'succeeded' };
  } finally {
    await closeChest(ctx, window);
  }
}
async function checkpointStock(args, ctx) {
  const wanted = parseItemSpec(args.items);
  if (!wanted.length) throw new Error('没有给出物资清单');
  const range = clampRange(args.range);
  const mode = String(args.mode || 'store');
  const chest = await ensureChest(ctx, range, false);
  await travelToChest(ctx, chest);
  const window = await openChest(ctx, chest);
  try {
    const chestCounts = readRange(window, containerRange(window));
    const invCounts = readRange(window, inventoryRange(window));
    const moves = [];
    for (const entry of wanted) {
      const inChest = toCount(chestCounts[entry.item]);
      const inBag = toCount(invCounts[entry.item]);
      if (mode === 'report') continue;
      if (mode === 'withdraw') {
        // 背包要凑够清单：箱子里的拿回来，背包里多余的放回箱子。
        if (inBag < entry.count) {
          const need = Math.min(entry.count - inBag, inChest);
          if (need > 0) moves.push({ item: entry.item, count: need, requested: need, direction: 'withdraw' });
        } else if (inBag > entry.count) {
          const extra = inBag - entry.count;
          moves.push({ item: entry.item, count: extra, requested: extra, direction: 'deposit' });
        }
        continue;
      }
      // 默认 store：箱子要凑够清单，背包里多余的先存进去。
      if (inChest < entry.count) {
        const need = Math.min(entry.count - inChest, inBag);
        if (need > 0) moves.push({ item: entry.item, count: need, requested: need, direction: 'deposit' });
      } else if (inChest > entry.count) {
        const extra = inChest - entry.count;
        moves.push({ item: entry.item, count: extra, requested: extra, direction: 'withdraw' });
      }
    }
    const { results, paths } = await runMoves(ctx, window, moves);
    await resyncWindow(ctx, window);
    const finalChest = readRange(window, containerRange(window));
    const finalInv = readRange(window, inventoryRange(window));
    const missing = [];
    const report = wanted.map((entry) => {
      const label = labelOf(ctx, entry.item);
      const inChest = toCount(finalChest[entry.item]);
      const inBag = toCount(finalInv[entry.item]);
      let gap = 0;
      if (mode === 'store') gap = Math.max(0, entry.count - inChest);
      else if (mode === 'withdraw') gap = Math.max(0, entry.count - inBag);
      if (gap > 0) missing.push({ item: entry.item, gap });
      const tail = gap > 0 ? `，还差 ${gap} 个` : '';
      return `${label}：箱子里 ${inChest} 个、背包里 ${inBag} 个${tail}`;
    });
    const detail = `检查点（${mode}）：${report.join('；')}。走的 ${paths.join(' → ') || '无'} 路径，箱子内容用 ${describeReadPath(ctx, window)} 读。`;
    if (missing.length) {
      const short = results.filter((result) => result.moved < result.requested);
      const reasons = short
        .map((result) => `${labelOf(ctx, result.item)}只${result.direction === 'deposit' ? '放进' : '拿到'} ${result.moved} 个`)
        .join('；');
      const gaps = missing.map((entry) => `${labelOf(ctx, entry.item)}还差 ${entry.gap} 个`).join('；');
      throw new Error(`${detail} ${reasons || gaps}；${gaps}`);
    }
    return { detail, status: 'succeeded' };
  } finally {
    await closeChest(ctx, window);
  }
}

async function listChest(args, ctx) {
  const range = clampRange(args.range);
  const chest = await ensureChest(ctx, range, false);
  await travelToChest(ctx, chest);
  const window = await openChest(ctx, chest);
  try {
    const chestCounts = readRange(window, containerRange(window));
    const item = args.item ? normalizeItemName(args.item) : '';
    if (item) {
      const count = toCount(chestCounts[item]);
      const label = labelOf(ctx, item);
      if (!count) throw new Error(`箱子里没有${label}`);
      return {
        detail: `箱子里有 ${count} 个${label}。位置 (${chest.position.x}, ${chest.position.y}, ${chest.position.z})，读取走 ${describeReadPath(ctx, window)}。`,
        status: 'succeeded',
      };
    }
    const items = Object.entries(chestCounts).map(([name, count]) => ({ name, count }));
    const detail = `${summarize(items, (name) => labelOf(ctx, name))}。位置 (${chest.position.x}, ${chest.position.y}, ${chest.position.z})，读取走 ${describeReadPath(ctx, window)}。`;
    return { detail, status: 'succeeded' };
  } finally {
    await closeChest(ctx, window);
    await syncInventory(ctx);
  }
}
