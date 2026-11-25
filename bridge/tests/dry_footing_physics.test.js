import assert from 'node:assert/strict';
import test from 'node:test';
import minecraftData from 'minecraft-data';
import blockFactory from 'prismarine-block';
import physicsModule from 'prismarine-physics';
import { Vec3 } from 'vec3';
import { walkDryCell } from '../dry_footing.js';

test('主世界矿道逐格上下台阶，使用 Java 1.21.1 方块和 Prismarine 碰撞', async () => {
  const data = minecraftData('1.21.1'), Block = blockFactory('1.21.1');
  const controls = {forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false};
  const world = {getBlock(point) {
    const p = point.floored(), floor = 60 + Math.max(0, Math.min(2, p.x));
    const name = p.z !== 0 || p.y <= floor || p.y > floor + 3 ? 'stone' : 'air';
    const b = Block.fromStateId(data.blocksByName[name].defaultState, 0);
    b.position = p;
    return b;
  }};
  const bot = {
    version: '1.21.1', game: {dimension: 'overworld'}, health: 20, inventory: {slots: []},
    entity: {position: new Vec3(0.5, 61, 0.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0,
      onGround: true, height: 1.8, eyeHeight: 1.62, effects: {}, attributes: {}},
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    blockAt: p => world.getBlock(p), setControlState: (name, value) => { controls[name] = value; },
    async look(yaw, pitch) { this.entity.yaw = yaw; this.entity.pitch = pitch; },
  };
  const physics = physicsModule.Physics(data, world);
  const ctx = {bot, sleep: async () => physics.simulatePlayer(new physicsModule.PlayerState(bot, controls), world).apply(bot)};
  for (const x of [1, 2, 1, 0]) {
    assert.equal(await walkDryCell(ctx, new Vec3(x, 61 + x, 0), 'overworld'), 'reached');
    assert.ok(bot.entity.onGround);
    assert.ok(Object.values(controls).every(value => !value));
  }
});
