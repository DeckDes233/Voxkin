import assert from 'node:assert/strict';
import test from 'node:test';

import { skills } from '../skills/nether.js';

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
