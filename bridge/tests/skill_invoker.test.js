import assert from 'node:assert/strict';
import test from 'node:test';

import { createSkillInvoker } from '../skill_invoker.js';
import { skills as netherSkills } from '../skills/nether.js';
import { skills as combatSkills } from '../skills/combat.js';

function createContext(runSkill) {
  return { runSkill, sharedValue: 'same action context' };
}

test('nested skill invocation uses registered handlers and shares action context', async () => {
  const seen = [];
  const skills = {
    parent: {
      async handler(_args, ctx) {
        return ctx.runSkill('child', { count: 3 });
      },
    },
    child: {
      async handler(args, ctx) {
        seen.push({ args, sharedValue: ctx.sharedValue });
        return { status: 'succeeded', detail: 'child complete' };
      },
    },
  };
  const invoker = createSkillInvoker(skills, createContext, ['parent']);

  const result = await skills.parent.handler({}, invoker.context);

  assert.deepEqual(result, { status: 'succeeded', detail: 'child complete' });
  assert.deepEqual(seen, [{ args: { count: 3 }, sharedValue: 'same action context' }]);
});

test('nested skill invocation rejects unknown handlers', async () => {
  const invoker = createSkillInvoker({}, createContext, ['parent']);

  await assert.rejects(invoker.context.runSkill('missing'), /未知嵌套技能 missing/);
});

test('nested skill invocation rejects cycles and excessive depth', async () => {
  const cycle = createSkillInvoker({
    parent: { async handler(_args, ctx) { return ctx.runSkill('parent'); } },
  }, createContext, ['parent']);
  await assert.rejects(cycle.context.runSkill('parent'), /循环调用/);

  const deep = createSkillInvoker({
    a: { async handler(_args, ctx) { return ctx.runSkill('b'); } },
    b: { async handler(_args, ctx) { return ctx.runSkill('c'); } },
    c: { async handler() { return 'unreachable'; } },
  }, createContext, [], 2);
  await assert.rejects(deep.context.runSkill('a'), /最大深度 2/);
});

test('nested skill invocation observes the current action interrupt flag', async () => {
  const invoker = createSkillInvoker({
    parent: {
      async handler(_args, ctx) {
        return ctx.runSkill('child');
      },
    },
    child: {
      async handler() {
        throw new Error('child must not run after interrupt');
      },
    },
  }, (runSkill) => ({ ...createContext(runSkill), interrupted: true }));

  await assert.rejects(invoker.context.runSkill('parent'), /被当前动作打断/);
});

test('raid_fortress composes the registered fight_blaze skill through the shared context', async () => {
  const position = {
    x: 0,
    y: 64,
    z: 0,
    distanceTo(other) {
      return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
    },
  };
  const blaze = {
    id: 7,
    name: 'blaze',
    position: { ...position, x: 3 },
  };
  const bot = {
    game: { dimension: 'minecraft:the_nether' },
    entity: { position },
    entities: { [blaze.id]: blaze },
  };
  const skills = { ...netherSkills, ...combatSkills };
  const context = {
    bot,
    countItem: (name) => name === 'blaze_rod' ? 1 : 0,
    async sleep() {},
    log() {},
  };
  const invoker = createSkillInvoker(
    skills,
    (runSkill) => ({ ...context, runSkill }),
    ['raid_fortress'],
  );

  const result = await netherSkills.raid_fortress.handler(
    { blazes: 1, timeout_s: 10 },
    invoker.context,
  );

  assert.equal(result.status, 'succeeded');
  assert.match(result.detail, /烈焰棒现在 1 根/);
});
