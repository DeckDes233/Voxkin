export function syncWindowWithLease(bot, window, token, toNotchSlot, timeoutMs = 2000) {
  if (token?.cancelled) return Promise.resolve(false);
  if (!bot || !window || typeof bot._client?.write !== 'function') return Promise.resolve(false);
  if (typeof bot.supportFeature === 'function' && !bot.supportFeature('stateIdUsed')) return Promise.resolve(true);
  const eventName = `setWindowItems:${window.id}`;
  const hooks = token?.cancelHooks || (token ? (token.cancelHooks = new Set()) : null);
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      bot.removeListener(eventName, onSynchronized);
      hooks?.delete(cancel);
    };
    const finish = (synchronized) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(synchronized);
    };
    const onSynchronized = () => finish(true);
    const cancel = () => finish(false);
    bot.on(eventName, onSynchronized);
    hooks?.add(cancel);
    timer = setTimeout(cancel, Math.max(1, Number(timeoutMs) || 2000));
    try {
      bot._client.write('window_click', {
        windowId: window.id,
        stateId: -1,
        slot: -999,
        mouseButton: 2,
        mode: 5,
        changedSlots: [],
        cursorItem: toNotchSlot(window.selectedItem),
      });
    } catch {
      finish(false);
    }
  });
}

export async function writeWindowClickWithLease(bot, window, {
  slot,
  mouseButton,
  mode,
  stateId,
  toNotchSlot,
  token,
  wait,
  cleanup = false,
}) {
  assertWindowLease(token, cleanup);
  const click = {
    slot,
    mouseButton,
    mode,
    item: slot === -999 ? null : window.slots[slot] ?? null,
  };
  const changed = window.acceptClick(click) || [];
  const changedSlots = changed.map((location) => ({
    location,
    item: toNotchSlot(window.slots[location]),
  }));
  bot._client.write('window_click', {
    windowId: window.id,
    stateId,
    slot,
    mouseButton,
    mode,
    changedSlots,
    cursorItem: toNotchSlot(window.selectedItem),
  });
  await wait();
  assertWindowLease(token, cleanup);
  return true;
}

function assertWindowLease(token, cleanup) {
  if (cleanup) {
    if (token?.cleanupDeadlineAt && Date.now() >= token.cleanupDeadlineAt) {
      throw new Error('合成窗口清理超过时间上限');
    }
    return;
  }
  if (token?.cancelled) throw new Error(token.cancelReason || '窗口操作被取消');
}
