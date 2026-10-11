const DIRECTIONS = [[2, 0, 1], [4, -1, 0], [6, 1, 0], [8, 0, -1]];
const key = (x, y) => `${x},${y}`;

/** Only active, static player-touch transfers participate in automatic travel. */
export function getPortals(world, entity) {
  const map = world.maps.get(entity.mapId), portals = [];
  for (const event of map?.events.values() || []) {
    if (event.erased || event.dead || event.enemyId) continue;
    const page = world.events.pageFor?.(entity, event, entity.mapId);
    if (!page || page.engineDisabledReason || ![1, 2].includes(page.trigger)) continue;
    // Conditional, scripted and choice-driven destinations are not safe routes.
    const list = page.list || [];
    if (list.some(c => [102, 111, 112, 113, 115, 117, 118, 119, 355, 356, 357, 655].includes(c.code))) continue;
    const command = list.find(c => c.code === 201), p = command?.parameters;
    if (!p || p[0] !== 0 || !Number.isInteger(p[1]) || !world.content.getMap(p[1])) continue;
    portals.push({x: event.x, y: event.y, mapId: p[1], targetX: p[2], targetY: p[3], eventId: event.id});
  }
  return portals;
}

/** Bounded four-direction BFS. It queries the same passability as real movement. */
export function findPath(world, entity, {x, y, range = 0, avoidPortals = true, allowBlockedGoal = false, maxNodes = 2048} = {}) {
  const raw = world.content.getMap(entity.mapId);
  if (!raw || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= raw.width || y >= raw.height) return null;
  range = Number.isFinite(range) ? Math.max(0, Math.min(10, range)) : 0;
  maxNodes = Math.max(1, Math.min(16384, Math.floor(maxNodes) || 2048));
  const reached = p => Math.abs(p.x - x) + Math.abs(p.y - y) <= range;
  if (reached(entity)) return [];
  const portals = new Set();
  if (avoidPortals) for (const event of world.maps.get(entity.mapId)?.events.values() || []) {
    const page = world.events.pageFor?.(entity, event, entity.mapId);
    // Even a transfer whose destination cannot safely be inferred is a route hazard.
    if (!event.erased && !event.enemyId && page && !page.engineDisabledReason && [1, 2].includes(page.trigger) && page.list?.some(c => c.code === 201)) portals.add(key(event.x, event.y));
  }
  const queue = [{x: entity.x, y: entity.y, parent: -1, direction: null}], seen = new Set([key(entity.x, entity.y)]);
  for (let head = 0; head < queue.length && head < maxNodes; head++) {
    const current = queue[head], ghost = {...entity, x: current.x, y: current.y};
    for (const [direction, dx, dy] of DIRECTIONS) {
      const next = world.content.wrapPosition(entity.mapId, current.x + dx, current.y + dy), id = key(next.x, next.y);
      if (seen.has(id) || (portals.has(id) && !(next.x === x && next.y === y))) continue;
      if (!world.canMove(ghost, direction) && !(allowBlockedGoal && range === 0 && next.x === x && next.y === y)) continue;
      const node = {...next, parent: head, direction};
      if (reached(node)) {
        const path = [direction]; let index = head;
        while (queue[index].parent !== -1) { path.push(queue[index].direction); index = queue[index].parent; }
        return path.reverse();
      }
      seen.add(id); queue.push(node);
    }
  }
  return null;
}
