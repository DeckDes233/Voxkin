// 采集目标未出现在已加载区块时，分段移动并重新搜索。
// 探索仍属于当前动作，因此取消、危险检查和总时限由调用方控制。
function searchState() {
  return { steps: 0, heading: Math.random() * Math.PI * 2, scanned: false, excluded: new Set(), visited: new Set() };
}

export async function findBlocksWithExploration(ctx, ids, range, count, scanOverride = null, state = searchState(), localOnly = null) {
  const bot = ctx.bot;
  const wait = ctx.actionToken?.wait ?? (ms => ctx.sleep(ms));
  const scan = async () => {
    const positions = scanOverride
      ? await scanOverride(state.excluded.size, state.excluded)
      : bot.findBlocks({ matching: ids, maxDistance: range, count: count + state.excluded.size });
    return positions.filter((p) => !state.excluded.has(`${p.x},${p.y},${p.z}`));
  };
  const check = () => {
    if (ctx.interrupted) throw new Error('资源搜索被取消：收到新的指令或动作超时');
    if (!bot.entity) throw new Error('与 Minecraft 的连接已断开，资源搜索中止');
  };
  const attempts = state.scanned ? 1 : 4;
  state.scanned = true;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    check();
    const positions = await scan();
    check();
    if (positions.length || localOnly?.()) return positions;
    if (attempts === 1) break;
    if (typeof bot.waitForChunksToLoad === 'function') {
      await Promise.race([bot.waitForChunksToLoad().catch(() => {}), wait(3000)]);
    }
    check();
    await wait(1200);
  }
  if (typeof ctx.exploreResource !== 'function') return [];
  while (state.steps < 5) {
    check();
    if (localOnly?.()) return [];
    const outcome = await ctx.exploreResource(state.steps++, state.heading, state);
    check();
    if (outcome === 'cancelled' || outcome === 'stopped') {
      throw new Error('资源探索已停止');
    }
    if (!['reached', 'unreachable', 'no_target'].includes(outcome)) {
      throw new Error(`资源探索未完成（${outcome || '未知状态'}）`);
    }
    if (outcome !== 'reached') state.heading += Math.PI / 2;
    ctx.reportProgress?.('searching', `资源探索 ${state.steps}/5，${outcome}`, 0, {
      resource_search: { steps: state.steps, outcome, position: { ...bot.entity.position } },
    });
    if (outcome === 'no_target') continue;
    if (typeof bot.waitForChunksToLoad === 'function') {
      await Promise.race([bot.waitForChunksToLoad().catch(() => {}), wait(3000)]);
      check();
    }
    const positions = await scan();
    check();
    if (positions.length) return positions;
  }
  return [];
}

// 一次动作共用探索预算；目标消失、走不到或采完后继续搜，不重试同一坐标。
export async function* resourceCandidates(ctx, ids, range, count, scanOverride = null, selectPosition = null, localOnly = null) {
  const state = searchState();
  while (state.excluded.size < 512) {
    const positions = await findBlocksWithExploration(ctx, ids, range, count, scanOverride, state, localOnly);
    if (!positions.length) return;
    if (selectPosition) {
      const position = await selectPosition(positions);
      const key = `${position.x},${position.y},${position.z}`;
      if (state.excluded.size >= 512) return;
      state.excluded.add(key);
      yield position;
      continue;
    }
    for (const position of positions) {
      const key = `${position.x},${position.y},${position.z}`;
      if (state.excluded.has(key)) continue;
      if (state.excluded.size >= 512) return;
      state.excluded.add(key);
      yield position;
    }
  }
}
