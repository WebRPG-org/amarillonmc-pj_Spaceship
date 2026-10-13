import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {loadContent} from '../server/content.mjs';
import {GameHost} from '../server/instances.mjs';
import {DIRECTIONS} from '../server/world.mjs';
import {PUBLIC_CITY_MAPS,PUBLIC_CITY_SPAWN,PUBLIC_CITY_SERVICES,PUBLIC_CITY_VERSION} from '../server/public-city.mjs';

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
  createWorldDrops({requestId,drops}){return this.serial(async()=>{
    const key=`world:${requestId}`;if(this.ops.has(key))return{...clone(this.ops.get(key)),duplicate:true};if(this.closed)throw new Error('ROUND_CLOSED');
    const created=drops.map((d,i)=>({...clone(d),id:`${key}:${i}`}));for(const d of created)this.drops.set(d.id,clone(d));
    const result={drops:created,duplicate:false};this.ops.set(key,clone(result));return result;
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
  async updateProfile(id,patch){const profile={...await this.loadProfile(id),...clone(patch)};this.profiles.set(id,clone(profile));return profile;}
  async listPlayerRecords(id){return[...this.rounds.values()].filter(r=>r.status==='finished'&&r.members.has(id)).map(r=>clone(r.result));}
  async createRound(data){const r={...data,status:'waiting',scope:new MemoryScope(),members:new Map()};this.rounds.set(data.id,r);return r;}
  forRound(id){return this.rounds.get(id).scope;}
  async updateRound(id,patch){Object.assign(this.rounds.get(id),patch);}
  async joinRound(id,playerId,state){const r=this.rounds.get(id);await r.scope.savePlayer(playerId,state);r.members.set(playerId,'active');return{id:playerId,username:playerId,state:clone(state)};}
  async leaveRound(id,playerId,result){const r=this.rounds.get(id);r.members.set(playerId,'left');return{result};}
  async finishRound(id,result){
    const r=this.rounds.get(id);if(r.status==='finished')return{result:clone(r.result),duplicate:true};result=clone(result);
    // This fake models the persistence contract so host restoration can be tested;
    // SQL transaction safety and reward idempotency have separate integration tests.
    if(result.success&&result.reward?.titleId){result.rewardsByPlayer={};for(const p of result.participants||[]){
      if(p.outcome!=='completed'||r.members.get(p.id)!=='active')continue;
      const profile=await this.loadProfile(p.id),titles=[...(profile.titles||[])],titleId=result.reward.titleId,newTitle=!titles.includes(titleId);
      if(newTitle)titles.push(titleId);await this.updateProfile(p.id,{titles});result.rewardsByPlayer[p.id]={titleId,newTitle,gold:0,items:[]};
    }}
    r.status='finished';r.result=clone(result);r.scope.closed=true;this.finishes++;return{result,duplicate:false};
  }
}
async function fixture(){
  const content=await loadContent(fileURLToPath(new URL('../../',import.meta.url))),store=new MemoryStore(),messages=new Map();let time=100000;
  const host=new GameHost({content,store,clock:()=>time,random:()=>.5});await host.init();
  const rawCommand=host.command.bind(host);host.command=(player,message)=>rawCommand(player,{contextInstanceId:host.locations.get(player.id)?.id||null,...message});
  async function connect(id,{atEntrance=true}={}){messages.set(id,[]);const account=await store.loadPlayer(id),player=await host.connect(account,m=>messages.get(id).push(m));if(atEntrance){const entry=PUBLIC_CITY_SERVICES.instance;await host.world.transfer(player,entry.mapId,entry.x,entry.y+1);}return player;}
  async function advance(ms=150){for(let left=ms;left>0;left-=50){time+=Math.min(left,50);host.update(Math.min(left,50)/1000);await Promise.resolve();}for(const p of host.players.values())await p._queue;}
  return{host,content,store,messages,connect,advance};
}
const qty=(p,id)=>p.inventory.filter(i=>i.kind==='item'&&i.itemId===id).reduce((n,i)=>n+i.quantity,0);
test('concurrent room creation reserves the last capacity slot before persisting',async()=>{
  const f=await fixture(),a=await f.connect('capacity-a'),b=await f.connect('capacity-b');
  for(let i=0;i<31;i++)f.host.rounds.set(`occupied-${i}`,{status:'ending'});
  const entered=deferred(),release=deferred(),create=f.store.createRound.bind(f.store);
  f.store.createRound=async value=>{entered.resolve();await release.promise;return create(value);};
  const first=f.host.command(a,{type:'instance',action:'create'});await entered.promise;
  await assert.rejects(f.host.command(b,{type:'instance',action:'create'}),/测试容量/);
  release.resolve();await first;assert.equal(f.host.rounds.size,32);assert.equal(f.host.pendingCreations,0);
  assert.equal(f.store.rounds.size,1);assert.equal(f.host.locations.has(b.id),false);
});
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
async function portal(f,p,toMap){const world=f.host.playerWorld(p.id),event=[...world.maps.get(p.mapId).events.values()].find(e=>e.pages.some(pg=>pg.list.some(c=>c.code===201&&c.parameters[1]===toMap)));assert.ok(event,`missing portal ${p.mapId}->${toMap}`);await walk(f,p,pos=>pos.x===event.x&&pos.y===event.y,true);await p._queue;for(let elapsed=0;p.mapId!==toMap&&elapsed<5000;elapsed+=100)await f.advance(100);assert.equal(p.mapId,toMap);}

test('new arrivals walk from the public city to its authored expedition guide and appearance NPC',async()=>{
  const f=await fixture(),p=await f.connect('new-arrival',{atEntrance:false});
  assert.deepEqual({mapId:p.mapId,x:p.x,y:p.y,direction:p.direction},PUBLIC_CITY_SPAWN);
  await assert.rejects(f.host.command(p,{type:'instance',action:'create',mode:'pve'}),/中央广场/);
  await portal(f,p,PUBLIC_CITY_SERVICES.instance.mapId);
  const plaza=f.host.world.maps.get(p.mapId),guide=plaza.events.get('service:instance-guide');
  assert.ok(guide);assert.equal([...plaza.events.values()].filter(e=>e.service?.kind==='instance').length,1);
  assert.ok(plaza.raw.events.some(e=>e?.id===guide.eventId&&/engine_service\s*:\s*instance/.test(e.note)));
  await walk(f,p,pos=>Math.abs(pos.x-guide.x)+Math.abs(pos.y-guide.y)<=1);
  await f.host.command(p,{type:'interact',targetId:guide.id});
  assert.ok(f.messages.get(p.id).some(m=>m.type==='service'&&m.service==='instance'));
  const before={mapId:p.mapId,x:p.x,y:p.y};await f.host.command(p,{type:'instance',action:'create',mode:'pve'});
  await f.host.command(f.host.getPlayer(p.id),{type:'instance',action:'leave'});
  const returned=f.host.getPlayer(p.id);assert.deepEqual({mapId:returned.mapId,x:returned.x,y:returned.y},{mapId:before.mapId,x:before.x,y:before.y});
  const salon=PUBLIC_CITY_SERVICES.appearance;await f.host.world.transfer(returned,salon.mapId,salon.x,salon.y+1);
  const stylist=f.host.world.maps.get(salon.mapId).events.get('service:appearance-guide');assert.ok(stylist);
  assert.equal([...f.host.world.maps.get(salon.mapId).events.values()].filter(e=>e.service?.kind==='appearance').length,1);
  await f.host.command(returned,{type:'interact',targetId:stylist.id});
  assert.ok(f.messages.get(p.id).some(m=>m.type==='service'&&m.service==='appearance'));
  for(const id of PUBLIC_CITY_MAPS){const map=await f.host.world.ensureMap(id);assert.equal(map.pvp,false);assert.equal(map.zone,null);assert.ok([...map.events.values()].every(e=>!e.enemyId));assert.ok(!f.host.scenario.mapIds.includes(id));}
});

test('old starting-room saves migrate once while other locations, inventory and public return positions remain intact',async()=>{
  const f=await fixture(),legacy={...f.host.world.defaultState(),mapId:1,x:13,y:6,gold:123,inventory:[{kind:'item',itemId:7,quantity:4}],selfSwitches:{'1:map:1:event:2:A':true}};
  f.store.states.set('legacy',clone(legacy));let p=await f.connect('legacy',{atEntrance:false});
  assert.equal(p.mapId,PUBLIC_CITY_SPAWN.mapId);assert.equal(p.publicCityVersion,PUBLIC_CITY_VERSION);assert.equal(p.gold,legacy.gold);assert.deepEqual(p.inventory,legacy.inventory);assert.deepEqual(p.selfSwitches,legacy.selfSwitches);
  await f.host.world.transfer(p,1,13,6);const visit=clone(f.store.states.get(p.id));await f.host.world.detach(p.id);p=await f.connect('legacy',{atEntrance:false});
  assert.deepEqual({mapId:p.mapId,x:p.x,y:p.y},{mapId:visit.mapId,x:visit.x,y:visit.y});
  f.store.states.set('elsewhere',{...legacy,mapId:3,x:25,y:32});const other=await f.connect('elsewhere',{atEntrance:false});
  assert.equal(other.mapId,3);assert.equal(other.publicCityVersion,PUBLIC_CITY_VERSION);assert.deepEqual(other.inventory,legacy.inventory);
});

test('NPC entry leaves the external world intact and independent rounds do not share maps or combat targets',async()=>{
  const f=await fixture(),a=await f.connect('a'),b=await f.connect('b');const before=clone(f.store.states.get('a'));
  await f.host.command(a,{type:'interact',targetId:'service:instance-guide'});assert.ok(f.messages.get('a').some(m=>m.type==='service'&&m.service==='instance'));
  await f.host.command(a,{type:'instance',action:'create',mode:'pve'});await f.host.command(b,{type:'instance',action:'create',mode:'pvpve'});
  const ra=f.host.locations.get('a'),rb=f.host.locations.get('b');await f.host.command(a,{type:'instance',action:'start'});await f.host.command(b,{type:'instance',action:'start'});
  assert.notEqual(ra.world.maps.get(11),rb.world.maps.get(11));assert.equal(ra.world.maps.get(11).pvp,false);assert.equal(rb.world.maps.get(11).pvp,true);assert.deepEqual(f.store.states.get('a'),before);
  assert.ok(!ra.world.snapshot(f.host.getPlayer('a')).players.some(p=>p.id==='b'));assert.ok(f.host.world.maps.get(PUBLIC_CITY_SERVICES.instance.mapId).events.size>2);
  const legacy=ra.world.content.getMap(11).events[21].pages[0];
  assert.ok(legacy.list.some(c=>c.code===355),'native legacy source remains reviewable');assert.match(legacy.engineDisabledReason,/旧战斗|旧 Chrono/);
  assert.ok(ra.world.runtimeDiagnostics.size>0);
});

test('a waiting player joins, shared containers grant only once, reusable key opens an exit for another player',async()=>{
  const f=await fixture();let a=await f.connect('a'),b=await f.connect('b');await f.host.command(a,{type:'instance',action:'create',mode:'pve'});const r=f.host.locations.get('a');await f.host.command(b,{type:'instance',action:'join',instanceId:r.id});a=f.host.getPlayer('a');b=f.host.getPlayer('b');
  await assert.rejects(f.host.command(b,{type:'instance',action:'start'}),/创建者/);await f.host.command(a,{type:'instance',action:'start'});
  await portal(f,a,12);await service(f,a,'container','inn');const key=r.scenario.itemIds.ordinary;assert.equal(qty(a,key),1);await service(f,a,'container','inn');assert.equal(qty(a,key),1);
  await portal(f,a,11);await service(f,a,'ordinaryExit');assert.equal(r.ordinaryExitUnlocked,true);assert.equal(qty(a,key),1);
  await r.world.inventoryAction(a,{action:'drop',kind:'item',itemId:key,quantity:1,requestId:'key-drop'});assert.equal(qty(a,key),0);const droppedKey=[...r.world.maps.get(11).drops.values()].find(d=>d.itemId===key);await r.world.pickup(a,droppedKey.id,'key-reclaim');assert.equal(qty(a,key),1);
  await service(f,b,'ordinaryExit');assert.equal(f.host.locations.has('b'),false);assert.equal(f.host.getPlayer('b').mapId,PUBLIC_CITY_SERVICES.instance.mapId);assert.equal(f.host.locations.get('a'),r);
});

test('death creates one bag, one claimant receives every stack, and duplicate drop requests do not recreate ground items',async()=>{
  const f=await fixture();let a=await f.connect('a'),b=await f.connect('b');const world=f.host.world;await world.grant(a,'item',7,2);await world.grant(a,'item',13,3);const total=clone(a.inventory);
  world.damage(a,a.hp);await a._queue;const bag=[...world.maps.get(PUBLIC_CITY_SERVICES.instance.mapId).drops.values()][0];assert.equal(world.maps.get(PUBLIC_CITY_SERVICES.instance.mapId).drops.size,1);assert.equal(bag.kind,'bag');assert.deepEqual(bag.metadata.items,total);assert.deepEqual(a.inventory,[]);
  await world.pickup(b,bag.id,'bag-once');assert.equal(qty(b,7),2);assert.equal(qty(b,13),3);await world.pickup(b,bag.id,'bag-once');assert.equal(qty(b,7),2);
  await world.inventoryAction(b,{action:'drop',kind:'item',itemId:7,quantity:1,requestId:'drop-one'});const drop=[...world.maps.get(PUBLIC_CITY_SERVICES.instance.mapId).drops.values()][0];await world.pickup(b,drop.id,'pick-one');await world.inventoryAction(b,{action:'drop',kind:'item',itemId:7,quantity:1,requestId:'drop-one'});assert.equal(world.maps.get(PUBLIC_CITY_SERVICES.instance.mapId).drops.size,0);assert.equal(qty(b,7),2);
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
  await service(f,p,'finalExit');assert.equal(r.status,'ended');assert.equal(qty(p,r.scenario.itemIds.final),1);assert.equal(f.store.finishes,1);assert.equal(f.host.getPlayer(p.id).mapId,PUBLIC_CITY_SERVICES.instance.mapId);assert.equal(f.host.getPlayer(p.id).characterIndex,3);assert.equal(f.host.getPlayer(p.id).appearance.characterIndex,3);
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
  await f.host.finishRound(r,{reason:'timeout',success:false});assert.equal(r.status,'ended');assert.equal(f.host.getPlayer(p.id).mapId,PUBLIC_CITY_SERVICES.instance.mapId);assert.equal(f.store.finishes,1);
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
  await f.host.finishRound(r,{reason:'timeout',success:false});assert.equal(f.store.finishes,1);assert.equal(f.host.getPlayer(p.id).mapId,PUBLIC_CITY_SERVICES.instance.mapId);assert.equal(f.host.rounds.size,0);assert.equal(r.world.maps.size,0);
});

test('a lost leave response can return the character without saving a closed participant',async()=>{
  const f=await fixture(),{p,r}=await start(f),leave=f.store.leaveRound.bind(f.store),save=r.world.store.savePlayer.bind(r.world.store);let fail=true;
  f.store.leaveRound=async(...args)=>{const result=await leave(...args);if(fail){fail=false;throw new Error('leave response lost');}return result;};
  r.world.store.savePlayer=async(id,state)=>{if(f.store.rounds.get(r.id).members.get(id)==='left')throw new Error('PARTICIPANT_CLOSED');return save(id,state);};
  await assert.rejects(f.host.command(p,{type:'instance',action:'leave'}),/response lost/);assert.equal(p._departure.flushed,true);await f.advance(1050);await r._queue;
  assert.equal(f.host.getPlayer(p.id).mapId,PUBLIC_CITY_SERVICES.instance.mapId);assert.equal(r.status,'ended');assert.equal(f.host.rounds.size,0);
});

test('all dead players end the round only after their single-bag death transaction finishes',async()=>{
  const f=await fixture(),{p,r}=await start(f);r.world.damage(p,p.hp);await p._queue;assert.equal([...r.world.maps.get(11).drops.values()].filter(d=>d.kind==='bag').length,1);
  await f.advance(50);await r._queue;assert.equal(r.status,'ended');assert.equal(r.result.reason,'all-dead');assert.equal(r.result.participants[0].outcome,'dead');assert.equal(f.host.getPlayer(p.id).mapId,PUBLIC_CITY_SERVICES.instance.mapId);assert.equal(f.host.rounds.size,0);
});

const stacks=p=>p.inventory.map(({kind,itemId,quantity})=>({kind,itemId,quantity})).sort((a,b)=>a.kind.localeCompare(b.kind)||a.itemId-b.itemId);
const inWarning=(p,warning)=>Math.abs(p.x-warning.x)<=1&&Math.abs(p.y-warning.y)<=1;
async function adventure(f,id='adventurer',{startNow=true}={}){
  const outside=await f.connect(id);
  await f.host.command(outside,{type:'interact',targetId:'service:instance-guide'});
  assert.ok(f.messages.get(id).some(m=>m.type==='service'&&m.scenarios?.some(s=>s.id==='meteor-recovery')));
  await f.host.command(outside,{type:'instance',action:'create',definitionId:'meteor-recovery',mode:'pvpve'});
  const p=f.host.getPlayer(id),r=f.host.locations.get(id);
  assert.equal(f.host.devTools,false);assert.equal(r.world.devTools,false);assert.equal(r.mode,'pve');
  if(startNow)await f.host.command(p,{type:'instance',action:'start'});
  return{p,r};
}
// Walk at the normal 150 ms input cadence, recomputing against moving NPCs. The
// walker reacts to actual warning snapshots, leaves their nine cells, and waits
// rather than re-entering a warning. No teleports, HP/stat changes or NPC erasure.
async function meteorWalk(f,p,goal,{allowBlockedGoal=false}={}){
  const r=f.host.locations.get(p.id),world=r.world;let steps=0;
  while(!goal(p)&&steps++<800){
    await f.advance(150);
    assert.equal(p.dead,false,`Adventurer died on Map ${p.mapId} at ${p.x},${p.y}`);
    assert.equal(f.host.locations.get(p.id),r,'Adventure ended during authored walking route');
    const warnings=world.hazards.snapshot(p.mapId).filter(h=>h.kind==='meteor');
    const unsafe=pos=>warnings.some(w=>inWarning(pos,w));
    const escape=unsafe(p),path=pathTo(world,p,escape?pos=>!unsafe(pos):goal,escape?false:allowBlockedGoal);
    assert.ok(path?.length,`No ${escape?'warning escape':'objective'} path on Map ${p.mapId} from ${p.x},${p.y}`);
    const direction=path[0],[dx,dy]=DIRECTIONS[direction];
    if(!escape&&unsafe({x:p.x+dx,y:p.y+dy}))continue;
    await f.host.command(p,{type:'move',direction});await p._queue;
    if(p.hp<250&&qty(p,102))await f.host.command(p,{type:'useItem',itemId:102,requestId:`route-bread-${p.mapId}-${steps}-${world.now}`});
  }
  assert.ok(goal(p),`Walking limit exceeded on Map ${p.mapId}`);return steps;
}
async function meteorPortal(f,p,toMap){
  const world=f.host.playerWorld(p.id),event=[...world.maps.get(p.mapId).events.values()].find(e=>e.pages.some(pg=>pg.list.some(c=>c.code===201&&c.parameters[1]===toMap)));
  assert.ok(event,`missing meteor portal ${p.mapId}->${toMap}`);
  await meteorWalk(f,p,pos=>pos.mapId===toMap||pos.x===event.x&&pos.y===event.y,{allowBlockedGoal:true});await p._queue;assert.equal(p.mapId,toMap);
}
async function meteorService(f,p,action){
  const world=f.host.playerWorld(p.id),event=[...world.maps.get(p.mapId).events.values()].find(e=>e.service?.action===action);assert.ok(event);
  await meteorWalk(f,p,pos=>Math.abs(pos.x-event.x)+Math.abs(pos.y-event.y)<=1);
  await f.host.command(p,{type:'interact',targetId:event.id});return event;
}
async function recoverMeteorDisk(f,p){
  await meteorPortal(f,p,53);await meteorPortal(f,p,54);await meteorPortal(f,p,56);
  await meteorService(f,p,'meteorDisk');
  await meteorPortal(f,p,54);await meteorPortal(f,p,53);await meteorPortal(f,p,52);
  await meteorService(f,p,'meteorExit');
}

test('a private adventure resets the player and begins five-second weather only after its owner starts',async()=>{
  const f=await fixture();f.store.states.set('adventurer',{...f.host.world.defaultState(),level:25,exp:999,gold:1234,inventory:[{kind:'item',itemId:7,quantity:99}],skills:[1,5],states:[{id:4,expires:999999}],switches:{12:true},variables:{8:92},paramPlus:[100,20]});
  const {p,r}=await adventure(f,'adventurer',{startNow:false}),external=clone(f.store.states.get(p.id));
  assert.equal(p.level,1);assert.equal(p.exp,0);assert.equal(p.gold,0);assert.equal(p.equips.armor,121);assert.equal(p.equips.weapon,0);
  assert.deepEqual(stacks(p),[{kind:'armor',itemId:121,quantity:1},{kind:'item',itemId:102,quantity:2},{kind:'item',itemId:103,quantity:2}]);
  assert.deepEqual(p.skills,[1]);assert.deepEqual(p.states,[]);assert.deepEqual(p.switches,{});assert.deepEqual(p.variables,{});assert.deepEqual(p.paramPlus,[]);
  const stranger=await f.connect('stranger');await assert.rejects(f.host.command(stranger,{type:'instance',action:'join',instanceId:r.id}),/私人冒险/);
  await assert.rejects(f.host.command(stranger,{type:'title',titleId:'meteor'}),/尚未获得/);
  await f.host.command(stranger,{type:'instance',action:'open'});const open=f.messages.get('stranger').filter(m=>m.type==='service').at(-1);assert.ok(!open.instances.some(i=>i.id===r.id));
  const hp=p.hp;await f.advance(30000);assert.equal(r.world.hazards.strikes.size,0);assert.equal(p.hp,hp);assert.equal(r.snapshot().remainingSeconds,600);
  await assert.rejects(f.host.command(p,{type:'move',direction:6}),/尚未开始/);
  await f.host.command(p,{type:'instance',action:'start'});
  await assert.rejects(f.host.command(p,{type:'travel',mapId:56}),/开发功能/);
  await f.advance(4950);assert.equal(r.world.hazards.strikes.size,0);await f.advance(50);
  const first=[...r.world.hazards.strikes.values()][0];assert.ok(first);assert.equal(first.startedAt-r.startedAt,5000);assert.equal(first.impactAt-first.startedAt,1000);assert.deepEqual([first.x,first.y],[p.x,p.y]);assert.equal(first.radius,1);
  await meteorWalk(f,p,pos=>!inWarning(pos,first));await f.advance(Math.max(0,first.impactAt-r.world.now));assert.equal(p.hp,hp);
  await f.advance(r.startedAt+9950-r.world.now);assert.equal(r.world.hazards.strikes.size,0);await f.advance(50);
  assert.equal([...r.world.hazards.strikes.values()][0].startedAt-r.startedAt,10000);
  await f.host.command(p,{type:'instance',action:'leave'});assert.deepEqual(f.store.states.get(p.id),external);assert.ok(!(await f.store.loadProfile(p.id)).titles?.includes('meteor'));
});

test('unknown and inherited scenario identifiers are rejected before any durable room is created',async()=>{
  const f=await fixture(),p=await f.connect('definition-probe'),external=clone(f.store.states.get(p.id));
  for(const definitionId of ['__proto__','constructor','missing-adventure']){
    await assert.rejects(f.host.command(p,{type:'instance',action:'create',definitionId,mode:'pve'}),/副本定义不存在/);
    assert.equal(f.store.rounds.size,0,`${definitionId} must not create a persistent room`);assert.equal(f.store.finishes,0);
    assert.equal(f.host.rounds.size,0);assert.equal(f.host.locations.size,0);assert.equal(f.host.getPlayer(p.id),p);assert.equal(f.host.transitions.size,0);
  }
  assert.deepEqual(f.store.states.get(p.id),external);
});

test('construction failure after a valid scenario is persisted closes the room and keeps the player in the lobby',async()=>{
  const f=await fixture(),p=await f.connect('missing-map'),external=clone(f.store.states.get(p.id));
  assert.ok(f.host.scenarios['meteor-recovery']);const missing=f.content.getMap(56);f.content.maps.delete(56);
  await assert.rejects(f.host.command(p,{type:'instance',action:'create',definitionId:'meteor-recovery',mode:'pve'}),/副本地图 56 不存在/);
  assert.equal(f.store.rounds.size,1);const failed=[...f.store.rounds.values()][0];
  assert.equal(failed.definitionId,'meteor-recovery');assert.equal(failed.status,'finished');assert.equal(failed.result.reason,'creation-failed');assert.equal(failed.scope.closed,true);assert.equal(failed.members.size,0);
  assert.equal(f.host.rounds.size,0);assert.equal(f.host.locations.size,0);assert.equal(f.host.transitions.size,0);assert.equal(f.host.getPlayer(p.id),p);assert.deepEqual(f.store.states.get(p.id),external);
  // Repairing the content allows the same player to retry without a stale lock.
  f.content.maps.set(56,missing);await f.host.command(p,{type:'instance',action:'create',definitionId:'meteor-recovery',mode:'pve'});
  assert.equal(f.host.locations.get(p.id).status,'waiting');await f.host.command(f.host.getPlayer(p.id),{type:'instance',action:'leave'});
  assert.ok([...f.store.rounds.values()].every(r=>r.status==='finished'));
});

test('authored adventure containers grant configured local loot once per distinct map event',async()=>{
  const f=await fixture(),{p,r}=await adventure(f,'container-walker'),external=clone(f.store.states.get(p.id));
  async function open(mapId,eventId,x,y){
    // This isolates service binding and inventory delivery; real travel under
    // weather is covered by the complete recovery-route test below.
    await r.world.transfer(p,mapId,x,y);
    const event=[...r.world.maps.get(mapId).events.values()].find(e=>e.eventId===eventId);assert.ok(event);
    assert.deepEqual(event.service,{kind:'round',action:'container',containerId:`adventure:${mapId}:${eventId}`});
    await f.host.command(p,{type:'interact',targetId:event.id});return event;
  }
  assert.equal(qty(p,102),2);assert.equal(qty(p,103),2);
  const first=await open(52,8,6,20);assert.equal(qty(p,102),4);assert.equal(qty(p,103),3);assert.equal(r.containers.get(first.service.containerId).opened,true);
  const claimed=stacks(p);await f.host.command(p,{type:'interact',targetId:first.id});assert.deepEqual(stacks(p),claimed,'Repeated interaction cannot duplicate an opened box');
  const second=await open(55,3,18,8);assert.notEqual(second.service.containerId,first.service.containerId);assert.equal(qty(p,102),6);assert.equal(qty(p,103),4);
  const medical=stacks(p);await f.host.command(p,{type:'interact',targetId:second.id});assert.deepEqual(stacks(p),medical);
  const supplies=await open(53,12,25,24);assert.equal(qty(p,102),7);assert.equal(qty(p,103),4);assert.equal(p.inventory.filter(i=>i.kind==='weapon'&&i.itemId===63).reduce((n,i)=>n+i.quantity,0),1);
  const allLoot=stacks(p);await f.host.command(p,{type:'interact',targetId:supplies.id});assert.deepEqual(stacks(p),allLoot);
  assert.deepEqual([...r.world.store.containers.keys()].sort(),['adventure:52:8','adventure:53:12','adventure:55:3']);assert.deepEqual(stacks(r.world.store.states.get(p.id)),allLoot);
  assert.deepEqual(f.store.states.get(p.id),external);await f.host.command(p,{type:'instance',action:'leave'});assert.deepEqual(stacks(f.host.getPlayer(p.id)),stacks(external));assert.deepEqual(f.store.states.get(p.id),external);
});

test('a baseline adventurer dodges real weather, recovers the disk and restores the external state with one permanent title',async()=>{
  const f=await fixture();f.store.profiles.set('adventurer',{appearance:{kind:'actor',actorId:2,characterName:'Actor1',characterIndex:3},offlineBehavior:'stay',customPreference:'retained'});
  const {p,r}=await adventure(f),external=clone(f.store.states.get(p.id)),baselineHp=p.maxHp;
  await assert.rejects(meteorService(f,p,'meteorExit'),/尚未取得/);
  await recoverMeteorDisk(f,p);
  assert.equal(p.dead,false);assert.equal(p.maxHp,baselineHp);assert.equal(p.level,1);assert.equal(qty(p,r.scenario.diskItemId),1);
  assert.equal(r.status,'ended');assert.equal(r.result.reason,'disk-extracted');assert.equal(r.result.participants[0].outcome,'completed');assert.equal(f.store.finishes,1);
  assert.deepEqual(f.store.states.get(p.id),external);const restored=f.host.getPlayer(p.id);assert.equal(qty(restored,104),0);assert.ok(!restored.inventory.some(i=>i.kind==='weapon'&&i.itemId===65));
  assert.deepEqual(restored.profile.titles,['meteor']);assert.equal(restored.profile.customPreference,'retained');assert.equal(restored.characterIndex,3);
  const result=f.messages.get(p.id).find(m=>m.type==='instanceResult'&&m.result.reason==='disk-extracted');assert.deepEqual(result.result.rewards,{titleId:'meteor',newTitle:true,gold:0,items:[]});
  assert.ok(f.messages.get(p.id).some(m=>m.type==='effect'&&m.kind==='meteor'),'Real timed impacts ran during the walking route');
  await f.host.finishRound(r,{reason:'replayed',success:true});assert.equal(f.store.finishes,1);assert.deepEqual((await f.store.loadProfile(p.id)).titles,['meteor']);
  await f.host.command(restored,{type:'records'});assert.equal(f.messages.get(p.id).filter(m=>m.type==='records').at(-1).records[0].definitionId,'meteor-recovery');
  await f.host.command(restored,{type:'title',titleId:'meteor'});assert.equal(restored.profile.equippedTitle,'meteor');assert.equal(restored.profile.customPreference,'retained');
  await f.host.command(restored,{type:'instance',action:'create',mode:'pve'});const dts=f.host.getPlayer(p.id);assert.equal(dts.level,1);assert.equal(dts.gold,0);assert.equal(dts.equips.armor,121);
  assert.equal(dts.inventory.filter(i=>i.kind==='weapon'&&i.itemId===65).reduce((n,i)=>n+i.quantity,0),1);assert.equal(dts.equips.weapon,0,'Title grants a carried weapon, not forced equipment');
  await assert.rejects(f.host.command(dts,{type:'title',titleId:null}),/主世界/);await f.host.command(dts,{type:'instance',action:'leave'});
  const outside=f.host.getPlayer(p.id);await f.host.command(outside,{type:'instance',action:'create',definitionId:'meteor-recovery',mode:'pve'});
  const unsupported=f.host.getPlayer(p.id);assert.equal(unsupported.inventory.some(i=>i.kind==='weapon'&&i.itemId===65),false);assert.equal(unsupported.profile.equippedTitle,'meteor');
  await f.host.command(unsupported,{type:'instance',action:'leave'});assert.deepEqual(f.store.states.get(p.id),external);
});

test('death, timeout and departure cannot award the adventure title or leak local inventory',async t=>{
  for(const outcome of ['death','timeout','leave'])await t.test(outcome,async()=>{
    const f=await fixture(),{p,r}=await adventure(f,outcome),external=clone(f.store.states.get(p.id));
    if(outcome==='death'){
      // Standing in two natural 400-damage impacts kills the real LV1 character.
      await f.advance(11100);await p._queue;await f.advance(50);await r._queue;
      assert.equal(r.result.reason,'all-dead');assert.equal(r.result.participants[0].outcome,'dead');
    }else if(outcome==='timeout'){
      await meteorPortal(f,p,53);await meteorPortal(f,p,55);const before=p.hp;
      await f.advance(Math.max(0,r.startedAt+r.durationSeconds*1000-r.world.now)+50);await r._queue;
      assert.equal(p.dead,false);assert.equal(p.hp,before,'Indoor shelter prevents outdoor meteor damage');assert.equal(r.result.reason,'timeout');
    }else{
      await meteorPortal(f,p,53);await f.host.command(p,{type:'instance',action:'leave'});assert.equal(r.result.reason,'all-left');
    }
    assert.equal(r.status,'ended');assert.equal(f.host.locations.has(p.id),false);assert.deepEqual(f.store.states.get(p.id),external);assert.ok(!(await f.store.loadProfile(p.id)).titles?.includes('meteor'));
  });
});
