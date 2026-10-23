import assert from 'node:assert/strict';
import test from 'node:test';

import { skills } from '../skills/survival.js';

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
    sleepAdvancedTime: (beforeTime, beforeDay) =>
      bot.time.day !== beforeDay || Math.abs(bot.time.timeOfDay - beforeTime) >= 1000,
    async sleepInBed() {
      bot.isSleeping = true;
      return '已躺下';
    },
    async sleep() {
      bot.time.timeOfDay = 1000;
      bot.time.day += 1;
      bot.isSleeping = false;
    },
  };
  return { bot, ctx };
}

test('sleep_safe waits until waking and time advancement before success', async () => {
  const world = makeWorld();

  const result = await skills.sleep_safe.handler({}, world.ctx);

  assert.equal(result.status, 'succeeded');
  assert.match(result.detail, /已经离开床/);
  assert.equal(world.bot.isSleeping, false);
  assert.equal(world.bot.time.day, 2);
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
