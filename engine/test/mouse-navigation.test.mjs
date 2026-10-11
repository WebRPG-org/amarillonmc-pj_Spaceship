import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {loadContent} from '../server/content.mjs';
import {World} from '../server/world.mjs';

const clone=x=>structuredClone(x),directions={2:[0,1],4:[-1,0],6:[1,0],8:[0,-1]};
class Store{
  constructor(){this.states=new Map();this.operations=new Map();this.drops=new Map();}
  async listDrops(mapId){return[...this.drops.values()].filter(d=>d.mapId===mapId).map(clone);}
  async savePlayer(id,state){this.states.set(id,clone(state));}
  async commitPlayer(id,requestId,mutator){const key=`${id}:${requestId}`;if(this.operations.has(key))return{...clone(this.operations.get(key)),duplicate:true};const state=clone(this.states.get(id)),result=await mutator(state),outcome={state,result,duplicate:false};this.states.set(id,clone(state));this.operations.set(key,clone(outcome));return outcome;}
  async claimDrop({playerId,requestId,dropId,mutator}){const drop=this.drops.get(dropId);assert.ok(drop);const result=await this.commitPlayer(playerId,requestId,s=>mutator(s,drop));this.drops.delete(dropId);return{...result,drop};}
}
async function fixture(){
  const content=await loadContent(fileURLToPath(new URL('../../',import.meta.url))),store=new Store(),walls=new Set(),edges=new Set(),notices=[],services=[];let now=100000;
  const maps=new Map([1,2].map(id=>[id,{id,width:14,height:12,events:[]} ]));content.getMap=id=>maps.get(Number(id));content.findSpawn=(_id,x,y)=>({x,y});content.wrapPosition=(_id,x,y)=>({x,y});
  content.isPassable=(id,x,y,d)=>{const[dx,dy]=directions[d],nx=x+dx,ny=y+dy;return nx>=0&&ny>=0&&nx<14&&ny<12&&!walls.has(`${id}:${nx},${ny}`)&&!edges.has(`${id}:${x},${y}:${d}`);};
  const world=new World({content,store,clock:()=>now,random:()=>.5,retainDisconnected:true,hooks:{onService:(_p,event)=>services.push(event.id)}});
  const p=await world.connect({id:'mouse',username:'mouse',state:{mapId:1,x:2,y:5}},m=>notices.push(m));
  async function advance(ms=200){for(let left=ms;left>0;left-=50){now+=Math.min(left,50);world.update(.05);await Promise.resolve();for(const player of world.players.values())await player._queue;await Promise.resolve();}}
  function event(id,x,y,{list=[{code:0,parameters:[]}],trigger=0,priorityType=1,service=false}={}){const e=world.addEvent(world.maps.get(1),{id,name:`Event ${id}`,x,y,pages:[{conditions:{},trigger,priorityType,image:{characterName:'Actor1',characterIndex:0,direction:2},list}]});if(service)e.service={kind:'test'};return e;}
  function enemy(x,y){const e=event(90,x,y,{list:[{code:108,parameters:['enemy_id : 1']},{code:0,parameters:[]}]});Object.assign(e,{hp:10000,maxHp:10000,nextMove:Infinity,nextAttack:Infinity,stats:{atk:1,def:0,mat:1,mdf:0,agi:1,luk:1}});return e;}
  async function equip(mode){const profile=[...content.weaponProfiles.values()].find(w=>w.mode===mode);await world.grant(p,'weapon',profile.weaponId,1);await world.equip(p,'weapon',profile.weaponId);return profile;}
  return{world,content,store,p,walls,edges,notices,services,event,enemy,equip,advance};
}

test('mouse RPC routes around collision and cancels for keyboard, explicit cancel, and disconnect',async()=>{
  const f=await fixture();f.walls.add('1:3,5');await f.world.command(f.p,{type:'navigate',x:6,y:5});assert.ok(f.p.navigation);await f.advance(2000);assert.deepEqual([f.p.x,f.p.y],[6,5]);assert.equal(f.p.navigation,null);
  await f.world.command(f.p,{type:'navigate',x:10,y:5});await f.world.command(f.p,{type:'move',direction:8});assert.equal(f.p.navigation,null);const afterKeyboard=[f.p.x,f.p.y];await f.advance(1000);assert.deepEqual([f.p.x,f.p.y],afterKeyboard);
  await f.world.command(f.p,{type:'navigate',x:10,y:5});await f.world.command(f.p,{type:'navigate',cancel:true});const afterCancel=[f.p.x,f.p.y];await f.advance(1000);assert.deepEqual([f.p.x,f.p.y],afterCancel);
  await f.world.command(f.p,{type:'navigate',x:10,y:5});await f.world.disconnect(f.p.id);assert.equal(f.p.navigation,null);const afterDisconnect=[f.p.x,f.p.y];await f.advance(1000);assert.deepEqual([f.p.x,f.p.y],afterDisconnect);
});

test('mouse NPC interaction waits for adjacency and opens only the selected service or dialogue',async()=>{
  const f=await fixture(),npc=f.event(1,6,5,{service:true});await f.world.command(f.p,{type:'navigate',x:6,y:5,targetId:npc.id});assert.deepEqual(f.services,[]);await f.advance(2000);assert.deepEqual(f.services,[npc.id]);assert.equal(Math.abs(f.p.x-npc.x)+Math.abs(f.p.y-npc.y),1);assert.equal(f.p.navigation,null);
  const dialogue=f.event(2,6,7,{list:[{code:101,parameters:['',0,0,2]},{code:401,parameters:['Hello mouse']},{code:0,parameters:[]}]});await f.world.command(f.p,{type:'navigate',x:6,y:7,targetId:dialogue.id});await f.advance(2000);assert.ok(f.world.events.dialogues.has(f.p.id));assert.equal(f.p.navigation,null);assert.ok(f.notices.some(m=>m.type==='dialogue'&&m.text==='Hello mouse'));
});

test('mouse clicks claim an entire bag and portal clicks perform a real transfer with no leftover route',async()=>{
  const f=await fixture(),bag={id:'ground-bag',kind:'bag',itemId:0,quantity:1,mapId:1,x:5,y:5,metadata:{items:[{kind:'item',itemId:7,quantity:2},{kind:'item',itemId:13,quantity:3}]}};f.store.drops.set(bag.id,clone(bag));f.world.maps.get(1).drops.set(bag.id,clone(bag));
  await f.world.command(f.p,{type:'navigate',x:5,y:5,entityId:bag.id,requestId:'mouse-bag'});await f.advance(1800);assert.equal(f.store.drops.size,0);assert.equal(f.p.inventory.find(i=>i.kind==='item'&&i.itemId===7).quantity,2);assert.equal(f.p.inventory.find(i=>i.kind==='item'&&i.itemId===13).quantity,3);
  const portal=f.event(3,7,5,{trigger:1,list:[{code:201,parameters:[0,2,3,3,2,0]},{code:0,parameters:[]}]});await f.world.command(f.p,{type:'navigate',x:7,y:5,targetId:portal.id});await f.advance(1800);assert.deepEqual([f.p.mapId,f.p.x,f.p.y],[2,3,3]);assert.equal(f.p.navigation,null);await f.advance(1000);assert.deepEqual([f.p.mapId,f.p.x,f.p.y],[2,3,3]);
});

test('mouse targeting rejects PvE allies and pays exactly once per successful ranged attack despite cooldown clicks',async()=>{
  const f=await fixture(),friend=await f.world.connect({id:'friend',username:'friend',state:{mapId:1,x:3,y:5}},()=>{});await assert.rejects(f.world.command(f.p,{type:'navigate',x:3,y:5,targetPlayerId:friend.id}),/不可攻击/);assert.equal(friend.hp,friend.maxHp);
  const profile=await f.equip('firearm');await f.world.grant(f.p,'item',profile.ammoItemId,4);const target=f.enemy(6,5),origin=[f.p.x,f.p.y];
  await f.world.command(f.p,{type:'navigate',x:6,y:5,targetId:target.id,requestId:'mouse-shot'});await f.advance(50);await f.world.command(f.p,{type:'navigate',x:6,y:5,targetId:target.id,requestId:'cooldown-click'});await f.advance(600);
  assert.deepEqual([f.p.x,f.p.y],origin,'ranged mouse attack fires from range');assert.ok(target.hp<target.maxHp);assert.equal(f.p.inventory.find(i=>i.itemId===profile.ammoItemId&&i.kind==='item').quantity,3);assert.equal([...f.store.operations.values()].filter(o=>o.result?.attack).length,1);
});

test('mouse attacks route around a blocked edge to another valid firing position',async()=>{
  const f=await fixture(),target=f.enemy(3,5);f.edges.add('1:2,5:6');f.edges.add('1:3,5:4');
  await f.world.command(f.p,{type:'navigate',x:3,y:5,targetId:target.id,requestId:'around-wall'});await f.advance(2000);assert.ok(target.hp<target.maxHp,'an adjacent wall must not prematurely cancel an otherwise reachable attack');assert.notDeepEqual([f.p.x,f.p.y],[2,5]);
});

test('mouse club swings use the authored rhombus area without taking an unnecessary step',async()=>{
  const f=await fixture();await f.equip('club');const target=f.enemy(3,6),origin=[f.p.x,f.p.y];
  await f.world.command(f.p,{type:'navigate',x:3,y:6,targetId:target.id,requestId:'club-diagonal'});await f.advance(300);assert.ok(target.hp<target.maxHp);assert.deepEqual([f.p.x,f.p.y],origin,'diagonal neighbor is already in the club rhombus');
});

test('mouse and keyboard interaction do not manually restart parallel event pages',async()=>{
  const f=await fixture(),automatic=f.event(44,3,5,{trigger:4,list:[{code:125,parameters:[0,0,99]},{code:0,parameters:[]}]});
  // Do not advance the world clock: the parallel scheduler has not run yet.
  try{await f.world.command(f.p,{type:'navigate',x:3,y:5,targetId:automatic.id});}catch(error){assert.match(error.message,/不存在|不可|交互/);}
  await Promise.resolve();await f.p._queue;assert.equal(f.p.gold,0,'mouse click must not run an extra interactive copy');
  await f.world.command(f.p,{type:'interact',targetId:automatic.id});await f.p._queue;assert.equal(f.p.gold,0,'keyboard interaction must obey the same event trigger rules');
});
