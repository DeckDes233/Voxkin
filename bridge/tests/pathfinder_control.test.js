import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import goto from 'mineflayer-pathfinder/lib/goto.js';
import { gotoWithTimeout, stopPathfinderAndClearGoal } from '../pathfinder_control.js';

test('an empty path cannot report arrival eight blocks away', async () => {
  const pathfinder = { goto: async () => {} };
  const goal = { isEnd: p => p.x === 8 };
  await assert.rejects(gotoWithTimeout(pathfinder, goal, 50, '', () => ({ floored: () => ({ x: 0 }) })), { name: 'NoPath' });
  await gotoWithTimeout(pathfinder, goal, 50, '', () => ({ floored: () => ({ x: 8 }) }));
});

function makePathfinder(bot) {
  return {
    goal: null,
    stopping: false,
    stop() { this.stopping = true; },
    setGoal(goal) {
      this.goal = goal;
      bot.emit('goal_updated', goal);
      if (this.stopping) {
        this.stopping = false;
        this.goal = null;
        bot.emit('path_stop');
      }
    },
    goto(goal) { return goto(bot, goal); },
  };
}

test('寻路超时清空 goal、结束真实 goto 监听器，并允许后续寻路', async () => {
  const bot = new EventEmitter();
  bot.pathfinder = makePathfinder(bot);
  await assert.rejects(gotoWithTimeout(bot.pathfinder, {}, 10), { name: 'CollectTimeout' });
  assert.equal(bot.pathfinder.goal, null);
  assert.equal(bot.pathfinder.stopping, false);
  assert.equal(bot.listenerCount('goal_updated'), 0);
  const next = gotoWithTimeout(bot.pathfinder, {}, 1000);
  bot.emit('goal_reached');
  await next;
  assert.equal(bot.listenerCount('goal_updated'), 0);
});

test('先调用 stop() 会让紧随其后的撤退 goto 收到 PathStopped', async () => {
  const bot = new EventEmitter();
  bot.pathfinder = makePathfinder(bot);

  bot.pathfinder.stop();

  await assert.rejects(bot.pathfinder.goto({ id: 'retreat' }), { name: 'PathStopped' });
  assert.equal(bot.pathfinder.stopping, false);
  assert.equal(bot.listenerCount('path_stop'), 0);
});

test('清除软停止标志后撤退 goto 可启动并到达路点', async () => {
  const bot = new EventEmitter();
  bot.pathfinder = makePathfinder(bot);

  bot.pathfinder.stop();
  assert.equal(stopPathfinderAndClearGoal(bot.pathfinder), true);
  const retreat = bot.pathfinder.goto({ id: 'retreat' });
  bot.emit('goal_reached');

  await retreat;
  assert.equal(bot.pathfinder.stopping, false);
  assert.equal(bot.listenerCount('path_stop'), 0);
});
