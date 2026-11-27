import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { dryMiningFooting, miningSiteCandidates, miningRouteExclusion, skills } from '../skills/exploration.js';
import { crossSurfaceWater, findSurfaceCrossing } from '../surface_crossing.js';

test('换区前脱离逼近的敌人，并从原起点核对实际位移', async () => {
  const ctx = context();
  const threat = {name: 'zombie'};
  let hostile = true;
  ctx.findHostile = () => hostile ? threat : null;
  ctx.nearbyHostiles = () => hostile ? [threat] : [];
  ctx.retreatFrom = async target => {
    assert.equal(target, threat);
    hostile = false;
    ctx.bot.entity.position = new Vec3(2, 64, 0);
  };
  const result = await skills.explore_mining_site.handler({min_distance: 16}, ctx);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.data.relocation.origin.x, 0.5);
});

function context() {
  const ctx = {
    bot: {
      entity: { position: new Vec3(0.5, 64, 0.5) }, health: 20,
      pathfinder: { movements: { canDig: true, allow1by1towers: true, allowParkour: true, maxDropDown: 4, liquidCost: 1, exclusionAreasStep: [], infiniteLiquidDropdownDistance: true } },
      blockAt(p) { return { name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' }; },
    },
    nearbyHostiles: () => [],
  };
  ctx.walkOnce = async (x, y, z) => { ctx.bot.entity.position = new Vec3(x, y, z); return 'reached'; };
  return ctx;
}

test('换矿区可沿连通的干燥走廊分段走出，自始至终核实位移', async () => {
  const ctx = context();
  const origin = ctx.bot.entity.position.floored();
  ctx.bot.blockAt = p => p.y < origin.y && p.z === origin.z && p.x >= origin.x && p.x < origin.x + 28
    ? {name: 'stone', boundingBox: 'block'} : {name: 'air', boundingBox: 'empty'};
  const steps = [];
  ctx.walkOnce = async (x,y,z) => {
    assert.ok(ctx.bot.entity.position.floored().distanceTo(new Vec3(x,y,z)) <= 3);
    ctx.bot.entity.position = new Vec3(x+0.5,y,z+0.5);
    steps.push(x);
    return 'reached';
  };
  const {data} = await skills.explore_mining_site.handler({min_distance: 16, connected_route: true}, ctx);
  assert.ok(steps.length >= 6 && data.relocation.destination.x - data.relocation.origin.x >= 16);
});

test('补木换区沿连通的干地优先走向已观察的树干', async () => {
  const ctx = context(), toward = {x: -40, y: 64, z: 0};
  const result = await skills.explore_mining_site.handler({min_distance: 16, connected_route: true, toward}, ctx);
  assert.equal(result.status, 'succeeded');
  assert.ok(result.data.relocation.destination.x < -16);
});

test('补木渡水只选择有完整水面和干岸的路线，取消后立即停止划水', async () => {
  const ctx = context(), bot = ctx.bot, start = bot.entity.position.floored(), toward = new Vec3(32, 64, 0);
  Object.assign(bot, {food: 19, game: {dimension: 'overworld'}, time: {isDay: true}});
  let covered = false;
  bot.blockAt = p => {
    if (p.z !== 0) return null;
    if (p.x > 0 && p.x < 21 && p.y === 63) return p.x === 8 ? {name: 'kelp', boundingBox: 'empty'} : {name: 'water', metadata: 0};
    if (p.y < 64 || (covered && p.x === 10 && p.y === 65)) return {name: 'stone', boundingBox: 'block'};
    return {name: 'air', boundingBox: 'empty', skyLight: 15};
  };
  const ground = {here: start, points: [], parents: new Map()};
  const route = await findSurfaceCrossing(ctx, ground, toward, 16, []);
  assert.deepEqual(route.bank, new Vec3(21, 64, 0));
  const controls = {};
  bot.look = async () => {};
  bot.setControlState = (key, on) => { controls[key] = on; };
  ctx.sleep = async () => { ctx.interrupted = true; };
  await assert.rejects(crossSurfaceWater(ctx, ground, route, () => {
    if (ctx.interrupted) throw new Error('取消');
  }), /取消/);
  assert.equal(controls.forward, false);
  assert.equal(controls.jump, false);
  ctx.interrupted = false;
  covered = true;
  assert.equal(await findSurfaceCrossing(ctx, ground, toward, 16, []), null);
});

test('撤退通道背离实际敌怪，仍用角色位移和敌怪距离验收', async () => {
  const ctx = context();
  const threat = { position: new Vec3(0.5, 64, 3.5) };
  ctx.findHostile = radius => ctx.bot.entity.position.distanceTo(threat.position) < radius ? threat : null;
  ctx.nearbyHostiles = radius => ctx.findHostile(radius) ? [threat] : [];
  const { data } = await skills.explore_mining_site.handler({min_distance: 12, covered_escape: true}, ctx);
  assert.ok(data.relocation.destination.z <= -11.5);
  assert.equal(ctx.nearbyHostiles(10).length, 0);
});

test('敌怪撤离方向没有地面支撑时保留起点', async () => {
  const ctx = context(), original = ctx.bot.blockAt;
  ctx.findHostile = () => ({position: new Vec3(0.5, 64, 3.5)});
  ctx.bot.blockAt = p => p.y === 63 ? {name: 'air', boundingBox: 'empty'} : original(p);
  await assert.rejects(skills.explore_mining_site.handler({min_distance: 12, covered_escape: true}, ctx), e => {
    assert.match(e.message, /可安全开挖/);
    assert.equal(e.data.reason, 'no_safe_excavation');
    assert.deepEqual(e.data.relocation.attempted_positions, []);
    return true;
  });
  await assert.rejects(skills.explore_mining_site.handler({min_distance: 12, covered_escape: true, connected_route: true}, ctx),
    e => e.data.reason === 'no_dry_retreat' && e.data.relocation.attempted_positions.length === 0);
  ctx.bot.health = 6;
  await assert.rejects(skills.explore_mining_site.handler({min_distance: 12}, ctx),
    e => e.data.reason === 'low_health' && e.data.health === 6 && e.data.minimum_health === 10);
  assert.deepEqual(ctx.bot.entity.position, new Vec3(0.5, 64, 0.5));
});

test('换矿点必须真实位移并到达干燥站位，退出时恢复寻路参数', async () => {
  const ctx = context(), before = { ...ctx.bot.pathfinder.movements };
  const result = await skills.explore_mining_site.handler({ min_distance: 16, avoid_positions: [{ x: 18.5, y: 64, z: 0.5 }] }, ctx);
  assert.equal(result.status, 'succeeded');
  assert.ok(Math.hypot(result.data.relocation.destination.x - 0.5, result.data.relocation.destination.z - 0.5) >= 16);
  assert.ok(Math.hypot(result.data.relocation.destination.x - 18.5, result.data.relocation.destination.z - 0.5) >= 8);
  assert.equal(result.data.relocation.attempted_positions.length, 1);
  assert.deepEqual(ctx.bot.pathfinder.movements, before);
});

test('假到达不算换位，失败携带候选供跨动作排除', async () => {
  const ctx = context();
  ctx.walkOnce = async () => 'reached';
  await assert.rejects(skills.explore_mining_site.handler({}, ctx), error => {
    assert.equal(error.data.relocation.attempted_positions.length, 12);
    assert.deepEqual(error.data.relocation.origin, { x: 0.5, y: 64, z: 0.5 });
    return /没有完成安全换位/.test(error.message);
  });
  assert.equal(ctx.bot.pathfinder.movements.canDig, true);
});

test('候选排除未加载区块、水、含水方块与危险地面', () => {
  const ctx = context();
  for (const bad of [null, { name: 'water', boundingBox: 'empty' }, { name: 'seagrass', boundingBox: 'empty' },
    { name: 'air', boundingBox: 'empty', getProperties: () => ({ waterlogged: true }) }]) {
    ctx.bot.blockAt = p => p.y < 64 ? { name: 'stone', boundingBox: 'block' } : bad;
    assert.equal(dryMiningFooting(ctx.bot, ctx.bot.entity.position), false);
  }
  ctx.bot.blockAt = p => p.y < 64 ? { name: 'magma_block', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
  assert.equal(dryMiningFooting(ctx.bot, ctx.bot.entity.position), false);
  ctx.bot.blockAt = () => null;
  assert.deepEqual(miningSiteCandidates(ctx.bot, ctx.bot.entity.position, 16, []), []);
});

test('斜向下坡绕不过干地限制，水面上的空气也排除', () => {
  const ctx = context();
  const dryBlock = ctx.bot.blockAt;
  ctx.bot.blockAt = p => p.x === 1 && p.z === 1 && p.y === 63
    ? {name: 'water', boundingBox: 'empty'} : dryBlock(p);
  assert.equal(miningRouteExclusion(ctx.bot, {position: new Vec3(1, 64, 1)}), 100);
  assert.equal(miningRouteExclusion(ctx.bot, {position: new Vec3(0, 64, 0)}), 0);
});

test('途中取消停止尝试且不泄漏临时寻路参数', async () => {
  const ctx = context();
  let calls = 0;
  ctx.walkOnce = async () => { calls++; ctx.interrupted = true; return 'cancelled'; };
  await assert.rejects(skills.explore_mining_site.handler({}, ctx), /已取消/);
  assert.equal(calls, 1);
  assert.equal(ctx.bot.pathfinder.movements.canDig, true);
});

test('到达位置后来进水也不能报成功', async () => {
  const ctx = context();
  ctx.walkOnce = async (x, y, z) => {
    ctx.bot.entity.position = new Vec3(x, y, z);
    ctx.bot.blockAt = p => p.y < 64 ? { name: 'stone', boundingBox: 'block' } : { name: 'water', boundingBox: 'empty' };
    return 'reached';
  };
  await assert.rejects(skills.explore_mining_site.handler({}, ctx), /没有完成安全换位/);
});

test('干燥终点不能允许中途水道，已有禁行规则在执行后恢复', async () => {
  const ctx = context(), original = ctx.bot.pathfinder.movements.exclusionAreasStep;
  original.push(() => 7);
  ctx.walkOnce = async (x, y, z) => {
    const rules = ctx.bot.pathfinder.movements.exclusionAreasStep;
    assert.equal(rules[0](), 7);
    assert.equal(ctx.bot.pathfinder.movements.infiniteLiquidDropdownDistance, false);
    const terrain = ctx.bot.blockAt;
    for (const wet of [{ name: 'water' }, { name: 'bubble_column' },
      { name: 'oak_stairs', getProperties: () => ({ waterlogged: true }) }, null]) {
      ctx.bot.blockAt = p => p.x === 4 && p.y === 65 ? wet : terrain(p);
      assert.equal(rules[1]({ position: new Vec3(4, 64, 0) }), 100);
    }
    ctx.bot.blockAt = terrain;
    assert.equal(miningRouteExclusion(ctx.bot, { position: new Vec3(4, 64, 0) }), 0);
    ctx.bot.entity.position = new Vec3(x, y, z);
    return 'reached';
  };
  await skills.explore_mining_site.handler({}, ctx);
  assert.equal(ctx.bot.pathfinder.movements.exclusionAreasStep, original);
  assert.equal(ctx.bot.pathfinder.movements.infiniteLiquidDropdownDistance, true);
});
