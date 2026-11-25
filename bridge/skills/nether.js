// 下界模块：黑曜石下界门、维度坐标换算、堡垒探索、烈焰棒收集。
import { besideDrop, dryMiningFooting, exposedMagmaCube, followNetherPath, netherRouteExclusion, reachableNetherGround } from '../dry_footing.js';
// 契约见 docs/plans/SKILL_MODULE_CONTRACT.md；对应路线图 M7.1-M7.4。
//
// 约束：
// - 只用 ctx 提供的能力，不 import 任何运行时依赖；bot 从 ctx.bot 取。
// - 模块之间不互相 import；需要别的技能时走 ctx 的技能入口，缺了就在结果里说明。
// - 坐标换算、门框布局、堡垒方块判定都是纯函数，单独导出，方便脱离游戏单测。
// - 结果只写真实读到的背包数量、方块与坐标，不凭空说「已建好门」。
//
// 跨模块战斗通过 ctx.runSkill 共享当前动作的取消与进度回执。

// ------------------------------------------------------------------ 常量

// 1.21.1 的维度 id。
const NETHER_DIMENSION = 'minecraft:the_nether';
const OVERWORLD_DIMENSION = 'minecraft:overworld';
const END_DIMENSION = 'minecraft:the_end';

// 主世界 : 下界 = 1 : 8。
const DIMENSION_SCALE = 8;

// 下界门：门内净空 2 宽 3 高，最省的门框要 10 块黑曜石，带上四角是 14 块。
const PORTAL_INTERIOR_WIDTH = 2;
const PORTAL_INTERIOR_HEIGHT = 3;
export const PORTAL_FRAME_OBSIDIAN = 10;
export const PORTAL_FULL_OBSIDIAN = 14;

// M7.4 的目标：7 根烈焰棒。
const BLAZE_ROD_TARGET = 7;

// 找下界门与堡垒结构的默认半径。
const DEFAULT_PORTAL_RADIUS = 32;
const DEFAULT_FORTRESS_RADIUS = 64;
const FORTRESS_ROUTE_SPACING = 16;
const FORTRESS_ROUTE_BUDGET_WAYPOINTS = 16;
const BLAZE_PATROL_BUDGET = 8;

function canonicalDimension(value) {
  const dimension = String(value || '').trim().toLowerCase();
  return {
    overworld: OVERWORLD_DIMENSION,
    the_nether: NETHER_DIMENSION,
    the_end: END_DIMENSION,
  }[dimension] || dimension;
}

// 导航只依赖能明确指向下界砖堡垒的方块，避免把普通下界地形当结构。
const FORTRESS_STRUCTURE_BLOCKS = new Set([
  'nether_bricks',
  'nether_brick_fence',
  'nether_brick_stairs',
  'nether_brick_slab',
  'nether_brick_wall',
  'nether_wart',
]);

// 岩浆类方块：掉进去会烧死，捡掉落物时必须避开。
const LAVA_BLOCK_NAMES = new Set(['lava', 'flowing_lava', 'magma_block', 'lava_cauldron']);

// 堡垒与下界废墟的结构方块。
export const FORTRESS_BLOCKS = new Set([
  'nether_bricks',
  'nether_brick_fence',
  'nether_brick_stairs',
  'nether_brick_slab',
  'nether_brick_wall',
  'nether_wart',
  'nether_wart_block',
  'nether_portal',
  'soul_sand',
  'soul_soil',
  'magma_block',
  'basalt',
  'smooth_basalt',
  'polished_blackstone',
  'polished_blackstone_brick',
  'polished_blackstone_brick_slab',
  'polished_blackstone_brick_stairs',
  'polished_blackstone_brick_wall',
  'chiseled_polished_blackstone',
  'blackstone',
  'gilded_blackstone',
  'chain',
  'netherrack',
  'bone_block',
  'iron_bars',
  'shroomlight',
  'crimson_roots',
  'warped_roots',
  'nether_sprouts',
]);

// 堡垒里要打的怪。
export const FORTRESS_ENTITIES = new Set(['blaze']);

// ctx.blockLabel 不认识这些 id，这里自己给中文名。
const BLOCK_LABELS = {
  obsidian: '黑曜石',
  flint_and_steel: '打火石',
  blaze_rod: '烈焰棒',
  nether_portal: '下界门',
  nether_bricks: '下界砖块',
  nether_brick_fence: '下界砖栅栏',
  nether_brick_stairs: '下界砖楼梯',
  nether_brick_slab: '下界砖台阶',
  nether_wart: '下界疣',
  nether_wart_block: '下界疣块',
  lava: '岩浆',
  flowing_lava: '流动岩浆',
  magma_block: '岩浆块',
  soul_sand: '灵魂沙',
  basalt: '玄武岩',
  netherrack: '下界岩',
  blackstone: '黑石',
};

// 模块级状态只服务当前 Bridge 进程；可恢复事实会随动作结果返回给 Core。
const moduleState = {
  portalTransition: null,
  structures: [],
};

function copyAnchor(anchor) {
  if (!anchor) return null;
  return {
    dimension: anchor.dimension,
    position: { ...anchor.position },
    observed: anchor.observed,
  };
}

function portalTransitionData(transition = moduleState.portalTransition) {
  if (!transition) return null;
  return {
    source: copyAnchor(transition.source),
    target: copyAnchor(transition.target),
  };
}

function withActionData(error, data) {
  const result = error instanceof Error ? error : new Error(String(error));
  result.data = { ...(result.data || {}), ...data };
  return result;
}

// ------------------------------------------------------------------ 纯逻辑

// 维度判断：下界是 minecraft:the_nether。
export function isNetherDimension(dimension) {
  return canonicalDimension(dimension) === NETHER_DIMENSION;
}

// 主世界判断只接受 Mineflayer 的原版维度 ID。
export function isOverworldDimension(dimension) {
  return canonicalDimension(dimension) === OVERWORLD_DIMENSION;
}

// 末地判断。
export function isEndDimension(dimension) {
  return canonicalDimension(dimension) === END_DIMENSION;
}

// 通用坐标缩放：factor 是倍率，结果按格取整。
export function scaleCoordinate(x, z, factor) {
  const baseX = Math.floor(Number(x));
  const baseZ = Math.floor(Number(z));
  const rate = Number(factor);
  if (!Number.isFinite(baseX) || !Number.isFinite(baseZ) || !Number.isFinite(rate)) return null;
  return { x: Math.floor(baseX * rate), z: Math.floor(baseZ * rate) };
}

// 主世界坐标换算成下界坐标（除以 8）。
export function netherScale(x, z) {
  return scaleCoordinate(x, z, 1 / DIMENSION_SCALE);
}

// 下界坐标换算回主世界坐标（乘以 8）。
export function overworldScale(x, z) {
  return scaleCoordinate(x, z, DIMENSION_SCALE);
}

// checkpoint 只放在返回值里，不落盘。
// 返回当前维度、当前位置，以及同一地点在两个维度的 x/z。
export function checkpointInfo(position, dimension) {
  const x = Math.floor(Number(position && position.x));
  const y = Math.floor(Number(position && position.y));
  const z = Math.floor(Number(position && position.z));
  if (![x, y, z].every(Number.isFinite)) return null;
  const inNether = isNetherDimension(dimension);
  const nether = inNether ? { x, z } : netherScale(x, z);
  const overworld = inNether ? overworldScale(x, z) : { x, z };
  return {
    dimension: String(dimension || ''),
    position: { x, y, z },
    nether: { x: nether.x, z: nether.z },
    overworld: { x: overworld.x, z: overworld.z },
  };
}

// 下界门框布局：以门内左下角为原点，facing 决定门宽方向。
// facing='x' 表示门宽沿 x 轴（门内两格在 x 上并排，门是 1 深的）；
// facing='z' 则门宽沿 z 轴。
// 返回 interior 门内 6 格、bottom 底排 4 格、sides 两侧 6 格、
// frame 为两条横梁与两侧共 10 格，full 包含四角共 14 格。
export function portalFrame(origin, facing) {
  const axis = facing === 'z' ? 'z' : 'x';
  const ox = Math.floor(Number(origin && origin.x));
  const oy = Math.floor(Number(origin && origin.y));
  const oz = Math.floor(Number(origin && origin.z));
  if (![ox, oy, oz].every(Number.isFinite)) return null;
  const at = (dx, dy, dz) => ({ x: ox + dx, y: oy + dy, z: oz + dz });

  const interior = [];
  for (let dy = 0; dy < PORTAL_INTERIOR_HEIGHT; dy += 1) {
    for (let d = 0; d < PORTAL_INTERIOR_WIDTH; d += 1) {
      interior.push(axis === 'x' ? at(d, dy, 0) : at(0, dy, d));
    }
  }

  const bottom = [];
  for (let d = -1; d <= PORTAL_INTERIOR_WIDTH; d += 1) {
    bottom.push(axis === 'x' ? at(d, -1, 0) : at(0, -1, d));
  }

  const sides = [];
  for (let dy = 0; dy < PORTAL_INTERIOR_HEIGHT; dy += 1) {
    sides.push(axis === 'x' ? at(-1, dy, 0) : at(0, dy, -1));
    sides.push(axis === 'x' ? at(2, dy, 0) : at(0, dy, 2));
  }

  const top = [];
  for (let d = -1; d <= PORTAL_INTERIOR_WIDTH; d += 1) {
    top.push(axis === 'x' ? at(d, PORTAL_INTERIOR_HEIGHT, 0) : at(0, PORTAL_INTERIOR_HEIGHT, d));
  }

  const frame = [...bottom.slice(1, -1), ...sides, ...top.slice(1, -1)];
  return {
    axis,
    origin: { x: ox, y: oy, z: oz },
    interior,
    bottom,
    sides,
    frame,
    top,
    full: [...bottom, ...sides, ...top],
  };
}

// 堡垒结构方块判定。
export function isFortressBlock(name) {
  return FORTRESS_BLOCKS.has(String(name || '').toLowerCase());
}

// 堡垒里要打的实体判定。
export function isFortressEntity(name) {
  return FORTRESS_ENTITIES.has(String(name || '').toLowerCase());
}

// 岩浆判定：lava / flowing_lava / magma_block 都算。
export function isLavaName(name) {
  const text = String(name || '').toLowerCase();
  if (LAVA_BLOCK_NAMES.has(text)) return true;
  return text.startsWith('lava_');
}

// yaw 0 面向 +Z，顺时针增大；返回正交的单位朝向。
export function facingFromYaw(yaw) {
  const angle = Number(yaw);
  const headings = [
    { x: 0, z: 1 },
    { x: -1, z: 0 },
    { x: 0, z: -1 },
    { x: 1, z: 0 },
  ];
  if (!Number.isFinite(angle)) return headings[0];
  const index = Math.round(angle / (Math.PI / 2));
  return headings[((index % 4) + 4) % 4];
}

// 数值夹取。
export function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

// ------------------------------------------------------------------ ctx 工具

function botOf(ctx) {
  const bot = ctx && ctx.bot;
  if (!bot || !bot.entity || !bot.entity.position) {
    throw new Error('还没有进入世界，无法在下界行动');
  }
  return bot;
}

function sleepMs(ctx, ms) {
  if (typeof ctx.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(ctx, ...args) {
  if (typeof ctx.log === 'function') ctx.log(...args);
}

function throwIfInterrupted(ctx, action) {
  if (ctx && ctx.interrupted) throw new Error(`${action}被新的指令打断`);
}

// 当前维度 id，例如 minecraft:the_nether。
function currentDimension(ctx) {
  const bot = ctx && ctx.bot;
  const game = bot && bot.game;
  return canonicalDimension(game && game.dimension);
}

function isExpectedDimension(ctx, expected) {
  const actual = currentDimension(ctx);
  if (expected === NETHER_DIMENSION) return isNetherDimension(actual);
  if (expected === OVERWORLD_DIMENSION) return isOverworldDimension(actual);
  return actual === expected;
}

function dimensionLabel(dimension) {
  if (isNetherDimension(dimension)) return '下界';
  if (isEndDimension(dimension)) return '末地';
  if (isOverworldDimension(dimension)) return '主世界';
  return String(dimension || '未知维度');
}

// 造一个 Vec3：不能 import vec3，就借 bot 自己的位置对象。
function makeVec(ctx, x, y, z) {
  const base = botOf(ctx).entity.position;
  const VecClass = base && base.constructor;
  if (typeof VecClass === 'function') {
    try {
      return new VecClass(Number(x), Number(y), Number(z));
    } catch {
      // 构造失败就退回普通对象
    }
  }
  return { x: Number(x), y: Number(y), z: Number(z) };
}

function blockAt(ctx, x, y, z) {
  try {
    return botOf(ctx).blockAt(makeVec(ctx, x, y, z));
  } catch {
    return null;
  }
}

// 方块中文名：先用本模块的表，再退到 ctx.blockLabel。
function label(ctx, name) {
  if (!name) return '未知方块';
  const key = String(name);
  if (BLOCK_LABELS[key]) return BLOCK_LABELS[key];
  if (typeof ctx.blockLabel === 'function') {
    try {
      const text = ctx.blockLabel(key);
      if (text) return String(text);
    } catch {
      // 拿不到标签就用方块 id
    }
  }
  return key;
}

// ------------------------------------------------------------------ 建门

// 找脚下能站人、且够高的地面高度；返回 null 表示这格不合适。
function findGroundLevel(ctx, x, z, nearY) {
  const start = Math.floor(Number(nearY) || 0);
  for (let y = start + 2; y >= start - 4; y -= 1) {
    const ground = blockAt(ctx, x, y, z);
    if (!ground || ground.boundingBox !== 'block') continue;
    if (isLavaName(ground.name)) continue;
    // 门框要 5 格高：底排 1 格 + 门内 3 格 + 顶部四角 1 格。多留的那一格是给服务端
    // 点火检查用的，天花板压太低的门框点不燃。
    let free = true;
    for (let dy = 1; dy <= PORTAL_INTERIOR_HEIGHT + 1; dy += 1) {
      const above = blockAt(ctx, x, y + dy, z);
      if (above && above.boundingBox !== 'empty') {
        free = false;
        break;
      }
    }
    if (free) return y;
  }
  return null;
}

// 门框底排下面必须是实地，不能悬空也不能是岩浆。
function frameGroundOk(ctx, frame) {
  for (const target of frame.bottom) {
    const ground = blockAt(ctx, target.x, target.y - 1, target.z);
    if (!ground || ground.boundingBox !== 'block') return false;
    if (isLavaName(ground.name)) return false;
  }
  return true;
}

function portalNeighbors(frame, target) {
  return [-1, 1].map(d => ({
    x: target.x + (frame.axis === 'z' ? d : 0), y: target.y,
    z: target.z + (frame.axis === 'x' ? d : 0),
  }));
}

function portalWater(block) {
  return block?.name === 'water' || block?.name === 'bubble_column' || block?.getProperties?.().waterlogged === true;
}

function dryPortalSite(ctx, frame) {
  return frame.interior.every(p => [p, ...portalNeighbors(frame, p)].every(q => {
    const block = blockAt(ctx, q.x, q.y, q.z);
    return block && !portalWater(block) && !isLavaName(block.name);
  }));
}

// 选建门位置：bot 前方 2 格，门宽轴与朝向垂直。
function choosePortalSite(ctx, axis, depthOffset = 2) {
  const bot = botOf(ctx);
  const base = bot.entity.position;
  const heading = facingFromYaw(bot.entity.yaw);
  // 深度方向：门宽轴的垂直方向，也就是 bot 朝向在深度轴上的投影。
  const frontX = axis === 'z' ? Math.sign(heading.x) || 1 : 0;
  const frontZ = axis === 'x' ? Math.sign(heading.z) || 1 : 0;

  const candidates = [depthOffset, depthOffset + 1, depthOffset - 1, depthOffset + 2,
    -depthOffset, -depthOffset - 1, -depthOffset - 2, depthOffset + 3, -depthOffset - 3];
  for (const offset of candidates) {
    const depthX = Math.floor(base.x + frontX * offset);
    const depthZ = Math.floor(base.z + frontZ * offset);
    const groundY = findGroundLevel(ctx, depthX, depthZ, base.y);
    if (groundY === null) continue;
    const origin =
      axis === 'x'
        ? { x: Math.floor(base.x), y: groundY + 1, z: depthZ }
        : { x: depthX, y: groundY + 1, z: Math.floor(base.z) };
    const frame = portalFrame(origin, axis);
    if (!frame) continue;
    if (!frameGroundOk(ctx, frame) || !dryPortalSite(ctx, frame)) continue;
    return { origin, axis, groundY, frame };
  }
  return null;
}

// 旧门框进水时，先封住两侧入水口，再填掉门内水源和流动水。
async function drainPortal(ctx, frame) {
  const wet = frame.interior.filter(p => portalWater(blockAt(ctx, p.x, p.y, p.z)));
  if (!wet.length) return;
  const plug = async p => {
    throwIfInterrupted(ctx, '下界门排水');
    const material = ['cobblestone', 'cobbled_deepslate', 'dirt', 'andesite', 'diorite', 'granite', 'netherrack']
      .find(name => ctx.countItem(name) > 0);
    if (!material) throw new Error('下界门排水需要垫块');
    await ctx.placeBlock({block: material, ...p});
  };
  for (const p of frame.interior.flatMap(target => portalNeighbors(frame, target))) {
    const face = blockAt(ctx, p.x, p.y, p.z);
    if (!face || isLavaName(face.name)) throw new Error('下界门旁有岩浆或未知方块，无法安全排水');
    if (portalWater(face)) await plug(p);
  }
  // 上层的源方块也可能向下补水，全部填完后再统一清空。
  for (const p of frame.interior) {
    if (portalWater(blockAt(ctx, p.x, p.y, p.z))) await plug(p);
  }
  await clearPortalSpace(ctx, frame);
  await sleepMs(ctx, 500);
  if (frame.interior.some(p => portalWater(blockAt(ctx, p.x, p.y, p.z)))) throw new Error('下界门内仍有水');
}

// 清出门内 2×3 与门框位置的空间。
async function clearPortalSpace(ctx, frame) {
  let cleared = 0;
  const targets = [...frame.interior, ...frame.frame];
  for (const target of targets) {
    throwIfInterrupted(ctx, 'Building nether portal');
    const block = blockAt(ctx, target.x, target.y, target.z);
    if (!block) continue;
    if (block.name === 'obsidian') continue;
    if (block.boundingBox === 'empty') continue;
    try {
      await ctx.breakBlock({ x: target.x, y: target.y, z: target.z });
      cleared += 1;
    } catch (error) {
      throwIfInterrupted(ctx, '清理下界门空间');
      throw new Error(
        `附近清不出门框空间：${error.message}；没有钻石镐的话黑曜石挖不动，先去挖黑曜石`
      );
    }
  }
  return cleared;
}

// 摆黑曜石门框：先底排，再两侧，每块都有可以依附的邻居。
async function placeObsidianFrame(ctx, frame) {
  let placed = 0;
  for (const target of frame.frame) {
    throwIfInterrupted(ctx, 'Building nether portal');
    const block = blockAt(ctx, target.x, target.y, target.z);
    if (block && block.name === 'obsidian') {
      placed += 1;
      continue;
    }
    // 两根侧柱和顶梁的第一块都需要相邻的支撑面；底梁与侧柱只在对角相接。
    const corner = target === frame.sides[0] ? frame.bottom[0]
      : target === frame.sides[1] ? frame.bottom.at(-1)
      : target === frame.top[1] ? frame.top[0] : null;
    if (corner) {
      const support = blockAt(ctx, corner.x, corner.y, corner.z);
      if (support?.boundingBox !== 'block') {
        const material = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'granite', 'andesite', 'diorite', 'stone']
          .find(name => ctx.countItem(name) > 0);
        if (!material) throw new Error('下界门需要一个垫角方块');
        await ctx.placeBlock({ block: material, ...corner });
      }
    }
    try {
      await ctx.placeBlock({ block: 'obsidian', x: target.x, y: target.y, z: target.z });
      placed += 1;
    } catch (error) {
      throwIfInterrupted(ctx, '摆放下界门框架');
      throw new Error(`门框摆不上去：${error.message}；附近没有可以依附的方块`);
    }
  }
  return placed;
}

// 门内有没有出现下界门。
function portalLit(ctx, frame) {
  for (const target of frame.interior) {
    const block = blockAt(ctx, target.x, target.y, target.z);
    if (block && block.name === 'nether_portal') return true;
  }
  return false;
}

// 用打火石点火：瞄准门框底部的黑曜石，服务端会在附近生成下界门。
async function lightPortal(ctx, frame) {
  const bot = botOf(ctx);
  const steel = bot.inventory.items().find((item) => item.name === 'flint_and_steel');
  if (!steel) throw new Error('没有打火石，黑曜石摆好了也点不燃下界门');
  await bot.equip(steel, 'hand');

  for (const target of frame.bottom.slice(1, -1)) {
    throwIfInterrupted(ctx, 'Lighting nether portal');
    try {
      const base = blockAt(ctx, target.x, target.y, target.z);
      if (base?.name !== 'obsidian') continue;
      if (bot.entity.position.distanceTo(base.position) > 4.5) await ctx.travelTo(target.x, target.y + 1, target.z, 2);
      throwIfInterrupted(ctx, '点燃下界门');
      await bot.equip(steel, 'hand');
      await bot.activateBlock(base, makeVec(ctx, 0, 1, 0));
    } catch (error) {
      throwIfInterrupted(ctx, '点燃下界门');
      log(ctx, '点火动作失败，换一个瞄准点', error.message);
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      throwIfInterrupted(ctx, 'Lighting nether portal');
      if (portalLit(ctx, frame)) return true;
      await sleepMs(ctx, 250);
    }
  }
  return false;
}

// 建下界门并点火。
async function makeNetherPortal(args, ctx) {
  throwIfInterrupted(ctx, 'Building nether portal');
  const dimension = currentDimension(ctx);
  if (isNetherDimension(dimension)) {
    throw new Error('已经在下界里了，下界门只能在主世界点燃');
  }
  if (isEndDimension(dimension)) {
    throw new Error(`当前在${dimensionLabel(dimension)}，没有可以建下界门的地方`);
  }

  const wantSecond = Boolean(args.second);
  const saved = args.resume_site;
  const have = ctx.countItem('obsidian');
  let need = PORTAL_FRAME_OBSIDIAN * (wantSecond ? 2 : 1);
  if (!saved && have < need) {
    throw new Error(`还差 ${need - have} 个黑曜石，造下界门需要 ${need} 个`);
  }
  if (ctx.countItem('flint_and_steel') <= 0) {
    throw new Error('没有打火石，黑曜石摆好了也点不燃下界门');
  }

  // 门宽轴：默认与朝向垂直，让 bot 能正面穿过去。
  const heading = facingFromYaw(botOf(ctx).entity.yaw);
  const asked = String(args.facing || '').toLowerCase();
  const axis =
    asked === 'x' || asked === 'z'
      ? asked
      : Math.abs(heading.x) >= Math.abs(heading.z)
        ? 'z'
        : 'x';

  let site;
  if (saved) {
    const origin = saved.origin;
    if (wantSecond || saved.dimension !== OVERWORLD_DIMENSION || !['x', 'z'].includes(saved.axis)
        || !origin || !['x','y','z'].every(a => Number.isSafeInteger(origin[a]))
        || botOf(ctx).entity.position.distanceTo(makeVec(ctx, origin.x, origin.y, origin.z)) > 16) {
      throw new Error('无法在当前位置核对已记录的下界门址');
    }
    site = {origin, axis: saved.axis, frame: portalFrame(origin, saved.axis)};
  } else {
    site = choosePortalSite(ctx, axis, 2);
    if (!site && !['x', 'z'].includes(asked)) site = choosePortalSite(ctx, axis === 'x' ? 'z' : 'x', 2);
    if (!site) {
      const p = botOf(ctx).entity.position;
      throw withActionData(new Error('附近没有足够大的空地放下下界门框'), {
        portal_search: {outcome: 'no_site_before_build', position: {x: p.x, y: p.y, z: p.z}},
      });
    }
  }
  const frameBlocks = site.frame.frame.map(p => blockAt(ctx, p.x, p.y, p.z));
  if (frameBlocks.some(b => !b) || !frameGroundOk(ctx, site.frame)) throw new Error('门址的方块或地基无法确认');
  if (saved) {
    need = frameBlocks.filter(b => b.name !== 'obsidian').length;
    if (have < need) throw new Error(`旧门框还需 ${need} 块黑曜石，背包只有 ${have} 块`);
  }
  if (!wantSecond) {
    ctx.reportProgress?.('portal_site', '已确认下界门址', 0, {
      portal_site: {dimension, origin: site.origin, axis: site.axis},
    });
  }
  const alreadyLit = portalLit(ctx, site.frame);
  const cleared = alreadyLit ? 0 : await clearPortalSpace(ctx, site.frame);
  const placed = alreadyLit ? PORTAL_FRAME_OBSIDIAN : await placeObsidianFrame(ctx, site.frame);

  if (!portalLit(ctx, site.frame)) {
    await drainPortal(ctx, site.frame);
    const lit = await lightPortal(ctx, site.frame);
    if (!lit) {
      throw new Error('打火石点了火，但门框里没有出现下界门，附近没有生成门');
    }
  }
  throwIfInterrupted(ctx, 'Building nether portal');

  const observedPortal = findNearbyPortal(ctx, 8);
  moduleState.portalTransition = observedPortal
    ? {
        source: {
          dimension: currentDimension(ctx),
          position: {
            x: Math.floor(Number(observedPortal.x)),
            y: Math.floor(Number(observedPortal.y)),
            z: Math.floor(Number(observedPortal.z)),
          },
          observed: 'nether_portal_block',
        },
        target: null,
      }
    : null;

  const parts = [
    `下界门已建好并点燃，位置 (${site.origin.x}, ${site.origin.y}, ${site.origin.z})`,
    `门框 ${placed} 个黑曜石，清掉 ${cleared} 格障碍`,
  ];

  // 往返用的第二个门。
  if (wantSecond) {
    const second = choosePortalSite(ctx, axis, 9);
    if (!second) throw new Error('首座下界门已经建成，附近没有足够空间放置第二座');
    const secondCleared = await clearPortalSpace(ctx, second.frame);
    const secondPlaced = await placeObsidianFrame(ctx, second.frame);
    if (!portalLit(ctx, second.frame)) {
      const lit = await lightPortal(ctx, second.frame);
      if (!lit) {
        throw new Error(
          `第二个门点不着火：门框 ${secondPlaced} 个黑曜石清掉 ${secondCleared} 格，附近没有生成门`
        );
      }
    }
    throwIfInterrupted(ctx, 'Building nether portal');
    parts.push(
      `返程门也建好了，位置 (${second.origin.x}, ${second.origin.y}, ${second.origin.z})，` +
        `门框 ${secondPlaced} 个黑曜石`
    );
  }

  return {
    detail: parts.join('，'),
    status: 'succeeded',
    data: { portal_transition: portalTransitionData() },
  };
}

// ------------------------------------------------------------------ 维度换算

// 找附近的下界门。
function findNearbyPortal(ctx, radius) {
  const candidates = new Map();
  if (typeof ctx.nearbyBlock === 'function') {
    const block = ctx.nearbyBlock('nether_portal', radius);
    if (block && block.position) {
      const key = positionKey(block.position);
      if (key) candidates.set(key, block.position);
    }
  }
  const bot = botOf(ctx);
  const registry = bot.registry && bot.registry.blocksByName;
  const entry = registry && registry['nether_portal'];
  if (entry && typeof bot.findBlocks === 'function') {
    try {
      const positions = bot.findBlocks({
        matching: entry.id,
        maxDistance: radius,
        count: 16,
      });
      for (const position of positions || []) {
        const key = positionKey(position);
        if (key) candidates.set(key, position);
      }
    } catch {
      // 加载中的区块不可读时按没有找到门处理。
    }
  }
  for (const position of candidates.values()) {
    const fresh = readFreshPortalBlock(ctx, position);
    if (fresh) return fresh;
  }
  return null;
}

function positionKey(position) {
  if (!position || typeof position !== 'object') return '';
  const coordinates = [];
  for (const axis of 'xyz') {
    const value = Number(position[axis]);
    if (!Number.isFinite(value)) return '';
    coordinates.push(Math.floor(value));
  }
  return coordinates.join(',');
}

function readFreshPortalBlock(ctx, position) {
  const key = positionKey(position);
  const bot = botOf(ctx);
  if (!key || typeof bot.blockAt !== 'function') return null;
  const [x, y, z] = key.split(',').map(Number);
  const base = bot.entity && bot.entity.position;
  const Vector = base && base.constructor;
  let vector = { x, y, z };
  if (typeof Vector === 'function' && Vector !== Object) {
    try {
      vector = new Vector(x, y, z);
    } catch {
      vector = { x, y, z };
    }
  }
  const block = bot.blockAt(vector);
  if (!block || block.name !== 'nether_portal') return null;
  const actualPosition = block.position || { x, y, z };
  return { x: Math.floor(Number(actualPosition.x)), y: Math.floor(Number(actualPosition.y)), z: Math.floor(Number(actualPosition.z)) };
}

function portalHint(value) {
  if (!value || typeof value !== 'object') return null;
  const readAnchor = (anchor, observed) => {
    if (!anchor || typeof anchor !== 'object') return null;
    const dimension = canonicalDimension(anchor.dimension);
    if (![OVERWORLD_DIMENSION, NETHER_DIMENSION].includes(dimension) || anchor.observed !== observed) return null;
    const key = positionKey(anchor.position);
    if (!key) return null;
    const [x, y, z] = key.split(',').map(Number);
    return { dimension, position: { x, y, z }, observed };
  };
  const source = readAnchor(value.source, 'nether_portal_block');
  const target = readAnchor(value.target, 'arrival_checkpoint');
  if (!source || !target || source.dimension === target.dimension) return null;
  return { source, target };
}

// 缓存点只用于回到该维度附近；是否有门必须重新读取方块。
async function findPortalNearRecordedAnchor(ctx, radius, dimension, restoredHint = null) {
  const transitions = [portalHint(restoredHint), portalHint(moduleState.portalTransition)].filter(Boolean);
  const anchors = transitions.flatMap((transition) => [transition.target, transition.source]).filter(
    (anchor) => anchor.dimension === dimension && anchor.position,
  );
  for (const anchor of anchors) {
    throwIfInterrupted(ctx, '寻找下界门');
    try {
      const position = botOf(ctx).entity.position;
      const distance = Math.hypot(
        anchor.position.x - position.x,
        anchor.position.z - position.z,
      );
      if (distance > 3) {
        if (typeof ctx.travelTo !== 'function') continue;
        await ctx.travelTo(anchor.position.x, anchor.position.y, anchor.position.z, 3);
      }
      throwIfInterrupted(ctx, '寻找下界门');
      if (currentDimension(ctx) !== dimension) {
        throw new Error('移动到已记录锚点时维度发生变化，停止寻找下界门');
      }
      const portal = findNearbyPortal(ctx, radius);
      if (portal) return portal;
      log(ctx, '已到达记录锚点，但附近重新扫描没有发现下界门');
    } catch (error) {
      throwIfInterrupted(ctx, '寻找下界门');
      if (currentDimension(ctx) !== dimension) throw error;
      log(ctx, '回到记录锚点失败', error.message);
    }
  }
  return null;
}

// 等维度变化。
async function waitDimension(ctx, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfInterrupted(ctx, '等待维度切换');
    if (currentDimension(ctx) === expected) return true;
    await sleepMs(ctx, 250);
  }
  return currentDimension(ctx) === expected;
}

// 走进下界门。
async function enterPortal(ctx, portal, expectedDimension, timeoutMs) {
  throwIfInterrupted(ctx, '穿过下界门');
  const sourceDimension = currentDimension(ctx);
  let floorY = portal.y;
  while (floorY > portal.y - 21 && blockAt(ctx, portal.x, floorY - 1, portal.z)?.name === 'nether_portal') floorY--;
  try {
    await ctx.travelTo(portal.x, floorY, portal.z, 1);
  } catch (error) {
    throwIfInterrupted(ctx, '穿过下界门');
    log(ctx, '没走到下界门', error.message);
  }
  // 再往门里挤一挤，必要时多试几次。
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfInterrupted(ctx, '穿过下界门');
    if (isExpectedDimension(ctx, expectedDimension)) return true;
    const beforeWalkDimension = currentDimension(ctx);
    if (beforeWalkDimension !== sourceDimension) {
      throw new Error(
        '没有走进下界门所连的预期维度，实际到达了非预期维度 ' + beforeWalkDimension +
          '，预期 ' + expectedDimension + '；停止重复穿门动作',
      );
    }
    try {
      const at = botOf(ctx).entity.position;
      if (blockAt(ctx, Math.floor(at.x), Math.floor(at.y), Math.floor(at.z))?.name !== 'nether_portal') {
        await ctx.walkOnce(portal.x, floorY, portal.z, 0, 4000);
      }
    } catch (error) {
      throwIfInterrupted(ctx, '穿过下界门');
      log(ctx, '进门动作失败', error.message);
    }
    if (isExpectedDimension(ctx, expectedDimension)) return true;
    const afterWalkDimension = currentDimension(ctx);
    if (afterWalkDimension !== sourceDimension) {
      throw new Error(
        '没有走进下界门所连的预期维度，实际到达了非预期维度 ' + afterWalkDimension +
          '，预期 ' + expectedDimension + '；停止重复穿门动作',
      );
    }
    await sleepMs(ctx, 400);
  }
  return isExpectedDimension(ctx, expectedDimension);
}

// 下界坐标换算与过门。
async function netherTravel(args, ctx) {
  throwIfInterrupted(ctx, '穿过下界门');
  const bot = botOf(ctx);
  const dimension = currentDimension(ctx);
  const mode = String(args.mode || 'auto').toLowerCase();
  const radius = clampNumber(args.radius, DEFAULT_PORTAL_RADIUS, 4, 64);
  const timeoutMs = clampNumber(args.timeout_s, 60, 5, 300) * 1000;

  const position = bot.entity.position;
  const here = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
  const toNether = netherScale(here.x, here.z);
  const toOverworld = overworldScale(here.x, here.z);

  // 明确指定目标坐标时，换算的是那个目标。
  const hasTarget = [args.x, args.z].every((value) => Number.isFinite(Number(value)));
  const targetX = hasTarget ? Math.floor(Number(args.x)) : here.x;
  const targetZ = hasTarget ? Math.floor(Number(args.z)) : here.z;
  const targetY = Number.isFinite(Number(args.y)) ? Math.floor(Number(args.y)) : here.y;
  const targetNether = netherScale(targetX, targetZ);
  const targetOverworld = overworldScale(targetX, targetZ);

  let wanted = mode;
  if (wanted === 'auto') {
    wanted = isNetherDimension(dimension) ? 'exit' : 'enter';
  }
  if (!['convert', 'enter', 'exit', 'auto'].includes(wanted)) {
    throw new Error(`不会的换算方式 ${wanted}，只能用 convert、enter、exit`);
  }

  if (wanted === 'convert') {
    return {
      detail:
        `当前在${dimensionLabel(dimension)} (${here.x}, ${here.y}, ${here.z})：` +
        `主世界 (${targetX}, ${targetY}, ${targetZ}) 对应下界 (${targetNether.x}, ${targetZ}, ${targetNether.z})，` +
        `下界 (${targetNether.x}, ${targetZ}, ${targetNether.z}) 反算回主世界是 (${targetOverworld.x}, ${targetZ}, ${targetOverworld.z})` +
        `；当前位置换算下界是 (${toNether.x}, ${toNether.z})，换回主世界是 (${toOverworld.x}, ${toOverworld.z})`,
      status: 'succeeded',
      checkpoint: checkpointInfo(position, dimension),
    };
  }

  if (dimension !== OVERWORLD_DIMENSION && dimension !== NETHER_DIMENSION) {
    throw new Error(`当前维度 ${dimension || '未知'} 不是可验证的原版主世界或下界，停止过门`);
  }

  // 过门：先确认当前维度对不对。
  if (wanted === 'enter' && isNetherDimension(dimension)) {
    throw new Error('已经在下界里了，要回主世界请用 exit');
  }
  if (wanted === 'exit' && !isNetherDimension(dimension)) {
    throw new Error('当前不在下界，附近没有下界门可以回去');
  }
  if (!dimension) {
    throw new Error('读不到当前维度，无法安全穿过下界门');
  }

  let portal = findNearbyPortal(ctx, radius);
  if (!portal) portal = await findPortalNearRecordedAnchor(ctx, radius, dimension, args.portal_hint);
  if (!portal) {
    throw new Error(`附近 ${radius} 格内没有下界门，先建好门再过`);
  }
  const sourceAnchor = {
    dimension,
    position: {
      x: Math.floor(Number(portal.x)),
      y: Math.floor(Number(portal.y)),
      z: Math.floor(Number(portal.z)),
    },
    observed: 'nether_portal_block',
  };
  moduleState.portalTransition = { source: sourceAnchor, target: null };

  const expectedDimension = wanted === 'enter' ? NETHER_DIMENSION : OVERWORLD_DIMENSION;
  let passed;
  try {
    passed = await enterPortal(ctx, portal, expectedDimension, timeoutMs);
  } catch (error) {
    throw withActionData(error, {
      portal_transition: portalTransitionData({ source: sourceAnchor, target: null }),
      observed_dimension: currentDimension(ctx),
    });
  }
  if (!passed) {
    throw withActionData(new Error(
      `没有走进下界门，附近 (${portal.x}, ${portal.y}, ${portal.z}) 的门没有把维度切过去`
    ), {
      portal_transition: portalTransitionData({ source: sourceAnchor, target: null }),
      observed_dimension: currentDimension(ctx),
    });
  }

  const arrived = currentDimension(ctx);
  const checkpoint = checkpointInfo(bot.entity.position, arrived);
  const targetAnchor = {
    dimension: arrived,
    position: {
      x: Math.floor(Number(bot.entity.position.x)),
      y: Math.floor(Number(bot.entity.position.y)),
      z: Math.floor(Number(bot.entity.position.z)),
    },
    observed: 'arrival_checkpoint',
  };
  moduleState.portalTransition = { source: sourceAnchor, target: targetAnchor };
  const netherPart = checkpoint
    ? `下界 (${checkpoint.nether.x}, ${checkpoint.position.y}, ${checkpoint.nether.z})`
    : '下界坐标未知';
  const overworldPart = checkpoint
    ? `主世界 (${checkpoint.overworld.x}, ${checkpoint.position.y}, ${checkpoint.overworld.z})`
    : '主世界坐标未知';

  return {
    detail:
      `已经穿过下界门，现在在${dimensionLabel(arrived)} ` +
      `(${Math.floor(bot.entity.position.x)}, ${Math.floor(bot.entity.position.y)}, ${Math.floor(bot.entity.position.z)})；` +
      `对应${netherPart}，对应${overworldPart}`,
    status: 'succeeded',
    checkpoint,
    data: {
      checkpoint,
      portal_transition: portalTransitionData(),
    },
  };
}

// ------------------------------------------------------------------ 堡垒探索

// 找附近的烈焰人实体。
function findBlaze(ctx, radius) {
  const bot = botOf(ctx);
  const origin = bot.entity.position;
  const entities = bot.entities ? Object.values(bot.entities) : [];
  const found = entities
    .filter(
      (entity) =>
        entity &&
        entity.position &&
        isFortressEntity(entity.name) &&
        entity.position.distanceTo(origin) <= radius
    )
    .sort((left, right) => left.position.distanceTo(origin) - right.position.distanceTo(origin));
  return found.length > 0 ? found[0] : null;
}

// 找附近的堡垒结构方块。
function findFortressStructure(ctx, radius) {
  const bot = botOf(ctx);
  const registry = bot.registry && bot.registry.blocksByName;
  if (!registry || typeof bot.findBlocks !== 'function') return null;
  const origin = bot.entity.position;
  const names = [...FORTRESS_STRUCTURE_BLOCKS].filter(name => registry[name]);
  if (!names.length) return null;
  const ids = names.map(name => registry[name].id);
  const positions = bot.findBlocks({ matching: ids.length === 1 ? ids[0] : ids, maxDistance: radius, count: 8 });
  let best = null;
  let bestDistance = Infinity;
  for (const spot of positions) {
    const name = names.length === 1 ? names[0] : bot.blockAt(spot, false)?.name;
    const distance = Math.hypot(spot.x - origin.x, spot.y - origin.y, spot.z - origin.z);
    if (FORTRESS_STRUCTURE_BLOCKS.has(name) && distance < bestDistance) {
      bestDistance = distance;
      best = { x: spot.x, y: spot.y, z: spot.z, name };
    }
  }
  return best;
}

function isLiveFortressStructure(ctx, record) {
  if (!record || record.dimension !== currentDimension(ctx)) return false;
  const block = blockAt(
    ctx,
    record.position.x,
    record.position.y,
    record.position.z,
  );
  return Boolean(block && block.name === record.block && FORTRESS_STRUCTURE_BLOCKS.has(block.name));
}

function fortressStructureKey(record) {
  return record.dimension + ':' + record.position.x + ',' + record.position.y + ',' + record.position.z;
}

function rememberFortressStructure(ctx, structure, evidence) {
  if (!structure) return null;
  const record = {
    dimension: currentDimension(ctx),
    block: structure.name,
    position: {
      x: Math.floor(Number(structure.x)),
      y: Math.floor(Number(structure.y)),
      z: Math.floor(Number(structure.z)),
    },
  };
  const key = fortressStructureKey(record);
  const previous = moduleState.structures.findIndex((entry) => fortressStructureKey(entry) === key);
  if (previous < 0) {
    moduleState.structures.push(record);
    if (moduleState.structures.length > 32) moduleState.structures.shift();
  } else {
    moduleState.structures[previous] = record;
  }
  if (evidence) evidence.set(key, record);
  return record;
}

function fortressEvidenceData(dimension, evidence, route = null) {
  const data = {
    dimension,
    observed_blocks: [...evidence.values()].map((entry) => ({
      dimension: entry.dimension,
      block: entry.block,
      position: { ...entry.position },
    })),
  };
  if (route) {
    data.route = {
      origin: { ...route.origin },
      scan_radius: route.scanRadius,
      waypoint_spacing: FORTRESS_ROUTE_SPACING,
      route_budget_waypoints: route.budgetWaypoints,
      attempted_waypoints: route.attemptedWaypoints,
      dimension: route.dimension,
      ...(route.confirmed?.length ? { visited: route.confirmed.slice(-24) } : {}),
      ...(route.walkMisses?.length ? { walk_misses: route.walkMisses.slice(-16) } : {}),
    };
  }
  return data;
}

// 请战斗模块打烈焰人。ctx 没有技能入口时返回 null。
async function callCombatEntry(ctx, options) {
  const attempts = [];
  if (typeof ctx.runSkill === 'function') {
    attempts.push(() => ctx.runSkill('fight_blaze', options));
  }
  const registry = ctx.skills;
  if (registry && registry.fight_blaze && typeof registry.fight_blaze.handler === 'function') {
    attempts.push(() => registry.fight_blaze.handler(options, ctx));
  }
  if (typeof ctx.fightBlaze === 'function') {
    attempts.push(() => ctx.fightBlaze(options, ctx));
  }
  for (const attempt of attempts) {
    // 战斗模块自己的错误信息已经带「还差」「没有」，直接透传。
    const outcome = await attempt();
    if (outcome) return outcome;
  }
  return null;
}

// 探索路线围绕本次调用的固定原点生成，radius 只用于每个位置的扫描。
function makeFortressRoute(position, dimension, scanRadius) {
  const origin = {
    x: Math.floor(Number(position.x)),
    y: Math.floor(Number(position.y)),
    z: Math.floor(Number(position.z)),
  };
  const waypoints = [];
  let x = 0;
  let z = 0;
  let dx = 1;
  let dz = 0;
  let segmentLength = 1;
  while (waypoints.length < FORTRESS_ROUTE_BUDGET_WAYPOINTS) {
    for (let segment = 0; segment < 2 && waypoints.length < FORTRESS_ROUTE_BUDGET_WAYPOINTS; segment += 1) {
      for (let step = 0; step < segmentLength && waypoints.length < FORTRESS_ROUTE_BUDGET_WAYPOINTS; step += 1) {
        x += dx;
        z += dz;
        waypoints.push({
          x: origin.x + x * FORTRESS_ROUTE_SPACING,
          y: origin.y,
          z: origin.z + z * FORTRESS_ROUTE_SPACING,
        });
      }
      const nextX = -dz;
      dz = dx;
      dx = nextX;
    }
    segmentLength += 1;
  }
  return {
    origin,
    dimension,
    scanRadius,
    budgetWaypoints: FORTRESS_ROUTE_BUDGET_WAYPOINTS,
    attemptedWaypoints: 0,
    nextWaypoint: 0,
    waypoints,
  };
}

function nextSurveyPoint(ctx, route) {
  const bot = botOf(ctx), here = bot.entity.position.floored();
  const candidates = [];
  for (const [dx, dz] of [[1,0],[0,1],[-1,0],[0,-1],[0.7,0.7],[-0.7,0.7],[0.7,-0.7],[-0.7,-0.7]]) {
    for (const distance of [24, 14, 8, 5]) {
      const p = here.offset(Math.round(dx * distance), 0, Math.round(dz * distance));
      for (const dy of [0,1,-1,2,-2,3,-3,4,-4,5,-5,6,-6,8,-8,10,-10,12,-12]) {
        const stand = p.offset(0, dy, 0);
        if (!dryMiningFooting(bot, stand) || netherRouteExclusion(bot, {position: stand}) || besideDrop(bot, stand)) continue;
        if (route.walkMisses.some(m => Math.hypot(here.x - m.from.x, here.y - m.from.y, here.z - m.from.z) <= 4
            && Math.hypot(stand.x - m.to.x, stand.y - m.to.y, stand.z - m.to.z) <= 2)) continue;
        const clearance = Math.min(...route.surveyed.map(v => Math.hypot(v.x - stand.x, v.z - stand.z)));
        if (clearance >= 4) candidates.push({stand, clearance});
        break;
      }
    }
  }
  candidates.sort((a, b) => b.clearance - a.clearance);
  return candidates[0]?.stand;
}

// 路标走不通时，从脚下按可步行的相邻列向外搜，把崖壁另一侧的孤立平台排除。
export async function connectedSurvey(ctx, route) {
  const {here, points, parents} = await reachableNetherGround(ctx);
  const candidates = [];
  for (const p of points) {
    if (route.walkMisses.some(m => here.distanceTo(m.from) < 4 && p.distanceTo(m.to) < 2)) continue;
    const clearance = Math.min(...route.surveyed.map(v => Math.hypot(p.x - v.x, p.z - v.z)));
    const outward = route.anchor ? Math.hypot(p.x - route.anchor.x, p.z - route.anchor.z)
      - Math.hypot(here.x - route.anchor.x, here.z - route.anchor.z) : 0;
    if (clearance >= 4) candidates.push({p, clearance, score: clearance + 1.2 * outward});
    else candidates.push({p, clearance, score: clearance - 40});
  }
  candidates.sort((a, b) => b.score - a.score);
  return {parents, target: candidates[0]?.clearance >= 4 ? candidates[0].p : null,
    launches: [here, ...candidates.slice(0, 24).map(c => c.p)]};
}

async function walkSurveyRoute(ctx, route, reachable, target) {
  const from = botOf(ctx).entity.position.floored();
  const outcome = route.followCells && reachable
    ? await followNetherPath(ctx, reachable.parents, target)
    : await ctx.walkOnce(target.x, target.y, target.z, 0, 12000);
  throwIfInterrupted(ctx, '探索下界堡垒');
  if (outcome === 'reached' && botOf(ctx).entity.position.floored().equals(target)) {
    route.walkFailures = 0;
    return true;
  }
  route.walkMisses.push({from, to: {x: target.x, y: target.y, z: target.z}});
  route.walkFailures++;
  route.followCells = Boolean(reachable);
  return false;
}

async function fallbackStep(ctx, route) {
  throwIfInterrupted(ctx, '探索下界堡垒');
  if (currentDimension(ctx) !== route.dimension) {
    throw new Error('探索路线维度变化，停止继续移动');
  }
  if (route.attemptedWaypoints >= route.budgetWaypoints || route.nextWaypoint >= route.waypoints.length) {
    return false;
  }
  const reachable = route.connected ? await connectedSurvey(ctx, route) : null;
  const target = reachable ? reachable.target : route.surveyed ? nextSurveyPoint(ctx, route) : route.waypoints[route.nextWaypoint];
  if (route.surveyed && (!target || route.walkFailures >= 2) && ctx.runSkill && route.passageFailures < 2) {
    const bot = botOf(ctx);
    const passages = (reachable?.launches ?? [bot.entity.position.floored()]).map(start => surveyPassage(bot, route, start))
      .filter(Boolean).sort((a, b) => b.clearance - a.clearance);
    const passage = passages[0];
    if (passage) {
      route.attemptedWaypoints++;
      // 成功抵达后可在剩余路标预算内继续向外；打不开的岩壁本轮只试一次。
      route.triedPassages.add(`${positionKey(passage.start)}:${passage.direction}`);
      route.passageFailures++;
      try {
        if (!bot.entity.position.floored().equals(passage.start)) {
          if (!await walkSurveyRoute(ctx, route, reachable, passage.start)) return false;
        }
        await ctx.runSkill('strip_mine', { direction: passage.direction, length: 6, branches: 0, torchInterval: 0 });
      } catch (error) {
        throwIfInterrupted(ctx, '探索下界堡垒');
        log(ctx, '短通道停止', error.message);
        return false;
      }
      throwIfInterrupted(ctx, '探索下界堡垒');
      const p = botOf(ctx).entity.position;
      if (Math.hypot(p.x - passage.end.x - 0.5, p.z - passage.end.z - 0.5) <= 1.5) {
        route.confirmed.push({x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z)});
        route.surveyed.push(route.confirmed.at(-1));
        route.passageFailures = 0;
        route.walkFailures = 0;
        return true;
      }
    }
  }
  if (!target) {
    route.exhausted = true;
    return false;
  }
  route.nextWaypoint += 1;
  route.attemptedWaypoints += 1;
  try {
    if (route.surveyed) {
      if (!await walkSurveyRoute(ctx, route, reachable, target)) return false;
      const p = botOf(ctx).entity.position;
      route.confirmed.push({x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z)});
      route.surveyed.push(route.confirmed.at(-1));
      ctx.reportProgress?.('fortress_survey', '已到新落脚点，继续扫描堡垒', null, {position: route.confirmed.at(-1)});
    } else {
      await ctx.travelTo(target.x, target.y, target.z, 3);
    }
    throwIfInterrupted(ctx, '探索下界堡垒');
    if (currentDimension(ctx) !== route.dimension) {
      throw new Error('探索路线移动后维度发生变化，停止继续移动');
    }
    return true;
  } catch (error) {
    throwIfInterrupted(ctx, '探索下界堡垒');
    log(ctx, '外扩搜索走不动', error.message);
    return false;
  }
}

// 普通寻路被围住时，只开掘已加载、下方有支撑且侧面没有岩浆的短通道。
const PASSAGE_ROCK = new Set(['netherrack', 'blackstone', 'basalt', 'smooth_basalt', 'nether_quartz_ore', 'nether_gold_ore']);
export function surveyPassage(bot, route, start = bot.entity.position.floored()) {
  const choices = [];
  const cubes = Object.values(bot.entities || {}).filter(e => e?.name === 'magma_cube');
  for (const [direction, dx, dz] of [['east', 1, 0], ['west', -1, 0], ['south', 0, 1], ['north', 0, -1]]) {
    if (route.triedPassages?.has(`${positionKey(start)}:${direction}`)) continue;
    let hasRock = false, safe = true;
    for (let step = 1; step <= 6 && safe; step++) {
      const p = start.offset(dx * step, 0, dz * step);
      const floor = bot.blockAt(p.offset(0, -1, 0), false);
      if (floor?.boundingBox !== 'block' || netherRouteExclusion(bot, {position: p}) || besideDrop(bot, p)
          || exposedMagmaCube(bot, p, cubes)) { safe = false; break; }
      for (let y = 0; y <= 2; y++) {
        const cell = bot.blockAt(p.offset(0, y, 0), false);
        if (PASSAGE_ROCK.has(cell?.name)) hasRock = true;
        else if (cell?.name !== 'air' && cell?.name !== 'cave_air') safe = false;
        for (const [x, h, z] of [[dz, y, dx], [-dz, y, -dx], [0, y + 1, 0], [dx, y, dz]]) {
          const adjacent = bot.blockAt(p.offset(x, h, z), false);
          if (!adjacent || ['lava', 'gravel', 'sand'].includes(adjacent.name)) safe = false;
        }
      }
    }
    const end = start.offset(dx * 6, 0, dz * 6);
    const clearance = Math.min(...route.surveyed.map(v => Math.hypot(v.x - end.x, v.z - end.z)));
    if (safe && hasRock && (clearance >= 4 || PASSAGE_ROCK.has(bot.blockAt(end, false)?.name))) {
      const here = bot.entity.position;
      const outward = route.anchor ? Math.hypot(end.x - route.anchor.x, end.z - route.anchor.z)
        - Math.hypot(here.x - route.anchor.x, here.z - route.anchor.z) : 0;
      choices.push({direction, start, end, clearance: clearance + outward});
    }
  }
  return choices.sort((a, b) => b.clearance - a.clearance)[0];
}

// 堡垒探索：找堡垒结构、找烈焰人、打烈焰人。
async function raidFortress(args, ctx) {
  const bot = botOf(ctx);
  const movements = bot.pathfinder?.movements;
  if (!args.scout_only || !movements || !isNetherDimension(currentDimension(ctx))) return searchFortress(args, ctx);
  const previous = { allowParkour: movements.allowParkour, allowSprinting: movements.allowSprinting,
    allow1by1towers: movements.allow1by1towers, canDig: movements.canDig, maxDropDown: movements.maxDropDown,
    exclusionAreasStep: movements.exclusionAreasStep };
  let hazards = [], nextScan = 0;
  const avoidCubes = block => {
    if (!block?.position) return 1000;
    if (Date.now() >= nextScan) {
      hazards = Object.values(bot.entities).filter(e => e?.name === 'magma_cube' && e.isValid !== false && e.position);
      nextScan = Date.now() + 400;
    }
    return exposedMagmaCube(bot, block.position, hazards) ? 1000 : 0;
  };
  const avoidCliffs = block => !block?.position || besideDrop(bot, block.position) ? 1000 : 0;
  Object.assign(movements, { allowParkour: false, allowSprinting: false, allow1by1towers: false, canDig: false,
    maxDropDown: 1, exclusionAreasStep: [...previous.exclusionAreasStep, avoidCubes, avoidCliffs] });
  try {
    return await searchFortress(args, ctx);
  } finally {
    Object.assign(movements, previous);
  }
}

async function searchFortress(args, ctx) {
  const dimension = currentDimension(ctx);
  if (!isNetherDimension(dimension)) {
    throw new Error(`当前在${dimensionLabel(dimension)}，附近没有可以探索的下界堡垒`);
  }

  const radius = clampNumber(args.radius, DEFAULT_FORTRESS_RADIUS, 16, 128);
  const timeoutMs = clampNumber(args.timeout_s, 120, 10, 600) * 1000;
  const wantBlazes = clampNumber(args.blazes, 1, 8, 1);
  const route = makeFortressRoute(botOf(ctx).entity.position, dimension, radius);
  if (args.scout_only === true && botOf(ctx).pathfinder?.movements && ctx.walkOnce) {
    route.surveyed = (Array.isArray(args.surveyed) ? args.surveyed : []).filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.z)).slice(0, 128);
    route.anchor = route.surveyed[0];
    route.surveyed.push(route.origin);
    route.connected = Array.isArray(args.surveyed) && args.surveyed.length > 0;
    route.confirmed = [];
    const point = p => p && [p.x, p.y, p.z].every(Number.isFinite);
    route.walkMisses = (Array.isArray(args.walk_misses) ? args.walk_misses : []).slice(-16)
      .filter(m => m && point(m.from) && point(m.to));
    route.followCells = route.connected && route.walkMisses.length > 0;
    route.walkFailures = 0;
    route.triedPassages = new Set();
    route.passageFailures = 0;
  }
  const deadline = Date.now() + timeoutMs;

  const notes = [];
  const structureEvidence = new Map();
  const visitedStructures = new Set();
  let structureFound = null;
  let blazeSeen = null;
  let lastSearch = 0;
  let previousScan = null;

  while (Date.now() < deadline) {
    throwIfInterrupted(ctx, '探索下界堡垒');
    if (currentDimension(ctx) !== dimension) {
      throw withActionData(new Error('探索期间维度发生变化，停止继续移动'), {
        fortress_evidence: fortressEvidenceData(dimension, structureEvidence, route),
      });
    }

    // 1. 先看附近有没有烈焰人。
    const blaze = findBlaze(ctx, radius);
    if (blaze) {
      blazeSeen = blaze;
      const position = blaze.position;
      const distance = Math.floor(position.distanceTo(botOf(ctx).entity.position));
      const blazeEvidence = {
        dimension,
        position: {
          x: Math.floor(position.x),
          y: Math.floor(position.y),
          z: Math.floor(position.z),
        },
      };
      if (args.scout_only === true) {
        return { status: 'succeeded', detail: `已在下界观察到烈焰人，距离 ${distance} 格`,
          data: { events: ['fortress_route_found'], blaze_evidence: blazeEvidence,
            fortress_evidence: fortressEvidenceData(dimension, structureEvidence, route) } };
      }
      log(
        ctx,
        '发现烈焰人',
        position.x.toFixed(1) + ', ' + position.y.toFixed(1) + ', ' + position.z.toFixed(1),
      );

      // 2. 有战斗技能入口就请它去打。
      const outcome = await callCombatEntry(ctx, {
        count: wantBlazes,
        radius,
        min_health: 6,
      });
      throwIfInterrupted(ctx, '探索下界堡垒');
      if (outcome) {
        const rods = ctx.countItem('blaze_rod');
        return {
          detail:
            `在堡垒附近找到烈焰人并交战（距离 ${distance} 格），` +
            `${outcome.detail || '战斗结束'}；` +
            `烈焰棒现在 ${rods} 根` +
            (notes.length ? `；${notes.join('，')}` : ''),
          status: outcome.status === 'partial' ? 'partial' : outcome.status === 'failed' ? 'failed' : 'succeeded',
          data: {
            fortress_evidence: fortressEvidenceData(dimension, structureEvidence, route),
            blaze_evidence: blazeEvidence,
          },
        };
      }

      // 3. 没有战斗入口，就报坐标与打法建议。
      return {
        detail:
          `附近 ${distance} 格处有烈焰人，坐标 (${Math.floor(position.x)}, ${Math.floor(position.y)}, ${Math.floor(position.z)})。` +
          `建议：带弓在 7 格以外射它，或者带盾贴到 3 格砍；` +
          `火球来袭时先横移躲开，被烧到就后撤。` +
          (structureFound
            ? `堡垒结构在 (${structureFound.x}, ${structureFound.y}, ${structureFound.z})。`
            : `附近还没找到堡垒结构，只看到这只烈焰人。`),
        status: 'partial',
        data: {
          fortress_evidence: fortressEvidenceData(dimension, structureEvidence, route),
          blaze_evidence: blazeEvidence,
        },
      };
    }

    // 4. 找当前维度里实扫到的下界砖结构。
    const here = botOf(ctx).entity.position;
    if (!previousScan || here.distanceTo(previousScan.position) >= 6 || Date.now() - previousScan.time >= 8000) {
      previousScan = {position: {x: here.x, y: here.y, z: here.z}, time: Date.now(), structure: findFortressStructure(ctx, radius)};
    }
    const structure = previousScan.structure;
    if (structure) {
      if (!structureFound) structureFound = structure;
      const evidence = rememberFortressStructure(ctx, structure, structureEvidence);
      const key = fortressStructureKey(evidence);
      const origin = botOf(ctx).entity.position;
      const distance = Math.hypot(structure.x - origin.x, structure.y - origin.y, structure.z - origin.z);
      if (distance > 6 && !visitedStructures.has(key) && route.attemptedWaypoints < route.budgetWaypoints) {
        visitedStructures.add(key);
        route.attemptedWaypoints += 1;
        log(ctx, '往实测堡垒方块走', structure.name + ' @ ' + structure.x + ', ' + structure.y + ', ' + structure.z);
        try {
          await ctx.travelTo(structure.x, structure.y, structure.z, 3);
          throwIfInterrupted(ctx, '探索下界堡垒');
          if (currentDimension(ctx) !== dimension) {
            throw new Error('前往堡垒方块后维度发生变化，停止继续移动');
          }
        } catch (error) {
          throwIfInterrupted(ctx, '探索下界堡垒');
          if (currentDimension(ctx) !== dimension) {
            throw withActionData(error, {
              fortress_evidence: fortressEvidenceData(dimension, structureEvidence, route),
            });
          }
          log(ctx, '走不到堡垒方块', error.message);
        }
        continue;
      }
      if (distance <= 6) {
        if (args.scout_only === true) {
          return { status: 'succeeded', detail: `已接近实测的堡垒方块 ${structure.name}`,
            data: { events: ['fortress_route_found'], fortress_evidence: fortressEvidenceData(dimension, structureEvidence, route) } };
        }
        notes.push('在 (' + structure.x + ', ' + structure.y + ', ' + structure.z + ') 看到 ' + label(ctx, structure.name));
      }
    }

    // 5. 没有可追的实测方块时，围绕本次起点走下一个有限路线点。
    if (Date.now() - lastSearch > 1500) {
      lastSearch = Date.now();
      const moved = await fallbackStep(ctx, route);
      if (!moved && (route.exhausted || route.attemptedWaypoints >= route.budgetWaypoints)) break;
      if (!moved) await sleepMs(ctx, 1000);
    } else {
      await sleepMs(ctx, 500);
    }
  }

  const data = {
    fortress_evidence: fortressEvidenceData(dimension, structureEvidence, route),
  };
  if (blazeSeen) {
    throw withActionData(
      new Error(
        `时间到了，附近没有打赢烈焰人，坐标 (${Math.floor(blazeSeen.position.x)}, ` +
          `${Math.floor(blazeSeen.position.y)}, ${Math.floor(blazeSeen.position.z)})；` +
          `附近也没有别的东西可以换目标`,
      ),
      data,
    );
  }
  throw withActionData(
    new Error(
      `附近 ${radius} 格内没有堡垒结构，也没有烈焰人，探索路线预算 ` +
        route.attemptedWaypoints + '/' + route.budgetWaypoints + ' 个点已用；' +
        (notes.length ? notes.join('，') : '找不到可以探索的方向'),
    ),
    data,
  );
}

// ------------------------------------------------------------------ 烈焰棒

// 掉落物的位置键：用来标记哪些掉落物已经试过了。
function dropKey(position) {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

// 附近的烈焰棒掉落物。exclude 是已经试过、跳过的掉落物位置键。
function findBlazeRodDrop(ctx, radius, exclude) {
  const bot = botOf(ctx);
  const origin = bot.entity.position;
  const entities = bot.entities ? Object.values(bot.entities) : [];
  const found = [];
  for (const entity of entities) {
    if (!entity || !entity.position) continue;
    if (entity.name !== 'item' && entity.name !== 'Item' && entity.name !== 'item_stack') continue;
    if (entity.position.distanceTo(origin) > radius) continue;
    let name = '';
    if (typeof entity.getDroppedItem === 'function') {
      try {
        name = entity.getDroppedItem()?.name || '';
      } catch {
        name = '';
      }
    }
    if (name !== 'blaze_rod') continue;
    if (exclude && exclude.has(dropKey(entity.position))) continue;
    found.push(entity);
  }
  found.sort(
    (left, right) => left.position.distanceTo(origin) - right.position.distanceTo(origin)
  );
  return found.length > 0 ? found[0] : null;
}

// 掉落物是不是掉在岩浆里。
function dropInLava(ctx, position) {
  const at = blockAt(ctx, Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
  if (at && isLavaName(at.name)) return true;
  const below = blockAt(
    ctx,
    Math.floor(position.x),
    Math.floor(position.y) - 1,
    Math.floor(position.z)
  );
  return Boolean(below && isLavaName(below.name));
}

// bot 是不是正踩在岩浆上。
function standingInLava(ctx) {
  const bot = botOf(ctx);
  const position = bot.entity.position;
  const x = Math.floor(position.x);
  const y = Math.floor(position.y);
  const z = Math.floor(position.z);
  const feet = blockAt(ctx, x, y, z);
  const below = blockAt(ctx, x, y - 1, z);
  return Boolean((feet && isLavaName(feet.name)) || (below && isLavaName(below.name)));
}

// 找附近能站的落脚点。
function findSafeSpot(ctx, radius, center = null) {
  const bot = botOf(ctx);
  const base = center || bot.entity.position;
  for (let distance = 1; distance <= radius; distance += 1) {
    for (let step = 0; step < 8; step += 1) {
      const angle = (Math.PI * 2 * step) / 8;
      const x = Math.floor(base.x + Math.cos(angle) * distance);
      const z = Math.floor(base.z + Math.sin(angle) * distance);
      for (let dy = 0; dy >= -3; dy -= 1) {
        const y = Math.floor(base.y) + dy;
        const ground = blockAt(ctx, x, y, z);
        if (!ground || ground.boundingBox !== 'block') continue;
        if (isLavaName(ground.name)) continue;
        const above = blockAt(ctx, x, y + 1, z);
        if (!above || above.boundingBox !== 'empty') continue;
        return { x, y: y + 1, z };
      }
    }
  }
  return null;
}

// 掉进岩浆就先爬出来。
async function escapeLava(ctx) {
  if (!standingInLava(ctx)) return false;
  const spot = findSafeSpot(ctx, 6);
  if (!spot) {
    log(ctx, '附近没有可以站的落脚点，只能等岩浆');
    return false;
  }
  try {
    await ctx.travelTo(spot.x, spot.y, spot.z, 1);
    log(ctx, '从岩浆里爬出来了', `${spot.x}, ${spot.y}, ${spot.z}`);
    return true;
  } catch (error) {
    log(ctx, '爬不出岩浆', error.message);
    return false;
  }
}

// 收集烈焰棒：捡掉落物，避开岩浆。
async function collectBlazeRods(args, ctx) {
  const wanted = Math.floor(clampNumber(args.count, BLAZE_ROD_TARGET, 1, 64));
  const radius = clampNumber(args.radius, 24, 4, 64);
  const timeoutMs = clampNumber(args.timeout_s, 180, 10, 900) * 1000;
  const deadline = Date.now() + timeoutMs;
  const dimension = currentDimension(ctx);

  let rods = Math.max(0, Math.floor(Number(ctx.countItem('blaze_rod')) || 0));
  if (rods >= wanted) {
    return {
      detail: `背包里已经有 ${rods} 根烈焰棒，够 ${wanted} 根`,
      status: 'succeeded',
      data: {
        inventory: { blaze_rod: rods },
        target: wanted,
        missing: 0,
        fortress_evidence: { dimension, observed_blocks: [] },
      },
    };
  }

  const notes = [];
  const tried = new Set();
  const structureEvidence = new Map();
  const visitedStructures = new Set();
  const observedBlazes = new Map();
  let picked = 0;
  let avoided = 0;
  let blazeNoted = false;
  let patrols = 0;

  while (Date.now() < deadline && rods < wanted) {
    throwIfInterrupted(ctx, '收集烈焰棒');
    if (currentDimension(ctx) !== dimension) {
      throw withActionData(new Error('收集期间维度发生变化，停止继续移动'), {
        inventory: { blaze_rod: rods },
        target: wanted,
        missing: Math.max(0, wanted - rods),
      });
    }

    // 1. 先确认自己不在岩浆里。
    if (await escapeLava(ctx)) avoided += 1;
    throwIfInterrupted(ctx, '收集烈焰棒');

    // 2. 先捡当前附近真实存在的烈焰棒掉落物。
    const drop = findBlazeRodDrop(ctx, radius, tried);
    if (drop) {
      const key = dropKey(drop.position);
      tried.add(key);
      if (dropInLava(ctx, drop.position)) {
        notes.push(`有一根烈焰棒掉进岩浆（${key}），捡不到`);
        log(ctx, '烈焰棒掉在岩浆里', key);
      } else {
        try {
          await ctx.travelTo(drop.position.x, drop.position.y, drop.position.z, 1);
        } catch (error) {
          throwIfInterrupted(ctx, '收集烈焰棒');
          log(ctx, '走不到烈焰棒掉落物', error.message);
        }
        await sleepMs(ctx, 400);
        throwIfInterrupted(ctx, '收集烈焰棒');
        const after = Math.max(0, Math.floor(Number(ctx.countItem('blaze_rod')) || 0));
        if (after > rods) {
          picked += after - rods;
          rods = after;
          continue;
        }
        if (typeof ctx.collectDrops === 'function') {
          try {
            const result = await ctx.collectDrops(radius, 'blaze_rod');
            throwIfInterrupted(ctx, '收集烈焰棒');
            const gained = Math.max(0, Math.floor(Number(ctx.countItem('blaze_rod')) || 0));
            if (gained > rods) {
              picked += gained - rods;
              rods = gained;
              continue;
            }
            if (result && result.missed && result.missed.length > 0) {
              notes.push(`有 ${result.missed.length} 根烈焰棒没捡到`);
            }
          } catch (error) {
            throwIfInterrupted(ctx, '收集烈焰棒');
            log(ctx, '捡烈焰棒失败', error.message);
          }
        }
      }
      continue;
    }

    // 3. 刷新当前附近的真实堡垒方块证据。
    const structure = findFortressStructure(ctx, radius);
    if (structure) rememberFortressStructure(ctx, structure, structureEvidence);

    // 4. 附近有烈焰人时，只请求背包净缺口数量。
    const blaze = findBlaze(ctx, radius);
    if (blaze) {
      const position = blaze.position;
      const blazeKey = dimension + ':' + dropKey(position);
      observedBlazes.set(blazeKey, {
        dimension,
        position: {
          x: Math.floor(position.x),
          y: Math.floor(position.y),
          z: Math.floor(position.z),
        },
      });
      const current = Math.max(0, Math.floor(Number(ctx.countItem('blaze_rod')) || 0));
      const missing = Math.max(0, wanted - current);
      const outcome = await callCombatEntry(ctx, {
        count: missing,
        radius,
        min_health: 6,
      });
      throwIfInterrupted(ctx, '收集烈焰棒');
      if (outcome) {
        const after = Math.max(0, Math.floor(Number(ctx.countItem('blaze_rod')) || 0));
        if (after >= wanted) {
          return {
            detail:
              `打了一只烈焰人，${outcome.detail || '战斗结束'}；烈焰棒一共 ${after} 根` +
              (notes.length ? `；${notes.join('，')}` : ''),
            status: 'succeeded',
            data: {
              inventory: { blaze_rod: after },
              target: wanted,
              missing: 0,
              fortress_evidence: fortressEvidenceData(dimension, structureEvidence),
              blaze_evidence: [...observedBlazes.values()],
              patrol: { budget: BLAZE_PATROL_BUDGET, attempted: patrols },
            },
          };
        }
        rods = after;
        continue;
      }
      if (!blazeNoted) {
        blazeNoted = true;
        const distance = Math.floor(position.distanceTo(botOf(ctx).entity.position));
        notes.push(
          `附近 ${distance} 格有烈焰人，坐标 (${Math.floor(position.x)}, ` +
            `${Math.floor(position.y)}, ${Math.floor(position.z)})，` +
            `但没有战斗技能入口，只能自己打`,
        );
      }
    }

    // 5. 只沿实扫堡垒点有限巡查，并要求目的地附近有安全落脚点。
    if (patrols < BLAZE_PATROL_BUDGET) {
      const position = botOf(ctx).entity.position;
      const candidates = moduleState.structures
        .filter((entry) => entry.dimension === dimension && !visitedStructures.has(fortressStructureKey(entry)))
        .sort((left, right) => {
          const leftDistance = Math.hypot(left.position.x - position.x, left.position.z - position.z);
          const rightDistance = Math.hypot(right.position.x - position.x, right.position.z - position.z);
          return leftDistance - rightDistance;
        });
      const target = candidates[0];
      if (target) {
        const key = fortressStructureKey(target);
        visitedStructures.add(key);
        patrols += 1;
        if (!isLiveFortressStructure(ctx, target)) {
          notes.push('已记录堡垒点重新读取时没有对应方块，跳过旧坐标');
          await sleepMs(ctx, 500);
          continue;
        }
        rememberFortressStructure(ctx, {
          x: target.position.x,
          y: target.position.y,
          z: target.position.z,
          name: target.block,
        }, structureEvidence);
        const safeSpot = findSafeSpot(ctx, 6, target.position);
        if (!safeSpot) {
          notes.push('堡垒点 (' + target.position.x + ', ' + target.position.y + ', ' + target.position.z + ') 周围没有确认安全的落脚点，跳过');
          await sleepMs(ctx, 500);
          continue;
        }
        const distance = Math.hypot(
          safeSpot.x - position.x,
          safeSpot.z - position.z,
        );
        if (distance > 3) {
          try {
            await ctx.travelTo(safeSpot.x, safeSpot.y, safeSpot.z, 1);
            throwIfInterrupted(ctx, '收集烈焰棒');
            if (currentDimension(ctx) !== dimension) {
              throw new Error('前往安全巡点后维度发生变化，停止继续移动');
            }
            log(ctx, '前往堡垒附近安全巡点', safeSpot.x + ', ' + safeSpot.y + ', ' + safeSpot.z);
          } catch (error) {
            throwIfInterrupted(ctx, '收集烈焰棒');
            if (currentDimension(ctx) !== dimension) throw error;
            log(ctx, '走不到堡垒附近安全巡点', error.message);
          }
        }
        continue;
      }
    }

    // 6. 周围没有可安全访问的新巡点时，等下一轮实体和掉落物更新。
    await sleepMs(ctx, 1000);
  }

  rods = Math.max(0, Math.floor(Number(ctx.countItem('blaze_rod')) || 0));
  if (rods >= wanted) {
    return {
      detail:
        `捡到 ${picked} 根烈焰棒，一共 ${rods} 根` +
        (avoided ? `，中途躲开 ${avoided} 次岩浆` : '') +
        (notes.length ? `；${notes.join('，')}` : ''),
      status: 'succeeded',
      data: {
        inventory: { blaze_rod: rods },
        target: wanted,
        missing: 0,
        fortress_evidence: fortressEvidenceData(dimension, structureEvidence),
        blaze_evidence: [...observedBlazes.values()],
        patrol: { budget: BLAZE_PATROL_BUDGET, attempted: patrols },
      },
    };
  }
  throw withActionData(
    new Error(
      `还差 ${wanted - rods} 根烈焰棒，附近 ${radius} 格内没有更多掉落物了` +
        (notes.length ? `；${notes.join('，')}` : ''),
    ),
    {
      inventory: { blaze_rod: rods },
      target: wanted,
      missing: Math.max(0, wanted - rods),
      fortress_evidence: fortressEvidenceData(dimension, structureEvidence),
      blaze_evidence: [...observedBlazes.values()],
      patrol: { budget: BLAZE_PATROL_BUDGET, attempted: patrols },
    },
  );
}

// ------------------------------------------------------------------ 技能表

export const skills = {
  make_nether_portal: {
    description:
      '建造并点燃下界门：清出门内 2×3 的空间，摆 10 个黑曜石当门框，用打火石点火并确认门被点燃；材料不够会直接报还差几个黑曜石。',
    parameters: [
      { name: 'facing', type: 'string', required: false, default: null, description: '门宽方向 x 或 z，默认按朝向自动选。' },
      { name: 'second', type: 'boolean', required: false, default: false, description: '是否再补一个返程门（要 20 个黑曜石）。' },
      { name: 'resume_site', type: 'object', required: false, default: null, description: '从上次实测门址续建，包含 dimension、origin 和 axis。' },
    ],
    handler: makeNetherPortal,
  },
  nether_travel: {
    description:
      '下界坐标换算与过门：主世界与下界按 1:8 互算坐标，enter 走进下界、exit 穿回主世界；结果分别记录实测源门和过门后抵达点。',
    parameters: [
      { name: 'mode', type: 'string', required: false, default: 'auto', description: 'convert 只换算，enter 进下界，exit 回主世界，auto 按当前维度选。' },
      { name: 'x', type: 'number', required: false, default: null, description: '要换算的目标 x，不填就用当前位置。' },
      { name: 'y', type: 'number', required: false, default: null, description: '要换算的目标 y。' },
      { name: 'z', type: 'number', required: false, default: null, description: '要换算的目标 z。' },
      { name: 'radius', type: 'number', required: false, default: DEFAULT_PORTAL_RADIUS, description: '找下界门的搜索半径。' },
      { name: 'timeout_s', type: 'number', required: false, default: 60, description: '过门的最长用时。' },
    ],
    handler: netherTravel,
  },
  raid_fortress: {
    description:
      '搜索堡垒方块与烈焰人。S5 侦察模式根据已访问位置选择安全落脚点并回报发现，默认模式发现烈焰人后交给战斗技能。',
    parameters: [
      { name: 'radius', type: 'number', required: false, default: DEFAULT_FORTRESS_RADIUS, description: '搜索半径。' },
      { name: 'blazes', type: 'number', required: false, default: 1, description: '要打几只烈焰人。' },
      { name: 'scout_only', type: 'boolean', required: false, default: false, description: '只寻找烈焰人或走近堡垒方块，保留战斗给采集动作。' },
      { name: 'surveyed', type: 'array', required: false, default: [], description: '先前侦察实际到过的区域，用于选择新的安全落脚点。' },
      { name: 'walk_misses', type: 'array', required: false, default: [], description: '最近走不通的起点和落脚点，仅在相同进路附近使用。' },
      { name: 'timeout_s', type: 'number', required: false, default: 120, description: '整个探索的最长用时。' },
    ],
    handler: raidFortress,
  },
  collect_blaze_rods: {
    description:
      '收集烈焰棒：按背包净缺口请求战斗数量，走近掉落物拾取并计数，掉进岩浆先爬出来再捡；附近无目标时只巡查实测堡垒点周围确认安全的有限位置。',
    parameters: [
      { name: 'count', type: 'number', required: false, default: BLAZE_ROD_TARGET, description: '要几根烈焰棒，M7.4 的目标是 7 根。' },
      { name: 'radius', type: 'number', required: false, default: 24, description: '掉落物搜索半径。' },
      { name: 'timeout_s', type: 'number', required: false, default: 180, description: '整个收集的最长用时。' },
    ],
    handler: collectBlazeRods,
  },
};
