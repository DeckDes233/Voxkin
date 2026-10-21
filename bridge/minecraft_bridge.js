// 沃心 Minecraft 桥接进程：mineflayer 负责游戏内身份，WebSocket 负责与 Voxkin Core 通信。
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import WebSocket from 'ws';

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
};

function blockLabel(name) {
  return BLOCK_NAMES[name] || name;
}

let socket = null;
let bot = null;
let reconnectTimer = null;
let actionChain = Promise.resolve();

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

function enqueueAction(message) {
  actionChain = actionChain.then(() => runAction(message)).catch((error) => {
    log('动作队列异常', error.message);
  });
}

async function runAction(message) {
  if (!bot || !bot.entity) {
    reply(message, false, 'bot 尚未进入世界');
    return;
  }
  const args = message.arguments || {};
  try {
    let detail = '';
    switch (message.tool) {
      case 'chat':
        bot.chat(String(args.text || ''));
        detail = '已发送聊天消息';
        break;
      case 'stop':
        bot.pathfinder.stop();
        bot.clearControlStates();
        detail = '已停止移动';
        break;
      case 'goto':
        detail = await goTo(Number(args.x), Number(args.y), Number(args.z));
        break;
      case 'collect_blocks':
        detail = await collectBlocks(String(args.block), Number(args.count || 1));
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

async function goTo(x, y, z) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    throw new Error('坐标无效');
  }
  const goal = new goals.GoalNear(x, y, z, 2);
  await bot.pathfinder.goto(goal);
  const distance = bot.entity.position.distanceTo({ x, y, z });
  return `已到达 (${x}, ${y}, ${z}) 附近，距离 ${distance.toFixed(1)} 格`;
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
    const block = bot.blockAt(position);
    if (!block) continue;
    await bot.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, 1));
    if (bot.canDigBlock(block)) {
      await bot.dig(block);
      collected += 1;
    }
    if (collected >= count) break;
  }
  if (collected === 0) throw new Error(`没有成功挖到 ${blockLabel(blockName)}`);
  return `挖到 ${collected} 个 ${blockLabel(blockName)}`;
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

  bot.once('spawn', () => {
    log('已进入世界');
    bot.pathfinder.setMovements(new Movements(bot));
    setInterval(sendState, 5000);
    sendState();
  });

  bot.on('chat', (username, message) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (username === bot.username) return;
    socket.send(JSON.stringify({ type: 'chat', player: username, text: message }));
  });

  bot.on('error', (error) => log('mineflayer 错误', error.message));
  bot.on('kicked', (reason) => log('被服务器踢出', reason));
  bot.on('end', () => {
    log('与 Minecraft 的连接结束，5 秒后重连');
    setTimeout(createBot, 5000);
  });
}

function sendState() {
  if (!socket || socket.readyState !== WebSocket.OPEN || !bot.entity) return;
  socket.send(
    JSON.stringify({
      type: 'state',
      data: {
        position: bot.entity.position,
        health: bot.health,
        food: bot.food,
        dimension: bot.game.dimension,
        time: bot.time.timeOfDay,
      },
    })
  );
}

connectCore();
createBot();

process.on('SIGINT', () => {
  log('收到退出信号');
  if (bot) bot.quit();
  if (socket) socket.close();
  process.exit(0);
});
