import { waterLike } from './water_escape.js';

export function placementOffsets(radius = 4) {
  const limit = Math.max(1, Math.floor(Number(radius) || 1));
  const offsets = [];
  for (let x = -limit; x <= limit; x += 1) {
    for (let z = -limit; z <= limit; z += 1) {
      if (x === 0 && z === 0) continue;
      offsets.push({ x, z, distance: x * x + z * z });
    }
  }
  return offsets
    .sort((left, right) => left.distance - right.distance || left.x - right.x || left.z - right.z)
    .map(({ x, z }) => [x, z]);
}

export function placementHeightOffsets(minimum = -16, maximum = 8) {
  const low = Math.floor(Number(minimum) || 0);
  const high = Math.floor(Number(maximum) || 0);
  const offsets = [];
  for (let offset = low; offset <= high; offset += 1) offsets.push(offset);
  return offsets.sort((left, right) => Math.abs(left + 1) - Math.abs(right + 1) || right - left);
}

export function inspectSupportedPlacementTargets({
  base,
  searchRadius = 1,
  getBlock,
  offsets = placementOffsets(searchRadius),
  heights = placementHeightOffsets(),
} = {}) {
  if (!base || typeof getBlock !== 'function') {
    return { targets: [], diagnostics: { query_count: 0, unknown_count: 0, unknown_samples: [], columns: [] } };
  }
  const originX = Math.floor(Number(base.x));
  const originY = Math.floor(Number(base.y));
  const originZ = Math.floor(Number(base.z));
  if (![originX, originY, originZ].every(Number.isFinite)) {
    return { targets: [], diagnostics: { query_count: 0, unknown_count: 0, unknown_samples: [], columns: [] } };
  }

  const diagnostics = {
    bot_floor: { x: originX, y: originY, z: originZ },
    search_radius: Math.max(1, Math.floor(Number(searchRadius) || 1)),
    query_count: 0,
    unknown_count: 0,
    unknown_samples: [],
    columns: [],
  };
  const read = (position, role) => {
    let block = null;
    let errorMessage = '';
    try {
      block = getBlock(position) || null;
    } catch (error) {
      errorMessage = String(error?.message || error);
    }
    diagnostics.query_count += 1;
    if (!block) {
      diagnostics.unknown_count += 1;
      if (diagnostics.unknown_samples.length < 12) {
        diagnostics.unknown_samples.push({
          role,
          query: position,
          name: null,
          bounding_box: null,
          ...(errorMessage ? { error: errorMessage } : {}),
        });
      }
    }
    return block;
  };
  const describe = (position, role) => {
    const block = read(position, role);
    return {
      query: position,
      name: block?.name || null,
      bounding_box: block?.boundingBox || null,
    };
  };

  const sampleOffsets = [[0, 0], ...offsets.slice(0, 8)];
  const seenOffsets = new Set();
  for (const [dx, dz] of sampleOffsets) {
    const key = `${dx},${dz}`;
    if (seenOffsets.has(key)) continue;
    seenOffsets.add(key);
    const x = originX + dx;
    const z = originZ + dz;
    diagnostics.columns.push({
      offset: [dx, dz],
      ground: describe({ x, y: originY - 1, z }, 'sample_ground'),
      above: describe({ x, y: originY, z }, 'sample_above'),
      body: describe({ x, y: originY + 1, z }, 'sample_body'),
    });
  }

  const targets = [];
  for (const [dx, dz] of offsets) {
    const x = originX + dx;
    const z = originZ + dz;
    for (const dy of heights) {
      const y = originY + dy;
      const ground = read({ x, y, z }, 'candidate_ground');
      if (!ground || ground.boundingBox !== 'block' || waterLike(ground) || ['magma_block', 'campfire', 'soul_campfire', 'cactus'].includes(ground.name)) continue;
      const target = { x, y: y + 1, z };
      const above = read(target, 'candidate_above');
      const above2 = read({ ...target, y: target.y + 1 }, 'candidate_body');
      if ([above, above2].every(cell => cell?.boundingBox === 'empty' && !waterLike(cell) && !['lava', 'fire', 'soul_fire', 'powder_snow'].includes(cell.name))) {
        targets.push({ target, ground });
      }
    }
  }
  const distance = ({target}) => Math.hypot(target.x + 0.5 - base.x, target.y - base.y, target.z + 0.5 - base.z);
  targets.sort((a, b) => distance(a) - distance(b));
  return { targets, diagnostics };
}

export function findSupportedPlacementTargets(options = {}) {
  return inspectSupportedPlacementTargets(options).targets;
}

export function dryStationAlcove(bot) {
  const origin = bot.entity.position.floored();
  const ordinary = new Set(['stone', 'andesite', 'diorite', 'granite', 'cobblestone', 'tuff', 'deepslate', 'dirt', 'grass_block']);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const target = origin.offset(dx, 0, dz), floor = bot.blockAt(target.offset(0, -1, 0));
    if (floor?.boundingBox !== 'block' || !ordinary.has(floor.name)) continue;
    const cells = [target.offset(0, 1, 0), target];
    if (!cells.every(p => {
      const block = bot.blockAt(p);
      if (!block || !(ordinary.has(block.name) || block.name === 'air' || block.name === 'cave_air')) return false;
      return [[0,1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]].every(([x, y, z]) => {
        const neighbor = bot.blockAt(p.offset(x, y, z));
        return neighbor && !waterLike(neighbor) && neighbor.name !== 'lava'
          && !(y && /(?:sand|gravel|anvil|concrete_powder)$/.test(neighbor.name));
      });
    })) continue;
    return {target, cells};
  }
  return null;
}
