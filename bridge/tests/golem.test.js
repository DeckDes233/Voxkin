import assert from 'node:assert/strict';
import test from 'node:test';

import { skills } from '../skills/golem.js';

class Vec3 {
  constructor(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  offset(dx, dy, dz) {
    return new Vec3(this.x + dx, this.y + dy, this.z + dz);
  }
}

function block(name, boundingBox = 'block') {
  return { name, boundingBox };
}

function makeContext({
  player = { x: 0.5, y: 64, z: 0.5 },
  golem = { x: 3, y: 64, z: 0.5 },
  items = { cobblestone: 3, iron_sword: 1, iron_ingot: 0 },
  hostiles = [],
  killAfterAttacks = 2,
  dropIron = 2,
  moveToCandidate = true,
  approachResult = null,
  loseTopBlockOnAttack = false,
  cancelAfterFirstPlacement = false,
  failFinalLanding = false,
} = {}) {
  const blocks = new Map();
  const controls = new Map();
  const walks = [];
  const attacks = [];
  const retreats = [];
  const sleepCalls = [];
  const keyOf = ({ x, y, z }) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
  const air = block('air', 'empty');
  const position = new Vec3(player.x, player.y, player.z);
  const entity = {
    position,
    onGround: true,
    velocity: new Vec3(0, 0, 0),
    height: 1.8,
  };
  const ironGolem = {
    id: 71,
    name: 'iron_golem',
    type: 'mob',
    position: new Vec3(golem.x, golem.y, golem.z),
    width: 1.4,
    height: 2.7,
    health: 100,
    isValid: true,
  };
  const inventoryItems = () => Object.entries(items)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => ({ name, count }));
  const highestPillarY = () => {
    let highest = 63;
    for (const [key, value] of blocks) {
      if (!value || value.name !== 'cobblestone') continue;
      const [x, y, z] = key.split(',').map(Number);
      if (x === Math.floor(position.x) && z === Math.floor(position.z)) highest = Math.max(highest, y);
    }
    return highest + 1;
  };
  let attackCount = 0;
  let maxCombatJumpY = -Infinity;
  let firstAttackY = null;
  const bot = {
    entity,
    health: 20,
    time: { isDay: true },
    entities: { [ironGolem.id]: ironGolem },
    registry: {
      blocksByName: {
        cobblestone: { name: 'cobblestone', boundingBox: 'block' },
        sand: { name: 'sand', boundingBox: 'block' },
      },
    },
    inventory: { items: inventoryItems },
    heldItem: null,
    blockAt(point) {
      const stored = blocks.get(keyOf(point));
      if (stored) return stored;
      if (Math.floor(point.y) === 63) return block('stone');
      return air;
    },
    setControlState(name, enabled) {
      controls.set(name, enabled);
      if (name === 'jump' && enabled && entity.onGround) {
        entity.onGround = false;
        entity.position.y += 0.25;
        entity.velocity.y = 0.45;
      }
    },
    async lookAt() {},
    attack(target) {
      assert.equal(target, ironGolem);
      assert.equal(controls.get('sneak'), true, 'the player stays crouched during the strike');
      assert.equal(entity.onGround, false, 'attack must occur before landing');
      assert.ok(entity.velocity.y < -0.01, 'attack must occur during descent');
      assert.ok(Math.hypot(entity.position.x - target.position.x, entity.position.z - target.position.z) <= 2.5);
      const eyeY = entity.position.y + 1.27;
      const dx = Math.max(0, Math.abs(entity.position.x - target.position.x) - target.width / 2);
      const dz = Math.max(0, Math.abs(entity.position.z - target.position.z) - target.width / 2);
      const dy = eyeY > target.position.y + target.height
        ? eyeY - target.position.y - target.height
        : eyeY < target.position.y ? target.position.y - eyeY : 0;
      assert.ok(Math.hypot(dx, dy, dz) <= 3, 'the eye point must be within actual melee reach of the golem AABB');
      for (let y = 64; y <= 66; y += 1) {
        assert.equal(bot.blockAt(new Vec3(entity.position.x, y, entity.position.z)).name, 'cobblestone');
      }
      maxCombatJumpY = Math.max(maxCombatJumpY, entity.position.y);
      firstAttackY ??= entity.position.y;
      attacks.push({ x: entity.position.x, y: entity.position.y, z: entity.position.z });
      attackCount += 1;
      ironGolem.health = attackCount >= killAfterAttacks ? 0 : 100 - attackCount * 20;
      if (attackCount >= killAfterAttacks) {
        ironGolem.isValid = false;
        delete bot.entities[String(ironGolem.id)];
      }
      if (loseTopBlockOnAttack) blocks.delete('0,66,0');
    },
  };
  for (let x = -32; x <= 32; x += 1) {
    for (let z = -32; z <= 32; z += 1) blocks.set(`${x},63,${z}`, block('stone'));
  }

  const ctx = {
    bot,
    interrupted: false,
    countItem: (name) => Number(items[name]) || 0,
    nearbyHostiles: () => hostiles,
    async equipWeapon() { bot.heldItem = { name: 'iron_sword' }; },
    async placeBlock({ block: name, x, y, z }) {
      blocks.set(`${x},${y},${z}`, block(name));
      if (failFinalLanding && y === 66) {
        entity.position.y = y + 2;
        entity.onGround = true;
        entity.velocity.y = 0;
      } else {
        entity.position.y = y + 1;
        entity.onGround = true;
        entity.velocity.y = 0;
      }
      if (cancelAfterFirstPlacement && y === 64) ctx.interrupted = true;
    },
    async walkOnce(x, y, z, radius, timeout) {
      walks.push({ x, y, z, radius, timeout });
      if (approachResult) return approachResult;
      if (!moveToCandidate) return 'unreachable';
      entity.position.x = x;
      entity.position.y = y;
      entity.position.z = z;
      entity.onGround = true;
      entity.velocity.y = 0;
      return 'reached';
    },
    async travelTo(x, y, z) {
      entity.position.x = x;
      entity.position.y = y;
      entity.position.z = z;
      entity.onGround = true;
    },
    async retreatFrom(target) {
      retreats.push(target);
      return true;
    },
    async collectDrops() {
      items.iron_ingot += dropIron;
    },
    async sleep(duration) {
      sleepCalls.push(duration);
      if (entity.onGround) return;
      if (entity.velocity.y > 0) {
        entity.position.y += 0.45;
        entity.velocity.y -= 0.2;
        maxCombatJumpY = Math.max(maxCombatJumpY, entity.position.y);
        return;
      }
      const landingY = highestPillarY();
      const nextY = entity.position.y - 0.45;
      if (nextY <= landingY) {
        entity.position.y = landingY;
        entity.onGround = true;
        entity.velocity.y = 0;
      } else {
        entity.position.y = nextY;
        entity.velocity.y -= 0.2;
      }
    },
  };
  return {
    ctx,
    bot,
    blocks,
    controls,
    walks,
    attacks,
    retreats,
    sleepCalls,
    items,
    ironGolem,
    get maxCombatJumpY() { return maxCombatJumpY; },
    get firstAttackY() { return firstAttackY; },
  };
}

test('harvest_iron_golem approaches an observed safe site from ten blocks away and verifies the pillar before descending strikes', async () => {
  const world = makeContext({
    player: { x: 0.5, y: 64, z: 0.5 },
    golem: { x: 10.5, y: 64, z: 0.5 },
  });

  const result = await skills.harvest_iron_golem.handler({ entity_id: 71 }, world.ctx);

  assert.equal(result.status, 'succeeded');
  assert.ok(world.walks.length > 0);
  assert.ok(result.data.approach_attempts > 0);
  assert.equal(result.data.pillar.height, 3);
  assert.equal(result.data.pillar.verified, true);
  assert.equal(result.data.target_gone, true);
  assert.equal(result.data.iron_ingot_gained, 2);
  assert.ok(world.attacks.length >= 2);
  assert.ok(world.firstAttackY < world.maxCombatJumpY, 'the first strike happens after the real Vec3 apex');
  assert.equal(world.controls.get('jump'), false);
  assert.equal(world.controls.get('sneak'), false);
  for (const control of ['forward', 'back', 'left', 'right', 'sprint']) {
    assert.equal(world.controls.get(control), false);
  }
});

test('entity disappearance without an iron ingot inventory increase is partial, not success', async () => {
  const world = makeContext({ killAfterAttacks: 1, dropIron: 0 });

  const result = await skills.harvest_iron_golem.handler({ entity_id: 71 }, world.ctx);

  assert.equal(result.status, 'partial');
  assert.equal(result.data.target_gone, true);
  assert.equal(result.data.iron_ingot_gained, 0);
  assert.match(result.detail, /没有增加/);
});

test('a broken pillar stops the fight and attempts retreat after the strike', async () => {
  const world = makeContext({ loseTopBlockOnAttack: true });

  const result = await skills.harvest_iron_golem.handler({ entity_id: 71 }, world.ctx);

  assert.equal(result.status, 'partial');
  assert.equal(world.attacks.length, 1);
  assert.equal(world.retreats.length, 1);
  assert.equal(result.data.retreat_confirmed, true);
  assert.match(result.data.stop_reason, /垫脚方块/);
  assert.equal(world.controls.get('jump'), false);
  assert.equal(world.controls.get('sneak'), false);
});

test('unreliable pillar inventory and nearby hostiles prevent approaching or angering the golem', async (t) => {
  await t.test('sand is rejected as a falling pillar block', async () => {
    const world = makeContext({ items: { sand: 3, iron_sword: 1, iron_ingot: 0 } });
    const result = await skills.harvest_iron_golem.handler({ entity_id: 71 }, world.ctx);
    assert.equal(result.status, 'partial');
    assert.equal(world.walks.length, 0);
    assert.equal(world.attacks.length, 0);
    assert.match(result.detail, /可靠的全实体垫脚方块/);
  });

  await t.test('hostile pressure prevents approaching a neutral golem', async () => {
    const world = makeContext({ hostiles: [{ name: 'zombie' }] });
    const result = await skills.harvest_iron_golem.handler({ entity_id: 71 }, world.ctx);
    assert.equal(result.status, 'partial');
    assert.equal(world.walks.length, 0);
    assert.equal(world.attacks.length, 0);
    assert.equal(world.blocks.has('0,64,0'), false);
  });
});

test('cancellation during pillar construction releases sneak and jump controls and propagates', async () => {
  const world = makeContext({ cancelAfterFirstPlacement: true });

  await assert.rejects(
    skills.harvest_iron_golem.handler({ entity_id: 71 }, world.ctx),
    /新的指令打断/,
  );
  assert.equal(world.controls.get('jump'), false);
  assert.equal(world.controls.get('sneak'), false);
  assert.equal(world.controls.get('sprint'), false);
  assert.equal(world.attacks.length, 0);
});

test('a cancelled approach is propagated instead of being treated as another unreachable candidate', async () => {
  const world = makeContext({
    player: { x: 0.5, y: 64, z: 0.5 },
    golem: { x: 10.5, y: 64, z: 0.5 },
    approachResult: 'cancelled',
  });

  await assert.rejects(
    skills.harvest_iron_golem.handler({ entity_id: 71 }, world.ctx),
    /靠近站位被取消/,
  );
  assert.equal(world.attacks.length, 0);
  assert.equal(world.walks.length, 1);
});

test('a full three-block structure without the expected player height never starts combat', async () => {
  const world = makeContext({ failFinalLanding: true });

  const result = await skills.harvest_iron_golem.handler({ entity_id: 71 }, world.ctx);

  assert.equal(result.status, 'partial');
  assert.equal(world.attacks.length, 0);
  assert.equal(result.data.pillar.height, 3);
  assert.equal(result.data.pillar.verified, false);
  assert.match(result.data.stop_reason, /没有确认落在新放置的垫脚方块上/);
});
