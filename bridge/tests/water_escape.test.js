import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { besideDrop, leaveMagmaBlock, netherRouteExclusion } from '../dry_footing.js';
import { escapeWater, reachShore, waterLike, breathable, avoidWaterScaffolding, allowedDuringWaterEscape, shallowSurfaceExit, shaftFlowBarrier, shoreHeadroomBlock, surfaceSkyLight, waterLanding } from '../water_escape.js';

const block = (name, box = 'empty', props = {}) => ({ name, boundingBox: box, getProperties: () => props });
const water = block('water'), air = block('air'), stone = block('iron_ore', 'block');

test('主世界已加载的露天空气列有直射天光，隔着顶板或未加载时保留原值', () => {
  const pos = new Vec3(-15, 63, 68);
  const column = {minY: -64, worldHeight: 384, sections: []};
  const bot = {blockAt: () => ({skyLight: 0}), game: {dimension: 'overworld'},
    registry: {blocksByName: {air: {defaultState: 0}}}, world: {getColumnAt: () => column}};
  assert.equal(surfaceSkyLight(bot, pos), 15);
  column.sections[11] = {solidBlockCount: 1, get: p => Number(p.x === 1 && p.y === 2 && p.z === 4)};
  assert.equal(surfaceSkyLight(bot, pos), 0);
  assert.equal(surfaceSkyLight(bot, pos.offset(1, 0, 0)), 15);
  bot.world.getColumnAt = () => null;
  assert.equal(surfaceSkyLight(bot, pos), 0);
});
test('水面踏脚石靠实体侧壁放置，避开角色和低顶空间', () => {
  const p = new Vec3(0.5,58.2,0.5);
  let clear = true;
  const bot = {entity: {position: p}, blockAt(v) {
    if (v.y === 58 && v.x === 2) return stone;
    if (v.y === 58 && v.x === 1 && v.z === 0) return water;
    return clear && v.y > 58 ? air : stone;
  }};
  assert.deepEqual(waterLanding(bot), [new Vec3(1,58,0)]);
  clear = false;
  assert.deepEqual(waterLanding(bot), []);
});
test('只在两侧有墙且上游水位更高的一格宽通道封水', () => {
  let openSide = false, level = 1;
  const bot = {entity: {position: new Vec3(101.5, 18, 9.5)}, blockAt(p) {
    if (p.x !== 101) return openSide && p.x === 100 ? air : stone;
    if (p.z === 7 && p.y === 18 || p.z === 6 && p.y === 19) return block('water', 'empty', {level});
    return p.y <= 17 ? stone : air;
  }};
  assert.deepEqual(shaftFlowBarrier(bot), [new Vec3(101,18,7), new Vec3(101,19,7)]);
  level = 0;
  assert.deepEqual(shaftFlowBarrier(bot), []);
  level = 1; openSide = true;
  assert.deepEqual(shaftFlowBarrier(bot), []);
});
test('浅水出口须有稳定单格顶板、明亮水面和可达干岸', () => {
  let cover = 'dirt', waterTop = 60, bank = true;
  const terrain = (x, y) => {
    if (x >= 23 && bank && y === waterTop) return stone;
    if (y < 58) return air;
    if (y === 58) return block(cover, 'block');
    return y <= waterTop ? water : {...air, skyLight: 15};
  };
  const {bot} = fixture(terrain, () => {});
  Object.assign(bot, {health: 20, food: 17, time: {isDay: true}, game: {dimension: 'overworld'}, canDigBlock: () => true});
  assert.equal(shallowSurfaceExit(bot)?.surfaceY, 60);
  bank = false;
  assert.equal(shallowSurfaceExit(bot), null);
  bank = true;
  cover = 'sand';
  assert.equal(shallowSurfaceExit(bot), null);
  cover = 'stone';
  waterTop = 64;
  assert.equal(shallowSurfaceExit(bot), null);
});
test('寻路垫块不选择水中、水面或未知脚下方块', () => {
  const position = new Vec3(0, 1, 0);
  assert.ok(avoidWaterScaffolding({ blockAt: () => water }, { ...air, position }) > 100);
  assert.ok(avoidWaterScaffolding({ blockAt: () => null }, { ...air, position }) > 100);
  assert.ok(avoidWaterScaffolding({ blockAt: () => stone }, { ...water, position }) > 100);
  assert.equal(avoidWaterScaffolding({ blockAt: () => stone }, { ...air, position }), 0);
});
function fixture(terrain, step) {
  let time = 0, bot;
  const controls = {}, looks = [];
  bot = { entity: {position: new Vec3(21.3,56.2,63.7), eyeHeight: 1.62}, oxygenLevel: 8,
    blockAt: p => terrain(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    setControlState: (k,v) => { controls[k] = v; },
    lookAt: async p => { looks.push(p.clone()); },
  };
  return {bot, controls, looks, options: {now: () => time, sleep: async ms => {time += ms; step(bot, controls, looks);}, timeoutMs: 6000}};
}
test('纯上浮直到眼部空气和氧气恢复', async () => {
  const f = fixture((x,y,z) => y >= 59 ? air : water, (b,c) => { if(c.jump) b.entity.position.y += .4; if(b.entity.position.y >= 57.4) b.oxygenLevel = 20; });
  assert.equal(await escapeWater(f.bot, f.options), true); assert.ok(f.bot.entity.position.y > 57); assert.equal(f.controls.jump, false);
});
test('在水底岩浆块上回气时潜行横移，离开气泡柱后再上浮', async () => {
  const magma = block('magma_block', 'block'), bubble = block('bubble_column', 'empty', {drag: true});
  for (const escape of [escapeWater, reachShore]) {
    const f = fixture((x,y,z) => {
      if (z !== 63 || x < 22) return stone;
      if (y === 53) return x === 22 ? magma : stone;
      if (x === 22 && y <= 57) return bubble;
      return x === 23 && y === 54 ? water : air;
    }, (bot, controls) => {
      if (bot.entity.position.x < 23) {
        assert.ok(controls.sneak && controls.forward && !controls.jump);
        bot.entity.position.x = 23.5;
      } else if (controls.forward) {
        bot.entity.position.x = 24.5;
      }
    });
    f.bot.entity.position = new Vec3(22.8,54,63.4);
    f.bot.oxygenLevel = 20;
    assert.ok(await escape(f.bot, f.options));
    assert.ok(f.bot.entity.position.x >= 23);
    assert.equal(f.controls.sneak, false);
  }
});
test('岩浆柱没有已知出口时，水中自救到时仍保持潜行保护', async () => {
  const f = fixture((x,y,z) => x === 21 && z === 63 && y === 55 ? block('magma_block','block') : stone, () => {});
  assert.equal(await escapeWater(f.bot, f.options), false);
  assert.equal(f.controls.sneak, true);
  assert.equal(f.controls.forward, false);
});
test('恢复呼吸后仍在水里时，继续移动到真实干地', async () => {
  const f = fixture((x,y,z) => x >= 23 && y === 55 ? stone : x >= 23 && y >= 56 ? air : y >= 57 ? air : water,
    (b,c) => { if (c.forward) b.entity.position.x += .5; });
  f.bot.oxygenLevel = 20;
  assert.equal(await reachShore(f.bot, f.options), true);
  assert.ok(f.bot.entity.position.x >= 23);
  assert.equal(f.controls.forward, false);
});
test('水面旁有一格高的岸时跳上岸并验收', async () => {
  const f = fixture((x,y,z) => x >= 23 && y === 56 ? stone : y >= 57 ? air : water,
    (b,c) => { if (c.forward) b.entity.position.x += .5; if (c.jump && b.entity.position.x >= 23) b.entity.position.y = 57.2; });
  f.bot.oxygenLevel = 20;
  assert.equal(await reachShore(f.bot, f.options), true);
  assert.ok(f.bot.entity.position.y >= 57);
});
test('补给靠岸跳过河中单独一块干地', async () => {
  const f = fixture((x,y,z) => y === 55 && ((x === 21 && z === 63) || x >= 24) ? stone
    : y >= 56 ? {...air, skyLight: 15} : water, (b,c) => { if (c.forward) b.entity.position.x += .5; });
  f.bot.oxygenLevel = 20;
  assert.equal(await reachShore(f.bot, {...f.options, connected: true}), true);
  assert.ok(f.bot.entity.position.x >= 24);
});
test('水面可呼吸但附近没有干地时不能宣称已经靠岸', async () => {
  const f = fixture((x,y,z) => y >= 57 ? air : water, () => {});
  f.bot.oxygenLevel = 20;
  assert.equal(await reachShore(f.bot, f.options), false);
});
test('有氧气时清理挡住靠岸路线的树叶', async () => {
  let leaves = true, dug = 0;
  const f = fixture((x,y,z) => x === 22 && y === 56 && leaves ? block('oak_leaves','block')
    : x >= 23 && y === 55 ? stone : x >= 23 && y >= 56 ? air : y >= 57 ? air : water,
    (b,c) => { if (c.forward) b.entity.position.x += .5; });
  f.bot.oxygenLevel = 20;
  f.bot.canDigBlock = () => true;
  f.bot.dig = async () => { dug += 1; leaves = false; };
  assert.equal(await reachShore(f.bot, f.options), true);
  assert.equal(dug, 1);
});
test('低氧时不挖树叶并继续保持安全控制', async () => {
  let dug = 0;
  const f = fixture((x,y,z) => x === 22 && y === 56 ? block('oak_leaves', 'block') : water, () => {});
  f.bot.oxygenLevel = 10;
  f.bot.canDigBlock = () => true;
  f.bot.dig = async () => { dug += 1; };
  assert.equal(await reachShore(f.bot, f.options), false);
  assert.equal(dug, 0);
  assert.equal(f.controls.forward, false);
  assert.equal(f.controls.jump, false);
});
test('靠岸路线会绕开实心墙并验证干地落脚点', async () => {
  const f = fixture((x,y,z) => {
    if (x === 22 && z === 63 && y >= 56 && y <= 57) return block('stone', 'block');
    if (x === 24 && z === 62 && y === 55) return stone;
    if (x === 24 && z === 62 && (y === 56 || y === 57)) return air;
    return water;
  }, (b,c,looks) => {
    if (!c.forward || !looks.length) return;
    const aim = looks.at(-1), dx = aim.x - b.entity.position.x, dz = aim.z - b.entity.position.z;
    const length = Math.hypot(dx, dz) || 1;
    b.entity.position.x += dx / length * 0.35;
    b.entity.position.z += dz / length * 0.35;
  });
  f.bot.oxygenLevel = 20;
  assert.equal(await reachShore(f.bot, f.options), true);
  assert.ok(Math.floor(f.bot.entity.position.x) === 24 && Math.floor(f.bot.entity.position.z) === 62);
  assert.equal(f.controls.forward, false);
});
test('保存地形形状：铁矿顶棚侧移至北侧空气', async () => {
  const f = fixture((x,y,z) => x===21 && y===58 && z===63 ? stone : (x===21 && z===62 && y>=58 ? air : water), (b,c,looks) => {
    if(c.forward && looks.length && looks.at(-1).z < b.entity.position.z) b.entity.position.z -= .4;
    if(c.jump && b.entity.position.z < 63) b.entity.position.y += .4;
    if(b.entity.position.z < 63 && b.entity.position.y >= 56.5) b.oxygenLevel = 20;
  });
  assert.equal(await escapeWater(f.bot, f.options), true); assert.ok(f.bot.entity.position.z < 63); assert.ok(f.bot.entity.position.y > 56.2);
});
test('含水碰撞方块、未知和假岸不能视为通路；气泡不等于安全退出', async () => {
  assert.equal(waterLike(block('oak_stairs','block',{waterlogged:true})), true);
  assert.equal(breathable(water), false); assert.equal(breathable(block('bubble_column')), true);
  const f = fixture(() => block('bubble_column'), () => {}); f.bot.oxygenLevel=20;
  assert.equal(await escapeWater(f.bot,f.options),false);
});
test('取消释放控制且缺失氧气不能成功', async () => {
  const token = {}; const f = fixture(() => water, () => {token.cancelled=true;});
  await assert.rejects(escapeWater(f.bot,{...f.options,token})); assert.equal(f.controls.jump,false); assert.equal(f.controls.forward,false);
  const g = fixture(() => air, () => {}); delete g.bot.oxygenLevel; assert.equal(await escapeWater(g.bot,g.options),false);
});

test('靠岸取消立即中断并释放移动控制', async () => {
  const token = {}, f = fixture(() => water, () => { token.cancelled = true; });
  f.bot.oxygenLevel = 20;
  await assert.rejects(reachShore(f.bot, { ...f.options, token }), /靠岸已取消/);
  assert.equal(f.controls.jump, false);
  assert.equal(f.controls.forward, false);
});
test('未知区块和含水实心墙不会被选作出口路线', async () => {
  const f = fixture((x,y,z) => {
    if (x === 21 && z === 63 && y === 58) return stone;
    if (z === 62 && y < 58) return block('oak_stairs','block',{waterlogged:true});
    if (z === 62 && y >= 58) return air;
    if (x !== 21 || z !== 63) return null;
    return water;
  }, () => {});
  assert.equal(await escapeWater(f.bot,f.options),false); assert.equal(f.looks.length,0);
});

test('执行器抢占原动作并完成共享低氧自救', async () => {
  const { ExecutionController } = await import('../execution_controller.js');
  const { LocalReflexScheduler } = await import('../local_reflex.js');
  const controller = new ExecutionController(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  controller.enqueue({id:'mine', run: async () => {await gate; return {status:'succeeded'};}});
  const f = fixture((x,y,z) => y >= 59 ? air : water, (b,c) => {if(c.jump) b.entity.position.y += .4; if(b.entity.position.y >= 57.4) b.oxygenLevel=20;});
  const safety = new LocalReflexScheduler({executor:controller, idFactory:()=> 'oxygen', run: async (event,data,token) => ({status: await escapeWater(f.bot,{...f.options,token}) ? 'succeeded':'failed'})});
  safety.dispatch('low_oxygen',{oxygen:8}); release();
  await new Promise(resolve => setTimeout(resolve,20));
  assert.equal(controller.status('mine').status,'preempted');
  assert.equal(controller.status('oxygen').status,'succeeded');
  assert.equal(f.controls.jump,false);
});

test('低氧未恢复时只允许观察、停止和自救动作', () => {
  for (const tool of ['stop','chat','inventory','observe','locate_block','locate_entity','swim_escape','swim_out']) assert.equal(allowedDuringWaterEscape(tool),true,tool);
  for (const tool of ['safe_travel','leave_shelter','sleep_safe','mine_collect','goto']) assert.equal(allowedDuringWaterEscape(tool),false,tool);
});
test('下界绕开岩浆池相邻的岩浆块边沿', () => {
  const position = new Vec3(19,91,18);
  const bot = { game: { dimension: 'the_nether' }, blockAt: p => p.x === 19 && p.y === 90 ? block('magma_block','block') : air };
  assert.ok(netherRouteExclusion(bot, {position}) > 100);
  assert.ok(netherRouteExclusion(bot, {position: position.offset(1,0,0)}) > 100);
  assert.equal(netherRouteExclusion(bot, {position: position.offset(2,0,0)}),0);
});

test('踩上岩浆块后潜行撤到实心干地再解除控制', async () => {
  const controls = {};
  const bot = {
    entity: { position: new Vec3(0.5, 92, 0.5), onGround: true },
    blockAt: p => p.y >= 92 ? air : block(p.x === 0 ? 'magma_block' : 'basalt', 'block'),
    setControlState: (key, value) => { controls[key] = value; },
    async lookAt() {},
  };
  const landed = await leaveMagmaBlock(bot, {}, async () => {
    assert.ok(controls.sneak && controls.forward);
    bot.entity.position.x += 0.6;
  });
  assert.ok(landed);
  assert.equal(controls.sneak, false);
  assert.equal(controls.forward, false);
});

test('气穴旁没有天然岸边时在完整岩壁开一级台阶', async () => {
  const dug = [];
  const f = fixture((x,y,z) => {
    if (x === 21 && z === 63) return y >= 57 ? air : water;
    if (dug.includes(`${x},${y},${z}`)) return air;
    return {...block('stone','block'), position:new Vec3(x,y,z)};
  }, (bot, controls) => {
    if (controls.forward && dug.length === 2) bot.entity.position = new Vec3(22.5,57,63.5);
  });
  Object.assign(f.bot, {
    oxygenLevel: 20, pathfinder: {bestHarvestTool: () => null}, canDigBlock: () => true, digTime: () => 250,
    async dig(b) { dug.push([b.position.x,b.position.y,b.position.z].join(',')); },
  });
  assert.equal(await reachShore(f.bot, f.options), true);
  assert.deepEqual(dug, ['22,58,63','22,57,63']);
});

test('低顶气穴旁已有干岸时先清出自己起跳所需的净空', async () => {
  let cap = 'air', removed = false;
  const f = fixture((x,y,z) => {
    let name = 'stone';
    if (x === 27 && z === 77) {
      if (y === 61 || y === 62) return water;
      if (y === 63 || y === 64 && removed) return air;
      if (y === 65) name = cap;
    }
    if (x === 27 && z === 78 && (y === 63 || y === 64)) return air;
    return {...block(name, name === 'air' ? 'empty' : 'block'), position: new Vec3(x,y,z)};
  }, (bot, controls) => {
    if (removed && controls.jump && controls.forward) bot.entity.position = new Vec3(27.5,63,78.5);
  });
  f.bot.entity.position = new Vec3(27.49,62.2,77.7);
  Object.assign(f.bot, {oxygenLevel: 20, pathfinder: {bestHarvestTool: () => null}, canDigBlock: () => true,
    digTime: () => 250, async dig(b) { assert.deepEqual(b.position, new Vec3(27,64,77)); removed = true; }});
  for (cap of ['water', 'lava', 'gravel']) assert.equal(shoreHeadroomBlock(f.bot), null);
  cap = 'air';
  f.bot.entity.position.y = 61.75;
  assert.deepEqual(shoreHeadroomBlock(f.bot).position, new Vec3(27,64,77));
  f.bot.entity.position.y = 62.2;
  assert.equal(await reachShore(f.bot, f.options), true);
  assert.ok(removed);
});
test('a scout rejects solid footing beside a deep open shaft and permits a shallow step', () => {
  const p = new Vec3(2, 90, 2);
  const terrain = bottom => ({ blockAt(cell) {
    const ground = cell.x === 3 ? bottom : 89;
    return { boundingBox: cell.y <= ground ? 'block' : 'empty' };
  } });
  assert.equal(besideDrop(terrain(26), p), true);
  assert.equal(besideDrop(terrain(88), p), false);
});
