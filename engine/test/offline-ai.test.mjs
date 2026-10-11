import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {World} from '../server/world.mjs';
import {Round} from '../server/rounds.mjs';
import {loadContent} from '../server/content.mjs';
import {hasLineOfSight,normalizeOfflineBehavior} from '../server/offline-ai.mjs';

const clone=x=>structuredClone(x),dist=(a,b)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
class MemoryStore{
  constructor(){this.states=new Map();this.drops=new Map();this.claims=new Set();this.claimed=0;this.queue=Promise.resolve();this.ops=new Map();}
  forRound(){return this;}
  async savePlayer(id,state){this.states.set(id,clone(state));}
  async loadPlayer(id){return{id,username:id,state:clone(this.states.get(id))};}
  async listDrops(mapId){return[...this.drops.values()].filter(d=>d.mapId===mapId).map(clone);}
  serial(fn){const p=this.queue.then(fn);this.queue=p.catch(()=>{});return p;}
  commitPlayer(id,requestId,mutator){return this.serial(async()=>{const key=`${id}:${requestId}`;if(this.ops.has(key))return{...clone(this.ops.get(key)),duplicate:true};const state=clone(this.states.get(id)),result=await mutator(state),outcome={state,result,duplicate:false};this.states.set(id,clone(state));this.ops.set(key,clone(outcome));return outcome;});}
  claimDrop({playerId,dropId,mutator}){return this.serial(async()=>{const drop=this.drops.get(dropId);if(!drop)throw new Error('already claimed');const state=clone(this.states.get(playerId));await mutator(state,drop);this.states.set(playerId,clone(state));this.drops.delete(dropId);this.claimed++;return{state,drop,duplicate:false};});}
  claimContainer({playerId,containerId,mutator}){return this.serial(async()=>{const state=clone(this.states.get(playerId));if(this.claims.has(containerId))return{state,claimed:false,claimedBy:'other'};await mutator(state);this.states.set(playerId,clone(state));this.claims.add(containerId);return{state,claimed:true,claimedBy:playerId};});}
  createDrops({playerId,drops,mutator}){return this.serial(async()=>{const state=clone(this.states.get(playerId));await mutator(state);this.states.set(playerId,clone(state));const made=drops.map((d,i)=>({...d,id:`drop-${this.drops.size}-${i}`}));for(const d of made)this.drops.set(d.id,clone(d));return{state,drops:made};});}
}
function tinyContent(){
  const maps=new Map([1,2].map(id=>[id,{id,width:20,height:16,events:[]}])),blocked=new Set();
  const item=id=>({id,name:`Item${id}`,params:Array(8).fill(0),effects:[],damage:{type:0,formula:'0'}});
  const c={blocked,database:{System:{startMapId:1,startX:5,startY:5,partyMembers:[1]},Actors:[null,{id:1,name:'Hero',characterName:'Actor1',classId:1,initialLevel:1,equips:[]}],Classes:[null,{params:[100,50,20,5,20,5,10,10].map(n=>Array(100).fill(n)),learnings:[]}],Items:[null,item(1),item(2)],Weapons:[null],Armors:[null],Enemies:[null,{id:1,name:'Threat',params:[1000,0,5,0,0,0,0,0],dropItems:[]}],Skills:[null,{id:1,name:'Attack',scope:1,hitType:0,successRate:100,damage:{type:1,formula:'a.atk',variance:0},effects:[]}],CommonEvents:[]},getMap:id=>maps.get(+id),findSpawn:(id,x,y)=>({x,y}),getTool:()=>null,getToolForSkill:()=>null,weaponTools:new Map(),wrapPosition:(id,x,y)=>({x,y}),isPassable:(id,x,y,d)=>{const[dx,dy]={2:[0,1],4:[-1,0],6:[1,0],8:[0,-1]}[d],p={x:x+dx,y:y+dy};return p.x>=0&&p.y>=0&&p.x<20&&p.y<16&&!blocked.has(`${id}:${p.x},${p.y}`)&&!blocked.has(`${id}:${x},${y}`);}};return c;
}
async function fixture(real=false){
  const content=real?await loadContent(fileURLToPath(new URL('../../',import.meta.url))):tinyContent(),store=new MemoryStore();let now=100000,round;
  const world=real?(round=new Round({id:'offline-test',content,store,host:{},clock:()=>now,random:()=>.5})).world:new World({content,store,clock:()=>now,random:()=>.5,retainDisconnected:true});
  if(round){round.status='active';world.paused=false;for(const id of round.scenario.mapIds)await world.ensureMap(id);}
  async function player(id='a',behavior='stay'){const state=round?round.seed(world.defaultState()):undefined,p=await world.connect({id,username:id,state},()=>{});p.offlineBehavior=behavior;return p;}
  async function advance(ms=200){for(let left=ms;left>0;left-=50){now+=Math.min(left,50);world.update(Math.min(left,50)/1000);await Promise.resolve();for(const p of world.players.values())await p._queue;await Promise.resolve();}}
  function enemy(x,y){const map=world.maps.get(1),e=world.addEvent(map,{id:90,name:'Threat',x,y,pages:[{conditions:{},trigger:0,priorityType:1,image:{characterName:'Monster',characterIndex:0},list:[{code:108,parameters:['enemy_id : 1']}]}]});e.nextMove=Infinity;e.nextAttack=Infinity;return e;}
  function drop(mapId,x,y,metadata={items:[{kind:'item',itemId:1,quantity:3},{kind:'item',itemId:2,quantity:2}]}){const d={id:'bag',kind:'bag',itemId:0,quantity:1,mapId,x,y,metadata};store.drops.set(d.id,clone(d));world.maps.get(mapId).drops.set(d.id,clone(d));return d;}
  return{world,content,store,round,player,advance,enemy,drop};
}

test('offline preferences are bounded, stay remains vulnerable, and paused/dead characters never run AI',async()=>{
  assert.equal(normalizeOfflineBehavior('hunt'),'hunt');assert.equal(normalizeOfflineBehavior('teleport'),'stay');
  const f=await fixture(),p=await f.player('a','stay'),start={x:p.x,y:p.y};await f.world.disconnect(p.id);f.world.maps.get(1).zone={startsAt:0,endsAt:999999,damage:7};await f.advance(1000);assert.equal(p.hp,93);assert.deepEqual({x:p.x,y:p.y},start);
  p.offlineBehavior='search';f.drop(1,p.x+4,p.y);f.world.paused=true;await f.advance(1000);assert.deepEqual({x:p.x,y:p.y},start);assert.equal(f.store.claimed,0);
  f.world.paused=false;p.dead=true;await f.advance(1000);assert.deepEqual({x:p.x,y:p.y},start);assert.equal(f.store.claimed,0);
});

test('evasion uses collision-aware movement and reconnection cancels the plan immediately',async()=>{
  const f=await fixture(),p=await f.player('a','evade'),enemy=f.enemy(p.x+2,p.y),initial=dist(p,enemy);await f.advance(1000);assert.equal(dist(p,enemy),initial,'connected players retain control');
  await f.world.disconnect(p.id);await f.advance(800);assert.ok(dist(p,enemy)>initial);assert.equal(p.hp,100);
  const resumed=await f.world.reconnect(p.id,()=>{}),position={x:p.x,y:p.y};assert.equal(resumed,p);assert.equal(p.offlineActivity,null);assert.equal(f.world.offlineAI.states.has(p.id),false);await f.advance(1200);assert.deepEqual({x:p.x,y:p.y},position);
});

test('hunt respects PvE immunity and walls, while normal PvP attacks apply in a PvP map',async()=>{
  const f=await fixture(),hunter=await f.player('hunter','hunt'),friend=await f.player('friend');friend.x=hunter.x+1;await f.world.disconnect(hunter.id);await f.advance(800);assert.equal(friend.hp,100);
  const enemy=f.enemy(hunter.x,hunter.y+2);f.content.blocked.add(`1:${hunter.x},${hunter.y+1}`);assert.equal(hasLineOfSight(f.world,hunter,enemy),false);await f.advance(800);assert.equal(enemy.hp,1000);
  f.content.blocked.clear();await f.advance(1600);assert.ok(enemy.hp<1000,'uses regular attacks against a visible monster');assert.equal(friend.hp,100);
  enemy.erased=true;friend.x=hunter.x+1;friend.y=hunter.y;f.world.maps.get(1).pvp=true;await f.advance(1200);assert.ok(friend.hp<100,'only PvP targets can be hunted');
});

test('search walks to a bag and claims all stacks exactly once through the normal transaction',async()=>{
  const f=await fixture(),p=await f.player('a','search');f.drop(1,p.x+4,p.y);await f.world.disconnect(p.id);await f.advance(2400);assert.equal(f.store.claimed,1);assert.equal(f.world.maps.get(1).drops.size,0);assert.deepEqual(p.inventory,[{kind:'item',itemId:1,quantity:3},{kind:'item',itemId:2,quantity:2}]);assert.ok(p.x>5);await f.advance(1000);assert.equal(f.store.claimed,1);
});

test('real round exploration opens shared authored supply services and then travels existing map portals',async()=>{
  const f=await fixture(true),p=await f.player('a','search'),startMap=p.mapId;await f.world.disconnect(p.id);
  for(let i=0;i<300&&p.mapId===startMap;i++)await f.advance(200);
  assert.ok(f.store.claims.has('village'),'real supply container is claimed');assert.ok(p.inventory.some(i=>i.itemId===47&&i.quantity===2));assert.notEqual(p.mapId,startMap,'search proceeds through a real transfer event');assert.ok(f.round.scenario.mapIds.includes(p.mapId));
});

test('real round forbidden-area evasion exits through a portal without teleporting or running legacy autoruns',async()=>{
  const f=await fixture(true),p=await f.player('a','evade'),start={mapId:p.mapId,x:p.x,y:p.y};f.world.maps.get(p.mapId).zone={startsAt:130000,endsAt:999999,damage:8};await f.world.disconnect(p.id);
  await f.advance(200);assert.equal(p.mapId,start.mapId);assert.ok(dist(p,start)<=1,'one tick cannot jump to an exit');
  for(let i=0;i<300&&p.mapId===start.mapId;i++)await f.advance(200);
  assert.notEqual(p.mapId,start.mapId);assert.ok(!f.world.maps.get(p.mapId).zone);assert.equal(p.hp,p.maxHp,'left before forbidden area activated');assert.equal(f.world.events.dialogues.size,0);assert.equal(f.world.events.tasks.size,0);
});

test('offline ranged hunting pays real ammunition, durability and MP costs and stops at depletion',async()=>{
  for(const mode of ['throw','firearm','staff']){
    const f=await fixture(true),p=await f.player('a','hunt'),profile=[...f.content.weaponProfiles.values()].find(w=>w.mode===mode);assert.ok(profile,`missing ${mode} weapon`);
    await f.world.grant(p,'weapon',profile.weaponId,1);await f.world.equip(p,'weapon',profile.weaponId);
    const weapon=p.inventory.find(i=>i.instanceId===p.equips.weaponInstanceId);
    if(mode==='throw')weapon.durability=profile.durabilityCost*2;
    if(mode==='firearm')await f.world.grant(p,'item',profile.ammoItemId,profile.ammoCost*2);
    if(mode==='staff')p.mp=profile.mpCost*2;
    const map=f.world.maps.get(p.mapId),target=f.world.addEvent(map,{id:99003,name:'Target',x:p.x+2,y:p.y,pages:[{conditions:{},trigger:0,priorityType:1,image:{characterName:'Monster'},list:[{code:108,parameters:['enemy_id : 1']}]}]});
    Object.assign(target,{hp:100000,maxHp:100000,nextMove:Infinity,nextAttack:Infinity,stats:{atk:1,def:0,mat:1,mdf:0,agi:1,luk:1}});assert.equal(hasLineOfSight(f.world,p,target),true);
    const initialDurability=weapon.durability;await f.world.disconnect(p.id);await f.advance(4000);
    const paid=[...f.store.ops.values()].filter(o=>o.result?.attack);assert.equal(paid.length,2,`${mode} cannot attack for free after resources run out`);assert.ok(target.hp<target.maxHp,`${mode} projectile actually hits`);
    const remaining=p.inventory.find(i=>i.instanceId===p.equips.weaponInstanceId);
    if(profile.durabilityCost)assert.equal(remaining.durability,initialDurability-profile.durabilityCost*2);
    if(mode==='firearm')assert.equal(p.inventory.find(i=>i.kind==='item'&&i.itemId===profile.ammoItemId)?.quantity||0,0);
    if(mode==='staff')assert.equal(p.mp,0);
    await f.world.reconnect(p.id,()=>{});await f.advance(1000);assert.equal([...f.store.ops.values()].filter(o=>o.result?.attack).length,2);
  }
});
