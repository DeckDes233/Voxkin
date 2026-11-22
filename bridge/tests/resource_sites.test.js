import assert from 'node:assert/strict';
import test from 'node:test';
import { Vec3 } from 'vec3';
import { inspectResourceSites } from '../resource_sites.js';

test('burst observations reuse only positions and refresh on movement, new sessions and direct skill reads', () => {
  const position = new Vec3(1, 64, 0);
  const block = { name: 'hay_block', position };
  let scans = 0;
  const bot = { game: { dimension: 'overworld' }, entity: { position: new Vec3(0, 64, 0) }, entities: {},
    registry: { blocksByName: { hay_block: { name: 'hay_block', id: 1 } } },
    findBlocks: () => { scans++; return [position]; }, blockAt: () => block };
  assert.equal(inspectResourceSites(bot, null, 'a').hay.length, 1);
  block.name = 'air';
  bot.entities = { 1: { name: 'iron_golem', position } };
  for (let i = 0; i < 100; i++) {
    const observed = inspectResourceSites(bot, null, 'a');
    assert.equal(observed.hay.length, 0);
    assert.equal(observed.golems.length, 1);
  }
  assert.equal(scans, 1);
  bot.entity.position.x += 4;
  inspectResourceSites(bot, null, 'a');
  inspectResourceSites(bot, null, 'b');
  inspectResourceSites(bot);
  assert.equal(scans, 4);
});

test('resource sites require village evidence for chests and beds, protect shelter, and accept hay elsewhere', () => {
  const blocks = [
    { name: 'chest', id: 1, position: new Vec3(20, 64, 0) },
    { name: 'chest', id: 1, position: new Vec3(0, 64, 0) },
    { name: 'hay_block', id: 2, position: new Vec3(5, 64, 0) },
    { name: 'red_bed', id: 3, position: new Vec3(20, 64, 1), getProperties: () => ({ part: 'foot', occupied: false }) },
    { name: 'red_bed', id: 3, position: new Vec3(20, 64, 2), getProperties: () => ({ part: 'head', occupied: false }) },
    { name: 'red_bed', id: 3, position: new Vec3(20, 64, 3), getProperties: () => ({ part: 'foot', occupied: true }) },
  ];
  const bot = { game: { dimension: 'overworld' }, entity: { position: new Vec3(0, 64, 0) }, entities: {},
    registry: { blocksByName: Object.fromEntries(blocks.map(b => [b.name, b])) },
    findBlocks: () => blocks.map(b => b.position), blockAt: p => blocks.find(b => b.position.equals(p)) };
  let result = inspectResourceSites(bot);
  assert.equal(result.chests.length, 0);
  assert.equal(result.beds.length, 0);
  assert.equal(result.hay.length, 1);
  bot.entities = { 4: { name: 'villager', position: new Vec3(20, 64, 0) } };
  result = inspectResourceSites(bot, { position: new Vec3(0, 63, 0) });
  assert.deepEqual(result.chests.map(p => p.x), [20]);
  assert.equal(result.beds.length, 1);
  assert.equal(result.hay.length, 1);
  assert.equal(result.village_evidence, true);
  bot.game.dimension = 'the_nether';
  assert.equal(inspectResourceSites(bot).hay.length, 0);
});
