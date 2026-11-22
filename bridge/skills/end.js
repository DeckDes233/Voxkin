// 末地模块：末影之眼定位、激活末地门、末影龙战斗、返回主世界。
// 契约见 docs/plans/SKILL_MODULE_CONTRACT.md；对应路线图 M8.1-M8.5。
//
// 约束：
// - 只用 ctx 提供的能力，不 import 任何运行时依赖；bot 从 ctx.bot 取。
// - 模块之间不互相 import；需要别的技能时走 ctx 的技能入口，缺了就在结果里说明。
// - 射线求交、框架状态、龙是否停在中央都是纯函数，单独导出，方便脱离游戏单测。
// - 结果只写真实读到的背包数量、实体与坐标，不凭空说「龙已死」「门已开」。
//
// 跨模块战斗通过 ctx.runSkill 共享当前动作的取消与进度回执。

// ------------------------------------------------------------------ 常量

import { dryMiningFooting, miningRouteExclusion } from '../dry_footing.js';
import { dragonHealth } from '../world_observation.js';

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
const S6_DESCENT_SEGMENT_LAYERS = 8;
const S6_MAX_DESCENT_LAYERS = 96;
const S6_MIN_DESCENT_HEALTH = 12;
const S6_FRAME_RADIUS = 64;

// ------------------------------------------------------------------ 纯逻辑

export function isEndDimension(dimension) {
  const text = String(dimension || '').trim().toLowerCase();
  return text === END_DIMENSION || text === 'the_end';
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
  const phaseIndex = bot.registry?.entitiesByName?.ender_dragon?.metadataKeys?.indexOf('phase');
  const phase = entity.metadata?.[phaseIndex];
  if (Number.isInteger(phase)) return phase >= 5 && phase <= 7;
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

function isExpectedDimension(ctx, expected) {
  const actual = currentDimension(ctx);
  if (expected === END_DIMENSION) return isEndDimension(actual);
  if (expected === OVERWORLD_DIMENSION) {
    return actual === OVERWORLD_DIMENSION || actual === 'overworld';
  }
  return actual === expected;
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
    .filter((block) => block && block.name === FRAME_BLOCK);
}

function countItemIfKnown(ctx, name) {
  if (typeof ctx.countItem === 'function') {
    try {
      const count = Number(ctx.countItem(name));
      return Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
    } catch {
      return null;
    }
  }
  const inventory = botOf(ctx).inventory;
  if (!inventory || typeof inventory.items !== 'function') return null;
  const matches = inventory.items().filter((item) => item && item.name === name);
  if (matches.some((item) => !Number.isFinite(Number(item.count)) || Number(item.count) < 0)) return null;
  return matches.reduce((total, item) => total + Number(item.count), 0);
}

function finitePosition(position) {
  return Boolean(position) && ['x', 'y', 'z'].every((axis) => Number.isFinite(Number(position[axis])));
}

function scanFramesFresh(ctx, radius = S6_FRAME_RADIUS) {
  const dimensionBefore = currentDimension(ctx);
  if (!isOverworldDimension(dimensionBefore)) {
    return { fresh: false, stable: false, dimension: dimensionBefore, radius, frames: [] };
  }
  const bot = botOf(ctx);
  if (typeof bot.blockAt !== 'function' || (typeof bot.findBlocks !== 'function' && typeof bot.findBlock !== 'function')) {
    return { fresh: false, stable: true, dimension: dimensionBefore, radius, frames: [] };
  }
  let positions = [];
  try {
    if (typeof bot.findBlocks === 'function') {
      positions = bot.findBlocks({
        point: bot.entity.position,
        matching: (block) => Boolean(block && block.name === FRAME_BLOCK),
        maxDistance: radius,
        count: 32,
      }) || [];
    } else {
      const frame = bot.findBlock({
        point: bot.entity.position,
        matching: (block) => Boolean(block && block.name === FRAME_BLOCK),
        maxDistance: radius,
      });
      positions = frame ? [frame.position] : [];
    }
  } catch (error) {
    log(ctx, 'fresh frame scan 失败', error.message);
    const dimensionAfter = currentDimension(ctx);
    return {
      fresh: false,
      stable: dimensionBefore === dimensionAfter && isOverworldDimension(dimensionAfter),
      dimension: dimensionAfter,
      radius,
      frames: [],
    };
  }
  let fresh = true;
  const frames = [];
  for (const position of positions) {
    if (!finitePosition(position)) {
      fresh = false;
      continue;
    }
    const block = bot.blockAt(position);
    if (!block) {
      fresh = false;
      continue;
    }
    if (block.name !== FRAME_BLOCK) continue;
    const actualPosition = block.position || position;
    if (!finitePosition(actualPosition)) {
      fresh = false;
      continue;
    }
    frames.push(copyPosition(actualPosition));
  }
  const dimensionAfter = currentDimension(ctx);
  return {
    fresh,
    stable: dimensionBefore === dimensionAfter && isOverworldDimension(dimensionAfter),
    dimension: dimensionAfter,
    radius,
    frames,
  };
}

function eyeAccounting(ctx, throwsCompleted, inventoryBefore) {
  const inventoryAfter = countItemIfKnown(ctx, EYE_ITEM);
  return {
    throws_completed: throwsCompleted,
    inventory_before: inventoryBefore,
    inventory_after: inventoryAfter,
    inventory_net_change:
      inventoryBefore !== null && inventoryAfter !== null
        ? inventoryAfter - inventoryBefore
        : null,
  };
}

function makeStrongholdSearch(ctx, {
  phase,
  estimate,
  throwsCompleted,
  inventoryBefore,
  evidence,
  layersCompleted = 0,
  scan,
  stopReason = '',
  searchId = null,
}) {
  const search = {
    schema_version: 1,
    search_id: searchId,
    phase,
    evidence,
    estimate: estimate ? { ...estimate } : null,
    eye_accounting: eyeAccounting(ctx, throwsCompleted, inventoryBefore),
    position: copyPosition(botOf(ctx).entity.position),
    descent: {
      layers_completed: layersCompleted,
      max_layers: S6_MAX_DESCENT_LAYERS,
      segment_layers: S6_DESCENT_SEGMENT_LAYERS,
    },
    scan,
  };
  if (stopReason) search.stop_reason = String(stopReason).slice(0, 240);
  return search;
}

function searchReceipt(status, detail, search) {
  return { status, detail, data: { stronghold_search: search } };
}

function safeSearchContext(raw) {
  if (!raw || typeof raw !== 'object' || raw.schema_version !== 1) return null;
  if (typeof raw.search_id !== 'string' || !raw.search_id.trim()) return null;
  if (!['descend', 'blocked', 'frames_found'].includes(raw.phase)) return null;
  if (!finitePosition(raw.position)) return null;
  const evidence = raw.evidence;
  if (!evidence || typeof evidence !== 'object' || evidence.kind !== 'eye_overhead') return null;
  if (!finitePosition(evidence.throw_origin) || !finitePosition(evidence.eye_position)) return null;
  if (Number(evidence.eye_position.y) > Number(evidence.throw_origin.y) + 0.25) return null;
  const horizontalDistance = Number(evidence.horizontal_distance);
  if (!Number.isFinite(horizontalDistance) || horizontalDistance < 0 || horizontalDistance >= 20) return null;
  const accounting = raw.eye_accounting;
  const throws = Number(accounting && accounting.throws_completed);
  const layers = Number(raw.descent && raw.descent.layers_completed);
  if (!Number.isInteger(throws) || throws < 1) return null;
  if (!Number.isInteger(layers) || layers < 0 || layers > S6_MAX_DESCENT_LAYERS) return null;
  if (raw.estimate !== null && raw.estimate !== undefined) {
    if (!Number.isFinite(Number(raw.estimate.x)) || !Number.isFinite(Number(raw.estimate.z))) return null;
  }
  return raw;
}

function blockedSearchReceipt(search, reason, allowExplicitResume = false) {
  const layers = Number(search && search.descent && search.descent.layers_completed);
  const maximum = Number(search && search.descent && search.descent.max_layers);
  const resumeAllowed = Boolean(
    allowExplicitResume &&
    search &&
    search.phase === 'descend' &&
    search.evidence &&
    search.evidence.kind === 'eye_overhead' &&
    finitePosition(search.position) &&
    Number.isInteger(layers) &&
    Number.isInteger(maximum) &&
    layers >= 0 &&
    layers < maximum &&
    maximum <= S6_MAX_DESCENT_LAYERS
  );
  return searchReceipt('partial', `要塞下探已停止：${reason}`, {
    ...search,
    phase: 'blocked',
    resume_allowed: resumeAllowed,
    stop_reason: String(reason).slice(0, 240),
  });
}

function freshFrameSearch(search, scan, ctx) {
  return {
    ...search,
    phase: scan.fresh && scan.stable && scan.frames.length > 0 ? 'frames_found' : search.phase,
    position: copyPosition(botOf(ctx).entity.position),
    scan,
  };
}

async function continueStrongholdSearch(raw, ctx) {
  let search = safeSearchContext(raw);
  if (!search) {
    return searchReceipt('partial', '保存的要塞搜索上下文无效；不会重新投掷末影之眼', {
      schema_version: 1,
      search_id: raw && typeof raw.search_id === 'string' ? raw.search_id : null,
      phase: 'blocked',
      evidence: raw && raw.evidence ? raw.evidence : null,
      estimate: raw && raw.estimate ? raw.estimate : null,
      eye_accounting: raw && raw.eye_accounting ? raw.eye_accounting : null,
      position: copyPosition(botOf(ctx).entity.position),
      descent: { layers_completed: 0, max_layers: S6_MAX_DESCENT_LAYERS, segment_layers: S6_DESCENT_SEGMENT_LAYERS },
      scan: null,
      stop_reason: 'invalid_search_context',
    });
  }
  if (search.phase === 'blocked' && search.resume_allowed === true) {
    search = { ...search, phase: 'descend', resume_allowed: false };
  }
  if (search.phase !== 'descend') {
    return blockedSearchReceipt(search, search.stop_reason || `当前阶段 ${search.phase} 不允许继续下探`);
  }
  if (!isOverworldDimension(currentDimension(ctx))) {
    return blockedSearchReceipt(search, '角色当前不在主世界');
  }
  if (!search.scan || !isOverworldDimension(search.scan.dimension)) {
    return blockedSearchReceipt(search, '保存的搜索维度未确认主世界；不会跨维度复用 eye-overhead 证据');
  }

  const bot = botOf(ctx);
  const savedPosition = search.position;
  const currentPosition = copyPosition(bot.entity.position);
  if (
    Math.floor(savedPosition.x) !== Math.floor(currentPosition.x) ||
    Math.floor(savedPosition.y) !== Math.floor(currentPosition.y) ||
    Math.floor(savedPosition.z) !== Math.floor(currentPosition.z)
  ) {
    return blockedSearchReceipt({ ...search, position: currentPosition }, '角色位置已变化；不会在未核对的地点继续下探');
  }
  const health = Number(bot.health);
  if (!Number.isFinite(health) || health <= S6_MIN_DESCENT_HEALTH) {
    return blockedSearchReceipt(search, `生命值不足或未确认（需高于 ${S6_MIN_DESCENT_HEALTH}）`, true);
  }
  if (typeof ctx.findHostile !== 'function') {
    return blockedSearchReceipt(search, '缺少附近敌对生物检查能力', true);
  }
  const hostile = ctx.findHostile(12);
  if (hostile) {
    return blockedSearchReceipt(search, `附近有敌对生物 ${String(hostile.name || '未知')}，停止下探`, true);
  }
  if (typeof ctx.runSkill !== 'function') {
    return blockedSearchReceipt(search, '缺少 safe_descend 技能入口', true);
  }

  let scan = scanFramesFresh(ctx, S6_FRAME_RADIUS);
  if (!scan.fresh || !scan.stable) {
    return blockedSearchReceipt({ ...search, scan, position: currentPosition }, 'fresh frame scan 未取得可重查的门框区块与稳定主世界维度', true);
  }
  if (scan.frames.length > 0) {
    return searchReceipt('succeeded', `fresh scan 在 ${scan.radius} 格内观察到 ${scan.frames.length} 个末地门框架`, {
      ...freshFrameSearch(search, scan, ctx),
      phase: 'frames_found',
    });
  }

  const descent = search.descent || {};
  const layersBefore = Number(descent.layers_completed);
  const remainingBudget = S6_MAX_DESCENT_LAYERS - layersBefore;
  if (remainingBudget <= 0) return blockedSearchReceipt(search, `已达到 ${S6_MAX_DESCENT_LAYERS} 层下探预算`);

  let layersCompleted = layersBefore;
  const segmentLimit = Math.min(S6_DESCENT_SEGMENT_LAYERS, remainingBudget);
  for (let index = 0; index < segmentLimit; index += 1) {
    throwIfInterrupted(ctx, '继续搜索要塞');
    if (!isOverworldDimension(currentDimension(ctx))) {
      return blockedSearchReceipt({ ...search, descent: { ...descent, layers_completed: layersCompleted } }, '下探过程中维度发生变化');
    }
    const currentHealth = Number(bot.health);
    if (!Number.isFinite(currentHealth) || currentHealth <= S6_MIN_DESCENT_HEALTH) {
      return blockedSearchReceipt({ ...search, descent: { ...descent, layers_completed: layersCompleted } }, `生命值降到安全阈值 ${S6_MIN_DESCENT_HEALTH} 或未确认`, true);
    }
    const nearbyHostile = ctx.findHostile(12);
    if (nearbyHostile) {
      return blockedSearchReceipt({ ...search, descent: { ...descent, layers_completed: layersCompleted } }, `出现敌对生物 ${String(nearbyHostile.name || '未知')}，停止下探`, true);
    }
    const before = copyPosition(bot.entity.position);
    const beforeY = Math.floor(before.y);
    if (beforeY <= -64) {
      return blockedSearchReceipt({ ...search, descent: { ...descent, layers_completed: layersCompleted } }, '已到世界底部 Y=-64');
    }
    try {
      await ctx.runSkill('safe_descend', {
        targetY: Math.max(-64, beforeY - 1),
        maxLayers: 1,
        fill: false,
        detour: false,
      });
      throwIfInterrupted(ctx, '继续搜索要塞');
    } catch (error) {
      throwIfInterrupted(ctx, '继续搜索要塞');
      return blockedSearchReceipt({
        ...search,
        position: copyPosition(bot.entity.position),
        scan: {
          fresh: false,
          stable: false,
          dimension: currentDimension(ctx),
          radius: S6_FRAME_RADIUS,
          frames: [],
        },
        descent: { ...descent, layers_completed: layersCompleted },
      }, `safe_descend 停止：${String((error && error.message) || error)}`);
    }
    const after = copyPosition(bot.entity.position);
    const afterY = Math.floor(after.y);
    if (
      afterY !== beforeY - 1 ||
      Math.floor(after.x) !== Math.floor(before.x) ||
      Math.floor(after.z) !== Math.floor(before.z)
    ) {
      return blockedSearchReceipt({
        ...search,
        position: after,
        scan: {
          fresh: false,
          stable: false,
          dimension: currentDimension(ctx),
          radius: S6_FRAME_RADIUS,
          frames: [],
        },
        descent: { ...descent, layers_completed: layersCompleted },
      }, '下降后未确认只向下移动一层且水平位置未变');
    }
    layersCompleted += 1;
    scan = scanFramesFresh(ctx, S6_FRAME_RADIUS);
    const updated = {
      ...search,
      position: after,
      descent: { ...descent, layers_completed: layersCompleted },
      scan,
    };
    if (!scan.fresh || !scan.stable) {
      return blockedSearchReceipt(updated, 'fresh frame scan 未取得可重查的门框区块与稳定主世界维度', true);
    }
    if (scan.frames.length > 0) {
      return searchReceipt('succeeded', `下探 ${layersCompleted} 层后在 ${scan.radius} 格内观察到 ${scan.frames.length} 个末地门框架`, {
        ...updated,
        phase: 'frames_found',
      });
    }
    search = updated;
  }

  return searchReceipt('partial', `已安全下探 ${layersCompleted} 层，fresh scan 尚未观察到末地门框架`, {
    ...search,
    phase: 'descend',
    position: copyPosition(bot.entity.position),
    descent: { ...descent, layers_completed: layersCompleted },
    scan,
  });
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
    throwIfInterrupted(ctx, '等待实体状态');
    if (entityGone(ctx, entity)) return true;
    await sleepMs(ctx, 200);
  }
  return entityGone(ctx, entity);
}

async function activateOnce(ctx) {
  throwIfInterrupted(ctx, '使用末影之眼');
  const bot = botOf(ctx);
  await bot.activateItem();
  try {
    await sleepMs(ctx, 120);
  } finally {
    if (typeof bot.deactivateItem === 'function') await bot.deactivateItem();
  }
  throwIfInterrupted(ctx, '使用末影之眼');
}

// 跟踪刚投出的末影之眼，保留最后坐标与实体是否已经消失。
async function trackEye(ctx, knownIds, durationMs) {
  const deadline = Date.now() + durationMs;
  let eye = null;
  let last = null;
  while (Date.now() < deadline) {
    throwIfInterrupted(ctx, '跟踪末影之眼');
    await sleepMs(ctx, 100);
    const candidates = eyeEntities(ctx).filter((entity) => entity && !knownIds.has(entity.id));
    if (candidates.length > 0) eye = candidates[0];
    if (eye && eye.position) last = copyPosition(eye.position);
    if (eye && entityGone(ctx, eye)) break;
  }
  return last ? { position: last, settled: Boolean(eye && entityGone(ctx, eye)) } : null;
}

async function moveToward(ctx, x, z, radius = 3) {
  throwIfInterrupted(ctx, '靠近要塞');
  const bot = botOf(ctx);
  const y = Math.floor(bot.entity.position.y);
  try {
    if (typeof ctx.walkOnce === 'function') {
      const outcome = await ctx.walkOnce(Math.floor(x), y, Math.floor(z), radius, 45000, true);
      throwIfInterrupted(ctx, '靠近要塞');
      return outcome === 'reached' && Math.hypot(bot.entity.position.x - x, bot.entity.position.z - z) <= radius + 1;
    }
    const result = await ctx.travelTo(Math.floor(x), y, Math.floor(z), radius);
    const position = bot.entity.position;
    if (![position.x, position.z].every(Number.isFinite)) return false;
    if (Math.hypot(position.x - x, position.z - z) > radius + 1) return false;
    if (result && Number.isFinite(result.distance) && result.distance > radius + 2) {
      return false;
    }
    return true;
  } catch (error) {
    throwIfInterrupted(ctx, '靠近要塞');
    log(ctx, '朝目标移动失败', error.message);
    return false;
  }
}

// ------------------------------------------------------------------ 技能：投掷末影之眼

async function throwEye(args, ctx) {
  throwIfInterrupted(ctx, '寻找要塞');
  const bearing = args?.resume_search?.phase === 'bearing' ? args.resume_search : null;
  if (!bearing && args && args.resume_search !== undefined) {
    return continueStrongholdSearch(args.resume_search, ctx);
  }
  const bot = botOf(ctx);
  const dimension = currentDimension(ctx);
  if (isEndDimension(dimension)) {
    throw new Error('已经在末地，不需要再投末影之眼');
  }
  if (!isOverworldDimension(dimension)) {
    throw new Error(`当前在${dimensionLabel(dimension)}，末影之眼只用来在主世界找要塞`);
  }

  const maxThrows = clampNumber(args.count, DEFAULT_EYE_THROWS, 1, 12);
  const advance = Math.min(96, clampNumber(args.advance, 0, 0, 256));
  const frameRadius = clampNumber(args.frame_radius, 24, 8, 64);
  const timeoutMs = clampNumber(args.timeout_s, 180, 20, 300) * 1000;
  const deadline = Date.now() + timeoutMs;

  let throws = bearing?.eye_accounting?.throws_completed ?? 0;
  let lastDirection = null;
  const throwRecords = [];
  const notes = [];
  const inventoryBefore = bearing?.eye_accounting?.inventory_before ?? countItemIfKnown(ctx, EYE_ITEM);
  let overheadEvidence = null;
  let lastFrameScan = null;
  const estimatedPosition = () => estimateStronghold(throwRecords);
  const makeSearch = (phase, scan = lastFrameScan, stopReason = '') => makeStrongholdSearch(ctx, {
    phase,
    searchId: bearing?.search_id ?? null,
    estimate: estimatedPosition(),
    throwsCompleted: throws,
    inventoryBefore,
    evidence: overheadEvidence || {
      kind: estimatedPosition() ? 'direction_estimate_only' : 'direction_insufficient',
      throw_origin: throwRecords.length > 0 ? { x: throwRecords.at(-1).x, y: Math.floor(bot.entity.position.y), z: throwRecords.at(-1).z } : null,
    },
    scan,
    stopReason,
  });

  if (bearing) {
    const old = bearing.evidence;
    if (!bearing.search_id || !isOverworldDimension(bearing.scan?.dimension) || old?.kind !== 'eye_bearing' ||
        !finitePosition(old.throw_origin) || !finitePosition(old.eye_position) || !Number.isInteger(throws) || throws < 1 || throws >= maxThrows) {
      throw new Error('投眼方向或剩余次数无法确认');
    }
    const origin = old.throw_origin;
    const direction = normalizeVector(old.eye_position.x - origin.x, old.eye_position.z - origin.z);
    if (!direction) throw new Error('投眼轨迹没有可用水平方向');
    const scan = scanFramesFresh(ctx, S6_FRAME_RADIUS);
    if (!scan.fresh || !scan.stable) throw new Error('续跑前无法确认当前主世界区块');
    if (scan.frames.length) return searchReceipt('succeeded', '恢复时在附近观察到末地门框', makeSearch('frames_found', scan));
    if (Math.hypot(bot.entity.position.x - origin.x, bot.entity.position.z - origin.z) < 8 &&
        !await moveToward(ctx, origin.x + direction.dx * 32, origin.z + direction.dz * 32)) {
      return searchReceipt('partial', '恢复时未走到新投眼地点', { ...bearing, phase: 'blocked', resume_allowed: false });
    }
    throwRecords.push({ x: origin.x, z: origin.z, ...direction });
  }
  while (throws < maxThrows && Date.now() < deadline) {
    throwIfInterrupted(ctx, '寻找要塞');
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
    throwIfInterrupted(ctx, '寻找要塞');
    await bot.look(yaw, 0, true);
    // 发出下一次使用前撤销上一投的检查点，避免中断时按旧库存对账。
    ctx.reportProgress?.('throwing_eye', '正在投掷末影之眼', 0);
    await activateOnce(ctx);
    throws += 1;

    const observed = await trackEye(ctx, knownIds, 4800);
    throwIfInterrupted(ctx, '寻找要塞');
    let direction = fallback;
    let eyeDistance = null;
    if (observed) {
      eyeDistance = Math.hypot(observed.position.x - origin.x, observed.position.z - origin.z);
      const fromFlight = normalizeVector(observed.position.x - origin.x, observed.position.z - origin.z);
      if (fromFlight) direction = fromFlight;
    } else {
      notes.push('未观察到飞行实体，停止按方向移动');
    }

    lastDirection = observed ? direction : null;
    if (observed) throwRecords.push({
      x: origin.x,
      z: origin.z,
      dx: direction.dx,
      dz: direction.dz,
    });
    if (throwRecords.length > MAX_THROW_RECORDS) {
      throwRecords.splice(0, throwRecords.length - MAX_THROW_RECORDS);
    }

    if (observed?.settled && observed.position.y <= origin.y + 0.25 && eyeDistance !== null && eyeDistance < 20) {
      overheadEvidence = {
        kind: 'eye_overhead',
        throw_origin: origin,
        eye_position: observed.position,
        horizontal_distance: eyeDistance,
      };
    }

    lastFrameScan = scanFramesFresh(ctx, frameRadius);
    if (observed && lastFrameScan.fresh && lastFrameScan.stable) {
      const checkpoint = makeSearch(overheadEvidence ? 'descend' : throws < maxThrows ? 'bearing' : 'blocked', lastFrameScan);
      checkpoint.throw_limit = maxThrows;
      if (!overheadEvidence) {
        checkpoint.evidence = { kind: 'eye_bearing', throw_origin: origin, eye_position: observed.position };
        checkpoint.stop_reason = '沿已观察的投眼方向移动时中断';
      }
      ctx.reportProgress?.('eye_observed', '已记录末影之眼轨迹与实际库存', 0, { stronghold_search: checkpoint });
    }
    if (!lastFrameScan.fresh || !lastFrameScan.stable) {
      return searchReceipt('partial', '投眼后 fresh frame scan 无法重查门框区块或未确认稳定主世界；已保留搜索账本',
        makeSearch('blocked', lastFrameScan, 'frame_scan_dimension_unverified'));
    }
    if (lastFrameScan.frames.length > 0) {
      return {
        detail:
          `第 ${throws} 次投掷后，在 ${frameRadius} 格内发现 ${lastFrameScan.frames.length} 个末地门框架，` +
          `方向 (${direction.dx.toFixed(2)}, ${direction.dz.toFixed(2)})，可以开始激活末地门`,
        status: 'succeeded',
        data: { stronghold_search: { ...makeSearch('frames_found', lastFrameScan), phase: 'frames_found' } },
      };
    }

    // 只有实体已消失且最后观测点接近投掷起点，才把它记作 overhead 证据。
    const droppedNearby = Boolean(overheadEvidence);
    if (droppedNearby) {
      lastFrameScan = scanFramesFresh(ctx, Math.min(frameRadius * 2, S6_FRAME_RADIUS));
        if (!lastFrameScan.fresh || !lastFrameScan.stable) {
          return searchReceipt('partial', '末影之眼在附近消失，但 fresh frame scan 无法重查门框区块或未确认稳定主世界；已保留搜索账本',
          makeSearch('blocked', lastFrameScan, 'wide_frame_scan_dimension_unverified'));
      }
      if (lastFrameScan.frames.length > 0) {
        return {
          detail:
            `第 ${throws} 次投掷后，末影之眼在 ${Math.round(eyeDistance)} 格内消失，` +
            `在 ${lastFrameScan.radius} 格内发现 ${lastFrameScan.frames.length} 个末地门框架`,
          status: 'succeeded',
          data: { stronghold_search: { ...makeSearch('frames_found', lastFrameScan), phase: 'frames_found' } },
        };
      }
      notes.push('末影之眼在附近消失，但附近没有找到框架；可以从当前位置安全分段下探');
      break;
    }

    const estimate = estimatedPosition();
    if (!observed) break;
    if (advance > 0 && estimate && estimate.distance <= advance + frameRadius) {
      const moved = await moveToward(ctx, estimate.x, estimate.z, 4);
      throwIfInterrupted(ctx, '寻找要塞');
      if (moved) {
        lastFrameScan = scanFramesFresh(ctx, Math.min(frameRadius * 2, S6_FRAME_RADIUS));
          if (!lastFrameScan.fresh || !lastFrameScan.stable) {
            return searchReceipt('partial', '到达估算点后 fresh frame scan 无法重查门框区块或未确认稳定主世界；已保留搜索账本',
            makeSearch('blocked', lastFrameScan, 'estimate_frame_scan_dimension_unverified'));
        }
        if (lastFrameScan.frames.length > 0) {
          return {
            detail:
              `根据 ${estimate.throws} 次投掷收敛到要塞估算点 (${estimate.x}, ${estimate.z})，` +
              `在附近发现 ${lastFrameScan.frames.length} 个末地门框架`,
            status: 'succeeded',
            data: { stronghold_search: { ...makeSearch('frames_found', lastFrameScan), phase: 'frames_found' } },
          };
        }
        notes.push(`已到达要塞估算点 (${estimate.x}, ${estimate.z})，附近尚未发现门框`);
      } else {
        notes.push(`无法到达要塞估算点 (${estimate.x}, ${estimate.z})`);
      }
    } else if (advance > 0 && Date.now() < deadline) {
      const targetX = origin.x + direction.dx * advance;
      const targetZ = origin.z + direction.dz * advance;
      const moved = await moveToward(ctx, targetX, targetZ, 4);
      throwIfInterrupted(ctx, '寻找要塞');
      if (!moved) notes.push(`朝要塞方向走 ${advance} 格失败`);
    }
  }

  const estimate = estimateStronghold(throwRecords);
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
  const phase = overheadEvidence ? 'descend' : 'blocked';
  const reason = overheadEvidence
    ? ''
    : estimate
      ? '没有 eye-overhead 证据；保留估算供人工或上层重新规划'
      : '方向数据不足且没有 eye-overhead 证据；不会自动重投';
  return searchReceipt('partial', `${head}${guess}${tail}`, makeSearch(phase, lastFrameScan, reason));
}

// ------------------------------------------------------------------ 技能：激活末地门

function visibleFrame(bot, feet, frame) {
  const eye = feet.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
  const ray = frame.position.offset(0.5, 0.45, 0.5).minus(eye);
  const reach = ray.norm();
  return reach > 0 && reach <= 4.5 && bot.world.raycast(eye, ray.scaled(1 / reach), reach + 0.1)?.position.equals(frame.position);
}

async function reachFrameFromOutside(ctx, frame, frames) {
  const bot = botOf(ctx), feet = bot.entity.position;
  if (dryMiningFooting(bot, feet) && visibleFrame(bot, feet, frame)) return true;
  const floor = frame.position.y;
  const minX = Math.min(...frames.map(f => f.position.x)), minZ = Math.min(...frames.map(f => f.position.z));
  const inside = p => p.x >= minX && p.x <= minX + 4 && p.z >= minZ && p.z <= minZ + 4;
  const stands = [];
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) for (let y = -3; y <= 2; y++) {
    const stand = frame.position.offset(x, y, z);
    if (!inside(stand) && dryMiningFooting(bot, stand) && visibleFrame(bot, stand.offset(0.5, 0, 0.5), frame)) stands.push(stand);
  }
  const movements = bot.pathfinder.movements;
  const previous = { exclusionAreasStep: movements.exclusionAreasStep, exclusionAreasBreak: movements.exclusionAreasBreak,
    allowParkour: movements.allowParkour, maxDropDown: movements.maxDropDown };
  Object.assign(movements, { allowParkour: false, maxDropDown: 1,
    exclusionAreasStep: [...(previous.exclusionAreasStep || []), b => !b?.position || (inside(b.position) && b.position.y <= floor + 1) ? 100 : miningRouteExclusion(bot, b)],
    exclusionAreasBreak: [...(previous.exclusionAreasBreak || []), b => !b?.position || (inside(b.position) && b.position.y <= floor) ? 100 : 0] });
  try {
    stands.sort((a, b) => a.distanceTo(feet) - b.distanceTo(feet));
    for (const stand of stands.slice(0, 4)) {
      throwIfInterrupted(ctx, '在门框外侧移动');
      await ctx.walkOnce(stand.x, stand.y, stand.z, 0, 6000);
      if (dryMiningFooting(bot, bot.entity.position) && visibleFrame(bot, bot.entity.position, frame)) return true;
    }
    return false;
  } finally {
    Object.assign(movements, previous);
  }
}

async function insertEye(ctx, frame, frames) {
  throwIfInterrupted(ctx, '激活末地门');
  const bot = botOf(ctx);
  if (bot.pathfinder?.movements && bot.world?.raycast && ctx.walkOnce) {
    if (!await reachFrameFromOutside(ctx, frame, frames)) return false;
  } else {
    try {
      await ctx.travelTo(frame.position.x, frame.position.y, frame.position.z, 2);
    } catch (error) {
      throwIfInterrupted(ctx, '激活末地门');
      log(ctx, '没走到末地门框架', error.message);
    }
  }
  const eye = findItem(ctx, EYE_ITEM);
  if (!eye) return false;
  await bot.equip(eye, 'hand');
  const fresh = bot.blockAt(frame.position) || frame;
  await bot.lookAt(fresh.position.offset(0.5, 0.5, 0.5), true);

  const before = frameHasEye(fresh);
  if (before) return true;

  throwIfInterrupted(ctx, '激活末地门');
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
  throwIfInterrupted(ctx, '激活末地门');

  let after = bot.blockAt(fresh.position);
  if (frameHasEye(after)) return true;

  // 第一次没成，换成交互键再试一次。
  try {
    await bot.lookAt(fresh.position.offset(0.5, 0.5, 0.5), true);
    await activateOnce(ctx);
    await sleepMs(ctx, 400);
    after = bot.blockAt(fresh.position);
  } catch (error) {
    throwIfInterrupted(ctx, '激活末地门');
    log(ctx, '第二次放末影之眼失败', error.message);
  }
  throwIfInterrupted(ctx, '激活末地门');
  return frameHasEye(after);
}

async function crossPortalSurface(ctx, center, y, expected) {
  const bot = botOf(ctx), here = bot.entity.position;
  const horizontal = Math.hypot(here.x - center.x, here.z - center.z);
  if (here.y < y + 0.7 || here.y > y + 2 || horizontal > 5) return false;
  const steps = Math.max(1, Math.ceil(horizontal * 3));
  for (let i = 1; i <= steps; i++) {
    const tile = here.offset((center.x - here.x) * i / steps, y - here.y, (center.z - here.z) * i / steps).floored();
    const floor = bot.blockAt(tile);
    if (!floor || !(floor.name === PORTAL_BLOCK || floor.name === FRAME_BLOCK || floor.boundingBox === 'block')) return false;
    if (bot.blockAt(tile.offset(0, 1, 0))?.boundingBox !== 'empty' || bot.blockAt(tile.offset(0, 2, 0))?.boundingBox !== 'empty') return false;
  }
  await bot.lookAt(center.offset(0, here.y - center.y + 1.4, 0), true);
  bot.setControlState('forward', true);
  try {
    for (let tick = 0; tick < 35; tick++) {
      if (isExpectedDimension(ctx, expected)) return true;
      throwIfInterrupted(ctx, '跨过已激活的门面');
      if (bot.entity.position.y < y - 0.3) break;
      await sleepMs(ctx, 50);
    }
    return isExpectedDimension(ctx, expected);
  } finally {
    bot.setControlState('forward', false);
  }
}

async function enterEndPortal(ctx, portal, expectedDimension, timeoutMs) {
  throwIfInterrupted(ctx, '进入末地');
  const bot = botOf(ctx);
  const x = Math.floor(portal.x);
  const y = Math.floor(portal.y);
  const z = Math.floor(portal.z);
  if (expectedDimension === END_DIMENSION && bot.world?.raycast && bot.pathfinder?.movements && ctx.walkOnce) {
    const frames = findFramesNearby(ctx, 16);
    const tiles = findBlockPositions(ctx, PORTAL_BLOCK, 16, 9);
    if (frames.length !== PORTAL_FRAME_COUNT || tiles.length !== 9) return false;
    const center = tiles.reduce((p, tile) => p.plus(tile), tiles[0].scaled(0)).scaled(1 / tiles.length).offset(0.5, 0, 0.5);
    if (await crossPortalSurface(ctx, center, y, expectedDimension)) return true;
    const movements = bot.pathfinder.movements;
    const previous = { canDig: movements.canDig, allowParkour: movements.allowParkour, maxDropDown: movements.maxDropDown,
      exclusionAreasStep: movements.exclusionAreasStep };
    const belowPortal = p => Math.abs(p.x + 0.5 - center.x) <= 2 && Math.abs(p.z + 0.5 - center.z) <= 2 && p.y < y;
    Object.assign(movements, { canDig: false, allowParkour: false, maxDropDown: 1,
      exclusionAreasStep: [...(previous.exclusionAreasStep || []), b => !b?.position || belowPortal(b.position) ? 100 : miningRouteExclusion(bot, b)] });
    const deadline = Date.now() + timeoutMs;
    try {
      frames.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
      for (const frame of frames) {
        if (Date.now() >= deadline) break;
        if (isExpectedDimension(ctx, expectedDimension)) return true;
        throwIfInterrupted(ctx, '从门框上沿进入末地');
        const p = frame.position;
        await ctx.walkOnce(p.x, y + 1, p.z, 0, Math.min(5000, deadline - Date.now()));
        if (isExpectedDimension(ctx, expectedDimension)) return true;
        const here = bot.entity.position;
        if (here.y < y + 0.7 || here.y > y + 2 || Math.hypot(here.x - p.x - 0.5, here.z - p.z - 0.5) > 1.2) continue;
        if (await crossPortalSurface(ctx, center, y, expectedDimension)) return true;
      }
      return isExpectedDimension(ctx, expectedDimension);
    } finally {
      Object.assign(movements, previous);
    }
  }
  try {
    await ctx.travelTo(x, y, z, 1);
  } catch (error) {
    throwIfInterrupted(ctx, '进入末地');
    log(ctx, '没走到末地门', error.message);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfInterrupted(ctx, '进入末地');
    if (isExpectedDimension(ctx, expectedDimension)) return true;
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
  return isExpectedDimension(ctx, expectedDimension);
}

async function activateEndPortal(args, ctx) {
  throwIfInterrupted(ctx, '激活末地门');
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
    return { status: 'partial', detail: `观察到 ${frames.length} 个末地门框架，需走近房间后再插眼`,
      data: { portal_phase: 'before_insertion', frames: frames.map(frame => copyPosition(frame.position)) } };
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
      throwIfInterrupted(ctx, '激活末地门');
      if (Date.now() > deadline) break;
      const ok = await insertEye(ctx, frame, frames);
      throwIfInterrupted(ctx, '激活末地门');
      if (ok) {
        inserted += 1;
        ctx.reportProgress?.('inserting_eyes', `已确认 ${filledBefore + inserted}/12 个门框有眼`, (filledBefore + inserted) / 12,
          { portal_phase: 'inserting', filled: filledBefore + inserted });
      }
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
  const entered = await enterEndPortal(
    ctx,
    portal,
    END_DIMENSION,
    Math.max(5000, deadline - Date.now()),
  );
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

  const initialCrystals = findEntities(ctx, CRYSTAL_ENTITY, radius);
  if (initialCrystals.length === 0) {
    return { broken: 0, failed: 0, left: 0, notes };
  }
  if (typeof ctx.runSkill === 'function') {
    throwIfInterrupted(ctx, '清除末地水晶');
    await ctx.runSkill('break_crystal', {
      count: 0,
      radius,
      safe_distance: 12,
      interval: 1200,
    });
    throwIfInterrupted(ctx, '清除末地水晶');
    const left = findEntities(ctx, CRYSTAL_ENTITY, radius).length;
    return { broken: Math.max(0, initialCrystals.length - left), failed: 0, left, notes };
  }
  if (typeof ctx.findRangedWeapon !== 'function' || !ctx.findRangedWeapon() || typeof ctx.shootAt !== 'function') {
    throw new Error('附近有末地水晶，但没有可用弓和箭；拒绝靠近水晶进行近战');
  }

  while (Date.now() < deadline && guard < 40) {
    throwIfInterrupted(ctx, '清除末地水晶');
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
      throwIfInterrupted(ctx, '清除末地水晶');
      notes.push(`打水晶失败：${error.message}`);
    }

    const gone = await waitEntityGone(ctx, crystal, 5000);
    throwIfInterrupted(ctx, '清除末地水晶');
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

async function reachEndIsland(ctx, deadline) {
  const bot = botOf(ctx);
  const origin = bot.entity.position;
  const arenaRadius = 24;
  if (Math.hypot(origin.x, origin.z) <= arenaRadius) return;
  const movements = bot.pathfinder?.movements;
  if (!movements || !ctx.walkOnce) return;
  const previous = { canDig: movements.canDig, allowParkour: movements.allowParkour, maxDropDown: movements.maxDropDown };
  Object.assign(movements, { canDig: false, allowParkour: false, maxDropDown: 1 });
  try {
    for (let step = 0; step < 96 && Date.now() < deadline; step++) {
      throwIfInterrupted(ctx, '从出生平台走上末地主岛');
      const here = bot.entity.position.floored();
      if (Math.hypot(here.x, here.z) <= arenaRadius) return;
      const dx = Math.abs(here.x) >= Math.abs(here.z) ? -Math.sign(here.x) : 0;
      const dz = dx ? 0 : -Math.sign(here.z);
      // 岛面上按短程路点移动，错开黑曜石柱。虚空上的每一块桥面仍逐格确认。
      if (bot.blockAt(here.offset(0, -1, 0))?.name === 'end_stone') {
        let advanced = false;
        for (const lateral of [0, 6, -6]) {
          const ahead = here.offset(dx * 18 + dz * lateral, 0, dz * 18 - dx * lateral);
          let surface = null;
          for (let h = 9; h >= -5; h--) {
            const p = ahead.offset(0, h, 0);
            if (bot.blockAt(p.offset(0, -1, 0))?.name === 'end_stone' && dryMiningFooting(bot, p)) {
              surface = p;
              break;
            }
          }
          if (!surface) continue;
          await ctx.walkOnce(surface.x, surface.y, surface.z, 1, Math.min(12000, Math.max(1, deadline - Date.now())));
          if (Math.hypot(bot.entity.position.x, bot.entity.position.z) < Math.hypot(here.x, here.z) - 2) {
            advanced = true;
            break;
          }
        }
        if (advanced) continue;
      }
      const next = here.offset(dx, 0, dz);
      const foot = bot.blockAt(next), floor = bot.blockAt(next.offset(0, -1, 0));
      if (!foot || !floor) break;
      let targetY = here.y;
      if (foot.boundingBox === 'block') {
        targetY++;
      } else if (floor.boundingBox === 'empty') {
        if (!dryMiningFooting(bot, here)) break;
        const material = ['cobblestone', 'cobbled_deepslate', 'granite', 'andesite', 'end_stone'].find(name => ctx.countItem(name) > 0);
        if (!material) break;
        await ctx.placeBlock({ block: material, x: next.x, y: here.y - 1, z: next.z });
      }
      let stand = next.offset(0, targetY - here.y, 0);
      if (!dryMiningFooting(bot, stand)) {
        // 岸壁超过一级时，仅向前方已观察到的岛面寻路。
        stand = null;
        for (let up = 2; up <= 16; up++) {
          const p = next.offset(0, up, 0);
          if (bot.blockAt(p.offset(0, -1, 0))?.name === 'end_stone' && dryMiningFooting(bot, p)) {
            stand = p;
            break;
          }
        }
        if (!stand) break;
      }
      const outcome = await ctx.walkOnce(stand.x, stand.y, stand.z, 0, Math.min(14000, Math.max(1, deadline - Date.now())));
      if (outcome !== 'reached' && here.distanceTo(bot.entity.position.floored()) < 2) break;
    }
  } finally {
    Object.assign(movements, previous);
  }
  if (Math.hypot(bot.entity.position.x, bot.entity.position.z) > arenaRadius) {
    throw new Error('从末地出生点向主岛前进时未能确认下一处落脚点');
  }
}

// 天然返回门紧邻 (0, 0) 的基岩柱。只读这四列，未加载时保留未知状态。
function centralPortalState(bot) {
  const origin = bot.entity.position;
  const bottom = bot.game.minY ?? 0;
  const top = bottom + (bot.game.height ?? 256);
  let fullyLoaded = true;
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (let y = bottom; y < top; y++) {
      const block = bot.blockAt(origin.offset(x - origin.x, y - origin.y, z - origin.z), false);
      if (!block) {
        fullyLoaded = false;
        break;
      }
      if (block.name === PORTAL_BLOCK) return true;
    }
  }
  return fullyLoaded ? false : null;
}

async function strikePerchedDragon(ctx, dragon) {
  const bot = botOf(ctx);
  if (!bot.attack || !ctx.equipWeapon || !ctx.walkOnce) {
    if (ctx.approach) await ctx.approach(dragon);
    return ctx.attackEntity(dragon);
  }
  const p = dragon.position.floored(), feet = bot.entity.position;
  const eye = feet.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
  const body = dragon.position.offset(0, 0.6, 0);
  if (eye.distanceTo(body) <= 3) {
    await ctx.equipWeapon();
    throwIfInterrupted(ctx, '末地战斗');
    await bot.lookAt(body, true);
    bot.attack(dragon);
  } else {
    // 龙停在基岩柱上方。走到柱边实际可站立的台阶，不追逐空中的实体坐标。
    const steps = [];
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]) {
      for (let dy = 0; dy >= -4; dy--) {
        const stand = p.offset(dx, dy, dz);
        if (!dryMiningFooting(bot, stand)) continue;
        if (stand.offset(0.5, 1.62, 0.5).distanceTo(body) <= 3) steps.push(stand);
        break;
      }
    }
    steps.sort((a, b) => a.distanceTo(feet) - b.distanceTo(feet));
    if (steps.length) await ctx.walkOnce(steps[0].x, steps[0].y, steps[0].z, 0, 3000);
  }
}

async function fightDragon(args, ctx) {
  throwIfInterrupted(ctx, '末地战斗');
  const bot = botOf(ctx);
  if (!isEndDimension(currentDimension(ctx))) {
    throw new Error(`当前在${dimensionLabel(currentDimension(ctx))}，末影龙只在末地`);
  }

  const radius = clampNumber(args.radius, DEFAULT_DRAGON_RADIUS, 16, 128);
  const timeoutMs = clampNumber(args.timeout_s, 240, 30, 300) * 1000;
  const deadline = Date.now() + timeoutMs;
  const notes = [];
  const pumpkin = findItem(ctx, 'carved_pumpkin');
  if (pumpkin && bot.inventory.slots?.[5]?.name !== 'carved_pumpkin') await bot.equip(pumpkin, 'head');
  const onIsland = bot.entity.position.floored && bot.blockAt?.(bot.entity.position.floored().offset(0, -1, 0))?.name === 'end_stone';
  const canEngage = onIsland && findEntity(ctx, DRAGON_ENTITY, radius);
  if (!canEngage) await reachEndIsland(ctx, deadline);
  const returnPortalPresentAtStart = centralPortalState(bot);

  let dragon = findEntity(ctx, DRAGON_ENTITY, radius);
  if (!dragon && returnPortalPresentAtStart) {
    return {
      detail: '中央返回传送门在本次战斗开始前已经存在，附近也没有末影龙；不报告本次击杀事件',
      status: 'partial',
      data: { evidence: 'return_portal_preexisting_dragon_absent', events: [] },
    };
  }
  if (!dragon) {
    const waitUntil = Math.min(deadline, Date.now() + 8000);
    while (!dragon && Date.now() < waitUntil) {
      throwIfInterrupted(ctx, '末地战斗');
      await sleepMs(ctx, 500);
      dragon = findEntity(ctx, DRAGON_ENTITY, radius);
    }
  }
  if (!dragon) {
    if (centralPortalState(bot)) {
      return {
        detail: '观察到中央返回传送门，但本次战斗没有观察到末影龙；不报告击杀事件',
        status: 'partial',
        data: { events: [], evidence: 'return_portal_present_dragon_absent_before_fight' },
      };
    }
    throw new Error('附近没有末影龙，可能还没生成');
  }

  const crystalResult = await clearCrystals(ctx, Math.max(radius, 96), deadline);
  if (!isEndDimension(currentDimension(ctx))) throw new Error('清除水晶期间离开末地，需要重新观察战场');
  notes.push(...crystalResult.notes);
  if (crystalResult.left > 0) {
    throw new Error(
      `还差 ${crystalResult.left} 个末地水晶没有打碎，末影龙会一直回血` +
        (notes.length ? `（${notes.slice(-3).join('，')}）` : ''),
    );
  }

  let lastDetail = '';
  let lastHealth = dragonHealth(bot, dragon);
  const startingHealth = lastHealth;
  while (Date.now() < deadline) {
    throwIfInterrupted(ctx, '末地战斗');
    if (!isEndDimension(currentDimension(ctx))) throw new Error('战斗期间离开末地，需要重新观察战场');
    dragon = findEntity(ctx, DRAGON_ENTITY, radius);
    if (!dragon) {
      const returnPortalPresentNow = centralPortalState(bot);
      if (returnPortalPresentNow && returnPortalPresentAtStart === false) {
        return {
          detail:
            `确认中央返回传送门在本次战斗期间出现，末影龙已不在附近；打碎 ${crystalResult.broken} 个末地水晶` +
            (notes.length ? `；过程记录：${notes.slice(-3).join('，')}` : ''),
          status: 'succeeded',
          data: {
            events: ['ender_dragon_killed'],
            evidence: 'return_portal_appeared_dragon_absent',
          },
        };
      }
      await sleepMs(ctx, 500);
      continue;
    }
    lastHealth = dragonHealth(bot, dragon);
    if (Number.isFinite(lastHealth) && lastHealth <= 0) {
      return {
        detail: `末影龙血量归零，打碎 ${crystalResult.broken} 个末地水晶`,
        status: 'succeeded',
        data: { events: ['ender_dragon_killed'], evidence: 'dragon_health_zero' },
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
          throwIfInterrupted(ctx, '末地战斗');
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
        throwIfInterrupted(ctx, '末地战斗');
        notes.push(`躲龙息失败：${error.message}`);
      }
      await sleepMs(ctx, 500);
      continue;
    }

    const perched = isDragonPerched(dragon, bot);
    const distance = distanceToBot(ctx, dragon);
    try {
      if (perched) {
        if (bot.health < 18 && ctx.findRangedWeapon?.() && ctx.evadePerchedDragon) {
          await ctx.evadePerchedDragon(dragon);
          if (bot.food < 20 && distanceToBot(ctx, dragon) >= 15 && !findEntity(ctx, 'area_effect_cloud', 10)) {
            const food = ctx.findFoodForEating?.();
            if (food && ctx.eatFood) await ctx.eatFood({ item: food.name, count: 1 });
          }
          await sleepMs(ctx, 500);
          continue;
        }
        const detail = await strikePerchedDragon(ctx, dragon);
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
      throwIfInterrupted(ctx, '末地战斗');
      notes.push(`攻击失败：${error.message}`);
    }
    await sleepMs(ctx, 500);
  }

  if (!Number.isFinite(lastHealth)) throw new Error('战斗结束时没有观察到龙的生命值或新出现的返回门');
  const remaining = Math.max(1, Math.ceil(lastHealth));
  const error = new Error(
    `还差 ${remaining} 点血才能击杀末影龙` +
      (lastDetail ? `（${lastDetail}）` : '') +
      (notes.length ? `；${notes.slice(-3).join('，')}` : ''),
  );
  if (Number.isFinite(startingHealth) && lastHealth > 0 && startingHealth - lastHealth >= 1) {
    error.data = { dragon_progress: { started_health: startingHealth, remaining_health: lastHealth } };
  }
  throw error;
}

// ------------------------------------------------------------------ 技能：返回主世界

async function returnHome(args, ctx) {
  throwIfInterrupted(ctx, '返回主世界');
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
      throwIfInterrupted(ctx, '返回主世界');
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
  const entered = await enterEndPortal(ctx, portal, OVERWORLD_DIMENSION, timeoutMs);
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
      '在主世界投掷末影之眼找要塞：只在实际观测到末地门框架时报告找到；眼在附近消失但没有框架时保留单次搜索上下文，可在安全检查后分段下探并逐段新扫描。',
    parameters: [
      { name: 'count', type: 'number', required: false, default: 3, description: '最多投几次，范围 1-12。' },
      { name: 'advance', type: 'number', required: false, default: 0, description: '每次投掷后朝眼飞的方向走多少格，0 表示原地投。' },
      { name: 'frame_radius', type: 'number', required: false, default: 24, description: '发现末地门框架的搜索半径，范围 8-64 格。' },
      { name: 'timeout_s', type: 'number', required: false, default: 180, description: '整个寻找过程的最长用时，范围 20-300 秒。' },
      { name: 'resume_search', type: 'object', required: false, default: null, description: 'Core 按先前回执恢复定位。沿已测方向实际前进后可在剩余预算内再次投眼，下探时沿用已有轨迹。' },
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
