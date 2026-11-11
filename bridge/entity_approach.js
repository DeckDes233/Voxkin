export async function approachEntity(bot, target, GoalFollow, options = {}) {
  if (!target || !target.position || target.isValid === false) return false;
  if (bot.entity.position.distanceTo(target.position) <= 3) return true;

  const goal = new GoalFollow(target, options.followRange ?? 2);
  const timeoutMs = options.timeoutMs ?? 12000;
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let interval;
    const cleanup = () => {
      clearInterval(interval);
      bot.removeListener('goal_updated', onGoalUpdated);
      if (bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null);
    };
    const finish = (error, reached = false) => {
      cleanup();
      if (error) reject(error);
      else resolve(reached);
    };
    const onGoalUpdated = (updatedGoal) => {
      if (updatedGoal !== goal) finish(new Error('Approach interrupted by another action'));
    };

    bot.on('goal_updated', onGoalUpdated);
    bot.pathfinder.setGoal(goal, true);
    interval = setInterval(() => {
      if (!target.position || target.isValid === false) {
        finish(null, false);
        return;
      }
      if (bot.entity.position.distanceTo(target.position) <= 4.5) {
        finish(null, true);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) finish(new Error('Approach timed out'));
    }, 100);
  });
}
