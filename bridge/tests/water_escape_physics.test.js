import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import minecraftData from 'minecraft-data';
import blockFactory from 'prismarine-block';
import physicsModule from 'prismarine-physics';
import { Vec3 } from 'vec3';
import { escapeWater } from '../water_escape.js';

const data = minecraftData('1.21.1');
const Block = blockFactory('1.21.1');
const { Physics, PlayerState } = physicsModule;
const terrain = JSON.parse(fs.readFileSync(new URL('./fixtures/drowning_terrain.json', import.meta.url)));

test('保存地形与实际 Prismarine 碰撞：低氧时侧移绕过铁矿顶棚恢复呼吸', async () => {
  const cells = new Map(terrain.blocks.map(([x,y,z,id]) => [`${x},${y},${z}`, terrain.palette[id]]));
  const world = {
    getBlock(position) {
      const p = position.floored();
      const state = cells.get(`${p.x},${p.y},${p.z}`);
      if (!state) return null;
      const props = Object.fromEntries(Object.entries(state.properties).map(([key,value]) =>
        [key, value === 'true' ? true : value === 'false' ? false : /^\d+$/.test(value) ? Number(value) : value]));
      const block = Block.fromProperties(data.blocksByName[state.name].id, props, 0);
      block.position = p;
      return block;
    },
  };
  const controls = Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(k => [k,false]));
  const bot = {
    version: '1.21.1', health: 20, oxygenLevel: 8,
    entity: { position: new Vec3(21.3,56.2,63.7), velocity: new Vec3(0,0,0),
      eyeHeight: 1.62, height: 1.8, yaw: 0, pitch: 0, effects: {}, attributes: {},
      onGround: false, isInWater: true, isInLava: false, isInWeb: false,
      isCollidedHorizontally: false, isCollidedVertically: false, elytraFlying: false },
    inventory: { slots: [] }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    blockAt: p => world.getBlock(p),
    setControlState: (key,value) => { controls[key] = value; },
    async lookAt(point) {
      // 与本地 Mineflayer lookAt 使用同一角度约定；位移由真实物理积分产生。
      const d = point.minus(this.entity.position.offset(0,this.entity.eyeHeight,0));
      this.entity.yaw = Math.atan2(-d.x,-d.z);
      this.entity.pitch = Math.atan2(d.y,Math.hypot(d.x,d.z));
    },
  };
  let time = 0, air = 120;
  const trace = [];
  const physics = Physics(data,world);
  let success;
  try { success = await escapeWater(bot, {radius:4, timeoutMs:20000, now:()=>time, sleep:async ms=>{
    for (let t=0;t<ms;t+=50) {
      physics.simulatePlayer(new PlayerState(bot,controls),world).apply(bot);
      const eye = world.getBlock(bot.entity.position.offset(0,1.62,0));
      // 服务器氧气和伤害采用确定性机制替身；移动、碰撞和水流使用真实依赖。
      if (eye && ['air','cave_air','bubble_column'].includes(eye.name)) air=Math.min(300,air+4);
      else air--;
      if (air<=-20) {air=0;bot.health-=2;}
      bot.oxygenLevel=Math.round(air/15);
      time+=50;
    }
    trace.push({time,position:bot.entity.position.clone(),oxygen:bot.oxygenLevel,yaw:bot.entity.yaw});
  }}); } catch (error) {
    assert.fail(`${error.message}; trace=${JSON.stringify(trace)}`);
  }
  assert.equal(success,true,`未脱困：${bot.entity.position}, health=${bot.health}, oxygen=${bot.oxygenLevel}`);
  assert.ok(bot.health>0);
  assert.ok(bot.oxygenLevel>=19);
  assert.match(world.getBlock(bot.entity.position.offset(0,1.62,0)).name,/^(air|cave_air)$/);
  assert.ok(bot.entity.position.distanceTo(new Vec3(21.3,56.2,63.7))>.5);
  assert.ok(Object.values(controls).every(v=>v===false));
});
