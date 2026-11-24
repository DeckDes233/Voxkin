import assert from 'node:assert/strict';
import test from 'node:test';

import { createSkillInvoker } from '../skill_invoker.js';
import { skills as combatSkills } from '../skills/combat.js';
import { isDragonPerched, isEndDimension, skills } from '../skills/end.js';

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
    return await run({
      sleep: async (ms) => {
        now += ms;
      },
    });
  } finally {
    Date.now = originalNow;
  }
}

function makeBlockPosition(x, y, z) {
  return {
    ...makePosition(x, y, z),
    offset(dx, dy, dz) {
      return makePosition(this.x + dx, this.y + dy, this.z + dz);
    },
  };
}

test('a dragon flying across the podium is distinguished from one actually sitting on it', () => {
  const position = makePosition(0, 66, 0);
  const bot = { entity: { position }, registry: { entitiesByName: { ender_dragon: { metadataKeys: ['phase'] } } } };
  assert.equal(isDragonPerched({ position, metadata: [0] }, bot), false);
  assert.equal(isDragonPerched({ position, metadata: [6] }, bot), true);
});

function makeStrongholdSearch({
  searchId = 's6-search-test',
  phase = 'descend',
  layers = 0,
  y = 64,
  maxLayers = 96,
  dimension = 'minecraft:overworld',
  resumeAllowed = false,
} = {}) {
  return {
    schema_version: 1,
    search_id: searchId,
    phase,
    resume_allowed: resumeAllowed,
    evidence: {
      kind: 'eye_overhead',
      throw_origin: { x: 10, y: 64, z: 20 },
      eye_position: { x: 15, y: 64, z: 20 },
      horizontal_distance: 5,
    },
    estimate: null,
    eye_accounting: {
      throws_completed: 1,
      inventory_before: 2,
      inventory_after: 1,
      inventory_net_change: -1,
    },
    position: { x: 10, y, z: 20 },
    descent: { layers_completed: layers, max_layers: maxLayers, segment_layers: 8 },
    scan: { fresh: true, stable: true, dimension, radius: 64, frames: [] },
  };
}

function makeContext({ dimension = 'minecraft:the_end', dragon = true, portal = false } = {}) {
  const botPosition = makeBlockPosition(0, 64, 0);
  const dragonEntity = dragon
    ? { id: 1, name: 'ender_dragon', position: makePosition(0, 64, 0), health: 200 }
    : null;
  const blocks = portal
    ? [{ name: 'end_portal', position: makePosition(1, 63, 0) }]
    : [];
  const bot = {
    game: { dimension },
    entity: { position: botPosition, yaw: 0 },
    entities: dragonEntity ? { [dragonEntity.id]: dragonEntity } : {},
    inventory: { items: () => [] },
    health: 20,
    blockAt(p) {
      return blocks.find(b => b.position.distanceTo(p) < 0.01) || { name: 'air' };
    },
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

test('end dimension detection accepts only the vanilla End identifiers', async () => {
  assert.equal(isEndDimension('minecraft:the_end'), true);
  assert.equal(isEndDimension('the_end'), true);
  assert.equal(isEndDimension(' Minecraft:THE_END '), true);
  assert.equal(isEndDimension('minecraft:overworld'), false);
  assert.equal(isEndDimension('minecraft:the_nether'), false);
  assert.equal(isEndDimension('custom:endless_realm'), false);
  assert.equal(isEndDimension('custom:the_endish'), false);
  assert.equal(isEndDimension('unknown'), false);
});

test('fight_dragon rejects a custom dimension whose identifier merely contains end', async () => {
  const { ctx } = makeContext({ dimension: 'custom:endless_realm' });

  await assert.rejects(
    skills.fight_dragon.handler({ timeout_s: 30 }, ctx),
    /末影龙只在末地/,
  );
});

test('activate_end_portal reports success after the server activates all frames and changes dimension', async () => {
  const frameOffsets = [
    [-1, -2], [0, -2], [1, -2],
    [-2, -1], [-2, 0], [-2, 1],
    [2, -1], [2, 0], [2, 1],
    [-1, 2], [0, 2], [1, 2],
  ];
  const frames = frameOffsets.map(([x, z]) => ({
    name: 'end_portal_frame',
    position: makeBlockPosition(x, 63, z),
    _properties: { eye: false },
  }));
  const portal = { name: 'end_portal', position: makeBlockPosition(0, 63, 0) };
  const botPosition = makePosition();
  let eyes = 12;
  let portalGenerated = false;
  const bot = {
    game: { dimension: 'minecraft:overworld' },
    entity: { position: botPosition, yaw: 0 },
    entities: {},
    inventory: {
      items() {
        return eyes > 0 ? [{ name: 'ender_eye', count: eyes }] : [];
      },
    },
    async equip() {},
    async lookAt() {},
    async activateBlock(frame) {
      frame._properties.eye = true;
      eyes -= 1;
      portalGenerated = frames.every((entry) => entry._properties.eye);
    },
    canSeeBlock: () => true,
    blockAt(position) {
      return frames.find((frame) =>
        frame.position.x === position.x &&
        frame.position.y === position.y &&
        frame.position.z === position.z,
      ) || (portalGenerated &&
        portal.position.x === position.x &&
        portal.position.y === position.y &&
        portal.position.z === position.z
        ? portal
        : null);
    },
    findBlocks({ matching }) {
      const candidates = portalGenerated ? [...frames, portal] : frames;
      return candidates.filter((block) => matching(block)).map((block) => block.position);
    },
  };
  const ctx = {
    bot,
    interrupted: false,
    countItem(name) {
      return name === 'ender_eye' ? eyes : 0;
    },
    async sleep() {},
    async travelTo() {},
    async walkOnce() {
      bot.game.dimension = 'minecraft:the_end';
    },
  };

  let result;
  await withFakeClock(async ({ sleep }) => {
    ctx.sleep = sleep;
    result = await skills.activate_end_portal.handler({ radius: 8, timeout_s: 20 }, ctx);
  });

  assert.equal(eyes, 0);
  assert.equal(frames.filter((frame) => frame._properties.eye).length, 12);
  assert.equal(portalGenerated, true);
  assert.equal(bot.game.dimension, 'minecraft:the_end');
  assert.equal(result.status, 'succeeded');
  assert.match(result.detail, /进入末地/);
});

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

test('throw_eye preserves a blocked receipt when direction data is insufficient', async () => {
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
    blockAt: () => null,
  };
  const ctx = { bot, async sleep() {} };

  await withFakeClock(async ({ sleep }) => {
    ctx.sleep = sleep;
    const result = await skills.throw_eye.handler({ count: 1, timeout_s: 20 }, ctx);
    assert.equal(result.status, 'partial');
    assert.equal(result.data.stronghold_search.phase, 'blocked');
    assert.equal(result.data.stronghold_search.estimate, null);
    assert.equal(result.data.stronghold_search.eye_accounting.throws_completed, 1);
    assert.equal(result.data.stronghold_search.evidence.kind, 'direction_insufficient');
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
    async activateItem() {
      const p = bot.entity.position;
      const id = Object.keys(bot.entities).length + 1;
      bot.entities[id] = { id, name: 'eye_of_ender', position: makePosition(p.x - (id === 1 ? 0 : 12), p.y + 8, p.z + (id === 1 ? 12 : 0)) };
    },
    async deactivateItem() {},
    findBlocks: () => [],
    blockAt: () => null,
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
    assert.deepEqual(destinations.at(-1), { x: 0, y: 64, z: 96 });
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
    async activateItem() {
      const p = bot.entity.position;
      const id = Object.keys(bot.entities).length + 1;
      bot.entities[id] = { id, name: 'eye_of_ender', position: makePosition(p.x - (id === 1 ? 0 : 12), p.y + 8, p.z + (id === 1 ? 12 : 0)) };
    },
    async deactivateItem() {},
    findBlocks: () => [],
    blockAt: () => null,
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

test('a resumed bearing scans for real frames before spending another eye', async () => {
  const frame = { name: 'end_portal_frame', position: makePosition(10, 64, 20) };
  const bot = { entity: { position: makePosition(10, 64, 20) }, game: { dimension: 'overworld' },
    findBlocks: () => [frame.position], blockAt: () => frame, canSeeBlock: () => true };
  const resume_search = { search_id: 'first', phase: 'bearing', scan: { dimension: 'overworld' },
    eye_accounting: { throws_completed: 2, inventory_before: 24 },
    evidence: { kind: 'eye_bearing', throw_origin: makePosition(), eye_position: makePosition(10, 72, 2) } };
  const receipt = await skills.throw_eye.handler({ count: 12, resume_search }, { bot, countItem: () => 22 });
  assert.equal(receipt.status, 'succeeded');
  assert.equal(receipt.data.stronghold_search.search_id, 'first');
  assert.equal(receipt.data.stronghold_search.eye_accounting.throws_completed, 2);
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
    blockAt: () => null,
  };
  const ctx = { bot, async sleep() {} };

  await withFakeClock(async ({ sleep }) => {
    ctx.sleep = sleep;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await skills.throw_eye.handler({ count: 1, timeout_s: 20 }, ctx);
      assert.equal(result.status, 'partial');
      assert.equal(result.data.stronghold_search.estimate, null);
      assert.equal(result.data.stronghold_search.eye_accounting.throws_completed, 1);
      assert.equal(result.data.stronghold_search.phase, 'blocked');
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

test('fight_dragon accepts dragon absence when the return portal appears during the observed fight', async () => {
  const { blocks, ctx } = makeContext({ portal: false });
  ctx.attackEntity = async () => {
    delete ctx.bot.entities[1];
    blocks.push({ name: 'end_portal', position: makePosition(1, 63, 0) });
  };

  const result = await skills.fight_dragon.handler({ timeout_s: 30 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.match(result.detail, /本次战斗期间出现/);
  assert.deepEqual(result.data, {
    events: ['ender_dragon_killed'],
    evidence: 'return_portal_appeared_dragon_absent',
  });
});

test('an injured fighter without arrows recovers before attacking a perched dragon', async () => {
  const { bot, ctx, dragonEntity } = makeContext();
  bot.health = 11;
  bot.food = 20;
  const actions = [];
  ctx.evadeDragon = async () => { actions.push('retreat'); bot.health = 18; };
  ctx.attackEntity = async () => { actions.push('attack'); dragonEntity.health = 0; };
  await withFakeClock(async ({ sleep }) => {
    ctx.sleep = sleep;
    await skills.fight_dragon.handler({ timeout_s: 30 }, ctx);
  });
  assert.deepEqual(actions, ['retreat', 'attack']);
});

test('a wounded fighter without arrows does not return to the podium during flight', async () => {
  const { bot, ctx, dragonEntity } = makeContext();
  bot.health = 12;
  bot.food = 20;
  dragonEntity.position = makePosition(30, 90, 20);
  ctx.travelTo = () => assert.fail('回到祭坛时仍未恢复');
  ctx.evadeDragon = async () => {
    bot.health = 18;
    dragonEntity.position = makePosition(0, 64, 0);
  };
  ctx.attackEntity = async () => { dragonEntity.health = 0; };
  await withFakeClock(async ({ sleep }) => {
    ctx.sleep = sleep;
    const result = await skills.fight_dragon.handler({timeout_s: 30}, ctx);
    assert.equal(result.status, 'succeeded');
  });
});

test('an unloaded central column cannot establish that the return portal was absent', async () => {
  const { ctx } = makeContext();
  let visible = false;
  ctx.bot.blockAt = () => visible ? { name: 'end_portal' } : null;
  ctx.attackEntity = async () => {
    delete ctx.bot.entities[1];
    visible = true;
  };
  await withFakeClock(async ({ sleep }) => {
    ctx.sleep = sleep;
    await assert.rejects(skills.fight_dragon.handler({ timeout_s: 30 }, ctx), /还差 200 点血/);
  });
});

test('fight_dragon does not emit a kill event for a pre-existing return portal with no visible dragon', async () => {
  const { ctx } = makeContext({ dragon: false, portal: true });

  const result = await skills.fight_dragon.handler({ timeout_s: 30 }, ctx);

  assert.equal(result.status, 'partial');
  assert.deepEqual(result.data, {
    evidence: 'return_portal_preexisting_dragon_absent',
    events: [],
  });
  assert.match(result.detail, /不报告本次击杀事件/);
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
  const { blocks, ctx } = makeContext();
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
    blocks.push({ name: 'end_portal', position: makePosition(1, 63, 0) });
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

test('throw_eye stores overhead evidence and measured inventory change without claiming a frame', async () => {
  const bot = {
    game: { dimension: 'minecraft:overworld' },
    entity: { position: makePosition(10, 64, 20), yaw: 0 },
    entities: {},
    health: 20,
    inventory: { items: () => [{ name: 'ender_eye', count: 1 }] },
    findBlocks: () => [],
    blockAt: () => null,
    async equip() {},
    async look() {},
    async deactivateItem() {},
  };
  let eyes = 2;
  let activeEye = null;
  let eyeTicks = 0;
  let activations = 0;
  bot.inventory.items = () => eyes > 0 ? [{ name: 'ender_eye', count: eyes }] : [];
  bot.activateItem = async () => {
    activations += 1;
    eyes -= 1;
    activeEye = {
      id: activations,
      name: 'eye_of_ender',
      position: makePosition(10, 64, 20),
    };
    bot.entities[activeEye.id] = activeEye;
  };
  const ctx = {
    bot,
    countItem: (name) => name === 'ender_eye' ? eyes : 0,
    async sleep(ms) {
      if (ms !== 100 || !activeEye) return;
      eyeTicks += 1;
      if (eyeTicks % 2 === 1) {
        activeEye.position = makePosition(15, 64, 20);
      } else {
        delete bot.entities[activeEye.id];
      }
    },
  };

  const result = await withFakeClock(async ({ sleep }) => {
    ctx.sleep = async (ms) => {
      if (ms !== 100 || !activeEye) return sleep(ms);
      eyeTicks += 1;
      if (eyeTicks % 2 === 1) activeEye.position = makePosition(15, 64, 20);
      else delete bot.entities[activeEye.id];
      await sleep(ms);
    };
    return skills.throw_eye.handler({ count: 1, timeout_s: 20 }, ctx);
  });

  assert.equal(result.status, 'partial');
  assert.equal(activations, 1);
  assert.equal(result.data.stronghold_search.phase, 'descend');
  assert.equal(result.data.stronghold_search.evidence.kind, 'eye_overhead');
  assert.equal(result.data.stronghold_search.evidence.horizontal_distance, 5);
  assert.equal(result.data.stronghold_search.eye_accounting.throws_completed, 1);
  assert.equal(result.data.stronghold_search.eye_accounting.inventory_before, 2);
  assert.equal(result.data.stronghold_search.eye_accounting.inventory_after, 1);
  assert.equal(result.data.stronghold_search.eye_accounting.inventory_net_change, -1);
  assert.deepEqual(result.data.stronghold_search.position, { x: 10, y: 64, z: 20 });
  assert.deepEqual(result.data.stronghold_search.scan.frames, []);
});

test('throw_eye continuation never throws again and descends only after safe checks until a fresh frame appears', async () => {
  const bot = {
    game: { dimension: 'minecraft:overworld' },
    entity: { position: makePosition(10, 64, 20), yaw: 0 },
    entities: {},
    health: 20,
    inventory: { items: () => [{ name: 'ender_eye', count: 4 }] },
    findBlocks({ matching }) {
      const frame = { name: 'end_portal_frame', position: makeBlockPosition(11, 62, 20) };
      return matching(frame) ? [frame.position] : [];
    },
    // 区块从一开始就包含门框，只有下探两层以后才能看见。
    canSeeBlock: () => descended >= 2,
    blockAt(position) {
      if (position.x === 11 && position.y === 62 && position.z === 20) {
        return { name: 'end_portal_frame', position: makeBlockPosition(11, 62, 20) };
      }
      return null;
    },
    async equip() { throw new Error('续跑不应装备末影之眼'); },
    async activateItem() { throw new Error('续跑不应再次投掷末影之眼'); },
  };
  let descended = 0;
  let hostileChecks = 0;
  const descendArguments = [];
  const ctx = {
    bot,
    findHostile(radius) {
      assert.equal(radius, 12);
      hostileChecks += 1;
      return null;
    },
    async runSkill(skillId, args) {
      assert.equal(skillId, 'safe_descend');
      descendArguments.push(args);
      descended += 1;
      bot.entity.position = makePosition(10, 64 - descended, 20);
      return { status: 'succeeded' };
    },
  };
  const search = {
    schema_version: 1,
    search_id: 's6-search-1',
    phase: 'descend',
    evidence: {
      kind: 'eye_overhead',
      throw_origin: { x: 10, y: 64, z: 20 },
      eye_position: { x: 15, y: 64, z: 20 },
      horizontal_distance: 5,
    },
    estimate: { x: 12, z: 18, distance: 4, angle_deg: 90, throws: 2 },
    eye_accounting: {
      throws_completed: 2,
      inventory_before: 5,
      inventory_after: 3,
      inventory_net_change: -2,
    },
    position: { x: 10, y: 64, z: 20 },
    descent: { layers_completed: 0, max_layers: 96, segment_layers: 8 },
    scan: { fresh: true, stable: true, dimension: 'minecraft:overworld', radius: 64, frames: [] },
  };

  const result = await skills.throw_eye.handler({ resume_search: search }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(result.data.stronghold_search.phase, 'frames_found');
  assert.equal(result.data.stronghold_search.search_id, 's6-search-1');
  assert.equal(result.data.stronghold_search.scan.dimension, 'minecraft:overworld');
  assert.equal(result.data.stronghold_search.scan.fresh, true);
  assert.equal(result.data.stronghold_search.scan.line_of_sight, true);
  assert.equal(result.data.stronghold_search.scan.frames.length, 1);
  assert.deepEqual(result.data.stronghold_search.scan.frames[0], { x: 11, y: 62, z: 20 });
  assert.equal(descended, 2);
  assert.equal(hostileChecks, 3);
  assert.deepEqual(descendArguments, [
    { targetY: 63, maxLayers: 1, fill: false, detour: false },
    { targetY: 62, maxLayers: 1, fill: false, detour: false },
  ]);
});

test('throw_eye continuation blocks low health before descending or using any eye', async () => {
  const bot = {
    game: { dimension: 'minecraft:overworld' },
    entity: { position: makePosition(10, 64, 20), yaw: 0 },
    entities: {},
    health: 8,
    inventory: { items: () => [{ name: 'ender_eye', count: 4 }] },
    findBlocks: () => [],
    blockAt: () => null,
    async equip() { throw new Error('续跑不应装备末影之眼'); },
    async activateItem() { throw new Error('续跑不应再次投掷末影之眼'); },
  };
  let descents = 0;
  const ctx = {
    bot,
    findHostile: () => null,
    async runSkill(skillId, args) {
      assert.equal(skillId, 'safe_descend');
      assert.equal(args.maxLayers, 1);
      descents += 1;
      bot.entity.position = makePosition(10, 64 - descents, 20);
    },
  };
  const search = {
    schema_version: 1,
    search_id: 's6-search-low-health',
    phase: 'descend',
    evidence: {
      kind: 'eye_overhead',
      throw_origin: { x: 10, y: 64, z: 20 },
      eye_position: { x: 15, y: 64, z: 20 },
      horizontal_distance: 5,
    },
    estimate: null,
    eye_accounting: { throws_completed: 1, inventory_before: 2, inventory_after: 1, inventory_net_change: -1 },
    position: { x: 10, y: 64, z: 20 },
    descent: { layers_completed: 0, max_layers: 96, segment_layers: 8 },
    scan: { fresh: true, stable: true, dimension: 'minecraft:overworld', radius: 64, frames: [] },
  };

  const result = await skills.throw_eye.handler({ resume_search: search }, ctx);

  assert.equal(result.status, 'partial');
  assert.equal(result.data.stronghold_search.phase, 'blocked');
  assert.match(result.data.stronghold_search.stop_reason, /生命值不足/);
  assert.equal(result.data.stronghold_search.resume_allowed, true);
  assert.equal(descents, 0);

  bot.health = 20;
  const resumed = await skills.throw_eye.handler(
    { resume_search: result.data.stronghold_search },
    ctx,
  );
  assert.equal(resumed.status, 'partial');
  assert.equal(resumed.data.stronghold_search.phase, 'descend');
  assert.equal(resumed.data.stronghold_search.search_id, 's6-search-low-health');
  assert.equal(resumed.data.stronghold_search.descent.layers_completed, 8);
  assert.equal(descents, 8);
});

test('throw_eye continuation rechecks hostiles between individual safe descent layers', async () => {
  const bot = {
    game: { dimension: 'minecraft:overworld' },
    entity: { position: makePosition(10, 64, 20), yaw: 0 },
    entities: {},
    health: 20,
    inventory: { items: () => [{ name: 'ender_eye', count: 4 }] },
    findBlocks: () => [],
    blockAt: () => null,
    async equip() { throw new Error('续跑不应装备末影之眼'); },
    async activateItem() { throw new Error('续跑不应再次投掷末影之眼'); },
  };
  let hostileChecks = 0;
  let descents = 0;
  const ctx = {
    bot,
    findHostile() {
      hostileChecks += 1;
      return hostileChecks >= 3 ? { name: 'zombie' } : null;
    },
    async runSkill(skillId, args) {
      assert.equal(skillId, 'safe_descend');
      assert.equal(args.maxLayers, 1);
      descents += 1;
      bot.entity.position = makePosition(10, 64 - descents, 20);
    },
  };
  const search = {
    schema_version: 1,
    search_id: 's6-search-hostile',
    phase: 'descend',
    evidence: {
      kind: 'eye_overhead',
      throw_origin: { x: 10, y: 64, z: 20 },
      eye_position: { x: 15, y: 64, z: 20 },
      horizontal_distance: 5,
    },
    estimate: null,
    eye_accounting: { throws_completed: 1, inventory_before: 2, inventory_after: 1, inventory_net_change: -1 },
    position: { x: 10, y: 64, z: 20 },
    descent: { layers_completed: 0, max_layers: 96, segment_layers: 8 },
    scan: { fresh: true, stable: true, dimension: 'minecraft:overworld', radius: 64, frames: [] },
  };

  const result = await skills.throw_eye.handler({ resume_search: search }, ctx);

  assert.equal(result.status, 'partial');
  assert.equal(result.data.stronghold_search.phase, 'blocked');
  assert.match(result.data.stronghold_search.stop_reason, /zombie/);
  assert.equal(descents, 1);
  assert.equal(result.data.stronghold_search.descent.layers_completed, 1);
  assert.equal(result.data.stronghold_search.position.y, 63);
});

test('throw_eye continuation blocks when a frame scan cannot recheck returned coordinates', async () => {
  const staleFrame = makeBlockPosition(11, 62, 20);
  const bot = {
    game: { dimension: 'minecraft:overworld' },
    entity: { position: makePosition(10, 64, 20), yaw: 0 },
    entities: {},
    health: 20,
    findBlocks: () => [staleFrame],
    async equip() { throw new Error('续跑不应装备末影之眼'); },
    async activateItem() { throw new Error('续跑不应再次投掷末影之眼'); },
  };
  let descents = 0;
  const ctx = {
    bot,
    findHostile: () => null,
    async runSkill() { descents += 1; },
  };
  const search = {
    schema_version: 1,
    search_id: 's6-search-stale-frame',
    phase: 'descend',
    evidence: {
      kind: 'eye_overhead',
      throw_origin: { x: 10, y: 64, z: 20 },
      eye_position: { x: 15, y: 64, z: 20 },
      horizontal_distance: 5,
    },
    estimate: null,
    eye_accounting: { throws_completed: 1, inventory_before: 2, inventory_after: 1, inventory_net_change: -1 },
    position: { x: 10, y: 64, z: 20 },
    descent: { layers_completed: 0, max_layers: 96, segment_layers: 8 },
    scan: { fresh: true, stable: true, dimension: 'minecraft:overworld', radius: 64, frames: [] },
  };

  const result = await skills.throw_eye.handler({ resume_search: search }, ctx);

  assert.equal(result.status, 'partial');
  assert.equal(result.data.stronghold_search.phase, 'blocked');
  assert.equal(result.data.stronghold_search.scan.fresh, false);
  assert.equal(result.data.stronghold_search.scan.frames.length, 0);
  assert.equal(result.data.stronghold_search.resume_allowed, true);
  assert.equal(descents, 0);
});

test('throw_eye continuation stops before scanning or claiming a layer when cancelled inside safe_descend', async () => {
  const bot = {
    game: { dimension: 'minecraft:overworld' },
    entity: { position: makePosition(10, 64, 20), yaw: 0 },
    entities: {},
    health: 20,
    findBlocks: () => [],
    blockAt: () => null,
    async equip() { throw new Error('续跑不应装备末影之眼'); },
    async activateItem() { throw new Error('续跑不应再次投掷末影之眼'); },
  };
  let scans = 0;
  let descents = 0;
  const ctx = {
    bot,
    interrupted: false,
    findHostile: () => null,
    async runSkill() {
      descents += 1;
      bot.entity.position = makePosition(10, 63, 20);
      ctx.interrupted = true;
    },
  };
  bot.findBlocks = () => {
    scans += 1;
    return [];
  };

  await assert.rejects(
    skills.throw_eye.handler({ resume_search: makeStrongholdSearch() }, ctx),
    /继续搜索要塞被新的指令打断/,
  );
  assert.equal(descents, 1);
  assert.equal(scans, 1);
});

test('throw_eye invalidates the previous frame scan when safe_descend fails after moving', async () => {
  const bot = {
    game: { dimension: 'minecraft:overworld' },
    entity: { position: makePosition(10, 64, 20), yaw: 0 },
    entities: {},
    health: 20,
    findBlocks: () => [],
    blockAt: () => null,
    async equip() { throw new Error('续跑不应装备末影之眼'); },
    async activateItem() { throw new Error('续跑不应再次投掷末影之眼'); },
  };
  const ctx = {
    bot,
    findHostile: () => null,
    async runSkill() {
      bot.entity.position = makePosition(10, 63, 20);
      throw new Error('UNKNOWN_TERRAIN: 落脚方块未确认');
    },
  };

  const result = await skills.throw_eye.handler({ resume_search: makeStrongholdSearch() }, ctx);
  const search = result.data.stronghold_search;

  assert.equal(result.status, 'partial');
  assert.equal(search.phase, 'blocked');
  assert.equal(search.position.y, 63);
  assert.equal(search.scan.fresh, false);
  assert.equal(search.scan.stable, false);
  assert.deepEqual(search.scan.frames, []);
  assert.equal(search.resume_allowed, false);
  assert.equal(search.search_id, 's6-search-test');
});

test('throw_eye continuation caps each segment at eight layers', async () => {
  const bot = {
    game: { dimension: 'minecraft:overworld' },
    entity: { position: makePosition(10, 100, 20), yaw: 0 },
    entities: {},
    health: 20,
    findBlocks: () => [],
    blockAt: () => null,
    async equip() { throw new Error('续跑不应装备末影之眼'); },
    async activateItem() { throw new Error('续跑不应再次投掷末影之眼'); },
  };
  let descents = 0;
  const ctx = {
    bot,
    findHostile: () => null,
    async runSkill(skillId, args) {
      assert.equal(skillId, 'safe_descend');
      assert.equal(args.maxLayers, 1);
      descents += 1;
      bot.entity.position = makePosition(10, 100 - descents, 20);
    },
  };

  const result = await skills.throw_eye.handler(
    { resume_search: makeStrongholdSearch({ y: 100, searchId: 's6-search-eight-layer-cap' }) },
    ctx,
  );

  assert.equal(result.status, 'partial');
  assert.equal(result.data.stronghold_search.phase, 'descend');
  assert.equal(result.data.stronghold_search.descent.layers_completed, 8);
  assert.equal(descents, 8);
});

test('throw_eye continuation enforces the 96-layer search budget across resumes', async () => {
  const bot = {
    game: { dimension: 'minecraft:overworld' },
    entity: { position: makePosition(10, 1, 20), yaw: 0 },
    entities: {},
    health: 20,
    findBlocks: () => [],
    blockAt: () => null,
    async equip() { throw new Error('续跑不应装备末影之眼'); },
    async activateItem() { throw new Error('续跑不应再次投掷末影之眼'); },
  };
  let descents = 0;
  const ctx = {
    bot,
    findHostile: () => null,
    async runSkill(skillId, args) {
      assert.equal(skillId, 'safe_descend');
      assert.equal(args.targetY, 0);
      assert.equal(args.maxLayers, 1);
      descents += 1;
      bot.entity.position = makePosition(10, 0, 20);
    },
  };

  const nearLimit = makeStrongholdSearch({
    searchId: 's6-search-total-layer-cap',
    layers: 95,
    y: 1,
  });
  const lastLayer = await skills.throw_eye.handler({ resume_search: nearLimit }, ctx);
  assert.equal(lastLayer.status, 'partial');
  assert.equal(lastLayer.data.stronghold_search.descent.layers_completed, 96);
  assert.equal(lastLayer.data.stronghold_search.position.y, 0);
  assert.equal(descents, 1);

  const exhausted = await skills.throw_eye.handler(
    { resume_search: lastLayer.data.stronghold_search },
    ctx,
  );
  assert.equal(exhausted.status, 'partial');
  assert.equal(exhausted.data.stronghold_search.phase, 'blocked');
  assert.equal(exhausted.data.stronghold_search.resume_allowed, false);
  assert.equal(exhausted.data.stronghold_search.descent.layers_completed, 96);
  assert.equal(descents, 1);
});

test('throw_eye refuses to reuse overhead evidence recorded in another dimension', async () => {
  const bot = {
    game: { dimension: 'minecraft:overworld' },
    entity: { position: makePosition(10, 64, 20), yaw: 0 },
    entities: {},
    health: 20,
    findBlocks: () => [],
    blockAt: () => null,
    async equip() { throw new Error('续跑不应装备末影之眼'); },
    async activateItem() { throw new Error('续跑不应再次投掷末影之眼'); },
  };
  let descents = 0;
  const ctx = {
    bot,
    findHostile: () => null,
    async runSkill() { descents += 1; },
  };

  const result = await skills.throw_eye.handler(
    {
      resume_search: makeStrongholdSearch({
        searchId: 's6-search-dimension-mismatch',
        dimension: 'minecraft:the_nether',
      }),
    },
    ctx,
  );

  assert.equal(result.status, 'partial');
  assert.equal(result.data.stronghold_search.phase, 'blocked');
  assert.match(result.data.stronghold_search.stop_reason, /保存的搜索维度/);
  assert.equal(descents, 0);
});
