// 末地模块：末影之眼定位、激活末地门、末影龙战斗、返回主世界。
// 契约见 docs/plans/SKILL_MODULE_CONTRACT.md；对应路线图 M8.1-M8.5。
//
// 约束：
// - 只用 ctx 提供的能力，不 import 任何运行时依赖；bot 从 ctx.bot 取。
// - 模块之间不互相 import；需要别的技能时走 ctx 的技能入口，缺了就在结果里说明。
// - 射线求交、框架状态、龙是否停在中央都是纯函数，单独导出，方便脱离游戏单测。
// - 结果只写真实读到的背包数量、实体与坐标，不凭空说「龙已死」「门已开」。
//
// 待接入（ctx 目前没有，集成阶段补；缺了都能降级不崩）：
// - ctx.runSkill(skillId, args)：跨模块调 combat.js 的 break_crystal。
//   没有它就自己用 ctx.shootAt 打水晶。
// - ctx.skills：技能注册表。缺了同样退回本地实现。

// ------------------------------------------------------------------ 常量

const END_DIMENSION = 'minecraft:the_end';
const OVERWORLD_DIMENSION = 'minecraft:overworld';
const EYE_ITEM = 'ender_eye';
const FRAME_BLOCK = 'end_portal_frame';
const PORTAL_BLOCK = 'end_portal';
const CRYSTAL_ENTITY = 'end_crystal';
const DRAGON_ENTITY = 'ender_dragon';

// 末地门固定 12 个框架。
const PORTAL_FRAME_COUNT = 12;

const DEFAULT_FRAME_RADIUS = 32;
const DEFAULT_EYE_THROWS = 3;
const DEFAULT_DRAGON_RADIUS = 64;

// 投掷记录只保留最近 8 次，避免长跑时越攒越多。
const MAX_THROW_RECORDS = 8;

const moduleState = {
  throws: [],
};

// ------------------------------------------------------------------ 纯逻辑

export function isEndDimension(dimension) {
  return String(dimension || '').toLowerCase().includes('end');
}

export function isOverworldDimension(dimension) {
  const text = String(dimension || '').toLowerCase();
  return text === OVERWORLD_DIMENSION || text === 'overworld';
}

export function dimensionLabel(dimension) {
  if (isEndDimension(dimension)) return '末地';
  if (isOverworldDimension(dimension)) return '主世界';
  if (String(dimension || '').toLowerCase().includes('nether')) return '下界';
  return String(dimension || '未知维度');
}

export function normalizeVector(dx, dz) {
  const x = Number(dx);
  const z = Number(dz);
  const length = Math.hypot(x, z);
  if (!Number.isFinite(length) || length < 1e-6) return null;
  return { dx: x / length, dz: z / length };
}

// 两条二维射线求交：A + t*dA 与 B + u*dB，t/u 都必须是正距离。
// 返回 { x, z, distance, angle }；射线近乎平行或交点在身后时返回 null。
export function rayIntersection(a, b) {
  if (!a || !b) return null;
  const da = normalizeVector(a.dx, a.dz);
  const db = normalizeVector(b.dx, b.dz);
  if (!da || !db) return null;
  const ax = Number(a.x);
  const az = Number(a.z);
  const bx = Number(b.x);
  const bz = Number(b.z);
  if (![ax, az, bx, bz].every(Number.isFinite)) return null;

  const denom = da.dx * db.dz - da.dz * db.dx;
  if (Math.abs(denom) < 0.12) return null;

  const rx = bx - ax;
  const rz = bz - az;
  const t = (rx * db.dz - rz * db.dx) / denom;
  const u = (rx * da.dz - rz * da.dx) / denom;
  if (!Number.isFinite(t) || !Number.isFinite(u)) return null;
  if (t <= 0 || u < -0.5) return null;

  const dot = da.dx * db.dx + da.dz * db.dz;
  const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
  return {
    x: ax + da.dx * t,
    z: az + da.dz * t,
    distance: (t + Math.max(0, u)) / 2,
    angle,
  };
}

// 从多次投掷里挑夹角最大的一对射线估算要塞中心。
export function estimateStronghold(throws) {
  const list = (Array.isArray(throws) ? throws : [])
    .filter((item) => item && normalizeVector(item.dx, item.dz))
    .slice(-MAX_THROW_RECORDS);
  let best = null;
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const hit = rayIntersection(list[i], list[j]);
      if (!hit) continue;
      if (!best || hit.angle > best.angle) best = hit;
    }
  }
  if (!best) return null;
  return {
    x: Math.round(best.x),
    z: Math.round(best.z),
    distance: Math.round(best.distance),
    angle_deg: Math.round((best.angle * 180) / Math.PI),
    throws: list.length,
  };
}

// prismarine-block 的 eye 属性可能是布尔、字符串或 0/1。
export function frameHasEye(block) {
  if (!block) return false;
  let properties = null;
  try {
    properties = typeof block.getProperties === 'function' ? block.getProperties() : block._properties;
  } catch {
    properties = null;
  }
  if (!properties) return false;
  const value =
    typeof properties.get === 'function' ? properties.get('eye') : properties.eye;
  return value === true || value === 'true' || value === 1 || value === '1';
}

// 末影龙停在中央祭坛附近时才会落下，允许一点垂直误差。
export function isDragonPerched(entity, bot) {
  if (!entity || !entity.position || !bot || !bot.entity || !bot.entity.position) return false;
  const dragon = entity.position;
  const me = bot.entity.position;
  return (
    Math.hypot(dragon.x, dragon.z) <= 18 &&
    Math.abs(dragon.y - me.y) <= 12 &&
    Number(dragon.y) < 90
  );
}

// ------------------------------------------------------------------ 小工具

function botOf(ctx) {
  const bot = ctx && ctx.bot;
  if (!bot || !bot.entity || !bot.entity.position) {
    throw new Error('还没有进入世界，无法在末地行动');
  }
  return bot;
}

function currentDimension(ctx) {
  const bot = ctx && ctx.bot;
  const game = bot && bot.game;
  return String((game && game.dimension) || '').toLowerCase();
}

function sleepMs(ctx, ms) {
  if (typeof ctx.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(ctx, ...args) {
  if (typeof ctx.log === 'function') ctx.log(...args);
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function copyPosition(position) {
  return {
    x: Number(position.x),
    y: Number(position.y),
    z: Number(position.z),
  };
}

function directionFromYaw(yaw) {
  const angle = Number(yaw) || 0;
  return { dx: -Math.sin(angle), dz: Math.cos(angle) };
}

function entityName(entity) {
  return String((entity && entity.name) || '').toLowerCase();
}

function findEntities(ctx, name, radius) {
  const bot = botOf(ctx);
  const origin = bot.entity.position;
  const found = [];
  for (const entity of Object.values(bot.entities || {})) {
    if (!entity || entity === bot.entity || entity.isValid === false) continue;
    if (entityName(entity) !== name) continue;
    if (!entity.position) continue;
    const distance = origin.distanceTo(entity.position);
    if (distance > radius) continue;
    found.push({ entity, distance });
  }
  found.sort((a, b) => a.distance - b.distance);
  return found.map((item) => item.entity);
}

function findEntity(ctx, name, radius) {
  return findEntities(ctx, name, radius)[0] || null;
}

function eyeEntities(ctx) {
  const bot = botOf(ctx);
  return Object.values(bot.entities || {}).filter(
    (entity) => entity && entity !== bot.entity && entityName(entity) === 'eye_of_ender',
  );
}

function findBlockPositions(ctx, name, radius, count = PORTAL_FRAME_COUNT * 2) {
  const bot = botOf(ctx);
  const origin = bot.entity.position;
  if (typeof bot.findBlocks === 'function') {
    try {
      const positions = bot.findBlocks({
        point: origin,
        matching: (block) => Boolean(block && block.name === name),
        maxDistance: radius,
        count,
      });
      return (positions || []).filter(Boolean);
    } catch (error) {
      log(ctx, '找方块失败', name, error.message);
    }
  }
  if (typeof bot.findBlock === 'function') {
    try {
      const block = bot.findBlock({
        point: origin,
        matching: (candidate) => Boolean(candidate && candidate.name === name),
        maxDistance: radius,
      });
      if (block) return [block.position];
    } catch (error) {
      log(ctx, '找方块失败', name, error.message);
    }
  }
  return [];
}

function findFramesNearby(ctx, radius) {
  return findBlockPositions(ctx, FRAME_BLOCK, radius, 32)
    .map((position) => botOf(ctx).blockAt(position))
    .filter(Boolean);
}

function findItem(ctx, name) {
  const bot = botOf(ctx);
  if (!bot.inventory || typeof bot.inventory.items !== 'function') return null;
  return bot.inventory.items().find((item) => item && item.name === name) || null;
}

function labelOf(ctx, name) {
  if (typeof ctx.itemLabel === 'function') {
    const label = ctx.itemLabel(name);
    if (label && label !== name) return label;
  }
  return String(name);
}

function distanceToBot(ctx, entity) {
  const bot = botOf(ctx);
  if (!entity || !entity.position) return Infinity;
  return bot.entity.position.distanceTo(entity.position);
}

function entityGone(ctx, entity) {
  if (!entity || entity.isValid === false) return true;
  const bot = botOf(ctx);
  return !bot.entities || !bot.entities[entity.id];
}

async function waitEntityGone(ctx, entity, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (entityGone(ctx, entity)) return true;
    await sleepMs(ctx, 200);
  }
  return entityGone(ctx, entity);
}

async function activateOnce(ctx) {
  const bot = botOf(ctx);
  await bot.activateItem();
  await sleepMs(ctx, 120);
  if (typeof bot.deactivateItem === 'function') await bot.deactivateItem();
}

// 跟踪刚投出的末影之眼，返回它最后被看到的位置。
async function trackEye(ctx, knownIds, durationMs) {
  const deadline = Date.now() + durationMs;
  let eye = null;
  let last = null;
  while (Date.now() < deadline) {
    await sleepMs(ctx, 100);
    const candidates = eyeEntities(ctx).filter((entity) => entity && !knownIds.has(entity.id));
    if (candidates.length > 0) eye = candidates[0];
    if (eye && eye.position) last = copyPosition(eye.position);
    if (eye && entityGone(ctx, eye)) break;
  }
  return last;
}

async function moveToward(ctx, x, z, radius = 3) {
  const bot = botOf(ctx);
  const y = Math.floor(bot.entity.position.y);
  try {
    await ctx.travelTo(Math.floor(x), y, Math.floor(z), radius);
    return true;
  } catch (error) {
    log(ctx, '朝目标移动失败', error.message);
    return false;
  }
}

// ------------------------------------------------------------------ 技能：投掷末影之眼

async function throwEye(args, ctx) {
  const bot = botOf(ctx);
  const dimension = currentDimension(ctx);
  if (isEndDimension(dimension)) {
    throw new Error('已经在末地，不需要再投末影之眼');
  }
  if (!isOverworldDimension(dimension)) {
    throw new Error(`当前在${dimensionLabel(dimension)}，末影之眼只用来在主世界找要塞`);
  }

  const maxThrows = clampNumber(args.count, DEFAULT_EYE_THROWS, 1, 12);
  const advance = clampNumber(args.advance, 0, 0, 256);
  const frameRadius = clampNumber(args.frame_radius, 24, 8, 64);
  const timeoutMs = clampNumber(args.timeout_s, 180, 20, 300) * 1000;
  const deadline = Date.now() + timeoutMs;

  let throws = 0;
  let lastDirection = null;
  let lastOrigin = null;
  const notes = [];

  for (let index = 0; index < maxThrows && Date.now() < deadline; index += 1) {
    const eye = findItem(ctx, EYE_ITEM);
    if (!eye) {
      if (throws === 0) {
        throw new Error(`没有${labelOf(ctx, EYE_ITEM)}，先合成末影之眼再找要塞`);
      }
      notes.push('末影之眼用完了');
      break;
    }

    const origin = copyPosition(bot.entity.position);
    const yaw = Number(bot.entity.yaw) || 0;
    const fallback = directionFromYaw(yaw);
    const knownIds = new Set(eyeEntities(ctx).map((entity) => entity.id));

    await bot.equip(eye, 'hand');
    await bot.look(yaw, 0, true);
    await activateOnce(ctx);
    throws += 1;

    const observed = await trackEye(ctx, knownIds, 2400);
    let direction = fallback;
    let eyeDistance = null;
    if (observed) {
      eyeDistance = Math.hypot(observed.x - origin.x, observed.z - origin.z);
      const fromFlight = normalizeVector(observed.x - origin.x, observed.z - origin.z);
      if (fromFlight) direction = fromFlight;
    } else {
      notes.push('没看到末影之眼的飞行实体，按投掷朝向推算');
    }

    lastDirection = direction;
    lastOrigin = origin;
    moduleState.throws.push({
      x: origin.x,
      z: origin.z,
      dx: direction.dx,
      dz: direction.dz,
    });
    if (moduleState.throws.length > MAX_THROW_RECORDS) {
      moduleState.throws = moduleState.throws.slice(-MAX_THROW_RECORDS);
    }

    const frames = findFramesNearby(ctx, frameRadius);
    if (frames.length > 0) {
      return {
        detail:
          `第 ${throws} 次投掷后，在 ${frameRadius} 格内发现 ${frames.length} 个末地门框架，` +
          `方向 (${direction.dx.toFixed(2)}, ${direction.dz.toFixed(2)})，可以开始激活末地门`,
        status: 'succeeded',
      };
    }

    // 眼在附近落下，说明要塞就在脚下，不要再朝远处走。
    const droppedNearby = eyeDistance !== null && eyeDistance < 20;
    if (droppedNearby) {
      const wideFrames = findFramesNearby(ctx, Math.min(frameRadius * 2, 64));
      if (wideFrames.length > 0) {
        return {
          detail:
            `第 ${throws} 次投掷后，末影之眼在 ${Math.round(eyeDistance)} 格内落下，` +
            `在 ${Math.min(frameRadius * 2, 64)} 格内发现 ${wideFrames.length} 个末地门框架`,
          status: 'succeeded',
        };
      }
      notes.push('眼在附近落下，但附近没有找到框架，可能要先往下挖进要塞');
      break;
    }

    if (advance > 0 && Date.now() < deadline) {
      const targetX = origin.x + direction.dx * advance;
      const targetZ = origin.z + direction.dz * advance;
      const moved = await moveToward(ctx, targetX, targetZ, 4);
      if (!moved) notes.push(`朝要塞方向走 ${advance} 格失败`);
    }
  }

  const estimate = estimateStronghold(moduleState.throws);
  if (throws === 0) {
    throw new Error('一次末影之眼都没有投出去，先确认背包里有末影之眼');
  }
  const head =
    `投了 ${throws} 次末影之眼，最后一次朝向 ` +
    (lastDirection
      ? `(${lastDirection.dx.toFixed(2)}, ${lastDirection.dz.toFixed(2)})`
      : '未知');
  const guess = estimate
    ? `；两次投掷推算要塞大约在 (${estimate.x}, ${estimate.z})，距最后一次起点约 ${estimate.distance} 格`
    : '；投掷方向太接近，还推算不出要塞坐标，换个位置再投';
  const tail = notes.length ? `；${notes.join('，')}` : '';
  return {
    detail: `${head}${guess}${tail}`,
    status: 'succeeded',
  };
}

// ------------------------------------------------------------------ 技能：激活末地门

async function insertEye(ctx, frame) {
  const bot = botOf(ctx);
  try {
    await ctx.travelTo(frame.position.x, frame.position.y, frame.position.z, 2);
  } catch (error) {
    log(ctx, '没走到末地门框架', error.message);
  }
  const eye = findItem(ctx, EYE_ITEM);
  if (!eye) return false;
  await bot.equip(eye, 'hand');
  const fresh = bot.blockAt(frame.position) || frame;
  await bot.lookAt(fresh.position.offset(0.5, 0.5, 0.5), true);

  const before = frameHasEye(fresh);
  if (before) return true;

  try {
    if (typeof bot.activateBlock === 'function') {
      await bot.activateBlock(fresh);
    } else {
      await activateOnce(ctx);
    }
  } catch (error) {
    log(ctx, '放末影之眼失败', error.message);
  }
  await sleepMs(ctx, 400);

  let after = bot.blockAt(fresh.position);
  if (frameHasEye(after)) return true;

  // 第一次没成，换成交互键再试一次。
  try {
    await bot.lookAt(fresh.position.offset(0.5, 0.5, 0.5), true);
    await activateOnce(ctx);
    await sleepMs(ctx, 400);
    after = bot.blockAt(fresh.position);
  } catch (error) {
    log(ctx, '第二次放末影之眼失败', error.message);
  }
  return frameHasEye(after);
}

async function enterEndPortal(ctx, portal, timeoutMs) {
  const bot = botOf(ctx);
  const x = Math.floor(portal.x);
  const y = Math.floor(portal.y);
  const z = Math.floor(portal.z);
  try {
    await ctx.travelTo(x, y, z, 1);
  } catch (error) {
    log(ctx, '没走到末地门', error.message);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isEndDimension(currentDimension(ctx))) return true;
    try {
      if (typeof ctx.walkOnce === 'function') {
        await ctx.walkOnce(x, y, z, 1, 4000);
      } else {
        bot.setControlState('forward', true);
        await sleepMs(ctx, 1200);
      }
    } catch (error) {
      log(ctx, '走进末地门失败', error.message);
    } finally {
      if (typeof bot.setControlState === 'function') bot.setControlState('forward', false);
    }
    await sleepMs(ctx, 400);
  }
  return isEndDimension(currentDimension(ctx));
}

async function activateEndPortal(args, ctx) {
  const dimension = currentDimension(ctx);
  if (isEndDimension(dimension)) {
    return { detail: '已经在末地，不需要再激活末地门', status: 'succeeded' };
  }
  if (!isOverworldDimension(dimension)) {
    throw new Error(`当前在${dimensionLabel(dimension)}，末地门只在主世界的要塞里`);
  }

  const radius = clampNumber(args.radius, DEFAULT_FRAME_RADIUS, 8, 64);
  const timeoutMs = clampNumber(args.timeout_s, 120, 20, 300) * 1000;
  const deadline = Date.now() + timeoutMs;

  let frames = findFramesNearby(ctx, radius);
  if (frames.length < PORTAL_FRAME_COUNT && radius < 64) {
    frames = findFramesNearby(ctx, Math.min(radius * 2, 64));
  }
  if (frames.length === 0) {
    throw new Error(`附近 ${radius} 格内没有末地门框架，先用 throw_eye 找到要塞`);
  }
  if (frames.length < PORTAL_FRAME_COUNT) {
    throw new Error(
      `只找到 ${frames.length} 个末地门框架，还差 ${PORTAL_FRAME_COUNT - frames.length} 个，` +
        '可能还没走到要塞的传送门房间',
    );
  }

  const filledBefore = frames.filter(frameHasEye).length;
  const need = Math.max(0, PORTAL_FRAME_COUNT - filledBefore);
  const eyes = ctx.countItem(EYE_ITEM);
  if (need > 0 && eyes < need) {
    throw new Error(`还差 ${need - eyes} 个末影之眼，填满 ${PORTAL_FRAME_COUNT} 个框架需要 ${need} 个`);
  }

  let inserted = 0;
  const failures = [];
  if (need > 0) {
    const unfilled = frames
      .filter((frame) => !frameHasEye(frame))
      .sort((a, b) => {
        const bot = botOf(ctx);
        const da = bot.entity.position.distanceTo(a.position);
        const db = bot.entity.position.distanceTo(b.position);
        return da - db;
      })
      .slice(0, need);
    for (const frame of unfilled) {
      if (Date.now() > deadline) break;
      const ok = await insertEye(ctx, frame);
      if (ok) inserted += 1;
      else failures.push(`${frame.position.x}, ${frame.position.y}, ${frame.position.z}`);
      await sleepMs(ctx, 250);
    }
  }

  frames = findFramesNearby(ctx, Math.min(radius * 2, 64));
  const filledAfter = frames.filter(frameHasEye).length;
  if (filledAfter < PORTAL_FRAME_COUNT) {
    throw new Error(
      `还差 ${PORTAL_FRAME_COUNT - filledAfter} 个末地门框架没有眼，` +
        `已填入 ${inserted} 个${failures.length ? `，失败位置 ${failures.join('；')}` : ''}`,
    );
  }

  let portals = findBlockPositions(ctx, PORTAL_BLOCK, 24, 8);
  if (portals.length === 0) {
    await sleepMs(ctx, 1200);
    portals = findBlockPositions(ctx, PORTAL_BLOCK, 32, 8);
  }
  if (portals.length === 0) {
    throw new Error(`${PORTAL_FRAME_COUNT} 个框架都填满了，但没有出现末地门`);
  }
  const portal = portals[0];
  const entered = await enterEndPortal(ctx, portal, Math.max(5000, deadline - Date.now()));
  if (!entered) {
    throw new Error('末地门已激活，但走进门后没有切到末地');
  }
  const position = botOf(ctx).entity.position;
  return {
    detail:
      `填了 ${inserted} 个末地门框架（原有 ${filledBefore} 个），` +
      `从 (${Math.floor(portal.x)}, ${Math.floor(portal.y)}, ${Math.floor(portal.z)}) 进入末地，` +
      `现在在 (${Math.floor(position.x)}, ${Math.floor(position.y)}, ${Math.floor(position.z)})`,
    status: 'succeeded',
  };
}

// ------------------------------------------------------------------ 技能：末影龙

async function clearCrystals(ctx, radius, deadline) {
  const broken = new Set();
  const notes = [];
  let failed = 0;
  let guard = 0;

  while (Date.now() < deadline && guard < 40) {
    guard += 1;
    const crystals = findEntities(ctx, CRYSTAL_ENTITY, radius);
    if (crystals.length === 0) break;
    const crystal = crystals[0];
    const distance = distanceToBot(ctx, crystal);

    try {
      if (distance < 12) {
        await ctx.retreatFrom(crystal);
      }
      const ranged =
        typeof ctx.findRangedWeapon === 'function' ? ctx.findRangedWeapon() : null;
      if (ranged && typeof ctx.shootAt === 'function') {
        const shot = await ctx.shootAt(crystal);
        if (!shot) notes.push('弓没有射出去');
      } else if (typeof ctx.approach === 'function') {
        await ctx.approach(crystal);
        botOf(ctx).attack(crystal);
      }
    } catch (error) {
      notes.push(`打水晶失败：${error.message}`);
    }

    const gone = await waitEntityGone(ctx, crystal, 5000);
    if (gone) broken.add(crystal.id);
    else failed += 1;

    const bot = botOf(ctx);
    if (Number(bot.health) <= 8 && typeof ctx.findFoodForEating === 'function') {
      const food = ctx.findFoodForEating();
      if (food && typeof ctx.eatFood === 'function') {
        try {
          await ctx.eatFood({ item: food.name, count: 1 });
        } catch (error) {
          notes.push(`进食失败：${error.message}`);
        }
      }
    }
    await sleepMs(ctx, 1200);
  }

  const left = findEntities(ctx, CRYSTAL_ENTITY, radius).length;
  return { broken: broken.size, failed, left, notes };
}

async function moveToArenaCenter(ctx) {
  const bot = botOf(ctx);
  const position = bot.entity.position;
  if (Math.hypot(position.x, position.z) <= 10) return;
  try {
    await ctx.travelTo(0, Math.floor(position.y), 0, 6);
  } catch (error) {
    log(ctx, '回中央祭坛失败', error.message);
  }
}

async function fightDragon(args, ctx) {
  const bot = botOf(ctx);
  if (!isEndDimension(currentDimension(ctx))) {
    throw new Error(`当前在${dimensionLabel(currentDimension(ctx))}，末影龙只在末地`);
  }

  const radius = clampNumber(args.radius, DEFAULT_DRAGON_RADIUS, 16, 128);
  const timeoutMs = clampNumber(args.timeout_s, 240, 30, 300) * 1000;
  const deadline = Date.now() + timeoutMs;
  const notes = [];

  let dragon = findEntity(ctx, DRAGON_ENTITY, radius);
  if (!dragon) {
    const waitUntil = Math.min(deadline, Date.now() + 8000);
    while (!dragon && Date.now() < waitUntil) {
      await sleepMs(ctx, 500);
      dragon = findEntity(ctx, DRAGON_ENTITY, radius);
    }
  }
  if (!dragon) {
    if (findBlockPositions(ctx, PORTAL_BLOCK, radius, 4).length > 0) {
      return { detail: '末影龙已经不在了，末地中央有返回传送门', status: 'succeeded' };
    }
    throw new Error('附近没有末影龙，可能还没生成');
  }

  const crystalResult = await clearCrystals(ctx, radius, deadline);
  notes.push(...crystalResult.notes);
  if (crystalResult.left > 0) {
    throw new Error(
      `还差 ${crystalResult.left} 个末地水晶没有打碎，末影龙会一直回血` +
        (notes.length ? `（${notes.slice(-3).join('，')}）` : ''),
    );
  }

  let lastDetail = '';
  let lastHealth = Number(dragon.health);
  while (Date.now() < deadline) {
    dragon = findEntity(ctx, DRAGON_ENTITY, radius);
    if (!dragon) {
      return {
        detail:
          `击败了末影龙，打碎 ${crystalResult.broken} 个末地水晶` +
          (notes.length ? `；过程记录：${notes.slice(-3).join('，')}` : ''),
        status: 'succeeded',
      };
    }
    lastHealth = Number(dragon.health);
    if (Number.isFinite(lastHealth) && lastHealth <= 0) {
      return {
        detail: `末影龙血量归零，打碎 ${crystalResult.broken} 个末地水晶`,
        status: 'succeeded',
      };
    }

    const health = Number(bot.health);
    if (health <= 6) {
      if (typeof ctx.findFoodForEating === 'function' && typeof ctx.eatFood === 'function') {
        const food = ctx.findFoodForEating();
        if (food) {
          try {
            await ctx.eatFood({ item: food.name, count: 1 });
          } catch (error) {
            notes.push(`进食失败：${error.message}`);
          }
        }
      }
      if (Number(bot.health) <= 6) {
        try {
          await ctx.retreatFrom(dragon);
        } catch (error) {
          notes.push(`后撤失败：${error.message}`);
        }
        await sleepMs(ctx, 800);
        continue;
      }
    }

    const threat =
      findEntity(ctx, 'dragon_fireball', 12) || findEntity(ctx, 'area_effect_cloud', 8);
    if (threat) {
      try {
        await ctx.retreatFrom(threat);
      } catch (error) {
        notes.push(`躲龙息失败：${error.message}`);
      }
      await sleepMs(ctx, 500);
      continue;
    }

    const perched = isDragonPerched(dragon, bot);
    const distance = distanceToBot(ctx, dragon);
    try {
      if (perched) {
        if (typeof ctx.approach === 'function') await ctx.approach(dragon);
        const detail = await ctx.attackEntity(dragon);
        if (detail) lastDetail = detail;
      } else {
        const ranged =
          typeof ctx.findRangedWeapon === 'function' ? ctx.findRangedWeapon() : null;
        if (ranged && typeof ctx.shootAt === 'function' && distance > 5) {
          const shot = await ctx.shootAt(dragon);
          if (!shot) notes.push('龙在射程外，射击没有命中');
        } else {
          await moveToArenaCenter(ctx);
        }
      }
    } catch (error) {
      notes.push(`攻击失败：${error.message}`);
    }
    await sleepMs(ctx, 500);
  }

  const remaining = Number.isFinite(lastHealth) ? Math.max(1, Math.ceil(lastHealth)) : 1;
  throw new Error(
    `还差 ${remaining} 点血才能击杀末影龙` +
      (lastDetail ? `（${lastDetail}）` : '') +
      (notes.length ? `；${notes.slice(-3).join('，')}` : ''),
  );
}

// ------------------------------------------------------------------ 技能：返回主世界

async function returnHome(args, ctx) {
  const bot = botOf(ctx);
  const dimension = currentDimension(ctx);
  if (isOverworldDimension(dimension)) {
    const position = bot.entity.position;
    return {
      detail: `已经在主世界 (${Math.floor(position.x)}, ${Math.floor(position.y)}, ${Math.floor(position.z)})`,
      status: 'succeeded',
    };
  }
  if (!isEndDimension(dimension)) {
    throw new Error(`当前在${dimensionLabel(dimension)}，这里没有回主世界的末地门`);
  }

  const timeoutMs = clampNumber(args.timeout_s, 60, 10, 180) * 1000;
  const position = bot.entity.position;
  if (Math.hypot(position.x, position.z) > 48) {
    try {
      await ctx.travelTo(0, Math.floor(position.y), 0, 6);
    } catch (error) {
      log(ctx, '回中央祭坛失败', error.message);
    }
  }

  let portals = findBlockPositions(ctx, PORTAL_BLOCK, 48, 8);
  if (portals.length === 0) portals = findBlockPositions(ctx, PORTAL_BLOCK, 96, 8);
  if (portals.length === 0) {
    throw new Error('附近没有返回传送门，末影龙还活着时不会出现');
  }

  const origin = bot.entity.position;
  portals.sort((a, b) => origin.distanceTo(a) - origin.distanceTo(b));
  const portal = portals[0];
  const entered = await enterEndPortal(ctx, portal, timeoutMs);
  if (!entered) {
    throw new Error('走进了返回传送门，但没有回到主世界');
  }
  const now = botOf(ctx).entity.position;
  return {
    detail:
      `从 (${Math.floor(portal.x)}, ${Math.floor(portal.y)}, ${Math.floor(portal.z)}) 的返回传送门回到主世界，` +
      `现在在 (${Math.floor(now.x)}, ${Math.floor(now.y)}, ${Math.floor(now.z)})`,
    status: 'succeeded',
  };
}

// ------------------------------------------------------------------ 导出

export const skills = {
  throw_eye: {
    description:
      '在主世界投掷末影之眼找要塞：朝当前朝向抛眼，跟踪飞行方向，按需朝该方向前进一段；多次投掷会用射线求交估算要塞坐标，靠近框架后自动停下。',
    parameters: [
      { name: 'count', type: 'number', required: false, default: 3, description: '最多投几次，范围 1-12。' },
      { name: 'advance', type: 'number', required: false, default: 0, description: '每次投掷后朝眼飞的方向走多少格，0 表示原地投。' },
      { name: 'frame_radius', type: 'number', required: false, default: 24, description: '发现末地门框架的搜索半径，范围 8-64 格。' },
      { name: 'timeout_s', type: 'number', required: false, default: 180, description: '整个寻找过程的最长用时，范围 20-300 秒。' },
    ],
    handler: throwEye,
  },
  activate_end_portal: {
    description:
      '在要塞里激活末地门：找齐 12 个末地门框架，把背包里的末影之眼逐个放进去，确认末地门出现后走进去；缺眼或框架不齐会报出还差多少。',
    parameters: [
      { name: 'radius', type: 'number', required: false, default: DEFAULT_FRAME_RADIUS, description: '搜索末地门框架的半径，范围 8-64 格。' },
      { name: 'timeout_s', type: 'number', required: false, default: 120, description: '激活并进门的最长用时，范围 20-300 秒。' },
    ],
    handler: activateEndPortal,
  },
  fight_dragon: {
    description:
      '打末影龙：先打碎末地水晶阻止回血，再在龙停到中央祭坛时近战、在空中时用弓射；血量低会进食后撤，躲开龙息与火球，龙死后回报实际剩余血量。',
    parameters: [
      { name: 'radius', type: 'number', required: false, default: DEFAULT_DRAGON_RADIUS, description: '搜索末影龙与水晶的半径，范围 16-128 格。' },
      { name: 'timeout_s', type: 'number', required: false, default: 240, description: '整场战斗的最长用时，范围 30-300 秒。' },
    ],
    handler: fightDragon,
  },
  return_home: {
    description:
      '从末地返回主世界：走到中央祭坛的返回传送门并穿过去，确认维度切回主世界；龙还活着、传送门没出现时会说明原因。',
    parameters: [
      { name: 'timeout_s', type: 'number', required: false, default: 60, description: '走到传送门并完成传送的最长用时，范围 10-180 秒。' },
    ],
    handler: returnHome,
  },
};
