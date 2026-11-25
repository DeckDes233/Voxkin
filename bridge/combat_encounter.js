// 自动战斗共享的威胁评估；实体元数据索引由当前版本的 registry 提供。
export const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'spider', 'creeper', 'witch', 'enderman', 'slime',
  'magma_cube', 'pillager', 'vindicator', 'drowned', 'husk', 'stray',
  'phantom', 'blaze', 'ghast', 'zoglin', 'hoglin', 'piglin_brute', 'warden',
  'guardian', 'elder_guardian', 'shulker', 'silverfish', 'endermite', 'vex',
  'ravager', 'evoker', 'illusioner', 'wither',
]);

const RANGED_THREATS = new Set([
  'blaze', 'ghast', 'wither', 'pillager', 'skeleton', 'stray',
  'crossbow_illager', 'evoker', 'witch', 'guardian', 'elder_guardian',
]);
const HEAVY_THREATS = new Set(['warden', 'ravager', 'wither', 'elder_guardian', 'piglin_brute']);
const CREEPER_ALERT_RANGE = 12;
const WARDEN_AVOID_RANGE = 16;
const HEAVY_AVOID_RANGE = 10;

function distance3(a, b) {
  if (!a || !b) return Infinity;
  const dx = Number(a.x) - Number(b.x);
  const dy = Number(a.y) - Number(b.y);
  const dz = Number(a.z) - Number(b.z);
  if (![dx, dy, dz].every(Number.isFinite)) return Infinity;
  return Math.hypot(dx, dy, dz);
}

function closingSpeed(entity, origin) {
  const velocity = entity && entity.velocity;
  if (!velocity || !entity.position) return 0;
  const dx = Number(origin.x) - Number(entity.position.x);
  const dz = Number(origin.z) - Number(entity.position.z);
  const length = Math.hypot(dx, dz);
  if (!Number.isFinite(length) || length < 0.001) return 0;
  const vx = Number(velocity.x) || 0;
  const vz = Number(velocity.z) || 0;
  return (vx * dx + vz * dz) / length;
}

function metadataValue(entity, key, metadataKeys) {
  const metadata = entity && entity.metadata;
  if (!metadata) return undefined;
  if (!Array.isArray(metadata) && Object.prototype.hasOwnProperty.call(metadata, key)) {
    return metadata[key];
  }
  const index = Array.isArray(metadataKeys) ? metadataKeys.indexOf(key) : -1;
  return index >= 0 ? metadata[index] : undefined;
}

function flagIsSet(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function endermanIsAggressive(entity, registry) {
  const metadataKeys = registry && registry.entitiesByName && registry.entitiesByName.enderman
    ? registry.entitiesByName.enderman.metadataKeys
    : null;
  const flags = [
    entity.creepy,
    entity.staredAt,
    entity.aggressive,
    entity.isAngry,
    entity.is_angry,
    metadataValue(entity, 'creepy', metadataKeys),
    metadataValue(entity, 'stared_at', metadataKeys),
    metadataValue(entity, 'aggressive', metadataKeys),
    metadataValue(entity, 'is_angry', metadataKeys),
  ];
  if (flags.some(flagIsSet)) return true;
  const target = entity.target ?? entity.targetId ?? entity.target_id;
  return target !== undefined && target !== null && target !== -1 && target !== 0;
}

// 末影人只有已激怒、已锁定目标或当前被明确指定时才算交战威胁。
export function isAutomaticCombatTarget(entity, registry) {
  const name = String(entity && entity.name || '').toLowerCase();
  if (!entity || !HOSTILE_MOBS.has(name)) return false;
  return name !== 'enderman' || endermanIsAggressive(entity, registry);
}

const MATERIAL_TIERS = new Map([
  ['wooden', 1], ['golden', 1], ['stone', 2], ['iron', 3], ['diamond', 4], ['netherite', 5],
  ['leather', 1], ['chainmail', 2],
]);

function itemTier(name) {
  const material = String(name || '').split('_', 1)[0];
  return MATERIAL_TIERS.get(material) || 0;
}

export function bestMeleeWeapon(bot) {
  const items = bot && bot.inventory && typeof bot.inventory.items === 'function'
    ? bot.inventory.items()
    : [];
  let best = null;
  for (const item of items) {
    if (!item || !/_(sword|axe)$/.test(String(item.name || ''))) continue;
    const tier = itemTier(item.name);
    const preferred = item.name.endsWith('_sword') && !(best && best.item.name.endsWith('_sword'));
    if (!best || tier > best.tier || (tier === best.tier && preferred)) best = { item, tier };
  }
  return best ? best.item : null;
}

// 使用 Mineflayer 当前背包槽位估算近战准备度；重型敌人需要铁级武器和大部分铁甲。
export function combatEquipment(bot) {
  const items = bot && bot.inventory && typeof bot.inventory.items === 'function'
    ? bot.inventory.items()
    : [];
  const bestWeapon = bestMeleeWeapon(bot);
  const weaponTier = bestWeapon ? itemTier(bestWeapon.name) : 0;
  const armor = [5, 6, 7, 8]
    .map((slot) => bot && bot.inventory && bot.inventory.slots && bot.inventory.slots[slot])
    .filter((item) => item && /_(helmet|chestplate|leggings|boots)$/.test(String(item.name || '')));
  const armorTier = Math.max(0, ...armor.map((item) => itemTier(item.name)));
  const protectivePieces = armor.filter((item) => itemTier(item.name) >= 3).length;
  return {
    weapon_tier: weaponTier,
    armor_tier: armorTier,
    armor_pieces: armor.length,
    armor_protective_pieces: protectivePieces,
    combat_ready: weaponTier >= 3 && protectivePieces >= 3,
  };
}

function creeperIsFusing(entity, registry) {
  const metadataKeys = registry && registry.entitiesByName && registry.entitiesByName.creeper
    ? registry.entitiesByName.creeper.metadataKeys
    : null;
  const swell = Number(
    entity.swellDirection ?? entity.swell_dir ?? metadataValue(entity, 'swell_dir', metadataKeys),
  );
  const ignited =
    flagIsSet(entity.isIgnited) ||
    flagIsSet(entity.is_ignited) ||
    flagIsSet(metadataValue(entity, 'is_ignited', metadataKeys));
  return ignited || (Number.isFinite(swell) && swell > 0);
}

function threatScore(name, distance, closing, fusing) {
  const strength = HEAVY_THREATS.has(name) ? 5 : RANGED_THREATS.has(name) ? 3 : 2;
  const proximity = distance <= 4 ? 3 : distance <= 8 ? 2 : distance <= 12 ? 1 : 0;
  const approach = closing >= 0.35 ? 1 : 0;
  const creeper = name === 'creeper' ? 2 : 0;
  return strength + proximity + approach + creeper + (fusing ? 100 : 0);
}

function retreatThreatWeight(threat) {
  const entry = threat && threat.name ? threat : { name: String(threat?.entity?.name || '') };
  const base = entry.fusing ? 10 : entry.name === 'warden' ? 8 :
    HEAVY_THREATS.has(entry.name) ? 5 : RANGED_THREATS.has(entry.name) ? 3 : 2;
  const distance = Number(threat && threat.distance);
  return base * (Number.isFinite(distance) ? 1 + Math.max(0, 16 - distance) / 16 : 1);
}

function retreatSafeRange(threat) {
  if (threat.name === 'creeper') return 10 + (threat.fusing ? 2 : 0);
  if (threat.name === 'warden') return 16;
  if (HEAVY_THREATS.has(threat.name)) return 11;
  if (RANGED_THREATS.has(threat.name)) return 14;
  return 7;
}

// 给候选退路打分：距离威胁越远越好，落入攻击距离时加重惩罚。
export function retreatSafetyScore(position, threats) {
  if (!position) return -Infinity;
  return (threats || []).reduce((total, threat) => {
    const entity = threat && threat.entity;
    if (!entity || !entity.position) return total;
    const distance = distance3(position, entity.position);
    const safeRange = retreatSafeRange(threat);
    const weight = retreatThreatWeight(threat);
    return total + distance * weight - Math.max(0, safeRange - distance) * weight * 6;
  }, 0);
}

// 沿现有 12 格后撤距离比较周围方向，不引入新的导航机制。
export function chooseRetreatDestination(origin, threats, { stepDistance = 12, candidateCount = 16 } = {}) {
  if (!origin || !Array.isArray(threats) || threats.length === 0) return null;
  const distance = Number(stepDistance);
  const count = Math.max(4, Math.floor(Number(candidateCount) || 16));
  if (!Number.isFinite(distance) || distance <= 0) return null;
  let best = null;
  for (let index = 0; index < count; index += 1) {
    const angle = (Math.PI * 2 * index) / count;
    const candidate = {
      x: Math.floor(Number(origin.x) + Math.cos(angle) * distance),
      z: Math.floor(Number(origin.z) + Math.sin(angle) * distance),
    };
    const score = retreatSafetyScore({ x: candidate.x, y: Number(origin.y) || 0, z: candidate.z }, threats);
    if (!best || score > best.score) best = { ...candidate, score };
  }
  return best;
}

// 低血量寻食时，区分脚下洞穴里的僵尸与同一地面的近身威胁。
export function zombieBehindFloor(bot, entity) {
  if (!['zombie', 'husk', 'zombie_villager'].includes(entity?.name)) return false;
  return twoSolidLayers(bot, bot.entity?.position, entity.position);
}

export function magmaCubeAboveCeiling(bot, entity, feet = bot.entity?.position) {
  return entity?.name === 'magma_cube' && twoSolidLayers(bot, entity.position, feet);
}

export function creeperBehindRock(bot, entity) {
  if (entity?.name !== 'creeper' || creeperIsFusing(entity, bot.registry)) return false;
  const feet = bot.entity?.position;
  const mob = entity.position;
  if (!feet || !mob || Math.abs(feet.y - mob.y) < 6 || Math.hypot(feet.x - mob.x, feet.z - mob.z) > 6) return false;
  return feet.y > mob.y ? twoSolidLayers(bot, feet, mob, 1) : twoSolidLayers(bot, mob, feet, 1);
}

function fullCollisionBlock(block) {
  return block?.shapes?.some(shape => shape.length === 6 && shape.every((v, i) => v === (i < 3 ? 0 : 1)));
}

export function magmaCubeBehindCover(bot, entity, feet = bot.entity?.position) {
  if (entity?.name !== 'magma_cube' || !feet || !entity.position) return false;
  if (magmaCubeAboveCeiling(bot, entity, feet)) return true;
  const mob = entity.position;
  const dx = mob.x - feet.x, dz = mob.z - feet.z, horizontal = Math.hypot(dx, dz);
  if (horizontal < 5 || horizontal > 12 || typeof feet.offset !== 'function' || typeof bot.blockAt !== 'function') return false;
  const axis = Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z';
  const side = axis === 'x' ? 'z' : 'x';
  const sign = Math.sign(mob[axis] - feet[axis]);
  const end = Math.floor(mob[axis]);
  // 检查两格厚、三格宽、四格高的整块岩壁。贴近、缺块或绕过墙后立即恢复警戒。
  for (let col = Math.floor(feet[axis]) + sign; (end - col) * sign >= 2; col += sign) {
    const t = (col + 0.5 - feet[axis]) / (mob[axis] - feet[axis]);
    const across = Math.floor(feet[side] + t * (mob[side] - feet[side]));
    const y = Math.floor(feet.y + 1 + t * (mob.y + 0.8 - feet.y - 1));
    const base = feet.floored();
    const wall = axis === 'x' ? base.offset(col - base.x, y - base.y, across - base.z)
                              : base.offset(across - base.x, y - base.y, col - base.z);
    let solid = true;
    for (let d = 0; d < 2 && solid; d++) for (let w = -1; w <= 1 && solid; w++) {
      for (let h = -1; h <= 2 && solid; h++) {
        solid = fullCollisionBlock(bot.blockAt(wall.offset(axis === 'x' ? sign * d : w, h, axis === 'x' ? w : sign * d), false));
      }
    }
    if (solid) return true;
  }
  return false;
}

function twoSolidLayers(bot, origin, target, radius = 0) {
  if (!origin || !target || origin.y - target.y < 6) return false;
  const depth = origin.y - target.y;
  let layers = 0;
  for (let y = Math.floor(origin.y) - 1; y > target.y + 2; y--) {
    const fraction = (origin.y - y - 0.5) / depth;
    const point = origin.offset((target.x - origin.x) * fraction, y + 0.5 - origin.y, (target.z - origin.z) * fraction);
    const center = point.floored();
    let solid = true;
    for (let x = -radius; x <= radius && solid; x++) for (let z = -radius; z <= radius && solid; z++) {
      const block = bot.blockAt(center.offset(x, 0, z), false);
      if (!block) return false;
      solid = fullCollisionBlock(block);
    }
    layers = solid ? layers + 1 : 0;
    if (layers >= 2) return true;
  }
  return false;
}

// 返回当前可见的敌对实体、威胁分数和是否该暂停交战。
export function assessCombatEncounter({
  entities,
  origin,
  registry,
  health,
  radius = 16,
  currentTarget,
  equipment,
  behindFloor,
}) {
  const maximum = Number(radius);
  const safeRadius = Number.isFinite(maximum) ? Math.max(0, maximum) : 16;
  const threats = [];
  for (const entity of Object.values(entities || {})) {
    if (!entity || !entity.position || entity.isValid === false) continue;
    const name = String(entity.name || '').toLowerCase();
    if (!HOSTILE_MOBS.has(name)) continue;
    if (name === 'enderman' && entity !== currentTarget && !endermanIsAggressive(entity, registry)) continue;
    const distance = distance3(origin, entity.position);
    if (distance > safeRadius) continue;
    if (entity !== currentTarget && behindFloor?.(entity)) continue;
    const closing = closingSpeed(entity, origin);
    const fusing = name === 'creeper' && creeperIsFusing(entity, registry);
    threats.push({
      entity,
      name,
      distance,
      closing_speed: closing,
      fusing,
      score: threatScore(name, distance, closing, fusing),
    });
  }

  threats.sort((left, right) =>
    right.score - left.score || left.distance - right.distance || String(left.entity.id).localeCompare(String(right.entity.id))
  );
  const closeThreats = threats.filter((entry) => entry.distance <= 12);
  const pressure = closeThreats.reduce((total, entry) => total + entry.score, 0);
  const urgentCreeper = threats.find((entry) =>
    entry.name === 'creeper' && (
      (entry.fusing && entry.distance <= CREEPER_ALERT_RANGE) ||
      entry.distance <= 5 ||
      (entry.distance <= 9 && entry.closing_speed >= 0.65)
    )
  );
  const knownHealth = Number(health);
  const equipmentKnown = Boolean(equipment && typeof equipment === 'object');
  const weaponTier = Number(equipment && equipment.weapon_tier) || 0;
  const protectivePieces = Number(equipment && equipment.armor_protective_pieces) || 0;
  const lowCombatCapacity = equipmentKnown && !equipment.combat_ready;
  const pressureThreshold = lowCombatCapacity
    ? weaponTier < 2 ? 12 : protectivePieces < 3 ? 15 : 20
    : 20;
  const overmatched =
    (knownHealth <= 6 && closeThreats.length > 0) ||
    (knownHealth <= 10 && pressure >= 7) ||
    (knownHealth <= 14 && pressure >= 10) ||
    (knownHealth <= 18 && pressure >= 14) ||
    pressure >= pressureThreshold;
  const wardenThreat = threats.find((entry) => entry.name === 'warden' && entry.distance <= WARDEN_AVOID_RANGE);
  const heavyThreat = threats.find((entry) =>
    entry.name !== 'warden' && HEAVY_THREATS.has(entry.name) && entry.distance <= HEAVY_AVOID_RANGE,
  );
  const weakAgainstHeavy = Boolean(heavyThreat && !(equipment && equipment.combat_ready));

  let retreatReason = '';
  if (urgentCreeper) {
    retreatReason = urgentCreeper.fusing
      ? `苦力怕正在引爆（${urgentCreeper.distance.toFixed(1)} 格）`
      : `苦力怕正在接近（${urgentCreeper.distance.toFixed(1)} 格）`;
  } else if (wardenThreat) {
    retreatReason = `附近有監守者（${wardenThreat.distance.toFixed(1)} 格），先避开`;
  } else if (weakAgainstHeavy) {
    retreatReason = `装备不足以应对${heavyThreat.name}（${heavyThreat.distance.toFixed(1)} 格），先撤退`;
  } else if (overmatched) {
    retreatReason = `群怪威胁过高（${closeThreats.length} 只，威胁分 ${pressure}，生命值 ${Number.isFinite(knownHealth) ? knownHealth : '未知'}）`;
  }

  return {
    threats,
    primary: threats[0] || null,
    urgent: urgentCreeper || wardenThreat || (weakAgainstHeavy ? heavyThreat : null) || threats[0] || null,
    pressure,
    should_retreat: Boolean(urgentCreeper || wardenThreat || weakAgainstHeavy || overmatched),
    retreat_reason: retreatReason,
  };
}

// 自动反击只在另一只敌对生物明显更危险时换目标；显式 attack_target 不调用此函数。
export function selectEncounterTarget(encounter, currentTarget) {
  const best = encounter && encounter.primary;
  if (!best || !currentTarget || currentTarget.isValid === false) return best ? best.entity : currentTarget;
  const current = encounter.threats.find((entry) => entry.entity === currentTarget);
  if (!current) return best.entity;
  return best.entity !== currentTarget && best.score >= current.score + 2
    ? best.entity
    : currentTarget;
}

// 单次出手门禁：撤退优先于切换目标，调用方在每次出手前重复执行。
export async function evaluateEncounterStep({
  entities,
  origin,
  registry,
  health,
  radius = 16,
  requestedTarget,
  currentTarget,
  allowTargetSwitch = false,
  equipment,
  retreat,
  behindFloor,
}) {
  const encounter = assessCombatEncounter({ entities, origin, registry, health, radius, currentTarget, equipment, behindFloor });
  if (encounter.should_retreat) {
    const threat = encounter.urgent && encounter.urgent.entity
      ? encounter.urgent.entity
      : currentTarget;
    const movedAway = typeof retreat === 'function' ? await retreat(threat) : false;
    return {
      status: 'retreated',
      encounter,
      threat,
      moved_away: Boolean(movedAway),
      requested_target: requestedTarget,
    };
  }

  const nextTarget = allowTargetSwitch
    ? selectEncounterTarget(encounter, currentTarget)
    : currentTarget;
  return {
    status: 'continue',
    encounter,
    target: nextTarget,
    switched: Boolean(nextTarget && nextTarget !== currentTarget),
  };
}
