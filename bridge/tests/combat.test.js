import assert from 'node:assert/strict';
import test from 'node:test';

import { crystalAimPoint, nearbyFoodAnimal, skills, visibleCrystalAim } from '../skills/combat.js';
import { Vec3 } from 'vec3';

test('a healthy respawn can observe a nearby dry food source in daylight', () => {
  let wet = false;
  const bot = {
    entity: {position: new Vec3(0, 64, 0)}, health: 20, food: 20, time: {isDay: true},
    game: {dimension: 'overworld'}, entities: {1: {name: 'sheep', position: new Vec3(10, 64, 0)}},
    blockAt: p => p.y === 63 ? {name: 'dirt', boundingBox: 'block'} : {name: wet ? 'water' : 'air', boundingBox: 'empty'},
  };
  assert.equal(nearbyFoodAnimal(bot), true);
  wet = true;
  assert.equal(nearbyFoodAnimal(bot), false);
  wet = false;
  bot.time.isDay = false;
  assert.equal(nearbyFoodAnimal(bot), false);
  Object.assign(bot, {health: 6, food: 14});
  assert.equal(nearbyFoodAnimal(bot), true);
});

test('a fully charged Java arrow reaches an elevated crystal at the computed angle', () => {
  const feet = new Vec3(40.5, 61, 8.5);
  const bot = { entity: { position: feet, eyeHeight: 1.62 } };
  const crystal = { position: new Vec3(33.5, 83, 24.5), height: 2 };
  const aim = crystalAimPoint(bot, crystal);
  let velocity = aim.minus(feet.offset(0, 1.62, 0)).normalize().scaled(3);
  let p = feet.offset(0, 1.52, 0);
  let distance = Infinity;
  for (let tick = 0; tick < 30; tick++) {
    for (let i = 0; i < 10; i++) distance = Math.min(distance, p.plus(velocity.scaled(i / 10)).distanceTo(crystal.position.offset(0, 1, 0)));
    p = p.plus(velocity);
    velocity = velocity.scaled(0.99).offset(0, -0.05, 0);
  }
  assert.ok(distance < 0.35);
});

test('crystal shots ignore a block intersection beyond the checked segment and stop at a nearer one', () => {
  const feet = new Vec3(0.5, 64, 0.5);
  const crystal = { position: new Vec3(25.5, 75, 1.5), height: 2 };
  let beyond = true;
  const block = { position: new Vec3(0, 0, 0), shapes: [[0, 0, 0, 1, 1, 1]] };
  const world = { raycast(origin, direction, range, matches) {
    const distance = beyond ? range + 0.1 : range / 2;
    const iterator = { intersect: () => ({ pos: origin.plus(direction.scaled(distance)) }) };
    return matches(block, iterator) ? block : null;
  } };
  const bot = { entity: { position: feet, eyeHeight: 1.62 }, world };
  assert.ok(visibleCrystalAim(bot, crystal));
  beyond = false;
  assert.equal(visibleCrystalAim(bot, crystal), null);
});

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
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    entities: Object.fromEntries(sheep.map((entity) => [entity.id, entity])),
    pathfinder: { movements: { liquidCost: 12, blocksToAvoid: new Set() } },
    blockAt(position) {
      if (position.y === 0) return { name: 'grass_block', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    },
    findBlocks({ matching, maxDistance }) {
      const supports = [];
      for (let index = 0; index < 48; index += 1) {
        const angle = (Math.PI * 2 * index) / 48;
        const distance = 12 + (index % 4);
        const position = {
          x: Math.round(botPosition.x + Math.cos(angle) * distance),
          y: 0,
          z: Math.round(botPosition.z + Math.sin(angle) * distance),
        };
        if (Math.hypot(position.x - botPosition.x, position.z - botPosition.z) > maxDistance) continue;
        if (matching({ name: 'grass_block', boundingBox: 'block' })) supports.push(position);
      }
      return supports;
    },
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
      blocksByName: {
        water: { id: 8 },
        flowing_water: { id: 9 },
        bubble_column: { id: 10 },
      },
      entitiesByName: {
        sheep: { metadataKeys: ['shared_flags', 'air_supply', 'custom_name', 'custom_name_visible', 'silent', 'no_gravity', 'pose', 'ticks_frozen', 'living_entity_flags', 'health', 'effect_particles', 'effect_ambience', 'arrow_count', 'stinger_count', 'sleeping_pos', 'mob_flags', 'baby', 'wool'] },
      },
    },
    countItem: (name) => inventory[name] || 0,
    itemLabel: (name) => name,
    async approach() {},
    async sleep() {},
    isSleepTime: () => false,
    isThunderstorm: () => false,
    nearbyHostiles: () => [],
    walkOnce: async () => 'unreachable',
    async collectDrops(range, name) {
      assert.equal(range, 6);
      assert.equal(name, itemName);
      if (giveWool) inventory[itemName] += woolPerSheep;
      return { picked: giveWool ? { [itemName]: woolPerSheep } : {}, missed: giveWool ? [] : [itemName] };
    },
  };
}

test('hunt_material wool completes one color without shears and ignores babies and shorn sheep', async () => {
  const ctx = makeContext([makeSheep(1, 15), makeSheep(2), makeSheep(3, 15),
    makeSheep(4, 15, true), makeSheep(5, 15, false, true)],
    { color: 'black', wool: 1, woolPerSheep: 1, shears: false });
  const attacked = [];
  ctx.attackEntity = async target => { attacked.push(target.id); target.isValid = false; };
  const result = await skills.hunt_material.handler({ item: 'wool', count: 3 }, ctx);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(attacked, [1, 3]);
  assert.equal(ctx.countItem('black_wool'), 3);
});

test('hunt_material wool wanders when no sheep are loaded and verifies drops after finding them', async () => {
  const ctx = makeContext([], { woolPerSheep: 1, shears: false });
  let walked = 0;
  ctx.walkOnce = async (x, y, z) => {
    walked += 1;
    Object.assign(ctx.bot.entity.position, { x, y, z });
    const sheep = makeSheep(walked);
    sheep.position = { x: x + 1, y, z };
    ctx.bot.entities[sheep.id] = sheep;
    return 'reached';
  };
  ctx.attackEntity = async target => { target.isValid = false; };
  assert.equal((await skills.hunt_material.handler({ item: 'wool', count: 3 }, ctx)).status, 'succeeded');
  assert.equal(walked, 3);
  assert.equal(ctx.countItem('white_wool'), 3);
});

function makePosition(x, y, z) {
  return {
    x,
    y,
    z,
    distanceTo(other) { return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z); },
    offset(dx, dy, dz) { return makePosition(this.x + dx, this.y + dy, this.z + dz); },
  };
}

function makeCombatSearchContext({ species = 'spider', item = 'string', targetAtStep = 0, dropsPerKill = 1, initialCount = 0 } = {}) {
  const inventory = { [item]: initialCount };
  const position = makePosition(0, 1, 0);
  const walked = [];
  let hostileAtStep = 0;
  const bot = {
    entity: { position },
    health: 20,
    entities: {},
    pathfinder: { movements: { liquidCost: 12, blocksToAvoid: new Set([99]) } },
    blockAt(blockPosition) {
      if (Math.floor(blockPosition.y) === 0) return { name: 'stone', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    },
    findBlocks({ matching, maxDistance }) {
      const supports = [];
      for (let dx = -18; dx <= 18; dx += 3) {
        for (let dz = -18; dz <= 18; dz += 3) {
          const candidate = {
            x: Math.floor(position.x) + dx,
            y: 0,
            z: Math.floor(position.z) + dz,
          };
          if (Math.hypot(dx, dz) > maxDistance) continue;
          if (matching({ name: 'stone', boundingBox: 'block', position: candidate })) supports.push(candidate);
        }
      }
      return supports;
    },
    attack(target) { target.isValid = false; },
    async lookAt() {},
  };
  const ctx = {
    bot,
    registry: {
      blocksByName: {
        water: { id: 8 },
        flowing_water: { id: 9 },
        bubble_column: { id: 10 },
      },
    },
    interrupted: false,
    countItem: (name) => inventory[name] || 0,
    itemLabel: (name) => name,
    nearbyHostiles: () => walked.length >= hostileAtStep ? (hostileAtStep ? [{ name: 'zombie' }] : []) : [],
    blockIsWater: () => false,
    findRangedWeapon: () => null,
    async approach() {},
    async attackEntity(target) { target.isValid = false; },
    async collectDrops(_range, name) {
      inventory[name] = (inventory[name] || 0) + dropsPerKill;
      return { picked: { [name]: dropsPerKill }, missed: [] };
    },
    async syncInventory() {},
    async sleep() {},
    log() {},
    random: () => 0.25,
    walked,
    setHostileAtStep(step) { hostileAtStep = step; },
    async walkOnce(x, y, z) {
      walked.push({ x, y, z });
      position.x = x;
      position.y = y;
      position.z = z;
      if (targetAtStep === walked.length) {
        const target = {
          id: 100 + walked.length,
          name: species,
          isValid: true,
          position: makePosition(x + 2, y, z),
        };
        bot.entities[target.id] = target;
      }
      if (typeof ctx.onWalk === 'function') return ctx.onWalk();
      return 'reached';
    },
  };
  return { ctx, inventory, walked, bot };
}

function makeAnimalSearchContext(options = {}) {
  const search = makeCombatSearchContext({
    species: options.species || 'pig',
    item: options.item || 'porkchop',
    targetAtStep: options.targetAtStep || 0,
  });
  const { ctx } = search;
  ctx.bot.food = 20;
  ctx.bot.time = { day: 1, timeOfDay: 6000 };
  ctx.isSleepTime = () => false;
  ctx.isThunderstorm = () => false;
  ctx.findHostile = () => ctx.nearbyHostiles(16).length > 0
    ? { name: 'zombie', position: makePosition(ctx.bot.entity.position.x + 1, ctx.bot.entity.position.y, ctx.bot.entity.position.z) }
    : null;
  ctx.retreatFrom = async () => {};
  return search;
}

test('combat material search advances to a new supported waypoint before hunting', async () => {
  const { ctx, inventory, walked } = makeCombatSearchContext({ targetAtStep: 2 });

  const result = await skills.hunt_material.handler({ item: 'string', count: 1, radius: 48, min_health: 12 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(inventory.string, 1);
  assert.equal(walked.length, 2);
  assert.notDeepEqual(walked[0], walked[1]);
});

test('combat material search preserves partial drops when its waypoint budget is exhausted', async () => {
  const { ctx, inventory, walked } = makeCombatSearchContext({ targetAtStep: 1, dropsPerKill: 1 });

  await assert.rejects(
    skills.hunt_material.handler({ item: 'string', count: 2, radius: 48, min_health: 12 }, ctx),
    /还差 1 个string/,
  );

  assert.equal(inventory.string, 1);
  assert.equal(walked.length, 8);
  assert.equal(new Set(walked.map(({ x, z }) => `${x},${z}`)).size, walked.length);
  // 固定朝 +Z 搜索，每一段都必须向前推进，不能绕回旧区域。
  let previousZ = 0;
  for (const waypoint of walked) {
    assert.ok(waypoint.z > previousZ + 3, JSON.stringify(walked));
    previousZ = waypoint.z;
  }
});

test('hunt_material stops before attacking when health drops during the chase', async () => {
  const { ctx, bot } = makeCombatSearchContext();
  const spider = {
    id: 70,
    name: 'spider',
    isValid: true,
    position: makePosition(5, 1, 0),
  };
  bot.entities[spider.id] = spider;
  bot.health = 13;
  let attacks = 0;
  ctx.approach = async () => {
    bot.health = 10;
    spider.position = makePosition(2, 1, 0);
  };
  ctx.attackEntity = async () => { attacks += 1; };

  await assert.rejects(
    skills.hunt_material.handler({ item: 'string', count: 1, min_health: 12 }, ctx),
    /血量不足/,
  );

  assert.equal(attacks, 0);
});

test('hunt_material treats count as total inventory and gathers only the remaining amount', async () => {
  const { ctx, inventory, walked } = makeCombatSearchContext({ targetAtStep: 1, initialCount: 1 });

  const result = await skills.hunt_material.handler({ item: 'string', count: 2 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(inventory.string, 2);
  assert.equal(walked.length, 1);
});

test('enderman search advances across distinct waypoints and keeps the earned pearl', async () => {
  const { ctx, inventory, walked } = makeCombatSearchContext({
    species: 'enderman',
    item: 'ender_pearl',
    targetAtStep: 3,
  });

  const result = await skills.hunt_enderman.handler({ count: 1, radius: 48 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(inventory.ender_pearl, 1);
  assert.equal(walked.length, 3);
  assert.equal(new Set(walked.map(({ x, z }) => `${x},${z}`)).size, walked.length);
});

test('hunt_enderman stops before engaging a visible target at its health floor', async () => {
  const { ctx, bot } = makeCombatSearchContext({ species: 'enderman', item: 'ender_pearl' });
  const enderman = {
    id: 80,
    name: 'enderman',
    isValid: true,
    position: makePosition(2, 1, 0),
  };
  bot.entities[enderman.id] = enderman;
  bot.health = 8;
  let attacks = 0;
  bot.attack = () => { attacks += 1; };

  await assert.rejects(
    skills.hunt_enderman.handler({ count: 1, radius: 48 }, ctx),
    /血量不足/,
  );

  assert.equal(attacks, 0);
});

test('hunt_enderman counts prior pearls toward the requested total', async () => {
  const { ctx, inventory, walked } = makeCombatSearchContext({
    species: 'enderman',
    item: 'ender_pearl',
    targetAtStep: 1,
    initialCount: 1,
  });

  const result = await skills.hunt_enderman.handler({ count: 2, radius: 48 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(inventory.ender_pearl, 2);
  assert.equal(walked.length, 1);
});

test('hunt_enderman uses melee and does not spend arrows even when a bow is available', async () => {
  const { ctx, inventory, bot } = makeCombatSearchContext({
    species: 'enderman',
    item: 'ender_pearl',
    targetAtStep: 1,
  });
  ctx.bot.blockAt = () => ({ name: 'air', boundingBox: 'empty' });
  let shots = 0;
  let attacks = 0;
  ctx.findRangedWeapon = () => ({ bow: { name: 'bow' }, arrows: { name: 'arrow' } });
  ctx.shootAt = async () => { shots += 1; return true; };
  bot.attack = (target) => {
    attacks += 1;
    target.isValid = false;
  };

  const result = await skills.hunt_enderman.handler({ count: 1, radius: 48 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(inventory.ender_pearl, 1);
  assert.equal(shots, 0);
  assert.equal(attacks, 1);
  assert.doesNotMatch(result.detail, /水源|硬追/);
  assert.doesNotMatch(result.detail, /服务器曾报告末影人乘载状态/);
});

test('enderman search stops at its finite waypoint budget', async () => {
  const { ctx, walked } = makeCombatSearchContext({ species: 'enderman', item: 'ender_pearl' });

  const failure = await skills.hunt_enderman.handler({ count: 2, radius: 48 }, ctx).catch((error) => error);
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /有限安全搜索未能确认附近有末影人.*有限安全搜索路线耗尽/);
  assert.doesNotMatch(failure.message, /附近 48 格内没有末影人/);

  assert.equal(walked.length, 8);
  assert.equal(ctx.bot.pathfinder.movements.liquidCost, 12);
  assert.deepEqual([...ctx.bot.pathfinder.movements.blocksToAvoid], [99]);
});

test('combat search stops on cancellation and restores pathfinder safety settings', async () => {
  const { ctx, walked, bot } = makeCombatSearchContext();
  ctx.onWalk = () => {
    ctx.interrupted = true;
    return 'stopped';
  };

  await assert.rejects(
    skills.hunt_material.handler({ item: 'string', count: 1, radius: 48, min_health: 12 }, ctx),
    /被新的指令打断/,
  );

  assert.equal(walked.length, 1);
  assert.equal(bot.pathfinder.movements.liquidCost, 12);
  assert.deepEqual([...bot.pathfinder.movements.blocksToAvoid], [99]);
});

test('enderman search observes cancellation at its first waypoint', async () => {
  const { ctx, walked, bot } = makeCombatSearchContext({ species: 'enderman', item: 'ender_pearl' });
  ctx.onWalk = () => {
    ctx.interrupted = true;
    return 'stopped';
  };

  await assert.rejects(
    skills.hunt_enderman.handler({ count: 1, radius: 48 }, ctx),
    /被新的指令打断/,
  );

  assert.equal(walked.length, 1);
  assert.equal(bot.pathfinder.movements.liquidCost, 12);
  assert.deepEqual([...bot.pathfinder.movements.blocksToAvoid], [99]);
});

test('combat search stops when hostiles appear after a waypoint without continuing the route', async () => {
  const { ctx, walked, bot } = makeCombatSearchContext();
  ctx.setHostileAtStep(1);

  await assert.rejects(
    skills.hunt_material.handler({ item: 'string', count: 1, radius: 48, min_health: 12 }, ctx),
    /附近有敌对生物或无法确认安全/,
  );

  assert.equal(walked.length, 1);
  assert.equal(bot.pathfinder.movements.liquidCost, 12);
  assert.deepEqual([...bot.pathfinder.movements.blocksToAvoid], [99]);
});

test('缺粮时步行寻找附近的猎物，拾取后恢复寻路设置', async () => {
  const {ctx, inventory, walked} = makeAnimalSearchContext({targetAtStep: 1});
  ctx.bot.food = 7;
  const movements = ctx.bot.pathfinder.movements;
  Object.assign(movements, {allowSprinting: true, allowParkour: true, canDig: true});
  ctx.onWalk = () => {
    assert.equal(movements.allowSprinting, false);
    assert.equal(movements.allowParkour, false);
    assert.equal(movements.canDig, false);
    return 'reached';
  };
  await assert.rejects(skills.hunt_animal.handler({count: 1}, ctx), /饥饿值/);
  const result = await skills.hunt_animal.handler({count: 1, walk_only: true}, ctx);
  assert.equal(result.status, 'succeeded');
  assert.ok(inventory.porkchop >= 1);
  assert.equal(walked.length, 1);
  assert.ok(movements.allowSprinting && movements.allowParkour && movements.canDig);
});

test('最近的猎物连续无法接近时，改追同一片区域的其他猎物', async () => {
  const {ctx, bot, inventory} = makeAnimalSearchContext();
  const pig = id => ({id, name: 'pig', isValid: true, position: makePosition(id, 1, 0)});
  const near = pig(7), far = pig(12);
  bot.entities = {7: near, 12: far};
  let failedApproaches = 0;
  ctx.approach = async target => {
    if (target === near) assert.ok(++failedApproaches <= 3);
    else bot.entity.position.x = target.position.x;
  };
  const result = await skills.hunt_animal.handler({count: 1}, ctx);
  assert.equal(result.status, 'succeeded');
  assert.ok(inventory.porkchop && near.isValid && !far.isValid);
});

test('nearby-only recovery stops without wandering and restores movement restrictions', async () => {
  const {ctx, walked} = makeAnimalSearchContext({targetAtStep: 1});
  ctx.bot.health = 3;
  const mov = ctx.bot.pathfinder.movements;
  const exclusions = [];
  Object.assign(mov, {maxDropDown: 4, infiniteLiquidDropdownDistance: true, exclusionAreasStep: exclusions});
  await assert.rejects(skills.hunt_animal.handler({nearby_only: true, min_health: 2}, ctx), /附近没有可从干地接近的猎物/);
  assert.deepEqual(walked, []);
  assert.equal(mov.maxDropDown, 4);
  assert.equal(mov.infiniteLiquidDropdownDistance, true);
  assert.equal(mov.exclusionAreasStep, exclusions);
});

test('普通白天狩猎也排除水路，并在寻猎结束后恢复原设置', async () => {
  const {ctx} = makeAnimalSearchContext({targetAtStep: 1});
  const mov = ctx.bot.pathfinder.movements;
  const previous = [];
  Object.assign(mov, {exclusionAreasStep: previous, maxDropDown: 4, infiniteLiquidDropdownDistance: true});
  let checked = false;
  ctx.onWalk = () => {
    const blockAt = ctx.bot.blockAt;
    try {
      ctx.bot.blockAt = () => ({name: 'water', boundingBox: 'empty'});
      assert.ok(mov.exclusionAreasStep.at(-1)({position: new Vec3(0,63,0)}) >= 100);
      assert.equal(mov.infiniteLiquidDropdownDistance, false);
      assert.equal(mov.maxDropDown, 1);
    } finally { ctx.bot.blockAt = blockAt; }
    checked = true;
    return 'reached';
  };
  await skills.hunt_animal.handler({count: 1}, ctx);
  assert.ok(checked);
  assert.equal(mov.exclusionAreasStep, previous);
});

test('hunt_animal exits after route cancellation even if an animal appears at the waypoint', async () => {
  const { ctx, walked } = makeAnimalSearchContext({ targetAtStep: 1 });
  let approaches = 0;
  let attacks = 0;
  ctx.onWalk = () => {
    ctx.interrupted = true;
    return 'stopped';
  };
  ctx.approach = async () => { approaches += 1; };
  ctx.attackEntity = async () => { attacks += 1; };

  await assert.rejects(
    skills.hunt_animal.handler({ count: 1, species: 'pig' }, ctx),
    /新的指令打断/,
  );

  assert.equal(walked.length, 1);
  assert.equal(approaches, 0);
  assert.equal(attacks, 0);
});

test('hunt_animal checks hostiles after a waypoint before chasing a discovered animal', async () => {
  const { ctx, walked } = makeAnimalSearchContext({ targetAtStep: 1 });
  let approaches = 0;
  let attacks = 0;
  ctx.setHostileAtStep(1);
  ctx.approach = async () => { approaches += 1; };
  ctx.attackEntity = async () => { attacks += 1; };

  await assert.rejects(
    skills.hunt_animal.handler({ count: 1, species: 'pig' }, ctx),
    /附近仍有敌对生物/,
  );

  assert.equal(walked.length, 1);
  assert.equal(approaches, 0);
  assert.equal(attacks, 0);
});

test('hunt_animal stops when a waypoint is stopped without cancellation metadata', async () => {
  const { ctx, walked } = makeAnimalSearchContext();
  ctx.onWalk = () => 'stopped';

  await assert.rejects(
    skills.hunt_animal.handler({ count: 1, species: 'pig' }, ctx),
    /搜索动物时移动已停止/,
  );

  assert.equal(walked.length, 1);
});

test('hunt_animal reports a finite search result without claiming the full radius is empty', async () => {
  const { ctx, walked } = makeAnimalSearchContext();
  const realNow = Date.now;
  let currentTime = realNow();
  Date.now = () => currentTime;
  ctx.sleep = async (ms) => { currentTime += Number(ms) || 0; };

  try {
    const failure = await skills.hunt_animal.handler({ count: 1, species: 'pig', radius: 48 }, ctx)
      .catch((error) => error);
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /有限安全搜索未能确认附近有可猎的猪/);
    assert.doesNotMatch(failure.message, /附近没有可以狩猎的动物/);
    assert.equal(walked.length, 8);
  } finally {
    Date.now = realNow;
  }
});

test('combat material search does not move when health is at its configured minimum', async () => {
  const { ctx, walked } = makeCombatSearchContext();
  ctx.bot.health = 12;

  await assert.rejects(
    skills.hunt_material.handler({ item: 'string', count: 1, radius: 48, min_health: 12 }, ctx),
    /血量不足/,
  );

  assert.equal(walked.length, 0);
});

test('hunt_material verifies the requested drop count', async () => {
  const inventory = { string: 0 };
  const position = {
    x: 0,
    y: 0,
    z: 0,
    distanceTo(other) { return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z); },
  };
  const spider = { id: 1, name: 'spider', isValid: true, position: { x: 1, y: 0, z: 0 } };
  const ctx = {
    bot: { entity: { position }, entities: { 1: spider }, health: 20 },
    interrupted: false,
    countItem: (name) => inventory[name] || 0,
    itemLabel: (name) => name,
    async approach() {},
    async attackEntity(target) { target.isValid = false; },
    async collectDrops() { inventory.string += 1; return { picked: { string: 1 }, missed: [] }; },
    async syncInventory() {},
    async sleep() {},
    log() {},
  };

  const result = await skills.hunt_material.handler({ item: 'string', count: 1 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(inventory.string, 1);
});

test('hunt_animal can exclude sheep while hunting other meat sources', async () => {
  const inventory = { beef: 0, porkchop: 0 };
  const position = {
    x: 0,
    y: 0,
    z: 0,
    distanceTo(other) { return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z); },
  };
  const sheep = { id: 1, name: 'sheep', isValid: true, position: { x: 1, y: 0, z: 0 } };
  const pig = { id: 2, name: 'pig', isValid: true, position: { x: 2, y: 0, z: 0 } };
  const ctx = {
    bot: { entity: { position }, entities: { 1: sheep, 2: pig }, health: 20, time: { timeOfDay: 6000 } },
    interrupted: false,
    countItem: (name) => inventory[name] || 0,
    itemLabel: (name) => name,
    async approach() {},
    async attackEntity(target) { target.isValid = false; },
    async collectDrops(_range, name) {
      inventory[name] = (inventory[name] || 0) + 1;
      return { picked: { [name]: 1 }, missed: [] };
    },
    async sleep() {},
    log() {},
  };

  const result = await skills.hunt_animal.handler(
    { count: 1, exclude_species: ['sheep'] },
    ctx,
  );

  assert.equal(result.status, 'succeeded');
  assert.equal(inventory.porkchop, 1);
  assert.equal(sheep.isValid, true);
});

test('hunt_material does not claim success when a kill yields no requested drop', async () => {
  const inventory = { feather: 0 };
  const realNow = Date.now;
  let currentTime = realNow();
  Date.now = () => currentTime;
  const position = {
    x: 0,
    y: 0,
    z: 0,
    distanceTo(other) { return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z); },
  };
  const entities = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [index + 1, {
      id: index + 1,
      name: 'chicken',
      isValid: true,
      position: { x: index + 1, y: 0, z: 0 },
    }]),
  );
  const ctx = {
    bot: { entity: { position }, entities, health: 20 },
    interrupted: false,
    countItem: (name) => inventory[name] || 0,
    itemLabel: (name) => name,
    async approach() {},
    async attackEntity(target) { target.isValid = false; },
    async collectDrops() { return { picked: {}, missed: ['feather'] }; },
    async syncInventory() {},
    async sleep(ms) { currentTime += ms; },
    log() {},
  };

  try {
    await assert.rejects(skills.hunt_material.handler({ item: 'feather', count: 1 }, ctx), /还差 1 个feather/);
    assert.equal(inventory.feather, 0);
  } finally {
    Date.now = realNow;
  }
});

test('hunt_material stops before attacking when below the health threshold', async () => {
  const position = {
    x: 0,
    y: 0,
    z: 0,
    distanceTo(other) { return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z); },
  };
  const spider = { id: 1, name: 'spider', isValid: true, position: { x: 1, y: 0, z: 0 } };
  let attacks = 0;
  const ctx = {
    bot: { entity: { position }, entities: { 1: spider }, health: 10 },
    interrupted: false,
    countItem: () => 0,
    itemLabel: (name) => name,
    async approach() {},
    async attackEntity() { attacks += 1; },
    log() {},
  };

  await assert.rejects(skills.hunt_material.handler({ item: 'string', count: 1, min_health: 12 }, ctx), /血量不足/);
  assert.equal(attacks, 0);
});

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

test('shear_sheep treats omitted default wool metadata as an adult white sheep', async () => {
  const sheep = makeSheep(1);
  sheep.metadata = {};
  const ctx = makeContext([sheep]);

  const result = await skills.shear_sheep.handler({ count: 3, color: 'white' }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(ctx.countItem('white_wool'), 3);
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

test('shear_sheep skips an unreachable sheep and continues with another', async () => {
  const unreachable = makeSheep(1);
  unreachable.position.x = 10;
  const reachable = makeSheep(2);
  const ctx = makeContext([unreachable, reachable]);
  ctx.approach = async (target) => {
    if (target.id === reachable.id) {
      ctx.bot.entity.position.x = target.position.x;
      ctx.bot.entity.position.z = target.position.z;
    }
  };

  const result = await skills.shear_sheep.handler({ count: 3, color: 'white' }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(unreachable.metadata[17], 0);
  assert.equal(reachable.metadata[17], 0x10);
});

test('shear_sheep succeeds from inventory without nearby sheep', async () => {
  const ctx = makeContext([], { wool: 3 });

  const result = await skills.shear_sheep.handler({ count: 3, color: 'auto' }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.match(result.detail, /已经有 3 个/);
});

test('shear_sheep explores random waypoints until it discovers a sheep', async () => {
  const ctx = makeContext([]);
  const sheep = makeSheep(1);
  let searches = 0;
  let randomState = 42;
  const waypoints = [];
  ctx.random = () => {
    randomState = (randomState * 1664525 + 1013904223) >>> 0;
    return randomState / 0x100000000;
  };
  ctx.walkOnce = async (x, y, z, radius, timeout, horizontalOnly) => {
    searches += 1;
    assert.deepEqual([y, radius, timeout, horizontalOnly], [1, 3, 18000, true]);
    waypoints.push({ x, z });
    ctx.bot.entity.position.x = x;
    ctx.bot.entity.position.z = z;
    sheep.position.x = x;
    sheep.position.z = z;
    ctx.bot.entities[sheep.id] = sheep;
    ctx.approach = async (target) => {
      ctx.bot.entity.position.x = target.position.x;
      ctx.bot.entity.position.z = target.position.z;
    };
    return 'reached';
  };

  const result = await skills.shear_sheep.handler({ count: 3, color: 'auto' }, ctx);

  assert.equal(searches, 4);
  assert.equal(new Set(waypoints.map(({ x, z }) => `${x},${z}`)).size, waypoints.length);
  assert.ok(waypoints.every(({ x, z }) => Math.hypot(x, z) <= 48));
  assert.equal(result.status, 'succeeded');
  assert.equal(ctx.countItem('white_wool'), 3);
});

test('shear_sheep discovers sheep while exploring a random walk route', async () => {
  const ctx = makeContext([]);
  const waypoints = [];
  let randomState = 7;
  ctx.random = () => {
    randomState = (randomState * 1664525 + 1013904223) >>> 0;
    return randomState / 0x100000000;
  };
  ctx.walkOnce = async (x, y, z) => {
    waypoints.push({ x, z });
    ctx.bot.entity.position.x = x;
    ctx.bot.entity.position.z = z;
    if (waypoints.length === 3) {
      for (const id of [1, 2, 3]) {
        const sheep = makeSheep(id);
        sheep.position.x = x;
        sheep.position.z = z;
        ctx.bot.entities[id] = sheep;
      }
      ctx.approach = async (target) => {
        ctx.bot.entity.position.x = target.position.x;
        ctx.bot.entity.position.z = target.position.z;
      };
    }
    return 'reached';
  };

  const result = await skills.shear_sheep.handler({ count: 3, radius: 48 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(ctx.countItem('white_wool'), 3);
  assert.equal(waypoints.length, 3);
  for (let index = 0; index < waypoints.length; index += 1) {
    const waypoint = waypoints[index];
    assert.ok(Math.hypot(waypoint.x, waypoint.z) <= 48);
    if (index > 0) {
      const previous = waypoints[index - 1];
      assert.ok(Math.hypot(waypoint.x - previous.x, waypoint.z - previous.z) >= 10);
    }
  }
});

test('shear_sheep revisits an eligible sheep discovered before walking farther away', async () => {
  const ctx = makeContext([]);
  const sheep = makeSheep(1);
  ctx.bot.findBlocks = () => [];
  const randomValues = [0, 0, 0.5, 1, 0.5, 1, 0.5, 1, 0, 1, 0.5, 1];
  let randomIndex = 0;
  ctx.random = () => randomValues[randomIndex++] ?? 0;
  let searches = 0;
  ctx.walkOnce = async (x, y, z) => {
    searches += 1;
    ctx.bot.entity.position.x = x;
    ctx.bot.entity.position.z = z;
    if (searches === 1) {
      sheep.position.x = x;
      sheep.position.z = z;
      ctx.bot.entities[sheep.id] = sheep;
    }
    ctx.approach = async (target) => {
      ctx.bot.entity.position.x = target.position.x;
      ctx.bot.entity.position.z = target.position.z;
    };
    return 'reached';
  };

  const result = await skills.shear_sheep.handler({ count: 3, color: 'auto' }, ctx);

  assert.equal(searches, 4);
  assert.equal(result.status, 'succeeded');
  assert.equal(ctx.countItem('white_wool'), 3);
});

test('shear_sheep auto samples beyond one rare-colored sheep before selecting a flock', async () => {
  const ctx = makeContext([], { color: 'white' });
  let searches = 0;
  ctx.walkOnce = async (x, y, z) => {
    searches += 1;
    ctx.bot.entity.position.x = x;
    ctx.bot.entity.position.z = z;
    if (searches === 1) {
      const sheep = makeSheep(1, 6);
      sheep.position.x = x;
      sheep.position.z = z;
      ctx.bot.entities[sheep.id] = sheep;
    }
    if (searches === 4) {
      for (const id of [2, 3, 4]) {
        const sheep = makeSheep(id, 0);
        sheep.position.x = x;
        sheep.position.z = z;
        ctx.bot.entities[sheep.id] = sheep;
      }
      ctx.approach = async (target) => {
        ctx.bot.entity.position.x = target.position.x;
        ctx.bot.entity.position.z = target.position.z;
      };
    }
    return 'reached';
  };

  const result = await skills.shear_sheep.handler({ count: 3, color: 'auto' }, ctx);

  assert.equal(searches, 4);
  assert.equal(result.status, 'succeeded');
  assert.equal(ctx.countItem('white_wool'), 3);
  assert.equal(ctx.countItem('pink_wool'), 0);
});

test('shear_sheep chooses dry supported waypoints and restores pathfinding settings', async () => {
  const ctx = makeContext([]);
  let selectedWaypoint;
  let liquidCostDuringSearch;
  let avoidedBlocksDuringSearch;
  ctx.bot.findBlocks = ({ matching }) => {
    const wetGround = { x: 12, y: 0, z: 0 };
    const dryGround = { x: 0, y: 0, z: 12 };
    return [
      ...(matching({ name: 'water', boundingBox: 'empty' }) ? [wetGround] : []),
      ...(matching({ name: 'grass_block', boundingBox: 'block' }) ? [dryGround] : []),
    ];
  };
  ctx.random = () => 0;
  ctx.walkOnce = async (x, y, z) => {
    selectedWaypoint = { x, y, z };
    liquidCostDuringSearch = ctx.bot.pathfinder.movements.liquidCost;
    avoidedBlocksDuringSearch = [...ctx.bot.pathfinder.movements.blocksToAvoid];
    ctx.interrupted = true;
    return 'reached';
  };

  await assert.rejects(
    skills.shear_sheep.handler({ count: 3, radius: 48 }, ctx),
    /被新的指令打断/,
  );
  assert.deepEqual(selectedWaypoint, { x: 0, y: 1, z: 12 });
  assert.equal(liquidCostDuringSearch, 32);
  assert.deepEqual(avoidedBlocksDuringSearch, [8, 9, 10]);
  assert.equal(ctx.bot.pathfinder.movements.liquidCost, 12);
  assert.deepEqual([...ctx.bot.pathfinder.movements.blocksToAvoid], []);
});

test('shear_sheep filters nearby supports before Mineflayer truncates block results', async () => {
  const ctx = makeContext([]);
  let selectedWaypoint;
  ctx.bot.findBlocks = ({ matching, maxDistance, count }) => {
    const supports = [];
    for (let x = -20; x <= 20; x += 1) {
      for (let z = -20; z <= 20; z += 1) {
        const distance = Math.hypot(x, z);
        const position = { x, y: 0, z };
        if (distance <= maxDistance && matching({ name: 'grass_block', boundingBox: 'block', position })) {
          supports.push(position);
        }
      }
    }
    return supports
      .sort((left, right) => Math.hypot(left.x, left.z) - Math.hypot(right.x, right.z))
      .slice(0, count);
  };
  ctx.random = () => 0;
  ctx.walkOnce = async (x, y, z) => {
    selectedWaypoint = { x, y, z };
    ctx.interrupted = true;
    return 'reached';
  };

  await assert.rejects(
    skills.shear_sheep.handler({ count: 3, radius: 48 }, ctx),
    /被新的指令打断/,
  );
  assert.ok(Math.hypot(selectedWaypoint.x, selectedWaypoint.z) >= 10);
  assert.ok(Math.hypot(selectedWaypoint.x, selectedWaypoint.z) <= 18);
});

test('shear_sheep expands its bounded search route instead of randomly revisiting nearby ground', async () => {
  const ctx = makeContext([]);
  const waypoints = [];
  ctx.bot.findBlocks = ({ matching, maxDistance, count }) => {
    const supports = [];
    for (let x = -24; x <= 24; x += 1) {
      for (let z = -24; z <= 24; z += 1) {
        const position = { x, y: 0, z };
        if (Math.hypot(x - ctx.bot.entity.position.x, z - ctx.bot.entity.position.z) > maxDistance) continue;
        if (matching({ name: 'grass_block', boundingBox: 'block', position })) supports.push(position);
      }
    }
    return supports
      .sort((left, right) => Math.hypot(left.x - ctx.bot.entity.position.x, left.z - ctx.bot.entity.position.z) -
        Math.hypot(right.x - ctx.bot.entity.position.x, right.z - ctx.bot.entity.position.z))
      .slice(0, count);
  };
  ctx.random = () => 0;
  ctx.walkOnce = async (x, y, z) => {
    waypoints.push({ x, y, z });
    ctx.bot.entity.position.x = x;
    ctx.bot.entity.position.z = z;
    if (waypoints.length === 6) ctx.interrupted = true;
    return 'reached';
  };

  await assert.rejects(
    skills.shear_sheep.handler({ count: 3, radius: 48 }, ctx),
    /被新的指令打断/,
  );

  const radii = waypoints.map(({ x, z }) => Math.hypot(x, z));
  assert.equal(waypoints.length, 6);
  assert.ok(radii[0] >= 11 && radii[0] <= 15);
  assert.ok(radii.every((radius) => radius <= 48));
  assert.ok(Math.max(...radii) > radii[0]);
  assert.equal(new Set(waypoints.map(({ x, z }) => `${x},${z}`)).size, waypoints.length);
  assert.ok(waypoints.every(({ x, y, z }) => Number.isFinite(x) && y === 1 && Number.isFinite(z)));
});

test('shear_sheep expands searches to the requested radius', async () => {
  const ctx = makeContext([]);
  const waypoints = [];
  ctx.bot.findBlocks = ({ matching, maxDistance, count }) => {
    const supports = [];
    for (let x = -72; x <= 72; x += 1) {
      for (let z = -72; z <= 72; z += 1) {
        const position = { x, y: 0, z };
        if (Math.hypot(x - ctx.bot.entity.position.x, z - ctx.bot.entity.position.z) > maxDistance) continue;
        if (matching({ name: 'grass_block', boundingBox: 'block', position })) supports.push(position);
      }
    }
    return supports
      .sort((left, right) => Math.hypot(left.x - ctx.bot.entity.position.x, left.z - ctx.bot.entity.position.z) -
        Math.hypot(right.x - ctx.bot.entity.position.x, right.z - ctx.bot.entity.position.z))
      .slice(0, count);
  };
  ctx.random = () => 0;
  ctx.walkOnce = async (x, y, z) => {
    waypoints.push({ x, y, z });
    ctx.bot.entity.position.x = x;
    ctx.bot.entity.position.z = z;
    if (waypoints.length === 40) ctx.interrupted = true;
    return 'reached';
  };

  await assert.rejects(
    skills.shear_sheep.handler({ count: 3, radius: 64 }, ctx),
    /被新的指令打断/,
  );

  assert.equal(waypoints.length, 40);
  assert.ok(waypoints.at(-1));
  assert.ok(Math.hypot(waypoints.at(-1).x, waypoints.at(-1).z) > 35);
  assert.ok(waypoints.every(({ x, y, z }) => Math.hypot(x, z) <= 96 && y === 1));
});

test('shear_sheep uses a bounded pathfinding waypoint when no safe support data is available', async () => {
  const ctx = makeContext([]);
  let selectedWaypoint;
  const waypoints = [];
  ctx.bot.findBlocks = () => [];
  ctx.random = () => 0;
  ctx.walkOnce = async (x, y, z) => {
    selectedWaypoint = { x, y, z };
    waypoints.push(selectedWaypoint);
    ctx.bot.entity.position.x = x;
    ctx.bot.entity.position.z = z;
    ctx.interrupted = true;
    return 'reached';
  };

  await assert.rejects(
    skills.shear_sheep.handler({ count: 3, radius: 48 }, ctx),
    /被新的指令打断/,
  );
  assert.deepEqual(selectedWaypoint, { x: 13, y: 0, z: 0 });
  assert.ok(waypoints.every(({ x, z }) => Math.hypot(x, z) <= 48));
});

test('shear_sheep allows pathfinding to choose an exit when exploration starts in water', async () => {
  const ctx = makeContext([]);
  ctx.bot.blockAt = (position) => position.y === 0
    ? { name: 'water', boundingBox: 'empty' }
    : { name: 'air', boundingBox: 'empty' };
  let liquidCostDuringSearch;
  let avoidedBlocksDuringSearch;
  ctx.walkOnce = async () => {
    liquidCostDuringSearch = ctx.bot.pathfinder.movements.liquidCost;
    avoidedBlocksDuringSearch = [...ctx.bot.pathfinder.movements.blocksToAvoid];
    ctx.interrupted = true;
    return 'reached';
  };

  await assert.rejects(
    skills.shear_sheep.handler({ count: 3, radius: 48 }, ctx),
    /被新的指令打断/,
  );
  assert.equal(liquidCostDuringSearch, 32);
  assert.deepEqual(avoidedBlocksDuringSearch, []);
  assert.equal(ctx.bot.pathfinder.movements.liquidCost, 12);
});

test('shear_sheep continues safe search when discovered sheep may not yield enough wool', async () => {
  const first = makeSheep(1);
  first.position.x = 24;
  const ctx = makeContext([first], { woolPerSheep: 1 });
  const second = makeSheep(2);
  const visited = [];
  ctx.walkOnce = async (x, y, z) => {
    visited.push([x, z]);
    ctx.bot.entity.position.x = x;
    ctx.bot.entity.position.z = z;
    if (visited.length === 1) {
      second.position.x = x;
      second.position.z = z;
      ctx.bot.entities[second.id] = second;
    }
    if (visited.length === 3) {
      first.position.x = x;
      first.position.z = z;
      second.position.x = x;
      second.position.z = z;
    }
    ctx.approach = async (target) => {
      ctx.bot.entity.position.x = target.position.x;
      ctx.bot.entity.position.z = target.position.z;
    };
    return 'reached';
  };

  const result = await skills.shear_sheep.handler({ count: 2, color: 'auto' }, ctx);

  assert.equal(visited.length, 1);
  assert.equal(result.status, 'succeeded');
  assert.equal(ctx.countItem('white_wool'), 2);
});

test('shear_sheep stops searching when the guaranteed wool amount is sufficient', async () => {
  const ctx = makeContext([]);
  let searches = 0;
  ctx.walkOnce = async (x, y, z) => {
    searches += 1;
    ctx.bot.entity.position.x = x;
    ctx.bot.entity.position.z = z;
    for (const id of [1, 2, 3]) {
      const sheep = makeSheep(id);
      sheep.position.x = x;
      sheep.position.z = z;
      ctx.bot.entities[id] = sheep;
    }
    ctx.approach = async (target) => {
      ctx.bot.entity.position.x = target.position.x;
      ctx.bot.entity.position.z = target.position.z;
    };
    return 'reached';
  };

  const result = await skills.shear_sheep.handler({ count: 3, color: 'auto' }, ctx);

  assert.equal(searches, 1);
  assert.equal(result.status, 'succeeded');
  assert.equal(ctx.countItem('white_wool'), 3);
});

test('shear_sheep skips blocked waypoints and stops after the finite search', async () => {
  const ctx = makeContext([]);
  let attempts = 0;
  ctx.walkOnce = async () => {
    attempts += 1;
    return attempts < 8 ? 'stopped' : 'reached';
  };

  await assert.rejects(
    skills.shear_sheep.handler({ count: 3, color: 'auto' }, ctx),
    /已尝试有限白天搜索/,
  );
  assert.equal(attempts, 48);
});

test('shear_sheep stops random exploration when a hostile appears', async () => {
  const ctx = makeContext([]);
  let searches = 0;
  ctx.walkOnce = async () => {
    searches += 1;
    ctx.nearbyHostiles = () => [{ name: 'zombie' }];
    return 'reached';
  };

  await assert.rejects(
    skills.shear_sheep.handler({ count: 3, color: 'auto' }, ctx),
    /附近有敌对生物.*停止外出寻找羊/,
  );
  assert.equal(searches, 1);
});

test('shear_sheep retreats from a hostile and resumes only after safety is confirmed', async () => {
  const ctx = makeContext([]);
  const hostile = { name: 'zombie', position: { x: 4, y: 0, z: 0 } };
  let hostileNearby = false;
  let searches = 0;
  let retreats = 0;
  ctx.nearbyHostiles = () => hostileNearby ? [hostile] : [];
  ctx.findHostile = () => hostileNearby ? hostile : null;
  ctx.retreatFrom = async () => {
    retreats += 1;
    hostileNearby = false;
  };
  ctx.walkOnce = async () => {
    searches += 1;
    if (searches === 1) hostileNearby = true;
    if (searches === 2) {
      for (const id of [3, 4, 5]) {
        const sheep = makeSheep(id);
        sheep.position.x = id - 2;
        ctx.bot.entities[sheep.id] = sheep;
      }
    }
    return 'reached';
  };

  const result = await skills.shear_sheep.handler({ count: 3, color: 'auto' }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(ctx.countItem('white_wool'), 3);
  assert.equal(retreats, 1);
  assert.equal(searches, 2);
});

test('shear_sheep stops after bounded retreats when the hostile remains nearby', async () => {
  const ctx = makeContext([]);
  const hostile = { name: 'creeper', position: { x: 4, y: 0, z: 0 } };
  let hostileNearby = false;
  let searches = 0;
  let retreats = 0;
  ctx.nearbyHostiles = () => hostileNearby ? [hostile] : [];
  ctx.findHostile = () => hostileNearby ? hostile : null;
  ctx.retreatFrom = async () => { retreats += 1; };
  ctx.walkOnce = async () => {
    searches += 1;
    hostileNearby = true;
    return 'reached';
  };

  await assert.rejects(
    skills.shear_sheep.handler({ count: 3, color: 'auto' }, ctx),
    /撤离后附近仍有敌对生物/,
  );
  assert.equal(retreats, 2);
  assert.equal(searches, 1);
});

test('shear_sheep does not search outside at night or near hostiles', async () => {
  const night = makeContext([]);
  night.bot.time.timeOfDay = 14000;
  night.isSleepTime = () => true;
  await assert.rejects(
    skills.shear_sheep.handler({ count: 3, color: 'auto' }, night),
    /夜晚.*停止外出寻找羊/,
  );

  const danger = makeContext([]);
  danger.nearbyHostiles = () => [{ name: 'zombie' }];
  await assert.rejects(
    skills.shear_sheep.handler({ count: 3, color: 'auto' }, danger),
    /附近有敌对生物.*停止外出寻找羊/,
  );

  const unknown = makeContext([]);
  unknown.bot.health = undefined;
  await assert.rejects(
    skills.shear_sheep.handler({ count: 3, color: 'auto' }, unknown),
    /血量未知或不足.*停止寻找羊/,
  );
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

test('fight_blaze collects and verifies a rod drop after killing a blaze', async () => {
  const inventory = { blaze_rod: 0 };
  const position = {
    x: 0,
    y: 64,
    z: 0,
    distanceTo(other) {
      return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
    },
  };
  const blaze = {
    id: 9,
    name: 'blaze',
    isValid: true,
    position: {
      x: 1,
      y: 64,
      z: 0,
      distanceTo(other) {
        return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
      },
      offset(dx, dy, dz) {
        return { x: this.x + dx, y: this.y + dy, z: this.z + dz };
      },
    },
  };
  const bot = {
    entity: { position, metadata: {} },
    entities: { [blaze.id]: blaze },
    health: 20,
    blockAt: () => null,
    async lookAt() {},
    attack(target) { target.isValid = false; },
  };
  let collected = 0;
  const ctx = {
    bot,
    countItem: (name) => inventory[name] || 0,
    findRangedWeapon: () => null,
    async collectDrops(range, name) {
      assert.equal(range, 6);
      assert.equal(name, 'blaze_rod');
      collected += 1;
      inventory.blaze_rod += 1;
      return { picked: { blaze_rod: 1 }, missed: [] };
    },
    async syncInventory() {},
    async sleep() {},
    async approach() {},
    log() {},
  };

  const result = await skills.fight_blaze.handler({ count: 1 }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.equal(inventory.blaze_rod, 1);
  assert.equal(collected, 1);
});

test('fight_blaze stops before collecting drops after cancellation', async () => {
  const position = {
    x: 0,
    y: 64,
    z: 0,
    distanceTo(other) {
      return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
    },
  };
  const blaze = {
    id: 10,
    name: 'blaze',
    isValid: true,
    position: {
      x: 1,
      y: 64,
      z: 0,
      distanceTo(other) {
        return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
      },
      offset(dx, dy, dz) {
        return { x: this.x + dx, y: this.y + dy, z: this.z + dz };
      },
    },
  };
  const bot = {
    entity: { position, metadata: {} },
    entities: { [blaze.id]: blaze },
    health: 20,
    blockAt: () => null,
    async lookAt() {},
    attack(target) {
      target.isValid = false;
      ctx.interrupted = true;
    },
  };
  let collected = 0;
  const ctx = {
    bot,
    interrupted: false,
    countItem: () => 0,
    findRangedWeapon: () => null,
    async collectDrops() {
      collected += 1;
      return { picked: {}, missed: [] };
    },
    async sleep() {},
    async approach() {},
    log() {},
  };

  await assert.rejects(
    skills.fight_blaze.handler({ count: 1 }, ctx),
    /被新的指令打断/,
  );
  assert.equal(collected, 0);
});

test('break_crystal releases the bow and cancels while charging', async () => {
  const position = {
    x: 0,
    y: 64,
    z: 0,
    distanceTo(other) {
      return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
    },
  };
  const crystal = {
    id: 11,
    name: 'end_crystal',
    position: {
      x: 20,
      y: 64,
      z: 0,
      distanceTo(other) {
        return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
      },
      offset(dx, dy, dz) {
        return { x: this.x + dx, y: this.y + dy, z: this.z + dz };
      },
    },
  };
  let deactivated = 0;
  const ctx = {
    bot: {
      entity: { position },
      entities: { [crystal.id]: crystal },
      health: 20,
      async equip() {},
      async lookAt() {},
      activateItem() {},
      deactivateItem() { deactivated += 1; },
    },
    interrupted: false,
    findRangedWeapon: () => ({ bow: { name: 'bow' }, arrows: { name: 'arrow' } }),
    async sleep() { this.interrupted = true; },
    log() {},
  };

  await assert.rejects(
    skills.break_crystal.handler({ count: 1 }, ctx),
    /射击末地水晶被新的指令打断/,
  );
  assert.equal(deactivated, 1);
});

test('break_crystal stops waiting for an explosion after cancellation', async () => {
  const position = {
    x: 0,
    y: 64,
    z: 0,
    distanceTo(other) {
      return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
    },
  };
  const crystal = {
    id: 12,
    name: 'end_crystal',
    position: {
      x: 20,
      y: 64,
      z: 0,
      distanceTo(other) {
        return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
      },
      offset(dx, dy, dz) {
        return { x: this.x + dx, y: this.y + dy, z: this.z + dz };
      },
    },
  };
  let sleeps = 0;
  const ctx = {
    bot: {
      entity: { position },
      entities: { [crystal.id]: crystal },
      health: 20,
      async equip() {},
      async lookAt() {},
      activateItem() {},
      deactivateItem() {},
    },
    interrupted: false,
    findRangedWeapon: () => ({ bow: { name: 'bow' }, arrows: { name: 'arrow' } }),
    async sleep() {
      sleeps += 1;
      if (sleeps === 2) this.interrupted = true;
    },
    log() {},
  };

  await assert.rejects(
    skills.break_crystal.handler({ count: 1 }, ctx),
    /等待水晶爆炸被新的指令打断/,
  );
  assert.equal(sleeps, 2);
});

test('break_crystal cancels while waiting for low health recovery', async () => {
  const position = {
    x: 0,
    y: 64,
    z: 0,
    distanceTo(other) {
      return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
    },
  };
  const crystal = {
    id: 13,
    name: 'end_crystal',
    position: {
      x: 20,
      y: 64,
      z: 0,
      distanceTo(other) {
        return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
      },
      offset(dx, dy, dz) {
        return { x: this.x + dx, y: this.y + dy, z: this.z + dz };
      },
    },
    isValid: true,
  };
  let sleeps = 0;
  const ctx = {
    bot: {
      entity: { position },
      entities: { [crystal.id]: crystal },
      health: 5,
      food: 20,
      async equip() {},
      async lookAt() {},
      activateItem() {},
      deactivateItem() {},
    },
    interrupted: false,
    findRangedWeapon: () => ({ bow: { name: 'bow' }, arrows: { name: 'arrow' } }),
    async sleep() {
      sleeps += 1;
      if (sleeps === 2) crystal.isValid = false;
      if (sleeps === 3) this.interrupted = true;
    },
    async retreatFrom() {},
    log() {},
  };

  await assert.rejects(
    skills.break_crystal.handler({ count: 1 }, ctx),
    /等待回血被新的指令打断/,
  );
  assert.equal(sleeps, 3);
});
