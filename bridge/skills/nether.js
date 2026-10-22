// 下界模块：黑曜石下界门、维度坐标换算、堡垒探索、烈焰棒收集。
// 契约见 docs/plans/SKILL_MODULE_CONTRACT.md；对应路线图 M7.1-M7.4。
//
// 约束：
// - 只用 ctx 提供的能力，不 import 任何运行时依赖；bot 从 ctx.bot 取。
// - 模块之间不互相 import；需要别的技能时走 ctx 的技能入口，缺了就在结果里说明。
// - 坐标换算、门框布局、堡垒方块判定都是纯函数，单独导出，方便脱离游戏单测。
// - 结果只写真实读到的背包数量、方块与坐标，不凭空说「已建好门」。
//
// 待接入（ctx 目前没有，集成阶段补；缺了都能降级不崩）：
// - ctx.runSkill(skillId, args)：跨模块调别的技能。raid_fortress / collect_blaze_rods
//   优先用它请 combat.js 的 fight_blaze；没有它就退回自己报坐标和建议。
// - ctx.skills：技能注册表。缺了同样退回。
// - ctx.withTimeout / ctx.classifyPathFailure：超时包装与路径失败分类，缺省用本地实现。

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

// 模块级状态：技能模块在桥接里是长驻单例，这些状态跨调用保留，
// 供堡垒探索迷路时回退（记住门的位置与最近看到的堡垒结构）。
const moduleState = {
  portal: null,
  structure: null,
  spiralStep: 0,
};

// ------------------------------------------------------------------ 纯逻辑

// 维度判断：下界是 minecraft:the_nether。
export function isNetherDimension(dimension) {
  return String(dimension || '').toLowerCase().includes('nether');
}

// 主世界判断：拿不到维度信息时按主世界处理。
export function isOverworldDimension(dimension) {
  const text = String(dimension || '').toLowerCase();
  if (!text) return true;
  return text.includes('overworld');
}

// 末地判断。
export function isEndDimension(dimension) {
  return String(dimension || '').toLowerCase().includes('end');
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
// frame 最省门框 10 格、top 顶部四角 4 格、full 完整门框 14 格。
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

  const frame = [...bottom, ...sides];
  return {
    axis,
    origin: { x: ox, y: oy, z: oz },
    interior,
    bottom,
    sides,
    frame,
    top,
    full: [...frame, ...top],
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

// 当前维度 id，例如 minecraft:the_nether。
function currentDimension(ctx) {
  const bot = ctx && ctx.bot;
  const game = bot && bot.game;
  return String((game && game.dimension) || '').toLowerCase();
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

// 选建门位置：bot 前方 2 格，门宽轴与朝向垂直。
function choosePortalSite(ctx, axis, depthOffset = 2) {
  const bot = botOf(ctx);
  const base = bot.entity.position;
  const heading = facingFromYaw(bot.entity.yaw);
  // 深度方向：门宽轴的垂直方向，也就是 bot 朝向在深度轴上的投影。
  const frontX = axis === 'z' ? Math.sign(heading.x) || 1 : 0;
  const frontZ = axis === 'x' ? Math.sign(heading.z) || 1 : 0;

  const candidates = [depthOffset, depthOffset + 1, depthOffset - 1, depthOffset + 2];
  for (const offset of candidates) {
    if (offset <= 0) continue;
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
    if (!frameGroundOk(ctx, frame)) continue;
    return { origin, axis, groundY, frame };
  }
  throw new Error('附近没有足够大的空地放下下界门框');
}

// 清出门内 2×3 与门框位置的空间。
async function clearPortalSpace(ctx, frame) {
  let cleared = 0;
  const targets = [...frame.interior, ...frame.frame];
  for (const target of targets) {
    const block = blockAt(ctx, target.x, target.y, target.z);
    if (!block) continue;
    if (block.name === 'obsidian') continue;
    if (block.boundingBox === 'empty') continue;
    try {
      await ctx.breakBlock({ x: target.x, y: target.y, z: target.z });
      cleared += 1;
    } catch (error) {
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
  for (const target of [...frame.bottom, ...frame.sides]) {
    const block = blockAt(ctx, target.x, target.y, target.z);
    if (block && block.name === 'obsidian') {
      placed += 1;
      continue;
    }
    try {
      await ctx.placeBlock({ block: 'obsidian', x: target.x, y: target.y, z: target.z });
      placed += 1;
    } catch (error) {
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

  // 瞄准点依次是：门内下边两格正下方的黑曜石中心，再退到门内净空中心。
  const aims = [];
  for (const target of frame.interior.slice(0, 2)) {
    aims.push(makeVec(ctx, target.x + 0.5, target.y - 0.5, target.z + 0.5));
  }
  const center = frame.interior[0];
  aims.push(makeVec(ctx, center.x + 0.5, center.y + 0.5, center.z + 0.5));

  for (const aim of aims) {
    try {
      await bot.lookAt(aim, true);
      await sleepMs(ctx, 150);
      bot.activateItem();
      await sleepMs(ctx, 400);
      bot.deactivateItem();
    } catch (error) {
      log(ctx, '点火动作失败，换一个瞄准点', error.message);
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (portalLit(ctx, frame)) return true;
      await sleepMs(ctx, 250);
    }
  }
  return false;
}

// 建下界门并点火。
async function makeNetherPortal(args, ctx) {
  const dimension = currentDimension(ctx);
  if (isNetherDimension(dimension)) {
    throw new Error('已经在下界里了，下界门只能在主世界点燃');
  }
  if (isEndDimension(dimension)) {
    throw new Error(`当前在${dimensionLabel(dimension)}，没有可以建下界门的地方`);
  }

  const wantSecond = Boolean(args.second);
  const need = PORTAL_FRAME_OBSIDIAN * (wantSecond ? 2 : 1);
  const have = ctx.countItem('obsidian');
  if (have < need) {
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

  const site = choosePortalSite(ctx, axis, 2);
  const cleared = await clearPortalSpace(ctx, site.frame);
  const placed = await placeObsidianFrame(ctx, site.frame);

  if (!portalLit(ctx, site.frame)) {
    const lit = await lightPortal(ctx, site.frame);
    if (!lit) {
      throw new Error('打火石点了火，但门框里没有出现下界门，附近没有生成门');
    }
  }

  moduleState.portal = {
    x: site.origin.x,
    y: site.origin.y,
    z: site.origin.z,
    dimension: currentDimension(ctx),
  };

  const parts = [
    `下界门已建好并点燃，位置 (${site.origin.x}, ${site.origin.y}, ${site.origin.z})`,
    `门框 ${placed} 个黑曜石，清掉 ${cleared} 格障碍`,
  ];

  // 往返用的第二个门。
  if (wantSecond) {
    const second = choosePortalSite(ctx, axis, 9);
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
    parts.push(
      `返程门也建好了，位置 (${second.origin.x}, ${second.origin.y}, ${second.origin.z})，` +
        `门框 ${secondPlaced} 个黑曜石`
    );
  }

  return { detail: parts.join('，'), status: 'succeeded' };
}

// ------------------------------------------------------------------ 维度换算

// 找附近的下界门。
function findNearbyPortal(ctx, radius) {
  if (typeof ctx.nearbyBlock === 'function') {
    const block = ctx.nearbyBlock('nether_portal', radius);
    if (block && block.position) return block.position;
  }
  const bot = botOf(ctx);
  const registry = bot.registry && bot.registry.blocksByName;
  const entry = registry && registry['nether_portal'];
  if (!entry || typeof bot.findBlocks !== 'function') return null;
  try {
    const positions = bot.findBlocks({
      matching: entry.id,
      maxDistance: radius,
      count: 1,
    });
    return positions.length > 0 ? positions[0] : null;
  } catch {
    return null;
  }
}

// 等维度变化。
async function waitDimension(ctx, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (currentDimension(ctx) === expected) return true;
    await sleepMs(ctx, 250);
  }
  return currentDimension(ctx) === expected;
}

// 走进下界门。
async function enterPortal(ctx, portal, timeoutMs) {
  try {
    await ctx.travelTo(portal.x, portal.y, portal.z, 1);
  } catch (error) {
    log(ctx, '没走到下界门', error.message);
  }
  // 再往门里挤一挤，必要时多试几次。
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (currentDimension(ctx) !== OVERWORLD_DIMENSION) break;
    try {
      await ctx.walkOnce(portal.x, portal.y, portal.z, 1, 4000);
    } catch (error) {
      log(ctx, '进门动作失败', error.message);
    }
    await sleepMs(ctx, 400);
  }
  return currentDimension(ctx) !== OVERWORLD_DIMENSION;
}

// 下界坐标换算与过门。
async function netherTravel(args, ctx) {
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

  // 过门：先确认当前维度对不对。
  if (wanted === 'enter' && isNetherDimension(dimension)) {
    throw new Error('已经在下界里了，要回主世界请用 exit');
  }
  if (wanted === 'exit' && !isNetherDimension(dimension)) {
    throw new Error('当前不在下界，附近没有下界门可以回去');
  }

  const portal = findNearbyPortal(ctx, radius);
  if (!portal) {
    throw new Error(`附近 ${radius} 格内没有下界门，先建好门再过`);
  }
  moduleState.portal = { x: portal.x, y: portal.y, z: portal.z, dimension };

  const passed = await enterPortal(ctx, portal, timeoutMs);
  if (!passed) {
    throw new Error(
      `没有走进下界门，附近 (${portal.x}, ${portal.y}, ${portal.z}) 的门没有把维度切过去`
    );
  }

  const arrived = currentDimension(ctx);
  const checkpoint = checkpointInfo(bot.entity.position, arrived);
  moduleState.portal = { x: portal.x, y: portal.y, z: portal.z, dimension: arrived };
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
  if (!registry) return null;
  const origin = bot.entity.position;
  let best = null;
  let bestDistance = Infinity;
  for (const name of FORTRESS_BLOCKS) {
    const entry = registry[name];
    if (!entry || typeof bot.findBlocks !== 'function') continue;
    let positions = [];
    try {
      positions = bot.findBlocks({ matching: entry.id, maxDistance: radius, count: 4 });
    } catch {
      positions = [];
    }
    for (const spot of positions) {
      const distance = Math.hypot(spot.x - origin.x, spot.z - origin.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { x: spot.x, y: spot.y, z: spot.z, name };
      }
    }
  }
  return best;
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

// 迷路时的回退路径：优先走回最近看到的堡垒结构，其次走回下界门，
// 都没有就按螺旋方向往外扩一圈再找。
async function fallbackStep(ctx, radius) {
  const bot = botOf(ctx);
  const base = bot.entity.position;
  const headings = [
    { x: 0, z: 1 },
    { x: -1, z: 0 },
    { x: 0, z: -1 },
    { x: 1, z: 0 },
  ];

  const targets = [];
  if (moduleState.structure) {
    targets.push({ ...moduleState.structure, label: '堡垒结构' });
  }
  if (moduleState.portal) {
    targets.push({ ...moduleState.portal, label: '下界门' });
  }
  for (const target of targets) {
    const distance = Math.hypot(target.x - base.x, target.z - base.z);
    if (distance < 3) continue;
    try {
      await ctx.travelTo(target.x, target.y, target.z, 3);
      log(ctx, `回退到${target.label}`, `${target.x}, ${target.y}, ${target.z}`);
      return true;
    } catch (error) {
      log(ctx, `回退到${target.label}失败`, error.message);
    }
  }

  // 螺旋外扩：每 4 步换一个方向，步长逐圈加大。
  moduleState.spiralStep += 1;
  const heading = headings[moduleState.spiralStep % headings.length];
  const ring = Math.floor(moduleState.spiralStep / headings.length) + 1;
  const step = Math.min(radius, 8 * ring);
  const target = {
    x: Math.floor(base.x + heading.x * step),
    y: Math.floor(base.y),
    z: Math.floor(base.z + heading.z * step),
  };
  try {
    await ctx.travelTo(target.x, target.y, target.z, 3);
    return true;
  } catch (error) {
    log(ctx, '外扩搜索走不动', error.message);
    return false;
  }
}

// 堡垒探索：找堡垒结构、找烈焰人、打烈焰人。
async function raidFortress(args, ctx) {
  const dimension = currentDimension(ctx);
  if (!isNetherDimension(dimension)) {
    throw new Error(`当前在${dimensionLabel(dimension)}，附近没有可以探索的下界堡垒`);
  }

  const radius = clampNumber(args.radius, DEFAULT_FORTRESS_RADIUS, 16, 128);
  const timeoutMs = clampNumber(args.timeout_s, 120, 10, 600) * 1000;
  const wantBlazes = clampNumber(args.blazes, 1, 8, 1);
  const deadline = Date.now() + timeoutMs;

  const notes = [];
  let structureFound = null;
  let blazeSeen = null;
  let lastSearch = 0;

  while (Date.now() < deadline) {
    // 1. 先看附近有没有烈焰人。
    const blaze = findBlaze(ctx, radius);
    if (blaze) {
      blazeSeen = blaze;
      const position = blaze.position;
      const distance = Math.floor(position.distanceTo(botOf(ctx).entity.position));
      log(
        ctx,
        '发现烈焰人',
        `${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}`
      );

      // 2. 有战斗技能入口就请它去打。
      const outcome = await callCombatEntry(ctx, {
        count: wantBlazes,
        radius,
        min_health: 6,
      });
      if (outcome) {
        const rods = ctx.countItem('blaze_rod');
        return {
          detail:
            `在堡垒附近找到烈焰人并交战（距离 ${distance} 格），` +
            `${outcome.detail || '战斗结束'}；` +
            `烈焰棒现在 ${rods} 根` +
            (notes.length ? `；${notes.join('，')}` : ''),
          status: 'succeeded',
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
        status: 'succeeded',
      };
    }

    // 4. 找堡垒结构，往那边走。
    const structure = findFortressStructure(ctx, radius);
    if (structure) {
      if (!structureFound) structureFound = structure;
      moduleState.structure = structure;
      const origin = botOf(ctx).entity.position;
      const distance = Math.hypot(structure.x - origin.x, structure.z - origin.z);
      if (distance > 6) {
        log(ctx, '往堡垒结构走', `${structure.name} @ ${structure.x}, ${structure.y}, ${structure.z}`);
        try {
          await ctx.travelTo(structure.x, structure.y, structure.z, 3);
        } catch (error) {
          log(ctx, '走不到堡垒结构', error.message);
        }
        continue;
      }
      notes.push(`在 (${structure.x}, ${structure.y}, ${structure.z}) 看到 ${label(ctx, structure.name)}`);
    }

    // 5. 附近什么都没有，走回退路径换个方向再找。
    if (Date.now() - lastSearch > 1500) {
      lastSearch = Date.now();
      const moved = await fallbackStep(ctx, radius);
      if (!moved) await sleepMs(ctx, 1000);
    } else {
      await sleepMs(ctx, 500);
    }
  }

  if (blazeSeen) {
    throw new Error(
      `时间到了，附近没有打赢烈焰人，坐标 (${Math.floor(blazeSeen.position.x)}, ` +
        `${Math.floor(blazeSeen.position.y)}, ${Math.floor(blazeSeen.position.z)})；` +
        `附近也没有别的东西可以换目标`
    );
  }
  throw new Error(
    `附近 ${radius} 格内没有堡垒结构，也没有烈焰人，找不到可以探索的方向` +
      (notes.length ? `；${notes.join('，')}` : '')
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
function findSafeSpot(ctx, radius) {
  const bot = botOf(ctx);
  const base = bot.entity.position;
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
        if (above && above.boundingBox !== 'empty') continue;
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
  const wanted = clampNumber(args.count, BLAZE_ROD_TARGET, 1, 64);
  const radius = clampNumber(args.radius, 24, 4, 64);
  const timeoutMs = clampNumber(args.timeout_s, 180, 10, 900) * 1000;
  const deadline = Date.now() + timeoutMs;

  let rods = ctx.countItem('blaze_rod');
  if (rods >= wanted) {
    return {
      detail: `背包里已经有 ${rods} 根烈焰棒，够 ${wanted} 根`,
      status: 'succeeded',
    };
  }

  const notes = [];
  const tried = new Set();
  let picked = 0;
  let avoided = 0;
  let blazeNoted = false;

  while (Date.now() < deadline && rods < wanted) {
    // 1. 先确认自己不在岩浆里。
    if (await escapeLava(ctx)) avoided += 1;

    // 2. 找附近还没试过的烈焰棒掉落物。
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
          log(ctx, '走不到烈焰棒掉落物', error.message);
        }
        await sleepMs(ctx, 400);
        const after = ctx.countItem('blaze_rod');
        if (after > rods) {
          picked += after - rods;
          rods = after;
          continue;
        }
        // 自己走位没捡到，交给桥接的拾取原语再试一次。
        if (typeof ctx.collectDrops === 'function') {
          try {
            const result = await ctx.collectDrops(radius, 'blaze_rod');
            const gained = ctx.countItem('blaze_rod');
            if (gained > rods) {
              picked += gained - rods;
              rods = gained;
              continue;
            }
            if (result && result.missed && result.missed.length > 0) {
              notes.push(`有 ${result.missed.length} 根烈焰棒没捡到`);
            }
          } catch (error) {
            log(ctx, '捡烈焰棒失败', error.message);
          }
        }
      }
      continue;
    }

    // 3. 附近没有掉落物，就找烈焰人，请战斗模块打。
    const blaze = findBlaze(ctx, radius);
    if (blaze) {
      const outcome = await callCombatEntry(ctx, {
        count: wanted - rods,
        radius,
        min_health: 6,
      });
      if (outcome) {
        rods = ctx.countItem('blaze_rod');
        if (rods >= wanted) {
          return {
            detail:
              `打了一只烈焰人，${outcome.detail || '战斗结束'}；烈焰棒一共 ${rods} 根` +
              (notes.length ? `；${notes.join('，')}` : ''),
            status: 'succeeded',
          };
        }
        continue;
      }
      if (!blazeNoted) {
        blazeNoted = true;
        const distance = Math.floor(blaze.position.distanceTo(botOf(ctx).entity.position));
        notes.push(
          `附近 ${distance} 格有烈焰人，坐标 (${Math.floor(blaze.position.x)}, ` +
            `${Math.floor(blaze.position.y)}, ${Math.floor(blaze.position.z)})，` +
            `但没有战斗技能入口，只能自己打`
        );
      }
    }

    // 4. 什么也没有，等一会儿再扫。
    await sleepMs(ctx, 1000);
  }

  rods = ctx.countItem('blaze_rod');
  if (rods >= wanted) {
    return {
      detail:
        `捡到 ${picked} 根烈焰棒，一共 ${rods} 根` +
        (avoided ? `，中途躲开 ${avoided} 次岩浆` : '') +
        (notes.length ? `；${notes.join('，')}` : ''),
      status: 'succeeded',
    };
  }
  throw new Error(
    `还差 ${wanted - rods} 根烈焰棒，附近 ${radius} 格内没有更多掉落物了` +
      (notes.length ? `；${notes.join('，')}` : '')
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
    ],
    handler: makeNetherPortal,
  },
  nether_travel: {
    description:
      '下界坐标换算与过门：主世界与下界按 1:8 互算坐标，enter 走进下界、exit 穿回主世界，过门后的 checkpoint 写在结果里，不落盘。',
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
      '探索下界堡垒：识别下界砖块、下界疣、下界门等结构方块，找到烈焰人后请战斗技能去打；没有战斗技能就报出烈焰人坐标与打法，迷路时沿结构或门户回退。',
    parameters: [
      { name: 'radius', type: 'number', required: false, default: DEFAULT_FORTRESS_RADIUS, description: '搜索半径。' },
      { name: 'blazes', type: 'number', required: false, default: 1, description: '要打几只烈焰人。' },
      { name: 'timeout_s', type: 'number', required: false, default: 120, description: '整个探索的最长用时。' },
    ],
    handler: raidFortress,
  },
  collect_blaze_rods: {
    description:
      '收集烈焰棒：走近掉落物拾取并计数，掉进岩浆先爬出来再捡；附近没有掉落物时会找烈焰人请战斗技能去打。',
    parameters: [
      { name: 'count', type: 'number', required: false, default: BLAZE_ROD_TARGET, description: '要几根烈焰棒，M7.4 的目标是 7 根。' },
      { name: 'radius', type: 'number', required: false, default: 24, description: '掉落物搜索半径。' },
      { name: 'timeout_s', type: 'number', required: false, default: 180, description: '整个收集的最长用时。' },
    ],
    handler: collectBlazeRods,
  },
};
