import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.mjs';

const clone=value=>structuredClone(value);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const cmd=(code,parameters=[])=>({code,parameters,indent:0});

function createContent(){
  const map={id:1,width:10,height:10,events:[],data:Array(600).fill(0)};
  const item=(id,name)=>({id,name,params:Array(8).fill(0),effects:[],damage:{type:0,formula:'0'}});
  const recipe={id:'test-recipe',name:'Crafted',ingredients:[{kind:'item',itemId:1,amount:1}],result:{kind:'item',itemId:2,amount:1}};
  return{database:{System:{startMapId:1,startX:1,startY:1,partyMembers:[1]},Actors:[null,{id:1,name:'Hero',characterName:'Actor1',characterIndex:0,initialLevel:1,classId:1,equips:[]}],Classes:[null,{params:[100,50,10,10,10,10,10,10].map(n=>Array(100).fill(n)),learnings:[]}],Items:[null,item(1,'Ingredient'),item(2,'Crafted')],Weapons:[null],Armors:[null],Enemies:[null],Skills:[null,{id:1,name:'Attack',damage:{type:1,formula:'a.atk'}}],CommonEvents:[]},recipes:[recipe],getMap:id=>Number(id)===1?map:null,findSpawn:(id,x,y)=>({x,y}),getRecipe:id=>id===recipe.id?recipe:null,getTool:()=>null,getToolForSkill:()=>null,isPassable:()=>true,wrapPosition:(id,x,y)=>({x,y}),weaponTools:new Map()};
}

class DelayedStore {
  constructor(){this.states=new Map();this.operations=new Map();this.log=[];this.commitCount=0;this.commitGate=null;this.commitStarted=deferred();this.mapGate=null;}
  async listDrops(){if(this.mapGate)await this.mapGate.promise;return[];}
  async savePlayer(id,state){this.log.push(`save:${id}`);this.states.set(id,clone(state));}
  async commitPlayer(id,requestId,mutator){
    const key=`${id}:${requestId}`;
    if(this.operations.has(key))return{...clone(this.operations.get(key)),duplicate:true};
    const working=clone(this.states.get(id));const result=await mutator(working);this.log.push('commit:started');this.commitStarted.resolve();
    if(this.commitGate)await this.commitGate.promise;
    this.commitCount++;this.states.set(id,clone(working));const outcome={state:clone(working),result,duplicate:false};this.operations.set(key,clone(outcome));this.log.push('commit:completed');return outcome;
  }
}

async function setup(state){const store=new DelayedStore(),content=createContent(),messages=[];const world=new World({content,store,clock:()=>100000,random:()=>.5});const account={id:'account-1',username:'Test',state};const player=await world.connect(account,m=>messages.push(m));return{store,content,world,player,account,messages};}
const quantity=(state,id)=>state.inventory.find(i=>i.kind==='item'&&i.itemId===id)?.quantity||0;

test('loading legacy empty equipment slots normalizes and persists the same unequipped state',async()=>{
  for(const equips of [{},{weapon:null,armor:''},{weapon:'0',armor:0}]){
    const f=await setup({mapId:1,x:1,y:1,equips,inventory:[]});
    assert.deepEqual(f.world.snapshot(f.player).self.equips,{weapon:0,armor:0,weaponInstanceId:null});
    assert.deepEqual(f.store.states.get(f.player.id).equips,f.player.equips);
    await f.world.disconnect(f.player.id);
    const saved=clone(f.store.states.get(f.player.id));
    const restored=await f.world.connect({...f.account,state:saved},()=>{});
    assert.deepEqual(restored.equips,{weapon:0,armor:0,weaponInstanceId:null});
    assert.deepEqual(restored.inventory,[],'normalizing an empty slot does not create equipment');
  }
});

test('a queued event reward survives a delayed craft transaction and dependent commands wait',async()=>{
  const f=await setup();await f.world.grant(f.player,'item',1,2);
  f.store.commitGate=deferred();
  const crafting=f.world.craft(f.player,'test-recipe','craft-1');
  // The interaction begins before the queue's first microtask. Its grant is queued AFTER crafting.
  const event={id:'reward',eventId:1,mapId:1,pages:[{conditions:{},trigger:0,list:[cmd(125,[0,0,7]),cmd(122,[1,1,0,0,42])]}]};
  assert.equal(f.world.events.start(f.player,event),true);
  await f.store.commitStarted.promise;
  f.world.events.update(.1);
  assert.equal(f.player.gold,0);assert.equal(f.player.variables[1],undefined);assert.equal(f.player._economyBusy,true);
  f.store.commitGate.resolve();await crafting;await f.player._queue;f.world.events.update(.1);
  assert.equal(quantity(f.player,1),1);assert.equal(quantity(f.player,2),1);assert.equal(f.player.gold,7);assert.equal(f.player.variables[1],42);
  await f.world.persist(f.player);
  assert.equal(quantity(f.store.states.get(f.player.id),2),1);assert.equal(f.store.states.get(f.player.id).gold,7);
  assert.equal(f.store.commitCount,1);
});

test('a duplicate crafting request never restores its stale result snapshot over new state',async()=>{
  const f=await setup();await f.world.grant(f.player,'item',1,2);
  await f.world.craft(f.player,'test-recipe','same-request');
  await f.world.grant(f.player,'gold',0,25);await f.world.grant(f.player,'item',1,3);
  const expected=clone(f.store.states.get(f.player.id));
  await f.world.craft(f.player,'test-recipe','same-request');
  assert.equal(f.store.commitCount,1);assert.equal(f.player.gold,25);assert.equal(quantity(f.player,1),4);assert.equal(quantity(f.player,2),1);
  assert.deepEqual(f.store.states.get(f.player.id),expected);
});

test('failed event inventory saves leave no reward in the live state',async()=>{
  const f=await setup();const original=f.store.savePlayer.bind(f.store);
  f.store.savePlayer=async()=>{throw new Error('database offline');};
  await assert.rejects(f.world.grant(f.player,'item',1,4),/database offline/);
  assert.equal(quantity(f.player,1),0);
  f.store.savePlayer=original;await f.world.persist(f.player);
  assert.equal(quantity(f.store.states.get(f.player.id),1),0);
});

test('disconnect drains saves queued by an in-flight action and prevents new automatic events',async()=>{
  const f=await setup(),gate=deferred(),entered=deferred();
  f.world.maps.get(1).events.set('autorun',{id:'autorun',eventId:3,mapId:1,pages:[{conditions:{},trigger:4,list:[cmd(125,[0,0,900])]}]});
  const job=f.world.enqueue(f.player,async()=>{entered.resolve();await gate.promise;f.player.gold=7;f.world.persist(f.player);});
  await entered.promise;
  const disconnect=f.world.disconnect(f.player.id);f.world.events.update(.05);
  gate.resolve();await job;await disconnect;
  assert.equal(f.world.players.size,0);assert.equal(f.store.states.get(f.player.id).gold,7);assert.equal(f.world.events.tasks.size,0);
});

test('an attack left in the old map cannot hit targets after its owner transfers',async()=>{
  const f=await setup(),enemy={id:'enemy',enemyId:1,mapId:2,x:2,y:1,hp:100,maxHp:100,mp:0,maxMp:0,stats:{def:0},states:[]};
  f.world.maps.set(2,{id:2,events:new Map([['enemy',enemy]]),pvp:false});
  f.player.mapId=2;
  f.world.resolveAttack({source:f.player,mapId:1,x:1,y:1,dx:1,dy:0,range:1,area:'front',activeAt:0,hit:new Map(),skill:f.content.database.Skills[1]});
  assert.equal(enemy.hp,100);
});

test('concurrent connections for the same account permit exactly one authoritative player',async()=>{
  const store=new DelayedStore();store.mapGate=deferred();const world=new World({content:createContent(),store,clock:()=>100000});const account={id:'same-account',username:'Same'};
  const results=Promise.allSettled([world.connect(account,()=>{}),world.connect(account,()=>{})]);store.mapGate.resolve();
  const settled=await results;assert.equal(settled.filter(r=>r.status==='fulfilled').length,1);assert.equal(settled.filter(r=>r.status==='rejected').length,1);
  assert.equal(world.players.size,1);assert.equal(world.connecting.size,0);assert.equal(store.log.filter(x=>x==='save:same-account').length,1);
});

test('permanent event parameter growth survives recalculation, save and reconnect',async()=>{
  const f=await setup();const base=f.player.stats.atk;
  const event={id:'growth',eventId:1,mapId:1,pages:[{conditions:{},trigger:0,list:[cmd(317,[0,1,2,0,0,5])]}]};
  f.world.events.start(f.player,event);assert.equal(f.player.paramPlus[2],5);assert.equal(f.player.stats.atk,base+5);
  f.world.recalculate(f.player);assert.equal(f.player.stats.atk,base+5);
  await f.world.persist(f.player);await f.world.disconnect(f.player.id);
  const saved=clone(f.store.states.get(f.account.id));assert.equal(saved.paramPlus[2],5);
  const restored=await f.world.connect({...f.account,state:saved},()=>{});
  assert.equal(restored.paramPlus[2],5);assert.equal(restored.stats.atk,base+5);
});
