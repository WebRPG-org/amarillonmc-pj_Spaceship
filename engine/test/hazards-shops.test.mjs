import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {World} from '../server/world.mjs';

const clone=structuredClone;
class Store {
  states=new Map();ops=new Map();drops=new Map();worldOps=new Map();
  async savePlayer(id,state){this.states.set(id,clone(state));}
  async loadPlayer(id){return {id,state:clone(this.states.get(id))};}
  async listDrops(mapId){return [...this.drops.values()].filter(d=>d.mapId===mapId).map(clone);}
  async commitPlayer(id,requestId,mutator){const key=`${id}:${requestId}`;if(this.ops.has(key))return{...clone(this.ops.get(key)),duplicate:true};const state=clone(this.states.get(id)),result=await mutator(state);if(this.fail)throw new Error('write failed');this.states.set(id,clone(state));const out={state,result,duplicate:false};this.ops.set(key,clone(out));return out;}
  async createDrops({playerId,requestId,drops,mutator}){const out=await this.commitPlayer(playerId,requestId,mutator);if(out.duplicate)return{...out,drops:[]};const rows=drops.map(d=>({...clone(d),id:randomUUID()}));for(const d of rows)this.drops.set(d.id,d);return{...out,drops:rows};}
  async createWorldDrops({requestId,drops}){if(this.failWorld)throw new Error('world write failed');if(this.worldOps.has(requestId))return{duplicate:true,drops:clone(this.worldOps.get(requestId))};const rows=drops.map(d=>({...clone(d),id:randomUUID()}));this.worldOps.set(requestId,rows);for(const d of rows)this.drops.set(d.id,d);return{duplicate:false,drops:rows};}
  async claimDrop({playerId,requestId,dropId,mutator}){const drop=this.drops.get(dropId);if(!drop)throw new Error('drop missing');const out=await this.commitPlayer(playerId,requestId,state=>mutator(state,drop));this.drops.delete(dropId);return{...out,drop};}
}
function rawEvent(id,x,y,note=''){return{id,x,y,note,name:'event',pages:[{conditions:{},trigger:0,priorityType:1,image:{characterName:'Actor1',characterIndex:0},list:[{code:0,parameters:[]}]}]};}
async function fixture(){
  let time=100000;const maps=[1,2,3].map(id=>({id,width:20,height:20,events:[],data:Array(2400).fill(0)}));
  const items=[null,{id:1,name:'水',params:Array(8).fill(0)}],weapons=Array(66).fill(null);weapons[65]={id:65,name:'飞火流星',params:Array(8).fill(0)};
  const content={database:{System:{startMapId:1,startX:5,startY:5,partyMembers:[1]},Actors:[null,{characterName:'Actor1',characterIndex:0,initialLevel:1,classId:1,equips:[]}],Classes:[null,{params:[1000,100,10,10,10,10,10,10].map(n=>Array(100).fill(n)),learnings:[]}],Items:items,Weapons:weapons,Armors:[null],Enemies:[null],Skills:[null,{id:1,damage:{type:1,formula:'a.atk'}}],CommonEvents:[]},weaponProfiles:new Map(),weaponTools:new Map(),getMap:id=>maps.find(m=>m.id===Number(id)),findSpawn:(_id,x,y)=>({x,y}),wrapPosition:(_id,x,y)=>({x,y}),isPassable:()=>true,getTool:()=>null,getToolForSkill:()=>null,
    gameplay:{npcs:{test:{name:'独立NPC',hp:120,mp:0,stats:{atk:10,def:5},gold:13,exp:8,drops:[{kind:'item',itemId:1,quantity:2,chance:1}],respawnMs:0}},structures:{barricade:{hp:300}},shops:{test:{name:'补给',goods:[{kind:'item',itemId:1,price:10},{kind:'weapon',itemId:65,price:100}],sellRate:.5}}}};
  const store=new Store(),messages=[],world=new World({content,store,clock:()=>time,random:()=>.5});
  world.scenario={type:'adventure',outdoorMapIds:[1,3],allowedTitles:['meteor'],meteor:{intervalMs:5000,warningMs:1000,damage:400},meteorWeapon:{delayMs:10000,mpMultiplier:8}};
  const player=await world.connect({id:1,username:'caster'},m=>messages.push(m));
  const advance=ms=>{time+=ms;world.update(ms/1000);};
  const npc=(x,y,note='engine_npc:test')=>{const e=world.addEvent(world.maps.get(1),rawEvent(world.maps.get(1).events.size+1,x,y,note));e._eventRouteOwner=true;return e;};
  const equip=async()=>{await world.grant(player,'weapon',65,1);await world.equip(player,'weapon',65);};
  const drain=async()=>{await Promise.all([...world.players.values()].map(p=>p._queue));await Promise.all([...world.pendingWorldDrops.values()].map(p=>p.running));};
  return{world,player,store,content,messages,advance,npc,equip,drain};
}

test('outdoor weather fixes a nine-cell warning, then hits NPCs and structures even after the player leaves the map',async()=>{
  const f=await fixture(),npc=f.npc(6,6),outside=f.npc(7,5),wall=f.npc(4,4,'engine_structure:barricade');
  assert.equal(npc.npcKey,'test');assert.equal(npc.enemyId,-1);assert.equal(f.world.canMove({...f.player,x:4,y:5},8),false);
  f.advance(4999);assert.equal(f.world.hazards.snapshot(1).length,0);
  f.advance(1);const warning=f.world.snapshot(f.player).hazards[0];assert.deepEqual([warning.x,warning.y,warning.radius],[5,5,1]);
  await f.world.transfer(f.player,2,5,5);f.advance(999);assert.equal(npc.hp,120);
  f.advance(1);await f.drain();assert.equal(npc.dead,true);assert.equal(wall.erased,true);assert.equal(outside.hp,120);assert.equal(f.player.hp,1000);
  assert.equal(f.world.canMove({...f.player,mapId:1,x:4,y:5},8),true);
  assert.equal(f.store.worldOps.size,1);assert.equal(f.player.gold,0);assert.equal(f.player.exp,0);
  const drops=[...f.store.drops.values()];assert.equal(drops.find(d=>d.kind==='gold').quantity,13);assert.equal(drops.find(d=>d.kind==='item').quantity,2);
  await f.world.transfer(f.player,1,6,6);await f.world.pickup(f.player,drops.find(d=>d.kind==='gold').id,'coins');assert.equal(f.player.gold,13);
});

test('weather never targets an indoor player and retains its five-second rhythm',async()=>{
  const f=await fixture();await f.world.transfer(f.player,2,5,5);f.advance(5000);assert.equal(f.world.hazards.strikes.size,0);
  await f.world.transfer(f.player,1,3,3);f.advance(4999);assert.equal(f.world.hazards.strikes.size,0);f.advance(1);assert.equal(f.world.hazards.strikes.size,1);
  f.player.x=8;f.advance(1000);assert.equal(f.player.hp,1000);await f.drain();
});

test('meteor weapon pays all MP once and hits self, friends and NPC diagonals at the ten-second position in PvE',async()=>{
  const f=await fixture();delete f.world.scenario.meteor;await f.equip();
  const friend=await f.world.connect({id:2,username:'friend'},()=>{});friend.x=9;friend.y=9;const npc=f.npc(7,7),outside=f.npc(10,8);npc.hp=npc.maxHp=1000;
  f.player.mp=20;assert.equal(await f.world.attack(f.player,1,'meteor'),true);assert.equal(f.player.mp,0);assert.equal(f.world.hazards.channels.size,1);
  f.player.mp=10;await assert.rejects(f.world.attack(f.player,305,'overlap'),/引导中/);assert.equal(f.player.mp,10);
  f.player.x=8;f.player.y=8;f.advance(9999);assert.equal(f.player.hp,1000);f.advance(1);await f.drain();
  assert.equal(f.player.hp,840);assert.equal(friend.hp,840);assert.equal(npc.hp,840);assert.equal(outside.hp,120);assert.equal(f.world.hazards.channels.size,0);
  assert.equal(await f.world.attack(f.player,305,'meteor'),false);assert.equal(f.player.mp,10);assert.equal(f.world.hazards.channels.size,0);
  assert.equal(await f.world.attack(f.player,305,'again'),true);assert.equal(f.player.mp,0);
});

test('meteor weapon cannot be spoofed, used indoors or in an unsupported scenario; failed payment has no channel',async()=>{
  const f=await fixture();delete f.world.scenario.meteor;
  await assert.rejects(f.world.attack(f.player,305,'spoof'),/装备/);await f.equip();
  await f.world.transfer(f.player,2,5,5);await assert.rejects(f.world.attack(f.player,305,'indoor'),/室外/);assert.equal(f.player.mp,100);
  await f.world.transfer(f.player,1,5,5);f.world.scenario.allowedTitles=[];await assert.rejects(f.world.attack(f.player,305,'unsupported'),/不支持/);
  f.world.scenario.allowedTitles=['meteor'];f.store.fail=true;await assert.rejects(f.world.attack(f.player,305,'failed'),/write failed/);assert.equal(f.player.mp,100);assert.equal(f.world.hazards.channels.size,0);
});

test('entering indoors, death and leaving an instance cancel meteor with no MP refund or delayed impact',async()=>{
  for(const action of ['indoor','death','leave']){
    const f=await fixture();delete f.world.scenario.meteor;await f.equip();f.player.mp=20;await f.world.attack(f.player,305,action);
    if(action==='indoor')await f.world.transfer(f.player,2,5,5);
    if(action==='death'){f.world.kill(f.player,null);await f.drain();}
    if(action==='leave')await f.world.detach(f.player.id);
    assert.equal(f.world.hazards.channels.size,0);assert.equal(f.player.mp,0);f.advance(10000);await f.drain();assert.equal(f.messages.filter(m=>m.type==='effect'&&m.kind==='meteor').length,0);
    if(action==='indoor')assert.ok(f.messages.some(m=>m.message?.includes('已进入室内')));
  }
});

test('environment drops retry with one durable identity after failure and never reward an unrelated player',async()=>{
  const f=await fixture(),npc=f.npc(6,5);f.store.failWorld=true;f.world.kill(npc,null);await f.drain();assert.equal(f.world.pendingWorldDrops.size,1);assert.equal(f.store.drops.size,0);
  f.store.failWorld=false;delete f.world.scenario.meteor;f.advance(5000);await f.drain();assert.equal(f.world.pendingWorldDrops.size,0);assert.equal(f.store.worldOps.size,1);assert.equal(f.store.drops.size,2);assert.equal(f.player.gold,0);
});

test('shop buy and sell use the current world wallet, reject remote/forged pricing and preserve duplicate state',async()=>{
  const f=await fixture();delete f.world.scenario.meteor;const event=f.world.addEvent(f.world.maps.get(1),rawEvent(1,5,6));event.service={kind:'shop',shopId:'test'};
  await f.world.grant(f.player,'gold',0,100);f.world.interact(f.player,event.id);assert.equal(f.messages.at(-1).type,'shop');
  const command={type:'shop',shopId:'test',eventId:event.id,action:'buy',kind:'item',itemId:1,quantity:2,price:0,requestId:'buy'};
  await f.world.command(f.player,command);assert.equal(f.player.gold,80);assert.equal(f.player.inventory.find(i=>i.kind==='item').quantity,2);
  await f.world.grant(f.player,'gold',0,5);await f.world.command(f.player,command);assert.equal(f.player.gold,85);
  await f.world.command(f.player,{...command,action:'sell',quantity:1,requestId:'sell'});assert.equal(f.player.gold,90);assert.equal(f.player.inventory.find(i=>i.kind==='item').quantity,1);
  f.player.x=10;await assert.rejects(f.world.command(f.player,{...command,requestId:'remote'}),/靠近/);assert.equal(f.player.gold,90);
  f.player.x=5;await assert.rejects(f.world.command(f.player,{...command,itemId:99,requestId:'unlisted'}),/不交易/);assert.equal(f.player.gold,90);
  await assert.rejects(f.world.command(f.player,{...command,quantity:99,requestId:'expensive'}),/金币不足/);assert.equal(f.player.gold,90);
});

test('lost shop COMMIT response recovers authoritative coins and items before save or replay',async()=>{
  const f=await fixture();delete f.world.scenario.meteor;const event=f.world.addEvent(f.world.maps.get(1),rawEvent(1,5,6));event.service={kind:'shop',shopId:'test'};
  await f.world.grant(f.player,'gold',0,100);
  const original=f.store.commitPlayer.bind(f.store);let lose=true;
  f.store.commitPlayer=async(...args)=>{const result=await original(...args);if(lose){lose=false;throw Object.assign(new Error('lost COMMIT response'),{economyUncertain:true});}return result;};
  const message={type:'shop',shopId:'test',eventId:event.id,action:'buy',kind:'item',itemId:1,quantity:2,requestId:'lost-buy'};
  await assert.rejects(f.world.command(f.player,message),/lost COMMIT/);assert.equal(f.player.gold,80);assert.equal(f.player.inventory.find(i=>i.kind==='item').quantity,2);
  await f.world.persist(f.player);await f.world.command(f.player,message);assert.equal(f.player.gold,80);assert.equal(f.store.states.get(f.player.id).gold,80);assert.equal(f.player.inventory.find(i=>i.kind==='item').quantity,2);
});

test('lost meteor COMMIT response cannot restore spent MP or start a duplicated delayed strike',async()=>{
  const f=await fixture();delete f.world.scenario.meteor;await f.equip();f.player.mp=20;
  const original=f.store.commitPlayer.bind(f.store);let lose=true;
  f.store.commitPlayer=async(...args)=>{const result=await original(...args);if(lose){lose=false;throw Object.assign(new Error('lost COMMIT response'),{economyUncertain:true});}return result;};
  await assert.rejects(f.world.attack(f.player,305,'lost-meteor'),/lost COMMIT/);assert.equal(f.player.mp,0);assert.equal(f.world.hazards.channels.size,0);
  f.player.mp=20;await f.world.persist(f.player);assert.equal(await f.world.attack(f.player,305,'lost-meteor'),false);assert.equal(f.player.mp,20);assert.equal(f.world.hazards.channels.size,0);
});

test('death and leaving during an in-flight MP payment cannot publish a late meteor channel',async()=>{
  for(const action of ['death','leave','indoor']){
    const f=await fixture();delete f.world.scenario.meteor;await f.equip();f.player.mp=20;
    let entered,release;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;}),original=f.store.commitPlayer.bind(f.store);
    f.store.commitPlayer=async(...args)=>{const result=await original(...args);entered();await gate;return result;};
    const attack=f.world.attack(f.player,305,`pending-${action}`);await started;
    let completion;if(action==='death')f.world.kill(f.player,null);else completion=action==='leave'?f.world.detach(f.player.id):f.world.transfer(f.player,2,5,5);
    release();const fired=await attack;await completion;await f.drain();
    if(action!=='indoor')assert.equal(fired,false);
    assert.equal(f.player.mp,0);assert.equal(f.world.hazards.channels.size,0);f.advance(10000);await f.drain();assert.equal(f.messages.filter(m=>m.kind==='meteor').length,0);
  }
});

test('disconnect retains an already-paid channel only when the character stays in the instance',async()=>{
  for(const retainDisconnected of [false,true]){
    const f=await fixture();delete f.world.scenario.meteor;f.world.retainDisconnected=retainDisconnected;await f.equip();f.player.mp=20;
    let entered,release;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;}),original=f.store.commitPlayer.bind(f.store);
    f.store.commitPlayer=async(...args)=>{const result=await original(...args);entered();await gate;return result;};
    const attack=f.world.attack(f.player,305,`disconnect-${retainDisconnected}`);await started;const disconnected=f.world.disconnect(f.player.id);release();await attack;await disconnected;
    assert.equal(f.world.hazards.channels.size,retainDisconnected?1:0);assert.equal(f.player.mp,0);f.advance(10000);await f.drain();assert.equal(f.player.hp,retainDisconnected?840:1000);
  }
});

test('pointing at a distant NPC with the meteor weapon starts its self channel without walking into melee',async()=>{
  const f=await fixture();delete f.world.scenario.meteor;await f.equip();f.player.mp=20;const npc=f.npc(15,15);
  f.world.navigation.set(f.player,{x:npc.x,y:npc.y,targetId:npc.id,requestId:'point-meteor'});
  await Promise.resolve();await f.player._queue;
  assert.deepEqual([f.player.x,f.player.y],[5,5]);assert.equal(f.world.hazards.channels.size,1);assert.equal(f.player.mp,0);
});

test('authored shop tags take precedence over positional binding and scopes cannot leak into another world',async()=>{
  for(const type of [null,'dts','adventure']){
    const f=await fixture();f.world.scenario=type?{type}:null;
    const base=f.content.gameplay.shops.test;
    f.content.gameplay.shops={tagged:{...base},fallback:{...base,mapId:3,eventId:1},world:{...base,scope:'world',mapId:3,eventId:2},dts:{...base,scope:'dts',mapId:3,eventId:3}};
    f.content.getMap(3).events=[rawEvent(1,5,6,'engine_shop:tagged'),rawEvent(2,6,6),rawEvent(3,7,6),rawEvent(4,8,6,'engine_shop:world'),rawEvent(5,9,6,'engine_shop:dts')];
    const map=await f.world.ensureMap(3),event=id=>[...map.events.values()].find(e=>e.eventId===id);
    assert.equal(event(1).service.shopId,'tagged');
    assert.equal(!!event(2).service,!type);assert.equal(!!event(4).service,!type);
    assert.equal(!!event(3).service,type==='dts');assert.equal(!!event(5).service,type==='dts');
    if(type){event(4).service={kind:'shop',shopId:'world'};f.player.mapId=3;f.player.x=8;f.player.y=5;assert.throws(()=>f.world.interact(f.player,event(4).id),/当前世界不可用/);}
  }
});
