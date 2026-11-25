import { escapeWater, reachShore, waterLike, breathable, avoidWaterScaffolding, allowedDuringWaterEscape } from './water_escape.js';
import { besideDrop, dryMiningFooting, leaveMagmaBlock, miningRouteExclusion, netherRouteExclusion, returnToNetherWaypoint, withDryGroundMovement } from './dry_footing.js';
import { crystalAimPoint } from './skills/combat.js';
import { FUEL_BURN, selectFuel } from './fuel.js';
// 沃心 Minecraft 桥接进程：mineflayer 负责游戏内身份，WebSocket 负责与 Voxkin Core 通信。
// 部分动作与自主行为参考 MindCraft（MIT，https://github.com/mindcraft-bots/mindcraft）。
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import mineflayer from 'mineflayer';
import { applyProtocol767ItemFormat } from './protocol_767.js';
import { correctMiningMaterials } from './mining_materials.js';
import pathfinderPkg from 'mineflayer-pathfinder';
import WebSocket from 'ws';
import { Vec3 } from 'vec3';
import armorManager from 'mineflayer-armor-manager';
import toolModule from 'mineflayer-tool';
import { loadSkills } from './skills/registry.js';
import { timeAdvanced } from './skills/survival.js';
import { createSkillInvoker } from './skill_invoker.js';
import { ExecutionController } from './execution_controller.js';
import { LocalReflexScheduler, canRunLocalSafety, shouldInterruptForHunger } from './local_reflex.js';
import { buildActionResult, mergeActionErrorData, validateActionState } from './action_response.js';
import { createObservation } from './world_observation.js';
import { HUNTABLE, nearbyFoodAnimal } from './skills/combat.js';
import { inspectResourceSites } from './resource_sites.js';
import { syncWindowWithLease, writeWindowClickWithLease } from './window_sync.js';
import { placeBedAt } from './bed_placement.js';
import { installArmorManagerApi } from './armor_manager.js';
import { cleanupCraftWindowForSafety, craftReturnSlot, isUrgentSafetyPreemption } from './craft_window_cleanup.js';
import { createRetreatTrail, retreatAlongTrail } from './retreat_route.js';
import { retainTemporaryTable, shouldRecoverTemporaryTable, ownedTableNearby } from './workstation_lifecycle.js';
import { pickCraftingRecipe } from './recipe_selection.js';
import { approachEntity } from './entity_approach.js';
import { stopPathfinderAndClearGoal, gotoWithTimeout } from './pathfinder_control.js';
import { BLOCK_NAMES } from './skills/labels.js';
import { dryStationAlcove, inspectSupportedPlacementTargets } from './placement.js';
import { inspectPositionTerrain } from './world_readiness.js';
import { installBridgeSessionLifecycle } from './session_lifecycle.js';
import {
  assessCombatEncounter,
  bestMeleeWeapon,
  chooseRetreatDestination,
  combatEquipment,
  creeperBehindRock,
  evaluateEncounterStep,
  HOSTILE_MOBS,
  isAutomaticCombatTarget,
  magmaCubeBehindCover,
  retreatSafetyScore,
  zombieBehindFloor,
} from './combat_encounter.js';
import {
  acknowledgeLifecycleEvent as removeLifecycleEvent,
  closeWindowAndSyncInventory,
  inventoryItemType,
  queueLifecycleEvent as storeLifecycleEvent,
  rejectBlockedAction,
  worldHealthSnapshot,
} from './action_lifecycle.js';

const { pathfinder, Movements, goals } = pathfinderPkg;

// 技能模块注册表：bridge/skills/ 下每个模块导出的 skills 会合并到这里。
const skillRegistry = await loadSkills();

const config = {
  host: process.env.MC_HOST || '127.0.0.1',
  port: Number(process.env.MC_PORT || 25565),
  version: process.env.MC_VERSION || false,
  username: process.env.MC_USERNAME || 'Voxkin',
  auth: process.env.MC_AUTH || 'offline',
  ws: process.env.VOXKIN_WS || 'ws://127.0.0.1:8765/ws/bridge',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function blockLabel(name) {
  return BLOCK_NAMES[name] || name;
}

const ITEM_SUFFIX_LABELS = [
  ['_helmet', '头盔'],
  ['_chestplate', '胸甲'],
  ['_leggings', '护腿'],
  ['_boots', '靴子'],
  ['_sword', '剑'],
  ['_pickaxe', '镐'],
  ['_shovel', '锹'],
  ['_axe', '斧'],
];

const MATERIAL_LABELS = {
  wooden: '木',
  stone: '石',
  iron: '铁',
  golden: '金',
  diamond: '钻石',
  netherite: '下界合金',
  leather: '皮革',
  chainmail: '锁链',
  turtle: '海龟',
};

const ITEM_NAMES = {
  bread: '面包',
  apple: '苹果',
  golden_apple: '金苹果',
  enchanted_golden_apple: '附魔金苹果',
  golden_carrot: '金胡萝卜',
  carrot: '胡萝卜',
  baked_potato: '烤土豆',
  potato: '土豆',
  cooked_beef: '熟牛肉',
  beef: '生牛肉',
  cooked_porkchop: '熟猪排',
  porkchop: '生猪排',
  cooked_chicken: '熟鸡肉',
  chicken: '生鸡肉',
  cooked_mutton: '熟羊肉',
  mutton: '生羊肉',
  cooked_cod: '熟鳕鱼',
  cod: '生鳕鱼',
  cooked_salmon: '熟鲑鱼',
  salmon: '生鲑鱼',
  cookie: '曲奇',
  melon_slice: '西瓜片',
  sweet_berries: '甜浆果',
  glow_berries: '发光浆果',
  dried_kelp: '干海带',
  pumpkin_pie: '南瓜派',
  mushroom_stew: '蘑菇煲',
  beetroot_soup: '甜菜汤',
  rabbit_stew: '兔肉煲',
  rotten_flesh: '腐肉',
  spider_eye: '蜘蛛眼',
  chorus_fruit: '紫颂果',
  honey_bottle: '蜂蜜瓶',
};

function itemLabel(name) {
  const text = String(name || '');
  const base = blockLabel(text);
  if (base !== text) return base;
  if (ITEM_NAMES[text]) return ITEM_NAMES[text];
  for (const [suffix, label] of ITEM_SUFFIX_LABELS) {
    if (!text.endsWith(suffix)) continue;
    const material = MATERIAL_LABELS[text.slice(0, -suffix.length)];
    if (material) return `${material}${label}`;
  }
  return text;
}

// 技能清单是技能元数据的唯一事实来源：默认优先级与能不能被抢占都从这里推导。
const SKILL_MANIFEST = JSON.parse(
  fs.readFileSync(new URL('./skills/manifest.json', import.meta.url), 'utf8')
);

const SKILL_META = new Map(
  SKILL_MANIFEST.skills.map((skill) => [
    skill.skill_id,
    { type: skill.type, cancellable: skill.cancellable === true },
  ])
);

// 避险技能：低血量、水中困住、下落、离开庇护所等场景下必须先跑。
const SAFETY_REFLEX_SKILLS = new Set([
  'flee_low_health',
  'swim_escape',
  'safe_descend',
  'leave_shelter',
  'parkour_safe',
  'safe_travel',
  'sleep_safe',
]);

const FINAL_ACTION_STATUSES = new Set([
  'succeeded',
  'partial',
  'failed',
  'cancelled',
  'preempted',
  'dead',
  'disconnected',
  'blocked',
  'unknown',
]);

// 动作的中文名，用于进度回报。
const ACTION_LABELS = {
  observe: '观察周围',
  inventory: '查看背包',
  locate_block: '查找方块',
  locate_entity: '查找实体',
  look_at_player: '看向玩家',
  goto: '前往坐标',
  goto_block: '前往方块',
  follow_player: '跟随玩家',
  come_to_player: '走到玩家身边',
  stop: '停止当前动作',
  eat: '进食',
  attack_nearest: '按威胁攻击敌人',
  attack_target: '攻击指定目标',
  collect_blocks: '采集方块',
  break_block: '破坏方块',
  place_block: '放置方块',
  pickup_items: '拾取物品',
  craft: '合成物品',
  smelt: '熔炼物品',
  sleep: '睡觉',
  chat: '发送聊天',
  activate_end_portal: '激活末地传送门',
  break_crystal: '破坏末影水晶',
  checkpoint_stock: '盘点物资储备',
  collect_blaze_rods: '收集烈焰棒',
  craft_bed: '合成床',
  craft_tool_set: '合成工具套装',
  craft_torch: '合成火把',
  deep_mine: '深层采矿',
  eat_if_hungry: '饥饿时进食',
  equip_shield: '装备盾牌',
  fight_blaze: '战斗烈焰人',
  fight_dragon: '战斗末影龙',
  find_diamond: '寻找钻石',
  flee_low_health: '低血量逃生',
  hunt_animal: '狩猎动物',
  hunt_enderman: '狩猎末影人',
  harvest_iron_golem: '搭柱击打铁傀儡取铁',
  loot_village: '收集村庄物资',
  leave_shelter: '离开庇护所',
  list_chest: '列出箱子内容',
  make_nether_portal: '建造下界传送门',
  make_shelter: '建造庇护所',
  mine_collect: '采矿并收集',
  nether_travel: '前往下界',
  parkour_safe: '安全跑酷',
  raid_fortress: '突袭堡垒',
  return_home: '返回据点',
  safe_descend: '安全下降',
  safe_travel: '安全行进',
  sleep_safe: '安全睡眠',
  smelt_batch: '批量熔炼',
  store_items: '存入箱子',
  strip_mine: '挖矿道采集',
  swim_escape: '水中脱困',
  swim_out: '游出水面',
  throw_eye: '投掷末影之眼',
  wait_for_day: '等待天亮',
  withdraw_items: '从箱子取出物资',
};

let socket = null;
let bot = null;
let reconnectTimer = null;
let botReconnectTimer = null;
let deathPending = false;
let respawnReady = false;
let actionBlockStatus = '';
const pendingLifecycleEvents = [];
let botReady = false;
let terrainReady = false;
let terrainReadinessGeneration = 0;
let deathLifecycleId = '';
let currentTool = '';
let currentActionId = '';
let currentGoalId = '';
let temporaryCraftingTable = null;
const retreatTrail = createRetreatTrail();
let interrupted = false;
let followSession = null;
let actionBusy = false;
let lastActivity = Date.now();
let lastPlayerChatAt = 0;
let lastDistanceAsk = 0;
let wanderActive = false;
let combatBusy = false;
let lastCombatAt = 0;
let retreatActive = false;
let lastEatAt = 0;
let lastHurtAt = 0;
let lastHealth = null;
let escapeBusy = false;
let lastCreeperWarnAt = 0;
let wanderActionId = '';
let armorTimer = null;
let sessionId = randomUUID();
let stateRevision = 0;
let rememberedShelter = null;
const reflexSentAt = new Map();

const executor = new ExecutionController({
  onChange: ({ reason } = {}) => {
    if (reason === 'started' && executor.active) {
      interrupted = false;
      currentTool = executor.active.tool || '';
      currentActionId = executor.active.id;
    } else if (reason === 'finished') {
      interrupted = false;
      currentTool = '';
      currentActionId = '';
    }
    sendState();
    if (reason === 'finished') finishRespawnIfIdle();
  },
  ledgerLimit: 256,
});
const actionQueue = executor.queue;
const reflexScheduler = new LocalReflexScheduler({
  executor,
  isReady: () => canRunLocalSafety({
    botPresent: Boolean(bot?.entity),
    botReady,
    health: bot?.health,
    deathPending,
    respawnReady,
  }),
  idFactory: (event) => `reflex-${event}-${randomUUID()}`,
  onCancel: (reason, status, token) => cancelActiveWorldWork(reason, status, token),
  run: async (event, data, token) => {
    try {
      await runLocalSafety(event, data, token);
      return { status: 'succeeded', detail: `本地安全策略完成：${event}`, data: { event } };
    } catch (error) {
      return { status: token.cancelled ? token.cancelStatus : 'partial', detail: error.message, data: { event } };
    }
  },
});

const IDLE_WANDER_MS = 20000;
const FAR_DISTANCE = Number(process.env.VOXKIN_FAR_DISTANCE || 128);
const DISTANCE_ASK_COOLDOWN_MS = 180000;
const INDEPENDENT = process.env.VOXKIN_INDEPENDENT === '1';

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
    } else if (message.type === 'action_cancel') {
      handleActionCancel(message);
    } else if (message.type === 'action_status') {
      sendActionStatus(message.action_id);
    } else if (message.type === 'state_request') {
      rememberRequestedShelter(message.shelter);
      sendState();
    } else if (message.type === 'lifecycle_ack') {
      acknowledgeLifecycleEvent(message);
    } else if (message.type === 'welcome') {
      log('Core 握手完成', message.name);
      flushLifecycleEvents();
      finishRespawnIfIdle();
      unblockExecutorIfReady();
      sendState();
    } else if (message.type === 'error') {
      log('Core 返回错误', message.error);
    }
  });

  socket.on('close', () => {
    log('与 Core 的连接断开，3 秒后重连');
    actionBlockStatus = 'disconnected';
    executor.block('disconnected', 'Core connection lost');
    stopResidentMovement();
    socket = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectCore, 3000);
  });

  socket.on('error', (error) => {
    log('Core 连接错误', error.message);
  });
}

// 技能的默认优先级：避险技能最高，其次是 stop，只读与语音最低，其余是普通任务。
function defaultPriority(tool) {
  if (tool === 'stop') return 1;
  if (SAFETY_REFLEX_SKILLS.has(tool)) return 0;
  const meta = SKILL_META.get(tool);
  if (meta && (meta.type === 'sense' || meta.type === 'voice')) return 5;
  return 3;
}

// Core 传来的 priority 是权威值；老消息没有这个字段时回落到清单推导的默认值。
function actionPriority(message) {
  const raw = message.priority;
  if (raw === undefined || raw === null) return defaultPriority(message.tool);
  const value = Number(raw);
  return Number.isFinite(value) ? value : defaultPriority(message.tool);
}

function metaForAction(message) {
  return SKILL_META.get(message.tool) || SKILL_META.get(message.skill_id || '');
}

// 只读与语音类技能没有进度概念，不发进度消息。
function progressEnabled(tool) {
  const meta = SKILL_META.get(tool);
  if (!meta) return false;
  return meta.type !== 'sense' && meta.type !== 'voice';
}

function actionLabel(tool) {
  return ACTION_LABELS[tool] || tool;
}

function sendProgress(message, phase, detail, progress, data = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const value = Math.min(Math.max(Number(progress) || 0, 0), 1);
  if (executor.active?.id === message.action_id) {
    executor.active.token.phase = phase;
    executor.active.token.progress = value;
    executor.active.token.progressData = { ...data, phase, progress: value };
  }
  socket.send(
    JSON.stringify({
      type: 'action_progress',
      action_id: message.action_id,
      skill_id: message.skill_id || message.tool,
      phase,
      detail: String(detail).slice(0, 200),
      progress: value,
      session_id: sessionId,
      state_revision: stateRevision,
      executor_epoch: executor.epoch,
      data,
    })
  );
}

// 处理 Core 的取消请求：可以按 action_id 取消单个动作，也可以清空整个队列。
function handleActionCancel(message) {
  const reason = String(message.reason || '收到取消请求');
  const actionId = String(message.action_id || '');
  const requestedStatus = ['cancelled', 'preempted'].includes(message.interrupt_status)
    ? message.interrupt_status
    : 'cancelled';
  if (message.scope === 'all') {
    stopResidentMovement();
    const dropped = executor.stop(reason, requestedStatus);
    log('清空动作队列', dropped, reason);
    return;
  }
  if (!actionId) {
    log('取消请求缺少 action_id，忽略');
    return;
  }
  if (executor.cancel(actionId, reason, requestedStatus)) return;
  log('取消请求没有匹配的动作', actionId, '当前', currentActionId);
}

function enqueueAction(message) {
  if (message.action_id && executor.status(message.action_id)) {
    sendActionStatus(message.action_id);
    return;
  }
  if (message.tool === 'stop') {
    stopResidentMovement();
    executor.stop('收到停止指令');
    enqueueActionTask(message);
    return;
  }
  if (rejectBlockedAction(actionBlockStatus, message, reply)) return;
  const read = worldReaderFor(message);
  const validation = validateActionState(message, {
    sessionId,
    revision: stateRevision,
    readLatest: Boolean(read),
    ready: ordinaryActionReady(allowedDuringWaterEscape(message.tool)),
    reason: !botReady || !bot?.entity
      ? 'Minecraft 世界尚未完成生命周期确认'
      : executor.safetyActive
        ? '本地安全动作正在执行，普通动作暂不接收'
        : 'Bridge 尚未准备好接收普通动作',
  });
  if (validation) {
    reply(message, false, validation.detail, validation.status, validation.data);
    return;
  }
  if (read) {
    message.action_id ||= `action-${randomUUID()}`;
    const result = executor.read(message.action_id, message.tool, () => read(message.arguments || {}), statusForError);
    reply(message, result.status === 'succeeded', result.detail, result.status);
    return;
  }
  stopResidentMovement();
  enqueueActionTask(message);
}

function worldReaderFor(message) {
  switch (message.tool) {
    case 'inventory': return readInventory;
    case 'locate_block': return locateBlock;
    case 'locate_entity': return locateEntity;
    // 带庇护所参数的观察会写入记忆，交给独占执行器处理。
    case 'observe': return message.arguments?.shelter || message.arguments?.shelter_position ? null : observeSurroundings;
    default: return null;
  }
}

function readInventory() {
  const items = bot.inventory.items().filter(item => item.slot !== 45);
  const labels = items.map(item => `${blockLabel(item.name)} x${item.count}`);
  const offHand = bot.inventory.slots?.[45];
  if (offHand) labels.unshift(`副手 ${blockLabel(offHand.name)} x${offHand.count}`);
  return labels.length ? labels.join('、').slice(0, 400) : '背包是空的';
}

function enqueueActionTask(message) {
  const actionId = String(message.action_id || `action-${randomUUID()}`);
  message.action_id = actionId;
  const result = executor.enqueue({
    id: actionId,
    tool: message.tool,
    priority: actionPriority(message),
    kind: SAFETY_REFLEX_SKILLS.has(message.tool) ? 'safety' : 'action',
    cancellable: metaForAction(message)?.cancellable !== false,
    deadlineAt: Date.now() + Math.min(Math.max(Number(message.timeout_s) || 120, 5), 300) * 1000,
    onCancel: (reason, status, token) => cancelActiveWorldWork(reason, status, token),
    run: (token) => runAction(message, token),
    onResult: (outcome) => reply(
      message,
      outcome.status === 'succeeded',
      outcome.detail || '',
      outcome.status,
      outcome.data || {},
    ),
  });
  if (result.duplicate) {
    sendActionStatus(actionId);
    return false;
  }
  if (!result.accepted) {
    reply(message, false, result.record.detail || result.record.status, result.record.status);
    return false;
  }
  return true;
}

function sendActionStatus(actionId) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const record = executor.status(actionId);
  const status = record?.status || 'unknown';
  socket.send(JSON.stringify({
    type: 'action_status_result',
    action_id: String(actionId || ''),
    status,
    detail: record?.detail || '',
    data: record?.data ? { ...record.data } : {},
  }));
}

// 技能模块上下文：把桥接内部已有的能力按稳定接口暴露出去。
// 每次动作都重新构造，保证 bot 重连后拿到的是最新实例。
function buildSkillContext(runSkill, token = null, actionMessage = null) {
  return {
    bot,
    log,
    sleep,
    blockLabel,
    itemLabel,
    travelTo,
    travelToBlock,
    walkOnce,
    exploreResource,
    collectDrops,
    nearbyHostiles,
    countItem,
    syncInventory: (window) => syncInventory(window, token),
    syncWindow: (window, timeoutMs) => syncWindow(window, timeoutMs, token),
    nearbyBlock,
    equipToolFor,
    equipWeapon,
    breakBlock,
    placeBlock,
    placeBlockWithFacing,
    placeBedAt: (target, name) => placeBedAt(bot, target, name, {
      createVector: (x, y, z) => vec(x, y, z),
      wait: sleep,
      moveTo: ({ x, y, z }) => travelTo(x + 0.5, y, z + 0.5, 0),
      token,
    }),
    pickupItems,
    placeInventoryBlock,
    placeCraftingTable,
    recoverPlacedTable,
    clickWindowSlot: (window, slot, mouseButton, mode) => clickWindowSlot(window, slot, mouseButton, mode, token),
    craftWithWindow: (recipe, window, width, height, times) => craftWithWindow(recipe, window, width, height, times, token),
    pickRecipe,
    materialsShortage,
    recipeRequirements,
    missingMaterials,
    findFuelItem,
    craftItem: (args) => craftItem(args, token),
    smeltItem: (args) => smeltItem(args, token),
    findFoodForEating,
    findFood,
    eatFood,
    findNearbyBed,
    sleepInBed,
    isSleepTime,
    isThunderstorm,
    sleepErrorText,
    sleepAdvancedTime,
    approach,
    retreatFrom,
    attackEntity,
    defendAgainst,
    findRangedWeapon,
    aimPoint,
    shootAt,
    evadeDragon: dragon => evadeDragonHazard(dragon, token, () => dragon.isValid !== false
      && bot.entity.position.distanceTo(dragon.position) < 16),
    nearbyPlayers,
    nearbyHostiles,
    entityMatches,
    entityDisplayName,
    entityTypeLabel,
    playerNameOf,
    findHostile,
    findAttackTarget,
    resolvePlayer,
    isNearDanger,
    escapeEnvironment,
    blockIsWater,
    swimToShore: (reason, timeoutMs, radius, connected) => swimToShore(reason, token, timeoutMs, radius, connected),
    describeEntity,
    runSkill,
    reportProgress(phase, detail, progress, data = {}) {
      if (token) token.progressData = { ...data, phase, progress };
      if (actionMessage) sendProgress(actionMessage, phase, detail, progress, data);
    },
    rememberShelter(shelter) {
      return rememberRequestedShelter(shelter);
    },
    getRememberedShelter() {
      return rememberedShelter?.dimension === String(bot.game?.dimension || '') ? rememberedShelter : null;
    },
    getResourceSites() {
      const shelter = rememberedShelter?.dimension === String(bot.game?.dimension || '') ? rememberedShelter : null;
      return inspectResourceSites(bot, shelter);
    },
    INDEPENDENT,
    get interrupted() {
      return Boolean(token?.cancelled || interrupted);
    },
    get actionToken() {
      return token;
    },
    get registry() {
      return bot.registry;
    },
  };
}

async function runAction(message, token) {
  if (waterEscapeRequired && !allowedDuringWaterEscape(message.tool)) {
    return { status: 'blocked', detail: '水中呼吸尚未恢复，普通动作暂不执行' };
  }
  if (!bot || !bot.entity) {
    return { status: actionBlockStatus || 'blocked', detail: 'bot 尚未进入世界' };
  }
  if (message.tool !== 'follow_player' && bot.pathfinder) {
    stopPathfinding();
  }
  const args = message.arguments || {};
  token.seekingEmergencyFood = message.tool === 'hunt_animal' && args.nearby_only === true;
  token.leavingMiningThreat = message.tool === 'explore_mining_site' && args.covered_escape === true;
  interrupted = false;
  currentTool = message.tool;
  currentActionId = message.action_id || '';
  currentGoalId = String(message.goal_id || '');
  actionBusy = true;
  lastActivity = Date.now();
  const timeoutMs = Math.min(Math.max(Number(message.timeout_s) || 120, 5), 300) * 1000;
  const deadline = setTimeout(() => {
    log('动作超时', message.tool, `${Math.round(timeoutMs / 1000)}s`);
    executor.cancel(message.action_id, `动作超时（${Math.round(timeoutMs / 1000)}s）`, 'failed');
  }, timeoutMs);
  if (progressEnabled(message.tool)) {
    sendProgress(message, 'running', `开始执行 ${actionLabel(message.tool)}`, 0);
  }
  let outcomeStatus = 'succeeded';
  let outcomeData = {};
  let outcomeDetail = '';
  let result = null;
  try {
    if (temporaryCraftingTable && shouldRecoverTemporaryTable(message.tool) && !token?.cancelled) {
      const ownedTable = ownedTableNearby(bot, temporaryCraftingTable);
      if (ownedTable) {
        await recoverPlacedTable(ownedTable);
        if (token?.cancelled) throw new Error(token.cancelReason || '动作已取消');
        if (bot.blockAt(temporaryCraftingTable.position)?.name !== 'crafting_table') temporaryCraftingTable = null;
      }
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
        if (INDEPENDENT) throw new Error('独立模式不跟随玩家');
        const player = resolvePlayer(args.player);
        const distance = Math.min(Math.max(Number(args.distance) || 2, 1), 6);
        await runFollow(player, distance, token);
        detail = `已停止跟随 ${player.username}`;
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
      case 'observe':
        if (args.shelter) rememberRequestedShelter(args.shelter);
        if (args.shelter_position) {
          rememberRequestedShelter({ position: args.shelter_position, size: args.shelter_size });
        }
        detail = observeSurroundings(args);
        break;
      case 'eat':
        detail = await eatFood(args);
        break;
      case 'attack_nearest': {
        const range = Math.min(Math.max(Number(args.range) || 16, 3), 32);
        const target = findHostile(range);
        if (!target) throw new Error(`附近 ${range} 格内没有敌对生物`);
        detail = await attackEntity(target, { allowTargetSwitch: true, encounterRadius: Math.max(16, range) });
        break;
      }
      case 'attack_target': {
        const target = findAttackTarget(args);
        if (!target) throw new Error('没有找到符合条件的实体');
        if (target.type === 'player') throw new Error('不攻击玩家');
        detail = await attackEntity(target);
        break;
      }
      case 'goto':
        if (args.nether_safe === true) {
          detail = await returnToNetherWaypoint(buildSkillContext(null, token, message), vec(args.x, args.y, args.z));
        } else {
          const walk = () => goTo(Number(args.x), Number(args.y), Number(args.z));
          detail = args.dry_only === true ? await withDryGroundMovement(bot, walk, true) : await walk();
        }
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
      case 'craft':
        detail = await craftItem(args);
        break;
      case 'smelt':
        detail = await smeltItem(args);
        break;
      case 'look_at_player': {
        const player = bot.players[args.player];
        if (!player || !player.entity) throw new Error(`找不到玩家 ${args.player}`);
        await bot.lookAt(player.entity.position.offset(0, 1.6, 0), true);
        detail = '已看向玩家';
        break;
      }
      case 'sleep': {
        const result = await sleepInBed();
        detail = result.detail;
        break;
      }
      case 'collect_blocks':
      default: {
        const skillId = message.tool === 'collect_blocks' ? 'mine_collect' : message.tool;
        const skill = skillRegistry[skillId];
        if (!skill) throw new Error(`未知动作 ${message.tool}`);
        const skillInvoker = createSkillInvoker(
          skillRegistry,
          (runSkill) => buildSkillContext(runSkill, token, message),
          [skillId],
        );
        const outcome = await skill.handler(args, skillInvoker.context);
        detail = outcome && outcome.detail ? outcome.detail : '已完成';
        const reportedStatus = outcome && outcome.status ? outcome.status : 'succeeded';
        outcomeData = outcome && outcome.data && typeof outcome.data === 'object'
          ? outcome.data
          : {};
        outcomeData = { ...(token.progressData || {}), ...outcomeData };
        if (outcomeData.shelter) rememberRequestedShelter(outcomeData.shelter);
        outcomeStatus = FINAL_ACTION_STATUSES.has(reportedStatus)
          ? reportedStatus
          : 'failed';
        break;
      }
    }
    outcomeDetail = detail;
    result = { status: outcomeStatus, detail: outcomeDetail, data: outcomeData };
  } catch (error) {
    result = {
      status: statusForError(error),
      detail: error.message || String(error),
      data: mergeActionErrorData(error, token.progressData || {}, outcomeData),
    };
  } finally {
    clearTimeout(deadline);
    actionBusy = false;
    currentTool = '';
    currentActionId = '';
    currentGoalId = '';
    interrupted = false;
    lastActivity = Date.now();
    finishRespawnIfIdle();
  }
  return result || { status: 'failed', detail: '动作未返回结果', data: outcomeData };
}

function finishRespawnIfIdle() {
  if (!deathPending || !respawnReady || !terrainReady || executor.active || !bot?.entity) return;
  if (!queueLifecycleEvent('respawn')) return;
  deathPending = false;
  respawnReady = false;
}

// 把异常映射成结构化状态：取消、部分完成、被环境阻塞、失败。
function statusForError(error) {
  const text = String((error && error.message) || error || '');
  if (['UNKNOWN_WINDOW_STATE', 'UNKNOWN_TERRAIN'].includes(error?.code)) return 'unknown';
  if (text.includes('还差') || text.includes('只拿到')) return 'partial';
  if (text.includes('断开') || text.includes('连接结束')) return 'disconnected';
  if (text.includes('打断') || text.includes('取消')) return 'cancelled';
  if (text.includes('没有') || text.includes('材料不够')) return 'blocked';
  return 'failed';
}

function reply(message, ok, detail, status, data = {}) {
  const finalStatus = status || (ok ? 'succeeded' : 'failed');
  const observation = buildStateObservation();
  const payload = buildActionResult(message, { ok, detail, status: finalStatus, data }, observation);
  executor.updateRecord(message.action_id, {
    status: finalStatus,
    detail: payload.detail,
    data: payload.data,
  });
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (observation) socket.send(JSON.stringify({ type: 'state', data: observation }));
  socket.send(JSON.stringify(payload));
  log(ok ? '动作完成' : '动作失败', message.tool, `${finalStatus} ${detail}`);
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
      await gotoWithDeadline(new goals.GoalXZ(waypointX, waypointZ));
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
      await gotoWithDeadline(goal);
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

const COLLECT_WALK_TIMEOUT_MS = 30000;
const COLLECT_DROP_RANGE = 6;
const COLLECT_DROP_WAIT_MS = 1500;
const COLLECT_DROP_TIMEOUT_MS = 8000;
const COLLECT_LOW_HEALTH = 8;
const COLLECT_RECOVER_HEALTH = 12;
const COLLECT_COMBAT_WAIT_MS = 30000;
const COLLECT_RECOVER_WAIT_MS = 20000;

// 库的 stop() 只把内部标志置位，真正的停止要等下一次路径重置才发生。
// 采集开始前先清一次目标，这次重置会把残留的标志一起清掉，
// 否则接下来的 goto 会立刻被 path_stop 打回。
function resetPathfinderGoal() {
  if (!bot || !bot.entity || !bot.pathfinder) return;
  bot.pathfinder.setGoal(null);
}

// 超时后必须同时置停止标志并清目标，否则旧 goto 会和新 goto 叠在一起。
function stopPathfinding() {
  if (!bot || !bot.pathfinder) return;
  stopPathfinderAndClearGoal(bot.pathfinder);
}

// goto 的错误名见 mineflayer-pathfinder/lib/goto.js：
// NoPath（走不到）、Timeout（算路超时）、GoalChanged（目标被换掉）、PathStopped（路径被停）。
function classifyPathFailure(error) {
  const name = String(error?.name || '');
  if (name === 'NoPath' || name === 'Timeout' || name === 'CollectTimeout') return 'unreachable';
  if (name === 'GoalChanged' || name === 'PathStopped') return 'stopped';
  return 'unknown';
}

async function gotoWithDeadline(goal, timeoutMs = 30000, message = '寻路超时') {
  if (!bot?.pathfinder) throw new Error('当前没有寻路能力');
  const result = await gotoWithTimeout(bot.pathfinder, goal, timeoutMs, message, () => bot.entity.position);
  if (interrupted) throw new Error('被新的指令打断');
  return result;
}

// 外部取消的三个来源：新的动作或停止指令、动作超时、与服务器断开。
function externalCancelReason() {
  if (interrupted) return '收到新的指令或动作超时';
  if (!bot || !bot.entity) return '与 Minecraft 的连接已断开';
  return '';
}

// 战斗打断的三个迹象：反击正在进行、刚受过伤、附近有敌对生物。
function isCombatInterrupt() {
  if (combatBusy) return true;
  if (Date.now() - lastHurtAt < 3000) return true;
  return nearbyHostiles(12).length > 0;
}

function isDroppedItem(entity) {
  return Boolean(
    entity &&
      entity.position &&
      (entity.name === 'item' || entity.name === 'Item' || entity.name === 'item_stack')
  );
}

// 掉落物实体的物品名。实体刚生成时元数据还没到，这时读不到名字。
function droppedItemName(entity) {
  if (!entity || typeof entity.getDroppedItem !== 'function') return '';
  try {
    const item = entity.getDroppedItem();
    return item?.name || '';
  } catch {
    return '';
  }
}

function inventorySnapshot() {
  const snapshot = {};
  for (const item of bot.inventory.items()) {
    snapshot[item.name] = (snapshot[item.name] || 0) + item.count;
  }
  return snapshot;
}

// 捡掉落物：等实体出现、走到拾取范围内、核对背包数量变化。
// 返回 { picked: { 物品名: 数量 }, missed: [没捡到的物品名] }。
async function collectDrops(range = COLLECT_DROP_RANGE, expectName = '') {
  const before = inventorySnapshot();
  const expectedBefore = expectName ? before[expectName] || 0 : 0;
  const missed = [];
  const collected = [];
  const onCollect = (collector, entity) => {
    if (collector !== bot.entity) return;
    collected.push(droppedItemName(entity) || '未知物品');
  };
  bot.on('playerCollect', onCollect);
  const deadline = Date.now() + COLLECT_DROP_TIMEOUT_MS;
  let entityDeadline = Date.now() + COLLECT_DROP_WAIT_MS;
  let walks = 0;
  try {
    while (Date.now() < deadline) {
      const cancel = externalCancelReason();
      if (cancel) {
        log('捡掉落物被外部取消', cancel);
        break;
      }
      if (expectName && countItem(expectName) > expectedBefore) break;
      const item = bot.nearestEntity(
        (entity) =>
          isDroppedItem(entity) &&
          entity.position.distanceTo(bot.entity.position) <= range &&
          (!expectName || droppedItemName(entity) === expectName)
      );
      if (!item) {
        // 掉落物实体还没生成，等它出现；等不到就说明这次没有掉落物。
        if (Date.now() > entityDeadline) break;
        await sleep(200);
        continue;
      }
      const name = droppedItemName(item);
      const position = item.position.clone();
      walks += 1;
      if (walks > 3) {
        log('掉落物捡不到，放弃这个掉落物', name || '未知物品');
        if (name && !missed.includes(name)) missed.push(name);
        break;
      }
      try {
        resetPathfinderGoal();
        await gotoWithDeadline(new goals.GoalNear(position.x, position.y, position.z, 1), 5000, '走到掉落物超时');
      } catch (error) {
        const cancel = externalCancelReason();
        if (cancel) {
          log('捡掉落物被外部取消', cancel);
          break;
        }
        if (name && !missed.includes(name)) missed.push(name);
        log('没走到掉落物', name || '未知物品', error.message);
        resetPathfinderGoal();
        await sleep(200);
        continue;
      }
      await sleep(400);
      entityDeadline = Date.now() + COLLECT_DROP_WAIT_MS;
    }
  } finally {
    bot.removeListener('playerCollect', onCollect);
  }
  await syncInventory();
  const after = inventorySnapshot();
  const picked = {};
  for (const key of Object.keys(after)) {
    const delta = after[key] - (before[key] || 0);
    if (delta > 0) picked[key] = delta;
  }
  if (expectName && !picked[expectName] && !missed.includes(expectName)) missed.push(expectName);
  if (collected.length > 0) log('拾取事件', collected.join('、'));
  return { picked, missed };
}

async function waitForCombat(timeoutMs = 20000) {
  // 反击由 defendAgainst 负责，这里只等它打完。
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (interrupted) return false;
    if (!combatBusy) return true;
    await sleep(300);
  }
  return !combatBusy;
}

async function waitForQuietAround(radius = 10, timeoutMs = 30000) {
  // 附近还有怪就先等反击把它们清掉，别在打架的时候走远。
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (interrupted) return false;
    await waitForCombat(5000);
    const hostiles = nearbyHostiles(radius);
    if (hostiles.length === 0) return true;
    await sleep(500);
  }
  return nearbyHostiles(radius).length === 0;
}

// 撤退之后等血量恢复；血量一直上不来就放弃这次采集。
async function waitForHealth(minHealth, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!bot || !bot.entity) return false;
    if (bot.health >= minHealth) return true;
    await sleep(500);
  }
  return Boolean(bot && bot.entity && bot.health >= minHealth);
}

// 走一次并分类结果：'reached' | 'unreachable' | 'stopped' | 'cancelled'。
async function walkOnce(x, y, z, radius, timeoutMs, horizontalOnly = false) {
  const cancel = externalCancelReason();
  if (cancel) {
    log('采集被外部取消', cancel);
    return 'cancelled';
  }
  resetPathfinderGoal();
  try {
    await gotoWithDeadline(
      horizontalOnly
        ? new goals.GoalNearXZ(x, z, radius)
        : new goals.GoalNear(x, y, z, radius),
      timeoutMs,
      '走到目标超时',
    );
    return 'reached';
  } catch (error) {
    const cancel = externalCancelReason();
    if (cancel) {
      log('采集被外部取消', cancel, error.message);
      return 'cancelled';
    }
    const kind = classifyPathFailure(error);
    log(kind === 'unreachable' ? '走不到目标' : '寻路被外部停止', error.message);
    resetPathfinderGoal();
    return kind === 'unreachable' ? 'unreachable' : 'stopped';
  }
}

// 走到方块附近并处理打断。
// 返回 'reached' | 'unreachable'（换目标）| 'cancelled'（外部取消）| 'low_health'（撤退中止）。
async function travelToBlock(position, timeoutMs = COLLECT_WALK_TIMEOUT_MS) {
  const target = bot.blockAt(position);
  const targetName = target?.name || '';
  const place = `${targetName} (${position.x}, ${position.y}, ${position.z})`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const approachY = Math.max(bot.game.minY, position.y - 1);
    let outcome = await walkOnce(position.x, approachY, position.z, 2, timeoutMs);
    if (outcome === 'reached' && bot.entity.position.distanceTo(position) > 4.5) {
      // 离原木还远，靠近一点再挖。
      const close = await walkOnce(position.x, position.y, position.z, 2, 8000);
      if (close === 'reached') return 'reached';
      outcome = close;
    }
    if (outcome === 'reached') return 'reached';
    if (outcome === 'cancelled') return 'cancelled';
    if (outcome === 'unreachable') {
      log('这个目标走不过去，换一个', place);
      return 'unreachable';
    }
    // 路径被停：先分清是战斗打断还是外部取消。
    if (!isCombatInterrupt()) {
      log('寻路被外部停止，结束采集', place);
      return 'cancelled';
    }
    if (bot.health <= COLLECT_LOW_HEALTH) {
      log('战斗里血量不足，先撤退等恢复', `血量 ${bot.health}`);
      resetPathfinderGoal();
      await waitForCombat(COLLECT_COMBAT_WAIT_MS);
      const recovered = await waitForHealth(COLLECT_RECOVER_HEALTH, COLLECT_RECOVER_WAIT_MS);
      if (!recovered) {
        log('血量没有恢复，结束采集', `血量 ${bot.health}`);
        return 'low_health';
      }
      log('血量恢复，继续采集', `血量 ${bot.health}`);
    } else {
      log('采集被怪打断，等反击结束后再试', place);
      await waitForCombat(COLLECT_COMBAT_WAIT_MS);
      await waitForQuietAround(10, 10000);
    }
    const current = bot.blockAt(position);
    if (!current || current.name !== targetName) {
      log('采集目标不见了，换一个', place);
      return 'unreachable';
    }
  }
  log('这个目标试了两次都没到，换一个', place);
  return 'unreachable';
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
    await gotoWithDeadline(new goals.GoalNear(position.x, position.y, position.z, 1));
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
  if (/_bed$/.test(name)) {
    if (bot.entity.position.distanceTo(target) > 4) {
      await gotoWithDeadline(new goals.GoalNear(target.x, target.y, target.z, 2));
    }
    const placed = await placeBedAt(bot, target, name, {
      createVector: (x, y, z) => vec(x, y, z),
      wait: sleep,
      moveTo: ({ x, y, z }) => travelTo(x + 0.5, y, z + 0.5, 0),
      token: executor.active?.token,
    });
    return `放置床于 (${placed.foot.x}, ${placed.foot.y}, ${placed.foot.z})，床头在 (${placed.head.x}, ${placed.head.y}, ${placed.head.z})`;
  }
  const item = bot.inventory.items().find((entry) => entry.name === name);
  if (!item) throw new Error(`背包里没有 ${blockLabel(name)}`);
  if (bot.entity.position.distanceTo(target) > 4) {
    await gotoWithDeadline(new goals.GoalNear(target.x, target.y, target.z, 2));
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
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const placed = bot.blockAt(target);
        if (placed && placed.name === name) {
          return `放置 ${blockLabel(name)} 于 (${target.x}, ${target.y}, ${target.z})`;
        }
        await sleep(100);
      }
      lastError = new Error(`放置后位置 (${target.x}, ${target.y}, ${target.z}) 仍是空气`);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(lastError ? `放置失败: ${lastError.message}` : '周围没有可以依附的方块');
}

// 按指定朝向放置方块。
// 床这类方块的朝向由放置那一刻的视角决定，通用 placeBlock 会依次试六个面，
// 床会放反或者被服务端拒绝；这里先转好视角再放到目标位置下方的方块上。
async function placeBlockWithFacing(name, target, yaw) {
  const item = bot.inventory.items().find((entry) => entry.name === name);
  if (!item) throw new Error(`背包里没有 ${blockLabel(name)}`);
  if (bot.entity.position.distanceTo(target) > 4) {
    await gotoWithDeadline(new goals.GoalNear(target.x, target.y, target.z, 2));
  }
  const support = bot.blockAt(target.offset(0, -1, 0));
  if (!support || support.boundingBox !== 'block') {
    throw new Error('目标位置下方没有可以依附的方块');
  }
  await bot.equip(item, 'hand');
  if (typeof yaw === 'number' && Number.isFinite(yaw)) {
    await bot.look(yaw, 0, true);
    await sleep(120);
  }
  if (typeof bot._placeBlockWithOptions === 'function') {
    await bot._placeBlockWithOptions(support, vec(0, 1, 0), { swingArm: 'right', forceLook: 'ignore' });
  } else {
    await bot.placeBlock(support, vec(0, 1, 0));
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const placed = bot.blockAt(target);
    if (placed && placed.name === name) {
      return `放置 ${blockLabel(name)} 于 (${target.x}, ${target.y}, ${target.z})`;
    }
    await sleep(100);
  }
  throw new Error(`放置 ${blockLabel(name)} 后位置仍是空气`);
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
      entity.name === 'item' &&
      entity.position.distanceTo(bot.entity.position) <= range
  );
  if (!item) throw new Error(`附近 ${range} 格内没有掉落物`);
  const dropped = item.getDroppedItem ? item.getDroppedItem() : null;
  const name = dropped?.name || '';
  const before = name ? countItem(name) : 0;
  await gotoWithDeadline(
    new goals.GoalNear(item.position.x, item.position.y, item.position.z, 1)
  );
  await sleep(500);
  if (name) {
    const gained = countItem(name) - before;
    if (gained > 0) return `捡起了 ${gained} 个 ${blockLabel(name)}`;
  }
  return '走到了掉落物旁边，但还没有捡起';
}

function countItem(name) {
  return bot.inventory
    .items()
    .filter((item) => item.name === name)
    .reduce((total, item) => total + item.count, 0);
}

async function syncInventory(window = bot?.currentWindow || bot?.inventory, token = executor.active?.token) {
  // mineflayer 在合成/快速拾取后偶尔会漏掉 set_slot，主动要一次完整背包。
  await syncWindow(window, 2000, token);
}

async function syncWindow(window = bot?.currentWindow || bot?.inventory, timeoutMs = 2000, token = executor.active?.token) {
  if (!bot || !window) return true;
  const synchronized = await syncWindowWithLease(bot, window, token, toNotchSlot, timeoutMs);
  if (synchronized) return true;
  if (token?.cancelled) throw new Error(token.cancelReason || '容器同步被取消');
  const error = new Error(`窗口 ${window.id} 同步超时，容器状态未知`);
  error.code = 'UNKNOWN_WINDOW_STATE';
  throw error;
}

function nearbyBlock(name, range) {
  const block = bot.registry.blocksByName[name];
  if (!block) return null;
  return bot.findBlock({ matching: block.id, maxDistance: range });
}

// 合成窗口的点击参数。
// 两次点击之间的间隔：服务端处理上一个 window_click 需要时间，间隔太短会连点。
const CRAFT_CLICK_GAP = 80;
// 等服务端算出产物的时间上限。
const CRAFT_RESULT_TIMEOUT = 5000;

// bot.recipesAll 的第三个参数只当作「有没有工作台」的真假标记：
// 传 null 只列出 2×2 背包格能做的配方，传真值才会把需要工作台的配方也列出来。
const HAS_TABLE = true;

// 1.17 之后 window_click 用状态编号代替了 action id：客户端把服务端最后下发的编号回传，
// 编号对不上时服务端会重发整个窗口，但不会拒绝这次点击
// （mineflayer 的 _syncWindow 就是靠发一个不可能的编号来强制服务端重发窗口的）。
let craftStateId = -1;

// 合成材料的中文名，缺材料时要直接说清楚缺的是什么。
const CRAFT_ITEM_LABELS = {
  oak_planks: '橡木木板',
  spruce_planks: '云杉木板',
  birch_planks: '白桦木板',
  jungle_planks: '丛林木板',
  acacia_planks: '金合欢木板',
  dark_oak_planks: '深色橡木木板',
  oak_log: '橡木原木',
  spruce_log: '云杉原木',
  birch_log: '白桦原木',
  jungle_log: '丛林原木',
  acacia_log: '金合欢原木',
  dark_oak_log: '深色橡木原木',
  stick: '木棍',
  coal: '煤炭',
  charcoal: '木炭',
  cobblestone: '圆石',
  stone: '石头',
  iron_ingot: '铁锭',
  gold_ingot: '金锭',
  copper_ingot: '铜锭',
  diamond: '钻石',
  netherite_ingot: '下界合金锭',
  redstone: '红石粉',
  glass: '玻璃',
  paper: '纸',
  book: '书',
  leather: '皮革',
  string: '线',
  feather: '羽毛',
  flint: '燧石',
  gunpowder: '火药',
  sand: '沙子',
  wheat: '小麦',
  sugar: '糖',
  egg: '鸡蛋',
  bucket: '桶',
  water_bucket: '水桶',
  lava_bucket: '岩浆桶',
};

function craftItemLabel(name) {
  return CRAFT_ITEM_LABELS[name] || blockLabel(name);
}

// 按物品 id 找名字，registry 的 items 就是按 id 建索引的。
function itemNameById(id) {
  const entry = bot.registry.items?.[id];
  if (entry?.name) return entry.name;
  for (const candidate of Object.values(bot.registry.itemsByName || {})) {
    if (candidate.id === id) return candidate.name;
  }
  return '';
}

function itemLabelById(id) {
  const name = itemNameById(id);
  return name ? craftItemLabel(name) : String(id);
}

// 记录服务端下发的窗口状态编号，window_click 要把它回传回去。
function trackCraftStateId() {
  if (!bot || !bot._client || bot._voxkinCraftState) return;
  bot._voxkinCraftState = true;
  const track = (packet) => {
    craftStateId = packet.stateId;
  };
  bot._client.on('window_items', track);
  bot._client.on('set_slot', track);
}

// 协议里的 Slot 结构在 1.20.5 之后换成了按数量计数的写法。
// 物品实例的构造函数就是 prismarine-item 的 Item 类，直接复用它的转换函数。
function toNotchSlot(item) {
  if (!item) {
    return bot.registry.supportFeature('itemsWithComponents')
      ? { itemCount: 0, components: [], removeComponents: [] }
      : { present: false };
  }
  const itemClass = item.constructor;
  if (typeof itemClass?.toNotch === 'function') return itemClass.toNotch(item);
  return { present: true, itemId: item.type, itemCount: item.count };
}

// 自己发 window_click，不走 mineflayer 的 bot.clickWindow。
// mineflayer 点完合成格后会去等结果槽位重发（lib/plugins/inventory.js 的 waitForWindowUpdate）：
// 合成格还没凑齐配方时服务端不会重发结果槽位，那次等待必然超时，
// once 的默认超时是 20000 毫秒（lib/promise_utils.js），所以摆第一个材料就会卡满 20 秒。
// 这里改成自己发包、自己跟踪窗口状态：本地按 prismarine-windows 的规则推演这次点击，
// 把要上报的槽位变化和鼠标物品一起发给服务端，之后只按固定间隔等待。
function assertActionToken(token, cleanup = false) {
  if (cleanup) {
    if (token?.cleanupDeadlineAt && Date.now() >= token.cleanupDeadlineAt) {
      throw new Error('合成窗口清理超过时间上限');
    }
    return;
  }
  if (token?.cancelled) throw new Error(token.cancelReason || '合成动作被取消');
}

async function clickWindowSlot(window, slot, mouseButton, mode, token = executor.active?.token, cleanup = false) {
  await writeWindowClickWithLease(bot, window, {
    slot,
    mouseButton,
    mode,
    stateId: craftStateId,
    toNotchSlot,
    token,
    cleanup,
    wait: () => sleep(CRAFT_CLICK_GAP),
  });
}

// 让服务端把整个窗口重发一遍：既刷新本地模型，也拿到最新的状态编号。
async function refreshWindowState(window, token = executor.active?.token) {
  await syncWindow(window, 2000, token);
}

async function storeCraftCursor(window, token, cleanup = false) {
  while (window.selectedItem) {
    const count = window.selectedItem.count;
    const slot = craftReturnSlot(window);
    if (slot === null) throw new Error('背包满了，无法归还合成物品');
    await clickWindowSlot(window, slot, 0, 0, token, cleanup);
    if (window.selectedItem && window.selectedItem.count >= count) throw new Error('合成物品归还后鼠标堆叠未减少');
  }
}

// 把合成格清空：先拿起格里的东西，再放进背包空位，材料不会被弄丢。
async function clearCraftGrid(window, width, height, token) {
  assertActionToken(token);
  for (let gridSlot = 1; gridSlot <= width * height; gridSlot += 1) {
    assertActionToken(token);
    if (!window.slots[gridSlot]) continue;
    await clickWindowSlot(window, gridSlot, 0, 0, token);
    await storeCraftCursor(window, token);
  }
}

// 按配方把材料摆进合成格：一次拿一叠，右键一个一个放进去，剩下的放回背包。
async function placeIngredient(window, ingredient, destSlot, token) {
  const need = Math.max(1, Number(ingredient.count) || 1);
  let placed = 0;
  while (placed < need) {
    assertActionToken(token);
    const source = window.findInventoryItem(ingredient.id, ingredient.metadata ?? null);
    if (!source) {
      throw new Error(
        `材料不够，还缺 ${need - placed} 个 ${itemLabelById(ingredient.id)}`
      );
    }
    await clickWindowSlot(window, source.slot, 0, 0, token);
    const held = window.selectedItem;
    if (!held) throw new Error(`材料 ${itemLabelById(ingredient.id)} 拿不到手上`);
    const take = Math.min(need - placed, held.count);
    for (let index = 0; index < take; index += 1) {
      assertActionToken(token);
      await clickWindowSlot(window, destSlot, 1, 0, token);
    }
    placed += take;
    if (window.selectedItem) {
      await storeCraftCursor(window, token);
    }
  }
}

// 等服务端算出产物：结果槽位的内容只有服务端会下发，本地推演算不出来。
async function waitForCraftResult(window, expectedId, timeoutMs, token) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertActionToken(token);
    const output = window.slots[0];
    if (output && (expectedId == null || output.type === expectedId)) return output;
    await sleep(100);
  }
  assertActionToken(token);
  return null;
}

// 取走产物：先点结果槽把产物拿到鼠标上，再放进背包空位。
async function takeCraftResult(window, token) {
  assertActionToken(token);
  const output = window.slots[0];
  if (!output) return null;
  await clickWindowSlot(window, window.craftingResultSlot, 0, 0, token);
  await storeCraftCursor(window, token);
  return output;
}

// 失败时把鼠标上的东西和合成格里的东西退回背包，别让材料卡在窗口里。
async function restoreCraftWindow(window, width, height, token, { cursorOnly = false } = {}) {
  assertActionToken(token, true);
  if (window.selectedItem) {
    await storeCraftCursor(window, token, true);
  }
  if (cursorOnly) return;
  for (let gridSlot = 1; gridSlot <= width * height; gridSlot += 1) {
    assertActionToken(token, true);
    if (!window.slots[gridSlot]) continue;
    await clickWindowSlot(window, gridSlot, 0, 0, token, true);
    await storeCraftCursor(window, token, true);
  }
}

async function craftWithWindow(recipe, window, width, height, times, token = executor.active?.token) {
  // 自己点合成格：mineflayer 的 bot.craft 在 1.21.1 上偶尔只点第一排材料就取产物。
  for (let round = 0; round < times; round += 1) {
    assertActionToken(token);
    const inventorySlots = window.slots
      .slice(window.inventoryStart, window.inventoryEnd)
      .filter(Boolean);
    if (inventorySlots.length === 0) {
      throw new Error('合成窗口里看不到背包内容');
    }
    try {
      await clearCraftGrid(window, width, height, token);
      if (recipe.inShape) {
        for (let y = 0; y < recipe.inShape.length; y += 1) {
          const row = recipe.inShape[y];
          for (let x = 0; x < row.length; x += 1) {
            const ingredient = row[x];
            if (!ingredient || ingredient.id === -1) continue;
            await placeIngredient(window, ingredient, 1 + x + width * y, token);
          }
        }
      } else if (recipe.ingredients) {
        let gridSlot = 1;
        for (const ingredient of recipe.ingredients) {
          await placeIngredient(window, ingredient, gridSlot, token);
          gridSlot += 1;
        }
      } else {
        throw new Error('不认识的合成配方');
      }
      const output = await waitForCraftResult(window, recipe.result?.id, CRAFT_RESULT_TIMEOUT, token);
      if (!output) throw new Error('合成格摆好后没有产物');
      await takeCraftResult(window, token);
      log('合成产出', `${output.name}x${output.count}`);
      // 产物被取走后材料会被服务端消耗掉，本地模型要同步清空合成格。
      for (let gridSlot = 1; gridSlot <= width * height; gridSlot += 1) {
        window.updateSlot(gridSlot, null);
      }
    } catch (error) {
      if (['dead', 'disconnected'].includes(token?.cancelStatus)) throw error;
      if (isUrgentSafetyPreemption(token)) {
        const cleanup = await cleanupCraftWindowForSafety({
          token,
          window,
          inventoryWindow: bot.inventory,
          restoreCursor: () => restoreCraftWindow(window, width, height, token, { cursorOnly: true }),
          closeContainer: () => bot.closeWindow(window),
          synchronize: async (targetWindow, timeoutMs) => {
            const cleanupToken = { cancelled: false, cancelHooks: new Set() };
            return syncWindowWithLease(bot, targetWindow, cleanupToken, toNotchSlot, timeoutMs);
          },
        });
        if (cleanup.handled) {
          token.progressData = {
            ...(token.progressData || {}),
            phase: 'safety_craft_cleanup',
            window_cleanup: cleanup.mode,
            crafting_grid_residue: cleanup.mode === 'cursor_only'
              ? window.slots.slice(1, window.craftingResultSlot).filter(Boolean).map((item) => ({ name: item.name, count: item.count }))
              : [],
          };
          throw error;
        }
      }
      try {
        if (token) token.cleanupDeadlineAt = Date.now() + 5000;
        await restoreCraftWindow(window, width, height, token);
        const cleanupToken = { cancelled: false, cancelHooks: new Set() };
        const synchronized = await syncWindowWithLease(bot, window, cleanupToken, toNotchSlot, 2000);
        if (!synchronized) throw new Error('合成窗口清理后的状态同步超时');
      } catch (cleanupError) {
        const unknown = new Error(`合成已停止，但窗口清理状态未知：${cleanupError.message}`);
        unknown.code = 'UNKNOWN_WINDOW_STATE';
        if (token?.cancelled) {
          token.cancelStatus = 'unknown';
          token.cancelReason = unknown.message;
          token.progressData = { ...(token.progressData || {}), phase: 'window_cleanup_unknown', window_state_unknown: true };
        } else {
          throw unknown;
        }
      } finally {
        if (token) delete token.cleanupDeadlineAt;
      }
      throw error;
    }
  }
  await refreshWindowState(window, token);
}

async function placeInventoryBlock(name, label, searchRadius = 1) {
  const base = bot.entity.position;
  const scan = inspectSupportedPlacementTargets({
    base,
    searchRadius,
    getBlock: ({ x, y, z }) => bot.blockAt(vec(x, y, z)),
  });
  const spots = scan.targets;
  if (dryMiningFooting(bot, base) && !spots.some(({target}) => base.distanceTo(vec(target.x, target.y, target.z)) <= 4)) {
    const alcove = dryStationAlcove(bot);
    if (alcove) {
      for (const point of alcove.cells) {
        if (interrupted || executor.active?.token?.cancelled) throw new Error('工作台站位准备已取消');
        const block = bot.blockAt(point);
        if (block?.boundingBox === 'empty') continue;
        if (!block || !bot.canDigBlock(block) || !dryStationAlcove(bot)?.target.equals(alcove.target)) break;
        await equipToolFor(block);
        if (interrupted || executor.active?.token?.cancelled) throw new Error('工作台站位准备已取消');
        await bot.dig(block);
      }
      if (dryMiningFooting(bot, alcove.target)) spots.unshift({target: alcove.target});
    }
  }
  const supported = spots.length;
  let openSpots = 0;
  for (const { target } of spots) {
    const targetPosition = vec(target.x, target.y, target.z);
    try {
      const distance = bot.entity.position.distanceTo(targetPosition);
      if (distance > 4) await travelTo(target.x, target.y, target.z, 2);
      if (interrupted) throw new Error('被新的指令打断');
      openSpots += 1;
      await placeBlock({ block: name, x: target.x, y: target.y, z: target.z });
      const placed = bot.blockAt(targetPosition);
      if (placed?.name === name) return placed;
      log('放置后没看到方块', `${label} (${target.x}, ${target.y}, ${target.z})`);
    } catch (error) {
      if (interrupted) throw error;
      log('这个位置放不下', `${label} (${target.x}, ${target.y}, ${target.z}): ${error.message}`);
    }
  }
  const token = executor.active?.token;
  const diagnostic = {
    ...scan.diagnostics,
    bot_position: { x: base.x, y: base.y, z: base.z },
    supported_targets: supported,
    placement_attempts: openSpots,
  };
  if (token) {
    token.progressData = {
      ...(token.progressData || {}),
      phase: scan.diagnostics.unknown_count > 0 ? 'placement_terrain_unknown' : 'placement_no_target',
      placement_diagnostics: diagnostic,
    };
  }
  log('放置点地形诊断', label, JSON.stringify(diagnostic));
  log('放置点搜索失败', label, `半径 ${searchRadius}，有支撑且上方空 ${supported} 个，尝试放置 ${openSpots} 个`);
  if (scan.diagnostics.unknown_count > 0) {
    const error = new Error(
      `放置${label}附近有 ${scan.diagnostics.unknown_count} 个方块状态未知，无法判断有效落点`
    );
    error.code = 'UNKNOWN_TERRAIN';
    throw error;
  }
  throw new Error(`附近没有地方放${label}`);
}

async function placeCraftingTable() {
  return placeInventoryBlock('crafting_table', '工作台', 4);
}

async function recoverPlacedTable(table) {
  const feet = bot.entity.position.floored();
  if (!dryMiningFooting(bot, feet) || table.position.equals(feet.offset(0, -1, 0))) return;
  const besideFluid = [[0,1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]].some(([x,y,z]) => {
    const neighbor = bot.blockAt(table.position.offset(x,y,z));
    return !neighbor || waterLike(neighbor) || neighbor.name === 'lava';
  });
  if (besideFluid) return;
  try {
    await bot.dig(table);
  } catch (error) {
    log('回收工作台失败', error.message);
    return;
  }
  if (countItem('crafting_table') === 0) {
    await sleep(400);
    // collectDrops 已等待掉落物生成、尝试接近并核对库存。
    if (!externalCancelReason() && dryMiningFooting(bot, bot.entity.position)) await collectDrops(4, 'crafting_table');
  }
}

// 按配方算出每种材料要做多少次、总共需要几个。
function recipeRequirements(recipe) {
  const needs = new Map();
  const collect = (entry) => {
    if (!entry || entry.id === -1) return;
    const key = `${entry.id}:${entry.metadata ?? 'any'}`;
    const amount = Math.max(1, Number(entry.count) || 1);
    const current = needs.get(key);
    if (current) current.need += amount;
    else needs.set(key, { id: entry.id, metadata: entry.metadata ?? null, need: amount });
  };
  if (recipe.inShape) {
    for (const row of recipe.inShape) {
      for (const cell of row) collect(cell);
    }
  } else if (recipe.ingredients) {
    for (const entry of recipe.ingredients) collect(entry);
  }
  return [...needs.values()];
}

// 背包里还差哪些材料。
function missingMaterials(recipe, operations) {
  const missing = [];
  for (const need of recipeRequirements(recipe)) {
    const total = need.need * operations;
    const have = bot.inventory.count(need.id, need.metadata);
    if (have < total) missing.push({ id: need.id, need: total, have });
  }
  return missing;
}

// 在候选配方里挑一个材料够做完的。
function pickRecipe(recipes, count) {
  for (const recipe of recipes) {
    const operations = Math.max(1, Math.ceil(count / Math.max(1, recipe.result?.count || 1)));
    if (missingMaterials(recipe, operations).length === 0) return { recipe, operations };
  }
  return null;
}

// 材料不够时直接说明缺什么、缺多少，一个物品都不动。
function materialsShortage(item, recipes, count) {
  if (!recipes.length) return `没有 ${blockLabel(item.name)} 的配方`;
  let worst = null;
  for (const recipe of recipes) {
    const operations = Math.max(1, Math.ceil(count / Math.max(1, recipe.result?.count || 1)));
    const missing = missingMaterials(recipe, operations);
    if (!missing.length) continue;
    if (!worst || missing.length < worst.length) worst = missing;
  }
  if (!worst) return `没有 ${blockLabel(item.name)} 的配方`;
  const parts = worst.map((entry) => {
    const label = itemLabelById(entry.id);
    const owned = entry.have > 0 ? `背包里只有 ${entry.have} 个${label}` : `背包里没有${label}`;
    return `${owned}，合成${blockLabel(item.name)}需要 ${entry.need} 个`;
  });
  return parts.join('；');
}

async function craftItem(args, token = executor.active?.token) {
  const name = String(args.item || '');
  const count = Math.max(1, Math.min(Number(args.count) || 1, 64));
  const item = bot.registry.itemsByName[name];
  if (!item) throw new Error(`未知物品 ${name}`);
  trackCraftStateId();
  const recipes = bot.recipesAll(item.id, null, HAS_TABLE);
  const picked = pickCraftingRecipe(recipes, (candidate) => Boolean(pickRecipe([candidate], count)));
  if (!picked) throw new Error(materialsShortage(item, recipes, count));
  let table = null;
  let placed = false;
  const { recipe, requiresTable } = picked;
  const operations = pickRecipe([recipe], count).operations;
  if (requiresTable) {
    // 矿井里携带工作台时就地合成，避免穿过岩层回到地表的旧工作台。
    const carried = countItem('crafting_table') > 0;
    table = nearbyBlock('crafting_table', carried ? 3 : 32);
    if (carried && table && !bot.canSeeBlock(table)) table = null;
    if (!table) {
      if (!carried) {
        throw new Error('附近 32 格内没有工作台，背包里也没有');
      }
      table = await placeCraftingTable();
      placed = true;
      temporaryCraftingTable = { position: table.position.clone(), dimension: String(bot.game?.dimension || '') };
    }
  }
  if (table && bot.entity.position.distanceTo(table.position) > 3) {
    await travelTo(table.position.x, table.position.y, table.position.z, 2);
  }
  const before = countItem(name);
  const yieldCount = Math.max(1, Number(recipe.result?.count) || 1);
  log(
    '合成参数',
    `${name} 已有 ${before}，工作台 ${table ? `(${table.position.x}, ${table.position.y}, ${table.position.z})` : '无'}，` +
      `现放 ${placed}，距离 ${table ? bot.entity.position.distanceTo(table.position).toFixed(1) : '-'}，` +
      `配方 id=${recipe.result?.id} x${yieldCount}，需台 ${recipe.requiresTable}，操作 ${operations}`
  );
  try {
    if (table) {
      const window = await bot.openBlock(table);
      try {
        await craftWithWindow(recipe, window, 3, 3, operations, token);
      } finally {
        if (!token?.craftWindowClosed) {
          try {
            await bot.closeWindow(window);
          } catch {
            // 关窗失败不影响已取走的产物
          }
        }
        if (token) delete token.craftWindowClosed;
        if (!token?.safetyWindowCleanup) await sleep(200);
        await syncInventoryAfterWindowClose(token, token?.safetyWindowCleanup ? 300 : 2000);
      }
    } else {
      await craftWithWindow(recipe, bot.inventory, 2, 2, operations, token);
    }
    const after = countItem(name);
    log(
      '合成结果',
      `${name} 背包 ${after}，手持 ${bot.heldItem?.name || '空'}，` +
        `物品 ${bot.inventory
          .items()
          .map((entry) => `${entry.name}x${entry.count}`)
          .join(',')}`
    );
    if (after <= before) {
      throw new Error(`合成 ${blockLabel(name)} 没有产出`);
    }
    const expected = before + operations * yieldCount;
    if (after !== expected) {
      // 数量对不上时让服务端重发一次背包再核对，确认不是本地模型算错。
      await refreshWindowState(bot.inventory);
      const confirmed = countItem(name);
      if (confirmed !== expected) {
        throw new Error(
          `合成 ${blockLabel(name)} 数量不对：期望 ${expected} 个，实际 ${confirmed} 个`
        );
      }
    }
    return `合成 ${after - before} 个 ${blockLabel(name)}`;
  } finally {
    if (placed && table && !token?.cancelled && !retainTemporaryTable(currentGoalId)) {
      await recoverPlacedTable(table);
      if (bot.blockAt(temporaryCraftingTable.position)?.name !== 'crafting_table') temporaryCraftingTable = null;
    }
  }
}

async function syncInventoryAfterWindowClose(token, timeoutMs = 2000) {
  if (['dead', 'disconnected'].includes(token?.cancelStatus)) return false;
  const cleanupToken = { cancelled: false, cancelHooks: new Set() };
  const synchronized = await syncWindowWithLease(bot, bot.inventory, cleanupToken, toNotchSlot, timeoutMs);
  if (synchronized) return true;
  const message = '工作台关闭后背包状态同步超时';
  if (token?.cancelled) {
    token.cancelStatus = 'unknown';
    token.cancelReason = message;
    token.progressData = { ...(token.progressData || {}), phase: 'window_cleanup_unknown', window_state_unknown: true };
    return false;
  }
  const error = new Error(message);
  error.code = 'UNKNOWN_WINDOW_STATE';
  throw error;
}

const SMELT_OUTPUTS = {
  raw_iron: 'iron_ingot',
  raw_gold: 'gold_ingot',
  raw_copper: 'copper_ingot',
  sand: 'glass',
  cobblestone: 'stone',
  clay_ball: 'brick',
  porkchop: 'cooked_porkchop',
  beef: 'cooked_beef',
  chicken: 'cooked_chicken',
  mutton: 'cooked_mutton',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
  potato: 'baked_potato',
};

function findFuelItem(count = 1, preferred = '') {
  return selectFuel(bot.inventory.items(), [count], preferred);
}

async function smeltItem(args, token = executor.active?.token) {
  const name = String(args.item || '');
  const count = Math.max(1, Math.min(Number(args.count) || 1, 64));
  const item = bot.registry.itemsByName[name];
  if (!item) throw new Error(`未知物品 ${name}`);
  if (countItem(name) < count) throw new Error(`背包里只有 ${countItem(name)} 个 ${blockLabel(name)}`);
  let furnaceBlock = nearbyBlock('furnace', 16);
  let placed = false;
  if (!furnaceBlock) {
    if (!bot.inventory.items().some((entry) => entry.name === 'furnace')) {
      throw new Error('附近没有熔炉，背包里也没有熔炉');
    }
    furnaceBlock = await placeInventoryBlock('furnace', '熔炉', 4);
    placed = true;
  }
  if (bot.entity.position.distanceTo(furnaceBlock.position) > 3) {
    await travelTo(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2);
  }
  const outputName = SMELT_OUTPUTS[name] || name;
  const before = countItem(outputName);
  const furnace = await bot.openFurnace(furnaceBlock);
  let furnaceClosed = false;
  try {
    const fuel = findFuelItem(count, String(args.fuel || ''));
    if (!fuel) throw new Error('没有燃料（煤、木炭或木板）');
    const fuelType = inventoryItemType(fuel);
    if (fuelType === null) throw new Error('燃料物品 ID 无效，无法放入熔炉');
    const fuelCount = Math.ceil(count / FUEL_BURN[fuel.name]);
    await furnace.putInput(item.id, null, count);
    await furnace.putFuel(fuelType, null, fuelCount);
    let waited = 0;
    while (waited < 90 && (furnace.outputItem()?.count || 0) < count) {
      if (interrupted) throw new Error('被新的指令打断');
      await (token?.wait ?? sleep)(1000);
      waited += 1;
    }
    const output = furnace.outputItem();
    log('熔炉产物待取', JSON.stringify({
      input: furnace.inputItem()?.name || '',
      inputCount: furnace.inputItem()?.count || 0,
      output: output?.name || '',
      outputCount: output?.count || 0,
      inventoryBefore: countItem(outputName),
      waited,
    }));
    if (output) await furnace.takeOutput();
    await closeWindowAndSyncInventory(furnace, () => syncInventory(bot.inventory));
    furnaceClosed = true;
    const gained = countItem(outputName) - before;
    log('熔炉取出后状态', JSON.stringify({
      output: furnace.outputItem()?.name || '',
      outputCount: furnace.outputItem()?.count || 0,
      inventoryAfter: countItem(outputName),
      gained,
    }));
    if (gained <= 0) throw new Error(`熔炼了 ${name}，但没有取到 ${outputName}`);
    return `熔炼出 ${gained} 个 ${blockLabel(outputName)}，背包共 ${countItem(outputName)} 个`;
  } finally {
    if (!furnaceClosed) {
      try {
        await furnace.close();
      } catch (error) {
        log('关闭熔炉失败', error.message);
      }
    }
    if (placed) {
      try {
        await bot.dig(furnaceBlock);
      } catch (error) {
        log('回收熔炉失败', error.message);
      }
    }
  }
}

const GOLDEN_FOODS = new Set(['golden_apple', 'enchanted_golden_apple']);

function numberText(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '未知';
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function foodInfo(name) {
  const foods = bot && bot.registry ? bot.registry.foodsByName : null;
  if (!foods) return null;
  const info = foods[name];
  if (!info || !(info.foodPoints > 0)) return null;
  return info;
}

function findFoodForEating() {
  const candidates = bot.inventory
    .items()
    .filter((item) => !GOLDEN_FOODS.has(item.name) && foodInfo(item.name));
  candidates.sort((left, right) => {
    const leftInfo = foodInfo(left.name);
    const rightInfo = foodInfo(right.name);
    return (
      (rightInfo.effectiveQuality || rightInfo.foodPoints) -
      (leftInfo.effectiveQuality || leftInfo.foodPoints)
    );
  });
  return candidates[0] || null;
}

async function eatFood(args) {
  const requested = String(args.item || '').trim();
  const count = Math.min(Math.max(Math.trunc(Number(args.count)) || 1, 1), 16);
  const startFood = Number(bot.food ?? 20);
  if (startFood >= 20) {
    throw new Error('现在不饿，饥饿值已经满了，先不吃东西');
  }
  let targetName;
  if (requested) {
    if (!foodInfo(requested)) throw new Error(`${itemLabel(requested)}不是能吃的食物`);
    const found = bot.inventory.items().find((item) => item.name === requested);
    if (!found) throw new Error(`背包里没有${itemLabel(requested)}`);
    targetName = requested;
  } else {
    const food = findFoodForEating();
    if (!food) throw new Error('背包里没有能吃的食物');
    targetName = food.name;
  }
  const startHealth = Number(bot.health ?? 20);
  const startCount = countItem(targetName);
  let eaten = 0;
  let stoppedBecause = '';
  for (let index = 0; index < count; index += 1) {
    if (interrupted) throw new Error('被新的指令打断');
    if (Number(bot.food ?? 20) >= 20) {
      stoppedBecause = 'full';
      break;
    }
    const item = bot.inventory.items().find((entry) => entry.name === targetName);
    if (!item) {
      stoppedBecause = 'empty';
      break;
    }
    const beforeCount = countItem(targetName);
    const beforeFood = Number(bot.food ?? 20);
    try {
      await bot.equip(item, 'hand');
      await bot.consume();
    } catch (error) {
      if (/food is full/i.test(error.message)) {
        stoppedBecause = 'full';
        break;
      }
      throw new Error(`吃${itemLabel(targetName)}失败：${error.message}`);
    }
    let verified = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (interrupted) throw new Error('被新的指令打断');
      if (
        countItem(targetName) < beforeCount ||
        Number(bot.food ?? 20) > beforeFood
      ) {
        verified = true;
        break;
      }
      await sleep(100);
    }
    if (!verified) {
      throw new Error(`没有观察到${itemLabel(targetName)}数量减少或饥饿值恢复`);
    }
    eaten += 1;
  }
  if (eaten === 0) {
    if (stoppedBecause === 'full') throw new Error('还没吃就饱了，没有消耗食物');
    throw new Error(`背包里没有${itemLabel(targetName)}了，没能吃成`);
  }
  const endFood = Number(bot.food ?? 20);
  const endHealth = Number(bot.health ?? 20);
  const endCount = countItem(targetName);
  const parts = [`吃了 ${eaten} 个${itemLabel(targetName)}`];
  if (endFood !== startFood) parts.push(`饥饿值从 ${startFood} 变成 ${endFood}`);
  else if (endCount !== startCount) parts.push(`背包里还剩 ${endCount} 个`);
  if (endHealth !== startHealth) parts.push(`血量从 ${startHealth} 变成 ${endHealth}`);
  if (eaten < count) {
    parts.push(stoppedBecause === 'full' || endFood >= 20 ? '已经吃饱了' : '背包里的份数不够');
  }
  return parts.join('，');
}

const FACING_LABELS = ['南', '西南', '西', '西北', '北', '东北', '东', '东南'];

function facingLabel(yaw) {
  const degrees = ((((Number(yaw) * 180) / Math.PI) % 360) + 360) % 360;
  return FACING_LABELS[Math.round(degrees / 45) % 8];
}

function dimensionLabel(dimension) {
  const text = String(dimension || '').toLowerCase();
  if (text.includes('nether')) return '下界';
  if (text.includes('end')) return '末地';
  if (text.includes('overworld')) return '主世界';
  return text || '未知维度';
}

function clockLabel(timeOfDay) {
  const ticks = (((Number(timeOfDay) || 0) % 24000) + 24000) % 24000;
  const hours = (Math.floor(ticks / 1000) + 6) % 24;
  const minutes = Math.floor(((ticks % 1000) / 1000) * 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function weatherLabel() {
  if (Number(bot.thunderState || 0) > 0) return '雷雨';
  if (Number(bot.rainState || 0) > 0) return '下雨';
  return '晴';
}

function playerNameOf(entity) {
  const entry = Object.values(bot.players).find((player) => player.entity === entity);
  if (entry && entry.username) return entry.username;
  return entity.username || entity.name || '玩家';
}

function armorSummary() {
  const names = [5, 6, 7, 8]
    .map((slot) => bot.inventory.slots[slot])
    .filter(Boolean)
    .map((item) => itemLabel(item.name));
  return names.length > 0 ? names.join('、') : '没有穿护甲';
}

function nearbyPlayers(radius, limit = 4) {
  const origin = bot.entity.position;
  return Object.values(bot.entities)
    .filter((entity) => entity !== bot.entity && entity.type === 'player' && entity.position)
    .map((entity) => ({
      name: playerNameOf(entity),
      distance: entity.position.distanceTo(origin),
    }))
    .filter((entry) => entry.distance <= radius)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, limit);
}

function hostileBehindCover(entity, emergencyHunt = executor.active?.token?.seekingEmergencyFood) {
  return magmaCubeBehindCover(bot, entity) || creeperBehindRock(bot, entity) || (emergencyHunt && zombieBehindFloor(bot, entity));
}

function nearbyHostiles(radius, limit = 4) {
  return assessCombatEncounter({
    entities: bot.entities,
    behindFloor: hostileBehindCover,
    origin: bot.entity.position,
    registry: bot.registry,
    health: bot.health,
    radius,
    equipment: combatEquipment(bot),
  }).threats
    .map((entry) => ({ name: blockLabel(entry.name), distance: entry.distance }))
    .slice(0, limit);
}

function observeSurroundings(args) {
  const radius = Math.min(Math.max(Number(args.radius) || 16, 1), 64);
  const position = bot.entity.position;
  const parts = [];
  parts.push(
    `我在${dimensionLabel(bot.game.dimension)} (${Math.floor(position.x)}, ${Math.floor(
      position.y
    )}, ${Math.floor(position.z)})，面向${facingLabel(bot.entity.yaw)}`
  );
  parts.push(`血量 ${numberText(bot.health)}/20，饥饿 ${numberText(bot.food)}/20`);
  parts.push(
    `第 ${bot.time.day ?? '?'} 天 ${clockLabel(bot.time.timeOfDay)}，${
      bot.time.isDay ? '白天' : '夜晚'
    }，${weatherLabel()}`
  );
  parts.push(`手持${bot.heldItem ? itemLabel(bot.heldItem.name) : '空手'}`);
  parts.push(`护甲：${armorSummary()}`);
  const items = bot.inventory.items();
  const inventoryText = items
    .slice(0, 8)
    .map((item) => `${itemLabel(item.name)} x${item.count}`)
    .join('、');
  parts.push(
    items.length > 0
      ? `背包：${inventoryText}${items.length > 8 ? ` 等 ${items.length} 种` : ''}`
      : '背包是空的'
  );
  const players = nearbyPlayers(radius);
  parts.push(
    players.length > 0
      ? `附近玩家：${players
          .map((entry) => `${entry.name} ${entry.distance.toFixed(1)} 格`)
          .join('、')}`
      : '附近没有玩家'
  );
  const hostiles = nearbyHostiles(radius);
  parts.push(
    hostiles.length > 0
      ? `敌对生物：${hostiles
          .map((entry) => `${entry.name} ${entry.distance.toFixed(1)} 格`)
          .join('、')}`
      : '附近没有敌对生物'
  );
  const filter = String(args.block || '').trim();
  if (filter) {
    const block = bot.registry.blocksByName[filter];
    if (!block) throw new Error(`未知方块 ${filter}`);
    const positions = bot.findBlocks({ matching: block.id, maxDistance: radius, count: 3 });
    parts.push(
      positions.length > 0
        ? `附近${blockLabel(filter)}：${positions
            .map((entry) => `(${entry.x}, ${entry.y}, ${entry.z})`)
            .join('、')}`
        : `附近没有${blockLabel(filter)}`
    );
  }
  return parts.join('；');
}

function signedDistance(value) {
  const rounded = Math.round(Number(value) * 10) / 10;
  if (rounded === 0) return '0';
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}

function locateBlock(args) {
  const name = String(args.block || '').trim();
  if (!name) throw new Error('需要方块 ID');
  const block = bot.registry.blocksByName[name];
  if (!block) throw new Error(`未知方块 ${name}`);
  const radius = Math.min(Math.max(Number(args.radius) || 32, 1), 64);
  const limit = Math.min(Math.max(Math.trunc(Number(args.limit)) || 5, 1), 16);
  const positions = bot.findBlocks({ matching: block.id, maxDistance: radius, count: limit });
  if (positions.length === 0) {
    throw new Error(`附近 ${radius} 格内没有${blockLabel(name)}`);
  }
  const origin = bot.entity.position;
  const candidates = positions
    .map((position) => ({
      position,
      distance: position.distanceTo(origin),
      vertical: position.y - origin.y,
    }))
    .sort((left, right) => left.distance - right.distance);
  const nearest = candidates[0];
  const nearestText = `最近的是 (${nearest.position.x}, ${nearest.position.y}, ${
    nearest.position.z
  })，距离 ${nearest.distance.toFixed(1)} 格，垂直差 ${signedDistance(nearest.vertical)}`;
  const others = candidates
    .slice(1)
    .map(
      (entry) =>
        `(${entry.position.x}, ${entry.position.y}, ${entry.position.z}) 距离 ${entry.distance.toFixed(
          1
        )} 格，垂直差 ${signedDistance(entry.vertical)}`
    )
    .join('；');
  return `找到 ${candidates.length} 个${blockLabel(name)}，${nearestText}${
    others ? `；还有 ${others}` : ''
  }`;
}

const ENTITY_TYPE_LABELS = {
  player: '玩家',
  mob: '生物',
  animal: '动物',
  hostile: '敌对生物',
  item: '掉落物',
  object: '物体',
  projectile: '投掷物',
  vehicle: '载具',
};

function entityMatches(entity, type, name) {
  if (type) {
    const wanted = type.toLowerCase();
    const rawType = String(entity.type || '').toLowerCase();
    const entityName = String(entity.name || '').toLowerCase();
    const username = entity.type === 'player' ? playerNameOf(entity).toLowerCase() : '';
    const matched =
      rawType === wanted ||
      entityName === wanted ||
      username === wanted ||
      (wanted === 'hostile' && HOSTILE_MOBS.has(entity.name));
    if (!matched) return false;
  }
  if (name) {
    const wanted = name.toLowerCase();
    const names = [entity.name, entity.username];
    if (entity.type === 'player') names.push(playerNameOf(entity));
    if (
      !names.filter(Boolean).some((entry) => String(entry).toLowerCase() === wanted)
    ) {
      return false;
    }
  }
  return true;
}

function entityTypeLabel(entity) {
  if (entity.type === 'player') return '玩家';
  if (HOSTILE_MOBS.has(entity.name)) return '敌对生物';
  return ENTITY_TYPE_LABELS[entity.type] || entity.type || '实体';
}

function entityDisplayName(entity) {
  if (entity.type === 'player') return playerNameOf(entity);
  return blockLabel(String(entity.name || entity.displayName || entity.type || '实体'));
}

function locateEntity(args) {
  const type = String(args.type || '').trim();
  const name = String(args.name || '').trim();
  const radius = Math.min(Math.max(Number(args.radius) || 32, 1), 64);
  const limit = Math.min(Math.max(Math.trunc(Number(args.limit)) || 5, 1), 16);
  const origin = bot.entity.position;
  const results = Object.values(bot.entities)
    .filter((entity) => entity !== bot.entity && entity.position)
    .filter((entity) => entity.position.distanceTo(origin) <= radius)
    .filter((entity) => entityMatches(entity, type, name))
    .map((entity) => ({
      name: entityDisplayName(entity),
      type: entityTypeLabel(entity),
      distance: entity.position.distanceTo(origin),
      position: entity.position,
    }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, limit);
  if (results.length === 0) {
    const conditions = [type ? `类型 ${type}` : '', name ? `名字 ${name}` : ''].filter(Boolean);
    throw new Error(
      `附近 ${radius} 格内没有${
        conditions.length > 0 ? `符合条件的实体（${conditions.join('、')}）` : '实体'
      }`
    );
  }
  return `附近 ${radius} 格内有 ${results.length} 个实体：${results
    .map(
      (entry) =>
        `${entry.name}（${entry.type}，${entry.distance.toFixed(1)} 格，位于 ${Math.floor(
          entry.position.x
        )}, ${Math.floor(entry.position.y)}, ${Math.floor(entry.position.z)}）`
    )
    .join('；')}`;
}

function isSleepTime() {
  const timeOfDay = Number(bot.time.timeOfDay);
  return timeOfDay >= 12541 && timeOfDay <= 23458;
}

function isThunderstorm() {
  return Boolean(bot.isRaining) && Number(bot.thunderState || 0) > 0;
}

function findNearbyBed(range) {
  return bot.findBlock({
    matching: (block) => block != null && (block.name === 'bed' || block.name.endsWith('_bed')),
    maxDistance: range,
  });
}

function sleepErrorText(message) {
  const text = String(message || '');
  if (/too far/i.test(text)) return '床太远了，走不到能点击床的位置';
  if (/occupied/i.test(text)) return '床已经被占用了';
  if (/monsters nearby/i.test(text)) return '床附近有敌对生物';
  if (/not night/i.test(text)) return '现在不是夜晚，也不是雷暴';
  if (/not sleeping/i.test(text)) return '躺下后没有进入睡眠，可能被服务器拒绝了';
  if (/already sleeping/i.test(text)) return '已经在睡觉了';
  if (/only half bed/i.test(text)) return '这张床只剩下一半';
  if (/cant click/i.test(text)) return '现在点不到这张床';
  if (/wrong block/i.test(text)) return '目标不是床';
  return text || '未知原因';
}

function sleepAdvancedTime(beforeTime, beforeDay) {
  return timeAdvanced(beforeTime, beforeDay, bot);
}

async function sleepInBed(range = 16) {
  const dimension = String(bot.game.dimension || '').toLowerCase();
  if (dimension.includes('nether')) {
    throw new Error('这里是下界，不能正常睡觉，床会爆炸');
  }
  if (dimension.includes('end')) throw new Error('这里是末地，不能正常睡觉');
  if (bot.isSleeping) throw new Error('我已经在睡觉了');
  if (!isSleepTime() && !isThunderstorm()) {
    throw new Error(`现在是 ${clockLabel(bot.time.timeOfDay)}，不是夜晚也没有雷暴，不能睡觉`);
  }
  const bed = findNearbyBed(range);
  if (!bed) throw new Error(`附近 ${range} 格内没有床，先放一张床再睡`);
  const bedPosition = `(${bed.position.x}, ${bed.position.y}, ${bed.position.z})`;
  const hostile = findHostile(8);
  if (hostile) {
    const distance = bot.entity.position.distanceTo(hostile.position);
    throw new Error(`附近有${blockLabel(hostile.name)}，距离 ${distance.toFixed(1)} 格，先清掉再睡`);
  }
  if (bot.entity.position.distanceTo(bed.position) > 2.5) {
    try {
      await travelTo(bed.position.x, bed.position.y, bed.position.z, 2);
    } catch (error) {
      throw new Error(`床在 ${bedPosition}，但走不到床边：${error.message}`);
    }
  }
  if (interrupted) throw new Error('被新的指令打断');
  const bedDistance = bot.entity.position.distanceTo(bed.position);
  if (bedDistance > 4) {
    throw new Error(`床在 ${bedPosition}，但还差 ${bedDistance.toFixed(1)} 格，走不到床边`);
  }
  const nearbyHostile = findHostile(8);
  if (nearbyHostile) {
    const distance = bot.entity.position.distanceTo(nearbyHostile.position);
    throw new Error(`附近有${blockLabel(nearbyHostile.name)}，距离 ${distance.toFixed(1)} 格，先清掉再睡`);
  }
  if (!isSleepTime() && !isThunderstorm()) {
    throw new Error(`走到床边时天已经亮了，现在是 ${clockLabel(bot.time.timeOfDay)}，不能睡觉`);
  }
  try {
    await bot.sleep(bed);
  } catch (error) {
    throw new Error(`没能睡到床上：${sleepErrorText(error.message)}`);
  }
  return {
    detail: bot.isSleeping
      ? `已经躺在床上睡着了，床在 ${bedPosition}`
      : `已收到床睡眠确认，正在等世界时间更新，床在 ${bedPosition}`,
    bedSleepAcknowledged: true,
  };
}

async function approach(target) {
  if (!target || !target.position) return;
  try {
    return await approachEntity(bot, target, goals.GoalFollow);
  } catch (error) {
    log('接近目标失败', error.message);
    return false;
  }
}

async function retreatFrom(target) {
  if (!target || !target.position || retreatActive) return false;
  retreatActive = true;
  const position = bot.entity.position;
  const origin = { x: position.x, y: position.y, z: position.z };
  const encounter = assessCombatEncounter({
    entities: bot.entities,
    origin,
    registry: bot.registry,
    health: bot.health,
    radius: 24,
    currentTarget: target,
    equipment: combatEquipment(bot),
  });
  const threats = [...encounter.threats];
  if (!threats.some((entry) => entry.entity === target)) {
    threats.push({
      entity: target,
      name: String(target.name || '').toLowerCase(),
      distance: position.distanceTo(target.position),
      closing_speed: 0,
      fusing: false,
      score: 0,
    });
  }
  const destination = chooseRetreatDestination(origin, threats, { stepDistance: 12 });
  const safetyBefore = retreatSafetyScore(origin, threats);
  let movedAway = false;
  const movements = bot.pathfinder.movements;
  const nether = ['the_nether', 'minecraft:the_nether'].includes(bot.game.dimension);
  const coast = ['overworld', 'minecraft:overworld'].includes(bot.game.dimension)
    && (dryMiningFooting(bot, position) || ['drowned', 'creeper'].includes(target.name));
  const previous = (nether || coast) && movements && { allowParkour: movements.allowParkour, canDig: movements.canDig,
    infiniteLiquidDropdownDistance: movements.infiniteLiquidDropdownDistance,
    maxDropDown: movements.maxDropDown, exclusionAreasStep: movements.exclusionAreasStep };
  try {
    if (previous) {
      const stayDry = coast && dryMiningFooting(bot, position);
      Object.assign(movements, {allowParkour: false, canDig: false, maxDropDown: 1, infiniteLiquidDropdownDistance: false,
        exclusionAreasStep: [...previous.exclusionAreasStep, block =>
          !block?.position || besideDrop(bot, block.position) ? 1000 : stayDry ? miningRouteExclusion(bot, block) : 0]});
    }
    const trailed = await retreatAlongTrail({
      trail: retreatTrail.snapshot(bot.game?.dimension),
      currentPosition: () => bot?.entity?.position,
      makeGoal: (point) => new goals.GoalNear(point.x, point.y, point.z, 1),
      gotoWaypoint: (goal, timeout) => gotoWithTimeout(bot.pathfinder, goal, timeout, '沿来路撤退超时'),
      safetyScore: (point) => retreatSafetyScore(point, threats),
      isSafe: (point) => {
        if (executor.active?.token?.cancelled || !bot?.entity) return false;
        const position = vec(point.x, point.y, point.z);
        const floor = bot.blockAt(position.offset(0, -1, 0));
        const feet = bot.blockAt(position);
        const head = bot.blockAt(position.offset(0, 1, 0));
        if (!floor || floor.boundingBox !== 'block' || waterLike(floor)
            || !feet || feet.boundingBox !== 'empty' || waterLike(feet)
            || !head || head.boundingBox !== 'empty' || waterLike(head)) return false;
        if (/lava|fire|magma|cactus|campfire|powder_snow|berry_bush/.test(floor.name)) return false;
        return !threats.some((entry) => entry.entity?.isValid !== false && entry.entity?.position?.distanceTo(position) < 3);
      },
      timeoutMs: 3000,
      maxWaypoints: 4,
    });
    if (trailed) {
      log('已沿来路撤退');
      return true;
    }
    if (!destination || executor.active?.token?.cancelled) return false;
    let goal = new goals.GoalXZ(destination.x, destination.z);
    if (coast) {
      const heading = Math.atan2(destination.z - position.z, destination.x - position.x);
      const candidates = [];
      for (const distance of [10, 5]) for (const angle of [0, -Math.PI/4, Math.PI/4, -Math.PI/2, Math.PI/2]) {
        const column = position.floored().offset(Math.round(distance * Math.cos(heading + angle)), 0,
                                                 Math.round(distance * Math.sin(heading + angle)));
        const stand = [0, 1, -1, 2, -2, 3].map(dy => column.offset(0, dy, 0)).find(p =>
          dryMiningFooting(bot, p) && !besideDrop(bot, p));
        if (stand && retreatSafetyScore(stand, threats) > safetyBefore) candidates.push(stand);
      }
      candidates.sort((a, b) => retreatSafetyScore(b, threats) - retreatSafetyScore(a, threats));
      if (!candidates.length) return false;
      const safe = candidates[0];
      goal = new goals.GoalBlock(safe.x, safe.y, safe.z);
    } else if (nether) {
      const column = vec(Math.floor(destination.x), Math.floor(position.y), Math.floor(destination.z));
      const safe = [0, 1, -1, 2, -2].map(dy => column.offset(0, dy, 0)).find(p =>
        dryMiningFooting(bot, p) && !netherRouteExclusion(bot, {position: p}) && !besideDrop(bot, p));
      if (!safe) return false;
      goal = new goals.GoalBlock(safe.x, safe.y, safe.z);
    }
    await gotoWithTimeout(bot.pathfinder, goal, 4000, '后撤超时');
    const current = bot.entity.position;
    const actuallyMoved = current.distanceTo(origin) > 0.5;
    const safetyAfter = retreatSafetyScore(current, threats);
    movedAway = Boolean(
      actuallyMoved &&
      Number.isFinite(safetyBefore) &&
      safetyAfter > safetyBefore + 0.5
    );
  } catch (error) {
    log('后撤失败', error.message);
  } finally {
    // stop() 单独调用会把 stopPathing 留给下一个 setGoal/resetPath；同步清目标，避免下一条 goto 被 path_stop 打断。
    if (!interrupted) stopPathfinding();
    if (previous) Object.assign(movements, previous);
    retreatActive = false;
  }
  return movedAway;
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
    if (target.name === 'ender_dragon' && ranged.bow.name === 'bow') {
      const token = executor.active?.token;
      bot.activateItem();
      try {
        await sleep(850);
        if (token?.cancelled || target.isValid === false) return false;
        const start = target.position.clone(), sampledAt = performance.now();
        await sleep(250);
        if (token?.cancelled || target.isValid === false) return false;
        const motion = target.position.minus(start).scaled(50 / Math.max(1, performance.now() - sampledAt));
        const ticks = Math.min(35, bot.entity.position.distanceTo(target.position) / 2.7);
        const body = target.position.plus(motion.scaled(ticks)).offset(0, 2, 0);
        const aim = crystalAimPoint(bot, target, body);
        if (!aim) return false;
        await bot.lookAt(aim, true);
        return !token?.cancelled;
      } finally {
        bot.deactivateItem();
      }
    }
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

async function attackEntity(target, { allowTargetSwitch = false, encounterRadius = 16, emergencyHunt = false, dryDefense = false } = {}) {
  await equipWeapon();
  const requestedTarget = target;
  let activeTarget = target;
  let switchedTargets = false;
  let hits = 0;
  let meleeReady = true;

  const updateEncounter = async () => {
    const decision = await evaluateEncounterStep({
      entities: bot.entities,
      behindFloor: entity => hostileBehindCover(entity, emergencyHunt),
      origin: bot.entity.position,
      registry: bot.registry,
      health: bot.health,
      radius: encounterRadius,
      requestedTarget,
      currentTarget: activeTarget,
      allowTargetSwitch,
      equipment: combatEquipment(bot),
      retreat: retreatFrom,
    });
    if (decision.status === 'retreated') {
      if (interrupted) throw new Error('被新的指令打断');
      const requestedName = blockLabel(requestedTarget.name);
      const movement = decision.moved_away ? '已拉开距离' : '后撤未确认';
      throw new Error(
        `还差指定目标 ${requestedName}；${decision.encounter.retreat_reason}，${movement}，未完成目标`,
      );
    }
    if (!decision.switched || !decision.target) return false;
    const previousName = blockLabel(activeTarget.name);
    activeTarget = decision.target;
    switchedTargets = true;
    log('群怪威胁变化，切换目标', `${previousName} → ${blockLabel(activeTarget.name)}`);
    return true;
  };

  const healthFloor = emergencyHunt && !allowTargetSwitch && HUNTABLE.includes(target.name) ? 2 : 4;
  for (let index = 0; index < 20 && activeTarget.isValid !== false && bot.health > healthFloor; index += 1) {
    if (interrupted) throw new Error('被新的指令打断');
    await updateEncounter();
    let distance = activeTarget.position
      ? bot.entity.position.distanceTo(activeTarget.position)
      : 0;
    const isEnderman = String(activeTarget.name || '').toLowerCase() === 'enderman';
    const flying =
      activeTarget.name === 'phantom' ||
      (!isEnderman && activeTarget.position && activeTarget.position.y - bot.entity.position.y > 2.5);
    if (flying) {
      await bot.lookAt(activeTarget.position.offset(0, activeTarget.height * 0.7, 0), true);
      if (await updateEncounter()) continue;
      if (!isEnderman && findRangedWeapon() && distance > 3.5) {
        if (await shootAt(activeTarget)) {
          hits += 1;
          meleeReady = false;
          await updateEncounter();
          await sleep(700);
          continue;
        }
      }
      if (distance <= 3.5) {
        if (!meleeReady) {
          await equipWeapon();
          meleeReady = true;
        }
        bot.attack(activeTarget);
        hits += 1;
      }
      await sleep(500);
      continue;
    }
    if (!isEnderman && findRangedWeapon() && distance > 6 && await shootAt(activeTarget)) {
      hits += 1;
      meleeReady = false;
      await updateEncounter();
      await sleep(700);
      continue;
    }
    if (!meleeReady) {
      await equipWeapon();
      meleeReady = true;
    }
    if (distance > 3) {
      const reached = await approach(activeTarget);
      if (interrupted) throw new Error('被新的指令打断');
      if (!reached && dryDefense) {
        const moved = await retreatFrom(activeTarget);
        return moved ? '干地上无法接敌，已撤离' : '干地路线受阻，停止追击';
      }
      if (await updateEncounter()) continue;
    }
    distance = activeTarget.position
      ? bot.entity.position.distanceTo(activeTarget.position)
      : 0;
    await bot.lookAt(activeTarget.position.offset(0, activeTarget.height * 0.8, 0), true);
    if (await updateEncounter()) continue;
    bot.attack(activeTarget);
    hits += 1;
    await sleep(600);
  }
  if (activeTarget.isValid === false) {
    const name = blockLabel(activeTarget.name);
    const switched = switchedTargets && activeTarget !== requestedTarget
      ? `，已按威胁优先级切换目标`
      : '';
    return hits === 0 ? `目标消失了，没有打中${switched}` : `击败了 ${name}，${hits} 次攻击${switched}`;
  }
  const name = blockLabel(activeTarget.name);
  const requested = activeTarget !== requestedTarget
    ? `；原指定的${blockLabel(requestedTarget.name)}仍在`
    : '';
  return `攻击了 ${name} ${hits} 次，它还在${requested}`;
}

async function defendAgainst(target) {
  if (combatBusy) return;
  combatBusy = true;
  lastCombatAt = Date.now();
  try {
    wanderActive = false;
    // 清除上一条路径和 stop() 的延迟标志，再让撤退/接近逻辑创建新 goto。
    stopPathfinding();
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
    const dryDefense = ['overworld', 'minecraft:overworld'].includes(bot.game?.dimension)
      && bot.pathfinder?.movements && dryMiningFooting(bot, bot.entity.position);
    const fight = () => attackEntity(target, {allowTargetSwitch: true, encounterRadius: 16, dryDefense: Boolean(dryDefense)});
    const detail = dryDefense ? await withDryGroundMovement(bot, fight) : await fight();
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
  const movements = bot.pathfinder.movements;
  const previous = { canDig: movements.canDig, allowParkour: movements.allowParkour, allow1by1towers: movements.allow1by1towers,
    allowSprinting: movements.allowSprinting, maxDropDown: movements.maxDropDown };
  try {
    const target = pickWanderTarget();
    if (target) {
      resetPathfinderGoal();
      Object.assign(movements, { canDig: false, allowParkour: false, allow1by1towers: false, allowSprinting: false, maxDropDown: 1 });
      await gotoWithTimeout(bot.pathfinder, new goals.GoalBlock(target.x, target.y, target.z), 4000, '避险换位超时',
        () => bot.entity.position);
      if (dryMiningFooting(bot, bot.entity.position)) log('离开了危险位置');
    }
  } catch (error) {
    log('离开危险位置失败', error.message);
  } finally {
    Object.assign(movements, previous);
    escapeBusy = false;
    lastActivity = Date.now();
  }
}

function blockIsWater(block) {
  return waterLike(block);
}

let waterEscapeBusy = false;
let waterEscapeRequired = false;
async function swimToShore(reason, token = null, timeoutMs = 25000, radius = 12, connected = false) {
  if (waterEscapeBusy) return false;
  waterEscapeBusy = true;
  try {
    log('水中自救', reason);
    const started = Date.now();
    if (!await escapeWater(bot, { token, timeoutMs, radius })) return false;
    const remaining = Math.max(0, timeoutMs - (Date.now() - started));
    const placeLanding = async p => {
      if (!countItem('cobblestone') || token?.cancelled) return false;
      try {
        await placeBlock({block: 'cobblestone', x: p.x, y: p.y, z: p.z});
        return true;
      } catch {
        return false;
      }
    };
    const landed = await reachShore(bot, { token, timeoutMs: remaining, radius, connected, placeLanding });
    log(landed ? '水中自救已靠岸' : '已恢复呼吸但未找到安全岸边');
    return landed;
  } finally {
    waterEscapeBusy = false;
  }
}

function waterTick() {
  if (!bot || !bot.entity) return;
  const feet = bot.blockAt(bot.entity.position);
  const head = bot.blockAt(bot.entity.position.offset(0, 1, 0));
  const eye = bot.blockAt(bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0));
  const oxygen = bot.oxygenLevel;
  if (breathable(eye) && eye.name !== 'bubble_column' && Number.isFinite(oxygen) && oxygen >= 19) waterEscapeRequired = false;
  const inWater = blockIsWater(feet) || blockIsWater(head) || blockIsWater(eye);
  if (!inWater) return;
  const stationWork = ['craft', 'smelt', 'smelt_batch'].includes(executor.active?.tool);
  if (Number.isFinite(oxygen) && (oxygen <= 8 || waterEscapeRequired || (stationWork && waterLike(eye) && oxygen < 19))) {
    waterEscapeRequired = true;
    reportReflexEvent('low_oxygen', { oxygen, health: bot.health, food: bot.food });
  }
}

function reportReflexEvent(event, data, cooldownMs = 3000) {
  if (bot?.entity?.position) data = { ...data, position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } };
  const now = Date.now();
  const key = `${event}:${data?.source_id ?? data?.entity_id ?? ''}`;
  if (now - (reflexSentAt.get(key) || 0) < cooldownMs) return false;
  reflexSentAt.set(key, now);
  if (reflexSentAt.size > 128) {
    for (const [entry, at] of reflexSentAt) {
      if (now - at > 30000) reflexSentAt.delete(entry);
    }
  }
  const interruptedAction = executor.active;
  const safetyActionId = enqueueLocalSafety(event, data);
  if (!socket || socket.readyState !== WebSocket.OPEN) return Boolean(safetyActionId);
  const action = interruptedAction ? {
    action_id: interruptedAction.id,
    skill_id: interruptedAction.tool || '',
    phase: interruptedAction.token?.phase || 'running',
  } : null;
  const phase = interruptedAction?.token?.phase || 'detected';
  const eventData = {
    ...data,
    session_id: sessionId,
    state_revision: stateRevision,
    action_id: interruptedAction?.id || null,
    action,
    phase,
    safety_action_id: safetyActionId,
    executor_epoch: executor.epoch,
  };
  socket.send(JSON.stringify({
    type: 'reflex_event',
    event,
    data: eventData,
    session_id: sessionId,
    state_revision: stateRevision,
    action_id: interruptedAction?.id || null,
    action,
    safety_action_id: safetyActionId,
    phase,
    executor_epoch: executor.epoch,
    executor: executor.snapshot(),
  }));
  return true;
}

function enqueueLocalSafety(event, data) {
  return reflexScheduler.dispatch(event, data);
}

function nearbyDragonCloud() {
  if (!['the_end', 'minecraft:the_end'].includes(bot?.game?.dimension)) return null;
  const pos = bot.entity.position;
  return Object.values(bot.entities).find(e => e?.name === 'area_effect_cloud' && e.isValid !== false && e.position &&
    Math.abs(e.position.y - pos.y) < 4 && Math.hypot(e.position.x - pos.x, e.position.z - pos.z) < 7);
}

async function evadeDragonHazard(threat, token, stillThreatened) {
  const origin = bot.entity.position.floored();
  const destinations = [];
  for (const [dx, dz] of [[8,0],[-8,0],[0,8],[0,-8],[6,6],[-6,6],[6,-6],[-6,-6]]) {
    for (let dy = 3; dy >= -3; dy--) {
      const target = origin.offset(dx, dy, dz);
      if (dryMiningFooting(bot, target)) {
        destinations.push(target);
        break;
      }
    }
  }
  destinations.sort((a, b) => b.distanceTo(threat.position) - a.distanceTo(threat.position));
  for (const p of destinations.slice(0, 3)) {
    if (token.cancelled || !stillThreatened()) return;
    try {
      await gotoWithTimeout(bot.pathfinder, new goals.GoalNear(p.x, p.y, p.z, 1), 2500, '末地避险换位超时', () => bot.entity.position);
    } catch (error) {
      if (token.cancelled) throw error;
    }
  }
}

async function runLocalSafety(event, data, token) {
  if (token.cancelled) throw new Error(token.cancelReason || '安全动作已取消');
  if (event === 'low_oxygen') {
    if (await swimToShore(`本地避险 oxygen=${data.oxygen}`, token, 30000)) return;
    throw new Error('水中自救超时，未确认抵达安全岸边');
  }
  if (await leaveMagmaBlock(bot, token, sleep)) return;
  const cloud = nearbyDragonCloud();
  if (cloud) {
    await evadeDragonHazard(cloud, token, nearbyDragonCloud);
    return;
  }
  if (event === 'critical_hunger') {
    if (Number(bot.food ?? 20) <= 8 && findFood()) await eatIfPossible();
    return;
  }
  const source = Number.isInteger(data.source_id) ? bot.entities[String(data.source_id)] : null;
  if (source?.name === 'ender_dragon' && ['the_end', 'minecraft:the_end'].includes(bot.game.dimension)) {
    // 专项战斗负责瞄准飞龙；局部避险只在贴身时拉开距离。
    await evadeDragonHazard(source, token, () => source.isValid !== false && bot.entity.position.distanceTo(source.position) < 10);
    return;
  }
  const hostile = source && ((source.type === 'mob' || source.type === 'hostile') || HOSTILE_MOBS.has(source.name))
    ? source
    : findHostile(event === 'hostile_nearby' ? 12 : 8);
  if (hostile) {
    if (bot.health <= 8 || ['creeper', 'drowned'].includes(hostile.name) || hostile.name === 'magma_cube' && event === 'hostile_nearby') {
      await retreatFrom(hostile);
      if (bot.health <= 10 && findFood()) await eatIfPossible();
    } else {
      await defendAgainst(hostile);
    }
    return;
  }
  if (data.source_type === 'player' && source) {
    await retreatFrom(source);
  } else if (bot.health <= 10 && bot.entity.onGround && dryMiningFooting(bot, bot.entity.position)
      && !netherRouteExclusion(bot, { position: bot.entity.position.floored() })) {
    // 已脱离接触且站稳时留在原地恢复，避免低血量触发随机跑动、再次跌落。
    if (bot.food < 20 && findFood()) await eatIfPossible();
  } else {
    await escapeEnvironment();
    if (bot.health <= 10 && findFood()) await eatIfPossible();
  }
}

function queueArmorMaintenance() {
  if (!bot?.armorManager || !botReady || !terrainReady) return;
  if (executor.active?.tool === 'armor_maintenance' || actionQueue.some((task) => task.tool === 'armor_maintenance')) return;
  executor.enqueue({
    id: `armor-${randomUUID()}`,
    tool: 'armor_maintenance',
    kind: 'maintenance',
    priority: 8,
    onCancel: (reason, status, token) => cancelActiveWorldWork(reason, status, token),
    run: async () => {
      await bot.armorManager.equipAll();
      return { status: 'succeeded', detail: '护甲整理完成' };
    },
  });
}

function onDamaged(source) {
  const now = Date.now();
  if (now - lastHurtAt < 1200) return;
  lastHurtAt = now;
  lastActivity = now;
  if (source && source.id !== undefined) {
    log('伤害来源', describeEntity(source), source.type || 'unknown');
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
  reportReflexEvent('damage', {
    source_id: Number.isInteger(source?.id) ? source.id : null,
    source_type: String(source?.type || ''),
    source_name: String(source?.name || ''),
    health: bot.health,
    food: bot.food,
    position: {
      x: bot.entity.position.x,
      y: bot.entity.position.y,
      z: bot.entity.position.z,
    },
  }, 1000);
}

function survivalTick() {
  if (!bot || !bot.entity || bot.isSleeping) return;
  const cloud = nearbyDragonCloud();
  if (cloud) {
    reportReflexEvent('hostile_nearby', { entity_id: cloud.id, entity_name: cloud.name, health: bot.health, food: bot.food }, 1500);
    return;
  }
  const seekingFood = executor.active?.token?.seekingEmergencyFood && bot.health > 2 && !findHostile(12)
    && !bot.entity.isInWater && !bot.entity.isInLava && (bot.entity.onGround || bot.entity.velocity.y > -0.5);
  if (bot.health <= 8 && !seekingFood) {
    reportReflexEvent('low_health', { health: bot.health, food: bot.food, position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } }, 5000);
  }
  if (shouldInterruptForHunger(bot.food, findFood())) {
    reportReflexEvent('critical_hunger', { health: bot.health, food: bot.food }, 8000);
  }
  const hostile = findHostile(16);
  if (hostile) {
    // 末地的末影人也会追打撞到它的龙。靠近已激怒的末影人时，由实际受击事件确认是否需要反击。
    if (hostile.name === 'enderman' && ['the_end', 'minecraft:the_end'].includes(bot.game.dimension)) return;
    const distance = bot.entity.position.distanceTo(hostile.position);
    if (executor.active?.token?.leavingMiningThreat && distance <= 8) {
      const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
      const screened = [0.25, (hostile.height || 1.8) * 0.85].every(height => {
        const ray = hostile.position.offset(0, height, 0).minus(eye);
        const length = ray.norm();
        return length > 0 && bot.world.raycast(eye, ray.scaled(1 / length), length);
      });
      if (screened) return;
    }
    if (distance <= 8 && Date.now() - lastCreeperWarnAt > 10000) {
      lastCreeperWarnAt = Date.now();
      reportReflexEvent(
        'hostile_nearby',
        {
          entity_id: Number.isInteger(hostile.id) ? hostile.id : null,
          entity_name: String(hostile.name || ''),
          distance,
          health: bot.health,
          food: bot.food,
        },
        8000,
      );
    }
  }
}

function findAttackTarget(args) {
  const range = Math.min(Math.max(Number(args.range) || 16, 3), 32);
  if (args.id !== undefined) {
    const entity = bot.entities[String(args.id)];
    if (entity && entity.position) return entity;
  }
  const name = String(args.name || '').toLowerCase();
  const type = String(args.type || '').toLowerCase();
  return bot.nearestEntity((entity) => {
    if (!entity.position || entity === bot.entity) return false;
    if (entity.position.distanceTo(bot.entity.position) > range) return false;
    if (name) {
      const label = String(entity.name || entity.username || '').toLowerCase();
      if (label !== name) return false;
    }
    if (type === 'hostile') {
      return (entity.type === 'hostile' || entity.type === 'mob') &&
        HOSTILE_MOBS.has(entity.name) &&
        (Boolean(name) || isAutomaticCombatTarget(entity, bot.registry));
    }
    if (type === 'player') return entity.type === 'player';
    if (type) {
      return String(entity.type || '').toLowerCase() === type || String(entity.name || '').toLowerCase() === type;
    }
    return (entity.type === 'hostile' || entity.type === 'mob') &&
      HOSTILE_MOBS.has(entity.name) &&
      (Boolean(name) || isAutomaticCombatTarget(entity, bot.registry));
  });
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
  return assessCombatEncounter({
    entities: bot.entities,
    behindFloor: hostileBehindCover,
    origin: bot.entity.position,
    registry: bot.registry,
    health: bot.health,
    radius: range,
    equipment: combatEquipment(bot),
  }).primary?.entity || null;
}

async function equipWeapon() {
  const weapon = bestMeleeWeapon(bot);
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

function pickWanderTarget(heading = null, visited = new Set()) {
  const base = bot.entity.position;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const angle = heading === null ? Math.random() * Math.PI * 2 : heading + (Math.random() - 0.5) * Math.PI;
    const radius = heading === null ? 5 + Math.random() * 5 : 10 + Math.random() * 6;
    const x = Math.floor(base.x + Math.cos(angle) * radius);
    const z = Math.floor(base.z + Math.sin(angle) * radius);
    if (visited.has(`${x},${z}`)) continue;
    for (let dy = 2; dy >= -4; dy -= 1) {
      const ground = bot.blockAt(vec(x, Math.floor(base.y) + dy, z));
      if (!ground || ground.boundingBox !== 'block') continue;
      const target = ground.position.offset(0, 1, 0);
      if (target.distanceTo(base) >= 3 && dryMiningFooting(bot, target)
          && !netherRouteExclusion(bot, { position: target }) && !isNearDanger(target)) return target;
    }
  }
  return null;
}

async function exploreResource(step, heading, search = { visited: new Set() }) {
  if (externalCancelReason()) return 'cancelled';
  if (Number.isFinite(bot.health) && bot.health <= COLLECT_LOW_HEALTH) {
    throw new Error(`血量不足（血量 ${bot.health}），停止资源探索`);
  }
  if (nearbyHostiles(10).length) throw new Error('附近有敌对生物，停止资源探索');
  const target = pickWanderTarget(heading, search.visited);
  if (!target) return 'no_target';
  search.visited.add(`${target.x},${target.z}`);
  log('资源未找到，移动后继续搜索', `${step + 1}/5`, `(${target.x}, ${target.y}, ${target.z})`);
  const movements = bot.pathfinder?.movements;
  const previous = movements && {
    canDig: movements.canDig,
    allow1by1towers: movements.allow1by1towers,
    allowParkour: movements.allowParkour,
  };
  let outcome;
  try {
    if (movements) {
      movements.canDig = false;
      movements.allow1by1towers = false;
      movements.allowParkour = false;
    }
    outcome = await walkOnce(target.x, target.y, target.z, 1, 12000);
  } finally {
    if (movements) Object.assign(movements, previous);
  }
  if (externalCancelReason()) return 'cancelled';
  if (Number.isFinite(bot.health) && bot.health <= COLLECT_LOW_HEALTH) {
    throw new Error(`血量不足（血量 ${bot.health}），停止资源探索`);
  }
  if (nearbyHostiles(10).length) throw new Error('移动后发现敌对生物，停止资源探索');
  return outcome;
}

function startWander() {
  if (!bot || !bot.entity || wanderActive || !bot.pathfinder) return false;
  const target = pickWanderTarget();
  if (!target) return false;
  wanderActive = true;
  const id = `wander-${randomUUID()}`;
  wanderActionId = id;
  const origin = bot.entity.position.clone();
  executor.enqueue({
    id,
    tool: 'idle_wander',
    kind: 'resident',
    priority: 9,
    onCancel: (reason, status, token) => cancelActiveWorldWork(reason, status, token),
    run: async () => {
      log('开始闲逛', `目标 (${target.x}, ${target.y}, ${target.z})`);
      bot.pathfinder.movements.allowSprinting = false;
      try {
        await gotoWithDeadline(new goals.GoalNear(target.x, target.y, target.z, 1), 12000, '闲逛超时');
        if (!interrupted) await bot.look(bot.entity.yaw + (Math.random() - 0.5) * 1.4, 0, true);
        return { status: 'succeeded', detail: '闲逛完成' };
      } catch (error) {
        return { status: interrupted ? 'cancelled' : 'partial', detail: error.message };
      } finally {
        lastActivity = Date.now();
        if (bot?.pathfinder?.movements) bot.pathfinder.movements.allowSprinting = true;
        if (bot?.entity) {
          const position = bot.entity.position;
          log('闲逛结束', `走了 ${position.distanceTo(origin).toFixed(1)} 格，位置 (${position.x}, ${position.y}, ${position.z})`);
        }
      }
    },
    onResult: () => {
      wanderActive = false;
      if (wanderActionId === id) wanderActionId = '';
    },
  });
  return true;
}

function idleTick() {
  if (INDEPENDENT) return;
  if (!bot || !bot.entity || bot.isSleeping || followSession || actionBusy || wanderActive || combatBusy) return;
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
  followSession = {
    name: player.username,
    distance,
    actionId: currentActionId,
    startedAt: Date.now(),
  };
}

async function runFollow(player, distance, token) {
  startFollow(player, distance);
  const session = followSession;
  const startedAt = Date.now();
  log('开始跟随', player.username, `距离 ${distance}`);
  try {
    while (!token.cancelled && Date.now() - startedAt < 5 * 60 * 1000) {
      const target = bot.players[session.name]?.entity;
      if (!target || target.isValid === false) throw new Error(`玩家 ${session.name} 已离开视野，停止跟随`);
      const gap = bot.entity.position.distanceTo(target.position);
      if (gap <= distance + 0.2) {
        bot.setControlState('sprint', false);
        await bot.lookAt(target.position.offset(0, 1.6, 0), true);
        await sleep(250);
        continue;
      }
      if (bot.pathfinder.movements) bot.pathfinder.movements.allowSprinting = gap > distance + 8;
      try {
        await gotoWithDeadline(new LiveFollowGoal(target, distance), 30000, '跟随寻路超时');
      } catch (error) {
        if (token.cancelled || interrupted) throw error;
        log('跟随寻路未完成，稍后重试', error.message);
        await sleep(500);
      }
    }
    if (!token.cancelled && Date.now() - startedAt >= 5 * 60 * 1000) {
      throw new Error('跟随超过 5 分钟，自动停止');
    }
  } finally {
    if (followSession === session) stopFollow();
  }
}

function stopFollow() {
  if (followSession) {
    log('已停止跟随', followSession.name);
  }
  followSession = null;
  // 服务器断开时 bot 可能还没加载 pathfinder 插件，这里必须容错，否则整个桥接进程会退出。
  if (bot && bot.pathfinder) {
    bot.pathfinder.setGoal(null);
    bot.pathfinder.stop();
    if (bot.pathfinder.movements) {
      bot.pathfinder.movements.allowSprinting = true;
    }
    bot.setControlState('sprint', false);
    bot.clearControlStates();
  }
}

function stopResidentMovement(reason = '收到新的前台动作') {
  if (followSession && followSession.actionId) {
    executor.cancel(followSession.actionId, reason, 'cancelled');
  }
  if (wanderActionId) executor.cancel(wanderActionId, reason, 'cancelled');
}

function cancelActiveWorldWork(reason, status, token) {
  interrupted = true;
  for (const cancelHook of [...(token?.cancelHooks || [])]) {
    try {
      cancelHook();
    } catch {
      // 取消监听失败不能阻止 pathfinder 与容器清理。
    }
  }
  if (bot) {
    if (bot.pathfinder) {
      bot.pathfinder.setGoal(null);
      bot.pathfinder.stop();
    }
    bot.stopDigging();
    bot.clearControlStates();
  }
  if (followSession && (!token || followSession.actionId === token.actionId)) {
    stopFollow();
  }
  if (wanderActionId && (!token || wanderActionId === token.actionId)) {
    wanderActive = false;
    wanderActionId = '';
  }
}

const STOP_INTENT = /(别跟|不要跟|不用跟|别再跟|别过来|不用过来|停下|站住|停住)/;

function isStopIntent(text) {
  return STOP_INTENT.test(String(text || ''));
}

function createBot() {
  applyProtocol767ItemFormat();
  retreatTrail.clear();
  if (INDEPENDENT) {
    log('独立模式已启用：不向玩家索要坐标，不跟随玩家');
  }
  bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    auth: config.auth,
    version: config.version || undefined,
  });
  bot.once('login', () => correctMiningMaterials(bot.registry));
  bot.loadPlugin(pathfinder);
  installArmorManagerApi(bot, armorManager);
  bot.loadPlugin(toolModule.plugin || toolModule);
  bot.on('physicsTick', () => {
    if (botReady && terrainReady && bot?.entity && !executor.safetyActive) {
      const position = bot.entity.position;
      const floor = bot.blockAt(position.offset(0, -1, 0));
      const feet = bot.blockAt(position);
      if (floor?.boundingBox === 'block' && !waterLike(floor) && feet && !waterLike(feet)) {
        retreatTrail.record(position, bot.game?.dimension);
      }
    }
  });
  // 窗口状态编号必须一直跟踪：自己发的 window_click 要把最新编号回传给服务端，
  // 只有在 craftItem 里才开启跟踪的话，箱子等窗口第一次点击会被服务端按编号不符忽略。
  trackCraftStateId();
  // 服务器没开时，底层 socket 会抛未捕获的 error 直接结束进程；这里接住并等重连。
  if (bot._client && typeof bot._client.on === 'function') {
    bot._client.on('error', (error) => log('连接 Minecraft 失败', error.message));
  }

  installBridgeSessionLifecycle({
    bot,
    client: bot._client,
    getIdentity: () => ({ sessionId, revision: stateRevision }),
    setIdentity: (identity) => {
      sessionId = identity.sessionId;
      stateRevision = identity.revision;
    },
    createSessionId: randomUUID,
    isDeathPending: () => deathPending,
    onRespawn: ({ deathRespawn }) => {
      log(deathRespawn ? '已重生' : '收到维度切换 respawn 包');
      stopPathfinding();
      bot.clearControlStates();
      if (deathRespawn) {
        lastHealth = 20;
        respawnReady = true;
      }
      botReady = true;
      terrainReady = false;
      startTerrainReadinessCheck(deathRespawn ? 'respawn' : 'dimension_change');
    },
  });

  bot.once('spawn', () => {
    log('已进入世界');
    botReady = true;
    terrainReady = false;
    const movements = new Movements(bot);
    const originalStop = bot.pathfinder.stop.bind(bot.pathfinder);
    bot.pathfinder.stop = (...args) => {
      if (currentTool) {
        const stack = new Error('stop-trace').stack.split('\n').slice(1, 5).join(' | ');
        log('pathfinder.stop', currentTool, stack);
      }
      return originalStop(...args);
    };
    movements.canDig = true;
    movements.allow1by1towers = true;
    movements.allowParkour = true;
    movements.allowSprinting = true;
    movements.canOpenDoors = true;
    movements.maxDropDown = 4;
    movements.liquidCost = 12;
    movements.exclusionAreasStep.push((block) => netherRouteExclusion(bot, block));
    movements.exclusionAreasPlace.push((block) => avoidWaterScaffolding(bot, block));
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
    if (!armorTimer) armorTimer = setInterval(queueArmorMaintenance, 15000);
    const stateTimer = setInterval(sendState, 5000);
    bot.once('end', () => clearInterval(stateTimer));
    startTerrainReadinessCheck('spawn');
    sendState();
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    lastActivity = Date.now();
    lastPlayerChatAt = Date.now();
    lastDistanceAsk = 0;
    if (wanderActionId) executor.cancel(wanderActionId, '玩家发言，停止闲逛', 'cancelled');
    if (followSession && isStopIntent(message)) {
      log('收到停止跟随指令', username, message);
      executor.cancel(followSession.actionId, '玩家要求停止跟随', 'cancelled');
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'chat', player: username, text: message }));
  });

  bot.on('entityHurt', (entity, source) => {
    if (!bot.entity || !entity || entity.id !== bot.entity.id) return;
    onDamaged(source);
  });

  bot.on('health', () => {
    const snapshot = worldHealthSnapshot(bot.health);
    if (!snapshot) return;
    if (!snapshot.alive) {
      lastHealth = 0;
      return;
    }
    if (lastHealth === null) {
      lastHealth = snapshot.health;
      sendState();
      return;
    }
    if (snapshot.health < lastHealth - 0.5) {
      setTimeout(() => {
        if (Date.now() - lastHurtAt > 500) onDamaged(null);
      }, 300);
    }
    lastHealth = snapshot.health;
    sendState();
  });

  bot.on('death', () => {
    log('死亡，准备请求重生');
    lastHealth = 20;
    deathPending = true;
    deathLifecycleId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    respawnReady = false;
    actionBlockStatus = 'dead';
    botReady = false;
    terrainReady = false;
    terrainReadinessGeneration += 1;
    executor.block('dead', '玩家角色死亡');
    wanderActive = false;
    wanderActionId = '';
    queueLifecycleEvent('death');
    requestRespawn();
  });

  // 1.19.3 起客户端用 client_command(actionId=0) 请求重生，服务端回应 clientbound_respawn。
  function requestRespawn() {
    setTimeout(() => {
      if (!bot || !bot._client) return;
      try {
        bot._client.write('client_command', { actionId: 0 });
        log('已发送重生请求');
      } catch (error) {
        log('重生请求失败', error.message);
      }
    }, 1200);
  }

  bot.on('error', (error) => log('mineflayer 错误', error.message));
  bot.on('kicked', (reason) => log('被服务器踢出', reason));
  bot.on('end', () => {
    log('与 Minecraft 的连接结束，5 秒后重连');
    botReady = false;
    terrainReady = false;
    terrainReadinessGeneration += 1;
    actionBlockStatus = 'disconnected';
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'world_unavailable', reason: 'minecraft_disconnected' }));
    }
    executor.block('disconnected', 'Minecraft connection lost');
    wanderActive = false;
    wanderActionId = '';
    clearTimeout(botReconnectTimer);
    botReconnectTimer = setTimeout(reconnectBotWhenIdle, 5000);
  });
}

function reconnectBotWhenIdle() {
  if (executor.active) {
    botReconnectTimer = setTimeout(reconnectBotWhenIdle, 1000);
    return;
  }
  bot = null;
  createBot();
}

function sendLifecycleEvent(event) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(event));
  return true;
}

function queueLifecycleEvent(type) {
  const position = bot.entity?.position;
  storeLifecycleEvent(pendingLifecycleEvents, type, deathLifecycleId, {
        health: bot.health,
        inventory: Object.fromEntries(
          (bot.inventory?.items?.() || []).map((item) => [item.name, item.count])
        ),
        position: position ? { x: position.x, y: position.y, z: position.z } : null,
        dimension: bot.game?.dimension || '',
        time: Number(bot.time?.timeOfDay ?? -1),
        day: Number(bot.time?.day ?? -1),
  });
  return flushLifecycleEvents();
}

function flushLifecycleEvents() {
  for (const event of pendingLifecycleEvents) {
    if (!sendLifecycleEvent(event)) return false;
  }
  return true;
}

function acknowledgeLifecycleEvent(message) {
  const lifecycleId = String(message.lifecycle_id || '');
  const type = String(message.event_type || '');
  if (!lifecycleId || !type) return;
  removeLifecycleEvent(pendingLifecycleEvents, type, lifecycleId);
  unblockExecutorIfReady();
}

function buildStateObservation() {
  stateRevision += 1;
  return createObservation(bot, {
    sessionId,
    revision: stateRevision,
    ready: ordinaryActionReady(),
    executor: executor.snapshot(),
    nearbyOwnedCraftingTable: Boolean(ownedTableNearby(bot, temporaryCraftingTable)),
    nearbyFoodAnimal: Boolean(terrainReady && bot?.health <= 10 && bot?.food < 18 && nearbyFoodAnimal(bot)),
    nearbyCraftingTable: Boolean(bot?.entity && terrainReady && nearbyBlock('crafting_table', 4)),
    netherMiningHostiles: bot?.entity && terrainReady && String(bot.game?.dimension).endsWith('the_nether')
      ? nearbyHostiles(8) : null,
    shelter: !bot?.entity || (rememberedShelter?.dimension && rememberedShelter.dimension !== String(bot.game?.dimension || ''))
      ? null
      : rememberedShelter,
    makeVec: (x, y, z) => vec(x, y, z),
  });
}

function ordinaryActionReady(allowWaterEscape = false) {
  const terrainReadable = terrainReady && positionTerrainReadable();
  if (terrainReady && !terrainReadable) startTerrainReadinessCheck('position_unloaded');
  return Boolean(
    bot?.entity && botReady && terrainReady && terrainReadable &&
    !deathPending && pendingLifecycleEvents.length === 0 &&
    !actionBlockStatus && (!waterEscapeRequired || allowWaterEscape) && socket?.readyState === WebSocket.OPEN && !executor.safetyActive
  );
}

function currentPositionTerrain() {
  if (!bot?.entity) return inspectPositionTerrain(null, () => null);
  return inspectPositionTerrain(bot.entity.position, ({ x, y, z }) => bot.blockAt(vec(x, y, z)));
}

function positionTerrainReadable() {
  return currentPositionTerrain().readable;
}

function unblockExecutorIfReady() {
  if (
    !bot?.entity || !botReady || !terrainReady || deathPending ||
    pendingLifecycleEvents.length > 0 || socket?.readyState !== WebSocket.OPEN
  ) return false;
  if (!positionTerrainReadable()) {
    startTerrainReadinessCheck('position_unloaded');
    return false;
  }
  actionBlockStatus = '';
  executor.unblock();
  return true;
}

function startTerrainReadinessCheck(reason) {
  const candidateBot = bot;
  const candidateSession = sessionId;
  const generation = ++terrainReadinessGeneration;
  terrainReady = false;
  if (!candidateBot?.entity) return;

  void (async () => {
    let lastDiagnostic = '';
    let lastLogAt = 0;
    while (
      generation === terrainReadinessGeneration && candidateBot === bot &&
      candidateSession === sessionId && botReady && !terrainReady
    ) {
      try {
        if (typeof candidateBot.waitForChunksToLoad === 'function') {
          await candidateBot.waitForChunksToLoad();
        }
      } catch (error) {
        const now = Date.now();
        const detail = String(error?.message || error);
        if (detail !== lastDiagnostic || now - lastLogAt >= 5000) {
          lastDiagnostic = detail;
          lastLogAt = now;
          log('等待当前位置区块失败', reason, detail);
        }
      }
      if (
        generation !== terrainReadinessGeneration || candidateBot !== bot ||
        candidateSession !== sessionId || !botReady
      ) return;

      const terrain = currentPositionTerrain();
      if (terrain.readable) {
        terrainReady = true;
        log('当前位置区块可读', reason, JSON.stringify(terrain));
        finishRespawnIfIdle();
        unblockExecutorIfReady();
        queueArmorMaintenance();
        sendState();
        return;
      }

      const diagnostic = JSON.stringify(terrain);
      const now = Date.now();
      if (diagnostic !== lastDiagnostic || now - lastLogAt >= 5000) {
        lastDiagnostic = diagnostic;
        lastLogAt = now;
        log('等待当前位置地形可读', reason, diagnostic);
      }
      await sleep(500);
    }
  })();
}

function sendState() {
  if (bot?.entity && !INDEPENDENT) checkPlayerDistance();
  const observation = buildStateObservation();
  if (observation && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'state', data: observation }));
  }
  return observation;
}

function rememberRequestedShelter(shelter) {
  const position = shelter?.position;
  const size = Number(shelter?.size);
  if (!position || ![position.x, position.y, position.z].every((value) => Number.isFinite(Number(value)))) return false;
  if (![3, 4, 5].includes(size)) return false;
  rememberedShelter = {
    position: { x: Math.floor(Number(position.x)), y: Math.floor(Number(position.y)), z: Math.floor(Number(position.z)) },
    size,
    dimension: String(bot?.game?.dimension || ''),
  };
  return true;
}

connectCore();
createBot();
setInterval(survivalTick, 1000);
setInterval(waterTick, 500);

process.on('SIGINT', () => {
  log('收到退出信号');
  if (bot) bot.quit();
  if (socket) socket.close();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  log('Bridge 未捕获异常', error?.stack || error?.message || String(error));
  if (bot?.pathfinder) {
    bot.pathfinder.setGoal(null);
    bot.pathfinder.stop();
    bot.clearControlStates();
  }
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'world_unavailable', reason: 'bridge_uncaught_exception' }));
  }
  setTimeout(() => process.exit(1), 100);
});

process.on('unhandledRejection', (reason) => {
  log('Bridge 未处理 Promise 拒绝', reason?.stack || reason?.message || String(reason));
});

process.on('exit', (code) => {
  log('Bridge 进程退出', `code=${code}`, `tool=${currentTool || 'idle'}`, `action=${currentActionId || 'none'}`);
});
