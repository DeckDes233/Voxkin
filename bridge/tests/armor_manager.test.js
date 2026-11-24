import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import armorManager from 'mineflayer-armor-manager';

import { installArmorManagerApi } from '../armor_manager.js';

test('armor manager exposes leased API without keeping its direct playerCollect writer', async () => {
  const bot = new EventEmitter();
  bot.username = 'Voxkin';
  bot.inventory = { items: () => [] };
  const existingListener = () => {};
  bot.on('playerCollect', existingListener);
  const api = installArmorManagerApi(bot, armorManager);

  assert.equal(api, bot.armorManager);
  assert.deepEqual(bot.listeners('playerCollect'), [existingListener]);
  await bot.armorManager.equipAll();
  bot.emit('playerCollect', bot, { getDroppedItem: () => ({ name: 'iron_helmet' }) });
  assert.deepEqual(bot.listeners('playerCollect'), [existingListener]);
});
