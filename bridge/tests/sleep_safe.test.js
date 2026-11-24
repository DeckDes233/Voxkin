import assert from 'node:assert/strict';
import test from 'node:test';

import { skills, timeAdvanced } from '../skills/survival.js';
import { ExecutionController } from '../execution_controller.js';
import { LocalReflexScheduler } from '../local_reflex.js';

function makeWorld({ timeOfDay = 13000, day = 1, isSleeping = false } = {}) {
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    game: { dimension: 'overworld' },
    time: { timeOfDay, day },
    health: 20,
    isSleeping,
    async wake() {
      this.isSleeping = false;
    },
  };
  const bed = { position: { x: 1, y: 64, z: 0 } };
  const ctx = {
    bot,
    findNearbyBed: () => bed,
    isSleepTime: () => bot.time.timeOfDay >= 12541,
    isThunderstorm: () => false,
    sleepAdvancedTime: (beforeTime, beforeDay) => timeAdvanced(beforeTime, beforeDay, bot),
    async sleepInBed() {
      bot.isSleeping = true;
      return { detail: '已躺下', bedSleepAcknowledged: true };
    },
    async sleep() {
      bot.time.timeOfDay = 1000;
      bot.time.day += 1;
      bot.isSleeping = false;
    },
  };
  return { bot, ctx };
}

test('等待天亮被敌人抢占时让出执行权，天亮也不能覆盖抢占回执', async () => {
  const { bot } = makeWorld();
  const controller = new ExecutionController();
  const events = [];
  let wake;
  const gate = new Promise(resolve => { wake = resolve; });
  controller.enqueue({
    id: 'wait-day', tool: 'wait_for_day', priority: 10,
    run: token => skills.wait_for_day.handler({}, {
      bot, sleep: () => gate, get interrupted() { return token.cancelled; },
    }),
    onResult: result => events.push(`wait:${result.status}`),
  });
  const reflex = new LocalReflexScheduler({
    executor: controller,
    idFactory: () => 'hostile',
    run: async () => { events.push('defend'); return { status: 'succeeded' }; },
  });
  assert.equal(reflex.dispatch('hostile_nearby', { health: 20 }), 'hostile');
  assert.equal(controller.status('wait-day').status, 'preempting');
  assert.deepEqual(events, []);
  bot.time.timeOfDay = 1000;
  wake();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['wait:preempted', 'defend']);
  assert.equal(controller.status('wait-day').status, 'preempted');
  assert.equal(controller.status('hostile').status, 'succeeded');
});

test('sleep_safe waits until waking and time advancement before success', async () => {
  const world = makeWorld();

  const result = await skills.sleep_safe.handler({}, world.ctx);

  assert.equal(result.status, 'succeeded');
  assert.match(result.detail, /已经离开床/);
  assert.equal(world.bot.isSleeping, false);
  assert.equal(world.bot.time.day, 2);
});

test('sleep_safe waits for the world-time packet when wake arrives first', async () => {
  const world = makeWorld({ timeOfDay: 13093, day: 1 });
  let polls = 0;
  world.ctx.sleepInBed = async () => {
    world.bot.isSleeping = true;
    world.bot.isSleeping = false;
    return { detail: '床睡眠确认已收到', bedSleepAcknowledged: true };
  };
  world.ctx.sleep = async () => {
    polls += 1;
    if (polls === 4) {
      world.bot.time.timeOfDay = 64;
      world.bot.time.day = 2;
    }
  };

  const result = await skills.sleep_safe.handler({}, world.ctx);

  assert.equal(result.status, 'succeeded');
  assert.match(result.detail, /床睡眠确认已收到/);
  assert.equal(world.bot.time.day, 2);
  assert.equal(world.bot.time.timeOfDay, 64);
  assert.equal(polls, 4);
});

test('sleep_safe does not accept daylight without a bed sleep acknowledgement', async () => {
  const world = makeWorld({ timeOfDay: 13093, day: 1 });
  world.ctx.sleepInBed = async () => {
    world.bot.time.timeOfDay = 64;
    world.bot.time.day = 2;
    return { detail: '只看到天亮', bedSleepAcknowledged: false };
  };

  await assert.rejects(
    skills.sleep_safe.handler({}, world.ctx),
    /没有收到床睡眠确认/,
  );
});

test('sleep_safe rejects a bed sleep acknowledgement without forward time progress', async () => {
  const world = makeWorld({ timeOfDay: 13093, day: 1 });
  world.ctx.sleepInBed = async () => {
    world.bot.isSleeping = false;
    return { detail: '床睡眠确认已收到', bedSleepAcknowledged: true };
  };
  world.ctx.sleep = async () => {};

  await assert.rejects(
    skills.sleep_safe.handler({}, world.ctx),
    /游戏时间没有推进/,
  );
});

test('sleep time confirmation uses the synchronized day and tick delta', () => {
  assert.equal(timeAdvanced(13093, 1, { time: { timeOfDay: 64, day: 2 } }), true);
  assert.equal(timeAdvanced(13093, 1, { time: { timeOfDay: 12000, day: 1 } }), false);
  assert.equal(timeAdvanced(13093, 2, { time: { timeOfDay: 15000, day: 1 } }), false);
});

test('sleep_safe recognizes a bot already sleeping when daylight arrives', async () => {
  const world = makeWorld({ timeOfDay: 1000, day: 2, isSleeping: true });

  const result = await skills.sleep_safe.handler({}, world.ctx);

  assert.equal(result.status, 'succeeded');
  assert.match(result.detail, /本来就在睡/);
  assert.equal(world.bot.isSleeping, false);
});

test('sleep_safe rejects daytime when the bot is awake', async () => {
  const world = makeWorld({ timeOfDay: 1000, day: 2 });

  await assert.rejects(
    skills.sleep_safe.handler({}, world.ctx),
    /不是夜晚也没有雷暴/,
  );
});

test('sleep_safe wakes the bot and stops waiting after cancellation', async () => {
  const world = makeWorld();
  world.ctx.sleep = async () => {
    world.ctx.interrupted = true;
  };

  await assert.rejects(
    skills.sleep_safe.handler({}, world.ctx),
    /睡觉被新的指令打断/,
  );
  assert.equal(world.bot.isSleeping, false);
});
