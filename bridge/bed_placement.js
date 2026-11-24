const DIRECTIONS = [
  { x: 0, z: -1 },
  { x: 1, z: 0 },
  { x: 0, z: 1 },
  { x: -1, z: 0 },
];

export async function placeBedAt(bot, target, name, {
  createVector = (x, y, z) => ({ x, y, z }),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  moveTo = null,
  token = null,
  verifyAttempts = 10,
  verifyIntervalMs = 100,
} = {}) {
  if (!bot?.entity || typeof bot.blockAt !== 'function') throw new Error('没有可用的 Minecraft bot');
  const foot = { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z) };
  const footBlock = bot.blockAt(createVector(foot.x, foot.y, foot.z));
  if (!isOpen(footBlock)) throw new Error('目标床脚位置不是空位');
  const item = bot.inventory?.items?.().find((entry) => entry.name === name);
  if (!item) throw new Error(`背包里没有 ${name}`);

  const spots = DIRECTIONS.map((dir) => ({
    dir,
    head: { x: foot.x + dir.x, y: foot.y, z: foot.z + dir.z },
  })).filter(({ head }) => {
    const headBlock = bot.blockAt(createVector(head.x, head.y, head.z));
    const headSupport = bot.blockAt(createVector(head.x, head.y - 1, head.z));
    return isOpen(headBlock) && isSolid(headSupport);
  });
  const footSupport = bot.blockAt(createVector(foot.x, foot.y - 1, foot.z));
  const spot = isSolid(footSupport) ? spots[0] : null;
  if (!spot) throw new Error('床脚与床头需要相邻的两个空位，且两格下方都要有支撑方块');
  const head = spot.head;
  await moveClearOfBedCells(bot, foot, head, createVector, moveTo, token);
  assertBedCellsReady(bot, foot, head, createVector);
  const { dir } = spot;
  const yaw = Math.atan2(-dir.x, -dir.z);

  assertActive(token);
  await bot.equip(item, 'hand');
  assertActive(token);
  if (typeof bot.look === 'function') await bot.look(yaw, 0, true);
  else {
    bot.entity.yaw = yaw;
    bot.entity.pitch = 0;
  }
  assertActive(token);
  await wait(120);
  assertActive(token);
  const support = bot.blockAt(createVector(foot.x, foot.y - 1, foot.z));
  if (typeof bot._placeBlockWithOptions === 'function') {
    await bot._placeBlockWithOptions(support, createVector(0, 1, 0), { swingArm: 'right', forceLook: 'ignore' });
  } else if (typeof bot.placeBlock === 'function') {
    await bot.placeBlock(support, createVector(0, 1, 0));
  } else {
    throw new Error('bot 没有放置方块的接口');
  }

  let placedFoot = null;
  let placedHead = null;
  for (let attempt = 0; attempt < verifyAttempts; attempt += 1) {
    assertActive(token);
    placedFoot = bot.blockAt(createVector(foot.x, foot.y, foot.z));
    const found = spots
      .map((candidate) => ({ position: candidate.head, block: bot.blockAt(createVector(candidate.head.x, candidate.head.y, candidate.head.z)) }))
      .find((candidate) => isBed(candidate.block));
    placedHead = found?.block || null;
    if (isBed(placedFoot) && found) return { foot, head: found.position, item: name };
    await wait(verifyIntervalMs);
  }
  throw new Error(`床未完整放置：床脚是 ${placedFoot?.name || '空气'}，床头是 ${placedHead?.name || '空气'}`);
}

async function moveClearOfBedCells(bot, foot, head, createVector, moveTo, token) {
  if (!playerOverlapsBlock(bot.entity, foot) && !playerOverlapsBlock(bot.entity, head)) return;
  if (typeof moveTo !== 'function') throw new Error('放床前玩家站在床位上，当前没有可用的移动接口');

  const candidate = findSafeStandingSpot(bot, foot, head, createVector);
  if (!candidate) throw new Error('放床前找不到有支撑且不会挡住床位的站位');
  assertActive(token);
  await moveTo({ x: candidate.x, y: candidate.y, z: candidate.z });
  assertActive(token);

  const position = bot.entity.position;
  const horizontalDistance = Math.hypot(position.x - (candidate.x + 0.5), position.z - (candidate.z + 0.5));
  if (horizontalDistance > 0.75 || Math.abs(position.y - candidate.y) > 0.25) {
    throw new Error('放床前没有到达清空床位的站位');
  }
  const standing = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
  const support = bot.blockAt(createVector(standing.x, standing.y - 1, standing.z));
  const feet = bot.blockAt(createVector(standing.x, standing.y, standing.z));
  const above = bot.blockAt(createVector(standing.x, standing.y + 1, standing.z));
  if (!isSafeStandingCell(support, feet, above)
    || playerOverlapsBlock(bot.entity, foot)
    || playerOverlapsBlock(bot.entity, head)) {
    throw new Error('放床前移动后的站位仍不安全，或仍挡住床位');
  }
}

function findSafeStandingSpot(bot, foot, head, createVector, radius = 4) {
  const current = bot.entity.position;
  const candidates = [];
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      const x = foot.x + dx;
      const z = foot.z + dz;
      const position = { x: x + 0.5, y: foot.y, z: z + 0.5 };
      const support = bot.blockAt(createVector(x, foot.y - 1, z));
      const feet = bot.blockAt(createVector(x, foot.y, z));
      const above = bot.blockAt(createVector(x, foot.y + 1, z));
      const entity = { ...bot.entity, position };
      if (!isSafeStandingCell(support, feet, above)
        || playerOverlapsBlock(entity, foot)
        || playerOverlapsBlock(entity, head)) continue;
      candidates.push({
        x,
        y: foot.y,
        z,
        distance: (position.x - current.x) ** 2 + (position.z - current.z) ** 2,
      });
    }
  }
  candidates.sort((left, right) => left.distance - right.distance || left.x - right.x || left.z - right.z);
  return candidates[0] || null;
}

function assertBedCellsReady(bot, foot, head, createVector) {
  const footBlock = bot.blockAt(createVector(foot.x, foot.y, foot.z));
  const headBlock = bot.blockAt(createVector(head.x, head.y, head.z));
  const footSupport = bot.blockAt(createVector(foot.x, foot.y - 1, foot.z));
  const headSupport = bot.blockAt(createVector(head.x, head.y - 1, head.z));
  if (!isOpen(footBlock) || !isOpen(headBlock) || !isSolid(footSupport) || !isSolid(headSupport)) {
    throw new Error('移动后床脚与床头不再是有支撑的空位');
  }
}

function isSafeStandingCell(support, feet, above) {
  return isSolid(support)
    && !isHazard(support)
    && isOpen(feet)
    && !isHazard(feet)
    && isOpen(above)
    && !isHazard(above);
}

function playerOverlapsBlock(entity, block) {
  const position = entity?.position;
  if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return false;
  const width = Number.isFinite(entity.width) && entity.width > 0 ? entity.width : 0.6;
  const height = Number.isFinite(entity.height) && entity.height > 0 ? entity.height : 1.8;
  return position.x + width / 2 > block.x
    && position.x - width / 2 < block.x + 1
    && position.y + height > block.y
    && position.y < block.y + 1
    && position.z + width / 2 > block.z
    && position.z - width / 2 < block.z + 1;
}

function assertActive(token) {
  if (token?.cancelled) throw new Error(token.cancelReason || '放床动作被取消');
}

function isOpen(block) {
  return Boolean(block && (block.name === 'air' || block.boundingBox === 'empty'));
}

function isSolid(block) {
  return Boolean(block && block.boundingBox === 'block');
}

function isBed(block) {
  return Boolean(block && (block.name === 'bed' || /_bed$/.test(String(block.name))));
}

function isHazard(block) {
  return Boolean(block && /lava|water|cactus|fire|magma|campfire|powder_snow|sweet_berry_bush|wither_rose/.test(String(block.name)));
}
