const KEEP_FOR_ACTIONS = new Set([
  'craft', 'craft_bed', 'craft_torch', 'craft_tool_set', 'prepare_bow_arrows',
  'inventory', 'observe', 'locate_block', 'locate_entity', 'chat', 'stop', 'eat', 'eat_if_hungry',
  'swim_out', 'swim_escape', 'flee_low_health',
]);

export function retainTemporaryTable(goalId) {
  return String(goalId || '').toLowerCase() !== 'stage:s0';
}

export function shouldRecoverTemporaryTable(tool) {
  return !KEEP_FOR_ACTIONS.has(tool);
}

export function ownedTableNearby(bot, record, maxDistance = 4) {
  if (!record || !bot?.entity || record.dimension !== String(bot.game?.dimension || '')) return null;
  const block = bot.blockAt(record.position);
  if (!block || block.name !== 'crafting_table') return null;
  if (bot.entity.position.distanceTo(block.position) > maxDistance) return null;
  return block;
}
