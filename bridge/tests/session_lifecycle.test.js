import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { installBridgeSessionLifecycle } from '../session_lifecycle.js';

test('dimension respawn packets preserve the active action receipt identity; death and disconnect rotate it', () => {
  const bot = new EventEmitter();
  const client = new EventEmitter();
  const nextIds = ['initial-session', 'death-session', 'disconnect-session'];
  const observations = [];
  let identity = { sessionId: 'before-spawn', revision: 19 };
  let deathPending = false;

  installBridgeSessionLifecycle({
    bot,
    client,
    getIdentity: () => identity,
    setIdentity: (next) => { identity = next; },
    createSessionId: () => nextIds.shift(),
    isDeathPending: () => deathPending,
    onRespawn: ({ packet, deathRespawn, identity: observed }) => {
      observations.push({ packet, deathRespawn, identity: observed });
    },
  });

  bot.emit('spawn');
  assert.deepEqual(identity, { sessionId: 'initial-session', revision: 0 });
  identity.revision = 7;
  const actionReceipt = { actionId: 'portal-action', ...identity };

  // Mineflayer 在过门换维度和死亡重生时都会发出这个事件。
  client.emit('respawn', { worldState: { dimension: 'minecraft:the_nether' } });
  client.emit('respawn', { worldState: { dimension: 'minecraft:overworld' } });
  identity.revision += 1; // Bridge 发布维度切换后的新观察。
  assert.equal(identity.sessionId, actionReceipt.sessionId);
  assert.ok(identity.revision > actionReceipt.revision);
  assert.deepEqual(observations.slice(0, 2).map((item) => item.deathRespawn), [false, false]);

  bot.on('death', () => { deathPending = true; });
  bot.emit('death');
  assert.deepEqual(identity, { sessionId: 'death-session', revision: 0 });
  client.emit('respawn', { worldState: { dimension: 'minecraft:overworld' } });
  client.emit('respawn', { worldState: { dimension: 'minecraft:overworld' } });
  assert.deepEqual(identity, { sessionId: 'death-session', revision: 0 });
  assert.deepEqual(observations.slice(2).map((item) => item.deathRespawn), [true, true]);

  deathPending = false;
  identity.revision = 3;
  bot.emit('end');
  assert.deepEqual(identity, { sessionId: 'disconnect-session', revision: 0 });
  client.emit('respawn', { worldState: { dimension: 'minecraft:the_nether' } });
  assert.deepEqual(identity, { sessionId: 'disconnect-session', revision: 0 });
});
