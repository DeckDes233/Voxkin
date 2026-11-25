// 采集与挖矿模块：mine_collect / strip_mine / deep_mine / find_diamond。
// 模块契约见 docs/plans/SKILL_MODULE_CONTRACT.md。
// 本模块只使用 ctx 提供的能力，不 import mineflayer / pathfinder / 其它运行时依赖。
//
// 待接入（集成阶段补 ctx，或在本模块内已经兜底处理）：
// - 挖矿时没有“看手上工具耐久”的独立能力，这里直接读 ctx.bot.heldItem.durabilityUsed。
// - 填埋岩浆要靠背包里的圆石/泥土，这里用 ctx.countItem + ctx.placeBlock 组合。
// - 火把靠 ctx.countItem('torch') 盘点，缺货时用 ctx.craftItem 补；
//   如果 ctx 没有 craftItem，就只能在返回里说明缺什么。

import { findBlocksWithExploration, resourceCandidates } from '../resource_search.js';
import { besideDrop, dryMiningFooting, exposedMagmaCube, followDryGround, followNetherPath, miningRouteExclusion, netherRouteExclusion, reachableDryGround, reachableNetherGround, walkDryCell, walkNetherCell } from '../dry_footing.js';
import { surfaceSkyLight, waterLike } from '../water_escape.js';
import { scanSurfaceLogs } from '../surface_wood_scan.js';
import { forwardCell } from './movement.js';
import { setImmediate as yieldToGame } from 'node:timers/promises';

// 掉落在这一格之外的掉落物就算离得太远，捡不到。
const COLLECT_DROP_RANGE = 6;
// 挖方块的有效距离：超过这个距离就必须先走过去。
const MINE_REACH = 4.5;
// 挖矿途中血量低于这个值就中止。
const LOW_HEALTH = 8;
const MINE_HOSTILE_RADIUS = 8;
const SURFACE_HEIGHT_OFFSETS = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8];
// 火把间隔：每挖多少格放一个。
const TORCH_INTERVAL = 8;
// 钻石矿的两种 id，普通钻石矿在深层是 deepslate_diamond_ore。
const DIAMOND_ORES = ['diamond_ore', 'deepslate_diamond_ore'];
const OVERWORLD_LOGS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'].map(name => `${name}_log`);
// 深层必须躲开的两类洞穴怪。
const DEEP_DANGER_MOBS = new Set(['enderman', 'ghast']);

// 空气的三种 id。
const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);

// 流体在 minecraft-data 里的 boundingBox 也是 empty，但不能当成通路。
const FLUID_NAMES = new Set(['water', 'lava', 'flowing_water', 'flowing_lava', 'bubble_column']);

// 这些方块在游戏里不挡路，但 boundingBox 不一定是 empty。
// 走廊判定时按“可以走”处理，主要是我们自己放下去的火把。
const PASSABLE_NAMES = new Set([
  'torch', 'redstone_torch', 'soul_torch', 'wall_torch', 'glow_lichen',
  'rail', 'lever', 'tripwire_hook', 'vine', 'ladder', 'sugar_cane',
  'tall_grass', 'short_grass', 'dead_bush', 'oak_sign', 'poppy', 'dandelion',
]);

// 候选路线按南、西、北、东枚举。
const CARDINAL_HEADINGS = [
  { x: 0, z: 1, name: 'south' },
  { x: -1, z: 0, name: 'west' },
  { x: 0, z: -1, name: 'north' },
  { x: 1, z: 0, name: 'east' },
];

// 绕行时能选的 8 个朝向：先四个正方向，再四个斜方向。
const ALL_HEADINGS = [
  ...CARDINAL_HEADINGS,
  { x: 1, z: 1, name: 'south-east' },
  { x: -1, z: 1, name: 'south-west' },
  { x: -1, z: -1, name: 'north-west' },
  { x: 1, z: -1, name: 'north-east' },
];

// ---------------------------------------------------------------------------
// 纯逻辑：坐标计算与方块判定，可以脱离游戏单独测试
// ---------------------------------------------------------------------------

// 坐标计算：把位置按格取整再加偏移，返回普通对象而不是 Vec3。
export function offsetPos(pos, dx = 0, dy = 0, dz = 0) {
  return {
    x: Math.floor(pos.x) + dx,
    y: Math.floor(pos.y) + dy,
    z: Math.floor(pos.z) + dz,
  };
}

// 坐标计算：把实体位置取整成脚下的那一格。
export function floorPos(pos) {
  return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
}

// 坐标计算：两点之间的三维距离。
export function distanceBetween(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

// 坐标展示：统一写成 (x, y, z)。
export function formatPosition(pos) {
  return `(${pos.x}, ${pos.y}, ${pos.z})`;
}

// 坐标计算：沿朝向排一条巷道的落点。
export function planTunnelPoints(start, direction, length) {
  const points = [];
  const total = Math.max(0, Math.floor(length));
  for (let step = 1; step <= total; step += 1) {
    points.push(offsetPos(start, direction.x * step, 0, direction.z * step));
  }
  return points;
}

// 方块判定：是不是空气。区块没加载时返回 false，判定宁可保守也不要误判。
// 注意水和岩浆的 boundingBox 也是 empty，但它们不是空气。
export function isAirBlock(block) {
  if (!block) return false;
  if (AIR_NAMES.has(block.name)) return true;
  if (FLUID_NAMES.has(block.name)) return false;
  return block.boundingBox === 'empty';
}

// 方块判定：能不能站人或者走过去（空气加上不挡路的装饰方块）。
export function isPassableBlock(block) {
  if (!block) return false;
  if (isAirBlock(block)) return true;
  if (FLUID_NAMES.has(block.name)) return false;
  return PASSABLE_NAMES.has(block.name);
}

// 方块判定：是不是岩浆。
export function isLavaBlock(block) {
  if (!block) return false;
  return block.name === 'lava' || block.name === 'flowing_lava';
}

// 方块判定：是不是水。
export function isWaterBlock(block) {
  if (!block) return false;
  return block.name.includes('water');
}

// 方块判定：是不是必须停下来的危险方块。
export function isHazardBlock(block) {
  return isLavaBlock(block) || isWaterBlock(block);
}

// 方块判定：是不是钻石矿（普通矿与深层变体都要认）。
export function isDiamondOre(name) {
  return DIAMOND_ORES.includes(String(name || ''));
}

// 物品 id 换名字。registry.items 是按 id 建的索引。
export function itemNameById(registry, id) {
  const entry = registry?.items?.[id];
  if (entry?.name) return entry.name;
  for (const candidate of Object.values(registry?.itemsByName || {})) {
    if (candidate.id === id) return candidate.name;
  }
  return '';
}

// 方块挖掉之后掉什么。石头掉圆石，钻石矿掉钻石，原木还是原木。
// 掉落物在 minecraft-data 里是物品 id，这里换成物品名。
export function dropItemName(registry, blockEntry, fallback) {
  const dropId = blockEntry?.drops?.[0];
  if (Number.isFinite(dropId)) {
    const name = itemNameById(registry, dropId);
    if (name) return name;
  }
  return fallback;
}

// Mineflayer 的 yaw 0 朝北，正 π/2 朝西。
export function directionFromYaw(yaw) {
  const angle = Number(yaw);
  if (!Number.isFinite(angle)) return null;
  const {dx, dz} = forwardCell(angle);
  return CARDINAL_HEADINGS.find(h => h.x === dx && h.z === dz);
}

// 朝向换算：按名字取朝向。
export function directionFromName(name) {
  const key = String(name || '').toLowerCase();
  return CARDINAL_HEADINGS.find((heading) => heading.name === key) || null;
}

// 安全走廊判定：头顶 2 格与前方 1 格都要能站人/能走。
// 这是继续往前挖的前置条件，不满足就不能挖。
export function isSafeCorridor(bot, pos, direction) {
  const heading = direction || directionFromYaw(bot?.entity?.yaw);
  if (!heading) return false;
  const head = blockAtPos(bot, offsetPos(pos, 0, 1, 0));
  const headTop = blockAtPos(bot, offsetPos(pos, 0, 2, 0));
  const front = blockAtPos(bot, offsetPos(pos, heading.x, 0, heading.z));
  return isPassableBlock(head) && isPassableBlock(headTop) && isPassableBlock(front);
}

// 危险扫描：前方那一列与脚下几格里的岩浆和水。
// ahead 是往前看几格，down 是前方那一列往下看几格，below 是脚下垂直看几格。
export function scanHazards(bot, pos, direction, options = {}) {
  const ahead = options.ahead ?? 1;
  const down = options.down ?? 2;
  const below = options.below ?? 3;
  const heading = direction || { x: 0, z: 0 };
  const lava = [];
  const water = [];
  const push = (list, block, fallback) => {
    list.push(
      block.position
        ? { x: block.position.x, y: block.position.y, z: block.position.z, name: block.name }
        : { ...fallback, name: block.name },
    );
  };
  for (let step = 1; step <= ahead; step += 1) {
    for (let dy = 0; dy >= -down; dy -= 1) {
      const at = offsetPos(pos, heading.x * step, dy, heading.z * step);
      const block = blockAtPos(bot, at);
      if (isLavaBlock(block)) push(lava, block, at);
      else if (isWaterBlock(block)) push(water, block, at);
    }
  }
  for (let depth = 1; depth <= below; depth += 1) {
    const under = offsetPos(pos, 0, -depth, 0);
    const underBlock = blockAtPos(bot, under);
    if (isLavaBlock(underBlock)) push(lava, underBlock, under);
    else if (isWaterBlock(underBlock)) push(water, underBlock, under);
    const aheadUnder = offsetPos(pos, heading.x, -depth, heading.z);
    const aheadBlock = blockAtPos(bot, aheadUnder);
    if (isLavaBlock(aheadBlock)) push(lava, aheadBlock, aheadUnder);
    else if (isWaterBlock(aheadBlock)) push(water, aheadBlock, aheadUnder);
  }
  return { lava, water };
}

// 选一个能走的朝向：优先用 preferred，其次按 8 个方向依次试。
// 头顶是岩浆水、前方有岩浆的朝向一律跳过。
// 前方那一格是石头是可以挖的，所以这里不要求前方已经是空气；
// 严格的“头顶 2 格与前方 1 格是空气”由 isSafeCorridor 在走进那一格之前把关。
export function pickSafeHeading(bot, pos, options = {}) {
  const exclude = new Set(options.exclude || []);
  const tried = new Set();
  const candidates = [];
  if (options.preferred) candidates.push(options.preferred);
  for (const heading of ALL_HEADINGS) candidates.push(heading);
  for (const heading of candidates) {
    if (!heading || tried.has(heading.name)) continue;
    tried.add(heading.name);
    if (exclude.has(heading.name)) continue;
    const head = blockAtPos(bot, offsetPos(pos, 0, 1, 0));
    const headTop = blockAtPos(bot, offsetPos(pos, 0, 2, 0));
    if (isHazardBlock(head) || isHazardBlock(headTop)) continue;
    const hazards = scanHazards(bot, pos, heading, {
      ahead: options.ahead ?? 2,
      down: options.down ?? 1,
      below: options.below ?? 0,
    });
    if (hazards.lava.length > 0) continue;
    return heading;
  }
  return null;
}

// 采集结果描述：把“挖完没掉”的几种原因说清楚。
// hazard: 'lava' | 'water'；distance: 掉落物离多远；reach: 捡拾范围。
export function classifyDropOutcome(state = {}) {
  if (state.hazard === 'lava') return '掉落物掉进岩浆，没有捡到';
  if (state.hazard === 'water') return '掉落物掉进水里，没有捡到';
  if (typeof state.distance === 'number' && typeof state.reach === 'number' && state.distance > state.reach) {
    return `掉落物距离 ${state.distance.toFixed(1)} 格，太远没有捡到`;
  }
  if (state.toolBroken) return '挖掉了但没有掉落物，工具耐久已经耗尽';
  if (state.playerNearby) {
    const who = state.playerName ? `${state.playerName} ` : '';
    return `挖掉了但没有掉落物，可能被附近的${who}捡走了`;
  }
  return '挖掉了但没有掉落物';
}

// 数量不足时的中文描述，必须带“还差”或“没有”，方便 Core 侧分类。
export function summarizeShortage(gained, need, label) {
  if (gained <= 0) return `没有拿到${label}`;
  const missing = Math.max(0, need - gained);
  return `只拿到 ${gained} 个${label}，还差 ${missing} 个`;
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function requireConnected(ctx) {
  const bot = ctx.bot;
  if (!bot || !bot.entity) throw new Error('与 Minecraft 的连接已断开，采集中止');
  checkInterrupted(ctx);
}

function checkInterrupted(ctx) {
  if (ctx.interrupted) throw new Error('挖矿被取消：收到新的指令或动作超时');
}

// 低血就停，不继续往危险里走。
function checkHealth(ctx, limit = LOW_HEALTH) {
  const health = Number(ctx.bot?.health);
  if (!Number.isFinite(health)) return;
  if (health <= limit) throw new Error(`血量不足（血量 ${health}），已中止采集`);
}

function checkNearbyHostiles(ctx) {
  if (typeof ctx.nearbyHostiles !== 'function') return;
  const hostiles = ctx.nearbyHostiles(MINE_HOSTILE_RADIUS);
  if (hostiles.length > 0) {
    const names = hostiles.map((hostile) => hostile.name).join('、');
    const error = new Error(`附近 ${MINE_HOSTILE_RADIUS} 格内有敌对生物（${names}），停止采矿`);
    error.data = {phase: 'safe_stop', reason: 'nearby_hostiles', hostiles};
    throw error;
  }
}

function blockLabelOf(ctx, name) {
  if (typeof ctx.blockLabel === 'function') return ctx.blockLabel(name);
  return String(name);
}

// 掉落物是物品，用物品名；找不到物品标签就退回方块标签。
function itemLabelOf(ctx, name, fallback) {
  if (typeof ctx.itemLabel === 'function') {
    const label = ctx.itemLabel(name);
    if (label && label !== name) return label;
  }
  if (typeof ctx.blockLabel === 'function') {
    const label = ctx.blockLabel(name);
    if (label && label !== name) return label;
  }
  return fallback || String(name);
}

function registryOf(ctx) {
  return ctx.registry || ctx.bot?.registry || null;
}

function blockProperties(block) {
  if (typeof block?.getProperties === 'function') {
    try {
      return block.getProperties();
    } catch {
      return {};
    }
  }
  return block?._properties || {};
}

function isSourceFluid(block) {
  const level = Number(blockProperties(block).level ?? block?.metadata);
  return Number.isFinite(level) && level === 0;
}

function findFluidSources(ctx, name, range, count = 64) {
  const bot = ctx.bot;
  const entry = registryOf(ctx)?.blocksByName?.[name];
  if (!entry || typeof bot.findBlocks !== 'function') return [];
  let positions = [];
  try {
    positions = bot.findBlocks({ matching: entry.id, maxDistance: range, count });
  } catch {
    return [];
  }
  return positions.filter((position) => {
    const block = blockAtPos(bot, position);
    return block?.name === name && isSourceFluid(block);
  });
}

function fluidSearchState() {
  return { steps: 0, heading: Math.random() * Math.PI * 2, scanned: false, excluded: new Set(), visited: new Set() };
}

async function searchFluidSources(ctx, name, range, state = fluidSearchState()) {
  return findBlocksWithExploration(ctx, null, range, 64, (excludedCount) =>
    findFluidSources(ctx, name, range, Math.min(256, 64 + excludedCount)).filter((position) =>
      !state.excluded.has(`${position.x},${position.y},${position.z}`),
    ),
    state,
  );
}

function findInventoryItem(ctx, name) {
  return ctx.bot.inventory?.items?.().find((item) => item.name === name) || null;
}

async function waitForItemChange(ctx, itemName, previousCount, direction, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    checkInterrupted(ctx);
    const current = ctx.countItem(itemName);
    if (direction === 'increase' ? current > previousCount : current < previousCount) return current;
    await ctx.sleep(100);
  }
  return ctx.countItem(itemName);
}

async function useBucketOn(ctx, bucketName, block, face = null) {
  const bot = ctx.bot;
  const bucket = findInventoryItem(ctx, bucketName);
  if (!bucket) throw new Error(`背包里没有${bucketName === 'bucket' ? '空桶' : '水桶'}`);
  await bot.equip(bucket, 'hand');
  checkInterrupted(ctx);
  if (typeof bot.activateItem === 'function' && typeof bot.lookAt === 'function') {
    // Java 桶使用物品的射线拾取液体源，视线落在指定方块或倾倒面上。
    const hit = block.position.offset(0.5 + (face?.x || 0) * 0.5, 0.5 + (face?.y || 0) * 0.5, 0.5 + (face?.z || 0) * 0.5);
    await bot.lookAt(hit, true);
    checkInterrupted(ctx);
    bot.activateItem();
  } else {
    await bot.activateBlock(block, face || undefined);
  }
  await ctx.sleep(250);
  if (typeof ctx.syncInventory === 'function') await ctx.syncInventory();
}

async function moveNearBlock(ctx, position, action, needsSight = false) {
  const bot = ctx.bot;
  if (bot.pathfinder?.movements && typeof ctx.walkOnce === 'function') {
    const origin = bot.entity.position;
    const usable = () => dryMiningFooting(bot, bot.entity.position) && distanceBetween(bot.entity.position, position) <= MINE_REACH &&
      (!needsSight || !bot.canSeeBlock || bot.canSeeBlock(blockAtPos(bot, position)));
    if (usable()) return;
    const banks = [];
    for (const dir of CARDINAL_HEADINGS) {
      for (const dy of [0, 1, -1]) {
        for (const offset of [1, 2]) {
          const feet = position.offset(dir.x * offset, dy, dir.z * offset);
          if (dryMiningFooting(bot, feet)) banks.push(feet);
        }
      }
    }
    banks.sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin));
    for (const feet of banks.slice(0, needsSight ? 5 : 2)) {
      const outcome = await ctx.walkOnce(feet.x, feet.y, feet.z, 0, 12000);
      checkInterrupted(ctx);
      if (outcome === 'cancelled') throw new Error(`${action}被取消`);
      if (usable()) return;
    }
    throw new Error(`没有可安全接触${action}的干燥岸边`);
  }
  if (distanceBetween(bot.entity.position, position) <= MINE_REACH) return;
  if (typeof ctx.travelToBlock !== 'function') throw new Error(`没有靠近${action}的寻路能力`);
  const outcome = await ctx.travelToBlock(position, 30000);
  checkInterrupted(ctx);
  if (outcome === 'cancelled') throw new Error(`${action}被取消`);
  if (outcome === 'low_health') throw new Error(`血量不足，已停止${action}`);
  if (outcome !== 'reached' || distanceBetween(bot.entity.position, position) > MINE_REACH) {
    throw new Error(`无法安全靠近${action}位置 ${formatPosition(position)}`);
  }
}

async function fillWaterBucket(args, ctx) {
  return withDryMiningMovement(ctx, () => fillWaterFromBank(args, ctx));
}

async function nearbyShoreSources(ctx, range) {
  const { bot } = ctx;
  if (!bot.pathfinder?.movements) return [];
  const origin = bot.entity.position.floored();
  const found = [];
  // 最近的几百格水可能全在脚下的含水层。按水平环带找同高度的水面，每批让出事件循环。
  const heights = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -7, -8];
  for (let radius = 1; radius <= range; radius += 2) {
    checkInterrupted(ctx);
    for (let d = -radius; d <= radius; d += 2) {
      for (const [dx, dz] of [[d, radius], [d, -radius], [radius, d], [-radius, d]]) {
        for (const dy of heights) {
          const pos = origin.offset(dx, dy, dz);
          const water = blockAtPos(bot, pos);
          if (water?.name !== 'water' || !isSourceFluid(water) || !isAirBlock(blockAtPos(bot, pos.offset(0, 1, 0)))) continue;
          if (CARDINAL_HEADINGS.some(({ x, z }) => [0, 1, -1].some(h => dryMiningFooting(bot, pos.offset(x, h, z))))) found.push(pos);
          break;
        }
      }
      if ((d + radius) % 16 === 0) await yieldToGame();
    }
    if (found.length >= 4) break;
  }
  return found;
}

async function fillWaterFromBank(args, ctx) {
  requireConnected(ctx);
  if (ctx.countItem('water_bucket') > 0) {
    return { detail: `背包已有水桶 ${ctx.countItem('water_bucket')} 个`, status: 'succeeded' };
  }
  if (ctx.countItem('bucket') < 1) throw new Error('需要一个空桶才能装水');
  const range = clampInt(args.range, 32, 4, 64);
  const searchState = fluidSearchState();
  const failures = [];
  let shores = await nearbyShoreSources(ctx, range);
  while (true) {
    const sources = shores.length ? shores : await searchFluidSources(ctx, 'water', range, searchState);
    shores = [];
    if (!sources.length) break;
    for (const [index, position] of sources.entries()) {
      const key = `${position.x},${position.y},${position.z}`;
      if (searchState.excluded.has(key)) continue;
      searchState.excluded.add(key);
      if (index % 8 === 7) await ctx.sleep(1);
      requireConnected(ctx);
      checkHealth(ctx);
      if (ctx.bot.pathfinder?.movements && !isAirBlock(blockAtPos(ctx.bot, position.offset(0, 1, 0)))) continue;
      try {
        await moveNearBlock(ctx, position, '取水', true);
        const block = blockAtPos(ctx.bot, position);
        if (block?.name !== 'water' || !isSourceFluid(block)) {
          failures.push(`${formatPosition(position)} 已不是静止水源`);
          continue;
        }
        const before = ctx.countItem('water_bucket');
        await useBucketOn(ctx, 'bucket', block);
        const after = await waitForItemChange(ctx, 'water_bucket', before, 'increase');
        if (after > before) {
          return { detail: `从水源 ${formatPosition(position)} 装满水桶`, status: 'succeeded' };
        }
        failures.push(`${formatPosition(position)} 交互后背包没有水桶`);
      } catch (error) {
        checkInterrupted(ctx);
        failures.push(`${formatPosition(position)} ${error.message}`);
      }
    }
  }
  if (!failures.length) throw new Error(`附近 ${range} 格内没有已加载的静止水源`);
  throw new Error(`没有装到水：${failures.slice(-4).join('；')}`);
}

function castingFace(bot, lava) {
  const above = lava.offset(0, 1, 0);
  if (!isAirBlock(blockAtPos(bot, above))) return null;
  const supports = [[above.offset(0, 1, 0), above]];
  for (const { x, z } of CARDINAL_HEADINGS) {
    supports.push([above.offset(x, 0, z), above]);
    supports.push([lava.offset(x, 0, z), above.offset(x, 0, z)]);
  }
  const feet = bot.entity.position.floored();
  const eye = bot.entity.position.offset(0, 1.62, 0);
  for (const [position, water] of supports) {
    const block = blockAtPos(bot, position);
    if (block?.boundingBox !== 'block' || !isAirBlock(blockAtPos(bot, water)) || water.equals(feet)) continue;
    const face = water.minus(position);
    const hit = position.offset(0.5 + face.x / 2, 0.5 + face.y / 2, 0.5 + face.z / 2);
    const ray = hit.minus(eye);
    const reach = ray.norm();
    if (reach > MINE_REACH || ray.dot(face) >= 0) continue;
    if (bot.world?.raycast && !bot.world.raycast(eye, ray.scaled(1 / reach), reach + 0.02)?.position.equals(position)) continue;
    return { block, face, water };
  }
  return null;
}

async function castOneObsidian(ctx, range, visited, searchState) {
  if (ctx.countItem('water_bucket') < 1) throw new Error('没有水桶，无法把静止岩浆浇成黑曜石');
  while (true) {
    requireConnected(ctx);
    checkHealth(ctx, LOW_HEALTH + 2);
    if (typeof ctx.nearbyHostiles === 'function' && ctx.nearbyHostiles(8).length > 0) {
      throw new Error('附近有敌对生物，停止靠近岩浆浇铸');
    }
    const lavaPositions = await searchFluidSources(ctx, 'lava', range, searchState);
    if (!lavaPositions.length) return null;
    for (const position of lavaPositions) {
      const key = `${position.x},${position.y},${position.z}`;
      if (visited.has(key)) continue;
      visited.add(key);
      requireConnected(ctx);
      checkHealth(ctx, LOW_HEALTH + 2);
      if (typeof ctx.nearbyHostiles === 'function' && ctx.nearbyHostiles(8).length > 0) {
        throw new Error('附近有敌对生物，停止靠近岩浆浇铸');
      }
      const bot = ctx.bot;
      try {
        await moveNearBlock(ctx, position, '岩浆源');
      } catch (error) {
        requireConnected(ctx);
        checkHealth(ctx, LOW_HEALTH + 2);
        if (typeof ctx.nearbyHostiles === 'function' && ctx.nearbyHostiles(8).length > 0) {
          throw new Error('寻路后发现敌对生物，停止浇铸');
        }
        if (/被取消|取消|血量不足|低血|断开/.test(error.message)) throw error;
        continue;
      }
      requireConnected(ctx);
      checkHealth(ctx, LOW_HEALTH + 2);
      if (typeof ctx.nearbyHostiles === 'function' && ctx.nearbyHostiles(8).length > 0) {
        throw new Error('靠近岩浆后发现敌对生物，停止浇铸');
      }
      const lava = blockAtPos(bot, position);
      if (lava?.name !== 'lava' || !isSourceFluid(lava)) continue;
      const placement = castingFace(bot, position);
      if (!placement) continue;
      const waterPosition = placement.water;

      const beforeWaterBuckets = ctx.countItem('water_bucket');
      const beforeBuckets = ctx.countItem('bucket');
      await useBucketOn(ctx, 'water_bucket', placement.block, placement.face);
      const deadline = Date.now() + 2500;
      let obsidian = null;
      while (Date.now() < deadline) {
        checkInterrupted(ctx);
        obsidian = blockAtPos(bot, position);
        const flowingWater = blockAtPos(bot, waterPosition);
        if (obsidian?.name === 'obsidian' && flowingWater?.name === 'water' && isSourceFluid(flowingWater)) break;
        await ctx.sleep(100);
      }
      const flowingWater = blockAtPos(bot, waterPosition);
      if (obsidian?.name !== 'obsidian' || flowingWater?.name !== 'water' || !isSourceFluid(flowingWater)) {
        throw new Error(`水流未能在 ${formatPosition(position)} 生成黑曜石并保留可回收水源`);
      }
      const emptyBuckets = await waitForItemChange(ctx, 'bucket', beforeBuckets, 'increase');
      if (emptyBuckets <= beforeBuckets || ctx.countItem('water_bucket') >= beforeWaterBuckets) {
        throw new Error(`已生成黑曜石 ${formatPosition(position)}，但背包水桶状态未确认`);
      }
      // 池边的第一格会先凝固。保留水源数次流动更新，让水覆盖邻近的岩浆。
      for (let tick = 0; tick < 16; tick++) {
        const molten = CARDINAL_HEADINGS.some(({ x, z }) => [1, 2].some(d =>
          blockAtPos(bot, position.offset(x * d, 0, z * d))?.name === 'lava'));
        if (!molten) break;
        checkInterrupted(ctx);
        checkHealth(ctx, LOW_HEALTH + 2);
        await ctx.sleep(250);
      }

      const beforeRecovered = ctx.countItem('water_bucket');
      const waterBlock = blockAtPos(bot, waterPosition);
      await useBucketOn(ctx, 'bucket', waterBlock);
      const recovered = await waitForItemChange(ctx, 'water_bucket', beforeRecovered, 'increase');
      if (recovered <= beforeRecovered) throw new Error('黑曜石已生成，但没有成功收回水源');
      return position;
    }
  }
}

async function collectObsidian(args, ctx) {
  return withDryMiningMovement(ctx, () => collectObsidianOnLand(args, ctx));
}

async function collectObsidianOnLand(args, ctx) {
  requireConnected(ctx);
  const bot = ctx.bot;
  const dimension = String(bot.game?.dimension || '').toLowerCase();
  if (dimension !== 'overworld' && !dimension.includes('overworld')) {
    throw new Error('水桶浇铸黑曜石只在主世界执行');
  }
  const want = clampInt(args.count, 10, 1, 10);
  const range = clampInt(args.range, 32, 8, 64);
  if (ctx.countItem('obsidian') >= want) {
    return { detail: `背包已有 ${ctx.countItem('obsidian')} 个黑曜石`, status: 'succeeded' };
  }
  if (ctx.countItem('diamond_pickaxe') < 1 && ctx.countItem('netherite_pickaxe') < 1) {
    throw new Error('挖黑曜石需要钻石镐或下界合金镐');
  }
  const lavaSearchState = fluidSearchState();
  const visited = lavaSearchState.excluded;
  let existingMiningFailure = '';
  try {
    return await mineCollect({ block: 'obsidian', count: want, range }, ctx, true);
  } catch (error) {
    existingMiningFailure = error.message;
    requireConnected(ctx);
    if (ctx.countItem('obsidian') >= want) {
      return { detail: `获得 ${ctx.countItem('obsidian')} 个黑曜石`, status: 'succeeded' };
    }
  }
  if (ctx.countItem('water_bucket') < 1 && ctx.countItem('bucket') > 0) {
    await fillWaterFromBank({ range }, ctx);
  }
  if (ctx.countItem('water_bucket') < 1) throw new Error('需要一个空桶和附近的静水源才能浇铸黑曜石');
  while (ctx.countItem('obsidian') < want) {
    requireConnected(ctx);
    checkHealth(ctx, LOW_HEALTH + 2);
    const produced = await castOneObsidian(ctx, range, visited, lavaSearchState);
    if (!produced) {
      const missing = want - ctx.countItem('obsidian');
      throw new Error(
        `静止岩浆源耗尽或均不可安全到达，还差 ${missing} 个黑曜石` +
          (existingMiningFailure ? `；直接采集结果：${existingMiningFailure}` : ''),
      );
    }
    try {
      const result = await mineCollect({ block: 'obsidian', count: want, range }, ctx, true);
      return { detail: `${result.detail}；黑曜石由安全浇铸后采集`, status: 'succeeded' };
    } catch (error) {
      existingMiningFailure = error.message;
      requireConnected(ctx);
      if (ctx.countItem('obsidian') >= want) {
        return { detail: `获得 ${ctx.countItem('obsidian')} 个黑曜石`, status: 'succeeded' };
      }
    }
  }
  return { detail: `获得 ${ctx.countItem('obsidian')} 个黑曜石`, status: 'succeeded' };
}

// bot.blockAt 需要 Vec3；普通 {x, y, z} 在区块已加载时会调用 pos.floored() 崩掉。
function toVec3(bot, pos) {
  const base = bot?.entity?.position;
  if (!base) return pos;
  const VecClass = base.constructor;
  if (typeof VecClass === 'function') {
    try {
      return new VecClass(Number(pos.x), Number(pos.y), Number(pos.z));
    } catch {
      // 构造失败就退回 offset，它一定返回 Vec3。
    }
  }
  return base.offset(Number(pos.x) - base.x, Number(pos.y) - base.y, Number(pos.z) - base.z);
}

function blockAtPos(bot, pos) {
  return bot.blockAt(toVec3(bot, pos));
}

// 手上的工具是不是已经坏了。
function toolIsBroken(bot) {
  const held = bot?.heldItem;
  if (!held) return false;
  try {
    const max = Number(held.maxDurability);
    const used = Number(held.durabilityUsed);
    if (!Number.isFinite(max) || max <= 0) return false;
    if (!Number.isFinite(used)) return false;
    return used >= max;
  } catch {
    return false;
  }
}

// 挖一个方块。先按方块换工具，再挖。
// 返回 { ok, reason, message }，失败不抛错，由调用方决定算不算致命。
async function digAt(ctx, position, options = {}) {
  checkInterrupted(ctx);
  const bot = ctx.bot;
  const block = blockAtPos(bot, position);
  if (!block) {
    return { ok: false, reason: 'missing', message: '目标位置的区块没有加载' };
  }
  if (options.expectName && block.name !== options.expectName) {
    return { ok: false, reason: 'changed', message: `目标方块已经变成${blockLabelOf(ctx, block.name)}` };
  }
  if (isHazardBlock(block)) {
    return {
      ok: false,
      reason: 'hazard',
      block,
      message: `目标是${isLavaBlock(block) ? '岩浆' : '水'}`,
    };
  }
  try {
    await ctx.equipToolFor(block);
  } catch (error) {
    checkInterrupted(ctx);
    return { ok: false, reason: 'tool', message: `换工具失败：${error.message}` };
  }
  checkInterrupted(ctx);
  const passageStone = options.clearByHand && ['stone', 'cobblestone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'cobbled_deepslate'].includes(block.name);
  if (!passageStone && typeof block.canHarvest === 'function' && !block.canHarvest(bot.heldItem?.type ?? null)) {
    return { ok: false, reason: 'tool', block, message: '当前工具不能采得该方块的掉落物' };
  }
  if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(block)) {
    return { ok: false, reason: 'tool', block, message: '工具不对或者离得太远，挖不动' };
  }
  try {
    if (block.name === 'obsidian' && typeof bot.digTime === 'function') {
      const duration = bot.digTime(block);
      if (!Number.isFinite(duration) || duration > 25000) return { ok: false, message: '当前站位不能稳定开采黑曜石' };
      ctx.reportProgress?.('mining', `开采黑曜石 ${formatPosition(position)}`, 0, { target: position, dig_time_ms: duration });
      let timer;
      try {
        await Promise.race([bot.dig(block, true, 'raycast'), new Promise((_, reject) => {
          timer = setTimeout(() => {
            if (bot.targetDigBlock?.position.equals(block.position)) bot.stopDigging();
            reject(new Error('黑曜石开采超时'));
          }, duration + 4000);
        })]);
      } finally {
        clearTimeout(timer);
      }
    } else {
      await bot.dig(block);
    }
  } catch (error) {
    checkInterrupted(ctx);
    return { ok: false, reason: 'dig', block, message: `挖不动：${error.message}` };
  }
  checkInterrupted(ctx);
  return { ok: true, block };
}

// 捡掉落物：优先用 ctx.collectDrops（它会真的走过去并核对背包）。
async function collectDrop(ctx, name) {
  const before = ctx.countItem(name);
  let missed = [];
  if (typeof ctx.collectDrops === 'function') {
    const result = await ctx.collectDrops(COLLECT_DROP_RANGE, name);
    missed = result?.missed || [];
  } else if (typeof ctx.pickupItems === 'function') {
    try {
      await ctx.pickupItems({ range: COLLECT_DROP_RANGE });
    } catch {
      // 附近没有掉落物，属于正常情况。
    }
  }
  return { gained: ctx.countItem(name) - before, missed };
}

// 附近的掉落物实体。
function findDropEntities(bot, position, range) {
  if (!bot?.entities) return [];
  return Object.values(bot.entities)
    .filter(
      (entity) =>
        entity &&
        entity.position &&
        (entity.name === 'item' || entity.name === 'Item' || entity.name === 'item_stack') &&
        distanceBetween(entity.position, position) <= range,
    )
    .sort(
      (left, right) =>
        distanceBetween(left.position, position) - distanceBetween(right.position, position),
    );
}

// 挖完之后判断掉落物到底怎么了：掉进岩浆/水里、离得太远、还是没有掉。
function dropFailureState(ctx, position) {
  const bot = ctx.bot;
  const state = { reach: COLLECT_DROP_RANGE };
  const drops = findDropEntities(bot, position, 8);
  if (drops.length > 0) {
    const nearest = drops[0];
    const block = blockAtPos(bot, {
      x: nearest.position.x,
      y: nearest.position.y,
      z: nearest.position.z,
    });
    if (isLavaBlock(block)) state.hazard = 'lava';
    else if (isWaterBlock(block)) state.hazard = 'water';
    state.distance = distanceBetween(nearest.position, bot.entity.position);
  }
  if (!state.hazard) {
    // 掉落物实体还没生成，但坑边就是岩浆，掉落物八成是被烧掉了。
    const hazards = scanHazards(bot, position, null, { ahead: 0, down: 0, below: 1 });
    if (hazards.lava.length > 0) state.hazard = 'lava';
  }
  state.toolBroken = toolIsBroken(bot);
  if (typeof ctx.nearbyPlayers === 'function') {
    const players = ctx.nearbyPlayers(12) || [];
    state.playerNearby = players.length > 0;
    state.playerName = players[0]?.name || '';
  }
  return state;
}

// 往前走一步。返回 'reached' | 'unreachable' | 'stopped' | 'cancelled'。
async function stepForward(ctx, position, onStair = false) {
  checkInterrupted(ctx);
  if (['the_nether', 'minecraft:the_nether'].includes(ctx.bot.game?.dimension) && ctx.bot.setControlState && ctx.bot.look) {
    return walkNetherCell(ctx, toVec3(ctx.bot, position));
  }
  if (onStair && ['overworld', 'minecraft:overworld'].includes(ctx.bot.game?.dimension) && ctx.bot.setControlState && ctx.bot.look) {
    return walkDryCell(ctx, toVec3(ctx.bot, position), 'overworld');
  }
  if (typeof ctx.walkOnce !== 'function') return 'unreachable';
  const outcome = await ctx.walkOnce(position.x, position.y, position.z, 0, 8000);
  checkInterrupted(ctx);
  if (outcome === 'cancelled') throw new Error('挖矿被取消：收到新的指令或连接断开');
  return outcome;
}

// 往前挖一格：先确认前方不是岩浆/水，再把前方那一格和它的头顶两格挖开，
// 确认走廊安全（头顶 2 格与前方 1 格都是空气）之后才走进去。
function supportedNetherPassage(bot, position, front) {
  const next = toVec3(bot, front);
  return bot.blockAt(next.offset(0, -1, 0))?.boundingBox === 'block' && !netherRouteExclusion(bot, {position: next})
    && !besideDrop(bot, next) && [position, front].every(base =>
      [0, 1, 2].every(y => safeStairOpening(bot, offsetPos(base, 0, y, 0))));
}

export function observeNetherPassages(bot) {
  const origin = floorPos(bot.entity.position);
  const lengths = {};
  const cubes = Object.values(bot.entities || {}).filter(e => e?.name === 'magma_cube');
  for (const heading of CARDINAL_HEADINGS) {
    let from = origin;
    for (let step = 1; step <= 4; step++) {
      const next = offsetPos(from, heading.x, 0, heading.z);
      if (!supportedNetherPassage(bot, from, next) || exposedMagmaCube(bot, toVec3(bot, next), cubes)) break;
      lengths[heading.name] = step;
      from = next;
    }
  }
  return {origin, lengths};
}

async function digForward(ctx, position, heading, state, options = {}) {
  const bot = ctx.bot;
  const front = offsetPos(position, heading.x, 0, heading.z);
  const frontBlock = blockAtPos(bot, front);
  if (['the_nether', 'minecraft:the_nether'].includes(bot.game?.dimension)) {
    if (!supportedNetherPassage(bot, position, front)) {
      return {ok: false, reason: 'hazard', position: front, message: '下界前方缺少安全支撑或开挖会暴露危险'};
    }
  }
  if (isHazardBlock(frontBlock)) {
    return {
      ok: false,
      reason: 'hazard',
      position: front,
      block: frontBlock,
      message: `遇到${isLavaBlock(frontBlock) ? '岩浆' : '水'}`,
    };
  }
  // 头顶两格不通就往上挖开，不然走过去会被卡住甚至窒息。
  // 当前脚下这一格与前方那一格都要有 2 格净空。
  for (const base of [position, front]) {
    for (const dy of [1, 2]) {
      const at = offsetPos(base, 0, dy, 0);
      const block = blockAtPos(bot, at);
      if (isPassableBlock(block)) continue;
      if (isHazardBlock(block)) {
        return {
          ok: false,
          reason: 'hazard',
          position: at,
          block,
          message: `头顶遇到${isLavaBlock(block) ? '岩浆' : '水'}`,
        };
      }
      const dug = await digAt(ctx, at);
      checkInterrupted(ctx);
      if (!dug.ok) {
        return { ok: false, reason: dug.reason, position: at, message: `头顶挖不开：${dug.message}` };
      }
      state.mined += 1;
    }
  }
  if (!isPassableBlock(frontBlock)) {
    const dug = await digAt(ctx, front);
    checkInterrupted(ctx);
    if (!dug.ok) {
      return { ok: false, reason: dug.reason, position: front, message: dug.message };
    }
    state.mined += 1;
  }
  // 等方块更新同步到客户端再寻路。
  await ctx.sleep(250);
  checkInterrupted(ctx);
  if (options.torch) {
    await placeTorch(ctx, front, state, options.notes || []);
  }
  // 安全走廊：头顶 2 格与前方 1 格都得是空气才能走进去。
  if (!isSafeCorridor(bot, position, heading)) {
    await ctx.sleep(300);
    if (!isSafeCorridor(bot, position, heading)) {
      return { ok: false, reason: 'unsafe', position: front, message: '挖开之后走廊还是不通' };
    }
  }
  const walk = await stepForward(ctx, front);
  if (walk !== 'reached') {
    return { ok: false, reason: walk, position: front, message: '挖开了但走不过去' };
  }
  if (options.countSteps !== false) state.steps += 1;
  return { ok: true, position: front };
}

// 火把：先盘点背包，没有就用 ctx 的合成能力补。
// 没有合成能力时只在 notes 里说明缺什么，不影响挖矿。
async function ensureTorches(ctx, wanted, notes) {
  checkInterrupted(ctx);
  const have = ctx.countItem('torch');
  if (have >= wanted) return { ok: true, have };
  const need = Math.max(1, wanted - have);
  if (typeof ctx.craftItem !== 'function') {
    notes.push(`背包里只有 ${have} 个火把，桥接没有提供合成能力（craftItem），缺 ${need} 个火把`);
    return { ok: false, have };
  }
  try {
    await ctx.craftItem({ item: 'torch', count: need });
  } catch (error) {
    checkInterrupted(ctx);
    notes.push(`火把没合成出来（${error.message}），背包里只有 ${have} 个`);
    return { ok: false, have };
  }
  checkInterrupted(ctx);
  const after = ctx.countItem('torch');
  if (after <= have) {
    notes.push(`火把没合成出来，背包里只有 ${after} 个`);
    return { ok: false, have: after };
  }
  return { ok: true, have: after };
}

// 放火把：放在刚挖开的那一格的地面上，bot 还站在上一格，不会被自己挡住。
async function placeTorch(ctx, cell, state, notes) {
  checkInterrupted(ctx);
  if (ctx.countItem('torch') <= 0) {
    notes.push('火把用完了，巷道后半段没有放火把');
    return false;
  }
  const bot = ctx.bot;
  const spot = offsetPos(cell, 0, 0, 0);
  const floor = blockAtPos(bot, offsetPos(spot, 0, -1, 0));
  if (!floor || floor.boundingBox !== 'block') {
    notes.push('脚下没有能放火把的地面');
    return false;
  }
  const existing = blockAtPos(bot, spot);
  if (existing && existing.name !== 'air') return false;
  try {
    if (typeof ctx.placeBlock === 'function') {
      await ctx.placeBlock({ block: 'torch', x: spot.x, y: spot.y, z: spot.z });
    } else if (typeof ctx.placeInventoryBlock === 'function') {
      await ctx.placeInventoryBlock('torch', '火把');
    } else {
      notes.push('桥接没有提供放置方块的能力，巷道里没放成火把');
      return false;
    }
  } catch (error) {
    checkInterrupted(ctx);
    notes.push(`火把没放下去：${error.message}`);
    return false;
  }
  checkInterrupted(ctx);
  const placed = blockAtPos(bot, spot);
  if (placed && (placed.name === 'torch' || placed.name === 'redstone_torch' || placed.name === 'soul_torch')) {
    state.torches += 1;
    return true;
  }
  notes.push('火把没出现在那一格');
  return false;
}

// 沿有支撑的阶梯下降；不跨空腔、流体或未加载区块。
async function digShaftDown(ctx, depth, state, lowHealth = LOW_HEALTH, targetY = null, returnable = false) {
  const bot = ctx.bot;
  let preferred = directionFromYaw(bot.entity.yaw) || CARDINAL_HEADINGS[0];
  const triedStairs = new Set();
  for (let step = 0; step < depth; step += 1) {
    requireConnected(ctx);
    checkHealth(ctx, lowHealth);
    checkNearbyHostiles(ctx);
    const feet = floorPos(bot.entity.position);
    const headings = [preferred, ...CARDINAL_HEADINGS.filter((item) => item !== preferred)];
    let descended = false;
    const failures = [];
    const candidateEvidence = [];
    for (const heading of headings) {
      const footPosition = offsetPos(feet, heading.x, -1, heading.z);
      const headPosition = offsetPos(feet, heading.x, 0, heading.z);
      const floorPosition = offsetPos(feet, heading.x, -2, heading.z);
      const foot = blockAtPos(bot, footPosition);
      const head = blockAtPos(bot, headPosition);
      const floor = blockAtPos(bot, floorPosition);
      const candidate = {
        direction: heading.name,
        ground_position: { x: floorPosition.x, y: floorPosition.y, z: floorPosition.z },
        loaded: Boolean(foot && head && floor),
        name: floor?.name || null,
        bounding_box: floor?.boundingBox ?? null,
      };
      if (!foot || !head || !floor) {
        failures.push(`${formatPosition(footPosition)} 区块未加载`);
        candidate.reason = 'unknown_terrain';
        candidateEvidence.push(candidate);
        continue;
      }
      const hazard = [
        [foot, footPosition],
        [head, headPosition],
        [floor, floorPosition],
      ].find(([block]) => isHazardBlock(block));
      if (hazard) {
        failures.push(`${formatPosition(hazard[1])} 有${isLavaBlock(hazard[0]) ? '岩浆' : '水'}`);
        candidate.reason = 'hazard';
        candidateEvidence.push(candidate);
        continue;
      }
      if (isPassableBlock(floor)) {
        failures.push(`${formatPosition(floorPosition)} 没有实心支撑`);
        candidate.reason = 'unsupported';
        candidateEvidence.push(candidate);
        continue;
      }
      const opening = [headPosition, footPosition];
      if (returnable) {
        const clearance = offsetPos(headPosition, 0, 1, 0);
        if (dryMiningFooting(bot, toVec3(bot, clearance))) {
          candidate.reason = 'up_stair_support';
          candidateEvidence.push(candidate);
          continue;
        }
        opening.unshift(clearance);
      }
      if (opening.some(p => {
        const block = blockAtPos(bot, p);
        return !block || waterLike(block) || isHazardBlock(block) || (!isPassableBlock(block) && !safeStairOpening(bot, p));
      })) {
        failures.push(`${formatPosition(footPosition)} 开口可能引入流体或落沙`);
        candidate.reason = 'unstable_opening';
        candidateEvidence.push(candidate);
        continue;
      }

      for (const position of opening) {
        const block = blockAtPos(bot, position);
        if (isPassableBlock(block)) continue;
        const dug = await digAt(ctx, position);
        checkInterrupted(ctx);
        if (!dug.ok) {
          failures.push(`${formatPosition(position)} ${dug.message}`);
          break;
        }
        state.mined += 1;
      }
      const clearFoot = blockAtPos(bot, footPosition);
      const clearHead = blockAtPos(bot, headPosition);
      if (returnable && !isPassableBlock(blockAtPos(bot, opening[0]))) {
        candidate.reason = 'return_headroom';
        candidateEvidence.push(candidate);
        continue;
      }
      if (!isPassableBlock(clearFoot) || !isPassableBlock(clearHead)) {
        candidate.reason = candidate.reason || 'corridor_not_clear';
        candidateEvidence.push(candidate);
        continue;
      }

      const walk = await stepForward(ctx, footPosition, returnable);
      checkInterrupted(ctx);
      if (walk !== 'reached') {
        failures.push(`${formatPosition(footPosition)} 无法安全走到阶梯落点`);
        candidate.reason = 'unreachable';
        candidateEvidence.push(candidate);
        continue;
      }
      requireConnected(ctx);
      const landed = floorPos(bot.entity.position);
      const landedFoot = blockAtPos(bot, landed);
      const landedHead = blockAtPos(bot, offsetPos(landed, 0, 1, 0));
      const support = blockAtPos(bot, offsetPos(landed, 0, -1, 0));
      if (
        landed.y !== feet.y - 1 ||
        !landedFoot ||
        !landedHead ||
        !support ||
        !isPassableBlock(landedFoot) ||
        !isPassableBlock(landedHead) ||
        isHazardBlock(landedFoot) ||
        isHazardBlock(landedHead) ||
        isPassableBlock(support) ||
        isHazardBlock(support)
      ) {
        throw new Error(`挖阶梯后落点未确认安全（原 ${formatPosition(feet)}，现 ${formatPosition(landed)}），已停止`);
      }
      descended = true;
      break;
    }
    if (!descended) {
      if (['the_nether', 'minecraft:the_nether'].includes(bot.game?.dimension) && triedStairs.size < 3
          && candidateEvidence.length === 4 && candidateEvidence.every(e => e.reason === 'unsupported')) {
        const {here, points, parents} = await reachableNetherGround(ctx, 200, 16);
        triedStairs.add(here.toString());
        let approach;
        for (const p of points) {
          if (p.y !== here.y || triedStairs.has(p.toString())) continue;
          const heading = CARDINAL_HEADINGS.find(h => [1, 2, 3].every(d => {
            const next = p.offset(h.x * d, -d, h.z * d);
            const ground = bot.blockAt(next.offset(0, -1, 0));
            return ground?.boundingBox === 'block' && !isHazardBlock(ground)
              && !netherRouteExclusion(bot, {position: next}) && !besideDrop(bot, next)
              && safeStairOpening(bot, next) && safeStairOpening(bot, next.offset(0, 1, 0));
          }));
          if (heading) { approach = {p, heading}; break; }
        }
        if (approach && triedStairs.size < 3) {
          triedStairs.add(approach.p.toString());
          if (await followNetherPath(ctx, parents, approach.p) === 'reached') {
            preferred = approach.heading;
            step--;
            continue;
          }
          checkInterrupted(ctx);
        }
      }
      const error = new Error(
        `没有安全的阶梯落点，已停止下探（当前 ${formatPosition(feet)}${failures.length ? `；${failures.join('；')}` : ''}）`,
      );
      error.data = {
        phase: 'safe_stop',
        reason: 'no_safe_stair',
        position: { x: feet.x, y: feet.y, z: feet.z },
        target_y: targetY === null || targetY === undefined || !Number.isFinite(Number(targetY))
          ? null
          : Math.floor(Number(targetY)),
        candidates: candidateEvidence,
      };
      throw error;
    }
  }
}

// 挖一条支巷，然后原路走回主巷。
async function digBranch(ctx, junction, heading, length, state, lowHealth = LOW_HEALTH) {
  const side = pickPerpendicular(ctx, junction, heading);
  if (!side) return { ok: false, moved: false };
  let position = junction;
  let moved = false;
  for (let step = 1; step <= length; step += 1) {
    requireConnected(ctx);
    checkHealth(ctx, lowHealth);
    const minedBefore = state.mined;
    const result = await digForward(ctx, position, side, state, { countSteps: false });
    checkInterrupted(ctx);
    if (!result.ok) return { ok: false, moved: moved || state.mined > minedBefore };
    position = result.position;
    moved = true;
  }
  state.branches += 1;
  // 原路退回主巷。
  for (let step = 0; step < length; step += 1) {
    checkHealth(ctx, lowHealth);
    const back = offsetPos(position, -side.x, 0, -side.z);
    const walk = await stepForward(ctx, back);
    if (walk !== 'reached') return { ok: false, moved: true };
    position = back;
  }
  return { ok: true, moved: false };
}

// 选一个与 heading 垂直、且前方不是岩浆水的地方。
function pickPerpendicular(ctx, position, heading) {
  const bot = ctx.bot;
  const options = [
    { x: -heading.z, z: heading.x, name: `${heading.name}-left` },
    { x: heading.z, z: -heading.x, name: `${heading.name}-right` },
  ];
  for (const option of options) {
    const front = blockAtPos(bot, offsetPos(position, option.x, 0, option.z));
    if (isHazardBlock(front)) continue;
    return option;
  }
  return null;
}

// 顺路找矿，记录坐标。
function scanOre(ctx, name, radius = 8) {
  const bot = ctx.bot;
  const registry = registryOf(ctx);
  const entry = registry?.blocksByName?.[name];
  if (!entry) return [];
  try {
    return bot.findBlocks({ matching: entry.id, maxDistance: radius, count: 8 });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 技能：mine_collect
// ---------------------------------------------------------------------------

// 挖指定方块：换工具 → 挖 → 等掉落物 → 走过去真的捡起来 → 核对背包数量。
// 三类失败都会说清楚：挖完没掉、掉落物掉进岩浆或水里、距离太远。
function surfaceFooting(bot, column) {
  for (const dy of SURFACE_HEIGHT_OFFSETS) {
    const feet = column.offset(0, dy, 0);
    if (dryMiningFooting(bot, feet) && surfaceSkyLight(bot, feet) > 0) return feet;
  }
  return null;
}

// 为远处的树找连通的干地。每六格取一个落脚点，并检查中间列，实际走步仍由寻路器验收。
export async function surfaceWoodRoute(ctx, trunks) {
  const bot = ctx.bot;
  const start = bot.entity.position.floored();
  if (!trunks.length || trunks.some(p => start.distanceTo(p) <= 24)) return null;
  const queue = [{point: start, parent: null}];
  const visited = new Set([`${start.x},${start.z}`]);
  for (let i = 0; i < queue.length && i < 1800; i++) {
    if (i % 16 === 0) {
      await yieldToGame();
      checkInterrupted(ctx);
    }
    const node = queue[i];
    const target = trunks.find(p => node.point.distanceTo(p) <= 7);
    if (target) {
      const path = [];
      for (let n = node; n.parent; n = n.parent) path.push(n.point);
      return { target, path: path.reverse() };
    }
    for (const {x, z} of CARDINAL_HEADINGS) {
      const end = node.point.offset(x * 6, 0, z * 6);
      const key = `${end.x},${end.z}`;
      if (visited.has(key) || Math.hypot(end.x - start.x, end.z - start.z) > 140) continue;
      const middle = surfaceFooting(bot, node.point.offset(x * 3, 0, z * 3));
      if (!middle || Math.abs(middle.y - node.point.y) > 3) continue;
      const next = surfaceFooting(bot, middle.offset(x * 3, 0, z * 3));
      if (!next || Math.abs(next.y - middle.y) > 3) continue;
      visited.add(key);
      queue.push({ point: next, parent: node });
    }
  }
  return null;
}

async function selectSurfaceTrunk(ctx, positions, paths) {
  const bot = ctx.bot;
  const base = bot.entity.position.floored();
  const trunks = new Map();
  const samples = new Map();
  for (const p of positions) {
    const key = `${p.x},${p.z}`;
    if (!trunks.has(key) || trunks.get(key).y > p.y) trunks.set(key, p);
  }
  const route = await surfaceWoodRoute(ctx, [...trunks.values()]);
  if (route) {
    paths.set(route.target, route.path);
    return route.target;
  }
  let best;
  let bestCost = Infinity;
  for (const trunk of trunks.values()) {
    await yieldToGame();
    checkInterrupted(ctx);
    const dx = trunk.x - base.x, dz = trunk.z - base.z;
    const distance = Math.hypot(dx, dz);
    let cost = base.distanceTo(trunk);
    // 每十二格采样一次已加载地形。同一批候选共用采样，优先选择干路较连续的树。
    for (let step = 12; step < distance && cost < bestCost; step += 12) {
      const ratio = step / distance;
      const column = base.offset(Math.round(dx * ratio), Math.round((trunk.y - base.y) * ratio), Math.round(dz * ratio));
      const key = `${column.x},${column.y},${column.z}`;
      if (!samples.has(key)) samples.set(key, Boolean(surfaceFooting(bot, column)));
      if (!samples.get(key)) cost += 24;
    }
    if (cost < bestCost) {
      best = trunk;
      bestCost = cost;
    }
  }
  return best;
}

function woodReach(bot, position) {
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
  return eye.distanceTo(position.offset(0.5, 0.5, 0.5));
}

function reachableWood(bot, position) {
  const block = bot.blockAt(position);
  return block && woodReach(bot, position) <= MINE_REACH && (!bot.canSeeBlock || bot.canSeeBlock(block));
}

async function walkToSurfaceLog(target, ctx) {
  const { bot } = ctx;
  const horizontal = p => Math.hypot(target.x - p.x, target.z - p.z);
  // 长距离整段寻路经常在规划中超时。沿朝向分段找日照干地，每段核对实际位移。
  for (let segment = 0; segment < 10 && horizontal(bot.entity.position) > 24; segment++) {
    const origin = bot.entity.position.clone();
    const distance = horizontal(origin);
    const heading = Math.atan2(target.z - origin.z, target.x - origin.x);
    let advanced = false;
    for (const angle of [heading, heading + Math.PI / 5, heading - Math.PI / 5]) {
      checkInterrupted(ctx);
      checkHealth(ctx);
      checkNearbyHostiles(ctx);
      const column = origin.floored().offset(Math.round(16 * Math.cos(angle)), 0, Math.round(16 * Math.sin(angle)));
      const waypoint = surfaceFooting(bot, column);
      if (!waypoint) continue;
      const outcome = await ctx.walkOnce(waypoint.x, waypoint.y, waypoint.z, 2, 12000);
      if (outcome === 'cancelled' || outcome === 'stopped') return outcome;
      if (horizontal(bot.entity.position) <= distance - 4) {
        advanced = true;
        break;
      }
    }
    if (!advanced) {
      const ground = await reachableDryGround(ctx, 1800, 28);
      let closest, remaining = horizontal(bot.entity.position) - 4;
      for (const point of ground.points) {
        const d = horizontal(point);
        if (d < remaining && surfaceSkyLight(bot, point) > 0) {
          closest = point;
          remaining = d;
        }
      }
      if (!closest) break;
      const outcome = await followDryGround(ctx, ground.parents, closest, () => {
        checkInterrupted(ctx);
        checkHealth(ctx);
        checkNearbyHostiles(ctx);
      });
      if (outcome === 'cancelled' || outcome === 'stopped') return outcome;
      if (horizontal(bot.entity.position) > distance - 4) break;
    }
  }
  checkInterrupted(ctx);
  checkHealth(ctx);
  checkNearbyHostiles(ctx);
  if (reachableWood(bot, target)) return 'reached';
  const outcome = await ctx.travelToBlock(target, 30000);
  if (outcome === 'unreachable' && reachableWood(bot, target)) return 'reached';
  return outcome;
}

async function approachSurfaceLog(target, ctx, path) {
  ctx.reportProgress?.('searching', '前往地表原木', 0, { surface_trunk: { x: target.x, y: target.y, z: target.z } });
  return withDryMiningMovement(ctx, async () => {
    for (const point of path || []) {
      checkInterrupted(ctx);
      checkHealth(ctx);
      checkNearbyHostiles(ctx);
      const outcome = await ctx.walkOnce(point.x, point.y, point.z, 1, 12000);
      if (outcome === 'cancelled' || outcome === 'stopped') return outcome;
      if (outcome !== 'reached') break;
    }
    return walkToSurfaceLog(target, ctx);
  }, { surfaceOnly: true });
}

// 近处矿脉从可见的岩面逐格开短通道。仅清普通岩石，保留脚下支撑和挡水顶板。
async function approachNearbyOre(ctx, target) {
  const bot = ctx.bot;
  const ordinary = new Set(['stone', 'deepslate', 'diorite', 'granite', 'andesite', 'tuff', 'dirt', 'cobblestone', 'cobbled_deepslate']);
  const safe = p => {
    const block = bot.blockAt(p);
    return block && !waterLike(block) && !isHazardBlock(block) &&
      (isPassableBlock(block) || ordinary.has(block.name) && safeStairOpening(bot, p));
  };
  const center = target.offset(0.5, 0.5, 0.5);
  for (let step = 0; step < 18; step++) {
    checkInterrupted(ctx);
    checkHealth(ctx);
    checkNearbyHostiles(ctx);
    const actual = bot.entity.position, feet = actual.floored();
    const eye = actual.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
    const ray = center.minus(eye), length = ray.norm();
    if (length <= MINE_REACH) {
      const face = bot.world.raycast(eye, ray.scaled(1 / length), length + 0.1);
      if (face?.position.equals(target)) return 'reached';
      if (face && !face.position.equals(feet.offset(0, -1, 0)) && ordinary.has(face.name) && safe(face.position)) {
        if (!(await digAt(ctx, face.position)).ok) return 'unreachable';
        continue;
      }
    }
    const options = [];
    for (const heading of CARDINAL_HEADINGS) {
      for (const rise of [0, 1, -1]) {
        const next = feet.offset(heading.x, rise, heading.z);
        const distance = next.offset(0.5, 1.5, 0.5).distanceTo(center);
        if (distance >= feet.offset(0.5, 1.5, 0.5).distanceTo(center)) continue;
        const floor = bot.blockAt(next.offset(0, -1, 0));
        if (floor?.boundingBox !== 'block' || waterLike(floor) || /magma|campfire|cactus/.test(floor.name)) continue;
        const cells = [next.offset(0, 1, 0), next];
        if (rise > 0) cells.unshift(feet.offset(0, 2, 0));
        if (rise < 0) cells.unshift(next.offset(0, 2, 0));
        if (cells.every(safe)) options.push({next, cells, distance});
      }
    }
    const route = options.sort((a, b) => a.distance - b.distance)[0];
    if (!route) return 'unreachable';
    for (const p of route.cells) {
      if (!safe(p)) return 'unreachable';
      if (!isPassableBlock(bot.blockAt(p)) && !(await digAt(ctx, p)).ok) return 'unreachable';
    }
    if (!dryMiningFooting(bot, route.next) || await stepForward(ctx, route.next) !== 'reached'
      || !bot.entity.position.floored().equals(route.next)) return 'unreachable';
  }
  return 'unreachable';
}

async function withDryMiningMovement(ctx, action, { surfaceOnly = false } = {}) {
  const movements = ctx.bot.pathfinder?.movements;
  if (!movements) return action();
  const previous = {
    canDig: movements.canDig,
    exclusionAreasStep: movements.exclusionAreasStep,
    allow1by1towers: movements.allow1by1towers,
    allowParkour: movements.allowParkour,
    maxDropDown: movements.maxDropDown,
    infiniteLiquidDropdownDistance: movements.infiniteLiquidDropdownDistance,
  };
  const pathfinder = ctx.bot.pathfinder;
  const tickTimeout = pathfinder.tickTimeout;
  if (Number.isFinite(tickTimeout)) pathfinder.tickTimeout = Math.min(tickTimeout, 10);
  movements.allow1by1towers = false;
  movements.allowParkour = false;
  movements.maxDropDown = Math.min(previous.maxDropDown ?? 2, 2);
  movements.infiniteLiquidDropdownDistance = false;
  if (surfaceOnly) movements.canDig = false;
  movements.exclusionAreasStep = [...(previous.exclusionAreasStep || []), block => miningRouteExclusion(ctx.bot, block)];
  try {
    return await action();
  } finally {
    pathfinder.tickTimeout = tickTimeout;
    Object.assign(movements, previous);
  }
}

async function mineCollect(args, ctx, knownBlocksOnly = false) {
  const bot = ctx.bot;
  requireConnected(ctx);
  const registry = registryOf(ctx);
  const blockName = String(args.block || 'stone').trim();
  const requested = Number(args.count ?? 1);
  if (!Number.isInteger(requested) || requested < 1 || requested > 2304) throw new Error('count 必须是 1-2304 的整数');
  const want = requested;
  const minimum = args.minimum_count == null ? want : Number(args.minimum_count);
  if (!Number.isInteger(minimum) || minimum < 1 || minimum > want) throw new Error('minimum_count 必须是 1 到 count 的整数');
  const avoided = Array.isArray(args.avoid_positions) ? args.avoid_positions : [];
  if (avoided.some(p => !p || !['x', 'y', 'z'].every(axis => Number.isFinite(p[axis])))) throw new Error('avoid_positions 必须是有效坐标列表');
  const localVein = args.local_vein === true;
  if (localVein && !/(?:coal|iron|diamond)_ore$/.test(blockName)) throw new Error('近矿短通道只支持煤、铁和钻石矿');
  const range = localVein ? clampInt(args.range, 12, 8, 16) : clampInt(args.range, 32, 8, blockName === 'wood_log' ? 128 : 64);
  const oreBase = blockName.replace(/^deepslate_/, '');
  const family = blockName === 'wood_log' ? OVERWORLD_LOGS
    : ['iron_ore', 'coal_ore', 'diamond_ore'].includes(oreBase) ? [oreBase, `deepslate_${oreBase}`]
    : [blockName];
  const targetBlockNames = family.filter(name => registry?.blocksByName?.[name]);
  const targetEntries = targetBlockNames
    .map((name) => registry?.blocksByName?.[name])
    .filter(Boolean);
  if (targetEntries.length === 0) throw new Error(`未知方块 ${blockName}`);
  const entry = targetEntries[0];
  const blockLabel = isDiamondOre(blockName) ? '钻石矿' : blockLabelOf(ctx, blockName);
  // 挖石头拿到的是圆石，挖钻石矿拿到的是钻石，数量按掉落物算。
  const itemName = dropItemName(registry, entry, blockName);
  const itemNames = [...new Set(targetEntries.map(candidate => dropItemName(registry, candidate, candidate.name || blockName)))];
  const countOwned = () => itemNames.reduce((total, name) => total + ctx.countItem(name), 0);
  const label = itemLabelOf(ctx, itemName, blockLabel);
  const owned = countOwned();
  const need = want - owned;
  if (need <= 0) {
    return { detail: `背包里已经有 ${owned} 个${label}，不需要再挖`, status: 'succeeded' };
  }
  const matching = targetEntries.map((candidate) => candidate.id);
  const acceptedBlockNames = new Set(targetBlockNames);
  let mined = 0;
  let tried = 0;
  let lastMinedPosition = null;
  const failures = [];
  const ids = matching.length === 1 ? matching[0] : matching;
  // 满足硬需求后只取手边的储备，把远程寻路的时间留给下一步。
  const reserveOnly = () => minimum < want && countOwned() >= minimum;
  const withinReach = () => args.within_reach === true || reserveOnly();
  const surfaceWood = blockName === 'wood_log' && args.surface_wood === true;
  const startY = bot.entity.position.y;
  const failedTrunks = new Set();
  const surfacePaths = new WeakMap();
  // 只在地表补木时筛选；在区块扫描阶段就排除深处构件，避免它们占满最近候选。
  const surfaceLog = (position) => position.y >= startY - 16 && position.y <= startY + 32 &&
    !failedTrunks.has(`${position.x},${position.z}`) &&
    CARDINAL_HEADINGS.some(({ x, z }) =>
      surfaceSkyLight(bot, position.offset(x, 0, z)) > 0);
  const scan = async (excludedCount) => {
    const nearby = withinReach();
    const count = avoided.length ? 512 : Math.max(need * 4, surfaceWood && !nearby ? 128 : 8) + excludedCount;
    const matches = surfaceWood && !nearby && bot.world?.getColumn
      ? await scanSurfaceLogs(bot, targetEntries, range, count, startY, surfaceLog, () => checkInterrupted(ctx))
      : bot.findBlocks({ matching: ids, maxDistance: nearby ? Math.ceil(MINE_REACH) : range, count,
        ...(surfaceWood ? { useExtraInfo: block => surfaceLog(block.position) } : {}) });
    const positions = matches
      .filter(p => !nearby || (surfaceWood ? woodReach(bot, p) : distanceBetween(bot.entity.position, p)) <= MINE_REACH)
      .filter(p => !avoided.some(danger => Math.hypot(p.x - danger.x, p.z - danger.z) < 8));
    if (blockName.endsWith('_log') || blockName.endsWith('_stem')) {
      const origin = bot.entity.position;
      positions.sort((a, b) => Math.hypot(a.x - origin.x, a.z - origin.z) - Math.hypot(b.x - origin.x, b.z - origin.z) || a.y - b.y);
    }
    return positions;
  };
  const chooseCandidate = (positions) => {
    if (surfaceWood) {
      const visible = positions.find(p => reachableWood(bot, p));
      if (visible) return visible;
    }
    if (surfaceWood && !lastMinedPosition) return selectSurfaceTrunk(ctx, positions, surfacePaths);
    const origin = lastMinedPosition || bot.entity.position;
    return positions.sort((a, b) => {
      const aAdjacent = lastMinedPosition && Math.abs(a.x - lastMinedPosition.x) + Math.abs(a.y - lastMinedPosition.y) + Math.abs(a.z - lastMinedPosition.z) === 1;
      const bAdjacent = lastMinedPosition && Math.abs(b.x - lastMinedPosition.x) + Math.abs(b.y - lastMinedPosition.y) + Math.abs(b.z - lastMinedPosition.z) === 1;
      if (aAdjacent !== bAdjacent) return aAdjacent ? -1 : 1;
      return distanceBetween(origin, a) - distanceBetween(origin, b);
    })[0];
  };
  // 地表补木由阶段规划扩大搜索半径并核对换区。空扫描时保留原点，让下一轮复用已加载地形。
  for await (const position of resourceCandidates(ctx, ids, range, Math.max(need * 4, 8), scan, chooseCandidate, () => localVein || knownBlocksOnly || surfaceWood || withinReach())) {
    if (countOwned() - owned >= need) break;
    requireConnected(ctx);
    checkHealth(ctx);
    checkNearbyHostiles(ctx);
    tried += 1;
    const block = blockAtPos(bot, position);
    if (!block || !acceptedBlockNames.has(block.name)) {
      failures.push(`${formatPosition(position)} 的${blockLabel}已经不见了`);
      continue;
    }
    if (blockName === 'obsidian' && knownBlocksOnly && bot.pathfinder?.movements) {
      const base = blockAtPos(bot, position.offset(0, -1, 0));
      const feet = bot.entity.position.floored();
      if (!base || base.boundingBox !== 'block' || isHazardBlock(base) ||
          (feet.x === position.x && feet.z === position.z && feet.y === position.y + 1) ||
          CARDINAL_HEADINGS.some(({ x, z }) => blockAtPos(bot, position.offset(x, 0, z))?.name === 'lava')) {
        failures.push(`${formatPosition(position)} 挖开后缺少安全落脚点或会引入岩浆`);
        continue;
      }
      try {
        await moveNearBlock(ctx, position, '开采黑曜石', true);
      } catch (error) {
        requireConnected(ctx);
        checkInterrupted(ctx);
        failures.push(error.message);
        continue;
      }
    }
    const distance = surfaceWood ? woodReach(bot, position) : distanceBetween(bot.entity.position, position);
    const shortMine = (localVein || /(?:iron|diamond)_ore$/.test(block.name)) && distance <= 16 && !withinReach()
      && bot.world?.raycast && typeof ctx.walkOnce === 'function' && dryMiningFooting(bot, bot.entity.position);
    if (localVein && !shortMine && !withinReach()) continue;
    if (shortMine || distance > MINE_REACH) {
      if (withinReach()) continue;
      let outcome;
      if (shortMine) {
        outcome = await withDryMiningMovement(ctx, () => approachNearbyOre(ctx, position), {surfaceOnly: true});
      } else if (surfaceWood) {
        outcome = await approachSurfaceLog(position, ctx, surfacePaths.get(position));
      } else {
        outcome = await ctx.travelToBlock(position, 30000);
      }
      checkInterrupted(ctx);
      if (outcome === 'cancelled' || outcome === 'stopped') throw new Error('采集被取消：收到新的指令或连接断开');
      if (outcome === 'low_health') throw new Error(`血量不足，撤退中止采集（血量 ${bot.health}）`);
      if (outcome !== 'reached') {
        if (surfaceWood) failedTrunks.add(`${position.x},${position.z}`);
        failures.push(`${formatPosition(position)} 距离 ${distance.toFixed(1)} 格，太远走不过去`);
        continue;
      }
    }
    checkHealth(ctx);
    checkNearbyHostiles(ctx);
    const feet = floorPos(bot.entity.position);
    if ((localVein || /(?:iron|diamond)_ore$/.test(block.name)) && !safeStairOpening(bot, position)) {
      failures.push(`${formatPosition(position)} 邻接流体、未知空间或不稳定顶板，保留矿壁`);
      continue;
    }
    if (feet.x === position.x && feet.z === position.z && feet.y - 1 === position.y) {
      const below = blockAtPos(bot, offsetPos(position, 0, -1, 0));
      if (!below || below.boundingBox !== 'block' || isHazardBlock(below)) {
        failures.push(`${formatPosition(position)} 是脚下支撑，下面没有安全落脚点`);
        continue;
      }
    }
    const dug = await digAt(ctx, position, { expectName: block.name });
    checkInterrupted(ctx);
    if (!dug.ok) {
      failures.push(`${formatPosition(position)} ${dug.message}`);
      if (dug.reason === 'tool' && isDiamondOre(block.name)) break;
      continue;
    }
    mined += 1;
    lastMinedPosition = { x: position.x, y: position.y, z: position.z };
    const dropped = await collectDrop(ctx, dropItemName(registry, registry.blocksByName[block.name], block.name));
    checkInterrupted(ctx);
    const collected = countOwned() - owned;
    ctx.reportProgress?.('running', `已采集 ${collected}/${need} ${label}`, Math.min(1, collected / need), {
      item: itemName, collected, target: need,
    });
    if (collected >= need) break;
    if (dropped.gained > 0) continue;
    const state = dropFailureState(ctx, position);
    failures.push(`${formatPosition(position)} ${classifyDropOutcome(state)}`);
  }
  if (tried === 0 && !reserveOnly()) throw new Error(`附近 ${withinReach() ? MINE_REACH : range} 格内没有${blockLabel}，一个都没有找到`);
  const gained = countOwned() - owned;
  if (gained <= 0 && !reserveOnly()) {
    throw new Error(
      `试了 ${tried} 个目标，没有拿到${label}${failures.length ? `：${failures.join('；')}` : ''}`,
    );
  }
  if (gained < need) {
    if (countOwned() >= minimum) {
      return {
        detail: `已采到最低需求 ${minimum} 个${label}，背包共 ${countOwned()} 个；储备目标 ${want} 未采满，继续后续任务`,
        status: 'succeeded',
        data: { minimum_met: true, reserve_met: false, inventory_count: countOwned(), reserve_target: want },
      };
    }
    throw new Error(
      `${summarizeShortage(gained, need, label)}（挖了 ${mined} 个，失败 ${failures.length} 次：${failures.join('；')}）`,
    );
  }
  return {
    detail: `挖了 ${mined} 个${blockLabel}，获得 ${gained} 个${label}，背包共 ${countOwned()} 个`,
    status: 'succeeded',
  };
}

// ---------------------------------------------------------------------------
// 技能：strip_mine
// ---------------------------------------------------------------------------

// 挖一条主巷道加若干分支。头顶 2 格与前方 1 格必须通得过，
// 沿途放火把，遇到岩浆或水立刻停下并上报坐标。
function safeStairOpening(bot, position) {
  const above = offsetPos(position, 0, 1, 0);
  const upper = blockAtPos(bot, above);
  if (!upper || /(?:sand|gravel|anvil|concrete_powder)$/.test(upper.name)) return false;
  const adjacent = CARDINAL_HEADINGS.map(h => offsetPos(position, h.x, 0, h.z));
  return [position, above, ...adjacent].every(at => {
    const block = blockAtPos(bot, at);
    return block && !isHazardBlock(block) && !waterLike(block);
  });
}

export async function leaveCoveredMiningSite(ctx, threat, origin, minimum, attempted, walkOnly = false) {
  const bot = ctx.bot;
  const danger = threat.position.clone();
  const initialHealth = bot.health;
  const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  if (walkOnly && String(bot.game?.dimension).replace(/^minecraft:/, '') === 'overworld' && bot.setControlState && bot.look) {
    const {points, parents} = await reachableDryGround(ctx, 400, minimum + 8);
    const separation = origin.distanceTo(danger);
    const exits = points.filter(p => distance(origin, p.offset(0.5, 0, 0.5)) >= minimum + 0.5
      && p.distanceTo(danger) > Math.max(11, separation));
    exits.sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin));
    for (const exit of exits) {
      const path = [];
      for (let p = exit; parents.has(p.toString()); p = parents.get(p.toString())) path.push(p);
      if (path.length > minimum * 3 || path.some(p => p.offset(0.5, 0, 0.5).distanceTo(danger) < separation - 0.5)) continue;
      attempted.push({x: exit.x, y: exit.y, z: exit.z});
      for (const next of path.reverse()) {
        checkInterrupted(ctx);
        if (bot.health < initialHealth || bot.health <= 10) throw new Error('沿旧矿道撤离时受伤，转入生存恢复');
        const nearest = ctx.findHostile(10)?.position;
        if (nearest && next.offset(0.5, 0, 0.5).distanceTo(nearest) < Math.max(4, bot.entity.position.distanceTo(nearest) - 0.5)) break;
        if (await walkDryCell(ctx, next, 'overworld') !== 'reached') break;
      }
      break;
    }
  }
  if (walkOnly) {
    if (distance(bot.entity.position, origin) >= minimum && !ctx.nearbyHostiles(10).length) return;
    throw new Error('已观察的干燥矿道未能通到足够远的安全位置');
  }
  for (let i = 0; i < minimum + 8; i++) {
    checkInterrupted(ctx);
    const actual = bot.entity.position;
    if (distance(actual, origin) >= minimum && !ctx.nearbyHostiles(10).length) return;
    const currentThreat = ctx.findHostile(10);
    const source = currentThreat?.position || danger;
    const feet = actual.floored();
    const candidates = CARDINAL_HEADINGS.map(h => feet.offset(h.x, 0, h.z))
      .filter(p => distance(p, source) > distance(feet, source) && distance(p, origin.floored()) > distance(feet, origin.floored()))
      .sort((a, b) => distance(b, source) - distance(a, source));
    let moved = false;
    for (const next of candidates) {
      const floor = bot.blockAt(next.offset(0, -1, 0));
      const cells = [next.offset(0, 1, 0), next];
      if (floor?.boundingBox !== 'block' || waterLike(floor) || isHazardBlock(floor) || !cells.every(p => safeStairOpening(bot, p))) continue;
      attempted.push({x: next.x, y: next.y, z: next.z});
      for (const p of cells) {
        checkInterrupted(ctx);
        if (bot.health < initialHealth || bot.health <= 10) throw new Error('开撤离通道时受伤，转入生存恢复');
        if (!safeStairOpening(bot, p)) break;
        if (!isPassableBlock(bot.blockAt(p)) && !(await digAt(ctx, p, {clearByHand: true})).ok) break;
      }
      if (!dryMiningFooting(bot, next)) continue;
      if (await stepForward(ctx, next) !== 'reached' || !bot.entity.position.floored().equals(next)) continue;
      moved = true;
      break;
    }
    if (!moved) throw new Error('远离敌怪的方向缺少可安全开挖的通道');
  }
}

async function climbMiningStairs(ctx, count, preferred, fillGaps, clearByHand) {
  const bot = ctx.bot;
  const headings = [preferred, ...CARDINAL_HEADINGS.filter(h => h.name !== preferred.name)];
  const visited = new Set();
  let climbed = 0;
  let lateral = 0;
  while (climbed < count) {
    requireConnected(ctx);
    checkInterrupted(ctx);
    checkHealth(ctx);
    checkNearbyHostiles(ctx);
    const feet = floorPos(bot.entity.position);
    visited.add(formatPosition(feet));
    let moved = false;
    const candidates = headings.map(heading => ({heading, rise: 1}));
    // 沙砾覆盖上方时，保留顶板，从同一高度绕出；限制横向开挖总量。
    if (lateral < 8) candidates.push(...headings.map(heading => ({heading, rise: 0})));
    for (const {heading, rise} of candidates) {
      const landing = offsetPos(feet, heading.x, rise, heading.z);
      if (visited.has(formatPosition(landing))) continue;
      const floorAt = offsetPos(landing, 0, -1, 0);
      let support = blockAtPos(bot, floorAt);
      const placeFloor = !rise && fillGaps && (isPassableBlock(support) || support?.name === 'water')
        && dryMiningFooting(bot, bot.entity.position) && ['stone','sandstone','dirt','deepslate','cobblestone'].includes(
          blockAtPos(bot, offsetPos(floorAt, 0, -1, 0))?.name) && ctx.countItem('cobblestone') > 0;
      if (!placeFloor && (!support || support.boundingBox !== 'block' || isHazardBlock(support) || waterLike(support))) continue;
      const opening = [offsetPos(landing, 0, 1, 0), landing];
      if (rise) opening.unshift(offsetPos(feet, 0, 2, 0));
      // 只挖有支撑的上行台阶。不能从头顶放出沙砾、水或岩浆。
      const safeOpening = p => {
        const cell = blockAtPos(bot, p);
        return isPassableBlock(cell) ? !waterLike(cell) && !isHazardBlock(cell) : safeStairOpening(bot, p);
      };
      if (!opening.every(safeOpening)) continue;
      for (const cell of opening) {
        checkInterrupted(ctx);
        if (isPassableBlock(blockAtPos(bot, cell))) continue;
        if (!safeStairOpening(bot, cell)) throw new Error('上行开口旁的方块或流体发生变化');
        const dug = await digAt(ctx, cell, {clearByHand});
        if (!dug.ok) break;
      }
      if (!opening.every(p => isPassableBlock(blockAtPos(bot, p)) && safeOpening(p))) continue;
      if (placeFloor) {
        try {
          await ctx.placeBlock({block: 'cobblestone', ...floorAt});
        } catch {
          checkInterrupted(ctx);
          continue;
        }
        checkInterrupted(ctx);
        support = blockAtPos(bot, floorAt);
        if (support?.name !== 'cobblestone' || support.boundingBox !== 'block') continue;
      }
      const outcome = await stepForward(ctx, landing, true);
      const actual = floorPos(bot.entity.position);
      if (actual.x === landing.x && actual.y === landing.y && actual.z === landing.z) {
        if (!dryMiningFooting(bot, bot.entity.position)) throw new Error('上行后无法确认落点仍是干地');
        if (rise) climbed++;
        else lateral++;
        moved = true;
        break;
      }
      if (outcome === 'stopped' || actual.x !== feet.x || actual.z !== feet.z || actual.y !== feet.y) {
        throw new Error('上行中位置变化，停止开挖并重新观察');
      }
    }
    if (!moved) throw new Error(`从 ${formatPosition(feet)} 未找到有支撑的安全上行台阶（已横移 ${lateral} 格）`);
  }
  return {status: 'succeeded', detail: `沿干燥台阶实际上升 ${count} 层，现在 Y=${floorPos(bot.entity.position).y}`};
}

async function stripMine(args, ctx) {
  const bot = ctx.bot;
  requireConnected(ctx);
  const rise = clampInt(args.rise, 0, 0, 8);
  if (rise > 0) {
    const heading = directionFromName(args.direction) || directionFromYaw(bot.entity.yaw) || CARDINAL_HEADINGS[0];
    return withDryMiningMovement(ctx, () => climbMiningStairs(ctx, rise, heading, args.fill_gaps === true, args.clear_by_hand === true), {surfaceOnly: true});
  }
  const length = clampInt(args.length, 32, 1, 128);
  const branchCount = clampInt(args.branches, 2, 0, 8);
  const branchLength = clampInt(args.branchLength, 8, 1, 32);
  const shaft = clampInt(args.shaft, 0, 0, 64);
  const torchInterval = clampInt(args.torchInterval, TORCH_INTERVAL, 0, 64);
  const targetY = args.y === undefined || args.y === null ? null : clampInt(args.y, 0, -64, 320);
  const targetName = args.target ? String(args.target) : '';
  const notes = [];
  const state = { mined: 0, torches: 0, branches: 0, steps: 0 };
  const start = floorPos(bot.entity.position);
  if (shaft > 0 && args.length === 0) {
    await withDryMiningMovement(ctx, () => digShaftDown(ctx, shaft, state, LOW_HEALTH, targetY, true), {surfaceOnly: true});
    const end = floorPos(bot.entity.position);
    if (targetY !== null && end.y !== targetY) throw new Error(`下探停在 Y=${end.y}，目标 Y=${targetY}`);
    return {status: 'succeeded', detail: `已下行 ${start.y - end.y} 层并留出返程净空，落点 ${formatPosition(end)}`};
  }

  // 火把：先用 ctx 的合成能力补货，没有就记下来继续挖。
  const torchPlan = torchInterval > 0 ? Math.floor(length / torchInterval) + 1 : 0;
  await ensureTorches(ctx, torchPlan, notes);
  checkInterrupted(ctx);

  // 先挖竖井到目标高度。
  if (shaft > 0) {
    await digShaftDown(ctx, shaft, state, LOW_HEALTH, targetY);
  } else if (targetY !== null && start.y > targetY) {
    await digShaftDown(ctx, start.y - targetY, state, LOW_HEALTH, targetY);
  }

  let heading = args.direction ? directionFromName(args.direction) : directionFromYaw(bot.entity.yaw);
  if (!heading) heading = CARDINAL_HEADINGS[0];
  let position = floorPos(bot.entity.position);
  if (targetY !== null && position.y !== targetY) {
    throw new Error(`无法到达目标 Y=${targetY}，当前在 Y=${position.y}，已停止挖矿`);
  }
  const branchEvery = branchCount > 0 ? Math.max(2, Math.floor(length / (branchCount + 1))) : 0;
  const ores = [];
  const seenOre = new Set();
  let completedSteps = 0;
  let attempts = 0;

  while (completedSteps < length && attempts < length * 4) {
    attempts += 1;
    const step = completedSteps + 1;
    requireConnected(ctx);
    checkHealth(ctx);
    const wantTorch = torchInterval > 0 && step % torchInterval === 0;
    const result = await digForward(ctx, position, heading, state, {
      torch: wantTorch,
      notes,
    });
    if (!result.ok) {
      if (args.direction && ['the_nether', 'minecraft:the_nether'].includes(bot.game?.dimension)) {
        const error = new Error(`下界巷道沿${heading.name}方向在第 ${step} 格受阻：${result.message || result.reason}（已挖 ${state.steps} 格长度的巷道）`);
        error.data = {reason: result.reason, nether_passages: observeNetherPassages(bot)};
        throw error;
      }
      if (result.reason === 'hazard') {
        throw new Error(
          `${result.message}，已停止挖矿：坐标 ${formatPosition(result.position)}（已挖 ${state.steps} 格长度的巷道）`,
        );
      }
      if (result.reason === 'unreachable' || result.reason === 'stopped') {
        throw new Error(`第 ${step} 格挖开后位置未确认，已停止挖矿`);
      }
      // 走不动就换一个朝向继续。
      const alternative = pickSafeHeading(ctx.bot, position, {
        exclude: [heading.name],
        ahead: 2,
        below: 0,
      });
      if (!alternative) {
        throw new Error(`挖到第 ${step} 格走不动了，已停止挖矿（已挖 ${state.steps} 格长度的巷道）`);
      }
      heading = alternative;
      notes.push(`第 ${step} 格改向${heading.name}`);
      continue;
    }
    position = result.position;
    completedSteps += 1;
    if (targetName) {
      for (const ore of scanOre(ctx, targetName, 8)) {
        const key = `${ore.x},${ore.y},${ore.z}`;
        if (seenOre.has(key)) continue;
        seenOre.add(key);
        ores.push(ore);
      }
    }
    if (branchEvery > 0 && step % branchEvery === 0 && state.branches < branchCount) {
      const done = await digBranch(ctx, position, heading, branchLength, state);
      if (!done.ok && done.moved) {
        throw new Error(`第 ${step} 格的支巷没能返回主巷，已停止挖矿以避免位置失配`);
      }
      if (!done.ok) notes.push(`第 ${step} 格的支巷没挖成`);
    }
  }
  if (completedSteps < length) {
    throw new Error(`只挖成 ${completedSteps}/${length} 格巷道，已停止挖矿`);
  }
  const end = floorPos(bot.entity.position);
  const parts = [
    `挖了 ${state.steps} 格长度的巷道（清掉 ${state.mined} 个方块），巷道终点 ${formatPosition(end)}`,
    `分支 ${state.branches} 条`,
    `火把 ${state.torches} 个`,
  ];
  if (ores.length > 0) {
    parts.push(`${targetName}：${ores.map((ore) => formatPosition(ore)).join('、')}`);
  }
  if (notes.length > 0) parts.push(notes.join('；'));
  return { detail: parts.join('，'), status: 'succeeded' };
}

// ---------------------------------------------------------------------------
// 技能：deep_mine
// ---------------------------------------------------------------------------

// 深层矿道：目标 y=-54~-59。扫前方与脚下 3 格避岩浆，
// 水和岩浆能填埋就填埋，不能填就绕行；末影人与恶魂直接撤退中止。
async function deepMine(args, ctx) {
  const bot = ctx.bot;
  requireConnected(ctx);
  const targetY = clampInt(args.y ?? args.targetY, -56, -64, 0);
  const length = clampInt(args.length, 20, 1, 64);
  const branchCount = clampInt(args.branches, 2, 0, 6);
  const branchLength = clampInt(args.branchLength, 6, 1, 24);
  const lowHealth = clampInt(args.lowHealth, LOW_HEALTH, 1, 20);
  const notes = [];
  const state = { mined: 0, torches: 0, branches: 0, steps: 0, filled: 0, detours: 0 };
  const start = floorPos(bot.entity.position);

  // 下降到目标高度，竖井里同样要躲岩浆。
  if (start.y > targetY) {
    await digShaftDown(ctx, start.y - targetY, state, lowHealth, targetY);
  } else if (start.y < targetY) {
    notes.push(`现在在 Y=${start.y}，已经比目标 ${targetY} 更深，就在这里挖`);
  }

  let heading = args.direction ? directionFromName(args.direction) : directionFromYaw(bot.entity.yaw);
  if (!heading) heading = CARDINAL_HEADINGS[0];
  let position = floorPos(bot.entity.position);
  const branchEvery = branchCount > 0 ? Math.max(2, Math.floor(length / (branchCount + 1))) : 0;
  let completedSteps = 0;
  let attempts = 0;

  while (completedSteps < length && attempts < length * 4) {
    attempts += 1;
    const step = completedSteps + 1;
    requireConnected(ctx);
    checkHealth(ctx, lowHealth);

    // 洞穴怪：末影人与恶魂直接撤退并中止。
    const danger = findDangerMob(ctx, 16);
    if (danger) {
      if (typeof ctx.retreatFrom === 'function') {
        await ctx.retreatFrom(danger);
      }
      throw new Error(
        `遇到${blockLabelOf(ctx, danger.name)}，已撤退并中止挖矿（坐标 ${formatPosition(floorPos(danger.position))}）`,
      );
    }

    // 前方与脚下 3 格的危险。
    const hazards = scanHazards(ctx.bot, position, heading, { ahead: 1, down: 2, below: 3 });
    if (hazards.lava.length > 0) {
      const plugged = await plugLava(ctx, hazards.lava[0], state, notes);
      if (!plugged) {
        const alternative = pickSafeHeading(ctx.bot, position, {
          exclude: [heading.name],
          ahead: 2,
          below: 0,
        });
        if (!alternative) {
          throw new Error(
            `遇到岩浆，填埋不了也没有安全的绕行方向，已中止挖矿：岩浆在 ${formatPosition(hazards.lava[0])}`,
          );
        }
        heading = alternative;
        state.detours += 1;
        notes.push(`岩浆在 ${formatPosition(hazards.lava[0])}，改向${heading.name}绕行`);
        continue;
      }
    }
    if (hazards.water.length > 0) {
      const plugged = await plugLava(ctx, hazards.water[0], state, notes);
      if (!plugged) {
        const alternative = pickSafeHeading(ctx.bot, position, {
          exclude: [heading.name],
          ahead: 2,
          below: 0,
        });
        if (!alternative) {
          throw new Error(
            `遇到水，填埋不了也没有安全的绕行方向，已中止挖矿：水在 ${formatPosition(hazards.water[0])}`,
          );
        }
        heading = alternative;
        state.detours += 1;
        notes.push(`水在 ${formatPosition(hazards.water[0])}，改向${heading.name}绕行`);
        continue;
      }
    }

    const result = await digForward(ctx, position, heading, state);
    if (!result.ok) {
      if (result.reason === 'hazard') {
        const alternative = pickSafeHeading(ctx.bot, position, {
          exclude: [heading.name],
          ahead: 2,
          below: 0,
        });
        if (!alternative) {
          throw new Error(
            `${result.message}，已中止挖矿：坐标 ${formatPosition(result.position)}（已挖 ${state.steps} 格长度的巷道）`,
          );
        }
        heading = alternative;
        state.detours += 1;
        notes.push(`${result.message}在 ${formatPosition(result.position)}，改向${heading.name}绕行`);
        continue;
      }
      if (result.reason === 'unreachable' || result.reason === 'stopped') {
        throw new Error(`深层第 ${step} 格挖开后位置未确认，已中止挖矿`);
      }
      const alternative = pickSafeHeading(ctx.bot, position, {
        exclude: [heading.name],
        ahead: 2,
        below: 0,
      });
      if (!alternative) {
        throw new Error(`挖到第 ${step} 格走不动了，已中止挖矿（已挖 ${state.steps} 格长度的巷道）`);
      }
      heading = alternative;
      state.detours += 1;
      notes.push(`第 ${step} 格改向${heading.name}`);
      continue;
    }
    position = result.position;
    completedSteps += 1;
    if (branchEvery > 0 && step % branchEvery === 0 && state.branches < branchCount) {
      const done = await digBranch(ctx, position, heading, branchLength, state, lowHealth);
      if (!done.ok && done.moved) {
        throw new Error(`第 ${step} 格的支巷没能返回主巷，已中止深层挖矿以避免位置失配`);
      }
      if (!done.ok) notes.push(`第 ${step} 格的支巷没挖成`);
    }
  }
  if (completedSteps < length) {
    throw new Error(`深层矿道只挖成 ${completedSteps}/${length} 格，已中止`);
  }
  const end = floorPos(bot.entity.position);
  const parts = [
    `在 Y=${end.y} 挖了 ${state.steps} 格长度的巷道（清掉 ${state.mined} 个方块），巷道终点 ${formatPosition(end)}`,
    `分支 ${state.branches} 条`,
    `填埋 ${state.filled} 处`,
    `绕行 ${state.detours} 次`,
  ];
  if (notes.length > 0) parts.push(notes.join('；'));
  return { detail: parts.join('，'), status: 'succeeded' };
}

// 找必须躲开的洞穴怪（末影人、恶魂）。找不到返回 null。
function findDangerMob(ctx, radius) {
  if (typeof ctx.findHostile !== 'function') return null;
  const entity = ctx.findHostile(radius);
  if (!entity) return null;
  if (!DEEP_DANGER_MOBS.has(String(entity.name || ''))) return null;
  return entity;
}

// 填埋岩浆或水：背包里有圆石/泥土就把它盖住。没有材料或够不到就返回 false。
async function plugLava(ctx, hazard, state, notes) {
  const bot = ctx.bot;
  const materials = ['cobblestone', 'dirt', 'stone', 'deepslate', 'gravel'];
  let material = '';
  for (const name of materials) {
    if (ctx.countItem(name) > 0) {
      material = name;
      break;
    }
  }
  if (!material) {
    notes.push('背包里没有圆石或泥土，填埋不了岩浆');
    return false;
  }
  const distance = distanceBetween(bot.entity.position, hazard);
  if (distance > MINE_REACH) {
    notes.push(`岩浆在 ${formatPosition(hazard)}，离得太远填埋不了`);
    return false;
  }
  const targets = [hazard, { x: hazard.x, y: hazard.y + 1, z: hazard.z }];
  for (const target of targets) {
    const existing = blockAtPos(bot, target);
    if (existing && !isHazardBlock(existing)) continue;
    try {
      if (typeof ctx.placeBlock !== 'function') {
        notes.push('桥接没有提供放置方块的能力，填埋不了');
        return false;
      }
      await ctx.placeBlock({ block: material, x: target.x, y: target.y, z: target.z });
      checkInterrupted(ctx);
      const placed = blockAtPos(bot, target);
      if (placed && !isHazardBlock(placed)) {
        state.filled += 1;
        notes.push(`用${blockLabelOf(ctx, material)}填住了 ${formatPosition(hazard)}`);
        return true;
      }
    } catch (error) {
      checkInterrupted(ctx);
      notes.push(`填埋失败：${error.message}`);
      return false;
    }
  }
  return false;
}

// 在有限数量的砂砾里寻找燧石，成功条件是燧石进入背包。
async function collectFlint(args, ctx) {
  requireConnected(ctx);
  const target = clampInt(args.count, 1, 1, 16);
  const range = clampInt(args.range, 32, 8, 64);
  const before = ctx.countItem('flint');
  if (before >= target) {
    return { detail: `背包里已经有 ${before} 个燧石，不需要继续挖砂砾`, status: 'succeeded' };
  }
  const gravel = registryOf(ctx)?.blocksByName?.gravel;
  if (!gravel) throw new Error('当前 Minecraft 数据里没有 gravel 方块定义');
  const positions = resourceCandidates(
    ctx,
    gravel.id,
    range,
    Math.min(256, Math.max(64, (target - before) * 24)),
  );
  const failures = [];
  let broken = 0;
  for await (const position of positions) {
    requireConnected(ctx);
    checkHealth(ctx);
    if (ctx.countItem('flint') >= target) break;
    const block = blockAtPos(ctx.bot, position);
    if (!block || block.name !== 'gravel') continue;
    if (distanceBetween(ctx.bot.entity.position, position) > MINE_REACH) {
      const outcome = await ctx.travelToBlock(position, 30000);
      checkInterrupted(ctx);
      if (outcome === 'cancelled' || outcome === 'stopped') throw new Error('寻找燧石时移动被取消');
      if (outcome === 'low_health') throw new Error(`血量不足（血量 ${ctx.bot.health}），停止寻找燧石`);
      if (outcome !== 'reached') {
        failures.push(`${formatPosition(position)} 走不到`);
        continue;
      }
    }
    const dig = await digAt(ctx, position);
    checkInterrupted(ctx);
    if (!dig.ok) {
      failures.push(`${formatPosition(position)} ${dig.message}`);
      continue;
    }
    broken += 1;
    await collectDrop(ctx, 'flint');
    checkInterrupted(ctx);
    if (ctx.countItem('flint') >= target) break;
  }
  const gained = ctx.countItem('flint') - before;
  if (gained < target - before) {
    throw new Error(`已挖 ${broken} 块砂砾，只获得 ${gained} 个燧石，还差 ${target - before - gained} 个${failures.length ? `；${failures.join('；')}` : ''}`);
  }
  return { detail: `挖了 ${broken} 块砂砾，获得 ${gained} 个燧石，背包共 ${ctx.countItem('flint')} 个`, status: 'succeeded' };
}

// ---------------------------------------------------------------------------
// 技能：find_diamond
// ---------------------------------------------------------------------------

// 找钻石矿。普通钻石矿与深层变体都认，可以在指定 Y 区间里搜。
async function findDiamond(args, ctx) {
  const bot = ctx.bot;
  requireConnected(ctx);
  const registry = registryOf(ctx);
  const yMin = clampInt(args.yMin, -59, -64, 320);
  const yMax = clampInt(args.yMax, 15, -64, 320);
  if (yMax < yMin) throw new Error(`Y 区间不对：下界 ${yMin} 比上界 ${yMax} 还大`);
  const radius = clampInt(args.radius, 48, 4, 96);
  const want = clampInt(args.count, 8, 1, 64);
  const ids = [];
  for (const name of DIAMOND_ORES) {
    const entry = registry?.blocksByName?.[name];
    if (entry) ids.push(entry.id);
  }
  if (ids.length === 0) throw new Error('当前游戏版本里没有钻石矿');
  const positions = bot.findBlocks({
    matching: ids,
    maxDistance: radius,
    count: Math.max(want * 4, 16),
  });
  const hits = positions
    .filter((position) => position.y >= yMin && position.y <= yMax)
    .filter((position) => {
      const block = blockAtPos(bot, position);
      return Boolean(block && isDiamondOre(block.name));
    })
    .slice(0, want);
  if (hits.length === 0) {
    throw new Error(`在 Y ${yMin} 到 ${yMax} 的区间内没有找到钻石矿（搜了 ${radius} 格）`);
  }
  const detail = hits.map((position) => {
    const block = blockAtPos(bot, position);
    return `${block.name} ${formatPosition(position)}`;
  });
  const deep = hits.filter((position) => {
    const block = blockAtPos(bot, position);
    return Boolean(block && block.name === 'deepslate_diamond_ore');
  }).length;
  return {
    detail: `找到 ${hits.length} 处钻石矿（深层 ${deep} 处）：${detail.join('、')}`,
    status: 'succeeded',
  };
}

// ---------------------------------------------------------------------------
// 技能清单
// ---------------------------------------------------------------------------

export const skills = {
  fill_water_bucket: {
    description: '用空桶装取附近的静止水源，并确认背包实际获得水桶。',
    parameters: [
      { name: 'range', type: 'number', required: false, default: 32, description: '静止水源搜索范围，4-64 格。' },
    ],
    handler: fillWaterBucket,
  },
  collect_obsidian: {
    description: '优先采集现有黑曜石；不足时在主世界将可安全接近的静止岩浆源逐个浇成黑曜石，回收水源后用钻石镐采集并按背包验收。',
    parameters: [
      { name: 'count', type: 'number', required: false, default: 10, description: '目标黑曜石数量，最多 10 个。' },
      { name: 'range', type: 'number', required: false, default: 32, description: '搜索范围，8-64 格。' },
    ],
    handler: collectObsidian,
  },
  collect_flint: {
    description: '有限挖掘砂砾并实际收集燧石；按背包燧石数量停下，不把砂砾当作任务产物。',
    parameters: [
      { name: 'count', type: 'number', required: false, default: 1, description: '需要的燧石数量，范围 1-16。' },
      { name: 'range', type: 'number', required: false, default: 32, description: '砂砾搜索范围，范围 8-64 格。' },
    ],
    handler: collectFlint,
  },
  mine_collect: {
    description:
      '挖指定方块：按目标换工具，挖掉之后等掉落物，走过去真的捡起来，最后核对背包数量。',
    parameters: [
      { name: 'block', type: 'string', required: true, default: null, description: '目标方块 ID；wood_log 搜索任意主世界原木，铁矿、煤矿、钻石矿同时搜索深层变体。' },
      { name: 'count', type: 'number', required: true, default: 1, description: '背包掉落物总目标，范围 1-2304，可跨多堆；已有数量算在内。' },
      { name: 'minimum_count', type: 'number', required: false, default: null, description: '可选最低背包总量。达到后只采触手可及的方块以补足 count，按实际库存回报。' },
      { name: 'within_reach', type: 'boolean', required: false, default: false, description: '只采挖掘距离内的方块，候选耗尽即回报。' },
      { name: 'local_vein', type: 'boolean', required: false, default: false, description: '只沿干燥、有支撑的短通道接近已加载的煤、铁或钻石矿，最远 16 格。' },
      { name: 'surface_wood', type: 'boolean', required: false, default: false, description: '地表补木时仅搜索接近出发高度且相邻空间有天空光的主世界原木。' },
      { name: 'avoid_positions', type: 'array', required: false, default: [], description: '已确认的危险坐标；跳过其水平八格范围内的矿点，换区后也不返回危险点。',
        items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'], additionalProperties: false } },
      { name: 'range', type: 'number', required: false, default: 32, description: '搜索已加载方块的半径，8-64 格；wood_log 可扩大到 128 格。' },
    ],
    handler: (args, ctx) => String(args.block || '').endsWith('_ore')
      ? withDryMiningMovement(ctx, () => mineCollect(args, ctx))
      : mineCollect(args, ctx),
  },
  strip_mine: {
    description:
      '挖一条主巷道加若干分支，头顶 2 格与前方 1 格必须通得过，沿途放火把，遇岩浆或水停下并上报坐标。',
    parameters: [
      { name: 'length', type: 'number', required: false, default: 32, description: '主巷道长度（格）。有 shaft 时传 0 表示只挖可原路返回的台阶。' },
      { name: 'branches', type: 'number', required: false, default: 2, description: '支巷数量。' },
      { name: 'branchLength', type: 'number', required: false, default: 8, description: '每条支巷的长度（格）。' },
      { name: 'shaft', type: 'number', required: false, default: 0, description: '开始前先挖多深的垂直竖井。' },
      { name: 'rise', type: 'number', required: false, default: 0, description: '只沿有支撑的干地向上开挖台阶，最多 8 层。' },
      { name: 'fill_gaps', type: 'boolean', required: false, default: false, description: '上行横移时可用圆石填补底部有支撑的一格浅缺口。' },
      { name: 'clear_by_hand', type: 'boolean', required: false, default: false, description: '缺镐时允许徒手清除上行通道中的普通岩石。' },
      { name: 'y', type: 'number', required: false, default: null, description: '目标 Y 高度，缺省就在当前高度挖。' },
      { name: 'direction', type: 'string', required: false, default: null, description: '主巷道方向：north / south / east / west，缺省按当前朝向。' },
      { name: 'torchInterval', type: 'number', required: false, default: 8, description: '每多少格放一个火把，0 表示不放。' },
      { name: 'target', type: 'string', required: false, default: null, description: '顺路要找的矿物 ID，例如 iron_ore，会在结果里给出坐标。' },
    ],
    handler: stripMine,
  },
  deep_mine: {
    description:
      '挖深层矿道（目标 y=-54~-59），扫描前方与脚下 3 格躲岩浆，水和岩浆能填埋就填埋、不能就绕行，遇到末影人或恶魂立刻撤退中止。',
    parameters: [
      { name: 'y', type: 'number', required: false, default: -56, description: '目标 Y 高度，M6 的目标是 -54 到 -59。' },
      { name: 'length', type: 'number', required: false, default: 20, description: '主巷道长度（格）。' },
      { name: 'branches', type: 'number', required: false, default: 2, description: '支巷数量。' },
      { name: 'branchLength', type: 'number', required: false, default: 6, description: '每条支巷的长度（格）。' },
      { name: 'direction', type: 'string', required: false, default: null, description: '主巷道方向：north / south / east / west，缺省按当前朝向。' },
      { name: 'lowHealth', type: 'number', required: false, default: 8, description: '血量低于这个值就中止挖矿。' },
    ],
    handler: deepMine,
  },
  find_diamond: {
    description:
      '在指定 Y 区间里找钻石矿，diamond_ore 与 deepslate_diamond_ore 都认，返回坐标列表。',
    parameters: [
      { name: 'yMin', type: 'number', required: false, default: -59, description: '搜索区间的最低 Y。' },
      { name: 'yMax', type: 'number', required: false, default: 15, description: '搜索区间的最高 Y。' },
      { name: 'radius', type: 'number', required: false, default: 48, description: '搜索半径，4-96 格。' },
      { name: 'count', type: 'number', required: false, default: 8, description: '最多返回多少处坐标。' },
    ],
    handler: findDiamond,
  },
};

export default skills;
