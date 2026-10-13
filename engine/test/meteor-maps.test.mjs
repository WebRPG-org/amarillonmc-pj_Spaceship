import test from 'node:test';
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadContent} from '../server/content.mjs';
import {World, DIRECTIONS} from '../server/world.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const content = await loadContent(root);
const ids = [52,53,54,55,56];
const spawn = {mapId:52,x:5,y:17};
const key = p => `${p.x},${p.y}`;
const position = p => ({mapId:p.mapId,x:p.x,y:p.y});
const near = (a,b) => Math.abs(a.x-b.x)+Math.abs(a.y-b.y) === 1;
const transfers = map => map.events.filter(Boolean).flatMap(event => event.pages.flatMap(page => page.list
  .filter(c => c.code === 201).map(command => ({event,page,command}))));
const metadata = event => [event.note,...event.pages.flatMap(page => page.list).filter(c => [108,408].includes(c.code)).map(c => c.parameters[0])].join('\n');

async function fixture() {
  const world = new World({content,clock:() => 100000,random:() => .5,
    store:{listDrops:async () => [],savePlayer:async () => {}}});
  for (const id of ids) await world.ensureMap(id);
  const player = await world.connect({id:'meteor-map-walker',username:'Walker',state:{...world.defaultState(),...spawn}},() => {});
  return {world,player};
}

// A touch-transfer ends exploration at that edge; finding an exit may not depend
// on walking through an exit to reach a disconnected area on its other side.
function explore(world, player, start) {
  const first = {...start,parent:null,direction:null}, visited = new Map([[key(first),first]]), queue = [first], exits = new Map();
  const portals = transfers(content.getMap(start.mapId));
  for (let i=0;i<queue.length;i++) {
    const current = queue[i], entity = {...player,...current};
    for (const [directionText,[dx,dy]] of Object.entries(DIRECTIONS)) {
      const direction = Number(directionText), next = {mapId:start.mapId,x:current.x+dx,y:current.y+dy,parent:current,direction};
      const portal = portals.find(p => key(p.event) === key(next));
      if (portal) {exits.set(portal.event.id,{portal,stand:current,direction});continue;}
      if (visited.has(key(next)) || !world.canMove(entity,direction)) continue;
      visited.set(key(next),next);queue.push(next);
    }
  }
  return {visited,exits};
}

test('meteor adventure keeps editable RM maps and independent real-time metadata', async () => {
  const images = new Set();
  for (const id of ids) {
    const map = content.getMap(id), tileset = content.getTileset(id);
    assert.equal(map.data.length,map.width*map.height*6);
    assert.equal(map.encounterList.length,0);
    assert.match(map.note,/engine_adventure: meteor/);
    assert.match(map.note,id <= 54 ? /engine_environment: outdoor/ : /engine_environment: indoor/);
    assert.equal(content.mapInfos[id].parentId,id === 52 ? 2 : 52);
    for (const name of tileset.tilesetNames.filter(Boolean)) images.add(path.join(root,'img/tilesets',`${name}.png`));
    for (const event of map.events.filter(Boolean)) {
      assert.ok(event.x>=0&&event.y>=0&&event.x<map.width&&event.y<map.height);
      assert.ok(!/enemy_id\s*:/i.test(metadata(event)),'New NPCs must not reuse RM turn-based enemy IDs');
      for (const page of event.pages) if (page.image.characterName) images.add(path.join(root,'img/characters',`${page.image.characterName}.png`));
    }
  }
  for (const image of images) await access(image);
  assert.match(content.getMap(52).events[1].note,/engine_service: meteorExit/);
  assert.deepEqual([content.getMap(52).events[1].x,content.getMap(52).events[1].y],[4,17]);
  assert.match(content.getMap(56).events[1].note,/engine_service: meteorDisk/);
  assert.deepEqual([content.getMap(56).events[1].x,content.getMap(56).events[1].y],[22,6]);
});

test('all meteor adventure arrivals can reach objectives and every return exit with intact structures', async t => {
  const {world,player} = await fixture();
  for (const mapId of ids) await t.test(`Map ${mapId}`,() => {
    const raw = content.getMap(mapId), portals = transfers(raw);
    const arrivals = ids.flatMap(id => transfers(content.getMap(id))).filter(p => p.command.parameters[1] === mapId)
      .map(p => ({mapId,x:p.command.parameters[2],y:p.command.parameters[3]}));
    if (mapId===52) arrivals.push(spawn);
    for (const arrival of arrivals) {
      assert.deepEqual(content.findSpawn(mapId,arrival.x,arrival.y),{x:arrival.x,y:arrival.y},`Map ${mapId}: invalid landing ${key(arrival)}`);
      assert.ok(!raw.events.filter(Boolean).some(e => key(e)===key(arrival)),`Map ${mapId}: landing overlaps event ${key(arrival)}`);
      const result = explore(world,player,arrival);
      for (const portal of portals) assert.ok(result.exits.has(portal.event.id),`Map ${mapId}: arrival ${key(arrival)} cannot reach exit ${portal.event.id}`);
      const targets = raw.events.filter(e => e && (/engine_service:|engine_container:/.test(metadata(e)) || e.pages[0].list.some(c => c.code===101)));
      for (const target of targets) assert.ok([...result.visited.values()].some(p => near(p,target)),`Map ${mapId}: cannot approach ${target.name} at ${key(target)}`);
    }
  });
});

test('every meteor map transfer executes by player movement and has a usable return journey', async () => {
  const {world,player} = await fixture();
  async function use(attempt) {
    const route = [];for(let node=attempt.stand;node.parent;node=node.parent)route.push(node.direction);
    for (const direction of route.reverse()) {
      const [dx,dy] = DIRECTIONS[direction], expected = {mapId:player.mapId,x:player.x+dx,y:player.y+dy};
      world.now+=150;world.move(player,direction);await player._queue;
      assert.deepEqual(position(player),expected,'Authored route must execute with runtime collision');
    }
    world.now+=150;world.move(player,attempt.direction);await player._queue;
    const [,mapId,x,y] = attempt.portal.command.parameters;
    assert.deepEqual(position(player),{mapId,x,y});
  }
  for (const mapId of ids) {
    const incoming = ids.flatMap(id=>transfers(content.getMap(id))).find(p=>p.command.parameters[1]===mapId).command.parameters;
    for (const portal of transfers(content.getMap(mapId))) {
      await world.transfer(player,mapId,incoming[2],incoming[3]);
      const attempt = explore(world,player,position(player)).exits.get(portal.event.id);assert.ok(attempt);
      await use(attempt);
      const back = [...explore(world,player,position(player)).exits.values()].find(a=>a.portal.command.parameters[1]===mapId);assert.ok(back);
      await use(back);assert.equal(player.mapId,mapId);
    }
  }
  assert.equal(world.runtimeDiagnostics.size,0);
  assert.equal(world.events.tasks.size,0);
});
