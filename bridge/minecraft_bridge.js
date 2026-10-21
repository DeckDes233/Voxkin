// 沃心 Minecraft 桥接进程：mineflayer 负责游戏内身份，WebSocket 负责与 Voxkin Core 通信。
// 部分动作与自主行为参考 MindCraft（MIT，https://github.com/mindcraft-bots/mindcraft）。
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import WebSocket from 'ws';
import { Vec3 } from 'vec3';
import armorManager from 'mineflayer-armor-manager';
import toolModule from 'mineflayer-tool';

const { pathfinder, Movements, goals } = pathfinderPkg;

const config = {
  host: process.env.MC_HOST || '127.0.0.1',
  port: Number(process.env.MC_PORT || 25565),
  version: process.env.MC_VERSION || false,
  username: process.env.MC_USERNAME || 'Voxkin',
  auth: process.env.MC_AUTH || 'offline',
  ws: process.env.VOXKIN_WS || 'ws://127.0.0.1:8765/ws/bridge',
};

const BLOCK_NAMES = {
  dirt: '泥土',
  grass_block: '草方块',
  stone: '石头',
  cobblestone: '圆石',
  oak_log: '橡木',
  birch_log: '白桦木',
  sand: '沙子',
  gravel: '沙砾',
  coal_ore: '煤矿',
  iron_ore: '铁矿',
  wheat: '小麦',
  zombie: '僵尸',
  skeleton: '骷髅',
  spider: '蜘蛛',
  creeper: '苦力怕',
  witch: '女巫',
  enderman: '末影人',
  slime: '史莱姆',
  drowned: '溺尸',
  husk: '尸壳',
  stray: '流浪者',
  phantom: '幻翼',
};

const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'spider', 'creeper', 'witch', 'enderman', 'slime',
  'magma_cube', 'pillager', 'vindicator', 'drowned', 'husk', 'stray',
  'phantom', 'blaze', 'ghast', 'zoglin', 'hoglin', 'piglin_brute', 'warden',
  'guardian', 'elder_guardian', 'shulker', 'silverfish', 'endermite', 'vex',
  'ravager', 'evoker', 'illusioner',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function blockLabel(name) {
  return BLOCK_NAMES[name] || name;
}

let socket = null;
let bot = null;
let reconnectTimer = null;
const actionQueue = [];
let actionRunning = false;
let currentTool = '';
let interrupted = false;
const PRIORITY_ACTIONS = new Set(['attack_nearest', 'stop']);
let followTimer = null;
let followSession = null;
let actionBusy = false;
let lastActivity = Date.now();
let lastPlayerChatAt = 0;
let lastDistanceAsk = 0;
let wanderActive = false;
let wanderToken = 0;
let combatBusy = false;
let lastCombatAt = 0;
let lastEatAt = 0;
let lastHurtAt = 0;
let lastHealth = null;
let escapeBusy = false;
let lastCreeperWarnAt = 0;

const IDLE_WANDER_MS = 20000;
const FAR_DISTANCE = Number(process.env.VOXKIN_FAR_DISTANCE || 128);
const DISTANCE_ASK_COOLDOWN_MS = 180000;

function log(...args) {
  console.log(new Date().toISOString(), '[bridge]', ...args);
}

function connectCore() {
  const name = `${config.username}@${config.host}:${config.port}`;
  socket = new WebSocket(`${config.ws}?name=${encodeURIComponent(name)}`);

  socket.on('open', () => {
    log('已连接 Voxkin Core');
    socket.send(JSON.stringify({ type: 'hello', bridge: name, protocol: 1 }));
  });

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      log('收到无法解析的消息', error.message);
      return;
    }
    if (message.type === 'action') {
      enqueueAction(message);
    } else if (message.type === 'welcome') {
      log('Core 握手完成', message.name);
    } else if (message.type === 'error') {
      log('Core 返回错误', message.error);
    }
  });

  socket.on('close', () => {
    log('与 Core 的连接断开，3 秒后重连');
    socket = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectCore, 3000);
  });

  socket.on('error', (error) => {
    log('Core 连接错误', error.message);
  });
}

function interruptCurrent(reason) {
  if (!currentTool) return;
  log('打断当前动作', currentTool, reason);
  interrupted = true;
  if (bot) {
    bot.pathfinder.stop();
    bot.stopDigging();
    bot.clearControlStates();
  }
}

function enqueueAction(message) {
  if (PRIORITY_ACTIONS.has(message.tool)) {
    interruptCurrent(message.tool);
    actionQueue.unshift(message);
  } else {
    actionQueue.push(message);
  }
  pumpActions();
}

async function pumpActions() {
  if (actionRunning) return;
  actionRunning = true;
  try {
    while (actionQueue.length > 0) {
      const message = actionQueue.shift();
      await runAction(message);
    }
  } finally {
    actionRunning = false;
  }
}

async function runAction(message) {
  if (!bot || !bot.entity) {
    reply(message, false, 'bot 尚未进入世界');
    return;
  }
  const args = message.arguments || {};
  currentTool = message.tool;
  interrupted = false;
  actionBusy = true;
  lastActivity = Date.now();
  try {
    if (
      ['goto', 'come_to_player', 'collect_blocks', 'attack_nearest', 'stop', 'break_block', 'place_block', 'goto_block', 'pickup_items'].includes(
        message.tool
      )
    ) {
      stopFollow();
      wanderToken += 1;
      wanderActive = false;
    }
    let detail = '';
    switch (message.tool) {
      case 'chat':
        bot.chat(String(args.text || ''));
        detail = '已发送聊天消息';
        break;
      case 'stop':
        stopFollow();
        detail = '已停止移动';
        break;
      case 'follow_player': {
        const player = resolvePlayer(args.player);
        const distance = Math.min(Math.max(Number(args.distance) || 2, 1), 6);
        startFollow(player, distance);
        detail = `正在跟随 ${player.username}，保持 ${distance} 格`;
        break;
      }
      case 'come_to_player': {
        const player = resolvePlayer(args.player);
        const target = player.entity.position;
        const result = await travelTo(target.x, target.y, target.z, 2);
        detail =
          result.vertical > 2
            ? `到了 ${player.username} 下方或上方，垂直差 ${result.vertical.toFixed(1)} 格`
            : `已到 ${player.username} 附近，距离 ${result.distance.toFixed(1)} 格`;
        break;
      }
      case 'inventory': {
        const items = bot.inventory.items();
        detail = items.length
          ? items.map((item) => `${blockLabel(item.name)} x${item.count}`).join('、').slice(0, 400)
          : '背包是空的';
        break;
      }
      case 'attack_nearest': {
        const range = Math.min(Math.max(Number(args.range) || 16, 3), 32);
        const target = findHostile(range);
        if (!target) throw new Error(`附近 ${range} 格内没有敌对生物`);
        await equipWeapon();
        const name = blockLabel(target.name);
        let hits = 0;
        for (let index = 0; index < 24 && target.isValid; index += 1) {
          await bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true);
          bot.attack(target);
          hits += 1;
          await sleep(600);
        }
        detail = target.isValid
          ? `攻击了 ${name} ${hits} 次，它还在`
          : `击败了 ${name}，${hits} 次攻击`;
        break;
      }
      case 'goto':
        detail = await goTo(Number(args.x), Number(args.y), Number(args.z));
        break;
      case 'collect_blocks':
        detail = await collectBlocks(String(args.block), Number(args.count || 1));
        break;
      case 'break_block':
        detail = await breakBlock(args);
        break;
      case 'place_block':
        detail = await placeBlock(args);
        break;
      case 'goto_block':
        detail = await gotoBlock(args);
        break;
      case 'pickup_items':
        detail = await pickupItems(args);
        break;
      case 'look_at_player': {
        const player = bot.players[args.player];
        if (!player || !player.entity) throw new Error(`找不到玩家 ${args.player}`);
        await bot.lookAt(player.entity.position.offset(0, 1.6, 0), true);
        detail = '已看向玩家';
        break;
      }
      default:
        throw new Error(`未知动作 ${message.tool}`);
    }
    reply(message, true, detail);
  } catch (error) {
    reply(message, false, error.message);
  } finally {
    actionBusy = false;
    currentTool = '';
    interrupted = false;
    lastActivity = Date.now();
  }
}

function reply(message, ok, detail) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(
    JSON.stringify({
      type: 'action_result',
      action_id: message.action_id,
      ok,
      detail: String(detail).slice(0, 500),
    })
  );
  log(ok ? '动作完成' : '动作失败', message.tool, detail);
}

async function travelTo(x, y, z, radius = 2) {
  if (![x, y, z].every(Number.isFinite)) throw new Error('坐标无效');
  if (typeof bot.waitForChunksToLoad === 'function') {
    await Promise.race([bot.waitForChunksToLoad().catch(() => {}), sleep(5000)]);
  }
  let guard = 0;
  while (guard < 10) {
    if (interrupted) throw new Error('被新的指令打断');
    const position = bot.entity.position;
    const horizontal = Math.hypot(x - position.x, z - position.z);
    if (horizontal <= 32) break;
    const step = Math.min(32, horizontal - 24);
    const waypointX = Math.floor(position.x + ((x - position.x) / horizontal) * step);
    const waypointZ = Math.floor(position.z + ((z - position.z) / horizontal) * step);
    try {
      await bot.pathfinder.goto(new goals.GoalXZ(waypointX, waypointZ));
    } catch (error) {
      log('分段寻路失败，改为直接尝试目标', error.message);
      break;
    }
    guard += 1;
  }
  const attempts = [new goals.GoalNear(x, y, z, radius), new goals.GoalXZ(x, z)];
  let lastError = null;
  for (const goal of attempts) {
    if (interrupted) throw new Error('被新的指令打断');
    try {
      await bot.pathfinder.goto(goal);
      return {
        distance: bot.entity.position.distanceTo(vec(x, y, z)),
        vertical: Math.abs(bot.entity.position.y - y),
        goal: goal.constructor.name,
      };
    } catch (error) {
      lastError = error;
      log('寻路失败，尝试备选目标', goal.constructor.name, error.message);
    }
  }
  throw new Error(`走不过去：${lastError ? lastError.message : '没有路径'}`);
}

async function goTo(x, y, z) {
  const result = await travelTo(x, y, z, 2);
  if (result.vertical > 2) {
    return `到了 (${x}, ${z}) 附近，垂直差 ${result.vertical.toFixed(1)} 格，可能在目标上方或下方`;
  }
  return `已到达 (${x}, ${y}, ${z}) 附近，距离 ${result.distance.toFixed(1)} 格`;
}

async function collectBlocks(blockName, count) {
  const blockIds = bot.registry.blocksByName[blockName];
  if (!blockIds) throw new Error(`未知方块 ${blockName}`);
  const positions = bot.findBlocks({
    matching: blockIds.id,
    maxDistance: 32,
    count: Math.max(count, 1),
  });
  if (positions.length === 0) throw new Error(`附近 32 格内没有 ${blockLabel(blockName)}`);
  let collected = 0;
  for (const position of positions) {
    if (interrupted) throw new Error('被新的指令打断');
    const block = bot.blockAt(position);
    if (!block) continue;
    await bot.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, 1));
    if (bot.canDigBlock(block)) {
      await equipToolFor(block);
      await bot.dig(block);
      collected += 1;
    }
    if (collected >= count) break;
  }
  if (collected === 0) throw new Error(`没有成功挖到 ${blockLabel(blockName)}`);
  return `挖到 ${collected} 个 ${blockLabel(blockName)}`;
}

async function equipToolFor(block) {
  if (!bot.tool || typeof bot.tool.equipForBlock !== 'function') return;
  try {
    await bot.tool.equipForBlock(block, {});
  } catch (error) {
    log('换工具失败', error.message);
  }
}

async function breakBlock(args) {
  let position;
  if (args.block) {
    position = findBlockPosition(String(args.block), Math.min(Number(args.range) || 16, 32));
  } else {
    if (![args.x, args.y, args.z].every(Number.isFinite)) {
      throw new Error('需要方块名或坐标');
    }
    position = vec(args.x, args.y, args.z);
  }
  const block = bot.blockAt(position);
  if (!block || block.name === 'air') throw new Error('目标位置没有方块');
  if (bot.entity.position.distanceTo(position) > 4) {
    await bot.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, 1));
  }
  await equipToolFor(block);
  if (!bot.canDigBlock(block)) throw new Error(`现在不能挖 ${blockLabel(block.name)}`);
  await bot.dig(block);
  return `挖掉了 ${blockLabel(block.name)}，位置 (${position.x}, ${position.y}, ${position.z})`;
}

async function placeBlock(args) {
  const name = String(args.block || '');
  if (![args.x, args.y, args.z].every(Number.isFinite)) throw new Error('坐标无效');
  const target = vec(args.x, args.y, args.z);
  const existing = bot.blockAt(target);
  if (existing && existing.boundingBox !== 'empty') throw new Error('目标位置已经有方块');
  const item = bot.inventory.items().find((entry) => entry.name === name);
  if (!item) throw new Error(`背包里没有 ${blockLabel(name)}`);
  if (bot.entity.position.distanceTo(target) > 4) {
    await bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 2));
  }
  await bot.equip(item, 'hand');
  const faces = [
    [0, -1, 0],
    [0, 0, -1],
    [0, 0, 1],
    [-1, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ];
  let lastError = null;
  for (const [dx, dy, dz] of faces) {
    const reference = bot.blockAt(target.offset(dx, dy, dz));
    if (!reference || reference.boundingBox !== 'block') continue;
    try {
      await bot.placeBlock(reference, vec(-dx, -dy, -dz));
      return `放置 ${blockLabel(name)} 于 (${target.x}, ${target.y}, ${target.z})`;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(lastError ? `放置失败: ${lastError.message}` : '周围没有可以依附的方块');
}

async function gotoBlock(args) {
  const range = Math.min(Math.max(Number(args.range) || 32, 4), 64);
  const position = findBlockPosition(String(args.block), range);
  const result = await travelTo(position.x, position.y, position.z, 2);
  if (result.vertical > 2) {
    return `到了 ${blockLabel(args.block)} 附近，垂直差 ${result.vertical.toFixed(1)} 格`;
  }
  return `到了 ${blockLabel(args.block)} 附近，距离 ${result.distance.toFixed(1)} 格`;
}

async function pickupItems(args) {
  const range = Math.min(Math.max(Number(args.range) || 16, 3), 32);
  const item = bot.nearestEntity(
    (entity) =>
      entity.type === 'item' &&
      entity.position.distanceTo(bot.entity.position) <= range
  );
  if (!item) throw new Error(`附近 ${range} 格内没有掉落物`);
  await bot.pathfinder.goto(
    new goals.GoalNear(item.position.x, item.position.y, item.position.z, 1)
  );
  return '走到了掉落物旁边';
}

async function approach(target) {
  if (!target || !target.position) return;
  if (bot.entity.position.distanceTo(target.position) <= 3) return;
  try {
    await bot.pathfinder.goto(
      new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2)
    );
  } catch (error) {
    log('接近目标失败', error.message);
  }
}

async function retreatFrom(target) {
  if (!target || !target.position) return;
  const position = bot.entity.position;
  const dx = position.x - target.position.x;
  const dz = position.z - target.position.z;
  const length = Math.hypot(dx, dz) || 1;
  const x = Math.floor(position.x + (dx / length) * 12);
  const z = Math.floor(position.z + (dz / length) * 12);
  try {
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalXZ(x, z)),
      sleep(4000),
    ]);
  } catch (error) {
    log('后撤失败', error.message);
  } finally {
    bot.pathfinder.stop();
  }
}

function findRangedWeapon() {
  const items = bot.inventory.items();
  const bow = items.find((item) => item.name === 'bow' || item.name === 'crossbow');
  const arrows = items.find((item) => item.name === 'arrow');
  if (!bow || !arrows) return null;
  return { bow, arrows };
}

function aimPoint(target) {
  const base = target.position.offset(0, target.height * 0.5, 0);
  const velocity = target.velocity || { x: 0, y: 0, z: 0 };
  const distance = bot.entity.position.distanceTo(base);
  const flight = distance / 30;
  return base.offset(
    (velocity.x || 0) * flight,
    (velocity.y || 0) * flight,
    (velocity.z || 0) * flight
  );
}

async function shootAt(target) {
  const ranged = findRangedWeapon();
  if (!ranged) return false;
  try {
    await bot.equip(ranged.bow, 'hand');
    await bot.lookAt(aimPoint(target), true);
    await bot.activateItem();
    await sleep(ranged.bow.name === 'crossbow' ? 1250 : 900);
    await bot.deactivateItem();
    return true;
  } catch (error) {
    log('射击失败', error.message);
    return false;
  }
}

async function attackEntity(target) {
  await equipWeapon();
  const name = blockLabel(target.name);
  let hits = 0;
  let meleeReady = true;
  for (let index = 0; index < 20 && target.isValid !== false && bot.health > 4; index += 1) {
    if (interrupted) throw new Error('被新的指令打断');
    const distance = target.position
      ? bot.entity.position.distanceTo(target.position)
      : 0;
    const flying =
      target.name === 'phantom' ||
      (target.position && target.position.y - bot.entity.position.y > 2.5);
    if (flying) {
      await bot.lookAt(target.position.offset(0, target.height * 0.7, 0), true);
      if (findRangedWeapon() && distance > 3.5) {
        if (await shootAt(target)) {
          hits += 1;
          meleeReady = false;
          await sleep(700);
          continue;
        }
      }
      if (distance <= 3.5) {
        if (!meleeReady) {
          await equipWeapon();
          meleeReady = true;
        }
        bot.attack(target);
        hits += 1;
      }
      await sleep(500);
      continue;
    }
    if (findRangedWeapon() && distance > 6 && await shootAt(target)) {
      hits += 1;
      meleeReady = false;
      await sleep(700);
      continue;
    }
    if (!meleeReady) {
      await equipWeapon();
      meleeReady = true;
    }
    if (distance > 3) {
      await approach(target);
    }
    await bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true);
    bot.attack(target);
    hits += 1;
    await sleep(600);
  }
  if (target.isValid === false) {
    return hits === 0 ? `目标消失了，没有打中` : `击败了 ${name}，${hits} 次攻击`;
  }
  return `攻击了 ${name} ${hits} 次，它还在`;
}

async function defendAgainst(target) {
  if (combatBusy) return;
  combatBusy = true;
  lastCombatAt = Date.now();
  try {
    wanderToken += 1;
    wanderActive = false;
    bot.pathfinder.stop();
    if (followSession) stopFollow();
    if (target.name === 'creeper') {
      log('苦力怕靠近，先后撤');
      await retreatFrom(target);
      return;
    }
    if (bot.health <= 8) {
      log('血量偏低，先后撤');
      await retreatFrom(target);
      if (findFood()) await eatIfPossible();
      return;
    }
    await approach(target);
    const detail = await attackEntity(target);
    log('反击结束', detail);
  } catch (error) {
    log('反击失败', error.message);
  } finally {
    combatBusy = false;
    lastActivity = Date.now();
  }
}

const FOOD_NAMES = [
  'bread',
  'cooked_beef',
  'cooked_porkchop',
  'cooked_chicken',
  'cooked_mutton',
  'cooked_cod',
  'cooked_salmon',
  'baked_potato',
  'apple',
  'carrot',
  'golden_apple',
  'cookie',
  'melon_slice',
  'sweet_berries',
  'glow_berries',
];

function findFood() {
  const items = bot.inventory.items().filter((item) => FOOD_NAMES.includes(item.name));
  return items.find((item) => item.name === 'golden_apple') || items[0];
}

async function eatIfPossible() {
  const food = findFood();
  if (!food) return;
  lastEatAt = Date.now();
  try {
    await bot.equip(food, 'hand');
    await bot.consume();
    log('吃了东西', food.name);
  } catch (error) {
    log('吃东西失败', error.message);
  }
}

function describeEntity(entity) {
  if (!entity) return '未知';
  return `${entity.name || entity.username || entity.type || 'entity'}#${entity.id}`;
}

function isNearDanger(position) {
  const dangers = new Set([
    'cactus',
    'lava',
    'water',
    'fire',
    'magma_block',
    'sweet_berry_bush',
    'powder_snow',
    'wither_rose',
    'campfire',
  ]);
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      const block = bot.blockAt(position.offset(dx, 0, dz));
      if (block && dangers.has(block.name)) return true;
    }
  }
  return false;
}

async function escapeEnvironment() {
  if (escapeBusy || actionBusy) return;
  escapeBusy = true;
  try {
    const target = pickWanderTarget();
    if (target) {
      bot.pathfinder.movements.allowSprinting = true;
      await bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 1));
      log('离开了危险位置');
    }
  } catch (error) {
    log('离开危险位置失败', error.message);
  } finally {
    escapeBusy = false;
    lastActivity = Date.now();
  }
}

function blockIsWater(block) {
  return Boolean(block && block.name && block.name.includes('water'));
}

function findShore(radius = 12) {
  const base = bot.entity.position;
  for (let distance = 3; distance <= radius; distance += 2) {
    for (let step = 0; step < 8; step += 1) {
      const angle = (Math.PI * 2 * step) / 8;
      const x = Math.floor(base.x + Math.cos(angle) * distance);
      const z = Math.floor(base.z + Math.sin(angle) * distance);
      for (let dy = -1; dy <= 2; dy += 1) {
        const ground = bot.blockAt(vec(x, Math.floor(base.y) + dy, z));
        if (!ground || ground.boundingBox !== 'block') continue;
        if (blockIsWater(ground) || /lava/.test(ground.name)) continue;
        const above = bot.blockAt(ground.position.offset(0, 1, 0));
        const above2 = bot.blockAt(ground.position.offset(0, 2, 0));
        if (above?.boundingBox === 'empty' && above2?.boundingBox === 'empty') {
          return { position: ground.position.offset(0, 1, 0), angle };
        }
      }
    }
  }
  return null;
}

let waterEscapeBusy = false;
let lastDrownLogAt = 0;

async function swimToShore(reason) {
  if (waterEscapeBusy) return;
  waterEscapeBusy = true;
  const oxygen = bot.oxygenLevel ?? 20;
  if (Date.now() - lastDrownLogAt > 5000) {
    lastDrownLogAt = Date.now();
    log('水里氧气不足，游向岸边', `oxygen=${oxygen} ${reason}`);
  }
  try {
    const shore = findShore(12);
    if (shore) {
      const base = bot.entity.position;
      const dx = shore.position.x - base.x;
      const dz = shore.position.z - base.z;
      await bot.look(Math.atan2(-dx, dz), 0, true);
    }
    bot.setControlState('jump', true);
    bot.setControlState('forward', true);
    await sleep(1800);
  } catch (error) {
    log('游向岸边失败', error.message);
  } finally {
    bot.setControlState('forward', false);
    waterEscapeBusy = false;
  }
}

function waterTick() {
  if (!bot || !bot.entity) return;
  const feet = bot.blockAt(bot.entity.position);
  const head = bot.blockAt(bot.entity.position.offset(0, 1, 0));
  const inWater = blockIsWater(feet) || blockIsWater(head);
  if (!inWater) {
    if (bot.getControlState('jump')) bot.setControlState('jump', false);
    return;
  }
  bot.setControlState('jump', true);
  const oxygen = bot.oxygenLevel ?? 20;
  if (oxygen <= 8) {
    swimToShore(`oxygen=${oxygen}`);
  }
}

function onDamaged(source) {
  const now = Date.now();
  if (now - lastHurtAt < 1200) return;
  lastHurtAt = now;
  lastActivity = now;
  if (source && source.id !== undefined) {
    log('伤害来源', describeEntity(source), source.type || 'unknown');
    if (source.type === 'player') {
      log('被玩家攻击，先退开');
      retreatFrom(source);
      return;
    }
    if (source.type === 'mob' || HOSTILE_MOBS.has(source.name)) {
      log('受到伤害，反击', source.name);
      defendAgainst(source);
      return;
    }
  }
  const position = bot.entity.position;
  const nearby = Object.values(bot.entities)
    .filter(
      (entity) =>
        entity !== bot.entity &&
        entity.position &&
        entity.position.distanceTo(position) < 12
    )
    .map(
      (entity) =>
        `${describeEntity(entity)}@${entity.position.distanceTo(position).toFixed(1)}`
    )
    .slice(0, 10);
  log(
    '受伤时状态',
    `health=${bot.health} food=${bot.food} pos=(${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}) 附近=${nearby.join(' | ') || '无'}`
  );
  const attacker = findHostile(12);
  if (attacker) {
    log('受到伤害，反击', attacker.name);
    defendAgainst(attacker);
    return;
  }
  log('受到环境伤害，尝试离开');
  escapeEnvironment();
}

function survivalTick() {
  if (!bot || !bot.entity || combatBusy || actionBusy) return;
  if (bot.health <= 8) return;
  if (bot.health <= 12 && findFood() && Date.now() - lastEatAt > 8000) {
    eatIfPossible();
    return;
  }
  const hostile = findHostile(16);
  if (hostile && Date.now() - lastCombatAt > 5000) {
    if (hostile.name === 'creeper') {
      const distance = bot.entity.position.distanceTo(hostile.position);
      if (distance <= 8) {
        defendAgainst(hostile);
        return;
      }
      if (Date.now() - lastCreeperWarnAt > 10000) {
        lastCreeperWarnAt = Date.now();
        log('附近有苦力怕，保持距离', distance.toFixed(1));
      }
      return;
    }
    log(
      '发现敌对生物，主动接近',
      hostile.name,
      bot.entity.position.distanceTo(hostile.position).toFixed(1)
    );
    defendAgainst(hostile);
    return;
  }
  if (bot.food <= 14 && Date.now() - lastEatAt > 10000) {
    eatIfPossible();
  }
}

function resolvePlayer(name) {
  if (name && bot.players[name] && bot.players[name].entity) {
    return bot.players[name];
  }
  const nearest = bot.nearestEntity((entity) => entity.type === 'player');
  if (!nearest) {
    const known = Object.keys(bot.players).filter((player) => player !== bot.username);
    if (known.length > 0) {
      throw new Error(`看不到 ${known[0]} 的位置，请发一下坐标`);
    }
    throw new Error('附近没有玩家');
  }
  const matched = Object.values(bot.players).find((player) => player.entity === nearest);
  if (!matched) throw new Error('附近没有玩家');
  return matched;
}

function findHostile(range) {
  return bot.nearestEntity(
    (entity) =>
      (entity.type === 'hostile' || entity.type === 'mob') &&
      HOSTILE_MOBS.has(entity.name) &&
      entity.position.distanceTo(bot.entity.position) <= range
  );
}

async function equipWeapon() {
  const weapon = bot.inventory
    .items()
    .find((item) => item.name.endsWith('_sword') || item.name.endsWith('_axe'));
  if (weapon) {
    await bot.equip(weapon, 'hand');
  }
}

function vec(x, y, z) {
  return new Vec3(Number(x), Number(y), Number(z));
}

function nearestPlayer(maxDistance = 128) {
  if (!bot || !bot.entity) return null;
  const entity = bot.nearestEntity(
    (candidate) =>
      candidate.type === 'player' &&
      candidate.position.distanceTo(bot.entity.position) <= maxDistance
  );
  if (!entity) return null;
  const entry = Object.values(bot.players).find((player) => player.entity === entity);
  if (!entry) return null;
  return { username: entry.username, entity };
}

function pickWanderTarget() {
  const base = bot.entity.position;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 5 + Math.random() * 5;
    const x = Math.floor(base.x + Math.cos(angle) * radius);
    const z = Math.floor(base.z + Math.sin(angle) * radius);
    for (let dy = 2; dy >= -4; dy -= 1) {
      const ground = bot.blockAt(vec(x, Math.floor(base.y) + dy, z));
      if (!ground || ground.boundingBox !== 'block') continue;
      if (/water|lava/.test(ground.name)) continue;
      const above = bot.blockAt(ground.position.offset(0, 1, 0));
      const above2 = bot.blockAt(ground.position.offset(0, 2, 0));
      if (above?.boundingBox === 'empty' && above2?.boundingBox === 'empty') {
        const target = ground.position.offset(0, 1, 0);
        if (target.distanceTo(base) >= 3 && !isNearDanger(target)) return target;
      }
    }
  }
  return null;
}

async function startWander() {
  if (!bot || !bot.entity || wanderActive) return;
  wanderActive = true;
  const token = ++wanderToken;
  const target = pickWanderTarget();
  if (!target) {
    wanderActive = false;
    return;
  }
  log('开始闲逛', `目标 (${target.x}, ${target.y}, ${target.z})`);
  bot.pathfinder.movements.allowSprinting = false;
  const origin = bot.entity.position.clone();
  try {
    const result = await Promise.race([
      bot.pathfinder
        .goto(new goals.GoalNear(target.x, target.y, target.z, 1))
        .then(() => 'ok'),
      sleep(12000).then(() => 'timeout'),
    ]);
    if (token !== wanderToken) return;
    if (result === 'timeout') {
      bot.pathfinder.stop();
      return;
    }
    const yaw = bot.entity.yaw + (Math.random() - 0.5) * 1.4;
    await bot.look(yaw, 0, true);
  } catch {
    // 走不过去就放弃这次闲逛
  } finally {
    if (token === wanderToken) {
      wanderActive = false;
      lastActivity = Date.now();
      if (!followSession) {
        bot.pathfinder.movements.allowSprinting = true;
      }
      if (bot && bot.entity) {
        const position = bot.entity.position;
        log(
          '闲逛结束',
          `走了 ${position.distanceTo(origin).toFixed(1)} 格，位置 (${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)})`
        );
      }
    }
  }
}

function idleTick() {
  if (!bot || !bot.entity || followSession || actionBusy || wanderActive) return;
  if (Date.now() - lastActivity < IDLE_WANDER_MS) return;
  if (bot.health < 10) return;
  const player = nearestPlayer(64);
  if (player && bot.entity.position.distanceTo(player.entity.position) > FAR_DISTANCE) {
    return;
  }
  startWander();
}

function checkPlayerDistance() {
  if (!bot || !bot.entity || followSession) return;
  const player = nearestPlayer(256);
  if (!player) return;
  const distance = bot.entity.position.distanceTo(player.entity.position);
  if (distance < FAR_DISTANCE) return;
  const now = Date.now();
  if (now - lastDistanceAsk < DISTANCE_ASK_COOLDOWN_MS) return;
  if (now - lastPlayerChatAt < 30000) return;
  lastDistanceAsk = now;
  bot.chat('你在哪？可以发一下坐标吗？');
  log('距离玩家较远，已请求坐标', distance.toFixed(1));
}

function findBlockPosition(name, range) {
  const block = bot.registry.blocksByName[name];
  if (!block) throw new Error(`未知方块 ${name}`);
  const positions = bot.findBlocks({
    matching: block.id,
    maxDistance: range,
    count: 1,
  });
  if (positions.length === 0) {
    throw new Error(`附近 ${range} 格内没有 ${blockLabel(name)}`);
  }
  return positions[0];
}

class LiveFollowGoal {
  constructor(entity, range) {
    this.entity = entity;
    this.range = range;
    this.anchor = entity.position.clone();
  }

  heuristic(node) {
    const position = this.entity.position;
    const dx = Math.abs(position.x - node.x);
    const dy = Math.abs(position.y - node.y);
    const dz = Math.abs(position.z - node.z);
    return Math.max(dx, dz) + dy;
  }

  isEnd(node) {
    if (!this.entity) return true;
    return this.entity.position.distanceTo(vec(node.x, node.y, node.z)) <= this.range;
  }

  hasChanged() {
    if (!this.entity) return false;
    const position = this.entity.position;
    if (position.distanceTo(this.anchor) >= 2) {
      this.anchor = position.clone();
      return true;
    }
    return false;
  }

  isValid() {
    return this.entity != null && this.entity.isValid !== false;
  }
}

function startFollow(player, distance) {
  wanderToken += 1;
  wanderActive = false;
  stopFollow();
  followSession = {
    name: player.username,
    distance,
    paused: false,
    sprinting: false,
    lastLook: 0,
    startedAt: Date.now(),
    goal: new LiveFollowGoal(player.entity, distance),
  };
  bot.pathfinder.setGoal(followSession.goal, true);
  tickFollow();
  followTimer = setInterval(tickFollow, 250);
}

function tickFollow() {
  const session = followSession;
  if (!bot || !bot.entity || !session) return;
  if (Date.now() - session.startedAt > 5 * 60 * 1000) {
    log('跟随超时，自动停止');
    stopFollow();
    return;
  }
  const entity = bot.players[session.name] && bot.players[session.name].entity;
  if (!entity) {
    stopFollow();
    return;
  }
  const gap = bot.entity.position.distanceTo(entity.position);
  const pauseAt = session.distance + 0.2;
  const resumeAt = session.distance + 1.2;
  if (!session.paused && gap <= pauseAt) {
    session.paused = true;
    bot.pathfinder.setGoal(null);
    bot.pathfinder.stop();
    bot.setControlState('sprint', false);
  } else if (session.paused && gap > resumeAt) {
    session.paused = false;
    session.goal = new LiveFollowGoal(entity, session.distance);
    bot.pathfinder.setGoal(session.goal, true);
  }
  if (!session.paused) {
    const sprintOn = session.distance + 8;
    const sprintOff = session.distance + 4;
    let sprint = session.sprinting;
    if (!sprint && gap > sprintOn) sprint = true;
    else if (sprint && gap < sprintOff) sprint = false;
    if (sprint !== session.sprinting) {
      session.sprinting = sprint;
      bot.pathfinder.movements.allowSprinting = sprint;
      log(sprint ? '距离较远，开始小跑' : '距离拉近，改为走路', gap.toFixed(1));
      session.goal = new LiveFollowGoal(entity, session.distance);
    bot.pathfinder.setGoal(session.goal, true);
    }
  } else {
    const now = Date.now();
    if (now - session.lastLook > 1200) {
      session.lastLook = now;
      bot.lookAt(entity.position.offset(0, 1.6, 0), true).catch(() => {});
    }
  }
}

function stopFollow() {
  if (followSession) {
    log('已停止跟随', followSession.name);
  }
  if (followTimer) {
    clearInterval(followTimer);
    followTimer = null;
  }
  followSession = null;
  if (bot) {
    bot.pathfinder.setGoal(null);
    bot.pathfinder.stop();
    bot.pathfinder.movements.allowSprinting = true;
    bot.setControlState('sprint', false);
    bot.clearControlStates();
  }
}

const STOP_INTENT = /(别跟|不要跟|不用跟|别再跟|别过来|不用过来|停下|站住|停住)/;

function isStopIntent(text) {
  return STOP_INTENT.test(String(text || ''));
}

function createBot() {
  bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    auth: config.auth,
    version: config.version || undefined,
  });
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(armorManager);
  bot.loadPlugin(toolModule.plugin || toolModule);

  bot.once('spawn', () => {
    log('已进入世界');
    const movements = new Movements(bot);
    movements.canDig = true;
    movements.allow1by1towers = true;
    movements.allowParkour = true;
    movements.allowSprinting = true;
    movements.canOpenDoors = true;
    movements.maxDropDown = 4;
    movements.liquidCost = 12;
    movements.infiniteLiquidDropdownDistance = false;
    const avoidBlocks = [
      'cactus',
      'magma_block',
      'sweet_berry_bush',
      'powder_snow',
      'wither_rose',
      'campfire',
    ];
    for (const name of avoidBlocks) {
      const block = bot.registry.blocksByName[name];
      if (block) movements.blocksToAvoid.add(block.id);
    }
    const scaffold = ['dirt', 'cobblestone']
      .map((name) => bot.registry.itemsByName[name]?.id)
      .filter((id) => id !== undefined);
    if (scaffold.length > 0) {
      movements.scafoldingBlocks = scaffold;
    }
    bot.pathfinder.setMovements(movements);
    if (bot.armorManager) {
      bot.armorManager.equipAll().catch((error) => log('穿装备失败', error.message));
    }
    setInterval(() => {
      if (bot.armorManager) {
        bot.armorManager.equipAll().catch(() => {});
      }
    }, 15000);
    setInterval(sendState, 5000);
    sendState();
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    lastActivity = Date.now();
    lastPlayerChatAt = Date.now();
    lastDistanceAsk = 0;
    if (wanderActive) {
      wanderToken += 1;
      wanderActive = false;
      bot.pathfinder.stop();
    }
    if (followSession && isStopIntent(message)) {
      log('收到停止跟随指令', username, message);
      stopFollow();
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'chat', player: username, text: message }));
  });

  bot.on('entityHurt', (entity, source) => {
    if (!bot.entity || !entity || entity.id !== bot.entity.id) return;
    onDamaged(source);
  });

  bot.on('health', () => {
    if (bot.health <= 0) {
      lastHealth = 0;
      return;
    }
    if (lastHealth === null) {
      lastHealth = bot.health;
      return;
    }
    if (bot.health < lastHealth - 0.5) {
      setTimeout(() => {
        if (Date.now() - lastHurtAt > 500) onDamaged(null);
      }, 300);
    }
    lastHealth = bot.health;
  });

  bot.on('death', () => {
    log('死亡，等待重生');
    lastHealth = 20;
    stopFollow();
    wanderToken += 1;
    wanderActive = false;
  });

  bot.on('error', (error) => log('mineflayer 错误', error.message));
  bot.on('kicked', (reason) => log('被服务器踢出', reason));
  bot.on('end', () => {
    log('与 Minecraft 的连接结束，5 秒后重连');
    stopFollow();
    setTimeout(createBot, 5000);
  });
}

function sendState() {
  if (!bot || !bot.entity) return;
  checkPlayerDistance();
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const position = bot.entity.position;
  const players = Object.values(bot.players)
    .filter((player) => player.username !== bot.username && player.entity)
    .map((player) => ({
      name: player.username,
      position: {
        x: player.entity.position.x,
        y: player.entity.position.y,
        z: player.entity.position.z,
      },
      distance: player.entity.position.distanceTo(position),
    }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 8);
  socket.send(
    JSON.stringify({
      type: 'state',
      data: {
        position: { x: position.x, y: position.y, z: position.z },
        yaw: bot.entity.yaw,
        pitch: bot.entity.pitch,
        health: bot.health,
        food: bot.food,
        dimension: bot.game.dimension,
        time: bot.time.timeOfDay,
        day: bot.time.day,
        is_day: bot.time.isDay,
        weather:
          bot.thunderState > 0 ? 'thunder' : bot.rainState > 0 ? 'rain' : 'clear',
        players,
      },
    })
  );
}

connectCore();
createBot();
setInterval(idleTick, 1000);
setInterval(survivalTick, 1000);
setInterval(waterTick, 500);

process.on('SIGINT', () => {
  log('收到退出信号');
  if (bot) bot.quit();
  if (socket) socket.close();
  process.exit(0);
});
