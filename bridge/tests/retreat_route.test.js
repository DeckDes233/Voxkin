import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetreatTrail, retreatWaypoints, retreatAlongTrail } from '../retreat_route.js';

test('trail is bounded, samples distinct positions, and resets on dimension change', () => {
  const trail = createRetreatTrail({ maxPoints: 3, minDistance: 1 });
  assert.equal(trail.record({ x: 0, y: 64, z: 0 }, 'overworld'), true);
  assert.equal(trail.record({ x: 0.5, y: 64, z: 0 }, 'overworld'), false);
  trail.record({ x: 2, y: 64, z: 0 }, 'overworld');
  trail.record({ x: 4, y: 64, z: 0 }, 'overworld');
  trail.record({ x: 6, y: 64, z: 0 }, 'overworld');
  assert.deepEqual(trail.snapshot('overworld'), [
    { x: 2, y: 64, z: 0 }, { x: 4, y: 64, z: 0 }, { x: 6, y: 64, z: 0 },
  ]);
  assert.deepEqual(trail.snapshot('nether'), []);
  trail.record({ x: 1, y: 50, z: 1 }, 'nether');
  assert.deepEqual(trail.snapshot('nether'), [{ x: 1, y: 50, z: 1 }]);
});

test('retreat candidates follow the recorded route in reverse and ignore the current point', () => {
  const history = [
    { x: 0, y: 64, z: 0 }, { x: 3, y: 64, z: 0 },
    { x: 6, y: 64, z: 0 }, { x: 9, y: 64, z: 0 },
  ];
  assert.deepEqual(retreatWaypoints(history, { x: 9, y: 64, z: 0 }), [
    { x: 6, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }, { x: 0, y: 64, z: 0 },
  ]);
  assert.deepEqual(retreatWaypoints(history.slice(0, 1), history[0]), []);
});

test('retreat skips unsafe or failed recent waypoint and succeeds at a safe earlier route point', async () => {
  let position = { x: 9, y: 64, z: 0 };
  const attempted = [];
  const pathfinder = {
    async goto(goal) {
      attempted.push(goal.point.x);
      if (goal.point.x === 6) throw new Error('route blocked');
      position = { ...goal.point };
    },
  };
  const result = await retreatAlongTrail({
    trail: [0, 3, 6, 9].map((x) => ({ x, y: 64, z: 0 })),
    currentPosition: () => position,
    pathfinder,
    makeGoal: (point) => ({ point }),
    isSafe: (point) => point.x !== 3,
    safetyScore: (point) => -point.x,
  });
  assert.equal(result, true);
  assert.deepEqual(attempted, [6, 0]);
  assert.equal(position.x, 0);
});

test('retreat requires real movement and improved safety when a score is supplied', async () => {
  const result = await retreatAlongTrail({
    trail: [{ x: 0, y: 64, z: 0 }, { x: 5, y: 64, z: 0 }],
    currentPosition: { x: 5, y: 64, z: 0 },
    pathfinder: { async goto() {} },
    makeGoal: (point) => point,
    safetyScore: () => 1,
  });
  assert.equal(result, false);
});
