import { waterLike } from './water_escape.js';
import { magmaCubeBehindCover } from './combat_encounter.js';

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
  // 斜向下坡时 pathfinder 检查的是落脚点上一格，水面上的空气也要排除。
  for (const dy of [-1, 0, 1]) {
    const cell = bot.blockAt(block.position.offset(0, dy, 0));
    if (!cell || waterLike(cell) || HAZARDS.has(cell.name)) return 100;
  }
  return 0;
}

export async function withDryGroundMovement(bot, action, walkOnly = false) {
  const movements = bot.pathfinder.movements;
  const original = {allowSprinting: movements.allowSprinting, allowParkour: movements.allowParkour, canDig: movements.canDig,
    maxDropDown: movements.maxDropDown, infiniteLiquidDropdownDistance: movements.infiniteLiquidDropdownDistance,
    exclusionAreasStep: movements.exclusionAreasStep};
  Object.assign(movements, {allowParkour: false, canDig: false, maxDropDown: 1, infiniteLiquidDropdownDistance: false,
    exclusionAreasStep: [...(movements.exclusionAreasStep || []), block => miningRouteExclusion(bot, block)]});
  if (walkOnly) movements.allowSprinting = false;
  try { return await action(); }
  finally { Object.assign(movements, original); }
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

export function exposedMagmaCube(bot, p, cubes) {
  const feet = p.offset(0.5, 0, 0.5);
  return cubes.some(e => e?.name === 'magma_cube' && e.isValid !== false && e.position
    && feet.distanceTo(e.position) < 9.5 && !magmaCubeBehindCover(bot, e, feet));
}

export async function walkNetherCell(ctx, p) {
  const bot = ctx.bot, start = bot.entity.position.floored();
  if (Math.abs(start.x - p.x) + Math.abs(start.z - p.z) > 1 || Math.abs(p.y - start.y) > 1) return 'unreachable';
  if (bot.pathfinder?.goal) bot.pathfinder.setGoal(null);
  try {
    for (let tick = 0; tick < 22; tick++) {
      if (ctx.interrupted) return 'cancelled';
      const pos = bot.entity.position;
      if (!['the_nether', 'minecraft:the_nether'].includes(bot.game?.dimension)) return 'unreachable';
      const safe = dryMiningFooting(bot, p), hazard = netherRouteExclusion(bot, {position: p});
      const cliff = besideDrop(bot, p), cube = exposedMagmaCube(bot, p, Object.values(bot.entities || {}));
      if (!safe || hazard || cliff || cube) {
        ctx.log?.('下界停步', {target: p, footing: safe, hazard, cliff, magma_cube: cube});
        return 'unreachable';
      }
      const dx = p.x + 0.5 - pos.x, dz = p.z + 0.5 - pos.z, distance = Math.hypot(dx, dz);
      if (distance <= 0.28 && Math.abs(pos.y - p.y) <= 0.25 && bot.entity.onGround) return 'reached';
      if (distance > 2.4) return 'unreachable';
      await bot.look(Math.atan2(-dx, -dz), 0, true);
      if (ctx.interrupted) return 'cancelled';
      bot.setControlState('jump', p.y > pos.y + 0.25 && bot.entity.onGround);
      bot.setControlState('forward', distance > 0.18);
      await ctx.sleep(50);
    }
    ctx.log?.('下界一步未到位', {target: p, actual: bot.entity.position, on_ground: bot.entity.onGround});
    return 'unreachable';
  } finally {
    bot.setControlState('forward', false);
    bot.setControlState('jump', false);
  }
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

export async function reachableDryGround(ctx, limit, radius, nether = false) {
  const bot = ctx.bot, here = bot.entity.position.floored();
  const cubes = Object.values(bot.entities || {}).filter(e => e?.name === 'magma_cube');
  const queue = [here], seen = new Set([here.toString()]);
  const parents = new Map();
  for (let i = 0; i < queue.length && i < limit; i++) {
    if (i % 24 === 0) {
      if (ctx.interrupted) throw new Error('干地步行搜索被打断');
      await new Promise(resolve => setImmediate(resolve));
    }
    const from = queue[i];
    for (const [dx, dz] of [[1,0], [0,1], [-1,0], [0,-1]]) {
      for (const dy of [0, 1, -1]) {
        const p = from.offset(dx, dy, dz);
        if (Math.abs(p.x - here.x) + Math.abs(p.z - here.z) > radius) continue;
        const key = p.toString();
        if (seen.has(key)) continue;
        if (dy !== 0) {
          const head = bot.blockAt((dy > 0 ? from : p).offset(0, 2, 0), false);
          if (!head || head.boundingBox !== 'empty') continue;
        }
        seen.add(key);
        if (!dryMiningFooting(bot, p) || (nether && (netherRouteExclusion(bot, {position: p})
            || besideDrop(bot, p) || exposedMagmaCube(bot, p, cubes)))) continue;
        queue.push(p);
        parents.set(key, from);
        break;
      }
    }
  }
  return {here, points: queue.slice(1), parents};
}

export function reachableNetherGround(ctx, limit = 320, radius = 24) {
  return reachableDryGround(ctx, limit, radius, true);
}

export async function followDryGround(ctx, parents, target, check) {
  const path = [];
  let start = target;
  while (parents.has(start.toString())) {
    path.push(start);
    start = parents.get(start.toString());
  }
  if (!ctx.bot.entity.position.floored().equals(start)) return 'unreachable';
  path.reverse();
  for (let i = 0; i < path.length; i++) {
    if (i % 3 !== 2 && i !== path.length - 1) continue;
    check();
    const p = path[i];
    if (!dryMiningFooting(ctx.bot, p)) return 'unreachable';
    const outcome = await ctx.walkOnce(p.x, p.y, p.z, 0, 5000);
    if (outcome !== 'reached') return outcome;
  }
  return 'reached';
}

export async function followNetherPath(ctx, parents, target) {
  const bot = ctx.bot, path = [];
  for (let p = target; parents.has(p.toString()); p = parents.get(p.toString())) path.push(p);
  const start = bot.entity.position.floored();
  if (!path.length) return start.equals(target) ? 'reached' : 'unreachable';
  if (!parents.get(path.at(-1).toString()).equals(start)) return 'unreachable';
  for (const p of path.reverse()) {
    const outcome = await walkNetherCell(ctx, p);
    if (outcome !== 'reached') return outcome;
  }
  return bot.entity.position.floored().equals(target) ? 'reached' : 'unreachable';
}

export async function returnToNetherWaypoint(ctx, target) {
  if (!['the_nether', 'minecraft:the_nether'].includes(ctx.bot.game?.dimension)) throw new Error('下界回撤需要在下界执行');
  const {here, points, parents} = await reachableNetherGround(ctx, 600, 28);
  const destination = points.filter(p => p.distanceTo(target) <= 1.5 && here.distanceTo(p) >= 6)
    .sort((a, b) => a.distanceTo(target) - b.distanceTo(target))[0];
  if (!destination || await followNetherPath(ctx, parents, destination) !== 'reached') {
    throw new Error('当前地形未确认到原路标的安全步行路径');
  }
  return `已沿干地回撤到 (${destination.x}, ${destination.y}, ${destination.z})`;
}
