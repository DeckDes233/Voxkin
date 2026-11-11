const DEFAULT_MAX_POINTS = 64;
const DEFAULT_MIN_DISTANCE = 1.5;

function pointOf(position) {
  if (!position) return null;
  const point = { x: Number(position.x), y: Number(position.y), z: Number(position.z) };
  return Object.values(point).every(Number.isFinite) ? point : null;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// 记录已走过的落脚位置，切换维度时清空，避免沿旧世界坐标盲走。
export function createRetreatTrail({ maxPoints = DEFAULT_MAX_POINTS, minDistance = DEFAULT_MIN_DISTANCE } = {}) {
  const limit = Math.max(2, Math.floor(Number(maxPoints) || DEFAULT_MAX_POINTS));
  const spacing = Math.max(0, Number(minDistance) || 0);
  let dimension = null;
  const points = [];

  return {
    record(position, currentDimension = '') {
      const point = pointOf(position);
      if (!point) return false;
      const nextDimension = String(currentDimension || '');
      if (dimension !== nextDimension) {
        points.length = 0;
        dimension = nextDimension;
      }
      if (points.length && distance(points[points.length - 1], point) < spacing) return false;
      points.push(point);
      if (points.length > limit) points.splice(0, points.length - limit);
      return true;
    },
    snapshot(currentDimension = '') {
      if (dimension !== String(currentDimension || '')) return [];
      return points.map((point) => ({ ...point }));
    },
    clear() {
      points.length = 0;
      dimension = null;
    },
  };
}

// 仅返回当前点之后的历史路点，最新到最旧；调用者可逐点做地形与威胁检查。
export function retreatWaypoints(trail, currentPosition, { minDistance = 1.5, maxWaypoints = 12 } = {}) {
  const current = pointOf(currentPosition);
  if (!current || !Array.isArray(trail) || trail.length < 2) return [];
  const threshold = Math.max(0, Number(minDistance) || 0);
  const maximum = Math.max(1, Math.floor(Number(maxWaypoints) || 12));
  const candidates = [];
  for (let index = trail.length - 2; index >= 0 && candidates.length < maximum; index -= 1) {
    const point = pointOf(trail[index]);
    if (!point || distance(current, point) < threshold) continue;
    if (candidates.length && distance(candidates[candidates.length - 1], point) < threshold) continue;
    candidates.push(point);
  }
  return candidates;
}

// 使用调用方提供的 pathfinder/Goal 构造器执行撤退，避免模块依赖游戏运行时。
// 每次抵达后都重新检查危险度；路点失效时跳过，成功必须有真实位移。
export async function retreatAlongTrail({
  trail,
  currentPosition,
  pathfinder,
  makeGoal,
  gotoWaypoint,
  safetyScore,
  isSafe = () => true,
  minDistance = 1.5,
  maxWaypoints = 12,
  timeoutMs = 5000,
}) {
  if ((!pathfinder || typeof pathfinder.goto !== 'function') && typeof gotoWaypoint !== 'function') return false;
  if (typeof makeGoal !== 'function') return false;
  const origin = pointOf(typeof currentPosition === 'function' ? currentPosition() : currentPosition);
  if (!origin) return false;
  const initialSafety = typeof safetyScore === 'function' ? Number(safetyScore(origin)) : NaN;
  for (const waypoint of retreatWaypoints(trail, origin, { minDistance, maxWaypoints })) {
    if (!isSafe(waypoint)) continue;
    try {
      const goal = makeGoal(waypoint);
      if (typeof gotoWaypoint === 'function') await gotoWaypoint(goal, timeoutMs);
      else await pathfinder.goto(goal);
    } catch {
      continue;
    }
    const current = pointOf(typeof currentPosition === 'function' ? currentPosition() : currentPosition);
    if (!current || distance(origin, current) < minDistance) continue;
    if (typeof safetyScore !== 'function') return true;
    const resultingSafety = Number(safetyScore(current));
    if (Number.isFinite(initialSafety) && Number.isFinite(resultingSafety) && resultingSafety > initialSafety) return true;
  }
  return false;
}
