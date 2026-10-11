import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {loadContent} from '../server/content.mjs';
import {GameHost} from '../server/instances.mjs';
import {DIRECTIONS} from '../server/world.mjs';

const clone=x=>structuredClone(x);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
class MemoryScope {
  constructor(){this.states=new Map();this.ops=new Map();this.drops=new Map();this.containers=new Map();this.queue=Promise.resolve();this.closed=false;}
  serial(fn){const p=this.queue.then(fn);this.queue=p.catch(()=>{});return p;}
  async listDrops(mapId){return[...this.drops.values()].filter(d=>d.mapId===mapId).map(clone);}
  async loadPlayer(id){return{id,username:id,state:clone(this.states.get(id)||{})};}
  async savePlayer(id,state){if(this.closed)throw new Error('ROUND_CLOSED');this.states.set(id,clone(state));}
  commitPlayer(id,requestId,mutator){return this.serial(async()=>{
    const key=`${id}:${requestId}`;if(this.ops.has(key))return{...clone(this.ops.get(key)),duplicate:true};if(this.closed)throw new Error('ROUND_CLOSED');
    const state=clone(this.states.get(id)),result=await mutator(state);this.states.set(id,clone(state));const outcome={state,result,duplicate:false};this.ops.set(key,clone(outcome));return outcome;
  });}
  createDrops({playerId,requestId,drops,mutator}){return this.serial(async()=>{
    const key=`${playerId}:${requestId}`;if(this.ops.has(key))return{...clone(this.ops.get(key)),duplicate:true};if(this.closed)throw new Error('ROUND_CLOSED');
    const state=clone(this.states.get(playerId)),result=await mutator(state),created=drops.map((d,i)=>({...clone(d),id:`${key}:${i}`}));
    this.states.set(playerId,clone(state));for(const d of created)this.drops.set(d.id,clone(d));const outcome={state,result,drops:created,duplicate:false};this.ops.set(key,clone(outcome));return outcome;
  });}
  claimDrop({playerId,requestId,dropId,mutator}){return this.serial(async()=>{
    const key=`${playerId}:${requestId}`;if(this.ops.has(key))return{...clone(this.ops.get(key)),duplicate:true};const drop=this.drops.get(dropId);if(!drop)throw new Error('物品已被拾取');
    const state=clone(this.states.get(playerId)),result=await mutator(state,clone(drop));this.states.set(playerId,clone(state));this.drops.delete(dropId);const outcome={state,result,drop:clone(drop),duplicate:false};this.ops.set(key,clone(outcome));return outcome;
  });}
  claimContainer({playerId,containerId,mutator}){return this.serial(async()=>{const previous=this.containers.get(containerId);if(previous)return{state:clone(this.states.get(playerId)),claimed:false,duplicate:true,claimedBy:previous};const state=clone(this.states.get(playerId)),result=await mutator(state);this.states.set(playerId,clone(state));this.containers.set(containerId,playerId);return{state,result,claimed:true,duplicate:false,claimedBy:playerId};});}
}
class MemoryStore extends MemoryScope {
  constructor(){super();this.rounds=new Map();this.profiles=new Map();this.finishes=0;this.aborts=0;}
  async abortUnfinishedRounds(){this.aborts++;return[];}
  async loadProfile(id){return clone(this.profiles.get(id)||{});}
  async createRound(data){const r={...data,status:'waiting',scope:new MemoryScope(),members:new Map()};this.rounds.set(data.id,r);return r;}
  forRound(id){return this.rounds.get(id).scope;}
  async updateRound(id,patch){Object.assign(this.rounds.get(id),patch);}
  async joinRound(id,playerId,state){const r=this.rounds.get(id);await r.scope.savePlayer(playerId,state);r.members.set(playerId,'active');return{id:playerId,username:playerId,state:clone(state)};}
  async leaveRound(id,playerId,result){const r=this.rounds.get(id);r.members.set(playerId,'left');return{result};}
  async finishRound(id,result){const r=this.rounds.get(id);if(r.status==='finished')return{result:r.result,duplicate:true};r.status='finished';r.result=clone(result);r.scope.closed=true;this.finishes++;return{result,duplicate:false};}
}
async function fixture(){
  const content=await loadContent(fileURLToPath(new URL('../../',import.meta.url))),store=new MemoryStore(),messages=new Map();let time=100000;
  const host=new GameHost({content,store,clock:()=>time,random:()=>.5});await host.init();
  const rawCommand=host.command.bind(host);host.command=(player,message)=>rawCommand(player,{contextInstanceId:host.locations.get(player.id)?.id||null,...message});
  async function connect(id){messages.set(id,[]);const account=await store.loadPlayer(id);return host.connect(account,m=>messages.get(id).push(m));}
  async function advance(ms=150){for(let left=ms;left>0;left-=50){time+=Math.min(left,50);host.update(Math.min(left,50)/1000);await Promise.resolve();}for(const p of host.players.values())await p._queue;}
  return{host,content,store,messages,connect,advance};
}
const qty=(p,id)=>p.inventory.filter(i=>i.kind==='item'&&i.itemId===id).reduce((n,i)=>n+i.quantity,0);
async function start(f,id='alice',mode='pve'){let p=await f.connect(id);await f.host.command(p,{type:'instance',action:'create',mode});p=f.host.getPlayer(id);const r=f.host.locations.get(id);await f.host.command(p,{type:'instance',action:'start'});return{p,r};}
function pathTo(world,player,goal,allowBlockedGoal=false){
  const queue=[{x:player.x,y:player.y,path:[]}],seen=new Set([`${player.x},${player.y}`]),raw=world.content.getMap(player.mapId);
  while(queue.length){const node=queue.shift();if(goal(node))return node.path;
    for(const[d,[dx,dy]]of Object.entries(DIRECTIONS)){const pos={x:node.x+dx,y:node.y+dy};if(pos.x<0||pos.y<0||pos.x>=raw.width||pos.y>=raw.height||seen.has(`${pos.x},${pos.y}`))continue;
      if(!world.canMove({...player,...node},Number(d))&&!(allowBlockedGoal&&goal(pos)))continue;
      const portal=[...world.maps.get(player.mapId).events.values()].find(e=>e.x===pos.x&&e.y===pos.y&&e.pages.some(p=>[1,2].includes(p.trigger)&&p.list.some(c=>c.code===201)));
      if(portal&&!goal(pos))continue;seen.add(`${pos.x},${pos.y}`);queue.push({...pos,path:[...node.path,Number(d)]});
    }
  }return null;
}
async function walk(f,p,goal,allowBlockedGoal=false){const world=f.host.playerWorld(p.id),path=pathTo(world,p,goal,allowBlockedGoal);assert.ok(path,`No path on map ${p.mapId} from ${p.x},${p.y}`);for(const direction of path){await f.advance();await f.host.command(p,{type:'move',direction});await p._queue;}return path.length;}
async function service(f,p,action,containerId){const world=f.host.playerWorld(p.id),event=[...world.maps.get(p.mapId).events.values()].find(e=>e.service?.action===action&&(!containerId||e.service.containerId===containerId));assert.ok(event,`missing ${action} on ${p.mapId}`);await walk(f,p,pos=>Math.abs(pos.x-event.x)+Math.abs(pos.y-event.y)<=1);await f.host.command(p,{type:'interact',targetId:event.id});return event;}
async function portal(f,p,toMap){const world=f.host.playerWorld(p.id),event=[...world.maps.get(p.mapId).events.values()].find(e=>e.pages.some(pg=>pg.list.some(c=>c.code===201&&c.parameters[1]===toMap)));assert.ok(event,`missing portal ${p.mapId}->${toMap}`);await walk(f,p,pos=>pos.x===event.x&&pos.y===event.y,true);await p._queue;assert.equal(p.mapId,toMap);}

test('NPC entry leaves the external world intact and independent rounds do not share maps or combat targets',async()=>{
  const f=await fixture(),a=await f.connect('a'),b=await f.connect('b');const before=clone(f.store.states.get('a'));
  await f.host.command(a,{type:'interact',targetId:'service:instance-guide'});assert.ok(f.messages.get('a').some(m=>m.type==='service'&&m.service==='instance'));
  await f.host.command(a,{type:'instance',action:'create',mode:'pve'});await f.host.command(b,{type:'instance',action:'create',mode:'pvpve'});
  const ra=f.host.locations.get('a'),rb=f.host.locations.get('b');await f.host.command(a,{type:'instance',action:'start'});await f.host.command(b,{type:'instance',action:'start'});
  assert.notEqual(ra.world.maps.get(11),rb.world.maps.get(11));assert.equal(ra.world.maps.get(11).pvp,false);assert.equal(rb.world.maps.get(11).pvp,true);assert.deepEqual(f.store.states.get('a'),before);
  assert.ok(!ra.world.snapshot(f.host.getPlayer('a')).players.some(p=>p.id==='b'));assert.ok(f.host.world.maps.get(1).events.size>2);
  assert.ok(ra.world.content.getMap(11).events.filter(Boolean).every(e=>e.pages.every(p=>!p.list.some(c=>[355,356].includes(c.code)))));
});

test('a waiting player joins, shared containers grant only once, reusable key opens an exit for another player',async()=>{
  const f=await fixture();let a=await f.connect('a'),b=await f.connect('b');await f.host.command(a,{type:'instance',action:'create',mode:'pve'});const r=f.host.locations.get('a');await f.host.command(b,{type:'instance',action:'join',instanceId:r.id});a=f.host.getPlayer('a');b=f.host.getPlayer('b');
  await assert.rejects(f.host.command(b,{type:'instance',action:'start'}),/创建者/);await f.host.command(a,{type:'instance',action:'start'});
  await portal(f,a,12);await service(f,a,'container','inn');const key=r.scenario.itemIds.ordinary;assert.equal(qty(a,key),1);await service(f,a,'container','inn');assert.equal(qty(a,key),1);
  await portal(f,a,11);await service(f,a,'ordinaryExit');assert.equal(r.ordinaryExitUnlocked,true);assert.equal(qty(a,key),1);
  await r.world.inventoryAction(a,{action:'drop',kind:'item',itemId:key,quantity:1,requestId:'key-drop'});assert.equal(qty(a,key),0);const droppedKey=[...r.world.maps.get(11).drops.values()].find(d=>d.itemId===key);await r.world.pickup(a,droppedKey.id,'key-reclaim');assert.equal(qty(a,key),1);
  await service(f,b,'ordinaryExit');assert.equal(f.host.locations.has('b'),false);assert.equal(f.host.getPlayer('b').mapId,1);assert.equal(f.host.locations.get('a'),r);
});

test('death creates one bag, one claimant receives every stack, and duplicate drop requests do not recreate ground items',async()=>{
  const f=await fixture();let a=await f.connect('a'),b=await f.connect('b');const world=f.host.world;await world.grant(a,'item',7,2);await world.grant(a,'item',13,3);const total=clone(a.inventory);
  world.damage(a,a.hp);await a._queue;const bag=[...world.maps.get(1).drops.values()][0];assert.equal(world.maps.get(1).drops.size,1);assert.equal(bag.kind,'bag');assert.deepEqual(bag.metadata.items,total);assert.deepEqual(a.inventory,[]);
  await world.pickup(b,bag.id,'bag-once');assert.equal(qty(b,7),2);assert.equal(qty(b,13),3);await world.pickup(b,bag.id,'bag-once');assert.equal(qty(b,7),2);
  await world.inventoryAction(b,{action:'drop',kind:'item',itemId:7,quantity:1,requestId:'drop-one'});const drop=[...world.maps.get(1).drops.values()][0];await world.pickup(b,drop.id,'pick-one');await world.inventoryAction(b,{action:'drop',kind:'item',itemId:7,quantity:1,requestId:'drop-one'});assert.equal(world.maps.get(1).drops.size,0);assert.equal(qty(b,7),2);
  await world.inventoryAction(b,{action:'sort',requestId:'sort-one'});assert.equal(qty(b,13),3);
});

test('offline characters stay vulnerable and reconnect into their live instance state',async()=>{
  const f=await fixture(),{p,r}=await start(f);const hp=p.hp;r.world.maps.get(11).zone={startsAt:0,endsAt:999999,damage:25};await f.host.disconnect(p.id);assert.equal(r.world.players.get(p.id),p);await f.advance(1000);assert.equal(p.hp,hp-25);
  const account=await f.store.loadPlayer(p.id),restored=await f.host.connect(account,()=>{});assert.equal(restored,p);assert.equal(restored.hp,hp-25);assert.equal(f.host.locations.get(p.id),r);
});

test('a solo player walks authored portals, suppresses ordinary zones, defeats the full-HP boss and ends the round using its dropped key',async()=>{
  const f=await fixture();f.store.profiles.set('alice',{appearance:{kind:'actor',actorId:2,characterName:'Actor1',characterIndex:3},offlineBehavior:'stay'});
  const{p,r}=await start(f);assert.equal(p.characterIndex,3);await service(f,p,'container','village');await portal(f,p,20);await service(f,p,'container','road');await portal(f,p,11);await portal(f,p,13);await service(f,p,'control');
  assert.equal(r.ordinaryZonesDisabled,true);assert.equal(r.boss.spawned,true);assert.ok(r.world.maps.get(22).zone?.persistent);assert.ok([...r.world.maps.values()].filter(m=>m.id!==22).every(m=>!m.zone));
  await portal(f,p,11);await portal(f,p,20);await portal(f,p,21);await service(f,p,'container','cave');await portal(f,p,22);
  const boss=r.world.maps.get(22).events.get(r.boss.entityId);assert.equal(boss.hp,350);let swings=0;
  while(!boss.dead&&swings++<30){await walk(f,p,pos=>Math.abs(pos.x-boss.x)+Math.abs(pos.y-boss.y)<=1);p.direction=Math.abs(boss.x-p.x)>Math.abs(boss.y-p.y)?(boss.x>p.x?6:4):(boss.y>p.y?2:8);await f.host.command(p,{type:'attack',skillId:1});await f.advance(500);if(p.hp<200&&!p.dead)await f.host.command(p,{type:'useItem',itemId:7,requestId:`heal-${swings}`});}
  await p._queue;assert.equal(boss.dead,true);assert.equal(p.dead,false);const drop=[...r.world.maps.get(22).drops.values()].find(d=>d.itemId===r.scenario.itemIds.final);assert.ok(drop);await walk(f,p,pos=>Math.abs(pos.x-drop.x)+Math.abs(pos.y-drop.y)<=1);await f.host.command(p,{type:'pickup',entityId:drop.id,requestId:'boss-key'});assert.equal(qty(p,r.scenario.itemIds.final),1);
  await service(f,p,'finalExit');assert.equal(r.status,'ended');assert.equal(qty(p,r.scenario.itemIds.final),1);assert.equal(f.store.finishes,1);assert.equal(f.host.getPlayer(p.id).mapId,1);assert.equal(f.host.getPlayer(p.id).characterIndex,3);assert.equal(f.host.getPlayer(p.id).appearance.characterIndex,3);
  await f.host.finishRound(r,{reason:'again'});assert.equal(f.store.finishes,1);assert.ok(f.messages.get(p.id).some(m=>m.type==='instanceResult'&&m.result.outcome==='completed'));
});

test('leaving and timeout settlement serialize without duplicate lobby connections',async()=>{
  const f=await fixture();let a=await f.connect('a'),b=await f.connect('b');await f.host.command(a,{type:'instance',action:'create',mode:'pve'});const r=f.host.locations.get('a');await f.host.command(b,{type:'instance',action:'join',instanceId:r.id});a=f.host.getPlayer('a');await f.host.command(a,{type:'instance',action:'start'});
  const entered=deferred(),release=deferred(),leave=f.store.leaveRound.bind(f.store);f.store.leaveRound=async(...args)=>{entered.resolve();await release.promise;return leave(...args);};
  const leaving=f.host.command(a,{type:'instance',action:'leave'});await entered.promise;const finishing=f.host.finishRound(r,{reason:'timeout',success:false});release.resolve();await Promise.all([leaving,finishing]);
  assert.equal(r.status,'ended');assert.equal(f.host.world.players.size,2);assert.equal(r.world.players.size,0);assert.equal(f.store.finishes,1);
});

test('a committed settlement retries destination failure without awarding or settling twice',async()=>{
  const f=await fixture(),{p,r}=await start(f);const save=f.store.savePlayer.bind(f.store);let fail=true;
  f.store.savePlayer=async(...args)=>{if(fail){fail=false;throw new Error('destination unavailable');}return save(...args);};
  await assert.rejects(f.host.finishRound(r,{reason:'timeout',success:false}),/destination unavailable/);assert.equal(r.status,'ending');assert.equal(r.world.players.get(p.id),p);assert.equal(f.store.finishes,1);
  await f.host.finishRound(r,{reason:'timeout',success:false});assert.equal(r.status,'ended');assert.equal(f.host.getPlayer(p.id).mapId,1);assert.equal(f.store.finishes,1);
});

test('old instance requests cannot leave a new round or recreate a round after returning',async()=>{
  const f=await fixture(),{p,r}=await start(f);await f.host.command(p,{type:'instance',action:'leave'});let current=f.host.getPlayer(p.id);
  await assert.rejects(f.host.command(current,{type:'instance',action:'create',mode:'pve',contextInstanceId:r.id}),/旧世界/);
  await f.host.command(current,{type:'instance',action:'create',mode:'pve'});const next=f.host.locations.get(p.id);current=f.host.getPlayer(p.id);
  await assert.rejects(f.host.command(current,{type:'instance',action:'leave',contextInstanceId:r.id}),/旧世界/);assert.equal(f.host.locations.get(p.id),next);
  await assert.rejects(f.host.command(current,{type:'move',direction:2,contextInstanceId:r.id}),/旧世界/);
});

test('an uncertain container commit is recovered before any stale inventory can be saved',async()=>{
  const f=await fixture(),{p,r}=await start(f),scope=r.world.store;const claim=scope.claimContainer.bind(scope),load=scope.loadPlayer.bind(scope);let offline=true;
  scope.claimContainer=async(args)=>{await claim(args);const error=new Error('commit response lost');error.economyUncertain=true;throw error;};scope.loadPlayer=async(...args)=>{if(offline)throw new Error('offline');return load(...args);};
  const before=qty(p,7);await assert.rejects(service(f,p,'container','village'),/commit response lost/);assert.equal(p._economyUncertain,true);assert.equal(qty(scope.states.get(p.id),7),before+3);
  await r.world.persist(p);assert.equal(qty(scope.states.get(p.id),7),before+3);assert.equal(p._economyUncertain,true);
  offline=false;await r.world.persist(p);assert.equal(p._economyUncertain,false);assert.equal(qty(p,7),before+3);assert.equal(qty(scope.states.get(p.id),7),before+3);
});

test('a lost finish response retries its idempotent commit without saving to the now-closed round',async()=>{
  const f=await fixture(),{p,r}=await start(f),finish=f.store.finishRound.bind(f.store);let fail=true;
  f.store.finishRound=async(...args)=>{const result=await finish(...args);if(fail){fail=false;throw new Error('finish response lost');}return result;};
  await assert.rejects(f.host.finishRound(r,{reason:'timeout',success:false}),/response lost/);assert.equal(r._settlementFlushed,true);assert.equal(r.result,undefined);assert.equal(r.world.store.closed,true);
  await f.host.finishRound(r,{reason:'timeout',success:false});assert.equal(f.store.finishes,1);assert.equal(f.host.getPlayer(p.id).mapId,1);assert.equal(f.host.rounds.size,0);assert.equal(r.world.maps.size,0);
});

test('a lost leave response can return the character without saving a closed participant',async()=>{
  const f=await fixture(),{p,r}=await start(f),leave=f.store.leaveRound.bind(f.store),save=r.world.store.savePlayer.bind(r.world.store);let fail=true;
  f.store.leaveRound=async(...args)=>{const result=await leave(...args);if(fail){fail=false;throw new Error('leave response lost');}return result;};
  r.world.store.savePlayer=async(id,state)=>{if(f.store.rounds.get(r.id).members.get(id)==='left')throw new Error('PARTICIPANT_CLOSED');return save(id,state);};
  await assert.rejects(f.host.command(p,{type:'instance',action:'leave'}),/response lost/);assert.equal(p._departure.flushed,true);await f.advance(1050);await r._queue;
  assert.equal(f.host.getPlayer(p.id).mapId,1);assert.equal(r.status,'ended');assert.equal(f.host.rounds.size,0);
});

test('all dead players end the round only after their single-bag death transaction finishes',async()=>{
  const f=await fixture(),{p,r}=await start(f);r.world.damage(p,p.hp);await p._queue;assert.equal([...r.world.maps.get(11).drops.values()].filter(d=>d.kind==='bag').length,1);
  await f.advance(50);await r._queue;assert.equal(r.status,'ended');assert.equal(r.result.reason,'all-dead');assert.equal(r.result.participants[0].outcome,'dead');assert.equal(f.host.getPlayer(p.id).mapId,1);assert.equal(f.host.rounds.size,0);
});
