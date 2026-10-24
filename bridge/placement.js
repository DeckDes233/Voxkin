export function placementOffsets(radius = 4) {
  const limit = Math.max(1, Math.floor(Number(radius) || 1));
  const offsets = [];
  for (let x = -limit; x <= limit; x += 1) {
    for (let z = -limit; z <= limit; z += 1) {
      if (x === 0 && z === 0) continue;
      offsets.push({ x, z, distance: x * x + z * z });
    }
  }
  return offsets
    .sort((left, right) => left.distance - right.distance || left.x - right.x || left.z - right.z)
    .map(({ x, z }) => [x, z]);
}

export function placementHeightOffsets(minimum = -16, maximum = 8) {
  const low = Math.floor(Number(minimum) || 0);
  const high = Math.floor(Number(maximum) || 0);
  const offsets = [];
  for (let offset = low; offset <= high; offset += 1) offsets.push(offset);
  return offsets.sort((left, right) => Math.abs(left + 1) - Math.abs(right + 1) || right - left);
}
