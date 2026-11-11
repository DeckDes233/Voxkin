export function inspectPositionTerrain(position, getBlock) {
  const floor = {
    x: Math.floor(Number(position?.x)),
    y: Math.floor(Number(position?.y)),
    z: Math.floor(Number(position?.z)),
  };
  if (!Object.values(floor).every(Number.isFinite) || typeof getBlock !== 'function') {
    return { floor, readable: false, blocks: {} };
  }

  const inspect = (role, y) => {
    const query = { x: floor.x, y, z: floor.z };
    let block = null;
    try {
      block = getBlock(query) || null;
    } catch {
      block = null;
    }
    return {
      query,
      loaded: Boolean(block),
      name: block?.name || null,
      bounding_box: block?.boundingBox || null,
      role,
    };
  };

  const blocks = {
    ground: inspect('ground', floor.y - 1),
    feet: inspect('feet', floor.y),
    head: inspect('head', floor.y + 1),
  };
  return {
    floor,
    readable: Object.values(blocks).every((block) => block.loaded),
    blocks,
  };
}
