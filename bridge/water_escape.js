// 水中呼吸避险只使用已加载区块和有界局部路线。
export function waterLike(block) {
  if (!block) return false;
  return /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/.test(block.name)
    || block.getProperties?.()?.waterlogged === true;
}
export function breathable(block) {
  return !!block && /^(air|cave_air|void_air|bubble_column)$/.test(block.name);
}
export function avoidWaterScaffolding(bot, block) {
  if (!block?.position || waterLike(block)) return 1000;
  const below = bot.blockAt(block.position.offset(0, -1, 0));
  return !below || waterLike(below) ? 1000 : 0;
}
function passable(block) {
  return !!block && block.boundingBox === 'empty' && (waterLike(block) || breathable(block));
}
function route(bot, pos, radius, excluded) {
  const bx = Math.floor(pos.x), by = Math.floor(pos.y), bz = Math.floor(pos.z);
  const queue = [{ x: bx, z: bz, path: [] }], seen = new Set([`${bx},${bz}`]);
  for (let i = 0; i < queue.length; i++) {
    const cell = queue[i];
    if (cell.path.length && !excluded.has(`${cell.x},${cell.z}`)) {
      const above = bot.blockAt(pos.offset(cell.x-bx, 2, cell.z-bz));
      const higher = bot.blockAt(pos.offset(cell.x-bx, 3, cell.z-bz));
      if (passable(above) && breathable(higher) && higher.name !== 'bubble_column') return cell.path;
    }
    for (const [dx,dz] of [[0,-1],[1,0],[0,1],[-1,0]]) {
      const x=cell.x+dx, z=cell.z+dz, key=`${x},${z}`;
      if (seen.has(key) || excluded.has(key) || Math.abs(x-bx)+Math.abs(z-bz)>radius) continue;
      seen.add(key);
      const offsetX=x-bx, offsetZ=z-bz;
      if (!passable(bot.blockAt(pos.offset(offsetX,0,offsetZ))) || !passable(bot.blockAt(pos.offset(offsetX,1,offsetZ)))) continue;
      queue.push({ x,z,path:[...cell.path,{x:x+0.5,y:pos.y,z:z+0.5,key}] });
    }
  }
  return null;
}
const MOVEMENT = ['jump','forward','back','left','right','sprint','sneak'];
function release(bot) { for (const key of MOVEMENT) bot.setControlState(key, false); }
export async function escapeWater(bot, { token = null, timeoutMs = 25000, radius = 12, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const deadline = now() + timeoutMs, searchRadius = Math.max(1, Math.min(8, Math.floor(radius)));
  let last = null, still = 0, path = null;
  const excluded = new Set();
  release(bot);
  try {
    if (!bot.entity || Number(bot.health ?? 20) <= 0) throw new Error('角色已死亡或离开世界');
    last = bot.entity.position.clone();
    while (now() < deadline) {
      if (token?.cancelled) throw new Error(token.cancelReason || '水中自救已取消');
      if (!bot.entity || Number(bot.health ?? 20) <= 0) throw new Error('角色已死亡或离开世界');
      const pos = bot.entity.position;
      const eye = bot.blockAt(pos.offset(0, bot.entity.eyeHeight ?? 1.62, 0));
      if (breathable(eye) && eye.name !== 'bubble_column' && Number.isFinite(bot.oxygenLevel) && bot.oxygenLevel >= 19) return true;
      const moved = Math.hypot(pos.x-last.x, pos.y-last.y, pos.z-last.z);
      still = moved < 0.12 ? still+1 : 0;
      last = pos.clone();
      if (path?.length && Math.hypot(pos.x-path[0].x,pos.z-path[0].z) < 0.12) path.shift();
      if (path?.length && still >= 3) { excluded.add(path[0].key); path = null; still = 0; }
      const above = bot.blockAt(pos.offset(0,2,0));
      if ((!path || !path.length) && (!passable(above) || still >= 3)) {
        path = route(bot,pos,searchRadius,excluded); still = 0;
      }
      bot.setControlState('jump', true);
      bot.setControlState('forward', false);
      if (path?.length) {
        const target = path[0];
        await bot.lookAt(pos.offset(target.x-pos.x,0,target.z-pos.z), true);
        if (token?.cancelled) throw new Error(token.cancelReason || '水中自救已取消');
        bot.setControlState('forward', true);
      }
      await sleep(400);
    }
    return false;
  } finally { release(bot); }
}

function dryStandingSpot(bot, x, y, z, origin) {
  const at = (dy) => bot.blockAt(origin.offset(x - origin.x, y + dy - origin.y, z - origin.z));
  const ground = at(-1), feet = at(0), head = at(1);
  return Boolean(ground && ground.boundingBox === 'block' && !waterLike(ground)
    && !/leaves|lava|fire|cactus|magma|campfire|powder_snow|sweet_berry_bush/.test(ground.name)
    && feet && feet.boundingBox === 'empty' && !waterLike(feet)
    && head && head.boundingBox === 'empty' && !waterLike(head));
}

function shoreRoute(bot, pos, radius, excluded) {
  const sx = Math.floor(pos.x), sz = Math.floor(pos.z), y = Math.floor(pos.y);
  const queue = [{ x: sx, z: sz, path: [] }];
  const seen = new Set([`${sx},${sz}`]);
  for (let i = 0; i < queue.length; i += 1) {
    const cell = queue[i];
    for (const dy of [0, 1, -1, 2, -2]) {
      const landY = y + dy, key = `${cell.x},${landY},${cell.z}`;
      if (!excluded.has(key) && dryStandingSpot(bot, cell.x, landY, cell.z, pos)) {
        return { path: cell.path, target: { x: cell.x + 0.5, y: landY, z: cell.z + 0.5, key } };
      }
    }
    for (const [dx, dz] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const x = cell.x + dx, z = cell.z + dz, key = `${x},${z}`;
      if (seen.has(key) || Math.hypot(x - sx, z - sz) > radius) continue;
      seen.add(key);
      const offset = pos.offset(x - sx, 0, z - sz);
      const feet = bot.blockAt(offset), head = bot.blockAt(offset.offset(0, 1, 0));
      const raisedKey = `${x},${y + 1},${z}`;
      if (!excluded.has(raisedKey) && dryStandingSpot(bot, x, y + 1, z, pos)) {
        return { path: cell.path, target: { x: x + 0.5, y: y + 1, z: z + 0.5, key: raisedKey } };
      }
      const leafPassable = block => /_leaves$/.test(String(block?.name || ''))
        && Number.isFinite(bot.oxygenLevel) && bot.oxygenLevel >= 15
        && typeof bot.canDigBlock === 'function' && bot.canDigBlock(block);
      if ((!passable(feet) && !leafPassable(feet)) || (!passable(head) && !leafPassable(head))) continue;
      queue.push({ x, z, path: [...cell.path, { x: x + 0.5, y: pos.y, z: z + 0.5, key }] });
    }
  }
  return null;
}

async function clearBlockingLeaves(bot, block, token) {
  if (!block || !/_leaves$/.test(String(block.name)) || typeof bot.dig !== 'function'
      || typeof bot.canDigBlock !== 'function' || !bot.canDigBlock(block)
      || !Number.isFinite(bot.oxygenLevel) || bot.oxygenLevel < 15) return false;
  release(bot);
  let timer;
  try {
    await Promise.race([
      bot.dig(block),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('清理树叶超时')), 2500); }),
    ]);
    if (token?.cancelled) throw new Error(token.cancelReason || '靠岸已取消');
    return true;
  } catch (error) {
    bot.stopDigging?.();
    if (token?.cancelled) throw error;
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function reachShore(bot, { token = null, timeoutMs = 25000, radius = 12,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  const searchRadius = Math.max(1, Math.min(12, Math.floor(radius)));
  const excluded = new Set();
  let target = null, path = [], previous = null, still = 0;
  release(bot);
  try {
    while (now() < deadline) {
      if (token?.cancelled) throw new Error(token.cancelReason || '靠岸已取消');
      if (!bot.entity || Number(bot.health ?? 20) <= 0) throw new Error('角色已死亡或离开世界');
      const pos = bot.entity.position;
      const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
      if (dryStandingSpot(bot, x, y, z, pos)) return true;
      const eye = bot.blockAt(pos.offset(0, bot.entity.eyeHeight ?? 1.62, 0));
      if (!breathable(eye) && (!Number.isFinite(bot.oxygenLevel) || bot.oxygenLevel < 12)) {
        bot.setControlState('forward', false);
        bot.setControlState('jump', true);
        await sleep(400);
        continue;
      }
      if (previous && Math.hypot(pos.x - previous.x, pos.y - previous.y, pos.z - previous.z) < 0.12) still += 1;
      else still = 0;
      previous = pos.clone();
      if (target && still >= 5) { excluded.add(target.key); target = null; path = []; still = 0; }
      if (path.length && Math.hypot(pos.x - path[0].x, pos.z - path[0].z) < 0.3) path.shift();
      if (!target) {
        const plan = shoreRoute(bot, pos, searchRadius, excluded);
        target = plan?.target || null;
        path = plan?.path || [];
      }
      bot.setControlState('jump', true);
      bot.setControlState('forward', false);
      if (target) {
        const waypoint = path[0] || target;
        const distance = Math.hypot(waypoint.x - pos.x, waypoint.z - pos.z);
        const ahead = distance > 0 ? pos.offset((waypoint.x - pos.x) / distance, 0, (waypoint.z - pos.z) / distance) : pos;
        const feetAhead = bot.blockAt(ahead), headAhead = bot.blockAt(ahead.offset(0, 1, 0));
        const leaf = [feetAhead, headAhead].find(block => /_leaves$/.test(String(block?.name || '')));
        if (leaf) {
          if (!await clearBlockingLeaves(bot, leaf, token)) { excluded.add(target.key); target = null; }
          await sleep(100);
          continue;
        }
        const climbingBank = waypoint === target && target.y === Math.floor(pos.y) + 1
          && feetAhead?.boundingBox === 'block' && !waterLike(feetAhead)
          && !/lava|fire|cactus|magma|campfire|powder_snow|sweet_berry_bush|leaves/.test(feetAhead.name)
          && passable(headAhead);
        if (!feetAhead || !headAhead || (!climbingBank && [feetAhead, headAhead].some(block => !passable(block)))) {
          excluded.add(target.key); target = null;
          path = [];
          await sleep(100);
          continue;
        }
        await bot.lookAt(pos.offset(waypoint.x - pos.x, 0, waypoint.z - pos.z), true);
        if (token?.cancelled) throw new Error(token.cancelReason || '靠岸已取消');
        bot.setControlState('forward', true);
      }
      await sleep(400);
    }
    return false;
  } finally { release(bot); }
}


export function allowedDuringWaterEscape(tool) {
  return new Set(['stop', 'chat', 'inventory', 'observe', 'locate_block', 'locate_entity', 'swim_escape', 'swim_out']).has(tool);
}
