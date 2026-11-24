import { findBlocksWithExploration } from '../resource_search.js';

const FOOD_ITEMS = [
  'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit',
  'cooked_cod', 'cooked_salmon', 'baked_potato', 'apple', 'carrot', 'potato', 'beetroot',
  'melon_slice', 'sweet_berries', 'glow_berries', 'cookie', 'pumpkin_pie', 'dried_kelp',
  'mushroom_stew', 'rabbit_stew', 'beetroot_soup', 'beef', 'porkchop', 'chicken', 'mutton',
  'rabbit', 'cod', 'salmon',
];
const FOOD_SET = new Set(FOOD_ITEMS);
const BED_NAMES = [
  'white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed', 'yellow_bed', 'lime_bed',
  'pink_bed', 'gray_bed', 'light_gray_bed', 'cyan_bed', 'purple_bed', 'blue_bed',
  'brown_bed', 'green_bed', 'red_bed', 'black_bed',
];
const BED_SET = new Set(BED_NAMES);
const CHEST_TARGETS = new Set([
  ...FOOD_ITEMS,
  ...BED_NAMES,
  'wheat', 'iron_ingot', 'diamond', 'gold_ingot', 'emerald', 'obsidian', 'coal',
  'charcoal', 'lapis_lazuli', 'redstone', 'shield', 'bow', 'crossbow', 'trident',
]);
const TOOL_SUFFIXES = new Set(['pickaxe', 'axe', 'shovel', 'sword', 'hoe']);
const ARMOR_SUFFIXES = new Set(['helmet', 'chestplate', 'leggings', 'boots']);
const TOOL_MATERIALS = new Set(['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite']);
const ARMOR_MATERIALS = new Set(['iron', 'golden', 'diamond', 'netherite', 'leather', 'chainmail']);
const DEFAULT_RANGE = 32;
const MAX_SEARCH_STEPS = 5;
const CLICK_GAP_MS = 120;
const SYNC_TIMEOUT_MS = 1500;

export const skills = {
  loot_village: {
    description: '检查当前可见的村庄箱子、闲置床和干草块；只取目标白名单物资，按背包目标量核对增量。',
    parameters: [
      { name: 'targets', type: 'object', required: false, default: {}, description: '物品到背包最终目标数量的映射，只接受食物、床、铁锭、钻石和工具白名单。' },
      { name: 'bed_count', type: 'number', required: false, default: 1, description: '背包中床物品的目标总数。' },
      { name: 'food_target', type: 'number', required: false, default: 16, description: '背包中可食用物品的目标总数；需要时用干草制小麦，再按实际配方合成面包。' },
      { name: 'range', type: 'number', required: false, default: 32, description: '资源点搜索和接近半径，最大 64 格。' },
      { name: 'max_search_steps', type: 'number', required: false, default: 5, description: '无附近候选时的有限探索步数，范围 0-5；自动机会可传 0。' },
      { name: 'avoid_positions', type: 'array', required: false, default: [], description: '本轮跳过的坐标字符串，例如 "12,64,-3"。' },
    ],
    handler: async (args, ctx) => lootVillage(args, ctx),
  },
};

function interrupted(ctx, action = '村庄物资搜索') {
  if (ctx.interrupted) throw new Error(`${action}被新的指令打断`);
}

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function clamp(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function itemAllowed(name) {
  if (CHEST_TARGETS.has(name)) return true;
  const separator = name.indexOf('_');
  if (separator <= 0) return false;
  const material = name.slice(0, separator);
  const suffix = name.slice(separator + 1);
  return (TOOL_MATERIALS.has(material) && TOOL_SUFFIXES.has(suffix)) ||
    (ARMOR_MATERIALS.has(material) && ARMOR_SUFFIXES.has(suffix));
}

function normalizeTargets(raw) {
  if (raw === undefined || raw === null) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('targets 必须是物品到目标数量的映射');
  const result = {};
  for (const [rawName, rawCount] of Object.entries(raw)) {
    const name = String(rawName || '').trim().toLowerCase();
    const numeric = Number(rawCount);
    if (!itemAllowed(name)) throw new Error(`loot_village 不允许取得物品 ${name || String(rawName)}`);
    if (!Number.isFinite(numeric) || numeric < 0) throw new Error(`${name} 的目标数量无效`);
    const count = Math.min(1024, Math.floor(numeric));
    if (count > 0) result[name] = count;
  }
  return result;
}

function inventoryCounts(ctx) {
  const counts = {};
  const items = ctx.bot?.inventory?.items?.();
  if (Array.isArray(items)) {
    for (const item of items) {
      if (item?.name) counts[item.name] = (counts[item.name] || 0) + toCount(item.count);
    }
    return counts;
  }
  for (const name of new Set([...FOOD_ITEMS, ...BED_NAMES, 'wheat', 'iron_ingot', 'diamond', 'gold_ingot', 'emerald', 'obsidian'])) {
    const count = typeof ctx.countItem === 'function' ? toCount(ctx.countItem(name)) : 0;
    if (count) counts[name] = count;
  }
  return counts;
}

function sumFood(counts) {
  return FOOD_ITEMS.reduce((total, name) => total + toCount(counts[name]), 0);
}

function sumBeds(counts) {
  return BED_NAMES.reduce((total, name) => total + toCount(counts[name]), 0);
}

function countDifference(before, after) {
  const delta = {};
  for (const name of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    const difference = toCount(after?.[name]) - toCount(before?.[name]);
    if (difference) delta[name] = difference;
  }
  return delta;
}

function targetGaps(counts, targets) {
  return Object.fromEntries(Object.entries(targets).map(([name, target]) => [
    name,
    Math.max(0, target - toCount(counts[name])),
  ]));
}

function breadNeed(counts, targets, foodTarget) {
  return Math.max(
    0,
    foodTarget - sumFood(counts),
    (targets.bread || 0) - toCount(counts.bread),
  );
}

function targetWheat(counts, targets, foodTarget) {
  const reserved = targets.wheat || 0;
  return reserved + breadNeed(counts, targets, foodTarget) * 3;
}

function coordinateKey(site) {
  const coordinates = ['x', 'y', 'z'].map((axis) => Number(site?.[axis]));
  if (!coordinates.every(Number.isFinite)) return '';
  return coordinates.map(Math.floor).join(',');
}

function parseAvoidPositions(values) {
  const result = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value === 'string') {
      const parts = value.split(',').map((part) => Number(part.trim()));
      if (parts.length === 3 && parts.every(Number.isFinite)) result.add(parts.map(Math.floor).join(','));
    } else if (value && typeof value === 'object') {
      const key = coordinateKey(value);
      if (key) result.add(key);
    }
  }
  return result;
}

function isBed(name) {
  return BED_SET.has(String(name || ''));
}

function insideRememberedShelter(site, shelter) {
  const base = shelter?.position;
  const size = Math.floor(Number(shelter?.size));
  if (!base || !Number.isFinite(size) || size < 3) return false;
  const dx = Math.floor(site.x) - Number(base.x);
  const dz = Math.floor(site.z) - Number(base.z);
  const min = -Math.floor(size / 2);
  const max = min + size - 1;
  const dy = Math.floor(site.y) - Number(base.y);
  return dx >= min && dx <= max && dz >= min && dz <= max && dy >= 1 && dy <= 4;
}

function makeVector(bot, position) {
  const base = bot?.entity?.position;
  if (base && base.constructor !== Object && typeof base.constructor === 'function') {
    try {
      return new base.constructor(Number(position.x), Number(position.y), Number(position.z));
    } catch {
      // 测试替身或非 Vec3 坐标继续走 offset 兜底。
    }
  }
  if (base && typeof base.offset === 'function') {
    return base.offset(Number(position.x) - base.x, Number(position.y) - base.y, Number(position.z) - base.z);
  }
  return { x: Number(position.x), y: Number(position.y), z: Number(position.z) };
}

function blockAt(ctx, site) {
  if (typeof ctx.bot?.blockAt !== 'function') return null;
  return ctx.bot.blockAt(makeVector(ctx.bot, site));
}

function withinRange(ctx, site, range) {
  const origin = ctx.bot?.entity?.position;
  if (!origin) return false;
  const dx = Number(site.x) - Number(origin.x);
  const dy = Number(site.y) - Number(origin.y);
  const dz = Number(site.z) - Number(origin.z);
  return [dx, dy, dz].every(Number.isFinite) && Math.hypot(dx, dy, dz) <= range;
}

function currentFoodNeed(ctx, targets, foodTarget) {
  return breadNeed(inventoryCounts(ctx), targets, foodTarget);
}

function shouldVisitChest(ctx, targets, bedCount, foodTarget) {
  const counts = inventoryCounts(ctx);
  return Object.values(targetGaps(counts, targets)).some((gap) => gap > 0) ||
    sumBeds(counts) < bedCount || sumFood(counts) < foodTarget;
}

function eligibleSites(ctx, targets, bedCount, foodTarget, range, avoid) {
  const resources = ctx.getResourceSites();
  if (!resources || typeof resources !== 'object') return [];
  const counts = inventoryCounts(ctx);
  const bedNeed = Math.max(0, bedCount - sumBeds(counts));
  const foodNeed = currentFoodNeed(ctx, targets, foodTarget);
  const needsWheat = toCount(targets.wheat) > toCount(counts.wheat) || foodNeed > 0;
  const candidates = [];
  if (bedNeed > 0) {
    for (const site of Array.isArray(resources.beds) ? resources.beds : []) {
      if (isBed(site?.name)) candidates.push({ ...site, kind: 'bed', priority: 0 });
    }
  }
  if (resources.village_evidence === true && shouldVisitChest(ctx, targets, bedCount, foodTarget)) {
    for (const site of Array.isArray(resources.chests) ? resources.chests : []) {
      if (site?.name === 'chest' || site?.name === 'trapped_chest') {
        candidates.push({ ...site, kind: 'chest', priority: 1 });
      }
    }
  }
  if (needsWheat) {
    for (const site of Array.isArray(resources.hay) ? resources.hay : []) {
      if (site?.name === 'hay_block') candidates.push({ ...site, kind: 'hay', priority: 2 });
    }
  }
  return candidates
    .filter((site) => {
      const key = coordinateKey(site);
      if (!key || avoid.has(key) || !withinRange(ctx, site, range)) return false;
      return site.kind !== 'bed' || !insideRememberedShelter(site, ctx.getRememberedShelter?.());
    })
    .sort((left, right) => left.priority - right.priority ||
      Math.hypot(left.x - ctx.bot.entity.position.x, left.y - ctx.bot.entity.position.y, left.z - ctx.bot.entity.position.z) -
      Math.hypot(right.x - ctx.bot.entity.position.x, right.y - ctx.bot.entity.position.y, right.z - ctx.bot.entity.position.z));
}

function cappedSearchContext(ctx, maxSearchSteps) {
  const wrapper = Object.create(ctx);
  const explore = ctx.exploreResource;
  wrapper.exploreResource = (step, heading, state) => {
    if (step >= maxSearchSteps || typeof explore !== 'function') return 'no_target';
    return explore(step, heading, state);
  };
  return wrapper;
}

function searchState() {
  return {
    steps: 0,
    heading: Math.random() * Math.PI * 2,
    scanned: false,
    excluded: new Set(),
    visited: new Set(),
  };
}

async function nextSite(ctx, targets, bedCount, foodTarget, range, avoid, state, maxSearchSteps) {
  return findBlocksWithExploration(
    cappedSearchContext(ctx, maxSearchSteps),
    null,
    range,
    64,
    () => eligibleSites(ctx, targets, bedCount, foodTarget, range, avoid),
    state,
  );
}

function getInventoryRange(window) {
  const start = Number.isFinite(window?.inventoryStart) ? window.inventoryStart : 27;
  const end = Number.isFinite(window?.inventoryEnd) ? window.inventoryEnd : start + 36;
  return { start, end: Math.max(start, end) };
}

function readRange(window, start, end) {
  const counts = {};
  for (let index = start; index < end; index += 1) {
    const item = window?.slots?.[index];
    if (!item?.name || !item.count) continue;
    counts[item.name] = (counts[item.name] || 0) + toCount(item.count);
  }
  return counts;
}

function stackLimit(ctx, window, name) {
  const registered = ctx.registry?.itemsByName?.[name]?.maxStack;
  if (Number.isFinite(registered) && registered > 0) return registered;
  for (const item of window?.slots || []) {
    if (item?.name === name && Number.isFinite(item.stackSize) && item.stackSize > 0) return item.stackSize;
  }
  return BED_SET.has(name) || /_(pickaxe|axe|shovel|sword|hoe|helmet|chestplate|leggings|boots)$/.test(name) ||
    ['bow', 'crossbow', 'trident', 'shield'].includes(name) ? 1 : 64;
}

function inventoryRoom(ctx, window, name) {
  const { start, end } = getInventoryRange(window);
  const maxStack = stackLimit(ctx, window, name);
  let room = 0;
  for (let index = start; index < end; index += 1) {
    const item = window?.slots?.[index];
    if (!item) room += maxStack;
    else if (item.name === name) room += Math.max(0, maxStack - toCount(item.count));
  }
  return room;
}

function inventorySlotFor(window, name) {
  const { start, end } = getInventoryRange(window);
  let empty = null;
  for (let index = start; index < end; index += 1) {
    const item = window?.slots?.[index];
    if (!item) {
      if (empty === null) empty = index;
    } else if (item.name === name && toCount(item.count) < toCount(item.stackSize || 64)) {
      return index;
    }
  }
  return empty;
}

function containerSlots(window) {
  return Number.isFinite(window?.inventoryStart) ? window.inventoryStart : 27;
}

function checkContainerSync(ctx) {
  if (typeof ctx.syncWindow !== 'function' || typeof ctx.clickWindowSlot !== 'function') {
    throw new Error('桥接没有提供箱子窗口点击与同步能力');
  }
}

async function syncWindow(ctx, window) {
  checkContainerSync(ctx);
  const synchronized = await ctx.syncWindow(window, SYNC_TIMEOUT_MS);
  if (synchronized === false) throw new Error('箱子窗口同步失败，物品位置状态未知');
}

async function transferExact(ctx, window, name, requested) {
  checkContainerSync(ctx);
  let moved = 0;
  const containerEnd = containerSlots(window);
  const inventory = getInventoryRange(window);
  while (moved < requested) {
    interrupted(ctx, '箱子取物');
    const sourceSlot = (window.slots || []).findIndex((item, index) => index < containerEnd && item?.name === name && toCount(item.count) > 0);
    if (sourceSlot < 0) break;
    const sourceCount = toCount(window.slots[sourceSlot].count);
    const bagBefore = readRange(window, inventory.start, inventory.end);
    const capacity = inventoryRoom(ctx, window, name);
    const amount = Math.min(requested - moved, sourceCount, capacity);
    if (amount <= 0) break;
    if (sourceCount <= amount) {
      await ctx.clickWindowSlot(window, sourceSlot, 0, 1);
      await sleepCtx(ctx, CLICK_GAP_MS);
    } else {
      let cursorRaised = false;
      try {
        await ctx.clickWindowSlot(window, sourceSlot, 0, 0);
        cursorRaised = true;
        await sleepCtx(ctx, CLICK_GAP_MS);
        for (let index = 0; index < amount; index += 1) {
          interrupted(ctx, '箱子取物');
          const targetSlot = inventorySlotFor(window, name);
          if (targetSlot === null) break;
          await ctx.clickWindowSlot(window, targetSlot, 1, 0);
          await sleepCtx(ctx, CLICK_GAP_MS);
        }
      } finally {
        if (cursorRaised && window.selectedItem) {
          try {
            await ctx.clickWindowSlot(window, sourceSlot, 0, 0);
            await sleepCtx(ctx, CLICK_GAP_MS);
          } catch (error) {
            if (typeof ctx.log === 'function') ctx.log('箱子取物时返还光标物品失败', error.message);
          }
        }
      }
    }
    await syncWindow(ctx, window);
    const bagAfter = readRange(window, inventory.start, inventory.end);
    const gained = toCount(bagAfter[name]) - toCount(bagBefore[name]);
    if (gained <= 0) break;
    moved += gained;
  }
  return moved;
}

function chestRequests(chestCounts, bagCounts, targets, bedCount, foodTarget) {
  const requested = new Map();
  for (const [name, target] of Object.entries(targets)) {
    const need = Math.max(0, target - toCount(bagCounts[name]));
    if (need > 0 && toCount(chestCounts[name]) > 0) requested.set(name, Math.min(need, toCount(chestCounts[name])));
  }
  let bedNeed = Math.max(0, bedCount - sumBeds(bagCounts));
  for (const name of BED_NAMES) {
    if (bedNeed <= 0) break;
    const available = toCount(chestCounts[name]);
    if (!available) continue;
    const amount = Math.min(available, bedNeed);
    requested.set(name, Math.max(requested.get(name) || 0, amount));
    bedNeed -= amount;
  }
  let foodNeed = Math.max(0, foodTarget - sumFood(bagCounts));
  for (const name of FOOD_ITEMS) {
    const available = toCount(chestCounts[name]);
    if (!available) continue;
    const individualNeed = Math.max(0, (targets[name] || 0) - toCount(bagCounts[name]));
    const amount = Math.min(available, Math.max(individualNeed, foodNeed));
    if (amount > 0) {
      requested.set(name, Math.max(requested.get(name) || 0, amount));
      foodNeed = Math.max(0, foodNeed - amount);
    }
  }
  return [...requested.entries()].map(([item, count]) => ({ item, count }));
}

async function travelToSite(ctx, site) {
  interrupted(ctx);
  if (typeof ctx.travelToBlock !== 'function') throw new Error('桥接没有靠近资源点的寻路能力');
  const outcome = await ctx.travelToBlock({ x: site.x, y: site.y, z: site.z });
  interrupted(ctx);
  if (outcome !== 'reached') throw new Error(`没有安全到达资源点（${outcome || '未知状态'}）`);
}

async function closeChest(ctx, window) {
  if (!window) return;
  try {
    await ctx.bot.closeWindow(window);
  } catch (error) {
    if (typeof ctx.log === 'function') ctx.log('关闭村庄箱子失败', error.message);
  }
}

async function syncInventoryAfterChest(ctx) {
  if (ctx.interrupted || typeof ctx.syncInventory !== 'function') return;
  try {
    await ctx.syncInventory();
  } catch (error) {
    if (error?.code === 'UNKNOWN_WINDOW_STATE') throw error;
    if (typeof ctx.log === 'function') ctx.log('关闭村庄箱子后同步背包失败', error.message);
  }
}

async function lootChest(ctx, site, targets, bedCount, foodTarget, range) {
  await travelToSite(ctx, site);
  const currentBlock = blockAt(ctx, site);
  if (!currentBlock || !['chest', 'trapped_chest'].includes(currentBlock.name)) {
    return { outcome: 'stale', moved: {} };
  }
  if (typeof ctx.bot?.openBlock !== 'function' || typeof ctx.bot?.closeWindow !== 'function') {
    throw new Error('桥接没有打开或关闭村庄箱子的能力');
  }
  let window = null;
  const moved = {};
  try {
    window = await ctx.bot.openBlock(currentBlock);
    if (!window) throw new Error('没有打开村庄箱子');
    interrupted(ctx, '村庄箱子检查');
    const containerEnd = containerSlots(window);
    const inventory = getInventoryRange(window);
    const chestCounts = readRange(window, 0, containerEnd);
    let bagCounts = readRange(window, inventory.start, inventory.end);
    const requests = chestRequests(chestCounts, bagCounts, targets, bedCount, foodTarget);
    for (const entry of requests) {
      interrupted(ctx, '村庄箱子取物');
      const currentBag = readRange(window, inventory.start, inventory.end);
      const targetCount = targets[entry.item] || 0;
      const groupNeed = FOOD_SET.has(entry.item)
        ? Math.max(0, foodTarget - sumFood(currentBag))
        : 0;
      const bedNeed = BED_SET.has(entry.item) ? Math.max(0, bedCount - sumBeds(currentBag)) : 0;
      const explicitNeed = Math.max(0, targetCount - toCount(currentBag[entry.item]));
      const stillWanted = Math.max(explicitNeed, groupNeed, bedNeed);
      const amount = Math.min(entry.count, stillWanted, toCount(chestCounts[entry.item]));
      if (amount <= 0) continue;
      const gained = await transferExact(ctx, window, entry.item, amount);
      if (gained > 0) moved[entry.item] = (moved[entry.item] || 0) + gained;
    }
    await syncWindow(ctx, window);
    bagCounts = readRange(window, inventory.start, inventory.end);
    return { outcome: requests.length ? 'checked' : 'empty_or_unhelpful', moved };
  } finally {
    await closeChest(ctx, window || ctx.bot.currentWindow);
    await syncInventoryAfterChest(ctx);
  }
}

function bedItemCounts(ctx) {
  const counts = inventoryCounts(ctx);
  return BED_NAMES.reduce((total, name) => total + toCount(counts[name]), 0);
}

async function collectBed(ctx, site, range) {
  await travelToSite(ctx, site);
  const block = blockAt(ctx, site);
  if (!block || !isBed(block.name)) return { outcome: 'stale', item: site.name, gained: 0 };
  const properties = typeof block.getProperties === 'function' ? block.getProperties() : {};
  if (properties.occupied === true || properties.occupied === 'true' || properties.part === 'head') {
    return { outcome: 'occupied_or_head', item: block.name, gained: 0 };
  }
  if (typeof ctx.breakBlock !== 'function' || typeof ctx.collectDrops !== 'function') {
    throw new Error('桥接没有破坏床或拾取掉落物的能力');
  }
  const before = inventoryCounts(ctx);
  await ctx.breakBlock({ x: site.x, y: site.y, z: site.z });
  interrupted(ctx, '村庄床采集');
  await ctx.collectDrops(4, block.name);
  interrupted(ctx, '村庄床采集');
  const after = inventoryCounts(ctx);
  return {
    outcome: toCount(after[block.name]) > toCount(before[block.name]) ? 'collected' : 'drop_not_confirmed',
    item: block.name,
    gained: Math.max(0, toCount(after[block.name]) - toCount(before[block.name])),
  };
}

function hasCraftingTable(ctx, range) {
  return toCount(ctx.countItem?.('crafting_table')) > 0 ||
    (typeof ctx.nearbyBlock === 'function' && Boolean(ctx.nearbyBlock('crafting_table', Math.min(range, 32))));
}

async function craftBreadIfReady(ctx, targets, foodTarget, range) {
  const counts = inventoryCounts(ctx);
  const wanted = breadNeed(counts, targets, foodTarget);
  const reservedWheat = toCount(targets.wheat);
  const availableWheat = Math.max(0, toCount(counts.wheat) - reservedWheat);
  const craftable = Math.min(wanted, Math.floor(availableWheat / 3));
  if (craftable <= 0 || !hasCraftingTable(ctx, range) || typeof ctx.craftItem !== 'function') {
    return { crafted: 0, missing_table: wanted > 0 && craftable > 0 && !hasCraftingTable(ctx, range) };
  }
  interrupted(ctx, '面包合成');
  const before = toCount(counts.bread);
  await ctx.craftItem({ item: 'bread', count: craftable });
  interrupted(ctx, '面包合成');
  const after = inventoryCounts(ctx);
  return { crafted: Math.max(0, toCount(after.bread) - before), missing_table: false };
}

async function collectHay(ctx, site, range, targets, foodTarget) {
  await travelToSite(ctx, site);
  const block = blockAt(ctx, site);
  if (!block || block.name !== 'hay_block') return { outcome: 'stale', wheat: 0, bread: 0 };
  if (typeof ctx.breakBlock !== 'function' || typeof ctx.collectDrops !== 'function') {
    throw new Error('桥接没有破坏干草块或拾取掉落物的能力');
  }
  const before = inventoryCounts(ctx);
  await ctx.breakBlock({ x: site.x, y: site.y, z: site.z });
  interrupted(ctx, '干草采集');
  await ctx.collectDrops(4, 'hay_block');
  interrupted(ctx, '干草采集');
  let after = inventoryCounts(ctx);
  const hayBlocks = Math.max(0, toCount(after.hay_block) - toCount(before.hay_block));
  let wheat = Math.max(0, toCount(after.wheat) - toCount(before.wheat));
  let missingTable = false;
  if (hayBlocks > 0) {
    const wheatNeed = Math.max(0, targetWheat(after, targets, foodTarget) - toCount(after.wheat));
    const wheatCraftTarget = Math.min(wheatNeed, hayBlocks * 9);
    if (wheatCraftTarget > 0 && hasCraftingTable(ctx, range) && typeof ctx.craftItem === 'function') {
      interrupted(ctx, '干草转小麦');
      await ctx.craftItem({ item: 'wheat', count: wheatCraftTarget });
      interrupted(ctx, '干草转小麦');
      after = inventoryCounts(ctx);
      wheat = Math.max(0, toCount(after.wheat) - toCount(before.wheat));
    } else if (wheatCraftTarget > 0) {
      missingTable = !hasCraftingTable(ctx, range);
    }
  }
  const crafted = await craftBreadIfReady(ctx, targets, foodTarget, range);
  return {
    outcome: hayBlocks > 0 || wheat > 0 ? 'collected' : 'drop_not_confirmed',
    hay_block: hayBlocks,
    wheat,
    bread: crafted.crafted,
    missing_table: missingTable || crafted.missing_table,
  };
}

function reportData(before, after, targets, bedTarget, foodTarget, visitedSites, visits) {
  const gaps = targetGaps(after, targets);
  const bedBefore = sumBeds(before);
  const bedAfter = sumBeds(after);
  const foodBefore = sumFood(before);
  const foodAfter = sumFood(after);
  return {
    visited_sites: [...visitedSites],
    visits,
    target_gaps: gaps,
    bed_count: {
      target: bedTarget,
      before: bedBefore,
      after: bedAfter,
      missing: Math.max(0, bedTarget - bedAfter),
    },
    food_count: {
      target: foodTarget,
      before: foodBefore,
      after: foodAfter,
      missing: Math.max(0, foodTarget - foodAfter),
    },
    delta: countDifference(before, after),
  };
}

function unmetSummary(data) {
  const parts = [];
  for (const [item, gap] of Object.entries(data.target_gaps)) {
    if (gap > 0) parts.push(`${item} 还差 ${gap}`);
  }
  if (data.bed_count.missing > 0) parts.push(`床还差 ${data.bed_count.missing} 张`);
  if (data.food_count.missing > 0) parts.push(`食物还差 ${data.food_count.missing} 个`);
  return parts;
}

function progress(ctx, before, targets, bedCount, foodTarget, visitedSites, visits, detail) {
  if (typeof ctx.reportProgress !== 'function') return;
  const data = reportData(before, inventoryCounts(ctx), targets, bedCount, foodTarget, visitedSites, visits);
  ctx.reportProgress('resource_looting', detail, 0.5, data);
}

async function lootVillage(args, ctx) {
  if (!ctx.bot?.entity) throw new Error('bot 尚未进入世界');
  if (typeof ctx.getResourceSites !== 'function') throw new Error('桥接没有提供当前观察到的 resource_sites');
  const targets = normalizeTargets(args.targets);
  const bedCount = clamp(args.bed_count, 1, 0, 16);
  const foodTarget = clamp(args.food_target, 16, 0, 1024);
  const range = clamp(args.range, DEFAULT_RANGE, 4, 64);
  const maxSearchSteps = args.max_search_steps === undefined
    ? MAX_SEARCH_STEPS
    : clamp(args.max_search_steps, 0, 0, MAX_SEARCH_STEPS);
  const avoid = parseAvoidPositions(args.avoid_positions);
  const before = inventoryCounts(ctx);
  const visitedSites = new Set();
  const visits = [];
  const state = searchState();
  let lastMissingTable = false;

  const finish = () => {
    const after = inventoryCounts(ctx);
    const data = reportData(before, after, targets, bedCount, foodTarget, visitedSites, visits);
    const missing = unmetSummary(data);
    const status = missing.length ? 'partial' : 'succeeded';
    const breadTarget = breadNeed(after, targets, foodTarget);
    const detail = [
      `检查了 ${visits.length} 个村庄/资源点`,
      `背包增量 ${Object.entries(data.delta).map(([name, count]) => `${name} ${count > 0 ? '+' : ''}${count}`).join('、') || '无'}`,
      missing.length ? `未完成：${missing.join('；')}` : '所有目标已满足',
      lastMissingTable && breadTarget > 0
        ? `附近和背包都没有工作台，保留 ${toCount(after.wheat)} 个小麦与 ${toCount(after.hay_block)} 个干草块供后续合成`
        : '',
    ].filter(Boolean).join('；');
    return { detail, status, data };
  };

  const initialBread = await craftBreadIfReady(ctx, targets, foodTarget, range);
  if (initialBread.missing_table) lastMissingTable = true;
  if (initialBread.crafted > 0) {
    visits.push({ type: 'craft_bread', name: 'bread', x: null, y: null, z: null, delta: initialBread.crafted });
    progress(ctx, before, targets, bedCount, foodTarget, visitedSites, visits, `按 3 wheat → 1 bread 配方合成了 ${initialBread.crafted} 个面包`);
  }

  while (true) {
    interrupted(ctx);
    const candidates = await nextSite(ctx, targets, bedCount, foodTarget, range, avoid, state, maxSearchSteps);
    if (!candidates.length) break;
    let selected = null;
    for (const candidate of candidates) {
      const key = coordinateKey(candidate);
      if (!key || state.excluded.has(key)) continue;
      selected = candidate;
      state.excluded.add(key);
      visitedSites.add(key);
      visits.push({ type: candidate.kind, name: candidate.name, x: Math.floor(candidate.x), y: Math.floor(candidate.y), z: Math.floor(candidate.z) });
      break;
    }
    if (!selected) break;
    let outcome = 'skipped';
    try {
      if (selected.kind === 'bed') {
        const result = await collectBed(ctx, selected, range);
        outcome = result.outcome;
      } else if (selected.kind === 'hay') {
        const result = await collectHay(ctx, selected, range, targets, foodTarget);
        outcome = result.outcome;
        if (result.missing_table) lastMissingTable = true;
        if (result.hay_block > 0) visits[visits.length - 1].hay_block = result.hay_block;
        if (result.bread > 0) visits[visits.length - 1].bread = result.bread;
        if (result.wheat > 0) visits[visits.length - 1].wheat = result.wheat;
      } else if (selected.kind === 'chest') {
        const result = await lootChest(ctx, selected, targets, bedCount, foodTarget, range);
        outcome = result.outcome;
      }
    } catch (error) {
      interrupted(ctx);
      if (error?.code === 'UNKNOWN_WINDOW_STATE' || /\b(cancelled|canceled|stopped)\b|已停止|已取消|被新的指令打断/i.test(String(error?.message || error))) {
        throw error;
      }
      outcome = 'failed';
      visits[visits.length - 1].detail = String(error?.message || error).slice(0, 180);
    }
    visits[visits.length - 1].outcome = outcome;
    progress(ctx, before, targets, bedCount, foodTarget, visitedSites, visits, `检查 ${selected.kind} ${coordinateKey(selected)}：${outcome}`);
    if (outcome === 'failed') continue;

    if (selected.kind === 'hay') {
      const crafted = await craftBreadIfReady(ctx, targets, foodTarget, range);
      if (crafted.crafted > 0) {
        visits.push({ type: 'craft_bread', name: 'bread', x: null, y: null, z: null, delta: crafted.crafted });
        progress(ctx, before, targets, bedCount, foodTarget, visitedSites, visits, `按 3 wheat → 1 bread 配方合成了 ${crafted.crafted} 个面包`);
      }
      if (crafted.missing_table) lastMissingTable = true;
    }
  }
  return finish();
}

async function sleepCtx(ctx, milliseconds) {
  if (typeof ctx.sleep === 'function') await ctx.sleep(milliseconds);
  else await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
