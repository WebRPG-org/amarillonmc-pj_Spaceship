import test from 'node:test';
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadContent} from '../server/content.mjs';
import {World, DIRECTIONS} from '../server/world.mjs';
import {ROUND_MAPS} from '../server/rounds.mjs';
import {getPortals} from '../server/navigation.mjs';
import {PUBLIC_CITY_MAPS, PUBLIC_CITY_SPAWN, bindPublicCityServices} from '../server/public-city.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const content = await loadContent(projectRoot);
const key = point => `${point.x},${point.y}`;
const near = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
const position = entity => ({mapId: entity.mapId, x: entity.x, y: entity.y});
const transfers = map => (map?.events || []).filter(Boolean).flatMap(event => event.pages.flatMap(page =>
  page.list.filter(command => command.code === 201 && command.parameters[0] === 0).map(command => ({event, page, command}))));
const eventText = event => [event.note, ...event.pages.flatMap(page => page.list)
  .filter(command => [108, 408].includes(command.code)).map(command => command.parameters[0])].join('\n');

async function fixture() {
  const states = new Map(), messages = [];
  const store = {listDrops: async () => [], savePlayer: async (id, state) => states.set(id, structuredClone(state))};
  const world = new World({content, store, clock: () => 100000, random: () => .5,
    hooks: {onMapReady: bindPublicCityServices}});
  for (const mapId of PUBLIC_CITY_MAPS) await world.ensureMap(mapId);
  const player = await world.connect({id: 'public-city-walker', username: 'Walker',
    state: {...world.defaultState(), ...PUBLIC_CITY_SPAWN}}, message => messages.push(message));
  return {world, player, states, messages};
}

function portalsFor(world, player, mapId) {
  return [...world.maps.get(mapId).events.values()].flatMap(event => {
    const page = world.events.pageFor({...player, mapId}, event, mapId);
    if (!page || page.engineDisabledReason || event.erased) return [];
    return page.list.filter(command => command.code === 201 && command.parameters[0] === 0)
      .map(command => ({event, page, command}));
  });
}

// No events are erased and no collision flags are changed. A touch portal ends a
// local route: walking through a transfer tile would hide a disconnected room.
function exploreMap(world, player, start) {
  const first = {...start, parent: null, direction: null};
  const queue = [first], visited = new Map([[key(first), first]]), taken = new Map();
  const portals = portalsFor(world, player, start.mapId);
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index], entity = {...player, ...current};
    for (const portal of portals) if (portal.page.trigger === 0 && near(current, portal.event)) {
      taken.set(portal.event.id, {portal, stand: current});
    }
    for (const [directionText, [dx, dy]] of Object.entries(DIRECTIONS)) {
      const direction = Number(directionText);
      const next = {mapId: start.mapId, ...content.wrapPosition(start.mapId, current.x + dx, current.y + dy), parent: current, direction};
      const touch = portals.find(portal => [1, 2].includes(portal.page.trigger) && key(portal.event) === key(next));
      // World.move also starts a touch event when a visible door blocks entry.
      if (touch) { taken.set(touch.event.id, {portal: touch, stand: current, direction}); continue; }
      if (visited.has(key(next)) || !world.canMove(entity, direction)) continue;
      visited.set(key(next), next); queue.push(next);
    }
  }
  return {visited, taken};
}

function arrivalsFor(mapId) {
  const arrivals = [...content.maps.values()].flatMap(map => transfers(map).map(portal => ({...portal, from: map.id})))
    .filter(({command}) => command.parameters[1] === mapId)
    .map(({event, command, from}) => ({mapId, x: command.parameters[2], y: command.parameters[3], from, source: `Map ${from} event ${event.id}`}));
  if (mapId === PUBLIC_CITY_SPAWN.mapId) arrivals.unshift({...PUBLIC_CITY_SPAWN, source: 'public city spawn'});
  return [...new Map(arrivals.map(arrival => [key(arrival), arrival])).values()];
}

function blockedByEvent(world, player, point) {
  return [...world.maps.get(point.mapId).events.values()].find(event => {
    if (event.erased || event.dead || key(event) !== key(point)) return false;
    const page = world.events.pageFor({...player, ...point}, event, point.mapId);
    return page && !page.engineDisabledReason && !(page.through ?? event.through)
      && (page.priorityType ?? event.priorityType) === 1 && (event.enemyId || page.image?.characterName || page.image?.tileId);
  });
}

function interactionTargets(world, player, mapId) {
  return [...world.maps.get(mapId).events.values()].filter(event => {
    const page = world.events.pageFor({...player, mapId}, event, mapId);
    return page && !page.engineDisabledReason && !event.erased && page.trigger === 0
      && !page.list.some(command => command.code === 201)
      && (event.service || page.list.some(command => ![0, 108, 408].includes(command.code)));
  });
}

async function walkAndUse(world, player, attempt) {
  const route = [];
  for (let node = attempt.stand; node.parent; node = node.parent) route.push(node.direction);
  for (const direction of route.reverse()) {
    const [dx, dy] = DIRECTIONS[direction], expected = {mapId: player.mapId, x: player.x + dx, y: player.y + dy};
    world.now += 150; world.move(player, direction); await player._queue;
    assert.deepEqual(position(player), expected, `Walk blocked at Map ${expected.mapId} (${expected.x},${expected.y})`);
  }
  const {portal} = attempt, [, mapId, x, y] = portal.command.parameters;
  if (portal.page.trigger === 0) await world.interact(player, portal.event.id);
  else { world.now += 150; world.move(player, attempt.direction); }
  await player._queue;
  assert.deepEqual(position(player), {mapId, x, y}, `${portal.event.id} at (${key(portal.event)}) did not use its exact authored landing`);
}

test('nine public maps preserve six layers and image references without instance combat or loot', async () => {
  assert.deepEqual(PUBLIC_CITY_MAPS, [40, 41, 42, 43, 44, 45, 46, 47, 48]);
  assert.deepEqual([...content.maps.values()].filter(map => /<publicCity>/i.test(map.note)).map(map => map.id), PUBLIC_CITY_MAPS);
  const images = new Set();
  for (const id of PUBLIC_CITY_MAPS) {
    const map = content.getMap(id), tileset = content.getTileset(id);
    assert.ok(map, `Map ${id} is missing`);
    assert.ok(!ROUND_MAPS.includes(id), `Public Map ${id} belongs to ROUND_MAPS`);
    assert.ok(!/<modernRound>/i.test(map.note), `Public Map ${id} has an instance tag`);
    assert.equal(map.data.length, map.width * map.height * 6, `Map ${id}: six RM layers`);
    assert.equal(map.scrollType, 0, `Map ${id}: bounded public map`);
    assert.ok(tileset?.flags.length, `Map ${id}: missing tileset flags`);
    assert.ok(content.mapInfos[id]?.name, `Map ${id}: missing editor entry`);
    for (const name of tileset.tilesetNames.filter(Boolean)) images.add(path.join(projectRoot, 'img', 'tilesets', `${name}.png`));
    for (const tile of map.data.slice(0, map.width * map.height * 4)) {
      assert.ok(Number.isInteger(tile) && tile >= 0 && tile < tileset.flags.length, `Map ${id}: missing flag for tile ${tile}`);
    }
    for (const event of map.events.filter(Boolean)) {
      assert.ok(!/\b(?:enemy_id|engine_enemy|engine_container)\s*:/i.test(eventText(event)), `Public event ${id}:${event.id} contains an enemy or loot marker`);
      assert.ok(event.x >= 0 && event.y >= 0 && event.x < map.width && event.y < map.height, `Map ${id}: event ${event.id} outside map at (${key(event)})`);
      for (const page of event.pages) if (page.image?.characterName) images.add(path.join(projectRoot, 'img', 'characters', `${page.image.characterName}.png`));
    }
  }
  for (const image of images) await access(image);
});

test('public city graph has return routes and is connected from the city spawn', () => {
  const graph = new Map(PUBLIC_CITY_MAPS.map(id => [id, new Set(transfers(content.getMap(id)).map(portal => portal.command.parameters[1]))]));
  const seen = new Set(), queue = [PUBLIC_CITY_SPAWN.mapId];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]; if (seen.has(id)) continue; seen.add(id);
    for (const next of graph.get(id) || []) {
      assert.ok(PUBLIC_CITY_MAPS.includes(next), `Map ${id} transfers outside the public city to ${next}`);
      assert.ok(graph.get(next)?.has(id), `Missing return route Map ${next} -> ${id}`);
      queue.push(next);
    }
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), PUBLIC_CITY_MAPS);
});

test('every actual arrival reaches all exits and NPC interaction tiles with full runtime collisions', async t => {
  const {world, player} = await fixture();
  for (const mapId of PUBLIC_CITY_MAPS) await t.test(`Map ${mapId}`, () => {
    const portals = portalsFor(world, player, mapId), targets = interactionTargets(world, player, mapId), arrivals = arrivalsFor(mapId), problems = [];
    assert.ok(arrivals.length, `Map ${mapId} has no arrivals`);
    for (const entry of arrivals) {
      const label = `Map ${mapId} arrival (${key(entry)}) from ${entry.source}`;
      const spawn = content.findSpawn(mapId, entry.x, entry.y);
      if (!spawn || key(spawn) !== key(entry)) problems.push(`${label}: blocked floor; runtime relocates to ${spawn ? key(spawn) : 'nowhere'}`);
      const blocking = blockedByEvent(world, player, entry);
      if (blocking) problems.push(`${label}: overlaps blocking ${blocking.id}`);
      if (portals.some(portal => [1, 2].includes(portal.page.trigger) && key(portal.event) === key(entry))) problems.push(`${label}: overlaps a touch portal`);
      const result = exploreMap(world, player, entry);
      for (const target of targets) if (![...result.visited.values()].some(point => near(point, target))) problems.push(`${label}: cannot approach ${target.id} ${target.name} at (${key(target)})`);
      for (const portal of portals) if (!result.taken.has(portal.event.id)) problems.push(`${label}: cannot use ${portal.event.id} at (${key(portal.event)})`);
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });
});

test('each city touch door executes an outward and return journey by actual player movement', async t => {
  const {world, player} = await fixture();
  for (const mapId of PUBLIC_CITY_MAPS) await t.test(`Map ${mapId} transfers`, async () => {
    const start = arrivalsFor(mapId)[0];
    assert.ok(start, `Map ${mapId} has no starting arrival`);
    for (const portal of portalsFor(world, player, mapId)) {
      assert.ok([1, 2].includes(portal.page.trigger), `${portal.event.id}: public doors must support touch travel`);
      await world.transfer(player, mapId, start.x, start.y);
      const attempt = exploreMap(world, player, position(player)).taken.get(portal.event.id);
      assert.ok(attempt, `Map ${mapId} (${key(start)}) cannot approach portal ${portal.event.id} (${key(portal.event)})`);
      const discoverable = getPortals(world, player).find(item => item.eventId === portal.event.id);
      assert.ok(discoverable, `Automatic navigation cannot discover ${portal.event.id}`);
      await walkAndUse(world, player, attempt);
      const landed = position(player), back = [...exploreMap(world, player, landed).taken.values()]
        .find(item => item.portal.command.parameters[1] === mapId);
      assert.ok(back, `Map ${landed.mapId} arrival (${key(landed)}) has no usable return to Map ${mapId}`);
      await walkAndUse(world, player, back);
      assert.equal(player.mapId, mapId);
    }
  });
  assert.equal(world.runtimeDiagnostics.size, 0, 'Public travel emitted runtime diagnostics');
  assert.equal(world.events.tasks.size, 0, 'Public travel left an active event task');
  assert.equal(world.events.dialogues.size, 0, 'Public travel unexpectedly opened a dialogue');
});

test('the relocated crafting artisan opens the existing recipes without granting supplies', async () => {
  assert.equal(content.getMap(3).events[8], null, 'The old Map003 event 8 must be retired');
  assert.equal(content.recipes.length, 9, 'The migration must retain the nine existing recipes');
  const originalRecipes = structuredClone(content.recipes);
  const {world, player, states, messages} = await fixture();
  const artisan = [...world.maps.get(42).events.values()].find(event => event.eventId === 8);
  assert.ok(artisan, 'Map042 event 8 must contain the relocated artisan');
  assert.deepEqual(position(artisan), {mapId: 42, x: 18, y: 13});
  const reachable = exploreMap(world, player, arrivalsFor(42)[0]);
  const stand = [...reachable.visited.values()].find(point => near(point, artisan));
  assert.ok(stand, 'The crafting artisan needs a reachable interaction tile');
  await world.transfer(player, 42, stand.x, stand.y);
  player.direction = Number(Object.entries(DIRECTIONS).find(([, [dx, dy]]) => player.x + dx === artisan.x && player.y + dy === artisan.y)[0]);
  const supplies = entity => ({inventory: entity.inventory, gold: entity.gold});
  const before = structuredClone(supplies(player));
  messages.length = 0;
  await world.interact(player);
  const dialogue = messages.find(message => message.type === 'dialogue' && message.choices);
  assert.ok(dialogue, 'Facing the artisan must open the original choice dialogue');
  assert.deepEqual(dialogue.choices, ['是', '否']);
  assert.equal(world.events.choose(player, dialogue.choices.indexOf('是')), true);
  await player._queue;
  const opened = messages.filter(message => message.type === 'openCrafting');
  assert.equal(opened.length, 1, 'Choosing 是 must open crafting exactly once');
  assert.deepEqual(opened[0].recipes, originalRecipes);
  assert.deepEqual(content.recipes, originalRecipes, 'The interaction must not mutate recipes');
  assert.deepEqual(supplies(player), before, 'Opening crafting must not grant live supplies');
  assert.deepEqual(supplies(states.get(player.id)), before, 'Opening crafting must not grant saved supplies');
  assert.equal(world.events.dialogues.size, 0);
  assert.equal(world.events.tasks.size, 0);
  assert.equal(world.runtimeDiagnostics.size, 0);
});
