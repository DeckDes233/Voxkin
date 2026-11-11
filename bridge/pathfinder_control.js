export function stopPathfinderAndClearGoal(pathfinder) {
  if (typeof pathfinder?.stop !== 'function' || typeof pathfinder.setGoal !== 'function') return false;
  pathfinder.stop();
  pathfinder.setGoal(null);
  return true;
}

// stop() 是软停止；清空 goal 才会让当前 goto 的 Promise 结束并释放监听器。
export async function gotoWithTimeout(pathfinder, goal, timeoutMs, message = '寻路超时') {
  let timedOut = false;
  const movement = pathfinder.goto(goal);
  const timer = setTimeout(() => {
    timedOut = true;
    stopPathfinderAndClearGoal(pathfinder);
  }, timeoutMs);
  try {
    return await movement;
  } finally {
    clearTimeout(timer);
    if (timedOut) {
      const error = new Error(message);
      error.name = 'CollectTimeout';
      throw error;
    }
  }
}
