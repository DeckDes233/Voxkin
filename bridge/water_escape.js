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
function onMagma(bot, pos) {
  return !!pos && bot.blockAt(pos.floored().offset(0, -1, 0))?.name === 'magma_block';
}
function hotCurrent(bot, pos) {
  const feet = bot.blockAt(pos);
  return onMagma(bot, pos) || (feet?.name === 'bubble_column' && feet.getProperties?.()?.drag === true);
}
// 水下岩浆柱能供氧，但会把角色拉到灼热的底面。横移出柱后再上浮。
async function leaveHotCurrent(bot, pos, token, sleep) {
  const hot = onMagma(bot, pos);
  bot.setControlState('sneak', hot);
  if (!hotCurrent(bot, pos)) return false;
  const base = pos.floored();
  const next = [[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dz]) => base.offset(dx,0,dz)).find(p => {
    const floor = bot.blockAt(p.offset(0,-1,0));
    return floor && (floor.boundingBox === 'block' || waterLike(floor)) && !/magma|lava|campfire/.test(floor.name)
      && !hotCurrent(bot,p) && passable(bot.blockAt(p)) && passable(bot.blockAt(p.offset(0,1,0)));
  });
  bot.setControlState('jump', !hot);
  bot.setControlState('forward', false);
  if (next) {
    await bot.lookAt(next.offset(0.5,bot.entity.eyeHeight ?? 1.62,0.5), true);
    if (token?.cancelled) throw new Error(token.cancelReason || '水中自救已取消');
    bot.setControlState('forward', true);
  }
  await sleep(200);
  return true;
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
      if (hotCurrent(bot,pos.offset(offsetX,0,offsetZ)) || !passable(bot.blockAt(pos.offset(offsetX,0,offsetZ))) || !passable(bot.blockAt(pos.offset(offsetX,1,offsetZ)))) continue;
      queue.push({ x,z,path:[...cell.path,{x:x+0.5,y:pos.y,z:z+0.5,key}] });
    }
  }
  return null;
}
const MOVEMENT = ['jump','forward','back','left','right','sprint','sneak'];
function release(bot) { for (const key of MOVEMENT) bot.setControlState(key, key === 'sneak' && onMagma(bot, bot.entity?.position)); }

// 在单宽进水矿道里，从侧壁承托处封住上游断面；保留角色所在列及下游呼吸空间。
export function shaftFlowBarrier(bot) {
  const pos = bot.entity.position.floored();
  const solid = p => {
    const block = bot.blockAt(p);
    return block?.boundingBox === 'block' && !waterLike(block) && !/magma|lava/.test(block.name);
  };
  for (const distance of [2, 1, 3]) {
    for (const [dx, dz, side] of [[0,-1],[0,1],[-1,0],[1,0]].flatMap(([x,z]) => [0,1,-1].map(s => [x,z,s]))) {
      const column = pos.offset(dx * distance + dz * side, 0, dz * distance + dx * side);
      for (const dy of [1, 0, -1]) {
        const top = column.offset(0, dy, 0), water = bot.blockAt(top);
        if (water?.name !== 'water' || !(Number(water.getProperties?.().level) > 0)
            || !breathable(bot.blockAt(top.offset(0, 1, 0))) || bot.blockAt(top.offset(dx, 1, dz))?.name !== 'water') continue;
        const cells = [];
        let bottom = top;
        while (cells.length < 3 && bot.blockAt(bottom)?.name === 'water') {
          cells.unshift(bottom);
          bottom = bottom.offset(0, -1, 0);
        }
        cells.push(top.offset(0, 1, 0));
        if (bot.blockAt(bottom)?.boundingBox !== 'block' || !cells.every(p =>
          p.distanceTo(bot.entity.position) < 3.8 && solid(p.offset(dz, 0, dx)) && solid(p.offset(-dz, 0, -dx)))) continue;
        return cells;
      }
    }
  }
  return [];
}

export async function escapeWater(bot, { token = null, timeoutMs = 25000, radius = 12, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const deadline = now() + timeoutMs, searchRadius = Math.max(1, Math.min(8, Math.floor(radius)));
  let last = null, still = 0, path = null, dryEyeTick = null;
  const excluded = new Set();
  release(bot);
  try {
    if (!bot.entity || Number(bot.health ?? 20) <= 0) throw new Error('角色已死亡或离开世界');
    last = bot.entity.position.clone();
    while (now() < deadline) {
      if (token?.cancelled) throw new Error(token.cancelReason || '水中自救已取消');
      if (!bot.entity || Number(bot.health ?? 20) <= 0) throw new Error('角色已死亡或离开世界');
      const pos = bot.entity.position;
      if (await leaveHotCurrent(bot, pos, token, sleep)) { path = null; continue; }
      const eye = bot.blockAt(pos.offset(0, bot.entity.eyeHeight ?? 1.62, 0));
      if (breathable(eye) && eye.name !== 'bubble_column') {
        if (Number.isFinite(bot.oxygenLevel) && bot.oxygenLevel >= 19) return true;
        if (Number.isFinite(bot.time?.age)) {
          dryEyeTick ??= bot.time.age;
          if (bot.oxygenLevel == null && bot.time.age - dryEyeTick >= 100) return true;
        }
      } else dryEyeTick = null;
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

// 只允许穿过单格稳定顶板，上方须是一到三格普通水、明亮空气及可游达的近岸。
export function shallowSurfaceExit(bot) {
  const pos = bot?.entity?.position;
  if (!pos?.offset || !(bot.health >= 16) || !(bot.food >= 10)
      || !bot.time?.isDay || !['overworld', 'minecraft:overworld'].includes(bot.game?.dimension)) return null;
  if (![0, 1].every(y => breathable(bot.blockAt(pos.offset(0, y, 0))))) return null;
  const roof = bot.blockAt(pos.offset(0, 2, 0));
  if (!['dirt', 'stone', 'andesite', 'diorite', 'granite', 'clay'].includes(roof?.name) || !bot.canDigBlock?.(roof)) return null;
  for (let height = 3; height <= 6; height++) {
    const block = bot.blockAt(pos.offset(0, height, 0));
    if (block?.name === 'water') continue;
    if (height === 3 || block?.name !== 'air' || !(surfaceSkyLight(bot, pos.offset(0, height, 0)) >= 14)
        || bot.blockAt(pos.offset(0, height + 1, 0))?.name !== 'air') return null;
    const surface = pos.offset(0, height - 1, 0);
    const shore = shoreRoute(bot, surface, 10, new Set(), true);
    if (shore && shore.target.y >= Math.floor(surface.y)) return {roof, surfaceY: Math.floor(surface.y)};
    return null;
  }
  return null;
}

function suitableBank(bot, x, y, z, pos, connected) {
  if (!dryStandingSpot(bot, x, y, z, pos)) return false;
  if (!connected) return true;
  if (!(surfaceSkyLight(bot, pos.offset(x - pos.x, y + 1 - pos.y, z - pos.z)) >= 12)) return false;
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) =>
    [0, 1, -1].some(dy => dryStandingSpot(bot, x + dx, y + dy, z + dz, pos))).length >= 2;
}

export function onConnectedBank(bot) {
  const pos = bot?.entity?.position;
  return Boolean(pos?.offset && suitableBank(bot, Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), pos, true));
}


// 水面和石台相差两格时搭一级台阶。最多用两块圆石，从侧壁向水面伸出，留足站立净空。
export function waterLanding(bot) {
  const pos = bot.entity.position, start = pos.floored(), choices = [];
  const sides = [[1,0],[-1,0],[0,1],[0,-1]];
  const anchored = p => sides.some(([x,z]) => {
    const side = bot.blockAt(p.offset(x,0,z));
    return side?.boundingBox === 'block' && !waterLike(side) && !/magma|lava/.test(side.name);
  });
  const usable = p => p.distanceTo(pos) < 3.6 && (p.x !== start.x || p.z !== start.z) && bot.blockAt(p)?.name === 'water';
  for (const dy of [0, 1, -1, 2]) {
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const p = start.offset(dx,dy,dz);
      if (!usable(p) || ![1,2].every(y => ['air','cave_air'].includes(bot.blockAt(p.offset(0,y,0))?.name))) continue;
      if (anchored(p)) choices.push([p]);
      else {
        const support = sides.map(([x,z]) => p.offset(x,0,z)).find(s => usable(s) && anchored(s));
        if (support) choices.push([support,p]);
      }
    }
  }
  return choices.sort((a,b) => a.length - b.length || a.at(-1).distanceTo(pos) - b.at(-1).distanceTo(pos))[0] || [];
}

function shoreRoute(bot, pos, radius, excluded, connected = false) {
  const sx = Math.floor(pos.x), sz = Math.floor(pos.z), y = Math.floor(pos.y);
  const queue = [{ x: sx, z: sz, path: [] }];
  const seen = new Set([`${sx},${sz}`]);
  for (let i = 0; i < queue.length; i += 1) {
    const cell = queue[i];
    for (const dy of [0, 1, -1, 2, -2]) {
      const landY = y + dy, key = `${cell.x},${landY},${cell.z}`;
      if (!excluded.has(key) && suitableBank(bot, cell.x, landY, cell.z, pos, connected)) {
        return { path: cell.path, target: { x: cell.x + 0.5, y: landY, z: cell.z + 0.5, key } };
      }
    }
    for (const [dx, dz] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const x = cell.x + dx, z = cell.z + dz, key = `${x},${z}`;
      if (seen.has(key) || Math.hypot(x - sx, z - sz) > radius) continue;
      seen.add(key);
      const offset = pos.offset(x - sx, 0, z - sz);
      if (hotCurrent(bot, offset)) continue;
      const feet = bot.blockAt(offset), head = bot.blockAt(offset.offset(0, 1, 0));
      const raisedKey = `${x},${y + 1},${z}`;
      if (!excluded.has(raisedKey) && suitableBank(bot, x, y + 1, z, pos, connected)) {
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

// 含水洞顶只有一个气穴时，在水面旁的实心岩壁中开出一级干燥台阶。
const shoreRock = /^(stone|granite|diorite|andesite|deepslate|tuff|dirt|cobblestone)$/;

function safeShoreOpening(bot, block) {
  return [[0,1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]].every(([x,y,z]) => {
    const side = bot.blockAt(block.position.offset(x,y,z));
    return side && !waterLike(side) && !/lava|dripstone/.test(side.name)
      && !(y > 0 && /sand$|gravel|anvil|concrete_powder/.test(side.name));
  });
}

export function shoreHeadroomBlock(bot) {
  const pos = bot.entity?.position;
  if (!pos?.floored || !waterLike(bot.blockAt(pos))) return null;
  let base = pos.floored();
  for (let i = 0; i < 2 && waterLike(bot.blockAt(base.offset(0, 1, 0))); i++) base = base.offset(0, 1, 0);
  if (!breathable(bot.blockAt(base.offset(0, 1, 0)))) return null;
  const roof = bot.blockAt(base.offset(0, 2, 0));
  if (!roof?.position || !shoreRock.test(roof.name) || !bot.canDigBlock?.(roof) || !safeShoreOpening(bot, roof)) return null;
  const bank = [[1,0],[-1,0],[0,1],[0,-1]].some(([x,z]) => dryStandingSpot(bot, base.x+x, base.y+1, base.z+z, base));
  return bank ? roof : null;
}

async function digShoreBlocks(bot, blocks, token, deadline, now) {
  for (const block of blocks) {
    if (token?.cancelled || now() >= deadline || bot.oxygenLevel < 19 || !safeShoreOpening(bot, block)) return false;
    const tool = bot.pathfinder.bestHarvestTool(block);
    if (tool) await bot.equip(tool, 'hand');
    const waitMs = Math.min(deadline - now(), 4000);
    if (!(bot.digTime(block) + 200 < waitMs)) return false;
    let timeout;
    try {
      await Promise.race([bot.dig(block), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('开靠岸台阶超时')), waitMs);
      })]);
    } catch {
      bot.stopDigging?.();
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
  return true;
}

async function openShoreStep(bot, pos, token, deadline, now) {
  if (!bot.canDigBlock || !bot.dig || !bot.pathfinder?.bestHarvestTool || bot.oxygenLevel < 19) return false;
  const origin = pos.floored();
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const feet = origin.offset(dx, 1, dz);
    const floor = bot.blockAt(feet.offset(0, -1, 0));
    if (!shoreRock.test(floor?.name)) {
      if (!['gravel', 'sand'].includes(floor?.name)) continue;
      // 沙砾只能作已承托的地板。沿柱向下确认实心岩层，施工不碰该列的地基。
      let anchored = false;
      for (let dy = -2; dy >= -9; dy--) {
        const below = bot.blockAt(feet.offset(0, dy, 0));
        if (shoreRock.test(below?.name)) { anchored = true; break; }
        if (!['gravel', 'sand'].includes(below?.name)) break;
      }
      if (!anchored) continue;
    }
    const cells = [feet.offset(0, 1, 0), feet].map(p => bot.blockAt(p));
    if (!cells.every(b => breathable(b) || (shoreRock.test(b?.name) && bot.canDigBlock(b)))) continue;
    const wall = cells.filter(b => !breathable(b));
    if (!wall.length) continue;
    if (wall.every(b => safeShoreOpening(bot, b))) return digShoreBlocks(bot, wall, token, deadline, now);
  }
  return false;
}

export async function reachShore(bot, { token = null, timeoutMs = 25000, radius = 12, connected = false, placeLanding = null,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  const searchRadius = Math.max(1, Math.min(12, Math.floor(radius)));
  const excluded = new Set();
  let target = null, path = [], previous = null, still = 0;
  let triedStep = false, triedLanding = false, triedHeadroom = false;
  release(bot);
  try {
    while (now() < deadline) {
      if (token?.cancelled) throw new Error(token.cancelReason || '靠岸已取消');
      if (!bot.entity || Number(bot.health ?? 20) <= 0) throw new Error('角色已死亡或离开世界');
      const pos = bot.entity.position;
      if (await leaveHotCurrent(bot, pos, token, sleep)) { target = null; path = []; continue; }
      const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
      if (suitableBank(bot, x, y, z, pos, connected)) return true;
      const eye = bot.blockAt(pos.offset(0, bot.entity.eyeHeight ?? 1.62, 0));
      if (!triedHeadroom && breathable(eye) && bot.oxygenLevel >= 19 && bot.pathfinder?.bestHarvestTool && bot.dig) {
        const roof = shoreHeadroomBlock(bot);
        if (roof) {
          triedHeadroom = true;
          bot.setControlState('forward', false);
          bot.setControlState('jump', true);
          if (await digShoreBlocks(bot, [roof], token, deadline, now)) { target = null; path = []; excluded.clear(); continue; }
        }
      }
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
        if (!connected && placeLanding && !triedLanding && (triedStep || excluded.size) && breathable(eye)) {
          const cells = waterLanding(bot);
          if (cells.length) {
            triedLanding = true;
            bot.setControlState('forward', false);
            bot.setControlState('jump', true);
            for (const p of cells) {
              const here = bot.entity.position;
              if (token?.cancelled || now() >= deadline || here.distanceTo(p) >= 3.6
                  || (p.x === Math.floor(here.x) && p.z === Math.floor(here.z)) || bot.blockAt(p)?.name !== 'water') break;
              if (!await placeLanding(p) || bot.blockAt(p)?.name !== 'cobblestone') break;
            }
            excluded.clear();
          }
        }
        const plan = shoreRoute(bot, pos, searchRadius, excluded, connected);
        target = plan?.target || null;
        path = plan?.path || [];
        if (!target && !triedStep && breathable(eye) && bot.oxygenLevel >= 19) {
          triedStep = true;
          bot.setControlState('forward', false);
          bot.setControlState('jump', true);
          if (await openShoreStep(bot, pos, token, deadline, now)) continue;
        }
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
// 客户端的光照 section 缺失时 prismarine-chunk 返回 0。仅在整列到天顶都是空气时补判直射天光。
export function surfaceSkyLight(bot, position) {
  const reported = bot.blockAt(position, false)?.skyLight;
  if (reported !== 0 || !['overworld', 'minecraft:overworld'].includes(bot.game?.dimension)) return reported;
  const col = bot.world?.getColumnAt?.(position);
  if (!col?.sections || !Number.isInteger(col.minY) || !Number.isInteger(col.worldHeight)) return reported;
  const top = col.minY + col.worldHeight, y0 = Math.floor(position.y);
  if (y0 < col.minY || y0 >= top) return reported;
  const local = {x: Math.floor(position.x) & 15, y: 0, z: Math.floor(position.z) & 15};
  const air = bot.registry?.blocksByName?.air?.defaultState;
  if (!Number.isInteger(air)) return reported;
  for (let y = y0; y < top;) {
    const section = col.sections[(y - col.minY) >> 4];
    const end = Math.min(top, (Math.floor(y / 16) + 1) * 16);
    if (section && section.solidBlockCount !== 0) {
      for (let h = y; h < end; h++) {
        local.y = h & 15;
        if (section.get(local) !== air) return reported;
      }
    }
    y = end;
  }
  return 15;
}
