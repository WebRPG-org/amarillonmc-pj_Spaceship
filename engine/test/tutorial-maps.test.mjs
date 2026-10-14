import test from 'node:test';
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadContent} from '../server/content.mjs';
import {World,DIRECTIONS} from '../server/world.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const content=await loadContent(root),ids=[57,58,59,60],spawn={mapId:57,x:4,y:19};
const key=p=>`${p.x},${p.y}`,position=p=>({mapId:p.mapId,x:p.x,y:p.y});
const near=(a,b)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y)===1;
const transfers=map=>map.events.filter(Boolean).flatMap(event=>event.pages.flatMap(page=>page.list.filter(c=>c.code===201).map(command=>({event,page,command}))));
async function fixture(){const world=new World({content,clock:()=>100000,random:()=>.5,store:{listDrops:async()=>[],savePlayer:async()=>{}}});for(const id of ids)await world.ensureMap(id);const player=await world.connect({id:'rose-map-walker',username:'Walker',state:{...world.defaultState(),...spawn}},()=>{});return{world,player};}
// Arrival/exit traversal uses server collision, including all active NPCs and
// complete furniture. Touch exits stop the search rather than joining islands.
function explore(world,player,start){const first={...start,parent:null,direction:null},visited=new Map([[key(first),first]]),queue=[first],exits=new Map(),portals=transfers(content.getMap(start.mapId));for(let i=0;i<queue.length;i++){const current=queue[i],entity={...player,...current};for(const[d,[dx,dy]]of Object.entries(DIRECTIONS)){const direction=Number(d),next={mapId:start.mapId,x:current.x+dx,y:current.y+dy,parent:current,direction};if(!world.canMove(entity,direction))continue;const portal=portals.find(p=>key(p.event)===key(next));if(portal){exits.set(portal.event.id,{portal,stand:current,direction});continue;}if(visited.has(key(next)))continue;visited.set(key(next),next);queue.push(next);}}return{visited,exits};}

test('ROSE maps preserve editable six-plane maps, tags, sprite resources and identity',async()=>{
  const images=new Set();
  for(const id of ids){const map=content.getMap(id);assert.equal(map.data.length,map.width*map.height*6);assert.equal(map.encounterList.length,0);assert.match(map.note,/engine_adventure: tutorial/);assert.equal(content.mapInfos[id].parentId,id===57?2:57);for(const name of content.getTileset(id).tilesetNames.filter(Boolean))images.add(path.join(root,'img/tilesets',`${name}.png`));for(const e of map.events.filter(Boolean)){assert.ok(e.x>=0&&e.y>=0&&e.x<map.width&&e.y<map.height);assert.ok(!/enemy_id\s*:/i.test(e.note));for(const p of e.pages)if(p.image.characterName)images.add(path.join(root,'img/characters',`${p.image.characterName}.png`));}}
  images.add(path.join(root,'img/faces/ROSE.png'));for(const file of images)await access(file);
  const entrance=content.getMap(41).events[11];assert.match(entrance.note,/engine_service: tutorialEntrance/);assert.deepEqual([entrance.x,entrance.y],[25,14]);
  assert.deepEqual(content.getMap(57).events.filter(e=>e?.note.includes('engine_tutorial_checkpoint')).map(e=>e.note),['engine_tutorial_checkpoint: a','engine_tutorial_checkpoint: b','engine_tutorial_checkpoint: c']);
  assert.equal(content.getMap(58).events.filter(e=>e?.note.includes('engine_tutorial_target:')).length,6);
  assert.equal(content.getMap(60).events.filter(e=>e?.note.includes('engine_npc: tutorial-final')).length,2);
});

test('every tutorial arrival reaches all exits, guides, supplies, targets and crafting stand',async t=>{
  const{world,player}=await fixture();
  for(const mapId of ids)await t.test(`Map ${mapId}`,()=>{
    const raw=content.getMap(mapId),arrivals=ids.flatMap(id=>transfers(content.getMap(id))).filter(p=>p.command.parameters[1]===mapId).map(p=>({mapId,x:p.command.parameters[2],y:p.command.parameters[3]}));if(mapId===57)arrivals.push(spawn);
    for(const arrival of arrivals){assert.deepEqual(content.findSpawn(mapId,arrival.x,arrival.y),{x:arrival.x,y:arrival.y},`invalid arrival ${mapId}:${key(arrival)}`);assert.ok(!raw.events.filter(Boolean).some(e=>key(e)===key(arrival)),`arrival overlaps event ${mapId}:${key(arrival)}`);const result=explore(world,player,arrival);for(const p of transfers(raw))assert.ok(result.exits.has(p.event.id),`${mapId}: ${key(arrival)} cannot reach exit ${p.event.id}`);for(const e of raw.events.filter(e=>e&&/engine_service:|engine_container:|engine_tutorial_|engine_npc:/.test(e.note)))assert.ok([...result.visited.values()].some(p=>near(p,e)),`${mapId}: cannot approach ${e.name} (${key(e)})`);}
  });
});

test('all six weapon targets have five clear firing tiles, and route requires both causeways',async()=>{
  const{world,player}=await fixture();
  for(const e of content.getMap(58).events.filter(e=>e?.note.includes('engine_tutorial_target:'))){for(let distance=1;distance<=5;distance++){const p={...player,mapId:58,x:e.x,y:e.y+distance};assert.ok([2,4,6,8].some(d=>content.isPassable(58,p.x,p.y,d)),`${e.name}: firing stand ${distance} blocked`);if(distance<5)assert.ok(world.canMove(p,2),`${e.name}: furniture interrupts approach`);}}
  const movement=explore(world,player,spawn),goal=movement.exits.get(5);assert.ok(goal);const route=[];for(let p=goal.stand;p;p=p.parent)route.push(p);
  assert.ok(route.some(p=>p.x===11&&p.y>=17&&p.y<=19),'route must cross south causeway');assert.ok(route.some(p=>p.x===21&&p.y>=5&&p.y<=7),'route must cross north causeway');
  assert.ok(!content.isPassable(57,9,9,6),'canal must block shortcut from first island');assert.ok(!content.isPassable(57,19,18,6),'canal must block shortcut to third island');
});

test('authored forward and return transfers execute through actual World.move',async()=>{
  const{world,player}=await fixture();
  async function use(attempt){const route=[];for(let p=attempt.stand;p.parent;p=p.parent)route.push(p.direction);for(const direction of route.reverse()){const[dx,dy]=DIRECTIONS[direction],expected={mapId:player.mapId,x:player.x+dx,y:player.y+dy};world.now+=250;world.move(player,direction);await player._queue;assert.deepEqual(position(player),expected);}world.now+=250;world.move(player,attempt.direction);await player._queue;const[,mapId,x,y]=attempt.portal.command.parameters;assert.deepEqual(position(player),{mapId,x,y});}
  for(const mapId of ids){const incoming=mapId===57?[0,57,4,19]:ids.flatMap(id=>transfers(content.getMap(id))).find(p=>p.command.parameters[1]===mapId).command.parameters;for(const portal of transfers(content.getMap(mapId))){await world.transfer(player,mapId,incoming[2],incoming[3]);const attempt=explore(world,player,position(player)).exits.get(portal.event.id);assert.ok(attempt);await use(attempt);const back=[...explore(world,player,position(player)).exits.values()].find(a=>a.portal.command.parameters[1]===mapId);assert.ok(back);await use(back);assert.equal(player.mapId,mapId);}}
  assert.equal(world.runtimeDiagnostics.size,0);assert.equal(world.events.tasks.size,0);
});
