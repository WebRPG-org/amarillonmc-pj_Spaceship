import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {loadContent} from '../server/content.mjs';
import {Round} from '../server/rounds.mjs';
import {prepareRoundEvents} from '../server/round-events.mjs';
import {eventTags,eventNotes,npcTag} from '../server/event-tags.mjs';
import {configureNpc} from '../server/npcs.mjs';

const base=await loadContent(fileURLToPath(new URL('../../',import.meta.url)));
const cmd=(code,parameters=[],indent=0)=>({code,parameters,indent});
const page=(list,extra={})=>({...structuredClone(base.getMap(31).events[1].pages[0]),list,conditions:{},trigger:0,...extra});
const event=(id,list,extra={})=>({id,name:`authored-${id}`,x:4+id,y:8,note:'',pages:[page(list)],...extra});
function contentFor(events,commonEvents=[]){
  const maps=new Map(base.maps);maps.set(31,{...structuredClone(base.getMap(31)),events:[null,...events]});
  return {...base,database:{...base.database,CommonEvents:commonEvents},maps,getMap:id=>maps.get(Number(id))};
}
const scenario=type=>({id:'authoring-test',name:'Authoring',type,mapIds:[31,32],durationSeconds:600,maxPlayers:1});
async function roundFixture(type,events,commonEvents=[]){
  const content=contentFor(events,commonEvents),messages=[],store={forRound:()=>({listDrops:async()=>[]})};
  const round=new Round({id:`authoring-${type}`,ownerId:'author',scenario:scenario(type),content,store,host:{}}),world=round.world,map=await world.ensureMap(31);
  const player={...world.defaultState(),id:'author',name:'Author',mapId:31,x:5,y:9,_connected:true,_send:message=>messages.push(message)};
  world.players.set(player.id,player);return{round,world,map,player,messages,content,entity:id=>[...map.events.values()].find(e=>e.eventId===id)};
}

for(const type of ['dts','adventure'])test(`${type} authored dialogue, choices, nested branches, common events and personal pages run without stripping`,async()=>{
  const list=[cmd(101,['',0,0,2]),cmd(401,['Choose a route']),cmd(102,[['Accept','Decline'],-1,0]),cmd(402,[0,'Accept']),cmd(117,[1],1),cmd(111,[1,1,0,42,0],1),cmd(121,[2,2,0],2),cmd(412,[],1),cmd(402,[1,'Decline']),cmd(122,[1,1,0,0,-1],1),cmd(404),cmd(0)];
  const source=event(1,list);source.pages.push(page([cmd(101),cmd(401,['Done']),cmd(0)],{conditions:{switch1Valid:true,switch1Id:2}}));
  const f=await roundFixture(type,[source],[null,{id:1,name:'Reward flag',trigger:0,list:[cmd(122,[1,1,0,0,42]),cmd(0)]}]);
  assert.deepEqual(f.entity(1).pages,source.pages);assert.equal(f.world.events.start(f.player,f.entity(1)),true);assert.deepEqual(f.messages.at(-1).choices,['Accept','Decline']);
  f.world.events.choose(f.player,0);assert.equal(f.player.variables[1],42);assert.equal(f.player.switches[2],true);assert.equal(f.world.events.pageFor(f.player,f.entity(1)).index,1);
  assert.equal(f.world.events.pageFor({...f.player,id:'other',switches:{},variables:{}},f.entity(1)).index,0);assert.equal(f.world.events.tasks.size,0);
  assert.deepEqual(f.content.getMap(31).events[1].pages,source.pages);
});

test('DTS note-only containers, edited NPC aliases, structures and shop tags bind to real runtime entities',async()=>{
  const f=await roundFixture('dts',[
    event(1,[cmd(108,['engine_container: ammo']),cmd(0)],{note:'engine_container: medical'}),
    event(2,[cmd(108,['engine_enemy: scavenger\nenemy_id: 1']),cmd(0)],{note:'engine_npc: guard'}),
    event(3,[cmd(0)],{note:'engine_structure: barricade'}),
    event(4,[cmd(0)],{note:'engine_shop: dts-supply'})
  ]);
  assert.equal(f.entity(1).service.action,'container');assert.deepEqual(f.round.containers.get(f.entity(1).service.containerId).items,[{kind:'item',itemId:7,quantity:2},{kind:'item',itemId:13,quantity:1}]);
  assert.equal(f.entity(2).npcKey,'guard');assert.equal(f.entity(2).hp,base.gameplay.npcs.guard.hp);assert.equal(f.entity(2).enemyId,-1);
  assert.equal(f.entity(3).structureKey,'barricade');assert.equal(f.entity(3).hp,base.gameplay.structures.barricade.hp);assert.deepEqual(f.entity(4).service,{kind:'shop',shopId:'dts-supply'});
});

test('note wins same-key legacy comments and explicit NPC alias wins old enemy regardless of order',()=>{
  const raw=event(1,[cmd(108,['engine_enemy: scavenger\nengine_container: supplies']),cmd(0)],{note:'engine_enemy: patrol\nengine_npc: guard\nengine_container: medical'}),tags=eventTags(raw);
  assert.equal(tags.engine_enemy,'patrol');assert.equal(tags.engine_container,'medical');assert.equal(npcTag(tags),'guard');
  const npc={};assert.equal(configureNpc(npc,eventNotes(raw),base),true);assert.equal(npc.npcKey,'guard');
  assert.equal(npcTag(eventTags({...raw,note:'engine_npc:\nengine_container:'})), '');
  assert.equal(npcTag(eventTags({...raw,note:'<engine_npc: guard>\n<engine_container: medical>'})), 'guard');
});

for(const type of ['dts','adventure'])test(`${type} legacy combat, unsafe routes and common event scripts remain preserved but quarantined before side effects`,async()=>{
  const lists=[
    [cmd(122,[9,9,0,0,99]),cmd(355,['globalThis.__roundUnsafe = true']),cmd(0)],
    [cmd(356,['force_damage']),cmd(0)],
    [cmd(355,['$gameMap.copyEventFromMapToRegion(26, 2, 21, true);']),cmd(0)],
    [cmd(301,[0,1,false,false]),cmd(0)],
    [cmd(205,[0,{list:[{code:45,parameters:['this.act(1);']},{code:0}],wait:false}]),cmd(0)],
    [cmd(117,[1]),cmd(0)],
    [cmd(201,[0,3,1,1,2,0]),cmd(0)],
    [cmd(108,['enemy_id: 1']),cmd(0)]
  ];
  const f=await roundFixture(type,lists.map((list,index)=>event(index+1,list)),[null,{id:1,name:'Old combat',trigger:2,switchId:1,list:[cmd(122,[9,9,0,0,99]),cmd(355,['this.act(1);']),cmd(0)]}]);
  for(let id=1;id<=lists.length;id++){assert.ok(f.entity(id));assert.deepEqual(f.entity(id).pages[0].list,lists[id-1]);assert.ok(f.entity(id).pages[0].engineDisabledReason);assert.equal(f.world.events.start(f.player,f.entity(id)),false);}
  f.player.switches[1]=true;f.world.events.update(.1);assert.equal(f.player.variables[9],undefined);assert.equal(globalThis.__roundUnsafe,undefined);assert.equal(f.world.events.tasks.size,0);assert.ok(f.world.runtimeDiagnostics.size>=lists.length);
  assert.equal(f.content.getMap(31).events[1].pages[0].engineDisabledReason,undefined);
});

test('native transfers keep authored condition/dialogue/route order and safe automatic common events still run',async()=>{
  const original=event(1,[cmd(101),cmd(401,['Leaving now']),cmd(201,[0,32,2,3,2,0]),cmd(0)],{pages:[page([cmd(101),cmd(401,['Leaving now']),cmd(201,[0,32,2,3,2,0]),cmd(0)],{conditions:{switch1Valid:true,switch1Id:3},trigger:1})]});
  const content=contentFor([original],[null,{id:1,name:'Safe parallel',trigger:2,switchId:3,list:[cmd(122,[8,8,0,0,7]),cmd(121,[3,3,1]),cmd(0)]}]);
  const prepared=prepareRoundEvents(content,scenario('dts'));assert.deepEqual(prepared.getMap(31).events[1],original);assert.equal(prepared.database.CommonEvents[1].engineDisabledReason,undefined);
  const f=await roundFixture('dts',[original],content.database.CommonEvents);f.player.switches[3]=true;f.world.events.update(.1);assert.equal(f.player.variables[8],7);assert.equal(f.player.switches[3],false);
});
