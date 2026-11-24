import assert from 'node:assert/strict';
import test from 'node:test';

import { skills, surveyPassage } from '../skills/nether.js';
import { Vec3 } from 'vec3';

test('a bounded fortress tunnel needs solid support and a dry wall along the entire passage', () => {
  const origin = new Vec3(0, 90, 0);
  const bot = { game: { dimension: 'the_nether' }, entity: { position: origin }, blockAt(p) {
    if (p.y < 90 || p.x > 0 && p.x <= 6 && p.z === 0 && p.y <= 92) return { name: 'netherrack', boundingBox: 'block' };
    return { name: 'air', boundingBox: 'empty' };
  } };
  const route = { surveyed: [origin] };
  assert.equal(surveyPassage(bot, route).direction, 'east');
  const baseline = bot.blockAt;
  bot.blockAt = p => p.x === 4 && p.z === 1 && p.y === 92 ? { name: 'lava', boundingBox: 'empty' } : baseline(p);
  assert.equal(surveyPassage(bot, route), undefined);
  bot.blockAt = p => p.x === 5 && p.z === 0 && p.y < 90 ? null : baseline(p);
  assert.equal(surveyPassage(bot, route), undefined);
});

class Position {
  constructor(x = 0, y = 64, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  distanceTo(other) {
    return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
  }
}

function makeContext(dimension = 'minecraft:the_nether', position = new Position()) {
  const liveBlocks = new Map();
  const keyOf = (position) => `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
  const bot = {
    game: { dimension },
    entity: { position },
    entities: {},
    registry: { blocksByName: {} },
    findBlocks: () => [],
    blockAt: (position) => liveBlocks.get(keyOf(position)) || null,
  };
  const ctx = {
    bot,
    interrupted: false,
    countItem: () => 0,
    nearbyBlock: () => null,
    async travelTo(x, y, z) {
      bot.entity.position = new Position(x, y, z);
    },
    async walkOnce() {},
    async sleep() {},
    log() {},
  };
  return {
    bot,
    ctx,
    setBlock(name, position) {
      liveBlocks.set(keyOf(position), { name, position: { ...position } });
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

test('nether_travel records observed source portal and actual destination arrival, then rescans before exit', async () => {
  const entry = makeContext('minecraft:overworld', new Position(0, 64, 0));
  const entryPortal = { x: 2, y: 64, z: 3 };
  entry.setBlock('nether_portal', entryPortal);
  entry.ctx.nearbyBlock = () => ({ position: entryPortal });
  entry.ctx.sleep = async () => {
    assert.equal(entry.bot.blockAt(entry.bot.entity.position).name, 'nether_portal');
    entry.bot.game.dimension = 'minecraft:the_nether';
    entry.bot.entity.position = new Position(121, 71, -249);
  };

  const entered = await skills.nether_travel.handler({ mode: 'enter' }, entry.ctx);
  assert.equal(entered.status, 'succeeded');
  assert.deepEqual(entered.data.portal_transition.source, {
    dimension: 'minecraft:overworld',
    position: entryPortal,
    observed: 'nether_portal_block',
  });
  assert.deepEqual(entered.data.portal_transition.target, {
    dimension: 'minecraft:the_nether',
    position: { x: 121, y: 71, z: -249 },
    observed: 'arrival_checkpoint',
  });
  assert.equal(entered.checkpoint.dimension, 'minecraft:the_nether');

  const exit = makeContext('minecraft:the_nether', new Position(500, 70, 500));
  const travelTargets = [];
  let portalReads = 0;
  const exitPortal = { x: 123, y: 71, z: -249 };
  exit.setBlock('nether_portal', exitPortal);
  exit.ctx.nearbyBlock = () => {
    portalReads += 1;
    if (portalReads === 2) return { position: exitPortal };
    return null;
  };
  exit.ctx.travelTo = async (x, y, z) => {
    travelTargets.push({ x, y, z });
    exit.bot.entity.position = new Position(x, y, z);
  };
  exit.ctx.sleep = async () => {
    assert.equal(exit.bot.blockAt(exit.bot.entity.position).name, 'nether_portal');
    exit.bot.game.dimension = 'minecraft:overworld';
    exit.bot.entity.position = new Position(22, 65, 33);
  };

  const returned = await skills.nether_travel.handler({ mode: 'exit' }, exit.ctx);
  assert.equal(returned.status, 'succeeded');
  assert.deepEqual(travelTargets.slice(0, 2), [
    { x: 121, y: 71, z: -249 },
    { x: 123, y: 71, z: -249 },
  ]);
  assert.deepEqual(returned.data.portal_transition.source, {
    dimension: 'minecraft:the_nether',
    position: { x: 123, y: 71, z: -249 },
    observed: 'nether_portal_block',
  });
  assert.deepEqual(returned.data.portal_transition.target, {
    dimension: 'minecraft:overworld',
    position: { x: 22, y: 65, z: 33 },
    observed: 'arrival_checkpoint',
  });
});

test('a cached arrival point is never accepted as a portal without a fresh block scan', async () => {
  const { bot, ctx } = makeContext('minecraft:the_nether', new Position(800, 70, 800));
  const travelTargets = [];
  let walks = 0;
  let portalScans = 0;
  ctx.nearbyBlock = () => {
    portalScans += 1;
    // arrival checkpoint 邻格报告候选门，但 blockAt 不确认门块。
    return portalScans === 2 ? { position: { x: 123, y: 71, z: -249 } } : null;
  };
  ctx.travelTo = async (x, y, z) => {
    travelTargets.push({ x, y, z });
    bot.entity.position = new Position(x, y, z);
  };
  ctx.walkOnce = async () => {
    walks += 1;
  };

  await assert.rejects(
    skills.nether_travel.handler({
      mode: 'exit',
      portal_hint: {
        source: {
          dimension: 'minecraft:overworld',
          position: { x: 2, y: 64, z: 3 },
          observed: 'nether_portal_block',
        },
        target: {
          dimension: 'minecraft:the_nether',
          position: { x: 123, y: 71, z: -249 },
          observed: 'arrival_checkpoint',
        },
      },
    }, ctx),
    /附近 32 格内没有下界门/,
  );
  assert.deepEqual(travelTargets, [{ x: 123, y: 71, z: -249 }]);
  assert.ok(portalScans >= 2);
  assert.equal(walks, 0);
});

test('a restored portal hint is only a search anchor and exact vanilla dimensions are required', async () => {
  const { bot, ctx, setBlock } = makeContext('the_nether', new Position(800, 70, 800));
  const anchor = { x: 300, y: 71, z: 300 };
  const portal = { x: 302, y: 71, z: 300 };
  const travelTargets = [];
  let scans = 0;
  setBlock('nether_portal', portal);
  ctx.nearbyBlock = () => {
    scans += 1;
    return scans === 2 ? { position: portal } : null;
  };
  ctx.travelTo = async (x, y, z) => {
    travelTargets.push({ x, y, z });
    bot.entity.position = new Position(x, y, z);
  };
  ctx.sleep = async () => {
    bot.game.dimension = 'minecraft:overworld';
    bot.entity.position = new Position(10, 64, 10);
  };

  const result = await skills.nether_travel.handler({
    mode: 'exit',
    portal_hint: {
      source: {
        dimension: 'minecraft:overworld',
        position: { x: 2400, y: 64, z: 2400 },
        observed: 'nether_portal_block',
      },
      target: {
        dimension: 'minecraft:the_nether',
        position: anchor,
        observed: 'arrival_checkpoint',
      },
    },
  }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(travelTargets[0], anchor);
  assert.ok(scans >= 2);
  assert.equal(bot.game.dimension, 'minecraft:overworld');
});

test('dimension helpers reject custom, partial, and unknown dimension names', async () => {
  const { isEndDimension, isNetherDimension, isOverworldDimension } = await import('../skills/nether.js');
  assert.equal(isNetherDimension('minecraft:the_nether'), true);
  assert.equal(isNetherDimension('the_nether'), true);
  assert.equal(isOverworldDimension('minecraft:overworld'), true);
  assert.equal(isOverworldDimension('overworld'), true);
  assert.equal(isEndDimension('minecraft:the_end'), true);
  assert.equal(isEndDimension('the_end'), true);
  assert.equal(isNetherDimension('custom:nether_realm'), false);
  assert.equal(isOverworldDimension('custom:overworld'), false);
  assert.equal(isEndDimension('my_end_dimension'), false);
  assert.equal(isOverworldDimension(''), false);
  const custom = makeContext('custom:nether_realm');
  await assert.rejects(
    skills.nether_travel.handler({ mode: 'exit' }, custom.ctx),
    /不是可验证的原版主世界或下界/,
  );
});

test('nether_travel stops after one unexpected or unknown dimension transition', async () => {
  for (const nextDimension of ['minecraft:the_end', '']) {
    const { bot, ctx, setBlock } = makeContext('minecraft:the_nether');
    let walks = 0;
    const portal = { x: 1, y: 64, z: 0 };
    setBlock('nether_portal', portal);
    ctx.travelTo = async () => {};
    ctx.nearbyBlock = () => ({ position: portal });
    ctx.walkOnce = async (x, y, z, radius) => {
      assert.deepEqual([x, y, z, radius], [1, 64, 0, 0]);
      walks += 1;
      bot.game.dimension = nextDimension;
    };

    await assert.rejects(
      skills.nether_travel.handler({ mode: 'exit', timeout_s: 5 }, ctx),
      (error) => {
        assert.equal(error.data.observed_dimension, nextDimension);
        assert.equal(error.data.portal_transition.target, null);
        return /停止重复穿门动作/.test(error.message);
      },
    );
    assert.equal(walks, 1);
  }
});

test('raid_fortress keeps one fixed origin and stops at its route budget regardless of scan radius', async () => {
  const { bot, ctx } = makeContext('minecraft:the_nether', new Position(100, 64, 200));
  const travelTargets = [];
  bot.registry.blocksByName = {};
  bot.entities = {};
  ctx.travelTo = async (x, y, z) => {
    travelTargets.push({ x, y, z });
    bot.entity.position = new Position(x, y, z);
  };

  await withFakeClock(async ({ sleep }) => {
    ctx.sleep = sleep;
    await assert.rejects(
      skills.raid_fortress.handler({ radius: 32, timeout_s: 600 }, ctx),
      (error) => {
        const route = error.data.fortress_evidence.route;
        assert.equal(route.scan_radius, 32);
        assert.equal(route.route_budget_waypoints, 16);
        assert.equal(route.attempted_waypoints, 16);
        assert.equal(route.origin.x, 100);
        assert.equal(route.origin.z, 200);
        return /路线预算/.test(error.message);
      },
    );
  });

  assert.equal(travelTargets.length, 16);
  assert.deepEqual(travelTargets.slice(0, 4), [
    { x: 116, y: 64, z: 200 },
    { x: 116, y: 64, z: 216 },
    { x: 100, y: 64, z: 216 },
    { x: 84, y: 64, z: 216 },
  ]);
});

test('raid_fortress returns only actually scanned fortress block coordinates', async () => {
  const fortress = { x: 10, y: 64, z: 0 };
  const { bot, ctx } = makeContext('minecraft:the_nether', new Position(0, 64, 0));
  const travelTargets = [];
  bot.registry.blocksByName = { nether_bricks: { id: 41 } };
  bot.findBlocks = ({ matching, maxDistance }) => {
    if (matching !== 41) return [];
    const origin = bot.entity.position;
    return origin.distanceTo(fortress) <= maxDistance ? [fortress] : [];
  };
  ctx.travelTo = async (x, y, z) => {
    travelTargets.push({ x, y, z });
    bot.entity.position = new Position(x, y, z);
  };

  await withFakeClock(async ({ sleep }) => {
    ctx.sleep = sleep;
    await assert.rejects(
      skills.raid_fortress.handler({ radius: 16, timeout_s: 600 }, ctx),
      (error) => {
        const evidence = error.data.fortress_evidence;
        assert.equal(evidence.dimension, 'minecraft:the_nether');
        assert.deepEqual(evidence.observed_blocks, [{
          dimension: 'minecraft:the_nether',
          block: 'nether_bricks',
          position: fortress,
        }]);
        return true;
      },
    );
  });

  assert.deepEqual(travelTargets[0], fortress);
});

test('a scout skips a previously unreachable approach and records the next unreachable target', async () => {
  const { bot, ctx } = makeContext('minecraft:the_nether', new Vec3(0, 64, 0));
  bot.pathfinder = { movements: { exclusionAreasStep: [] }, setMovements() {} };
  bot.blockAt = p => p.y < 64 ? { name: 'netherrack', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
  const previous = { from: {x: 0, y: 64, z: 0}, to: {x: 24, y: 64, z: 0} };
  const attempts = [];
  ctx.walkOnce = async (x, y, z) => { attempts.push({x, y, z}); return 'unreachable'; };
  await withFakeClock(async ({sleep}) => {
    ctx.sleep = sleep;
    await assert.rejects(skills.raid_fortress.handler({scout_only: true, walk_misses: [previous]}, ctx), error => {
      assert.ok(error.data, error.stack);
      const misses = error.data.fortress_evidence.route.walk_misses;
      assert.ok(attempts.length > 0);
      assert.ok(!attempts.some(p => Math.hypot(p.x - 24, p.z) <= 2));
      assert.deepEqual(misses.at(-1).to, attempts.at(-1));
      return true;
    });
  });
});

test('scouting records a live blaze without initiating combat', async () => {
  const { bot, ctx } = makeContext();
  bot.entities = { blaze: { name: 'blaze', position: new Position(2, 64, 0) } };
  ctx.runSkill = () => assert.fail('scouting initiated combat');
  const result = await skills.raid_fortress.handler({ scout_only: true }, ctx);
  assert.deepEqual(result.data.events, ['fortress_route_found']);
  assert.deepEqual(result.data.blaze_evidence.position, { x: 2, y: 64, z: 0 });
});

test('collect_blaze_rods asks combat for the inventory net shortage', async () => {
  const { bot, ctx } = makeContext();
  const blazePosition = new Position(2, 64, 0);
  bot.entities = {
    blaze: { name: 'blaze', position: blazePosition },
  };
  let rods = 5;
  let requested = 0;
  ctx.countItem = () => rods;
  ctx.fightBlaze = async (options) => {
    requested = options.count;
    rods += options.count;
    return { status: 'succeeded', detail: '战斗完成' };
  };

  const result = await skills.collect_blaze_rods.handler({ count: 12, timeout_s: 10 }, ctx);
  assert.equal(requested, 7);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.data.inventory, { blaze_rod: 12 });
  assert.equal(result.data.target, 12);
  assert.equal(result.data.missing, 0);
});

test('collect_blaze_rods propagates combat retreat instead of reporting success', async () => {
  const { bot, ctx } = makeContext();
  bot.entities = {
    blaze: { name: 'blaze', position: new Position(2, 64, 0), isValid: true },
  };
  ctx.fightBlaze = async () => {
    throw new Error('还差目标；群怪威胁过高，已拉开距离，停止打烈焰人');
  };

  await assert.rejects(
    skills.collect_blaze_rods.handler({ count: 1, timeout_s: 10 }, ctx),
    /还差目标.*群怪威胁过高.*已拉开距离/,
  );
  assert.equal(ctx.countItem('blaze_rod'), 0);
});

test('collect_blaze_rods rejects a cached fortress coordinate without a fresh matching block', async () => {
  const { bot, ctx } = makeContext('minecraft:the_nether', new Position(0, 64, 0));
  const travelTargets = [];
  bot.registry.blocksByName = {};
  bot.findBlocks = () => [];
  bot.blockAt = () => null;
  ctx.travelTo = async (x, y, z) => {
    travelTargets.push({ x, y, z });
    bot.entity.position = new Position(x, y, z);
  };

  await withFakeClock(async ({ sleep }) => {
    ctx.sleep = sleep;
    await assert.rejects(
      skills.collect_blaze_rods.handler({ count: 12, timeout_s: 10 }, ctx),
      (error) => {
        assert.equal(error.data.fortress_evidence.observed_blocks.length, 0);
        assert.equal(error.data.patrol.attempted, 1);
        return /还差 12 根/.test(error.message);
      },
    );
  });
  assert.deepEqual(travelTargets, []);
});

test('collect_blaze_rods visits a recorded fortress only through a verified safe spot', async () => {
  const fortress = { x: 10, y: 64, z: 0 };
  const { bot, ctx } = makeContext('minecraft:the_nether', new Position(0, 64, 0));
  const travelTargets = [];
  bot.registry.blocksByName = { nether_bricks: { id: 41 } };
  bot.findBlocks = ({ matching, maxDistance }) => {
    if (matching !== 41) return [];
    const origin = bot.entity.position;
    return origin.distanceTo(fortress) <= maxDistance ? [fortress] : [];
  };
  bot.blockAt = (position) => {
    if (position.y === 64) return { name: 'nether_bricks', boundingBox: 'block' };
    if (position.y === 65) return { name: 'air', boundingBox: 'empty' };
    return null;
  };
  ctx.travelTo = async (x, y, z) => {
    travelTargets.push({ x, y, z });
    bot.entity.position = new Position(x, y, z);
  };

  await withFakeClock(async ({ sleep }) => {
    ctx.sleep = sleep;
    await assert.rejects(
      skills.collect_blaze_rods.handler({ count: 12, radius: 48, timeout_s: 10 }, ctx),
      (error) => {
        assert.equal(error.data.missing, 12);
        assert.equal(error.data.patrol.budget, 8);
        assert.equal(error.data.patrol.attempted, 1);
        return /还差 12 根/.test(error.message);
      },
    );
  });

  assert.deepEqual(travelTargets, [{ x: 11, y: 65, z: 0 }]);
  assert.notDeepEqual(travelTargets[0], fortress);
});

test('collect_blaze_rods honors cancellation before patrol movement', async () => {
  const { ctx } = makeContext();
  let travels = 0;
  ctx.interrupted = true;
  ctx.travelTo = async () => {
    travels += 1;
  };

  await assert.rejects(
    skills.collect_blaze_rods.handler({ count: 12, timeout_s: 10 }, ctx),
    /被新的指令打断/,
  );
  assert.equal(travels, 0);
});
