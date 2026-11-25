import { inspectResourceSites } from './resource_sites.js';
import { onConnectedBank, shallowSurfaceExit, shoreHeadroomBlock, surfaceSkyLight, waterLike } from './water_escape.js';

const portalRooms = new WeakMap();

export function dragonHealth(bot, dragon) {
  if (!dragon || dragon.isValid === false) return null;
  const key = bot?.registry?.entitiesByName?.ender_dragon?.metadataKeys?.indexOf('health');
  const value = dragon.health ?? dragon.metadata?.[key];
  return Number.isFinite(value) ? value : null;
}

function observeDragon(bot) {
  if (!['the_end', 'minecraft:the_end'].includes(bot?.game?.dimension)) return null;
  const entity = Object.values(bot.entities || {}).find(e => e?.name === 'ender_dragon' && e.isValid !== false);
  const hp = dragonHealth(bot, entity);
  if (hp !== null && entity.position) {
    return { health: hp, position: { x: entity.position.x, y: entity.position.y, z: entity.position.z } };
  }
  const bar = bot.bossBars?.find(b => b.isDragonBar && (b.title?.translate ?? b.title?.json?.translate) === 'entity.minecraft.ender_dragon');
  return bar && Number.isFinite(bar.health) ? { health_fraction: bar.health, source: 'dragon_boss_bar' } : null;
}

function observePortalRoom(bot) {
  const p = bot?.entity?.position;
  const id = bot?.registry?.blocksByName?.end_portal_frame?.id;
  if (!p || id == null || !bot.findBlocks || !['overworld', 'minecraft:overworld'].includes(bot.game?.dimension)) return null;
  const cache = portalRooms.get(bot);
  if (cache && Date.now() - cache.time < 1000 && p.distanceTo(cache.position) < 3) return cache.room;
  const frames = [];
  for (const pos of bot.findBlocks({ matching: id, maxDistance: 12, count: 12 })) {
    const block = bot.blockAt(pos, false);
    if (block?.name !== 'end_portal_frame' || !bot.canSeeBlock?.(block)) continue;
    const eye = block.getProperties().eye;
    if (![true, false, 'true', 'false', 0, 1].includes(eye)) continue;
    frames.push({ x: pos.x, y: pos.y, z: pos.z, filled: eye === true || eye === 'true' || eye === 1 });
  }
  const room = frames.length ? { frames } : null;
  portalRooms.set(bot, { time: Date.now(), position: p.clone(), room });
  return room;
}

function observeSurfaceAccess(bot, makeVec) {
  const position = bot?.entity?.position;
  if (!position || !['overworld', 'minecraft:overworld'].includes(bot.game?.dimension) || !bot.blockAt) return null;
  const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
  const sky = surfaceSkyLight(bot, makeVec(x, y + 1, z));
  if (!Number.isFinite(sky)) return null;
  const access = { sky_light: sky, exit: null };
  if (waterLike(bot.blockAt(makeVec(x, y, z), false))) {
    access.in_water = true;
    const roof = shoreHeadroomBlock(bot);
    if (roof) access.bank_ceiling = {x: roof.position.x, y: roof.position.y, z: roof.position.z};
    access.open_water = [1, 2, 3, 4].some(dy => {
      const cell = bot.blockAt(makeVec(x, y + dy, z), false);
      return cell?.name === 'air' && surfaceSkyLight(bot, makeVec(x, y + dy, z)) >= 14;
    });
  }
  if (sky >= 12) {
    if (onConnectedBank(bot)) access.connected_land = true;
    const walls = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .filter(([dx, dz]) => bot.blockAt(makeVec(x + dx, y + 2, z + dz), false)?.boundingBox === 'block');
    if (walls.length < 3) return access;
  }
  const columns = [[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4]];
  // 水底的亮度可能接近地表，额外检查近岸的干燥落脚点。
  if (sky > 0 && Array.from({length: 8}, (_, i) => i + 2).some(dy =>
    ['water', 'bubble_column'].includes(bot.blockAt(makeVec(x, y + dy, z), false)?.name))) {
    columns.push([8, 0], [-8, 0], [0, 8], [0, -8], [5, 5], [-5, 5], [5, -5], [-5, -5]);
    const shallow = shallowSurfaceExit(bot);
    if (shallow) access.shallow_exit_y = shallow.surfaceY;
  }
  for (const [dx, dz] of columns) {
    for (let height = y + 1; height <= y + 24; height++) {
      const feet = bot.blockAt(makeVec(x + dx, height, z + dz), false);
      if (!['air', 'short_grass', 'tall_grass'].includes(feet?.name) || !(surfaceSkyLight(bot, makeVec(x + dx, height, z + dz)) >= 14)) continue;
      const ground = bot.blockAt(makeVec(x + dx, height - 1, z + dz), false);
      const head = bot.blockAt(makeVec(x + dx, height + 1, z + dz), false);
      if (ground?.boundingBox !== 'block' || !['air', 'short_grass', 'tall_grass'].includes(head?.name)) continue;
      if (ground.name.endsWith('_leaves') || ['magma_block', 'cactus', 'campfire', 'soul_campfire', 'powder_snow'].includes(ground.name)) continue;
      access.exit = { x: x + dx, y: height, z: z + dz };
      return access;
    }
  }
  return access;
}

function observePortalBank(bot, makeVec) {
  const p = bot?.entity?.position;
  if (!p || !bot.blockAt || !['the_nether', 'minecraft:the_nether'].includes(bot.game?.dimension)) return null;
  const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
  if (bot.blockAt(makeVec(x, y, z), false)?.name !== 'nether_portal') return null;
  const rock = /^(?:netherrack|blackstone|basalt|smooth_basalt)$/;
  for (const [heading, dx, dz] of [['north', 0, -1], ['south', 0, 1], ['west', -1, 0], ['east', 1, 0]]) {
    if ([1, 2].every(i => rock.test(bot.blockAt(makeVec(x + dx * i, y + i - 1, z + dz * i), false)?.name))) return heading;
  }
  return null;
}

function inspectShelterDetails(bot, remembered, makeVec = (x, y, z) => ({ x, y, z })) {
  if (!remembered?.position || ![3, 4, 5].includes(Number(remembered.size))) {
    return {
      observation: { position: null, size: null, sealed: false, inside: false },
      nearbyBeds: [],
    };
  }
  const { position } = remembered;
  const size = Number(remembered.size);
  const min = -Math.floor(size / 2);
  const max = min + size - 1;
  const dangerous = new Set([
    'cactus', 'lava', 'fire', 'soul_fire', 'magma_block', 'sweet_berry_bush',
    'powder_snow', 'wither_rose', 'campfire', 'soul_campfire', 'cobweb',
  ]);
  const isSafeSolid = (block) => Boolean(block && block.boundingBox === 'block' && !dangerous.has(block.name));
  let sealed = true;
  let determinable = true;
  let missingBlocks = 0;
  let unsafeBlocks = 0;
  const nearbyBeds = new Map();
  const assessStructureBlock = (block) => {
    if (!block) {
      sealed = false;
      determinable = false;
      return;
    }
    if (!isSafeSolid(block)) {
      sealed = false;
      if (block.boundingBox === 'empty') missingBlocks += 1;
      else unsafeBlocks += 1;
    }
  };
  for (let dx = min; dx <= max; dx += 1) {
    for (let dz = min; dz <= max; dz += 1) {
      const floor = bot?.blockAt?.(makeVec(position.x + dx, position.y, position.z + dz));
      assessStructureBlock(floor);
      const edge = dx === min || dx === max || dz === min || dz === max;
      if (edge) {
        for (let dy = 1; dy <= 2; dy += 1) {
          const block = bot?.blockAt?.(makeVec(position.x + dx, position.y + dy, position.z + dz));
          assessStructureBlock(block);
        }
      } else {
        for (let dy = 1; dy <= 2; dy += 1) {
          const x = position.x + dx;
          const y = position.y + dy;
          const z = position.z + dz;
          const block = bot?.blockAt?.(makeVec(x, y, z));
          const isBed = /_bed$/.test(String(block?.name || ''));
          if (!block) determinable = false;
          if (isBed) {
            const bed = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
            nearbyBeds.set(`${bed.x},${bed.y},${bed.z}`, bed);
          }
          if (!block || (block.boundingBox !== 'empty' && !isBed)) sealed = false;
        }
      }
      const roof = bot?.blockAt?.(makeVec(position.x + dx, position.y + 3, position.z + dz));
      assessStructureBlock(roof);
    }
  }
  const botPosition = bot?.entity?.position;
  const relativeX = botPosition ? Math.floor(botPosition.x) - position.x : Number.NaN;
  const relativeY = botPosition ? Math.floor(botPosition.y) - position.y : Number.NaN;
  const relativeZ = botPosition ? Math.floor(botPosition.z) - position.z : Number.NaN;
  const currentCell = botPosition
    ? bot?.blockAt?.(makeVec(Math.floor(botPosition.x), Math.floor(botPosition.y), Math.floor(botPosition.z)))
    : null;
  const clearCurrentCell = Boolean(currentCell && (currentCell.boundingBox === 'empty' || /_bed$/.test(String(currentCell.name || ''))));
  const inside = sealed && clearCurrentCell && relativeX > min && relativeX < max && relativeZ > min && relativeZ < max && relativeY >= 1 && relativeY <= 2;
  const observation = {
    position: { x: position.x, y: position.y, z: position.z },
    size,
    bounds: {
      min: { x: position.x + min, y: position.y, z: position.z + min },
      max: { x: position.x + max, y: position.y + 3, z: position.z + max },
    },
    sealed,
    inside,
  };
  if (determinable) {
    observation.missing_blocks = missingBlocks;
    observation.unsafe_blocks = unsafeBlocks;
  }
  return { observation, nearbyBeds: [...nearbyBeds.values()] };
}

export function inspectShelter(bot, remembered, makeVec = (x, y, z) => ({ x, y, z })) {
  return inspectShelterDetails(bot, remembered, makeVec).observation;
}

export function createObservation(bot, options) {
  const {
    sessionId,
    revision,
    ready,
    executor,
    shelter,
    nearbyOwnedCraftingTable = false,
    nearbyFoodAnimal = false,
    nearbyCraftingTable = false,
    makeVec = (x, y, z) => ({ x, y, z }),
  } = options;
  const health = Number(bot?.health);
  const position = bot?.entity?.position;
  const inventory = {};
  const items = bot?.inventory?.items?.() || [];
  for (const item of items) {
    inventory[item.name] = (inventory[item.name] || 0) + item.count;
  }
  const offHand = bot?.inventory?.slots?.[45];
  // Java 1.21.1 的副手是单独的格子。已装备的盾仍满足持有装备的验收。
  if (offHand?.name === 'shield' && !items.some(item => item === offHand || item.slot === 45)) {
    inventory.shield = (inventory.shield || 0) + offHand.count;
  }
  const players = Object.values(bot?.players || {})
    .filter((player) => position && player.username !== bot?.username && player.entity?.position)
    .map((player) => ({
      name: player.username,
      position: { x: player.entity.position.x, y: player.entity.position.y, z: player.entity.position.z },
      distance: player.entity.position.distanceTo(position),
    }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 8);
  const shelterDetails = inspectShelterDetails(bot, shelter, makeVec);
  return {
    session_id: sessionId,
    revision,
    ready: Boolean(ready),
    executor: { ...executor },
    alive: Number.isFinite(health) ? health > 0 : null,
    position: position ? { x: position.x, y: position.y, z: position.z } : null,
    yaw: bot?.entity?.yaw,
    pitch: bot?.entity?.pitch,
    health: Number.isFinite(health) ? health : null,
    food: Number.isFinite(Number(bot?.food)) ? Number(bot.food) : null,
    dimension: String(bot?.game?.dimension || ''),
    time: Number(bot?.time?.timeOfDay ?? -1),
    day: Number(bot?.time?.day ?? -1),
    is_day: Boolean(bot?.time?.isDay),
    weather: bot?.thunderState > 0 ? 'thunder' : bot?.rainState > 0 ? 'rain' : 'clear',
    players,
    inventory,
    off_hand: offHand?.name || '',
    nearby_owned_crafting_table: Boolean(nearbyOwnedCraftingTable),
    nearby_food_animal: Boolean(nearbyFoodAnimal),
    nearby_crafting_table: Boolean(nearbyCraftingTable || nearbyOwnedCraftingTable),
    surface_access: observeSurfaceAccess(bot, makeVec),
    nether_portal_bank: observePortalBank(bot, makeVec),
    ...(Array.isArray(options.netherMiningHostiles) ? {nether_mining_hostiles: options.netherMiningHostiles} : {}),
    end_portal_room: observePortalRoom(bot),
    end_dragon: observeDragon(bot),
    inventory_free_slots: typeof bot?.inventory?.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : null,
    resource_sites: inspectResourceSites(bot, shelter, sessionId),
    collection_within_reach: true,
    held: bot?.heldItem ? bot.heldItem.name : '',
    shelter: shelterDetails.observation,
    nearby_beds: shelterDetails.nearbyBeds,
  };
}
