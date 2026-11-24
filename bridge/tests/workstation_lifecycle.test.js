import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { retainTemporaryTable, shouldRecoverTemporaryTable, ownedTableNearby } from '../workstation_lifecycle.js';

test('连续合成保留临时工作台，离开前回收，S0 保留库存验收', () => {
  assert.equal(retainTemporaryTable('stage:s0'), false);
  assert.equal(retainTemporaryTable('stage:s1'), true);
  assert.equal(retainTemporaryTable(''), true);
  assert.equal(shouldRecoverTemporaryTable('craft'), false);
  assert.equal(shouldRecoverTemporaryTable('craft_bed'), false);
  assert.equal(shouldRecoverTemporaryTable('swim_out'), false);
  assert.equal(shouldRecoverTemporaryTable('mine_collect'), true);
});

test('只识别同维度、附近且仍实际存在的自放工作台', () => {
  const position = new Vec3(1, 64, 0);
  const record = { position, dimension: 'overworld' };
  const table = { name: 'crafting_table', position };
  const bot = { game: { dimension: 'overworld' }, entity: { position: new Vec3(0, 64, 0) }, blockAt: () => table };
  assert.equal(ownedTableNearby(bot, record), table);
  assert.equal(ownedTableNearby(bot, null), null);
  assert.equal(ownedTableNearby(bot, { ...record, dimension: 'the_nether' }), null);
  bot.blockAt = () => ({ ...table, name: 'stone' });
  assert.equal(ownedTableNearby(bot, record), null);
  bot.blockAt = () => table;
  bot.entity.position = new Vec3(10, 64, 0);
  assert.equal(ownedTableNearby(bot, record), null);
});
