// 按状态 ID 查已加载区块。长距离动作在让步点处理消息，短距离同步观察复用同一套几何与调色板筛选。
export function* scanLoadedBlockStates(bot, entries, radius, count, minY, maxY, accept) {
  if (count <= 0) return [];
  const origin = bot.entity.position.floored();
  const states = new Set();
  for (const block of entries) {
    for (let id = block.minStateId; id <= block.maxStateId; id++) states.add(id);
  }
  const radiusSq = radius * radius;
  minY = Math.max(origin.y - radius, Math.ceil(minY));
  maxY = Math.min(origin.y + radius, Math.floor(maxY));
  let nextYield = performance.now() + 6;
  const nearest = [];
  let cutoffSq = radiusSq;
  const keepNearest = () => {
    nearest.sort((a, b) => a.distanceSquared(origin) - b.distanceSquared(origin) || a.x - b.x || a.y - b.y || a.z - b.z);
    if (nearest.length > count) nearest.length = count;
    if (nearest.length === count) cutoffSq = nearest[count - 1].distanceSquared(origin);
  };
  // 按区块包围盒到角色的最短距离扫描。已有足够近的候选后，远区块无需解码。
  const columns = [];
  for (let cx = (origin.x - radius) >> 4; cx <= (origin.x + radius) >> 4; cx++) {
    for (let cz = (origin.z - radius) >> 4; cz <= (origin.z + radius) >> 4; cz++) {
      const dx = Math.max(cx * 16 - origin.x, origin.x - (cx * 16 + 15), 0);
      const dz = Math.max(cz * 16 - origin.z, origin.z - (cz * 16 + 15), 0);
      const minSq = dx * dx + dz * dz;
      if (minSq <= radiusSq) columns.push({cx, cz, minSq});
    }
  }
  columns.sort((a, b) => a.minSq - b.minSq);
  for (const [index, {cx, cz, minSq}] of columns.entries()) {
    if (minSq > cutoffSq) break;
    // 空区块与无匹配调色板会直接跳过，不会经过方块循环内的让步点。
    if (index > 0 && (index % 16 === 0 || performance.now() >= nextYield)) {
      yield;
      nextYield = performance.now() + 6;
    }
    const column = bot.world.getColumn(cx, cz);
    if (!column) continue;
    let added = false;
    for (let sy = minY >> 4; sy <= maxY >> 4; sy++) {
      const section = column.sections[sy - (column.minY >> 4)];
      if (!section || (section.palette && !section.palette.some(id => states.has(id)))) continue;
      for (let y = Math.max(minY, sy * 16); y <= Math.min(maxY, sy * 16 + 15); y++) {
        const dy = y - origin.y;
        if (minSq + dy * dy > cutoffSq) continue;
        for (let z = 0; z < 16; z++) {
          if (performance.now() >= nextYield) {
            yield;
            nextYield = performance.now() + 6;
          }
          const dz = cz * 16 + z - origin.z;
          const remainingSq = cutoffSq - dy * dy - dz * dz;
          if (remainingSq < 0) continue;
          const span = Math.floor(Math.sqrt(remainingSq));
          const center = origin.x - cx * 16;
          for (let x = Math.max(0, center - span); x <= Math.min(15, center + span); x++) {
            if (!states.has(section.get({ x, y: y & 15, z }))) continue;
            const pos = origin.offset(x - center, dy, dz);
            if (!accept || accept(pos)) {
              nearest.push(pos);
              added = true;
            }
          }
        }
        if (nearest.length >= count * 2) {
          keepNearest();
          added = false;
        }
      }
    }
    if (added && nearest.length >= count) keepNearest();
  }
  keepNearest();
  return nearest;
}

export function findObservedBlocks(bot, entries, radius, count) {
  if (!entries.length) return [];
  if (!bot.world?.getColumn || entries.some(b => !Number.isInteger(b.minStateId) || !Number.isInteger(b.maxStateId))) {
    const ids = entries.map(b => b.id);
    return bot.findBlocks({matching: ids.length === 1 ? ids[0] : ids, maxDistance: radius, count});
  }
  const search = scanLoadedBlockStates(bot, entries, radius, count, -Infinity, Infinity);
  let result;
  do {
    result = search.next();
  } while (!result.done);
  return result.value;
}
