function transitionIdentity(identity, event, nextSessionId) {
  if (event === 'respawn_packet') {
    return { sessionId: identity.sessionId, revision: identity.revision };
  }
  if (!['initial_spawn', 'death', 'disconnect'].includes(event)) {
    throw new Error(`未知 Bridge lifecycle event: ${event}`);
  }
  if (!nextSessionId) throw new Error(`Bridge lifecycle event ${event} 缺少新 session_id`);
  return { sessionId: String(nextSessionId), revision: 0 };
}

export function installBridgeSessionLifecycle({
  bot,
  client,
  getIdentity,
  setIdentity,
  createSessionId,
  isDeathPending,
  onRespawn,
}) {
  const advance = (event) => {
    const identity = transitionIdentity(getIdentity(), event, createSessionId());
    setIdentity(identity);
    return identity;
  };

  bot.once('spawn', () => advance('initial_spawn'));
  bot.on('death', () => advance('death'));
  bot.on('end', () => advance('disconnect'));

  const handleRespawnPacket = (packet) => {
    const deathRespawn = Boolean(isDeathPending());
    const identity = transitionIdentity(getIdentity(), 'respawn_packet');
    setIdentity(identity);
    onRespawn({ packet, deathRespawn, identity });
  };
  client.on('respawn', handleRespawnPacket);

  return { handleRespawnPacket, advance };
}
