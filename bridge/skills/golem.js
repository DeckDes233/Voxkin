// 单只铁傀儡取铁：先靠近已验证的平坦站位，搭好三格柱，再受控下落攻击。
import { bestMeleeWeapon } from '../combat_encounter.js';

const PILLAR_HEIGHT = 3;
const PILLAR_CHECK_RADIUS = 1;
const MAX_ATTACKS = 32;
const MAX_STATE_CHECKS = 36;
const MAX_DROP_CHECKS = 6;
const MAX_APPROACH_ATTEMPTS = 8;
const MOVEMENT_CONTROLS = ['forward', 'back', 'left', 'right', 'sprint'];
const STATE_POLL_MS = 50;
const DROP_POLL_MS = 500;
const APPROACH_TIMEOUT_MS = 6000;
const MELEE_TARGET_HORIZONTAL_RANGE = 2.5;
const MELEE_EYE_RANGE = 3;
const SNEAK_EYE_HEIGHT = 1.27;
const CENTER_TOLERANCE = 0.38;
const DANGEROUS_BLOCKS = new Set([
  'cactus', 'campfire', 'fire', 'lava', 'magma_block', 'powder_snow',
  'sweet_berry_bush', 'water', 'wither_rose',
]);
const UNSTABLE_BLOCKS = new Set([
  'anvil', 'chipped_anvil', 'damaged_anvil', 'dragon_egg', 'scaffolding',
  'slime_block', 'honey_block', 'tnt',
]);
const PREFERRED_PILLAR_BLOCKS = [
  'cobblestone', 'cobbled_deepslate', 'stone', 'dirt', 'coarse_dirt',
  'rooted_dirt', 'grass_block', 'oak_planks', 'spruce_planks', 'birch_planks',
  'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks',
  'cherry_planks', 'bamboo_planks', 'crimson_planks', 'warped_planks',
  'hay_block', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate',
  'blackstone', 'netherrack', 'sandstone', 'red_sandstone', 'stone_bricks',
];
const PARTIAL_BLOCK_SUFFIX = /_(?:slab|stairs|wall|fence|fence_gate|pane|door|trapdoor|button|pressure_plate|carpet|bed|sign|hanging_sign|banner|rail|torch|ladder|chain|rod|coral_fan)$/;
const NON_FLAT_BLOCK_NAMES = new Set([
  'dirt_path', 'farmland', 'soul_sand', 'soul_soil', 'snow', 'powder_snow',
]);

function interrupted(ctx) {
  if (ctx.interrupted) throw new Error('采集铁傀儡时被新的指令打断');
}

function isCancellation(ctx, error) {
  return Boolean(ctx.interrupted || error && error.name === 'AbortError');
}

function blockAt(ctx, x, y, z) {
  const bot = ctx.bot;
  if (typeof bot.blockAt !== 'function') return null;
  const origin = bot.entity.position;
  const position = typeof origin.offset === 'function'
    ? origin.offset(x - origin.x, y - origin.y, z - origin.z)
    : { x, y, z };
  return bot.blockAt(position);
}

function blockName(block) {
  return String(block && block.name || '').toLowerCase();
}

function isSafeFullBlock(block) {
  if (!block || block.boundingBox !== 'block') return false;
  const name = blockName(block);
  return !DANGEROUS_BLOCKS.has(name) && !UNSTABLE_BLOCKS.has(name) &&
    !NON_FLAT_BLOCK_NAMES.has(name) && !PARTIAL_BLOCK_SUFFIX.test(name) &&
    !/(?:^|_)(?:sand|gravel)$/.test(name) && !/_concrete_powder$/.test(name) &&
    !/_leaves$/.test(name);
}

function isOpenBlock(block) {
  if (!block) return false;
  const name = blockName(block);
  return ['air', 'cave_air', 'void_air'].includes(name) || block.boundingBox === 'empty';
}

function choosePillarBlock(ctx) {
  const bot = ctx.bot;
  const definitions = bot.registry && bot.registry.blocksByName;
  const items = bot.inventory && typeof bot.inventory.items === 'function'
    ? bot.inventory.items()
    : [];
  const held = new Set(items.map((item) => item && item.name).filter(Boolean));
  const preferredOrder = new Map(PREFERRED_PILLAR_BLOCKS.map((name, index) => [name, index]));
  const candidates = [...held]
    .filter((name) => {
      const definition = definitions && definitions[name];
      return definition && isSafeFullBlock(definition) && Number(ctx.countItem(name)) >= PILLAR_HEIGHT;
    })
    .sort((left, right) => {
      const leftRank = preferredOrder.has(left) ? preferredOrder.get(left) : PREFERRED_PILLAR_BLOCKS.length;
      const rightRank = preferredOrder.has(right) ? preferredOrder.get(right) : PREFERRED_PILLAR_BLOCKS.length;
      return leftRank - rightRank || left.localeCompare(right);
    });
  return candidates[0] || null;
}

function ironGolemById(ctx, id) {
  const value = String(id ?? '');
  if (!value) return null;
  const entity = ctx.bot.entities && ctx.bot.entities[value];
  if (!entity || entity.isValid === false || entity.name !== 'iron_golem' || !entity.position) return null;
  return entity;
}

function targetIsAlive(ctx, golem) {
  if (!golem || golem.isValid === false) return false;
  if (Number.isFinite(Number(golem.health)) && Number(golem.health) <= 0) return false;
  return !ctx.bot.entities || golem.id === undefined || Boolean(ctx.bot.entities[String(golem.id)]);
}

function currentGolem(ctx, id) {
  const entity = ironGolemById(ctx, id);
  return entity && targetIsAlive(ctx, entity) ? entity : null;
}

function hostileList(ctx) {
  if (typeof ctx.nearbyHostiles !== 'function') return null;
  const entities = ctx.nearbyHostiles(12);
  return Array.isArray(entities) ? entities : null;
}

function dayCheck(bot) {
  if (bot.time && typeof bot.time.isDay === 'boolean') return bot.time.isDay;
  const time = Number(bot.time && bot.time.timeOfDay);
  return Number.isFinite(time) && time >= 0 && time < 12000;
}

function basicReadinessReason(ctx) {
  const bot = ctx.bot;
  if (Number(bot.health) <= 10 || !Number.isFinite(Number(bot.health))) {
    return '血量必须高于 10 点';
  }
  if (!dayCheck(bot)) return '必须在白天采集铁傀儡';
  if (!bestMeleeWeapon(bot)) return '背包里没有近战武器';
  if (typeof ctx.placeBlock !== 'function') return '桥接没有放置方块能力';
  if (typeof ctx.equipWeapon !== 'function') return '桥接没有装备武器能力';
  if (typeof ctx.countItem !== 'function') return '无法读取铁锭库存';
  if (typeof ctx.sleep !== 'function') return '无法等待跳跃和攻击冷却';
  if (typeof bot.setControlState !== 'function' || typeof bot.attack !== 'function') {
    return '桥接没有安全控制跳跃或近战攻击的能力';
  }
  if (!choosePillarBlock(ctx)) return '至少需要 3 个可靠的全实体垫脚方块';
  if (!hostileList(ctx)) return '无法检查周围敌对生物';
  if (typeof ctx.retreatFrom !== 'function') return '桥接没有撤离能力';
  return '';
}

function safeSiteAt(ctx, x, z, baseY) {
  for (let dx = -PILLAR_CHECK_RADIUS; dx <= PILLAR_CHECK_RADIUS; dx += 1) {
    for (let dz = -PILLAR_CHECK_RADIUS; dz <= PILLAR_CHECK_RADIUS; dz += 1) {
      const ground = blockAt(ctx, x + dx, baseY - 1, z + dz);
      if (!isSafeFullBlock(ground)) return false;
      if (DANGEROUS_BLOCKS.has(blockName(blockAt(ctx, x + dx, baseY, z + dz)))) return false;
    }
  }
  for (let y = baseY; y <= baseY + PILLAR_HEIGHT + 2; y += 1) {
    if (!isOpenBlock(blockAt(ctx, x, y, z))) return false;
  }
  return true;
}

function preflight(ctx, golem) {
  const readiness = basicReadinessReason(ctx);
  if (readiness) return { reason: readiness };

  const bot = ctx.bot;
  const position = bot.entity.position;
  if (bot.entity.onGround !== true) return { reason: '必须先站稳在地面上' };
  const feetY = Math.round(position.y);
  if (Math.abs(position.y - feetY) > 0.16) return { reason: '玩家没有稳在整格地面高度' };
  const x = Math.floor(position.x);
  const z = Math.floor(position.z);
  if (Math.abs(position.x - (x + 0.5)) > CENTER_TOLERANCE ||
      Math.abs(position.z - (z + 0.5)) > CENTER_TOLERANCE) {
    return { reason: '必须站在方块中央，才能安全搭建立柱' };
  }
  if (!safeSiteAt(ctx, x, z, feetY)) return { reason: '脚下周围没有平坦、安全且有足够空间的实体地面' };

  const hostiles = hostileList(ctx);
  if (hostiles === null) return { reason: '无法检查周围敌对生物' };
  if (hostiles.length > 0) return { reason: '周围有敌对生物，暂不激怒铁傀儡' };

  const targetHeight = Number(golem.position.y);
  if (!Number.isFinite(targetHeight) || feetY - targetHeight < -0.05) {
    return { reason: '铁傀儡站位高于当前地面，三格立柱不能保证安全' };
  }
  const attackY = feetY + PILLAR_HEIGHT;
  const targetHorizontal = Math.hypot(position.x - golem.position.x, position.z - golem.position.z);
  const targetVertical = Math.max(0, golem.position.y + Number(golem.height || 2.7) - attackY);
  if (targetHorizontal > MELEE_TARGET_HORIZONTAL_RANGE || targetVertical > 2.7) {
    return { reason: '铁傀儡离三格立柱过远，无法安全近战' };
  }

  return {
    base: { x, y: feetY, z },
    block: choosePillarBlock(ctx),
    weapon: bestMeleeWeapon(bot),
  };
}

function candidateSites(ctx, golem) {
  const player = ctx.bot.entity.position;
  const minY = Math.ceil(Number(golem.position.y) - 0.05);
  const playerY = Math.round(player.y);
  const baseYs = [...new Set([
    playerY, playerY - 1, playerY + 1, playerY - 2, playerY + 2,
    minY, minY + 1, minY + 2,
  ])].filter((y) => Number.isInteger(y) && y >= minY);
  const sites = new Map();
  for (let ring = 1.8; ring <= 2.5; ring += 0.35) {
    for (let index = 0; index < 16; index += 1) {
      const angle = (Math.PI * 2 * index) / 16;
      const x = Math.floor(golem.position.x + Math.cos(angle) * ring);
      const z = Math.floor(golem.position.z + Math.sin(angle) * ring);
      const centerX = x + 0.5;
      const centerZ = z + 0.5;
      const horizontal = Math.hypot(centerX - golem.position.x, centerZ - golem.position.z);
      if (horizontal > MELEE_TARGET_HORIZONTAL_RANGE || horizontal < 1.2) continue;
      for (const baseY of baseYs) {
        if (!safeSiteAt(ctx, x, z, baseY)) continue;
        const key = `${x},${baseY},${z}`;
        if (!sites.has(key)) {
          const distance = Math.hypot(centerX - player.x, centerZ - player.z) + Math.abs(baseY - playerY) * 2;
          sites.set(key, { x, z, baseY, centerX, centerZ, distance });
        }
      }
    }
  }
  return [...sites.values()].sort((left, right) => left.distance - right.distance);
}

async function approachSafeSite(ctx, entityId) {
  const initial = currentGolem(ctx, entityId);
  if (!initial) return { reason: '指定的铁傀儡在靠近前已消失' };
  const initialSite = preflight(ctx, initial);
  if (!initialSite.reason) return { checks: initialSite, attempts: 0 };
  const readiness = basicReadinessReason(ctx);
  if (readiness) return { reason: `未开始靠近：${readiness}` };

  if (typeof ctx.walkOnce !== 'function' && typeof ctx.travelTo !== 'function') {
    return { reason: '没有有界寻路能力，无法靠近平坦安全站位' };
  }
  const candidates = candidateSites(ctx, initial);
  if (candidates.length === 0) return { reason: '铁傀儡附近没有可验证的平坦安全站位' };

  let attempts = 0;
  for (const candidate of candidates) {
    if (attempts >= MAX_APPROACH_ATTEMPTS) break;
    interrupted(ctx);
    const liveBefore = currentGolem(ctx, entityId);
    if (!liveBefore) return { reason: '指定的铁傀儡在靠近时已消失', attempts };
    const hostiles = hostileList(ctx);
    if (hostiles === null || hostiles.length > 0) return { reason: '靠近前发现周围敌对生物，未激怒铁傀儡', attempts };
    const stillNear = Math.hypot(candidate.centerX - liveBefore.position.x, candidate.centerZ - liveBefore.position.z);
    if (stillNear > MELEE_TARGET_HORIZONTAL_RANGE ||
        candidate.baseY < Math.ceil(Number(liveBefore.position.y) - 0.05)) continue;

    attempts += 1;
    try {
      let outcome = 'reached';
      if (typeof ctx.walkOnce === 'function') {
        outcome = await ctx.walkOnce(candidate.centerX, candidate.baseY, candidate.centerZ, 0, APPROACH_TIMEOUT_MS);
        interrupted(ctx);
        if (outcome === 'cancelled') {
          const error = new Error('采集铁傀儡时靠近站位被取消');
          error.name = 'AbortError';
          throw error;
        }
        if (outcome !== 'reached') continue;
      } else {
        await ctx.travelTo(candidate.centerX, candidate.baseY, candidate.centerZ, 0);
        interrupted(ctx);
      }
    } catch (error) {
      if (isCancellation(ctx, error)) throw error;
      continue;
    }

    // 寻路后重新读取实体和实际玩家位置，不能把候选坐标当成到达证据。
    const liveAfter = currentGolem(ctx, entityId);
    if (!liveAfter) return { reason: '靠近后指定的铁傀儡已消失', attempts };
    const checks = preflight(ctx, liveAfter);
    if (!checks.reason) return { checks, attempts };
  }
  return { reason: '没有靠到可验证的近战安全站位', attempts };
}

function pillarBlocksPresent(ctx, pillar, height = PILLAR_HEIGHT) {
  for (let offset = 0; offset < height; offset += 1) {
    const block = blockAt(ctx, pillar.x, pillar.baseY + offset, pillar.z);
    if (!block || block.name !== pillar.block || !isSafeFullBlock(block)) return false;
  }
  return true;
}

function unsafeTerrainReason(ctx, pillar) {
  const bot = ctx.bot;
  const position = bot.entity.position;
  if (Math.abs(position.x - (pillar.x + 0.5)) > CENTER_TOLERANCE ||
      Math.abs(position.z - (pillar.z + 0.5)) > CENTER_TOLERANCE) {
    return '玩家偏离立柱中心';
  }
  const placedCount = Math.min(PILLAR_HEIGHT, Math.max(0, Number(pillar.placedCount) || 0));
  if (!pillarBlocksPresent(ctx, pillar, placedCount)) return '已搭建的垫脚方块缺失或不再可靠';
  if (pillar.verified && (placedCount !== PILLAR_HEIGHT || !pillarBlocksPresent(ctx, pillar))) {
    return '三格立柱有方块缺失或不再可靠';
  }
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      const ground = blockAt(ctx, pillar.x + dx, pillar.baseY - 1, pillar.z + dz);
      const atBase = blockAt(ctx, pillar.x + dx, pillar.baseY, pillar.z + dz);
      if (!isSafeFullBlock(ground) || DANGEROUS_BLOCKS.has(blockName(atBase))) {
        return '立柱周围地形出现危险';
      }
    }
  }
  const headY = pillar.baseY + placedCount;
  if (!isOpenBlock(blockAt(ctx, pillar.x, headY, pillar.z)) ||
      !isOpenBlock(blockAt(ctx, pillar.x, headY + 1, pillar.z))) {
    return '立柱上方空间被占用';
  }
  const hostiles = hostileList(ctx);
  if (hostiles === null) return '无法继续检查周围敌对生物';
  if (hostiles.length > 0) return '周围出现敌对生物';
  return '';
}

function safeFightReason(ctx, golem, pillar, requireGrounded = true) {
  const bot = ctx.bot;
  const terrainReason = unsafeTerrainReason(ctx, pillar);
  if (terrainReason) return terrainReason;
  if (Number(bot.health) <= 10 || !Number.isFinite(Number(bot.health))) return '血量降到 10 点或更低';
  if (!pillar.verified) return '尚未验证三格立柱的实际高度';
  const position = bot.entity.position;
  const expectedY = pillar.baseY + PILLAR_HEIGHT;
  if (requireGrounded) {
    if (bot.entity.onGround !== true || Math.abs(position.y - expectedY) > 0.16) {
      return '玩家没有稳在三格立柱顶端';
    }
  } else if (position.y < expectedY - 0.1 || position.y > expectedY + 1.8) {
    return '跳跃高度偏离已验证的立柱';
  }
  const live = currentGolem(ctx, golem && golem.id);
  if (!live) return '指定的铁傀儡已消失';
  if (position.y - live.position.y < 2.9) return '铁傀儡高度变化，立柱不再足够安全';
  const horizontal = Math.hypot(position.x - live.position.x, position.z - live.position.z);
  if (horizontal > MELEE_TARGET_HORIZONTAL_RANGE) return '铁傀儡离开安全近战范围';
  return '';
}

function eyeToTargetAabbDistance(bot, target) {
  if (!bot || !bot.entity || !bot.entity.position || !target || !target.position) return Infinity;
  const player = bot.entity.position;
  const position = target.position;
  const width = Number(target.width) > 0 ? Number(target.width) : 1.4;
  const height = Number(target.height) > 0 ? Number(target.height) : 2.7;
  const eyeY = Number(player.y) + SNEAK_EYE_HEIGHT;
  const dx = Math.max(0, Math.abs(Number(player.x) - Number(position.x)) - width / 2);
  const dz = Math.max(0, Math.abs(Number(player.z) - Number(position.z)) - width / 2);
  const dy = eyeY < position.y ? position.y - eyeY : eyeY > position.y + height ? eyeY - position.y - height : 0;
  return Math.hypot(dx, dy, dz);
}

async function sleepChecked(ctx, duration, golem, pillar, requireGrounded = false) {
  interrupted(ctx);
  await ctx.sleep(duration);
  interrupted(ctx);
  return safeFightReason(ctx, golem, pillar, requireGrounded);
}

async function waitForJumpAscent(ctx, golem, pillar, startY) {
  for (let check = 0; check < MAX_STATE_CHECKS; check += 1) {
    interrupted(ctx);
    const unsafe = safeFightReason(ctx, golem, pillar, false);
    if (unsafe) return { ok: false, reason: unsafe };
    const entity = ctx.bot.entity;
    if (entity.onGround === false && entity.position.y >= startY + 1.05) return { ok: true };
    const reason = await sleepChecked(ctx, STATE_POLL_MS, golem, pillar, false);
    if (reason) return { ok: false, reason };
  }
  return { ok: false, reason: '没有确认跳到可攻击高度' };
}

async function waitForDescentAttackWindow(ctx, golem, pillar) {
  for (let check = 0; check < MAX_STATE_CHECKS; check += 1) {
    interrupted(ctx);
    const unsafe = safeFightReason(ctx, golem, pillar, false);
    if (unsafe) return { ok: false, reason: unsafe, landed: false };
    const entity = ctx.bot.entity;
    const falling = entity.onGround === false && Number(entity.velocity && entity.velocity.y) < -0.01;
    if (falling) {
      const distance = eyeToTargetAabbDistance(ctx.bot, currentGolem(ctx, golem.id));
      if (distance <= MELEE_EYE_RANGE) return { ok: true, distance, landed: false };
    }
    if (entity.onGround === true) {
      return { ok: false, reason: '下降到落地前没有进入铁傀儡近战距离', landed: true };
    }
    const reason = await sleepChecked(ctx, STATE_POLL_MS, golem, pillar, false);
    if (reason) return { ok: false, reason, landed: false };
  }
  return { ok: false, reason: '下降阶段没有确认可触及铁傀儡的攻击窗口', landed: false };
}

async function waitForLanding(ctx, pillar) {
  const expectedY = pillar.baseY + PILLAR_HEIGHT;
  for (let check = 0; check < MAX_STATE_CHECKS; check += 1) {
    interrupted(ctx);
    const terrainReason = unsafeTerrainReason(ctx, pillar);
    if (terrainReason) return { ok: false, reason: terrainReason };
    if (Number(ctx.bot.health) <= 10 || !Number.isFinite(Number(ctx.bot.health))) {
      return { ok: false, reason: '血量降到 10 点或更低' };
    }
    const entity = ctx.bot.entity;
    if (entity.onGround === true && Math.abs(entity.position.y - expectedY) <= 0.16) return { ok: true };
    interrupted(ctx);
    await ctx.sleep(STATE_POLL_MS);
    interrupted(ctx);
  }
  return { ok: false, reason: '没有落回已验证的三格立柱顶端' };
}

async function waitForPillarAscent(ctx, pillar, startY) {
  for (let check = 0; check < MAX_STATE_CHECKS; check += 1) {
    interrupted(ctx);
    const terrainReason = unsafeTerrainReason(ctx, pillar);
    if (terrainReason) return { ok: false, reason: terrainReason };
    if (ctx.bot.entity.onGround === false && ctx.bot.entity.position.y >= startY + 1.05) return { ok: true };
    interrupted(ctx);
    await ctx.sleep(STATE_POLL_MS);
    interrupted(ctx);
  }
  return { ok: false, reason: '没有确认跳到可安全放置方块的高度' };
}

async function waitForPillarLanding(ctx, pillar, expectedY) {
  for (let check = 0; check < MAX_STATE_CHECKS; check += 1) {
    interrupted(ctx);
    const terrainReason = unsafeTerrainReason(ctx, pillar);
    if (terrainReason) return { ok: false, reason: terrainReason };
    const entity = ctx.bot.entity;
    if (entity.onGround === true && Math.abs(entity.position.y - expectedY) <= 0.16) return { ok: true };
    interrupted(ctx);
    await ctx.sleep(STATE_POLL_MS);
    interrupted(ctx);
  }
  return { ok: false, reason: '没有确认落在新放置的垫脚方块上' };
}

async function buildPillar(ctx, pillar) {
  const bot = ctx.bot;
  for (let offset = 0; offset < PILLAR_HEIGHT; offset += 1) {
    interrupted(ctx);
    const expectedStart = pillar.baseY + offset;
    if (bot.entity.onGround !== true || Math.abs(bot.entity.position.y - expectedStart) > 0.16) {
      return { ok: false, reason: '搭柱时没有稳在预期高度' };
    }
    const hostiles = hostileList(ctx);
    if (!hostiles || hostiles.length > 0) return { ok: false, reason: '搭柱时附近出现敌对生物或无法检查威胁' };
    const golem = currentGolem(ctx, pillar.entityId);
    if (!golem) return { ok: false, reason: '搭柱时指定的铁傀儡已消失' };
    const targetY = pillar.baseY + offset;
    if (!isOpenBlock(blockAt(ctx, pillar.x, targetY, pillar.z))) {
      return { ok: false, reason: '立柱目标位置不再是空位' };
    }

    bot.setControlState('jump', true);
    const ascent = await waitForPillarAscent(ctx, pillar, expectedStart);
    bot.setControlState('jump', false);
    if (!ascent.ok) return ascent;

    pillar.attempted = true;
    await ctx.placeBlock({ block: pillar.block, x: pillar.x, y: targetY, z: pillar.z });
    interrupted(ctx);
    const placed = blockAt(ctx, pillar.x, targetY, pillar.z);
    if (!placed || placed.name !== pillar.block || !isSafeFullBlock(placed)) {
      return { ok: false, reason: `没有确认第 ${offset + 1} 个垫脚方块` };
    }
    pillar.placedCount = offset + 1;
    const landed = await waitForPillarLanding(ctx, pillar, targetY + 1);
    if (!landed.ok) return landed;
  }
  if (!pillarBlocksPresent(ctx, pillar)) return { ok: false, reason: '没有确认完整三格立柱' };
  if (Math.abs(bot.entity.position.y - (pillar.baseY + PILLAR_HEIGHT)) > 0.16 || bot.entity.onGround !== true) {
    return { ok: false, reason: '搭柱后没有确认实际高度为三格' };
  }
  pillar.verified = true;
  return { ok: true };
}

function cooldownForWeapon(name) {
  return String(name || '').endsWith('_axe') ? 1300 : 750;
}

async function waitForCooldown(ctx, golem, pillar, lastAttackAt, cooldownMs) {
  let waited = 0;
  while (lastAttackAt !== null && waited < cooldownMs) {
    const unsafe = safeFightReason(ctx, golem, pillar, true);
    if (unsafe) return unsafe;
    const duration = Math.min(100, cooldownMs - waited);
    const reason = await sleepChecked(ctx, duration, golem, pillar, true);
    if (reason) return reason;
    waited += duration;
  }
  return '';
}

async function retreat(ctx, golem) {
  if (targetIsAlive(ctx, golem) && typeof ctx.retreatFrom === 'function') {
    return Boolean(await ctx.retreatFrom(golem));
  }
  return false;
}

function receipt(status, detail, data = {}) {
  return { status, detail, data };
}

async function harvestIronGolem(args, ctx) {
  const entityId = args && args.entity_id;
  const golem = ironGolemById(ctx, entityId);
  if (!golem) return receipt('partial', '指定的铁傀儡当前不可见或已消失，没有开始攻击', {
    entity_id: entityId,
    iron_ingot_gained: 0,
  });

  const before = Math.max(0, Math.floor(Number(ctx.countItem && ctx.countItem('iron_ingot')) || 0));
  const approach = await approachSafeSite(ctx, entityId);
  if (approach.reason) return receipt('partial', `未开始采集：${approach.reason}`, {
    entity_id: golem.id,
    approach_attempts: approach.attempts || 0,
    iron_ingot_before: before,
    iron_ingot_after: before,
    iron_ingot_gained: 0,
  });

  const liveGolem = currentGolem(ctx, entityId);
  if (!liveGolem) return receipt('partial', '到达安全站位后指定的铁傀儡已消失，没有开始攻击', {
    entity_id: golem.id,
    approach_attempts: approach.attempts,
    iron_ingot_before: before,
    iron_ingot_after: before,
    iron_ingot_gained: 0,
  });
  const checks = preflight(ctx, liveGolem);
  if (checks.reason) return receipt('partial', `未开始采集：${checks.reason}`, {
    entity_id: liveGolem.id,
    approach_attempts: approach.attempts,
    iron_ingot_before: before,
    iron_ingot_after: before,
    iron_ingot_gained: 0,
  });

  const pillar = {
    x: checks.base.x,
    z: checks.base.z,
    baseY: checks.base.y,
    block: checks.block,
    entityId: liveGolem.id,
    placedCount: 0,
    attempted: false,
    verified: false,
  };
  let stopReason = '';
  let attacks = 0;
  let lastAttackAt = null;
  let targetGone = false;
  let retreatConfirmed = false;
  let equippedWeapon = '';
  let pendingError = null;

  try {
    for (const control of MOVEMENT_CONTROLS) ctx.bot.setControlState(control, false);
    ctx.bot.setControlState('sneak', true);
    const build = await buildPillar(ctx, pillar);
    if (!build.ok) {
      stopReason = build.reason;
    } else {
      const verified = safeFightReason(ctx, liveGolem, pillar, true);
      if (verified) {
        stopReason = verified;
      } else {
        await ctx.equipWeapon();
        interrupted(ctx);
        equippedWeapon = String(ctx.bot.heldItem && ctx.bot.heldItem.name || '');
        if (!/_sword$|_axe$/.test(equippedWeapon)) stopReason = '装备后没有确认手持近战武器';
      }
    }

    while (!stopReason && attacks < MAX_ATTACKS && targetIsAlive(ctx, liveGolem)) {
      interrupted(ctx);
      stopReason = safeFightReason(ctx, liveGolem, pillar, true);
      if (stopReason) break;
      const cooldown = await waitForCooldown(ctx, liveGolem, pillar, lastAttackAt, cooldownForWeapon(equippedWeapon));
      if (cooldown) {
        stopReason = cooldown;
        break;
      }
      stopReason = safeFightReason(ctx, liveGolem, pillar, true);
      if (stopReason) break;

      const startY = ctx.bot.entity.position.y;
      ctx.bot.setControlState('jump', true);
      const ascent = await waitForJumpAscent(ctx, liveGolem, pillar, startY);
      ctx.bot.setControlState('jump', false);
      if (!ascent.ok) {
        stopReason = ascent.reason;
        break;
      }
      const window = await waitForDescentAttackWindow(ctx, liveGolem, pillar);
      if (!window.ok) {
        stopReason = window.reason;
        if (!window.landed) {
          const landing = await waitForLanding(ctx, pillar);
          if (!landing.ok) stopReason = landing.reason;
        }
        break;
      }

      const current = currentGolem(ctx, entityId);
      if (!current) {
        stopReason = '指定的铁傀儡在攻击窗口前已消失';
        break;
      }
      if (typeof ctx.bot.lookAt === 'function') {
        const aim = typeof current.position.offset === 'function'
          ? current.position.offset(0, Number(current.height || 2.7) * 0.5, 0)
          : current.position;
        await ctx.bot.lookAt(aim, true);
        interrupted(ctx);
      }
      stopReason = safeFightReason(ctx, current, pillar, false);
      if (!stopReason) {
        const player = ctx.bot.entity;
        const distance = eyeToTargetAabbDistance(ctx.bot, currentGolem(ctx, entityId));
        if (player.onGround !== false || Number(player.velocity && player.velocity.y) >= -0.01) {
          stopReason = '没有确认处于安全的下降攻击阶段';
        } else if (distance > MELEE_EYE_RANGE) {
          stopReason = '转向后铁傀儡超出实际近战距离';
        }
      }
      if (stopReason) {
        const landing = await waitForLanding(ctx, pillar);
        if (!landing.ok) stopReason = landing.reason;
        break;
      }

      // 只发送一次下降阶段近战攻击，不声称游戏已确认暴击。
      ctx.bot.attack(current);
      attacks += 1;
      lastAttackAt = Date.now();

      const landing = await waitForLanding(ctx, pillar);
      if (!landing.ok) {
        stopReason = landing.reason;
        break;
      }
    }
    targetGone = attacks > 0 && !targetIsAlive(ctx, liveGolem);
    if (!stopReason && !targetGone && attacks >= MAX_ATTACKS) stopReason = '达到单只铁傀儡攻击次数上限';
  } catch (error) {
    pendingError = error;
  } finally {
    let cleanupError = null;
    for (const control of [...MOVEMENT_CONTROLS, 'jump', 'sneak']) {
      try {
        ctx.bot.setControlState(control, false);
      } catch (error) {
        cleanupError ||= error;
      }
    }
    if (cleanupError) throw cleanupError;
  }

  if (pendingError) {
    if (pillar.attempted && !ctx.interrupted && targetIsAlive(ctx, liveGolem)) {
      retreatConfirmed = await retreat(ctx, liveGolem);
    }
    throw pendingError;
  }

  if (stopReason && targetIsAlive(ctx, liveGolem)) retreatConfirmed = await retreat(ctx, liveGolem);

  if (targetGone) {
    for (let attempt = 0; attempt < MAX_DROP_CHECKS; attempt += 1) {
      interrupted(ctx);
      const current = Math.max(0, Math.floor(Number(ctx.countItem('iron_ingot')) || 0));
      if (current > before) break;
      if (typeof ctx.collectDrops === 'function') await ctx.collectDrops(8, 'iron_ingot');
      interrupted(ctx);
      const afterPickup = Math.max(0, Math.floor(Number(ctx.countItem('iron_ingot')) || 0));
      if (afterPickup > before) break;
      await ctx.sleep(DROP_POLL_MS);
    }
  }

  const after = Math.max(0, Math.floor(Number(ctx.countItem('iron_ingot')) || 0));
  const gained = Math.max(0, after - before);
  const data = {
    entity_id: liveGolem.id,
    approach_attempts: approach.attempts,
    target_gone: targetGone,
    pillar: {
      block: pillar.block,
      base: checks.base,
      height: pillar.placedCount,
      verified: pillar.verified,
    },
    attacks,
    iron_ingot_before: before,
    iron_ingot_after: after,
    iron_ingot_gained: gained,
    retreat_confirmed: retreatConfirmed,
    stop_reason: stopReason || null,
  };

  if (targetGone && gained > 0) {
    return receipt('succeeded', `确认指定铁傀儡消失后，背包铁锭增加 ${gained} 个，共 ${after} 个`, data);
  }
  if (targetGone) {
    return receipt('partial', '铁傀儡已消失，但背包铁锭数量没有增加，不报告取铁成功', data);
  }
  return receipt('partial', `已停止对铁傀儡的攻击${stopReason ? `：${stopReason}` : ''}，铁锭没有增加`, data);
}

export const skills = {
  harvest_iron_golem: {
    description:
      '采集一只指定的可见铁傀儡：验证白天、血量、近战武器、三块稳定垫脚方块、平坦安全站位和周围威胁；有界靠近安全站位后搭建并确认三格立柱，蹲伏并在冷却完成且下降时、眼位进入目标实体近战距离后攻击，按背包铁锭增量确认结果。',
    parameters: [
      { name: 'entity_id', type: 'number', required: true, description: '本次唯一允许攻击的可见铁傀儡实体 ID。' },
    ],
    handler: harvestIronGolem,
  },
};
