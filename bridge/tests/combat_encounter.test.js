import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessCombatEncounter,
  bestMeleeWeapon,
  chooseRetreatDestination,
  combatEquipment,
  evaluateEncounterStep,
  isAutomaticCombatTarget,
  retreatSafetyScore,
} from '../combat_encounter.js';

function makeEntity(id, name, x, options = {}) {
  return {
    id,
    name,
    type: 'hostile',
    isValid: true,
    position: { x, y: 64, z: options.z || 0 },
    velocity: options.velocity || { x: 0, y: 0, z: 0 },
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
}

const origin = { x: 0, y: 64, z: 0 };

test('combat encounter switches to a visibly higher-threat hostile instead of retaining the nearest target', async () => {
  const zombie = makeEntity(1, 'zombie', 7);
  const skeleton = makeEntity(2, 'skeleton', 4);
  const entities = { [zombie.id]: zombie, [skeleton.id]: skeleton };
  const result = await evaluateEncounterStep({
    entities,
    origin,
    health: 20,
    currentTarget: zombie,
    requestedTarget: zombie,
    allowTargetSwitch: true,
  });

  assert.equal(result.status, 'continue');
  assert.equal(result.target, skeleton);
  assert.equal(result.switched, true);
  assert.equal(result.encounter.primary.entity, skeleton);
});

test('encounter is reassessed between strikes and retreats from a side creeper closing on the bot', async () => {
  const zombie = makeEntity(1, 'zombie', 2);
  const entities = { [zombie.id]: zombie };
  const first = await evaluateEncounterStep({
    entities,
    origin,
    health: 20,
    currentTarget: zombie,
    requestedTarget: zombie,
    allowTargetSwitch: true,
  });
  assert.equal(first.status, 'continue');

  const creeper = makeEntity(2, 'creeper', 8, { velocity: { x: -1, y: 0, z: 0 } });
  entities[creeper.id] = creeper;
  const retreats = [];
  const second = await evaluateEncounterStep({
    entities,
    origin,
    health: 20,
    currentTarget: zombie,
    requestedTarget: zombie,
    allowTargetSwitch: true,
    retreat: async (target) => { retreats.push(target); return true; },
  });

  assert.equal(second.status, 'retreated');
  assert.equal(second.threat, creeper);
  assert.equal(second.moved_away, true);
  assert.match(second.encounter.retreat_reason, /苦力怕正在接近/);
  assert.deepEqual(retreats, [creeper]);
});

test('1.21.1 creeper swell and ignition metadata trigger a retreat before another hit', async () => {
  const metadataKeys = [
    'shared_flags', 'air_supply', 'custom_name', 'custom_name_visible', 'silent',
    'no_gravity', 'pose', 'ticks_frozen', 'living_entity_flags', 'health',
    'effect_particles', 'effect_ambience', 'arrow_count', 'stinger_count',
    'sleeping_pos', 'mob_flags', 'swell_dir', 'is_powered', 'is_ignited',
  ];
  const metadata = [];
  metadata[metadataKeys.indexOf('swell_dir')] = 1;
  const creeper = makeEntity(3, 'creeper', 10, { metadata });
  const registry = { entitiesByName: { creeper: { metadataKeys } } };
  const zombie = makeEntity(1, 'zombie', 2);
  const encounter = assessCombatEncounter({
    entities: { [zombie.id]: zombie, [creeper.id]: creeper },
    origin,
    registry,
    health: 20,
    radius: 16,
  });

  assert.equal(encounter.should_retreat, true);
  assert.equal(encounter.urgent.entity, creeper);
  assert.equal(encounter.urgent.fusing, true);
  assert.match(encounter.retreat_reason, /正在引爆/);

  metadata[metadataKeys.indexOf('swell_dir')] = -1;
  metadata[metadataKeys.indexOf('is_ignited')] = true;
  const ignited = assessCombatEncounter({
    entities: { [creeper.id]: creeper }, origin, registry, health: 20, radius: 16,
  });
  assert.equal(ignited.urgent.fusing, true);
});

test('low health and several nearby mobs produce an explicit retreat decision', async () => {
  const entities = {
    1: makeEntity(1, 'zombie', 2),
    2: makeEntity(2, 'skeleton', -3),
    3: makeEntity(3, 'spider', 4),
  };
  let retreatedFrom = null;
  const result = await evaluateEncounterStep({
    entities,
    origin,
    health: 8,
    requestedTarget: entities[1],
    currentTarget: entities[1],
    retreat: async (target) => { retreatedFrom = target; return false; },
  });

  assert.equal(result.status, 'retreated');
  assert.equal(result.moved_away, false);
  assert.equal(retreatedFrom, result.encounter.primary.entity);
  assert.match(result.encounter.retreat_reason, /群怪威胁过高/);
});

test('a creeper fuse check uses metadata keys and ignores unrelated entity metadata', () => {
  const metadataKeys = ['shared_flags', 'swell_dir', 'is_powered', 'is_ignited'];
  const creeper = makeEntity(3, 'creeper', 3, { metadata: [0, -1, 0, false] });
  const encounter = assessCombatEncounter({
    entities: { [creeper.id]: creeper },
    origin,
    registry: { entitiesByName: { creeper: { metadataKeys } } },
    health: 20,
    radius: 16,
  });

  assert.equal(encounter.should_retreat, true);
  assert.equal(encounter.urgent.fusing, false);
  assert.match(encounter.retreat_reason, /苦力怕正在接近/);
});

test('calm Endermen are excluded from pressure and automatic target selection', () => {
  const metadataKeys = ['shared_flags', 'creepy', 'stared_at'];
  const enderman = makeEntity(7, 'enderman', 2, { metadata: [0, false, false] });
  const registry = { entitiesByName: { enderman: { metadataKeys } } };
  const encounter = assessCombatEncounter({
    entities: { [enderman.id]: enderman }, origin, registry, health: 20,
  });
  assert.equal(encounter.threats.length, 0);
  assert.equal(isAutomaticCombatTarget(enderman, registry), false);

  enderman.metadata[1] = true;
  const aggressive = assessCombatEncounter({
    entities: { [enderman.id]: enderman }, origin, registry, health: 20,
  });
  assert.equal(aggressive.threats.length, 1);
  assert.equal(isAutomaticCombatTarget(enderman, registry), true);
});

test('an explicitly engaged calm Enderman remains part of its encounter', () => {
  const enderman = makeEntity(7, 'enderman', 2, { metadata: { creepy: false, stared_at: false } });
  const encounter = assessCombatEncounter({
    entities: { [enderman.id]: enderman }, origin, health: 20, currentTarget: enderman,
  });
  assert.equal(encounter.threats.length, 1);
  assert.equal(encounter.threats[0].entity, enderman);
});

test('the combat loadout reads a weapon and worn armor from the Mineflayer inventory', () => {
  const loadout = combatEquipment({
    inventory: {
      items: () => [{ name: 'iron_sword' }],
      slots: [null, null, null, null, null, { name: 'iron_helmet' }, { name: 'iron_chestplate' },
        { name: 'iron_leggings' }, { name: 'iron_boots' }],
    },
  });
  assert.deepEqual(loadout, {
    weapon_tier: 3,
    armor_tier: 3,
    armor_pieces: 4,
    armor_protective_pieces: 4,
    combat_ready: true,
  });

  const thinArmor = combatEquipment({
    inventory: {
      items: () => [{ name: 'iron_sword' }],
      slots: [null, null, null, null, null, { name: 'iron_helmet' }, { name: 'leather_chestplate' },
        { name: 'leather_leggings' }, null],
    },
  });
  assert.equal(thinArmor.combat_ready, false);
  assert.equal(thinArmor.armor_protective_pieces, 1);

  const weapons = [{ name: 'wooden_axe' }, { name: 'diamond_sword' }, { name: 'iron_sword' }];
  assert.equal(bestMeleeWeapon({ inventory: { items: () => weapons } }), weapons[1]);
});

test('a Warden always triggers avoidance and a low-gear Ravager triggers retreat', async () => {
  const warden = makeEntity(8, 'warden', 15);
  const wardenResult = await evaluateEncounterStep({
    entities: { [warden.id]: warden }, origin, health: 20,
  });
  assert.equal(wardenResult.status, 'retreated');
  assert.match(wardenResult.encounter.retreat_reason, /監守者/);

  const ravager = makeEntity(9, 'ravager', 4);
  const lowGear = assessCombatEncounter({
    entities: { [ravager.id]: ravager }, origin, health: 20,
  });
  assert.equal(lowGear.should_retreat, true);
  assert.match(lowGear.retreat_reason, /装备不足.*ravager/);

  const prepared = assessCombatEncounter({
    entities: { [ravager.id]: ravager }, origin, health: 20,
    equipment: { combat_ready: true },
  });
  assert.equal(prepared.should_retreat, false);
});

test('low combat capacity lowers the group pressure threshold while equipped gear retains it', () => {
  const entities = {
    1: makeEntity(1, 'zombie', 3),
    2: makeEntity(2, 'zombie', -3),
    3: makeEntity(3, 'zombie', 0, { z: 3 }),
  };
  const lowGear = assessCombatEncounter({ entities, origin, health: 20, equipment: {
    weapon_tier: 0, armor_protective_pieces: 0, combat_ready: false,
  } });
  const ready = assessCombatEncounter({ entities, origin, health: 20, equipment: { combat_ready: true } });
  assert.equal(lowGear.pressure, 15);
  assert.equal(lowGear.should_retreat, true);
  assert.equal(ready.should_retreat, false);
});

test('retreat destination opens distance from a fuse threat without entering another mob range', () => {
  const creeper = makeEntity(10, 'creeper', 2);
  const zombie = makeEntity(11, 'zombie', -8);
  const threats = [
    { entity: creeper, name: 'creeper', distance: 2, fusing: true },
    { entity: zombie, name: 'zombie', distance: 8, fusing: false },
  ];
  const destination = chooseRetreatDestination(origin, threats, { stepDistance: 12 });
  assert.ok(destination);

  const creeperDistance = Math.hypot(destination.x - creeper.position.x, destination.z - creeper.position.z);
  const zombieDistance = Math.hypot(destination.x - zombie.position.x, destination.z - zombie.position.z);
  assert.ok(creeperDistance >= 12);
  assert.ok(zombieDistance >= 7);
  const destinationScore = retreatSafetyScore({ ...destination, y: origin.y }, threats);
  assert.ok(Number.isFinite(destinationScore));
  assert.ok(destinationScore > retreatSafetyScore(origin, threats));
});
