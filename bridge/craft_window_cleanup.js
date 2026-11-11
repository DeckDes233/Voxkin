export function isUrgentSafetyPreemption(token) {
  return Boolean(token?.cancelled && token.cancelStatus === 'preempted' && token.cancelCause === 'safety_priority');
}

export async function cleanupCraftWindowForSafety({
  token,
  window,
  inventoryWindow,
  restoreCursor,
  closeContainer,
  synchronize,
}) {
  if (!isUrgentSafetyPreemption(token)) return { handled: false, unknown: false };
  const isInventory = window === inventoryWindow;
  token.safetyWindowCleanup = true;
  token.cleanupDeadlineAt = Date.now() + 150;
  try {
    if (isInventory) {
      await restoreCursor();
    } else {
      await closeContainer();
      token.craftWindowClosed = true;
    }
  } catch (error) {
    markUnknown(token, `紧急避险时关闭合成窗口失败：${error?.message || error}`);
    return { handled: true, unknown: true, mode: isInventory ? 'cursor_only' : 'close_container' };
  } finally {
    delete token.cleanupDeadlineAt;
  }

  if (isInventory) {
    try {
      const synchronized = await synchronize(inventoryWindow, 300);
      if (!synchronized) {
        markUnknown(token, '紧急避险时合成背包同步超时');
        return { handled: true, unknown: true, mode: 'cursor_only' };
      }
    } catch (error) {
      markUnknown(token, `紧急避险时合成背包状态未知：${error?.message || error}`);
      return { handled: true, unknown: true, mode: 'cursor_only' };
    }
  }
  return { handled: true, unknown: false, mode: isInventory ? 'cursor_only' : 'close_container' };
}

function markUnknown(token, detail) {
  token.cancelStatus = 'unknown';
  token.cancelReason = detail;
  token.progressData = {
    ...(token.progressData || {}),
    phase: 'window_cleanup_unknown',
    window_cleanup: 'unknown',
    window_state_unknown: true,
  };
}
