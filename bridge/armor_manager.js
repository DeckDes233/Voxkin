export function installArmorManagerApi(bot, plugin) {
  if (!bot || typeof plugin !== 'function') throw new TypeError('需要 bot 与 armor-manager 插件');
  const previous = new Set(bot.listeners('playerCollect'));
  plugin(bot);
  for (const listener of bot.listeners('playerCollect')) {
    if (!previous.has(listener)) bot.removeListener('playerCollect', listener);
  }
  return bot.armorManager;
}
