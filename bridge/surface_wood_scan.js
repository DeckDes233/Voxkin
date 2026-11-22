import { setImmediate as yieldToGame } from 'node:timers/promises';

// 只查看客户端已加载的区块。用 section 调色板跳过无原木的空间，定期归还事件循环。
export async function scanSurfaceLogs(bot, entries, radius, count, startY, accept, check) {
  const origin = bot.entity.position.floored();
  const states = new Set();
  for (const block of entries) {
    for (let id = block.minStateId; id <= block.maxStateId; id++) states.add(id);
  }
  const radiusSq = radius * radius;
  const minY = Math.max(origin.y - radius, Math.ceil(startY - 16));
  const maxY = Math.min(origin.y + radius, Math.ceil(startY + 32));
  let nextYield = performance.now() + 6;
  const nearest = [];
  const keepNearest = () => {
    nearest.sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin));
    if (nearest.length > count) nearest.length = count;
  };
  for (let cx = (origin.x - radius) >> 4; cx <= (origin.x + radius) >> 4; cx++) {
    for (let cz = (origin.z - radius) >> 4; cz <= (origin.z + radius) >> 4; cz++) {
      const column = bot.world.getColumn(cx, cz);
      if (!column) continue;
      for (let sy = minY >> 4; sy <= maxY >> 4; sy++) {
        const section = column.sections[sy - (column.minY >> 4)];
        if (!section || (section.palette && !section.palette.some(id => states.has(id)))) continue;
        for (let y = Math.max(minY, sy * 16); y <= Math.min(maxY, sy * 16 + 15); y++) {
          if (performance.now() >= nextYield) {
            await yieldToGame();
            check();
            nextYield = performance.now() + 6;
          }
          for (let z = 0; z < 16; z++) {
            for (let x = 0; x < 16; x++) {
              if (!states.has(section.get({ x, y: y & 15, z }))) continue;
              const dx = cx * 16 + x - origin.x, dz = cz * 16 + z - origin.z, dy = y - origin.y;
              if (dx * dx + dy * dy + dz * dz > radiusSq) continue;
              const pos = origin.offset(dx, dy, dz);
              if (accept(pos)) nearest.push(pos);
            }
          }
          if (nearest.length >= count * 2) keepNearest();
        }
      }
    }
  }
  keepNearest();
  return nearest;
}
