import { setImmediate as yieldToGame } from 'node:timers/promises';
import { scanLoadedBlockStates } from './loaded_block_scan.js';

export async function scanSurfaceLogs(bot, entries, radius, count, startY, accept, check) {
  const search = scanLoadedBlockStates(bot, entries, radius, count, startY - 16, Math.ceil(startY + 32), accept);
  let result = search.next();
  while (!result.done) {
    await yieldToGame();
    check();
    result = search.next();
  }
  return result.value;
}
