import assert from 'node:assert/strict';
import test from 'node:test';
import { Vec3 } from 'vec3';

import { portalFrame, skills } from '../skills/nether.js';

test('the ten-block Nether frame encloses every side of a two-by-three opening on either axis', () => {
  for (const axis of ['x', 'z']) {
    const layout = portalFrame({ x: 0, y: 64, z: 0 }, axis);
    const coords = new Set(layout.frame.map(p => `${p[axis]},${p.y}`));
    assert.equal(coords.size, 10);
    for (const y of [63, 67]) for (const d of [0, 1]) assert.ok(coords.has(`${d},${y}`));
    for (const y of [64, 65, 66]) for (const d of [-1, 2]) assert.ok(coords.has(`${d},${y}`));
    assert.equal(layout.full.length, 14);
  }
});

function makePosition(x = 0, y = 64, z = 0) {
  return {
    x,
    y,
    z,
    distanceTo(other) {
      return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
    },
  };
}

async function withFakeClock(run) {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    await run({
      sleep: async (ms) => {
        now += ms;
      },
    });
  } finally {
    Date.now = originalNow;
  }
}

function makeTravelContext(dimension, { destination, cancel = false } = {}) {
  const bot = {
    game: { dimension },
    entity: { position: makePosition() },
    blockAt(position) {
      return position.x === 1 && position.y === 64 && position.z === 0
        ? { name: 'nether_portal', position: { x: 1, y: 64, z: 0 } }
        : null;
    },
  };
  const ctx = {
    bot,
    interrupted: cancel,
    countItem: () => 0,
    nearbyBlock: () => ({ position: { x: 1, y: 64, z: 0 } }),
    async travelTo() {},
    async walkOnce() {
      if (destination) bot.game.dimension = destination;
    },
    async sleep() {},
  };
  return { ctx };
}

test('nether_travel waits for the requested overworld destination when exiting', async () => {
  const { ctx } = makeTravelContext('minecraft:the_nether', {
    destination: 'minecraft:overworld',
  });

  const result = await skills.nether_travel.handler({ mode: 'exit' }, ctx);

  assert.equal(result.status, 'succeeded');
  assert.match(result.detail, /主世界/);
});

test('nether_travel rejects an unexpected destination dimension', async () => {
  const { ctx } = makeTravelContext('minecraft:the_nether', {
    destination: 'minecraft:the_end',
  });

  await withFakeClock(async ({ sleep }) => {
    ctx.sleep = sleep;
    await assert.rejects(
      skills.nether_travel.handler({ mode: 'exit', timeout_s: 5 }, ctx),
      /没有走进下界门/,
    );
  });
});

test('make_nether_portal honors cancellation before changing the world', async () => {
  const { ctx } = makeTravelContext('minecraft:overworld', { cancel: true });
  let itemReads = 0;
  ctx.countItem = () => {
    itemReads += 1;
    return 64;
  };

  await assert.rejects(skills.make_nether_portal.handler({}, ctx), /被新的指令打断/);
  assert.equal(itemReads, 0);
});

test('续建只在原门址补缺块，点燃后重查时不再消耗黑曜石', async () => {
  const origin = {x: 2, y: 64, z: 2};
  const site = {dimension: 'minecraft:overworld', origin, axis: 'x'};
  const frame = portalFrame(origin, site.axis);
  const key = p => [p.x, p.y, p.z].join(',');
  const blocks = new Map(frame.bottom.slice(1, -1).map(p => [key(p), 'obsidian']));
  for (const p of frame.full) blocks.set(key({...p, y: 62}), 'stone');
  const portal = frame.interior[0];
  const {ctx} = makeTravelContext('minecraft:overworld');
  ctx.bot.entity.position = new Vec3(0, 64, 0);
  ctx.bot.blockAt = p => {
    const name = blocks.get(key(p)) || 'air';
    return {name, position: p, boundingBox: ['air', 'nether_portal'].includes(name) ? 'empty' : 'block'};
  };
  ctx.nearbyBlock = () => blocks.get(key(portal)) === 'nether_portal' ? {position: portal} : null;
  let stock = 8;
  ctx.countItem = item => item === 'obsidian' ? stock : 1;
  ctx.bot.inventory = {items: () => [{name: 'flint_and_steel'}]};
  ctx.bot.equip = async () => {};
  ctx.bot.activateBlock = async () => { blocks.set(key(portal), 'nether_portal'); };
  ctx.placeBlock = async p => {
    const neighbors = [[0,-1,0], [0,1,0], [-1,0,0], [1,0,0], [0,0,-1], [0,0,1]];
    assert.ok(neighbors.some(([dx,dy,dz]) => blocks.has(key({x: p.x+dx, y: p.y+dy, z: p.z+dz}))));
    blocks.set(key(p), p.block);
    if (p.block === 'obsidian') stock--;
  };
  const reported = [];
  ctx.reportProgress = (_phase, _detail, _progress, data) => reported.push(data.portal_site);
  for (let i = 0; i < 2; i++) {
    const result = await skills.make_nether_portal.handler({resume_site: site}, ctx);
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(result.data.portal_transition.source.position, portal);
    assert.equal(stock, 0);
  }
  assert.deepEqual(reported, [site, site]);
});
