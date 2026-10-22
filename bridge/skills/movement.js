// 移动与避险模块：safe_descend / swim_escape / safe_travel / parkour_safe。
// 契约见 docs/plans/SKILL_MODULE_CONTRACT.md；移动手感见 docs/research/PLAYER_LIKENESS.md。
//
// 反机械感约束（PLAYER_LIKENESS.md 第 8 节）：
// - 转向有速率上限：移动中 ≤150°/s、pitch ≤120°/s，不用 force=true 硬转。
// - 不每 tick 重建 goal：分段寻路之间至少隔 600ms，跳跃冷却 700ms。
// - 关掉 pathfinder 的 allowParkour 与 canDig，跳跃由本模块自己控制。
//
// 待接入（集成阶段可补 ctx；可选能力都用 typeof 判断，缺了也不会崩）：
// - ctx.withTimeout(promise, ms, message)：可选的超时包装；本模块用 ctx.walkOnce 自带的超时，缺了不影响。
// - ctx.classifyPathFailure(error)：路径失败分类；缺省时按 error.name 本地兜底。

// ------------------------------------------------------------------ 常量

const LAVA_BLOCKS = new Set(['lava', 'magma_block', 'lava_cauldron']);

const HAZARD_BLOCKS = new Set([
  'fire',
  'soul_fire',
  'campfire',
  'soul_campfire',
  'cactus',
  'sweet_berry_bush',
  'powder_snow',
  'wither_rose',
]);

const BLOCK_LABELS = {
  lava: '岩浆',
  magma_block: '岩浆块',
  lava_cauldron: '岩浆锅',
  fire: '火',
  soul_fire: '灵魂火',
  campfire: '营火',
  soul_campfire: '灵魂营火',
  cactus: '仙人掌',
  sweet_berry_bush: '甜浆果丛',
  powder_snow: '细雪',
  wither_rose: '凋零玫瑰',
  water: '水',
  cobblestone: '圆石',
  dirt: '泥土',
  stone: '石头',
  deepslate: '深板岩',
  oak_planks: '橡木木板',
  sand: '沙子',
  gravel: '沙砾',
  netherrack: '下界岩',
};

// 填埋水坑时优先用背包里已有的方块。
const FILL_BLOCK_ORDER = [
  'cobblestone',
  'dirt',
  'stone',
  'deepslate',
  'oak_planks',
  'sand',
  'gravel',
  'netherrack',
];

const DESCEND_AHEAD_SCAN = 3;   // 前方扫描几格
const DESCEND_HEAD_SCAN = 2;    // 头顶扫描几格
const DESCEND_SHAFT_SCAN = 3;   // 竖井往下扫描几格
const MAX_YAW_RATE = 150;       // 度/秒，移动中的转向上限
const MAX_PITCH_RATE = 120;     // 度/秒
const JUMP_COOLDOWN_MS = 700;   // 跳跃冷却，避免连续跳造成抖动
const REPATH_INTERVAL_MS = 600; // 重寻路最小间隔
const MAX_DROP_DOWN = 2;        // 可以直接走下去的最大落差
const PIT_DEPTH = 3;            // 超过这个深度算深坑
const TRAVEL_SEGMENT = 12;      // 分段移动的长度
const DETOUR_OFFSETS = [2, -2, 3, -3, 4, -4, 6, -6];
const MAX_TRAVEL_RETRIES = 2;

// 模块级状态：技能模块在桥接里是长驻单例，跳跃冷却与重寻路间隔要跨调用保持。
let lastJumpAt = 0;
let lastPathAt = 0;

// ------------------------------------------------------------------ 纯逻辑

// 岩浆判定：lava / magma_block / lava_* 都是岩浆类方块。
export function isLava(name) {
  if (!name) return false;
  const text = String(name);
  return LAVA_BLOCKS.has(text) || text.startsWith('lava_');
}

// 水判定：与桥接的 blockIsWater 口径一致，方块名里带 water 就是水。
export function isWaterBlock(name) {
  if (!name) return false;
  return String(name).includes('water');
}

// 危险方块判定：岩浆、火、仙人掌这些踩上去会掉血或卡住。
export function isHazardBlock(name) {
  if (!name) return false;
  const text = String(name);
  if (isLava(text)) return true;
  return HAZARD_BLOCKS.has(text);
}

// 落脚点分类：solid 可站、water 是水、lava 是岩浆、open 是空的。
export function classifyFooting(block) {
  if (!block) return 'open';
  const name = block.name;
  if (isLava(name)) return 'lava';
  if (isWaterBlock(name)) return 'water';
  if (block.boundingBox === 'block') return 'solid';
  return 'open';
}

// 下降计划：从 startY 逐层降到 targetY，每层一次。
export function planDescent(startY, targetY, options = {}) {
  const step = Math.max(1, Math.floor(Number(options.step) || 1));
  const from = Math.floor(Number(startY));
  const to = Math.floor(Number(targetY));
  const levels = [];
  if (!Number.isFinite(from) || !Number.isFinite(to)) return levels;
  if (from <= to) return levels;
  let cursor = from;
  while (cursor > to) {
    const next = Math.max(to, cursor - step);
    levels.push({ fromY: cursor, toY: next, drop: cursor - next });
    cursor = next;
  }
  return levels;
}

// 跳跃冷却：默认 700ms，太近了会抖。
export function jumpCooldownOk(lastJump, now = Date.now(), cooldownMs = JUMP_COOLDOWN_MS) {
  if (!Number.isFinite(lastJump) || lastJump <= 0) return true;
  if (!Number.isFinite(now)) return false;
  return now - lastJump >= cooldownMs;
}

// 还要等多久才能跳。
export function jumpCooldownRemaining(lastJump, now = Date.now(), cooldownMs = JUMP_COOLDOWN_MS) {
  if (jumpCooldownOk(lastJump, now, cooldownMs)) return 0;
  return Math.max(0, cooldownMs - (now - lastJump));
}

// 角度归一到 [-π, π]。
export function normalizeAngle(angle) {
  if (!Number.isFinite(angle)) return 0;
  let value = angle % (Math.PI * 2);
  if (value > Math.PI) value -= Math.PI * 2;
  if (value < -Math.PI) value += Math.PI * 2;
  return value;
}

// 单次转向的步长上限：按速率上限算，50ms 一次最多转 7.5°。
export function clampYawStep(currentYaw, targetYaw, maxRateDeg = MAX_YAW_RATE, dtMs = 50) {
  const delta = normalizeAngle(targetYaw - currentYaw);
  // 速率上限是度/秒，delta 是弧度，换算一下再比。
  const limit = ((Math.max(0, maxRateDeg) * Math.max(0, dtMs)) / 1000) * (Math.PI / 180);
  if (Math.abs(delta) <= limit) return delta;
  return Math.sign(delta) * limit;
}

// 朝向前方向量，yaw 是 mineflayer 的约定：前方 = (-sin, -cos)。
export function forwardVector(yaw) {
  return { dx: -Math.sin(yaw), dz: -Math.cos(yaw) };
}

// 前方第 step 格落在哪个格子（取主轴，避免斜着走）。
export function forwardCell(yaw, step = 1) {
  const vector = forwardVector(yaw);
  if (Math.abs(vector.dx) >= Math.abs(vector.dz)) {
    return { dx: Math.sign(vector.dx) * step, dz: 0 };
  }
  return { dx: 0, dz: Math.sign(vector.dz) * step };
}

// 长距离移动的分段计划：每段不超过 segmentLength 格。
export function planTravelSegments(from, to, segmentLength = TRAVEL_SEGMENT) {
  const segments = [];
  const start = { x: Number(from.x), y: Number(from.y), z: Number(from.z) };
  const end = { x: Number(to.x), y: Number(to.y), z: Number(to.z) };
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const total = Math.hypot(dx, dz);
  if (!Number.isFinite(total) || total <= 0.0001) return segments;
  const length = Math.max(1, Number(segmentLength) || TRAVEL_SEGMENT);
  const count = Math.max(1, Math.ceil(total / length));
  for (let index = 1; index <= count; index += 1) {
    const ratio = index / count;
    segments.push({
      x: Math.round(start.x + dx * ratio),
      y: Math.round(start.y + (end.y - start.y) * ratio),
      z: Math.round(start.z + dz * ratio),
      distance: total * ratio,
    });
  }
  return segments;
}

// 受控跳跃的决策：只在前方 1 格被挡或 1 格沟时跳，落差能走就走。
export function planParkour(front) {
  const { blocked = false, gap = false, drop = 0, hazard = false, pit = false, tooTall = false } = front || {};
  if (hazard) return { action: 'stop', reason: '前方有危险方块' };
  if (tooTall) return { action: 'stop', reason: '前方挡了 2 格，跳不上去' };
  if (pit) return { action: 'stop', reason: '前方是深坑' };
  if (drop > 0) {
    if (gap) return { action: 'jump', reason: '前方是 1 格沟' };
    if (drop <= MAX_DROP_DOWN) return { action: 'walk', reason: `前方落差 ${drop} 格，直接走下去` };
    return { action: 'stop', reason: `前方落差 ${drop} 格，太深了` };
  }
  if (blocked) return { action: 'jump', reason: '前方 1 格被挡住' };
  return { action: 'walk', reason: '前方没有障碍' };
}

// ------------------------------------------------------------------ ctx 适配

function botOf(ctx) {
  const bot = ctx && ctx.bot;
  if (!bot || !bot.entity || !bot.entity.position) {
    throw new Error('还没有进入世界，不能移动');
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

// 方块中文名：先用本模块的表，再退到 ctx.blockLabel。
function label(ctx, name) {
  if (!name) return '未知方块';
  if (BLOCK_LABELS[name]) return BLOCK_LABELS[name];
  if (typeof ctx.blockLabel === 'function') {
    try {
      const text = ctx.blockLabel(String(name));
      if (text) return String(text);
    } catch {
      // 拿不到标签就用方块 id
    }
  }
  return String(name);
}

// 造一个 Vec3：不能 import vec3，就借 bot 自己的位置对象。
function makeVec(ctx, x, y, z) {
  const base = botOf(ctx).entity.position;
  const VecClass = base && base.constructor;
  if (typeof VecClass === 'function') {
    try {
      return new VecClass(Number(x), Number(y), Number(z));
    } catch {
      // 退回 offset 方案
    }
  }
  return base.offset(Number(x) - base.x, Number(y) - base.y, Number(z) - base.z);
}

// 读方块：区块没加载时返回 null。
function blockAt(ctx, x, y, z) {
  try {
    const block = botOf(ctx).blockAt(makeVec(ctx, Math.floor(x), Math.floor(y), Math.floor(z)));
    return block || null;
  } catch {
    return null;
  }
}

// 水判定优先用 ctx.blockIsWater，保证和桥接其它地方口径一致。
function waterLike(ctx, block) {
  if (!block) return false;
  if (typeof ctx.blockIsWater === 'function') {
    try {
      return Boolean(ctx.blockIsWater(block));
    } catch {
      // 落回本地判定
    }
  }
  return isWaterBlock(block.name);
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

// 路径失败分类：优先用 ctx.classifyPathFailure，缺省按 error.name 兜底。
function classifyFailure(ctx, error) {
  if (typeof ctx.classifyPathFailure === 'function') {
    try {
      const kind = ctx.classifyPathFailure(error);
      if (kind) return String(kind);
    } catch {
      // 落回本地判定
    }
  }
  const name = String((error && error.name) || '');
  if (name === 'NoPath' || name === 'Timeout' || name === 'CollectTimeout') return 'unreachable';
  if (name === 'GoalChanged' || name === 'PathStopped') return 'stopped';
  return 'unknown';
}

// 分段寻路之间至少隔 600ms，避免每 tick 重建 goal。
async function respectRepathInterval(ctx) {
  const wait = Math.max(0, REPATH_INTERVAL_MS - (Date.now() - lastPathAt));
  if (wait > 0) await sleepMs(ctx, wait);
  lastPathAt = Date.now();
}

// 临时改 pathfinder 参数，只改字段不重建 goal。
function applyMovementSettings(ctx, overrides) {
  const movements = ctx && ctx.bot && ctx.bot.pathfinder && ctx.bot.pathfinder.movements;
  if (!movements) return null;
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in movements)) continue;
    saved[key] = movements[key];
    movements[key] = value;
  }
  return saved;
}

function restoreMovementSettings(ctx, saved) {
  if (!saved) return;
  const movements = ctx && ctx.bot && ctx.bot.pathfinder && ctx.bot.pathfinder.movements;
  if (!movements) return;
  for (const [key, value] of Object.entries(saved)) {
    if (key in movements) movements[key] = value;
  }
}

function stopPathfinder(ctx) {
  const pathfinder = ctx && ctx.bot && ctx.bot.pathfinder;
  if (pathfinder && typeof pathfinder.stop === 'function') {
    try {
      pathfinder.stop();
    } catch {
      // 停止失败不影响后续判断
    }
  }
}

// 带速率上限的转向：一次最多转 150°/s 的量，不用 force=true 硬转。
async function turnToward(ctx, targetYaw, pitch = 0) {
  const bot = botOf(ctx);
  const current = bot.entity.yaw;
  const delta = clampYawStep(current, targetYaw, MAX_YAW_RATE, 50);
  const next = current + delta;
  const pitchLimit = ((MAX_PITCH_RATE * 50) / 1000) * (Math.PI / 180);
  const pitchDelta = clampNumber(Math.abs(pitch - bot.entity.pitch), 0, 0, pitchLimit);
  const nextPitch = bot.entity.pitch + Math.sign(pitch - bot.entity.pitch) * pitchDelta;
  try {
    await bot.look(next, nextPitch);
  } catch {
    // 转向失败不阻断流程
  }
  return next;
}

// ------------------------------------------------------------------ 环境扫描

// 脚下竖井的扫描：返回岩浆、水、危险方块列表。
function scanShaft(ctx, origin, maxDepth = DESCEND_SHAFT_SCAN) {
  const lava = [];
  const water = [];
  const hazards = [];
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const block = blockAt(ctx, origin.x, origin.y - depth, origin.z);
    if (!block) continue;
    const entry = {
      x: origin.x,
      y: origin.y - depth,
      z: origin.z,
      name: block.name,
      zone: `脚下${depth}格`,
      depth,
    };
    if (isLava(block.name)) lava.push(entry);
    else if (waterLike(ctx, block)) water.push(entry);
    else if (isHazardBlock(block.name)) hazards.push(entry);
  }
  return { lava, water, hazards };
}

// 下降前的整圈扫描：脚下竖井 + 前方 1-3 格 + 头顶 2 格。
function scanDescentArea(ctx) {
  const bot = botOf(ctx);
  const position = bot.entity.position;
  const origin = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
  const yaw = bot.entity.yaw;
  const cells = [];

  for (let depth = 1; depth <= DESCEND_SHAFT_SCAN; depth += 1) {
    cells.push({ dx: 0, dy: -depth, dz: 0, zone: `脚下${depth}格`, depth });
  }
  for (let step = 1; step <= DESCEND_AHEAD_SCAN; step += 1) {
    const cell = forwardCell(yaw, step);
    cells.push({ dx: cell.dx, dy: 0, dz: cell.dz, zone: `前方${step}格` });
    cells.push({ dx: cell.dx, dy: -1, dz: cell.dz, zone: `前方${step}格脚下` });
  }
  for (let up = 1; up <= DESCEND_HEAD_SCAN; up += 1) {
    cells.push({ dx: 0, dy: up, dz: 0, zone: `头顶${up}格` });
  }

  const lava = [];
  const water = [];
  const hazards = [];
  for (const cell of cells) {
    const block = blockAt(ctx, origin.x + cell.dx, origin.y + cell.dy, origin.z + cell.dz);
    if (!block) continue;
    const entry = {
      x: origin.x + cell.dx,
      y: origin.y + cell.dy,
      z: origin.z + cell.dz,
      name: block.name,
      zone: cell.zone,
      depth: cell.depth || null,
    };
    if (isLava(block.name)) lava.push(entry);
    else if (waterLike(ctx, block)) water.push(entry);
    else if (isHazardBlock(block.name)) hazards.push(entry);
  }
  return { origin, lava, water, hazards };
}

// 竖井某一格是不是能站的。
function columnIsSafe(ctx, x, feetY, z, landingY) {
  const floor = blockAt(ctx, x, feetY - 1, z);
  if (classifyFooting(floor) !== 'solid') return false;
  const landing = blockAt(ctx, x, landingY, z);
  if (classifyFooting(landing) !== 'solid') return false;
  const head = blockAt(ctx, x, feetY, z);
  const headTop = blockAt(ctx, x, feetY + 1, z);
  if (head && head.boundingBox === 'block') return false;
  if (headTop && headTop.boundingBox === 'block') return false;
  const shaft = scanShaft(ctx, { x, y: landingY, z }, 2);
  if (shaft.lava.length > 0) return false;
  return true;
}

// 往旁边绕一格：找一根没有水的竖井挪过去。
async function detourColumn(ctx, origin, landingY) {
  if (typeof ctx.walkOnce !== 'function') return false;
  for (let radius = 1; radius <= 2; radius += 1) {
    for (let step = 0; step < 8; step += 1) {
      const angle = (Math.PI * 2 * step) / 8;
      const nx = origin.x + Math.round(Math.cos(angle) * radius);
      const nz = origin.z + Math.round(Math.sin(angle) * radius);
      if (!columnIsSafe(ctx, nx, origin.y, nz, landingY)) continue;
      await respectRepathInterval(ctx);
      const outcome = await ctx.walkOnce(nx, origin.y, nz, 0, 8000);
      if (outcome !== 'reached') continue;
      const position = botOf(ctx).entity.position;
      if (Math.floor(position.x) !== nx || Math.floor(position.z) !== nz) continue;
      return true;
    }
  }
  return false;
}

// 背包里能用来填埋的方块。
function pickFillBlock(ctx) {
  if (typeof ctx.countItem !== 'function') return 'cobblestone';
  for (const name of FILL_BLOCK_ORDER) {
    try {
      if (ctx.countItem(name) > 0) return name;
    } catch {
      // 单个物品统计失败就跳过
    }
  }
  return null;
}

// 往指定格子放一块方块（填水或垫脚）。
async function placeBlockAt(ctx, x, y, z) {
  if (typeof ctx.placeBlock !== 'function') return false;
  const name = pickFillBlock(ctx);
  if (!name) return false;
  try {
    await ctx.placeBlock({ block: name, x, y, z });
  } catch (error) {
    log(ctx, '放方块失败', String((error && error.message) || error));
    return false;
  }
  const block = blockAt(ctx, x, y, z);
  return Boolean(block && block.boundingBox === 'block');
}

// 等 bot 落到目标高度。
async function waitForDescent(ctx, targetY, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const position = botOf(ctx).entity.position;
    if (Math.floor(position.y) <= targetY) return true;
    await sleepMs(ctx, 100);
  }
  return Math.floor(botOf(ctx).entity.position.y) <= targetY;
}

// 走廊扫描：找危险方块和深坑。
function scanCorridor(ctx, from, to) {
  const hazards = [];
  const pits = [];
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(length));
  for (let index = 1; index <= steps; index += 1) {
    const ratio = index / steps;
    const x = Math.floor(from.x + dx * ratio);
    const y = Math.floor(from.y + (to.y - from.y) * ratio);
    const z = Math.floor(from.z + dz * ratio);
    for (const [ox, oz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const [offset, zone] of [[0, '脚高'], [-1, '脚下']]) {
        const block = blockAt(ctx, x + ox, y + offset, z + oz);
        if (!block) continue;
        if (!isHazardBlock(block.name)) continue;
        hazards.push({ x: x + ox, y: y + offset, z: z + oz, name: block.name, zone });
      }
    }
    if (pitDepth(ctx, x, y, z) >= PIT_DEPTH) {
      pits.push({ x, y, z });
    }
  }
  return { hazards, pits };
}

// 脚下连续多深是空的。
function pitDepth(ctx, x, y, z, maxDepth = 4) {
  let depth = 0;
  for (let offset = 1; offset <= maxDepth; offset += 1) {
    const block = blockAt(ctx, x, y - offset, z);
    if (!block || block.boundingBox !== 'block') {
      depth += 1;
      continue;
    }
    break;
  }
  return depth;
}

// 绕行点：在垂直于行进方向的偏移里找一条没有危险的路。
function pickDetour(ctx, from, to) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz);
  if (length < 0.001) return null;
  const perpX = -dz / length;
  const perpZ = dx / length;
  for (const offset of DETOUR_OFFSETS) {
    const candidate = {
      x: Math.round(to.x + perpX * offset),
      y: to.y,
      z: Math.round(to.z + perpZ * offset),
    };
    const scan = scanCorridor(ctx, from, candidate);
    if (scan.hazards.length === 0 && scan.pits.length === 0) return candidate;
  }
  return null;
}

// ------------------------------------------------------------------ 技能

export const skills = {
  // 逐层安全下降：每层先扫描脚下竖井、前方 1-3 格、头顶 2 格，
  // 遇岩浆立刻停并上报坐标，遇水先填埋、填不了就绕行。
  safe_descend: {
    description: '安全下降到指定的 y 坐标：逐层下降，每层先扫描岩浆与水，保证每层都有落脚方块。',
    parameters: [
      {
        name: 'targetY',
        type: 'number',
        required: true,
        default: null,
        description: '要下降到的 y 坐标，深层矿道常用 -54 到 -59。',
      },
      {
        name: 'maxLayers',
        type: 'number',
        required: false,
        default: 12,
        description: '最多下降几层，防止一路挖到底。',
      },
      {
        name: 'fill',
        type: 'boolean',
        required: false,
        default: true,
        description: '遇到水是否用背包里的方块填埋。',
      },
      {
        name: 'detour',
        type: 'boolean',
        required: false,
        default: true,
        description: '水填不了时是否绕到旁边没有水的竖井。',
      },
    ],
    handler: async (args, ctx) => {
      const bot = botOf(ctx);
      const targetY = Math.floor(Number(args.targetY));
      if (!Number.isFinite(targetY)) {
        throw new Error('需要目标 y 坐标');
      }
      const maxLayers = clampNumber(args.maxLayers, 12, 1, 64);
      const allowFill = args.fill !== false;
      const allowDetour = args.detour !== false;
      const startY = Math.floor(bot.entity.position.y);
      const levels = planDescent(startY, targetY, { step: 1 });
      if (levels.length === 0) {
        return { detail: `已经在 y=${startY}，不需要下降`, status: 'succeeded' };
      }

      const settings = applyMovementSettings(ctx, {
        allowSprinting: false,
        allowParkour: false,
        canDig: false,
        maxDropDown: 1,
      });
      let dug = 0;
      let filled = 0;
      let detoured = 0;
      try {
        for (const level of levels) {
          if (dug >= maxLayers) break;
          const scan = scanDescentArea(ctx);
          const origin = scan.origin;

          // 岩浆：立刻停。竖井第 3 格只提醒，上面两层会挡住。
          const blockingLava = scan.lava.find((cell) => cell.depth !== 3);
          if (blockingLava) {
            throw new Error(
              `危险：${blockingLava.zone}有岩浆（${blockingLava.x}, ${blockingLava.y}, ${blockingLava.z}），没有安全的落脚点，已停在 (${origin.x}, ${origin.y}, ${origin.z})`
            );
          }
          if (scan.lava.length > 0) {
            const deep = scan.lava[0];
            log(ctx, '竖井深处有岩浆，先垫一层', `${deep.x}, ${deep.y}, ${deep.z}`);
          }
          if (scan.hazards.length > 0) {
            const first = scan.hazards[0];
            log(ctx, '附近有危险方块', `${label(ctx, first.name)} @ ${first.x}, ${first.y}, ${first.z}`);
          }

          const floorY = origin.y - 1;   // 要挖掉的脚下方块
          const landingY = origin.y - 2; // 挖完以后踩的方块
          const landing = classifyFooting(blockAt(ctx, origin.x, landingY, origin.z));

          if (landing === 'water') {
            let done = false;
            if (allowFill) {
              done = await placeBlockAt(ctx, origin.x, landingY, origin.z);
              if (done) filled += 1;
            }
            if (!done && allowDetour) {
              done = await detourColumn(ctx, origin, landingY);
              if (done) {
                detoured += 1;
                log(ctx, '绕到旁边的竖井', `目标 y=${targetY}`);
                continue; // 位置变了，下一轮重新扫描
              }
            }
            if (!done) {
              throw new Error(
                `危险：脚下 ${landingY} 格是水，没有能填埋的方块，也没有可以绕行的落脚点，已停在 (${origin.x}, ${origin.y}, ${origin.z})`
              );
            }
          } else if (landing === 'open') {
            // 没有落脚方块：先垫一块再挖。
            let done = false;
            if (allowFill) {
              done = await placeBlockAt(ctx, origin.x, landingY, origin.z);
              if (done) filled += 1;
            }
            if (!done) {
              const below = classifyFooting(blockAt(ctx, origin.x, landingY - 1, origin.z));
              if (below === 'lava') {
                throw new Error(
                  `危险：脚下 ${landingY - 1} 格是岩浆（${origin.x}, ${landingY - 1}, ${origin.z}），没有安全的落脚点，已停在 (${origin.x}, ${origin.y}, ${origin.z})`
                );
              }
              if (below === 'solid') {
                log(ctx, '没有方块可垫，直接下 2 格', `y=${landingY}`);
              } else {
                throw new Error(
                  `脚下 ${landingY} 格没有落脚方块，也没有能垫的方块，安全下降到 y=${origin.y - 1} 就停了`
                );
              }
            }
          }

          // 挖掉脚下的方块。
          const floorBlock = blockAt(ctx, origin.x, floorY, origin.z);
          if (!floorBlock || floorBlock.boundingBox !== 'block') {
            throw new Error(`脚下没有可以挖的方块，安全下降到 y=${origin.y - 1} 就停了`);
          }
          if (typeof ctx.breakBlock !== 'function') {
            throw new Error('没有挖掘能力，无法安全下降');
          }
          stopPathfinder(ctx);
          try {
            await ctx.breakBlock({ x: origin.x, y: floorY, z: origin.z });
          } catch (error) {
            const message = String((error && error.message) || error);
            if (message.includes('不能挖') || message.includes('镐')) {
              throw new Error(
                `还差一把能挖${label(ctx, floorBlock.name)}的镐，安全下降到 y=${floorY} 就停了：${message}`
              );
            }
            if (message.includes('没有')) throw error;
            throw new Error(`没有挖开脚下的${label(ctx, floorBlock.name)}，安全下降到 y=${floorY} 就停了：${message}`);
          }
          dug += 1;

          const landed = await waitForDescent(ctx, floorY);
          if (!landed) {
            throw new Error(`没有落到下一层，安全下降停在 y=${Math.floor(bot.entity.position.y)}`);
          }
          const afterY = Math.floor(bot.entity.position.y);
          const standing = blockAt(
            ctx,
            Math.floor(bot.entity.position.x),
            afterY - 1,
            Math.floor(bot.entity.position.z)
          );
          if (standing && isLava(standing.name)) {
            throw new Error(
              `危险：落下后踩到岩浆（${standing.position.x}, ${standing.position.y}, ${standing.position.z}），没有安全的落脚点`
            );
          }
        }
      } finally {
        restoreMovementSettings(ctx, settings);
      }

      const nowY = Math.floor(bot.entity.position.y);
      if (nowY > targetY) {
        throw new Error(`还差 ${nowY - targetY} 格才到 y=${targetY}，安全下降停在 y=${nowY}`);
      }
      const parts = [`安全下降到 y=${nowY}，挖了 ${dug} 层`];
      if (filled) parts.push(`填埋 ${filled} 处`);
      if (detoured) parts.push(`绕行 ${detoured} 次`);
      return { detail: parts.join('，'), status: 'succeeded' };
    },
  },

  // 落水脱困：确认脚下和身体是水，朝最近岸边游过去，上岸后回报。
  // skill_id 用 swim_escape，避开 survival.js 里的 swim_out。
  swim_escape: {
    description: '落水脱困：确认脚下和身体是水，朝最近的岸边游过去并上岸。',
    parameters: [
      {
        name: 'radius',
        type: 'number',
        required: false,
        default: 12,
        description: '找岸边的半径。',
      },
      {
        name: 'timeout_s',
        type: 'number',
        required: false,
        default: 25,
        description: '脱困的最长等待时间。',
      },
    ],
    handler: async (args, ctx) => {
      const bot = botOf(ctx);
      const radius = clampNumber(args.radius, 12, 4, 32);
      const timeoutMs = clampNumber(args.timeout_s, 25, 5, 120) * 1000;

      if (!detectWater(ctx)) {
        return { detail: '脚下和身体都不是水，现在不需要脱困', status: 'succeeded' };
      }

      let shore = null;
      if (typeof ctx.findShore === 'function') {
        shore = ctx.findShore(radius) || ctx.findShore(Math.min(radius * 2, 32));
      }
      if (!shore) {
        throw new Error('附近没有找到能上岸的岸边，水里脱困失败');
      }
      const shorePosition = shore.position;
      log(ctx, '往岸边游', `${shorePosition.x}, ${shorePosition.y}, ${shorePosition.z}`);

      const start = bot.entity.position.clone();
      const deadline = Date.now() + timeoutMs;
      let landed = false;
      while (Date.now() < deadline) {
        if (!detectWater(ctx)) {
          landed = true;
          break;
        }
        await swimStep(ctx, shorePosition);
      }
      if (!landed && !detectWater(ctx)) landed = true;

      // 上岸后清掉游泳时按下的控制键。
      if (typeof bot.getControlState === 'function' && bot.getControlState('jump')) {
        bot.setControlState('jump', false);
      }
      if (typeof bot.getControlState === 'function' && bot.getControlState('forward')) {
        bot.setControlState('forward', false);
      }

      const position = bot.entity.position;
      if (!landed) {
        throw new Error(
          `没有游到岸边（目标 ${shorePosition.x}, ${shorePosition.y}, ${shorePosition.z}），还在水里`
        );
      }
      const distance = Math.hypot(position.x - start.x, position.z - start.z);
      const ground = blockAt(ctx, Math.floor(position.x), Math.floor(position.y) - 1, Math.floor(position.z));
      const onLand = classifyFooting(ground) === 'solid';
      return {
        detail:
          `已游上岸，位置 (${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)})，` +
          `游了 ${distance.toFixed(1)} 格，岸边在 (${shorePosition.x}, ${shorePosition.y}, ${shorePosition.z})` +
          `${onLand ? '' : '，脚下还不是实地'}`,
        status: 'succeeded',
      };
    },
  },

  // 带避障的长距离移动：分段走，遇到危险方块绕行，失败重试并带上原因。
  safe_travel: {
    description: '带避障的长距离移动：分段走向目标坐标，遇到岩浆、火、仙人掌、深坑绕行，路径失败会重试并说明原因。',
    parameters: [
      { name: 'x', type: 'number', required: true, default: null, description: '目标 x 坐标。' },
      { name: 'y', type: 'number', required: true, default: null, description: '目标 y 坐标。' },
      { name: 'z', type: 'number', required: true, default: null, description: '目标 z 坐标。' },
      {
        name: 'maxDistance',
        type: 'number',
        required: false,
        default: 128,
        description: '最多走多少格，超过就不走。',
      },
      {
        name: 'radius',
        type: 'number',
        required: false,
        default: 2,
        description: '到目标附近多少格算到达。',
      },
      {
        name: 'timeout_s',
        type: 'number',
        required: false,
        default: 60,
        description: '整个移动的最长用时。',
      },
    ],
    handler: async (args, ctx) => {
      const bot = botOf(ctx);
      const target = { x: Number(args.x), y: Number(args.y), z: Number(args.z) };
      if (![target.x, target.y, target.z].every(Number.isFinite)) {
        throw new Error('需要目标坐标 x、y、z');
      }
      const maxDistance = clampNumber(args.maxDistance, 128, 1, 512);
      const radius = clampNumber(args.radius, 2, 1, 8);
      const deadline = Date.now() + clampNumber(args.timeout_s, 60, 5, 300) * 1000;

      const start = bot.entity.position;
      const distance = Math.hypot(target.x - start.x, target.z - start.z);
      if (distance > maxDistance) {
        throw new Error(`目标距离 ${distance.toFixed(0)} 格，超过了限距 ${maxDistance} 格，没有走`);
      }

      const settings = applyMovementSettings(ctx, {
        allowSprinting: false,
        allowParkour: false,
        canDig: false,
        maxDropDown: MAX_DROP_DOWN,
      });
      const failures = [];
      let detours = 0;
      let retries = 0;
      try {
        const segments = planTravelSegments(start, target, TRAVEL_SEGMENT);
        let cursor = { x: start.x, y: start.y, z: start.z };
        for (const segment of segments) {
          if (Date.now() > deadline) {
            throw new Error('没有在时限内走到目标，中途被叫停');
          }
          let waypoint = { x: segment.x, y: segment.y, z: segment.z };
          const scan = scanCorridor(ctx, cursor, waypoint);
          if (scan.hazards.length > 0 || scan.pits.length > 0) {
            const detour = pickDetour(ctx, cursor, waypoint);
            if (detour) {
              waypoint = detour;
              detours += 1;
              log(ctx, '绕开危险方块', `${waypoint.x}, ${waypoint.y}, ${waypoint.z}`);
            } else {
              const first = scan.hazards[0] || scan.pits[0];
              log(ctx, '附近绕不开，只能硬走', `${first.x}, ${first.y}, ${first.z}`);
            }
          }

          const outcome = await travelSegment(ctx, waypoint, radius, deadline);
          if (outcome.ok) {
            cursor = waypoint;
            continue;
          }
          failures.push({ kind: outcome.kind, at: waypoint });
          if (outcome.kind === 'cancelled') {
            throw new Error('移动被取消：收到新的指令或连接断开');
          }
          retries += 1;
          if (retries > MAX_TRAVEL_RETRIES) {
            throw new Error(
              `没有走到 (${waypoint.x}, ${waypoint.y}, ${waypoint.z})，失败原因：${outcome.kind}`
            );
          }
          log(ctx, '这一段没走通，重试一次', outcome.kind);
          await sleepMs(ctx, REPATH_INTERVAL_MS);
        }
      } finally {
        restoreMovementSettings(ctx, settings);
      }

      const position = bot.entity.position;
      const remaining = Math.hypot(target.x - position.x, target.z - position.z);
      const parts = [
        `走到 (${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)})，离目标还差 ${remaining.toFixed(1)} 格`,
      ];
      if (detours) parts.push(`绕行 ${detours} 次`);
      if (retries) {
        const kinds = failures.map((item) => item.kind).join('、');
        parts.push(`中途有 ${retries} 次路径失败（${kinds}），重试后继续`);
      }
      return { detail: parts.join('，'), status: 'succeeded' };
    },
  },

  // 受控跳跃：只在前方 1 格被挡或 1 格沟时跳，带冷却，能走就不跳。
  parkour_safe: {
    description: '受控跳跃：只在前方 1 格被挡或有 1 格沟时起跳，带跳跃冷却，落差能直接走就走。',
    parameters: [
      {
        name: 'count',
        type: 'number',
        required: false,
        default: 1,
        description: '连续做几步。',
      },
      {
        name: 'yaw',
        type: 'number',
        required: false,
        default: null,
        description: '跳跃方向，缺省用当前朝向。',
      },
    ],
    handler: async (args, ctx) => {
      const bot = botOf(ctx);
      const count = clampNumber(args.count, 1, 1, 8);
      const yaw = Number.isFinite(Number(args.yaw)) ? Number(args.yaw) : bot.entity.yaw;

      const settings = applyMovementSettings(ctx, {
        allowSprinting: false,
        allowParkour: false,
        canDig: false,
        maxDropDown: MAX_DROP_DOWN,
      });
      const events = [];
      let jumps = 0;
      let walks = 0;
      try {
        for (let index = 0; index < count; index += 1) {
          const front = describeFront(ctx, yaw);
          const plan = planParkour(front);
          if (plan.action === 'stop') {
            const position = bot.entity.position;
            throw new Error(
              `危险：${plan.reason}，停在 (${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)})`
            );
          }
          if (plan.action === 'jump') {
            const wait = jumpCooldownRemaining(lastJumpAt, Date.now());
            if (wait > 0) await sleepMs(ctx, wait);
            const moved = await performJump(ctx, yaw);
            if (!moved) {
              throw new Error('跳起来以后没有前进，安全起跳失败');
            }
            jumps += 1;
            events.push(`第${index + 1}步跳过去（${plan.reason}）`);
          } else {
            const moved = await stepForward(ctx, yaw);
            if (!moved) {
              throw new Error('前方走不动，没有继续');
            }
            walks += 1;
            events.push(`第${index + 1}步走过去（${plan.reason}）`);
          }
        }
      } finally {
        restoreMovementSettings(ctx, settings);
      }

      const position = bot.entity.position;
      return {
        detail:
          `受控移动 ${count} 步，跳了 ${jumps} 次，走了 ${walks} 步，` +
          `结束在 (${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)})：${events.join('；')}`,
        status: 'succeeded',
      };
    },
  },
};

// ------------------------------------------------------------------ 内部动作

// 脚下和身体是不是水。
function detectWater(ctx) {
  const bot = botOf(ctx);
  const position = bot.entity.position;
  const feet = blockAt(ctx, position.x, position.y, position.z);
  const head = blockAt(ctx, position.x, position.y + 1, position.z);
  return waterLike(ctx, feet) || waterLike(ctx, head);
}

// 往岸边游一步。
async function swimStep(ctx, shorePosition) {
  if (typeof ctx.swimToShore === 'function') {
    await ctx.swimToShore('落水脱困');
    return;
  }
  const bot = botOf(ctx);
  const position = bot.entity.position;
  const dx = shorePosition.x - position.x;
  const dz = shorePosition.z - position.z;
  const yaw = Math.atan2(-dx, -dz);
  await turnToward(ctx, yaw, 0);
  bot.setControlState('jump', true);
  bot.setControlState('forward', true);
  await sleepMs(ctx, 700);
}

// 走完一段：返回 { ok, kind }。
async function travelSegment(ctx, waypoint, radius, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { ok: false, kind: 'unreachable' };
  await respectRepathInterval(ctx);
  try {
    if (typeof ctx.walkOnce === 'function') {
      const outcome = await ctx.walkOnce(
        waypoint.x,
        waypoint.y,
        waypoint.z,
        Math.max(1, radius),
        remaining
      );
      if (outcome === 'reached') return { ok: true, kind: 'reached' };
      if (outcome === 'cancelled') return { ok: false, kind: 'cancelled' };
      return { ok: false, kind: outcome === 'unreachable' ? 'unreachable' : 'stopped' };
    }
    await ctx.travelTo(waypoint.x, waypoint.y, waypoint.z, Math.max(1, radius));
    return { ok: true, kind: 'reached' };
  } catch (error) {
    const message = String((error && error.message) || error);
    if (message.includes('打断') || message.includes('取消') || message.includes('断开')) {
      return { ok: false, kind: 'cancelled' };
    }
    return { ok: false, kind: classifyFailure(ctx, error), message };
  }
}

// 前方 1 格与 2 格的情况。
function describeFront(ctx, yaw) {
  const bot = botOf(ctx);
  const position = bot.entity.position;
  const feetY = Math.floor(position.y);
  const baseX = Math.floor(position.x);
  const baseZ = Math.floor(position.z);
  const near = forwardCell(yaw, 1);
  const far = forwardCell(yaw, 2);
  const nearX = baseX + near.dx;
  const nearZ = baseZ + near.dz;
  const farX = baseX + far.dx;
  const farZ = baseZ + far.dz;

  const ahead = blockAt(ctx, nearX, feetY, nearZ);
  const below = blockAt(ctx, nearX, feetY - 1, nearZ);
  const hazard = isHazardBlock(ahead && ahead.name) || isHazardBlock(below && below.name);

  // 前方挡住的高度：从脚高起算有几层实心方块。1 层是台阶，跳得上去；2 层跳不上去。
  let stack = 0;
  for (let offset = 0; offset <= 1; offset += 1) {
    const block = blockAt(ctx, nearX, feetY + offset, nearZ);
    if (block && block.boundingBox === 'block') stack += 1;
    else break;
  }
  const blocked = stack >= 1;
  const tooTall = stack >= 2;

  // 被挡住时脚下就是台阶本身，不用再看下面的地面。
  const nearGroundY = blocked ? null : groundHeight(ctx, nearX, feetY, nearZ);
  const farGroundY = groundHeight(ctx, farX, feetY, farZ);
  const drop = blocked ? 0 : nearGroundY === null ? 0 : feetY - 1 - nearGroundY;
  const pit = !blocked && (nearGroundY === null || drop > MAX_DROP_DOWN);
  const gap =
    !blocked && nearGroundY !== null && farGroundY !== null && farGroundY === feetY - 1 && drop >= 1;

  return { blocked, gap, drop, hazard, pit, tooTall, nearX, nearZ, feetY };
}

// 某个格子上脚下第一块实心地面的高度。
function groundHeight(ctx, x, feetY, z) {
  for (let offset = 1; offset <= 3; offset += 1) {
    const block = blockAt(ctx, x, feetY - offset, z);
    if (block && block.boundingBox === 'block') return feetY - offset;
  }
  return null;
}

// 起跳一次：转向 → 前进 + 跳 → 落地。
async function performJump(ctx, yaw) {
  const bot = botOf(ctx);
  const before = { x: bot.entity.position.x, z: bot.entity.position.z };
  await turnToward(ctx, yaw, 0);
  bot.setControlState('forward', true);
  bot.setControlState('jump', true);
  await sleepMs(ctx, 280);
  bot.setControlState('jump', false);
  await sleepMs(ctx, 260);
  bot.setControlState('forward', false);
  lastJumpAt = Date.now();
  const after = bot.entity.position;
  return Math.hypot(after.x - before.x, after.z - before.z) > 0.35;
}

// 往前走一格。
async function stepForward(ctx, yaw) {
  const bot = botOf(ctx);
  const position = bot.entity.position;
  const cell = forwardCell(yaw, 1);
  const targetX = Math.floor(position.x) + cell.dx;
  const targetZ = Math.floor(position.z) + cell.dz;
  const feetY = Math.floor(position.y);
  const before = { x: position.x, z: position.z };
  await turnToward(ctx, yaw, 0);
  if (typeof ctx.walkOnce === 'function') {
    await respectRepathInterval(ctx);
    const outcome = await ctx.walkOnce(targetX, feetY, targetZ, 0, 8000);
    if (outcome === 'cancelled') {
      throw new Error('移动被取消：收到新的指令或连接断开');
    }
    if (outcome === 'reached') {
      const after = bot.entity.position;
      return Math.hypot(after.x - before.x, after.z - before.z) > 0.2;
    }
  }
  // 寻路走不通就自己推一小段，行为更像玩家。
  bot.setControlState('forward', true);
  await sleepMs(ctx, 450);
  bot.setControlState('forward', false);
  const after = bot.entity.position;
  return Math.hypot(after.x - before.x, after.z - before.z) > 0.2;
}
