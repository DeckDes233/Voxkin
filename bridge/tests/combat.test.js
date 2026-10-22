import assert from 'node:assert/strict';
import test from 'node:test';

import { skills } from '../skills/combat.js';

function makeSheep(id, colorIndex = 0, sheared = false, baby = false) {
  const metadata = {};
  metadata[16] = baby;
  metadata[17] = colorIndex | (sheared ? 0x10 : 0);
  return {
    id,
    name: 'sheep',
    type: 'animal',
    isValid: true,
    position: { x: id, y: 0, z: 0 },
    metadata,
  };
}

function makeContext(sheep, { color = 'white', wool = 0, giveWool = true, woolPerSheep = 3, shears = true } = {}) {
  const itemName = `${color}_wool`;
  const inventory = { [itemName]: wool };
  const botPosition = {
    x: 0,
    y: 0,
    z: 0,
    distanceTo(position) {
      return Math.hypot(this.x - position.x, this.y - position.y, this.z - position.z);
    },
  };
  const bot = {
    entity: { position: botPosition },
    entities: Object.fromEntries(sheep.map((entity) => [entity.id, entity])),
    inventory: {
      items: () => shears ? [{ name: 'shears' }] : [],
    },
    async equip() {},
    async activateEntity(entity) {
      entity.metadata[17] |= 0x10;
    },
  };
  return {
    bot,
    registry: {
      entitiesByName: {
        sheep: { metadataKeys: ['shared_flags', 'air_supply', 'custom_name', 'custom_name_visible', 'silent', 'no_gravity', 'pose', 'ticks_frozen', 'living_entity_flags', 'health', 'effect_particles', 'effect_ambience', 'arrow_count', 'stinger_count', 'sleeping_pos', 'mob_flags', 'baby', 'wool'] },
      },
    },
    countItem: (name) => inventory[name] || 0,
    itemLabel: (name) => name,
    async approach() {},
    async sleep() {},
    async collectDrops(range, name) {
      assert.equal(range, 6);
      assert.equal(name, itemName);
      if (giveWool) inventory[itemName] += woolPerSheep;
      return { picked: giveWool ? { [itemName]: woolPerSheep } : {}, missed: giveWool ? [] : [itemName] };
    },
  };
}

test('shear_sheep verifies wool gain and skips already-sheared sheep', async () => {
  const shorn = makeSheep(1, 0, true);
  const sheep = makeSheep(2, 0);
  const ctx = makeContext([shorn, sheep]);

  const result = await skills.shear_sheep.handler({ count: 3, color: 'auto' }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(ctx.countItem('white_wool'), 3);
  assert.equal(shorn.metadata[17], 0x10);
  assert.equal(sheep.metadata[17], 0x10);
});

test('shear_sheep skips lambs', async () => {
  const lamb = makeSheep(1, 0, false, true);
  const ctx = makeContext([lamb]);

  await assert.rejects(
    skills.shear_sheep.handler({ count: 3, color: 'white' }, ctx),
    /没有可剪的white羊/,
  );
  assert.equal(ctx.countItem('white_wool'), 0);
  assert.equal(lamb.metadata[17], 0);
});

test('shear_sheep succeeds from inventory without nearby sheep', async () => {
  const ctx = makeContext([], { wool: 3 });

  const result = await skills.shear_sheep.handler({ count: 3, color: 'auto' }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.match(result.detail, /已经有 3 个/);
});
test('shear_sheep rejects a server interaction that yields no wool', async () => {
  const ctx = makeContext([makeSheep(1)], { giveWool: false });

  await assert.rejects(
    skills.shear_sheep.handler({ count: 3, color: 'white' }, ctx),
    /没有增加羊毛/,
  );
});

test('shear_sheep rejects missing shears before interacting', async () => {
  const ctx = makeContext([makeSheep(1)], { shears: false });

  await assert.rejects(
    skills.shear_sheep.handler({ count: 3, color: 'white' }, ctx),
    /没有剪刀/,
  );
});

test('shear_sheep prefers a color already present in inventory', async () => {
  const ctx = makeContext([makeSheep(1, 14)], { color: 'red', wool: 2 });

  const result = await skills.shear_sheep.handler({ count: 3, color: 'auto' }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(ctx.countItem('red_wool'), 5);
  assert.equal(ctx.countItem('white_wool'), 0);
});

test('shear_sheep reports insufficient matching sheep without false success', async () => {
  const ctx = makeContext([makeSheep(1, 0)], { woolPerSheep: 1 });

  await assert.rejects(
    skills.shear_sheep.handler({ count: 3, color: 'auto' }, ctx),
    /羊毛不够，还差/,
  );
  assert.equal(ctx.countItem('white_wool'), 1);
});

test('shear_sheep stops before interaction after cancellation', async () => {
  const sheep = makeSheep(1);
  const ctx = makeContext([sheep]);
  ctx.approach = async () => {
    ctx.interrupted = true;
  };

  await assert.rejects(
    skills.shear_sheep.handler({ count: 3, color: 'white' }, ctx),
    /被新的指令打断/,
  );
  assert.equal(ctx.countItem('white_wool'), 0);
  assert.equal(sheep.metadata[17], 0);
});
