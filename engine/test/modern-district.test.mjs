import test from 'node:test';
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadContent} from '../server/content.mjs';
import {Round, ROUND_MAPS} from '../server/rounds.mjs';
import {DIRECTIONS} from '../server/world.mjs';
import {getPortals} from '../server/navigation.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const content = await loadContent(projectRoot);
const modernIds = Array.from({length: 9}, (_, i) => 31 + i);
const clone = value => structuredClone(value);
const key = p => `${p.x},${p.y}`;
const near = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
const commentText = event => event.pages.flatMap(page => page.list).filter(c => [108, 408].includes(c.code)).map(c => c.parameters[0]).join('\n');
const authoredBoxes = map => map.events.filter(e => e && /engine_container\s*:/i.test(commentText(e)));
const authoredEnemies = map => map.events.filter(e => e && /enemy_id\s*:\s*\d+/i.test(commentText(e)));
const transferCommands = map => map.events.filter(Boolean).flatMap(event => event.pages.flatMap(page => page.list.filter(c => c.code === 201 && c.parameters[0] === 0).map(command => ({event, page, command}))));
const runtimeEvent = (round, mapId, eventId) => [...round.world.maps.get(mapId).events.values()].find(event => event.eventId === eventId);

// This store implements only the persistence boundary exercised by the Round.
// Production movement, event import, rewards, enemy death, and zones run unchanged.
class MemoryScope {
  constructor() { this.states = new Map(); this.containers = new Map(); this.drops = new Map(); this.operations = new Map(); }
  async listDrops(mapId) { return [...this.drops.values()].filter(drop => drop.mapId === mapId).map(clone); }
  async savePlayer(id, state) { this.states.set(id, clone(state)); }
  async loadPlayer(id) { return {id, username: id, state: clone(this.states.get(id))}; }
  async claimContainer({playerId, containerId, mutator}) {
    if (this.containers.has(containerId)) return {state: clone(this.states.get(playerId)), claimed: false, duplicate: true, claimedBy: this.containers.get(containerId)};
    const state = clone(this.states.get(playerId)), result = await mutator(state);
    this.states.set(playerId, clone(state)); this.containers.set(containerId, playerId);
    return {state, result, claimed: true, duplicate: false, claimedBy: playerId};
  }
  async createDrops({playerId, requestId, drops, mutator}) {
    const operation = `${playerId}:${requestId}`;
    if (this.operations.has(operation)) return {...clone(this.operations.get(operation)), duplicate: true};
    const state = clone(this.states.get(playerId)), result = await mutator(state);
    const created = drops.map((drop, index) => ({...clone(drop), id: `${operation}:${index}`}));
    for (const drop of created) this.drops.set(drop.id, clone(drop));
    this.states.set(playerId, clone(state));
    const outcome = {state, result, drops: created, duplicate: false};
    this.operations.set(operation, clone(outcome)); return outcome;
  }
}
async function fixture(id = 'modern-test') {
  let time = 100000;
  const scope = new MemoryScope(), store = {forRound: () => scope, updateRound: async () => {}};
  const round = new Round({id, ownerId: `${id}-a`, content, store, clock: () => time, random: () => .5,
    host: {finishRound: async () => assert.fail('Unexpected round settlement')}});
  async function connect(suffix) {
    const id = `${round.id}-${suffix}`, state = round.seed(round.world.defaultState());
    const player = await round.world.connect({id, username: id, state}, () => {});
    round.members.set(id, {id, name: id, result: null}); return player;
  }
  const player = await connect('a'); await round.start(player);
  return {round, player, connect, scope, setTime(value) { time = value; },
    async advance(ms = 200) {
      for (let remaining = ms; remaining > 0; remaining -= 50) {
        const step = Math.min(remaining, 50); time += step; round.world.update(step / 1000);
        await Promise.resolve(); for (const player of round.world.players.values()) await player._queue; await Promise.resolve();
      }
    }
  };
}

// Clear combatants only while checking the walkable layout: they can be defeated.
// Fixed decorations and container/service events still block World.canMove.
function withDefeatedEnemies(round, operation) {
  const enemies = [...round.world.maps.values()].flatMap(map => [...map.events.values()]).filter(e => e.enemyId);
  const previous = enemies.map(enemy => enemy.erased);
  try { for (const enemy of enemies) enemy.erased = true; return operation(); }
  finally { enemies.forEach((enemy, index) => { enemy.erased = previous[index]; }); }
}
function portalsFor(world, player, mapId) {
  return [...world.maps.get(mapId).events.values()].flatMap(event => {
    const page = world.events.pageFor({...player, mapId}, event, mapId);
    return (page?.engineDisabledReason ? [] : page?.list || []).filter(c => c.code === 201 && c.parameters[0] === 0).map(command => ({event, page, command}));
  });
}
function exploreMap(world, player, start) {
  const queue = [{...player, ...start}], visited = new Map([[key(start), start]]), taken = new Map();
  const portals = portalsFor(world, player, start.mapId);
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    for (const portal of portals) if (portal.page.trigger === 0 && near(current, portal.event)) taken.set(portal.event.id, portal);
    for (const [directionText, [dx, dy]] of Object.entries(DIRECTIONS)) {
      const direction = Number(directionText), dest = {...current, x: current.x + dx, y: current.y + dy};
      const touch = portals.find(p => [1, 2].includes(p.page.trigger) && p.event.x === dest.x && p.event.y === dest.y);
      // World.move triggers a touch event even when its visible door blocks entry.
      if (touch) { taken.set(touch.event.id, touch); continue; }
      if (visited.has(key(dest)) || !world.canMove(current, direction)) continue;
      visited.set(key(dest), {mapId: dest.mapId, x: dest.x, y: dest.y}); queue.push(dest);
    }
  }
  return {visited, taken};
}
function reachableRound(round, player) {
  const queue = [{mapId: player.mapId, x: player.x, y: player.y}], entries = new Set(), byMap = new Map();
  for (let index = 0; index < queue.length; index++) {
    const entry = queue[index], id = `${entry.mapId}:${key(entry)}`;
    if (entries.has(id)) continue; entries.add(id);
    const result = exploreMap(round.world, player, entry);
    if (!byMap.has(entry.mapId)) byMap.set(entry.mapId, {visited: new Map(), taken: new Map()});
    const all = byMap.get(entry.mapId);
    for (const [k, v] of result.visited) all.visited.set(k, v);
    for (const [k, portal] of result.taken) {
      all.taken.set(k, portal);
      const [, mapId, x, y] = portal.command.parameters, spawn = round.world.content.findSpawn(mapId, x, y);
      assert.ok(spawn, `Portal ${portal.event.id} has no destination spawn`);
      queue.push({mapId, ...spawn});
    }
  }
  return byMap;
}
function interactionTile(result, event) { return [...result.visited.values()].find(pos => near(pos, event)); }
function inventoryTotals(players) {
  const result = {};
  for (const player of players) for (const item of player.inventory) {
    const id = `${item.kind}:${item.itemId}`; result[id] = (result[id] || 0) + item.quantity;
  }
  return result;
}

test('nine modern maps retain six RM layers, collision flags, and all referenced image assets', async () => {
  assert.deepEqual([...content.maps.values()].filter(map => /<modernRound>/i.test(map.note)).map(map => map.id), modernIds);
  const images = new Set();
  for (const id of modernIds) {
    const map = content.getMap(id), tileset = content.getTileset(id);
    assert.ok(ROUND_MAPS.includes(id), `Map ${id} must join the actual round`);
    assert.equal(map.data.length, map.width * map.height * 6, `Map ${id}: six RM layers`);
    assert.equal(map.scrollType, 0, `Map ${id}: entrances require a bounded map`);
    assert.ok(tileset?.flags.length, `Map ${id}: tileset flags`);
    assert.ok(content.mapInfos[id]?.name, `Map ${id}: editor map info`);
    for (const name of tileset.tilesetNames.filter(Boolean)) images.add(path.join(projectRoot, 'img', 'tilesets', `${name}.png`));
    for (const tile of map.data.slice(0, map.width * map.height * 4)) {
      assert.ok(Number.isInteger(tile) && tile >= 0 && tile < tileset.flags.length, `Map ${id}: flag missing for tile ${tile}`);
    }
    assert.ok(authoredBoxes(map).length > 0, `Map ${id}: authored loot`);
    assert.ok(authoredEnemies(map).length > 0, `Map ${id}: authored enemies`);
    for (const event of map.events.filter(Boolean)) {
      assert.ok(event.x >= 0 && event.y >= 0 && event.x < map.width && event.y < map.height, `Map ${id}: event ${event.id} outside map`);
      for (const page of event.pages) if (page.image?.characterName) images.add(path.join(projectRoot, 'img', 'characters', `${page.image.characterName}.png`));
    }
  }
  for (const image of images) await access(image);
});

test('modern transfers are reciprocal and all districts join the existing round graph', () => {
  const graph = new Map(ROUND_MAPS.map(id => [id, new Set(transferCommands(content.getMap(id)).map(p => p.command.parameters[1]))]));
  const seen = new Set(), queue = [11];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]; if (seen.has(id)) continue; seen.add(id);
    for (const next of graph.get(id) || []) if (graph.has(next)) queue.push(next);
  }
  for (const id of modernIds) {
    assert.ok(seen.has(id), `Map ${id} cannot be reached from the original map 11`);
    for (const next of graph.get(id)) {
      assert.ok(ROUND_MAPS.includes(next), `Map ${id} leads outside this round`);
      assert.ok(graph.get(next)?.has(id), `Missing return portal ${next} -> ${id}`);
    }
  }
});

test('actual round spawn and every modern arrival can reach loot, enemies and exits with fixed events blocking movement', async () => {
  const {round, player} = await fixture();
  withDefeatedEnemies(round, () => {
    const reached = reachableRound(round, player);
    for (const id of modernIds) {
      const map = content.getMap(id), runtime = round.world.maps.get(id), result = reached.get(id);
      assert.ok(result, `Map ${id} is disconnected from actual round spawn`);
      const targets = [...runtime.events.values()].filter(e => e.service?.action === 'container' || e.enemyId);
      for (const event of targets) assert.ok(interactionTile(result, event), `No reachable interaction tile for ${event.id} at ${key(event)}`);
      for (const portal of portalsFor(round.world, player, id)) assert.ok(result.taken.has(portal.event.id), `Unreachable portal ${portal.event.id}`);
      const incoming = ROUND_MAPS.flatMap(from => transferCommands(round.world.content.getMap(from))).filter(p => p.command.parameters[1] === id);
      assert.ok(incoming.length, `Map ${id} has no arrivals`);
      for (const {event, command} of incoming) {
        const [, , x, y] = command.parameters, spawn = content.findSpawn(id, x, y);
        assert.deepEqual(spawn, {x, y}, `Portal ${event.id} into ${id} lands on a blocked tile`);
        assert.ok(!targets.some(target => target.x === x && target.y === y), `Portal into ${id} overlaps an event`);
        const local = exploreMap(round.world, player, {mapId: id, ...spawn});
        for (const target of targets) assert.ok(interactionTile(local, target), `Map ${id} arrival ${x},${y} cannot approach ${target.id}`);
        for (const portal of portalsFor(round.world, player, id)) assert.ok(local.taken.has(portal.event.id), `Map ${id} arrival ${x},${y} cannot use ${portal.event.id}`);
      }
      for (const authored of authoredEnemies(map)) {
        const enemy = runtimeEvent(round, id, authored.id);
        assert.ok(enemy?.npcKey && enemy.enemyId === -1 && enemy.hp > 0, `Native NPC ${id}:${authored.id} lost during round import`);
        assert.deepEqual({x: enemy.x, y: enemy.y}, {x: authored.x, y: authored.y});
        assert.deepEqual(content.findSpawn(id, enemy.x, enemy.y), {x: enemy.x, y: enemy.y}, `Enemy ${enemy.id} stands on blocked tiles`);
      }
    }
  });
});

test('every new portal executes its authored transfer through the real touch or interaction runtime', async () => {
  const {round, player} = await fixture('transfers');
  const reached = withDefeatedEnemies(round, () => reachableRound(round, player));
  for (const mapId of ROUND_MAPS) for (const portal of portalsFor(round.world, player, mapId)) {
    const [, destination, x, y] = portal.command.parameters;
    if (!modernIds.includes(mapId) && !modernIds.includes(destination)) continue;
    const stand = interactionTile(reached.get(mapId), portal.event);
    assert.ok(stand, 'No approach to portal ' + portal.event.id);
    await round.world.transfer(player, mapId, stand.x, stand.y);
    if (portal.page.trigger === 0) await round.world.interact(player, portal.event.id);
    else {
      const direction = Number(Object.entries(DIRECTIONS).find(([, [dx, dy]]) => stand.x + dx === portal.event.x && stand.y + dy === portal.event.y)?.[0]);
      round.world.now += 150; round.world.move(player, direction);
    }
    await player._queue;
    assert.equal(player.mapId, destination, 'Portal did not transfer: ' + portal.event.id);
    assert.deepEqual({x: player.x, y: player.y}, {x, y}, 'Portal changed authored landing: ' + portal.event.id);
  }
});

test('every authored modern container awards its valid contents once to the round and independently in another round', async () => {
  const first = await fixture('first'), second = await fixture('second'), peer = await first.connect('b');
  const reach = withDefeatedEnemies(first.round, () => reachableRound(first.round, first.player));
  for (const mapId of modernIds) for (const authored of authoredBoxes(content.getMap(mapId))) {
    const event = runtimeEvent(first.round, mapId, authored.id), otherEvent = runtimeEvent(second.round, mapId, authored.id);
    assert.equal(event?.service?.action, 'container', `Box ${mapId}:${authored.id} was not installed`);
    assert.deepEqual({x: event.x, y: event.y}, {x: authored.x, y: authored.y});
    const cache = first.round.containers.get(event.service.containerId), otherCache = second.round.containers.get(otherEvent.service.containerId);
    assert.notEqual(cache, otherCache); assert.equal(otherCache.opened, false); assert.ok(cache.items.length);
    const expected = inventoryTotals([first.player, peer]);
    for (const item of cache.items) {
      assert.ok(content.database[{item: 'Items', weapon: 'Weapons', armor: 'Armors'}[item.kind]]?.[item.itemId], `Unknown box reward ${item.kind}:${item.itemId}`);
      assert.ok(Number.isInteger(item.quantity) && item.quantity > 0);
      const id = `${item.kind}:${item.itemId}`; expected[id] = (expected[id] || 0) + item.quantity;
    }
    const stand = interactionTile(reach.get(mapId), event); assert.ok(stand);
    await first.round.world.transfer(first.player, mapId, stand.x, stand.y);
    await first.round.world.transfer(peer, mapId, stand.x, stand.y);
    await Promise.all([first.round.world.interact(first.player, event.id), first.round.world.interact(peer, event.id)]);
    assert.deepEqual(inventoryTotals([first.player, peer]), expected, `Shared box ${event.id} must award once`);
    await first.round.world.interact(first.player, event.id); await first.round.world.interact(peer, event.id);
    assert.deepEqual(inventoryTotals([first.player, peer]), expected, `Repeated box ${event.id} awarded again`);
    assert.equal(otherCache.opened, false);
    const before = inventoryTotals([second.player]);
    await second.round.world.transfer(second.player, mapId, stand.x, stand.y);
    await second.round.world.interact(second.player, otherEvent.id);
    assert.equal(otherCache.opened, true); assert.notDeepEqual(inventoryTotals([second.player]), before);
  }
});

test('authored enemies die, drop loot, stay dead beyond the respawn interval and remain isolated from another round', async () => {
  const first = await fixture('combat'), second = await fixture('untouched');
  for (const mapId of modernIds) {
    const enemies = authoredEnemies(content.getMap(mapId)).map(raw => runtimeEvent(first.round, mapId, raw.id));
    assert.equal(enemies.length, [...first.round.world.maps.get(mapId).events.values()].filter(e => e.enemyId).length);
    for (const enemy of enemies) {
      assert.equal(enemy.noRespawn, true); first.round.world.kill(enemy, first.player); await first.player._queue;
      assert.equal(enemy.dead, true); assert.equal(enemy.erased, true);
      const untouched = runtimeEvent(second.round, mapId, enemy.eventId);
      assert.ok(!untouched.dead && untouched.hp === untouched.maxHp);
    }
    assert.ok(first.round.world.maps.get(mapId).drops.size >= enemies.length, `No death loot on map ${mapId}`);
    first.player.mapId = mapId; first.setTime(first.round.world.now + 60000); first.round.world.update(.05); await first.player._queue;
    for (const enemy of enemies) assert.ok(enemy.dead && enemy.erased, `${enemy.id} respawned within the same round`);
  }
});

test('all modern districts receive ordinary danger zones and the existing controller clears them while retaining the boss zone', async () => {
  const {round, player, setTime} = await fixture('zones');
  setTime(round.startedAt + 900000); round.update(.05); await player._queue;
  for (const mapId of modernIds) {
    const zone = round.world.maps.get(mapId).zone;
    assert.ok(zone && zone.damage > 0 && zone.startsAt < zone.endsAt, `Map ${mapId} missing danger zone`);
    assert.ok(zone.startsAt < round.startedAt + round.durationSeconds * 1000, `Map ${mapId} closes after the round`);
  }
  await round.world.grant(player, 'item', round.scenario.itemIds.control, 1);
  const controller = [...round.world.maps.get(13).events.values()].find(event => event.service?.action === 'control');
  const stand = Object.values(DIRECTIONS).map(([dx, dy]) => ({x: controller.x + dx, y: controller.y + dy})).find(pos => content.findSpawn(13, pos.x, pos.y)?.x === pos.x && content.findSpawn(13, pos.x, pos.y)?.y === pos.y);
  assert.ok(stand); await round.world.transfer(player, 13, stand.x, stand.y); await round.world.interact(player, controller.id);
  for (const id of modernIds) assert.equal(round.world.maps.get(id).zone, null);
  assert.equal(round.world.maps.get(22).zone?.persistent, true);
});


test('offline search recognizes every modern route and walks from the original round spawn into the new district', async () => {
  const f = await fixture('offline-search'), {round, player} = f, world = round.world;
  for (const mapId of ROUND_MAPS) {
    const automatic = getPortals(world, {...player, mapId});
    for (const portal of portalsFor(world, player, mapId)) {
      const [, destination, x, y] = portal.command.parameters;
      if (!modernIds.includes(mapId) && !modernIds.includes(destination)) continue;
      const route = automatic.find(route => route.eventId === portal.event.id);
      assert.ok(route, 'Automatic navigation cannot discover portal ' + portal.event.id);
      assert.deepEqual({mapId: route.mapId, x: route.targetX, y: route.targetY}, {mapId: destination, x, y});
    }
  }
  const start = {mapId: player.mapId, x: player.x, y: player.y};
  player.offlineBehavior = 'search'; await world.disconnect(player.id); await f.advance();
  assert.equal(player.mapId, start.mapId);
  assert.ok(Math.abs(player.x - start.x) + Math.abs(player.y - start.y) <= 1, 'Offline search must move one tile at a time');
  for (let step = 0; step < 1200 && !modernIds.includes(player.mapId) && !player.dead; step++) await f.advance();
  assert.ok(modernIds.includes(player.mapId), 'Offline search never entered a modern district: ' + player.offlineActivity);
  assert.equal(player.dead, false); assert.equal(player._connected, false);
  assert.ok(f.scope.containers.has('village'), 'Search must claim the existing village supply on its journey');
  assert.ok(f.scope.containers.has('road'), 'Search must claim the existing road supply before exploring farther');
  assert.equal(world.events.dialogues.size, 0); assert.equal(world.events.tasks.size, 0);
});

test('offline evasion walks out of a modern danger zone through an authored portal before the zone activates', async () => {
  const f = await fixture('offline-zone'), {round, player} = f, world = round.world;
  // Pick an authored arrival far enough inside a district to require movement,
  // away from combat so this regression measures danger-zone travel itself.
  const arrivals = ROUND_MAPS.flatMap(id => transferCommands(world.content.getMap(id)));
  const incoming = arrivals.find(({command}) => {
    const [, mapId, x, y] = command.parameters;
    if (!modernIds.includes(mapId)) return false;
    const point = {x, y}, portals = getPortals(world, {...player, mapId});
    return portals.length && portals.every(p => Math.abs(p.x - x) + Math.abs(p.y - y) >= 2)
      && [...world.maps.get(mapId).events.values()].filter(e => e.enemyId).every(e => Math.abs(e.x - point.x) + Math.abs(e.y - point.y) > 8);
  });
  assert.ok(incoming, 'No safe authored arrival for the danger-zone regression');
  const [, mapId, x, y] = incoming.command.parameters;
  await world.transfer(player, mapId, x, y);
  world.maps.get(mapId).zone = {startsAt: world.now + 30000, endsAt: world.now + 120000, damage: 8};
  player.offlineBehavior = 'evade'; await world.disconnect(player.id); await f.advance();
  assert.equal(player.mapId, mapId);
  assert.ok(Math.abs(player.x - x) + Math.abs(player.y - y) <= 1, 'Evasion must walk to the exit');
  for (let step = 0; step < 150 && player.mapId === mapId && !player.dead; step++) await f.advance();
  assert.notEqual(player.mapId, mapId, 'Offline evasion was trapped in a modern zone: ' + player.offlineActivity);
  assert.equal(world.maps.get(player.mapId).zone, null);
  assert.equal(player.hp, player.maxHp, 'Evasion must leave before danger damage begins');
  assert.equal(world.events.dialogues.size, 0); assert.equal(world.events.tasks.size, 0);
});
