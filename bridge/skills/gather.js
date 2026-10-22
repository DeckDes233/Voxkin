// 采集与挖矿模块：mine_collect / strip_mine / deep_mine / find_diamond。
// 模块契约见 docs/plans/SKILL_MODULE_CONTRACT.md。
// 本模块只使用 ctx 提供的能力，不 import mineflayer / pathfinder / 其它运行时依赖。
//
// 待接入（集成阶段补 ctx，或在本模块内已经兜底处理）：
// - 挖矿时没有“看手上工具耐久”的独立能力，这里直接读 ctx.bot.heldItem.durabilityUsed。
// - 填埋岩浆要靠背包里的圆石/泥土，这里用 ctx.countItem + ctx.placeBlock 组合。
// - 火把靠 ctx.countItem('torch') 盘点，缺货时用 ctx.craftItem 补；
//   如果 ctx 没有 craftItem，就只能在返回里说明缺什么。

// 掉落在这一格之外的掉落物就算离得太远，捡不到。
const COLLECT_DROP_RANGE = 6;
// 挖方块的有效距离：超过这个距离就必须先走过去。
const MINE_REACH = 4.5;
// 挖矿途中血量低于这个值就中止。
const LOW_HEALTH = 8;
// 火把间隔：每挖多少格放一个。
const TORCH_INTERVAL = 8;
// 钻石矿的两种 id，普通钻石矿在深层是 deepslate_diamond_ore。
const DIAMOND_ORES = ['diamond_ore', 'deepslate_diamond_ore'];
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

// 四个正方向的朝向表，yaw 0 面向 +Z（南），顺时针增大。
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

// 朝向换算：Minecraft 的 yaw 0 面向 +Z，顺时针增大。
export function directionFromYaw(yaw) {
  const angle = Number(yaw);
  if (!Number.isFinite(angle)) return null;
  const index = Math.round(angle / (Math.PI / 2));
  return CARDINAL_HEADINGS[((index % 4) + 4) % 4];
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
}

// 低血就停，不继续往危险里走。
function checkHealth(ctx, limit = LOW_HEALTH) {
  const health = Number(ctx.bot?.health);
  if (!Number.isFinite(health)) return;
  if (health <= limit) throw new Error(`血量不足（血量 ${health}），已中止采集`);
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

// 找目标方块。世界刚重置时区块还没加载完，要等一等再找。
async function findCandidateBlocks(ctx, ids, range, count) {
  const bot = ctx.bot;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const positions = bot.findBlocks({ matching: ids, maxDistance: range, count });
    if (positions.length > 0) return positions;
    if (typeof bot.waitForChunksToLoad === 'function') {
      await Promise.race([
        bot.waitForChunksToLoad().catch(() => {}),
        ctx.sleep(3000),
      ]);
    }
    await ctx.sleep(1200);
  }
  return [];
}

// 挖一个方块。先按方块换工具，再挖。
// 返回 { ok, reason, message }，失败不抛错，由调用方决定算不算致命。
async function digAt(ctx, position, options = {}) {
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
    return { ok: false, reason: 'tool', message: `换工具失败：${error.message}` };
  }
  if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(block)) {
    return { ok: false, reason: 'tool', block, message: '工具不对或者离得太远，挖不动' };
  }
  try {
    await bot.dig(block);
  } catch (error) {
    return { ok: false, reason: 'dig', block, message: `挖不动：${error.message}` };
  }
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
async function stepForward(ctx, position) {
  if (typeof ctx.walkOnce !== 'function') return 'reached';
  const outcome = await ctx.walkOnce(position.x, position.y, position.z, 1, 8000);
  if (outcome === 'cancelled') throw new Error('挖矿被取消：收到新的指令或连接断开');
  return outcome;
}

// 往前挖一格：先确认前方不是岩浆/水，再把前方那一格和它的头顶两格挖开，
// 确认走廊安全（头顶 2 格与前方 1 格都是空气）之后才走进去。
async function digForward(ctx, position, heading, state, options = {}) {
  const bot = ctx.bot;
  const front = offsetPos(position, heading.x, 0, heading.z);
  const frontBlock = blockAtPos(bot, front);
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
      if (!dug.ok) {
        return { ok: false, reason: dug.reason, position: at, message: `头顶挖不开：${dug.message}` };
      }
      state.mined += 1;
    }
  }
  const dug = await digAt(ctx, front);
  if (!dug.ok) {
    return { ok: false, reason: dug.reason, position: front, message: dug.message };
  }
  state.mined += 1;
  // 等方块更新同步到客户端再寻路。
  await ctx.sleep(250);
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
    notes.push(`火把没合成出来（${error.message}），背包里只有 ${have} 个`);
    return { ok: false, have };
  }
  const after = ctx.countItem('torch');
  if (after <= have) {
    notes.push(`火把没合成出来，背包里只有 ${after} 个`);
    return { ok: false, have: after };
  }
  return { ok: true, have: after };
}

// 放火把：放在刚挖开的那一格的地面上，bot 还站在上一格，不会被自己挡住。
async function placeTorch(ctx, cell, state, notes) {
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
    notes.push(`火把没放下去：${error.message}`);
    return false;
  }
  const placed = blockAtPos(bot, spot);
  if (placed && (placed.name === 'torch' || placed.name === 'redstone_torch' || placed.name === 'soul_torch')) {
    state.torches += 1;
    return true;
  }
  notes.push('火把没出现在那一格');
  return false;
}

// 垂直竖井下降。每往下一格都要先确认脚下 3 格没有岩浆。
async function digShaftDown(ctx, depth, state) {
  const bot = ctx.bot;
  for (let step = 0; step < depth; step += 1) {
    requireConnected(ctx);
    checkHealth(ctx);
    const feet = floorPos(bot.entity.position);
    const below = offsetPos(feet, 0, -1, 0);
    const target = blockAtPos(bot, below);
    if (isLavaBlock(target)) {
      throw new Error(`挖竖井时遇到岩浆，已停止：岩浆在 ${formatPosition(below)}`);
    }
    if (isWaterBlock(target)) {
      throw new Error(`挖竖井时遇到水，已停止：水在 ${formatPosition(below)}`);
    }
    // 脚下 3 格里有岩浆就不要继续往下挖了。
    const hazards = scanHazards(bot, feet, null, { ahead: 0, down: 0, below: 3 });
    if (hazards.lava.length > 0) {
      throw new Error(`挖竖井时脚下的岩浆，已停止：岩浆在 ${formatPosition(hazards.lava[0])}`);
    }
    const dug = await digAt(ctx, below);
    if (!dug.ok) {
      throw new Error(`竖井挖不下去：${dug.message}（坐标 ${formatPosition(below)}）`);
    }
    state.mined += 1;
    // 脚下被挖空之后会掉下去，等落地再继续。
    await ctx.sleep(700);
  }
}

// 挖一条支巷，然后原路走回主巷。
async function digBranch(ctx, junction, heading, length, state) {
  const side = pickPerpendicular(ctx, junction, heading);
  if (!side) return false;
  let position = junction;
  for (let step = 1; step <= length; step += 1) {
    const result = await digForward(ctx, position, side, state, { countSteps: false });
    if (!result.ok) return false;
    position = result.position;
  }
  state.branches += 1;
  // 原路退回主巷。
  for (let step = 0; step < length; step += 1) {
    const back = offsetPos(position, -side.x, 0, -side.z);
    const walk = await stepForward(ctx, back);
    if (walk !== 'reached') return false;
    position = back;
  }
  return true;
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
async function mineCollect(args, ctx) {
  const bot = ctx.bot;
  requireConnected(ctx);
  const registry = registryOf(ctx);
  const blockName = String(args.block || 'stone').trim();
  const want = clampInt(args.count, 1, 1, 64);
  const range = clampInt(args.range, 32, 8, 64);
  if (!registry?.blocksByName?.[blockName]) throw new Error(`未知方块 ${blockName}`);
  const entry = registry.blocksByName[blockName];
  const blockLabel = blockLabelOf(ctx, blockName);
  // 挖石头拿到的是圆石，挖钻石矿拿到的是钻石，数量按掉落物算。
  const itemName = dropItemName(registry, entry, blockName);
  const label = itemLabelOf(ctx, itemName, blockLabel);
  const owned = ctx.countItem(itemName);
  const need = want - owned;
  if (need <= 0) {
    return { detail: `背包里已经有 ${owned} 个${label}，不需要再挖`, status: 'succeeded' };
  }
  const positions = await findCandidateBlocks(ctx, entry.id, range, Math.max(need * 4, 8));
  if (positions.length === 0) {
    throw new Error(`附近 ${range} 格内没有${blockLabel}，一个都没有找到`);
  }
  let mined = 0;
  const failures = [];
  for (const position of positions) {
    if (ctx.countItem(itemName) - owned >= need) break;
    requireConnected(ctx);
    const block = blockAtPos(bot, position);
    if (!block || block.name !== blockName) {
      failures.push(`${formatPosition(position)} 的${blockLabel}已经不见了`);
      continue;
    }
    const distance = distanceBetween(bot.entity.position, position);
    if (distance > MINE_REACH) {
      const outcome = await ctx.travelToBlock(position, 30000);
      if (outcome === 'cancelled') throw new Error('采集被取消：收到新的指令或连接断开');
      if (outcome === 'low_health') throw new Error(`血量不足，撤退中止采集（血量 ${bot.health}）`);
      if (outcome !== 'reached') {
        failures.push(`${formatPosition(position)} 距离 ${distance.toFixed(1)} 格，太远走不过去`);
        continue;
      }
    }
    const dug = await digAt(ctx, position, { expectName: blockName });
    if (!dug.ok) {
      failures.push(`${formatPosition(position)} ${dug.message}`);
      continue;
    }
    mined += 1;
    const dropped = await collectDrop(ctx, itemName);
    if (dropped.gained > 0) continue;
    const state = dropFailureState(ctx, position);
    failures.push(`${formatPosition(position)} ${classifyDropOutcome(state)}`);
  }
  const gained = ctx.countItem(itemName) - owned;
  if (gained <= 0) {
    throw new Error(
      `试了 ${positions.length} 个目标，没有拿到${label}${failures.length ? `：${failures.join('；')}` : ''}`,
    );
  }
  if (gained < need) {
    throw new Error(
      `${summarizeShortage(gained, need, label)}（挖了 ${mined} 个，失败 ${failures.length} 次：${failures.join('；')}）`,
    );
  }
  return {
    detail: `挖了 ${mined} 个${blockLabel}，获得 ${gained} 个${label}，背包共 ${ctx.countItem(itemName)} 个`,
    status: 'succeeded',
  };
}

// ---------------------------------------------------------------------------
// 技能：strip_mine
// ---------------------------------------------------------------------------

// 挖一条主巷道加若干分支。头顶 2 格与前方 1 格必须通得过，
// 沿途放火把，遇到岩浆或水立刻停下并上报坐标。
async function stripMine(args, ctx) {
  const bot = ctx.bot;
  requireConnected(ctx);
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

  // 火把：先用 ctx 的合成能力补货，没有就记下来继续挖。
  const torchPlan = torchInterval > 0 ? Math.floor(length / torchInterval) + 1 : 0;
  await ensureTorches(ctx, torchPlan, notes);

  // 先挖竖井到目标高度。
  if (shaft > 0) {
    await digShaftDown(ctx, shaft, state);
  } else if (targetY !== null && start.y > targetY) {
    await digShaftDown(ctx, start.y - targetY, state);
  }

  let heading = args.direction ? directionFromName(args.direction) : directionFromYaw(bot.entity.yaw);
  if (!heading) heading = CARDINAL_HEADINGS[0];
  let position = floorPos(bot.entity.position);
  if (targetY !== null && position.y !== targetY) {
    notes.push(`目标 Y 是 ${targetY}，现在在 ${position.y}，差 ${Math.abs(position.y - targetY)} 格`);
  }
  const branchEvery = branchCount > 0 ? Math.max(2, Math.floor(length / (branchCount + 1))) : 0;
  const ores = [];
  const seenOre = new Set();

  for (let step = 1; step <= length; step += 1) {
    requireConnected(ctx);
    checkHealth(ctx);
    const wantTorch = torchInterval > 0 && step % torchInterval === 0;
    const result = await digForward(ctx, position, heading, state, {
      torch: wantTorch,
      notes,
    });
    if (!result.ok) {
      if (result.reason === 'hazard') {
        throw new Error(
          `${result.message}，已停止挖矿：坐标 ${formatPosition(result.position)}（已挖 ${state.steps} 格长度的巷道）`,
        );
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
      if (!done) notes.push(`第 ${step} 格的支巷没挖成`);
    }
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
    await digShaftDown(ctx, start.y - targetY, state);
  } else if (start.y < targetY) {
    notes.push(`现在在 Y=${start.y}，已经比目标 ${targetY} 更深，就在这里挖`);
  }

  let heading = args.direction ? directionFromName(args.direction) : directionFromYaw(bot.entity.yaw);
  if (!heading) heading = CARDINAL_HEADINGS[0];
  let position = floorPos(bot.entity.position);
  const branchEvery = branchCount > 0 ? Math.max(2, Math.floor(length / (branchCount + 1))) : 0;

  for (let step = 1; step <= length; step += 1) {
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
    if (branchEvery > 0 && step % branchEvery === 0 && state.branches < branchCount) {
      const done = await digBranch(ctx, position, heading, branchLength, state);
      if (!done) notes.push(`第 ${step} 格的支巷没挖成`);
    }
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
      const placed = blockAtPos(bot, target);
      if (placed && !isHazardBlock(placed)) {
        state.filled += 1;
        notes.push(`用${blockLabelOf(ctx, material)}填住了 ${formatPosition(hazard)}`);
        return true;
      }
    } catch (error) {
      notes.push(`填埋失败：${error.message}`);
      return false;
    }
  }
  return false;
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
  const hits = positions.filter((position) => position.y >= yMin && position.y <= yMax).slice(0, want);
  if (hits.length === 0) {
    throw new Error(`在 Y ${yMin} 到 ${yMax} 的区间内没有找到钻石矿（搜了 ${radius} 格）`);
  }
  const detail = hits.map((position) => {
    const block = blockAtPos(bot, position);
    const name = block && isDiamondOre(block.name) ? block.name : DIAMOND_ORES[0];
    return `${name} ${formatPosition(position)}`;
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
  mine_collect: {
    description:
      '挖指定方块：按目标换工具，挖掉之后等掉落物，走过去真的捡起来，最后核对背包数量。',
    parameters: [
      { name: 'block', type: 'string', required: true, default: null, description: '目标方块 ID，例如 oak_log、stone、iron_ore。' },
      { name: 'count', type: 'number', required: true, default: 1, description: '要拿到的总数量，按掉落物算（挖石头得到圆石，挖钻石矿得到钻石），背包里已有的算在内。' },
      { name: 'range', type: 'number', required: false, default: 32, description: '搜索目标的半径，8-64 格。' },
    ],
    handler: mineCollect,
  },
  strip_mine: {
    description:
      '挖一条主巷道加若干分支，头顶 2 格与前方 1 格必须通得过，沿途放火把，遇岩浆或水停下并上报坐标。',
    parameters: [
      { name: 'length', type: 'number', required: false, default: 32, description: '主巷道长度（格）。' },
      { name: 'branches', type: 'number', required: false, default: 2, description: '支巷数量。' },
      { name: 'branchLength', type: 'number', required: false, default: 8, description: '每条支巷的长度（格）。' },
      { name: 'shaft', type: 'number', required: false, default: 0, description: '开始前先挖多深的垂直竖井。' },
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
