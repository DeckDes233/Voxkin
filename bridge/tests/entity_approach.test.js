import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { approachEntity } from '../entity_approach.js';
import { stopPathfinderAndClearGoal } from '../pathfinder_control.js';

class GoalFollow {
  constructor(entity, range) {
    this.entity = entity;
    this.range = range;
  }
}

function makeBot() {
  const bot = new EventEmitter();
  bot.entity = {
    position: {
      x: 0,
      y: 0,
      z: 0,
      distanceTo(position) {
        return Math.hypot(this.x - position.x, this.y - position.y, this.z - position.z);
      },
    },
  };
  bot.pathfinder = {
    goal: null,
    dynamic: false,
    stopPathing: false,
    setGoal(goal, dynamic = false) {
      this.goal = goal;
      this.dynamic = dynamic;
      bot.emit('goal_updated', goal, dynamic);
      if (this.stopPathing) {
        this.stopPathing = false;
        this.goal = null;
        bot.emit('path_stop');
      }
    },
    stop() { this.stopPathing = true; },
  };
  return bot;
}

test('approachEntity keeps following until the entity is within three blocks', async () => {
  const bot = makeBot();
  const target = { position: { x: 4, y: 0, z: 0 }, isValid: true };
  const approaching = approachEntity(bot, target, GoalFollow, { timeoutMs: 1000 });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(bot.pathfinder.goal instanceof GoalFollow);
  bot.entity.position.x = 2;
  assert.equal(await approaching, true);
});

test('approachEntity follows a moving entity with a dynamic goal', async () => {
  const bot = makeBot();
  const target = { position: { x: 12, y: 0, z: 0 }, isValid: true };
  const approaching = approachEntity(bot, target, GoalFollow, { timeoutMs: 1000 });
  const goal = bot.pathfinder.goal;

  assert.ok(goal instanceof GoalFollow);
  assert.equal(goal.entity, target);
  assert.equal(bot.pathfinder.dynamic, true);

  setTimeout(() => {
    target.position.x = 4;
    bot.entity.position.x = 4;
  }, 20);

  assert.equal(await approaching, true);
  assert.equal(bot.pathfinder.goal, null);
});

test('approachEntity does not replace an existing goal when already close', async () => {
  const bot = makeBot();
  const target = { position: { x: 2, y: 0, z: 0 }, isValid: true };

  assert.equal(await approachEntity(bot, target, GoalFollow), true);
  assert.equal(bot.pathfinder.goal, null);
});

test('approachEntity preserves a newer action goal when interrupted', async () => {
  const bot = makeBot();
  const target = { position: { x: 12, y: 0, z: 0 }, isValid: true };
  const approaching = approachEntity(bot, target, GoalFollow, { timeoutMs: 1000 });
  const newGoal = {};
  bot.pathfinder.setGoal(newGoal, false);

  await assert.rejects(approaching, /interrupted by another action/);
  assert.equal(bot.pathfinder.goal, newGoal);
});

test('action startup clears the real stop flag before approachEntity installs its first goal', async () => {
  const bot = makeBot();
  let pathStopEvents = 0;
  bot.on('path_stop', () => { pathStopEvents += 1; });
  bot.pathfinder.stop();
  assert.equal(bot.pathfinder.stopPathing, true);

  stopPathfinderAndClearGoal(bot.pathfinder);
  assert.equal(bot.pathfinder.stopPathing, false);
  assert.equal(bot.pathfinder.goal, null);
  const resetStopEvents = pathStopEvents;

  const target = { position: { x: 12, y: 0, z: 0 }, isValid: true };
  const approaching = approachEntity(bot, target, GoalFollow, { timeoutMs: 1000 });
  const firstGoal = bot.pathfinder.goal;
  setTimeout(() => {
    target.position.x = 4;
    bot.entity.position.x = 4;
  }, 20);

  assert.equal(await approaching, true);
  assert.ok(firstGoal instanceof GoalFollow, '首次动态导航目标必须存活，不得被残留 stop flag 清掉');
  assert.equal(pathStopEvents, resetStopEvents, '安装首次目标时不能触发 path_stop');
});
