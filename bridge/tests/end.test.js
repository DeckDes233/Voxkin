import assert from 'node:assert/strict';
import test from 'node:test';

import { createSkillInvoker } from '../skill_invoker.js';
import { skills as combatSkills } from '../skills/combat.js';
import { skills } from '../skills/end.js';

function makePosition(x = 0, y = 64, z = 0) {
  return {
    x,
    y,
    z,
    distanceTo(other) {
      return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
    },
  };
}

async function withFakeClock(run) {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    await run({
      sleep: async (ms) => {
        now += ms;
      },
    });
  } finally {
    Date.now = originalNow;
  }
}

function makeContext({ dimension = 'minecraft:the_end', dragon = true, portal = false } = {}) {
  const botPosition = makePosition();
  const dragonEntity = dragon
    ? { id: 1, name: 'ender_dragon', position: makePosition(0, 64, 0), health: 200 }
    : null;
  const blocks = portal
    ? [{ name: 'end_portal', position: makePosition(0, 63, 0) }]
    : [];
  const bot = {
    game: { dimension },
    entity: { position: botPosition, yaw: 0 },
    entities: dragonEntity ? { [dragonEntity.id]: dragonEntity } : {},
    inventory: { items: () => [] },
    health: 20,
    findBlocks({ matching }) {
      return blocks.filter(matching).map((block) => block.position);
    },
    setControlState() {},
  };
  const ctx = {
    bot,
    interrupted: false,
    countItem: () => 0,
    async sleep() {},
    async travelTo() {},
    async walkOnce() {},
    async approach() {},
    async attackEntity() {
      delete bot.entities[dragonEntity.id];
      dragonEntity.isValid = false;
      return 'attacked';
    },
    findRangedWeapon: () => null,
  };
  return { blocks, bot, ctx, dragonEntity };
}

test('return_home succeeds only after the return portal reaches the overworld', async () => {
  const { bot, ctx } = makeContext({ portal: true });
  ctx.walkOnce = async () => {
    bot.game.dimension = 'minecraft:overworld';
  };

  const result = await skills.return_home.handler({ timeout_s: 10 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.match(result.detail, /回到主世界/);
});

test('return_home rejects a portal transition to the wrong dimension', async () => {
  const { bot, ctx } = makeContext({ portal: true });
  ctx.walkOnce = async () => {
    bot.game.dimension = 'minecraft:the_nether';
  };

  await withFakeClock(async ({ sleep }) => {
    ctx.sleep = sleep;
    await assert.rejects(
      skills.return_home.handler({ timeout_s: 10 }, ctx),
      /没有回到主世界/,
    );
  });
});

test('throw_eye refuses to claim progress without enough direction data', async () => {
  const bot = {
    game: { dimension: 'minecraft:overworld' },
    entity: { position: makePosition(), yaw: 0 },
    entities: {},
    inventory: { items: () => [{ name: 'ender_eye' }] },
    async equip() {},
    async look() {},
    async activateItem() {},
    async deactivateItem() {},
    findBlocks: () => [],
  };
  const ctx = { bot, async sleep() {} };

  await withFakeClock(async ({ sleep }) => {
    ctx.sleep = sleep;
    await assert.rejects(
      skills.throw_eye.handler({ count: 1, timeout_s: 20 }, ctx),
      /方向数据不足/,
    );
  });
});

test('throw_eye reports an estimate as partial until stronghold frames are found', async () => {
  const bot = {
    game: { dimension: 'minecraft:overworld' },
    entity: { position: makePosition(), yaw: 0 },
    entities: {},
    inventory: { items: () => [{ name: 'ender_eye' }] },
    async equip() {},
    async look(yaw) {
      bot.entity.yaw = yaw;
    },
    async activateItem() {},
    async deactivateItem() {},
    findBlocks: () => [],
  };
  const destinations = [];
  const ctx = {
    bot,
    async sleep() {},
    async travelTo(x, y, z) {
      destinations.push({ x, y, z });
      bot.entity.position = makePosition(x, y, z);
      bot.entity.yaw = Math.PI / 2;
    },
  };

  await withFakeClock(async ({ sleep }) => {
    ctx.sleep = sleep;
    const result = await skills.throw_eye.handler(
      { count: 2, advance: 200, timeout_s: 20 },
      ctx,
    );

    assert.equal(result.status, 'partial');
    assert.match(result.detail, /两次投掷推算要塞大约在/);
    assert.match(result.detail, /已到达要塞估算点/);
    assert.deepEqual(destinations.at(-1), { x: 0, y: 64, z: 200 });
  });
});

test('throw_eye does not claim it reached the estimate when travel made no progress', async () => {
  const bot = {
    game: { dimension: 'minecraft:overworld' },
    entity: { position: makePosition(), yaw: 0 },
    entities: {},
    inventory: { items: () => [{ name: 'ender_eye' }] },
    async equip() {},
    async look(yaw) {
      bot.entity.yaw = yaw;
    },
    async activateItem() {},
    async deactivateItem() {},
    findBlocks: () => [],
  };
  let travelCalls = 0;
  const ctx = {
    bot,
    async sleep() {},
    async travelTo(x, y, z) {
      travelCalls += 1;
      if (travelCalls === 1) {
        bot.entity.position = makePosition(x + 10, y, z);
        bot.entity.yaw = Math.PI / 2;
      }
    },
  };

  await withFakeClock(async ({ sleep }) => {
    ctx.sleep = sleep;
    const result = await skills.throw_eye.handler(
      { count: 2, advance: 200, timeout_s: 20 },
      ctx,
    );

    assert.equal(result.status, 'partial');
    assert.match(result.detail, /无法到达要塞估算点/);
    assert.doesNotMatch(result.detail, /已到达要塞估算点/);
  });
});

test('throw_eye does not reuse direction records from an earlier search', async () => {
  const bot = {
    game: { dimension: 'minecraft:overworld' },
    entity: { position: makePosition(), yaw: 0 },
    entities: {},
    inventory: { items: () => [{ name: 'ender_eye' }] },
    async equip() {},
    async look() {},
    async activateItem() {},
    async deactivateItem() {},
    findBlocks: () => [],
  };
  const ctx = { bot, async sleep() {} };

  await withFakeClock(async ({ sleep }) => {
    ctx.sleep = sleep;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        skills.throw_eye.handler({ count: 1, timeout_s: 20 }, ctx),
        /方向数据不足/,
      );
    }
  });
});

test('fight_dragon does not treat a temporarily missing dragon as a kill', async () => {
  const { ctx } = makeContext({ portal: false });
  let attacks = 0;
  ctx.attackEntity = async () => {
    attacks += 1;
    delete ctx.bot.entities[1];
  };

  await withFakeClock(async ({ sleep }) => {
    ctx.sleep = sleep;
    await assert.rejects(
      skills.fight_dragon.handler({ timeout_s: 30 }, ctx),
      /还差 200 点血才能击杀末影龙/,
    );
  });
  assert.equal(attacks, 1);
});

test('fight_dragon accepts dragon absence only when the return portal is observed', async () => {
  const { ctx } = makeContext({ portal: true });
  ctx.attackEntity = async () => {
    delete ctx.bot.entities[1];
  };

  const result = await skills.fight_dragon.handler({ timeout_s: 30 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.match(result.detail, /确认中央返回传送门已出现/);
  assert.deepEqual(result.data, {
    events: ['ender_dragon_killed'],
    evidence: 'return_portal_present_dragon_absent',
  });
});

test('fight_dragon reports a structured kill event when dragon health reaches zero', async () => {
  const { ctx } = makeContext({ portal: false });
  ctx.attackEntity = async () => {
    ctx.bot.entities[1].health = 0;
  };

  let result;
  await withFakeClock(async ({ sleep }) => {
    ctx.sleep = sleep;
    result = await skills.fight_dragon.handler({ timeout_s: 30 }, ctx);
  });

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.data, {
    events: ['ender_dragon_killed'],
    evidence: 'dragon_health_zero',
  });
});

test('fight_dragon refuses to approach crystals without a ranged weapon', async () => {
  const { ctx } = makeContext();
  ctx.bot.entities[2] = {
    id: 2,
    name: 'end_crystal',
    position: makePosition(8, 70, 0),
  };
  let approaches = 0;
  ctx.approach = async () => {
    approaches += 1;
  };
  const registeredSkills = { ...skills, ...combatSkills };
  const invoker = createSkillInvoker(
    registeredSkills,
    (runSkill) => ({ ...ctx, runSkill }),
    ['fight_dragon'],
  );

  await assert.rejects(
    skills.fight_dragon.handler({ timeout_s: 30 }, invoker.context),
    /没有弓，不能远程破坏末地水晶/,
  );
  assert.equal(approaches, 0);
});

test('fight_dragon delegates crystal clearing to the registered safe skill', async () => {
  const { ctx } = makeContext({ portal: true });
  const crystal = {
    id: 2,
    name: 'end_crystal',
    position: makePosition(20, 80, 0),
  };
  ctx.bot.entities[2] = crystal;
  let delegatedArgs;
  ctx.runSkill = async (skillId, args) => {
    assert.equal(skillId, 'break_crystal');
    delegatedArgs = args;
    delete ctx.bot.entities[crystal.id];
    return { status: 'succeeded', detail: '水晶已清除' };
  };
  ctx.attackEntity = async () => {
    delete ctx.bot.entities[1];
  };

  const result = await skills.fight_dragon.handler({ timeout_s: 30 }, ctx);

  assert.equal(delegatedArgs.count, 0);
  assert.equal(delegatedArgs.safe_distance, 12);
  assert.equal(result.status, 'succeeded');
  assert.match(result.detail, /打碎 1 个末地水晶/);
});

test('fight_dragon rejects a delegated success when crystals remain in the world', async () => {
  const { ctx } = makeContext();
  ctx.bot.entities[2] = {
    id: 2,
    name: 'end_crystal',
    position: makePosition(20, 80, 0),
  };
  ctx.runSkill = async () => ({ status: 'succeeded', detail: 'reported success' });

  await assert.rejects(
    skills.fight_dragon.handler({ timeout_s: 30 }, ctx),
    /还差 1 个末地水晶没有打碎/,
  );
});

test('end skills stop before interacting when cancelled', async () => {
  const { ctx } = makeContext();
  ctx.interrupted = true;
  let attacks = 0;
  ctx.attackEntity = async () => {
    attacks += 1;
  };

  await assert.rejects(skills.fight_dragon.handler({}, ctx), /被新的指令打断/);
  assert.equal(attacks, 0);
});
