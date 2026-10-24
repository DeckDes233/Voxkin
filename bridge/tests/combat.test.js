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
    assert.deepEqual([y, radius, timeout, horizontalOnly], [1, 3, 10000, true]);
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

  assert.equal(searches, 6);
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

  assert.equal(searches, 5);
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

test('shear_sheep falls back to a bounded random pathfinding waypoint without safe support data', async () => {
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
  assert.deepEqual(selectedWaypoint, { x: 10, y: 0, z: 0 });
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
  assert.equal(attempts, 12);
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
