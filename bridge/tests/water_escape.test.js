import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { escapeWater, reachShore, waterLike, breathable, avoidWaterScaffolding, allowedDuringWaterEscape } from '../water_escape.js';

const block = (name, box = 'empty', props = {}) => ({ name, boundingBox: box, getProperties: () => props });
const water = block('water'), air = block('air'), stone = block('iron_ore', 'block');
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
