import { waterLike } from './water_escape.js';

const HAZARDS = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire', 'cactus', 'sweet_berry_bush', 'powder_snow', 'wither_rose']);

export function netherRouteExclusion(bot, block) {
  if (!['the_nether', 'minecraft:the_nether'].includes(bot.game?.dimension)) return 0;
  if (!block?.position) return 1000;
  for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (const dy of [-1, 0]) {
      const cell = bot.blockAt(block.position.offset(dx, dy, dz), false);
      if (!cell || HAZARDS.has(cell.name)) return 1000;
    }
  }
  return 0;
}

export function miningRouteExclusion(bot, block) {
  if (!block?.position) return 100;
  // 液体代价只是偏好；换区路线必须直接排除水、含水方块和未知空间。
  for (const dy of [0, 1]) {
    const cell = bot.blockAt(block.position.offset(0, dy, 0));
    if (!cell || waterLike(cell) || HAZARDS.has(cell.name)) return 100;
  }
  return 0;
}

// 侦察时要给横移和被击退留出一步余地。相邻列下方三格都没有支撑就是悬崖边沿。
export function besideDrop(bot, position) {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let supported = false;
    for (let dy = 0; dy >= -3; dy--) {
      const cell = bot.blockAt(position.offset(dx, dy, dz), false);
      if (cell?.boundingBox === 'block') { supported = true; break; }
    }
    if (!supported) return true;
  }
  return false;
}

export function dryMiningFooting(bot, position) {
  const feet = position.floored();
  const ground = bot.blockAt(feet.offset(0, -1, 0));
  if (!ground || ground.boundingBox !== 'block' || waterLike(ground) || HAZARDS.has(ground.name)) return false;
  for (const dy of [0, 1]) {
    const block = bot.blockAt(feet.offset(0, dy, 0));
    if (!block || block.boundingBox !== 'empty' || waterLike(block) || HAZARDS.has(block.name)) return false;
  }
  return true;
}

export async function leaveMagmaBlock(bot, token, sleep) {
  const origin = bot.entity.position.floored();
  if (bot.blockAt(origin.offset(0, -1, 0))?.name !== 'magma_block') return false;
  bot.setControlState('sneak', true);
  try {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const dy of [0, 1, -1]) {
        if (token.cancelled) return false;
        const p = origin.offset(dx, dy, dz);
        if (!dryMiningFooting(bot, p)) continue;
        await bot.lookAt(p.offset(0.5, 1.5, 0.5), true);
        bot.setControlState('jump', dy > 0);
        bot.setControlState('forward', true);
        for (let tick = 0; tick < 24 && !token.cancelled; tick++) {
          await sleep(50);
          if (bot.entity.onGround && dryMiningFooting(bot, bot.entity.position)) return true;
        }
        bot.setControlState('forward', false);
        bot.setControlState('jump', false);
      }
    }
    return false;
  } finally {
    for (const control of ['forward', 'jump', 'sneak']) bot.setControlState(control, false);
  }
}
