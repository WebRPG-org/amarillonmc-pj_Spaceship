import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {loadContent} from '../server/content.mjs';
import {World} from '../server/world.mjs';
import {normalizeWeapons,equippedWeapon,cleaveTiles,weaponMovementSpeed,importWeaponProfiles} from '../server/weapons.mjs';
import {addInventory} from '../server/combat.mjs';
import {MySqlStore} from '../server/persistence.mjs';
import {Round} from '../server/rounds.mjs';

const clone=structuredClone;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
class Store{
  constructor(){this.states=new Map();this.ops=new Map();this.drops=new Map();}
  async savePlayer(id,state){this.states.set(id,clone(state));}
  async loadPlayer(id){return{id,state:clone(this.states.get(id))};}
  async listDrops(mapId){return [...this.drops.values()].filter(d=>d.mapId===mapId).map(clone);}
  async commitPlayer(id,requestId,mutator){
    const key=`${id}:${requestId}`;if(this.ops.has(key))return{...clone(this.ops.get(key)),duplicate:true};
    const state=clone(this.states.get(id)),result=await mutator(state);this.entered?.resolve();if(this.gate)await this.gate.promise;
    if(this.fail)throw new Error('write failed');
    this.states.set(id,clone(state));const response={state,result,duplicate:false};this.ops.set(key,clone(response));return response;
  }
  async createDrops({playerId,requestId,drops,mutator}){
    const created=drops.map(d=>({...clone(d),id:randomUUID()}));
    const outcome=await this.commitPlayer(playerId,requestId,async state=>{const result=await mutator(state,created);return{result,drops:created};});
    if(!outcome.duplicate)for(const drop of created)this.drops.set(drop.id,clone(drop));
    return{...outcome,drops:outcome.result.drops};
  }
  async claimDrop({playerId,requestId,dropId,mutator}){
    const drop=this.drops.get(dropId);if(!drop)throw new Error('No drop');
    const outcome=await this.commitPlayer(playerId,requestId,state=>mutator(state,clone(drop)));
    if(!outcome.duplicate)this.drops.delete(dropId);return{...outcome,drop:clone(drop)};
  }
}
async function fixture(){
  const content=await loadContent(fileURLToPath(new URL('../../',import.meta.url))),store=new Store();let time=100000;
  const maps=[1,2].map(id=>({id,width:24,height:20,events:[],data:Array(24*20*6).fill(0)}));
  content.getMap=id=>maps.find(m=>m.id===Number(id));content.findSpawn=(_id,x,y)=>({x,y});content.wrapPosition=(_id,x,y)=>({x,y});
  content.isPassable=(_id,x,y,d)=>x>=0&&y>=0&&x<23&&y<19;
  const world=new World({content,store,clock:()=>time,random:()=>.5});
  const player=await world.connect({id:1,username:'tester'},()=>{});player.x=1;player.y=5;player.direction=6;
  const profiles=Object.fromEntries([...content.weaponProfiles.values()].map(p=>[p.mode,p]));
  async function equip(mode){const p=profiles[mode];await world.grant(player,'weapon',p.weaponId,1);const item=player.inventory.filter(i=>i.itemId===p.weaponId&&i.kind==='weapon').at(-1);await world.equip(player,'weapon',p.weaponId,item.instanceId);return item;}
  function enemy(x,y=5){const e={id:randomUUID(),enemyId:1,mapId:1,x,y,hp:10000,maxHp:10000,mp:100,maxMp:100,stats:{def:0,mdf:0},states:[],_eventRouteOwner:true};world.maps.get(1).events.set(e.id,e);return e;}
  return{world,player,store,content,profiles,equip,enemy,advance:()=>{time+=2000;world.now=time;}};
}

test('four authored weapon profiles import their appended Toolmap attacks and MZ animations',async()=>{
  const f=await fixture();assert.equal(f.content.weaponProfiles.size,5);
  for(const [index,p]of [...f.content.weaponProfiles.values()].filter(p=>p.mode!=='cleave').entries()){
    const tool=f.content.getTool(p.toolId);assert.equal(tool.skillId,p.skillId);assert.equal(tool.mapId,25);assert.equal(tool.projectile,p.projectile);assert.equal(tool.animationId,121+index);
    assert.equal(f.content.getToolForSkill(p.skillId),tool);assert.ok(f.content.database.Animations[121+index].effectName);
  }
});

test('same-type weapons retain separate identities and wear through sort, discard, pickup, death and reconnect',async()=>{
  const f=await fixture(),a=await f.equip('throw'),b=await f.equip('throw');
  await f.world.equip(f.player,'weapon',a.itemId,a.instanceId);
  assert.equal(await f.world.attack(f.player,1,'throw-1'),true);f.advance();
  assert.equal(equippedWeapon(f.player).durability,23);assert.equal(f.player.inventory.find(i=>i.instanceId===b.instanceId).durability,24);
  await f.world.inventoryAction(f.player,{action:'sort',requestId:'sort'});
  await f.world.inventoryAction(f.player,{action:'drop',kind:'weapon',itemId:a.itemId,instanceId:a.instanceId,quantity:1,requestId:'drop'});
  assert.equal(f.player.equips.weapon,0);const drop=[...f.store.drops.values()][0];assert.equal(drop.metadata.instanceId,a.instanceId);assert.equal(drop.metadata.durability,23);
  await f.world.pickup(f.player,drop.id,'pick');assert.equal(f.player.inventory.find(i=>i.instanceId===a.instanceId).durability,23);
  const second=await f.world.connect({id:2,username:'second'},()=>{});second.x=f.player.x;second.y=f.player.y;
  f.world.kill(f.player,second);await f.player._queue;
  const bag=[...f.store.drops.values()][0];assert.equal(bag.kind,'bag');await f.world.pickup(second,bag.id,'bag');
  assert.equal(second.inventory.find(i=>i.instanceId===a.instanceId).durability,23);assert.equal(second.inventory.find(i=>i.instanceId===b.instanceId).durability,24);
  await f.world.disconnect(second.id);const account=await f.store.loadPlayer(second.id),restored=await f.world.connect({...account,username:'second'},()=>{});
  assert.equal(restored.inventory.find(i=>i.instanceId===a.instanceId).durability,23);
});

test('legacy weapon stacks migrate once and exhausted pieces cannot borrow a spare weapon durability',async()=>{
  const f=await fixture(),p=f.profiles.throw,state={inventory:[{kind:'weapon',itemId:p.weaponId,quantity:2}],equips:{weapon:p.weaponId}};
  normalizeWeapons(state,f.content.weaponProfiles);assert.equal(state.inventory.length,2);assert.notEqual(state.inventory[0].instanceId,state.inventory[1].instanceId);
  state.inventory[0].durability=0;const saved=clone(state);normalizeWeapons(state,f.content.weaponProfiles);assert.deepEqual(state,saved);
  Object.assign(f.player,state);await assert.rejects(f.world.attack(f.player,1,'exhausted'),/耐久不足/);assert.equal(state.inventory[1].durability,24);assert.equal(f.world.maps.get(1).projectiles.size,0);
  await f.world.equip(f.player,'weapon',p.weaponId,state.inventory[1].instanceId);assert.equal(await f.world.attack(f.player,1,'spare'),true);
});

test('firearm and staff pay atomic ammo/MP/wear costs; duplicate requests and direct skill IDs cannot bypass them',async()=>{
  const f=await fixture();await f.equip('firearm');const firearm=f.profiles.firearm;
  await assert.rejects(f.world.attack(f.player,1,'empty'),/弹药不足/);assert.equal(f.world.maps.get(1).projectiles.size,0);
  await f.world.grant(f.player,'item',firearm.ammoItemId,2);assert.equal(await f.world.attack(f.player,1,'shot'),true);f.advance();
  assert.equal(await f.world.attack(f.player,1,'shot'),false);assert.equal(f.player.inventory.find(i=>i.itemId===firearm.ammoItemId&&i.kind==='item').quantity,1);
  await assert.rejects(f.world.attack(f.player,f.profiles.staff.skillId,'forged-skill'),/对应武器/);
  await f.equip('staff');f.player.mp=8;const before=f.world.maps.get(1).projectiles.size;
  assert.equal(await f.world.attack(f.player,f.profiles.staff.skillId,'staff'),true);assert.equal(f.player.mp,4);assert.equal(equippedWeapon(f.player).durability,29);f.advance();
  f.player.mp=3;await assert.rejects(f.world.attack(f.player,1,'low-mp'),/MP 不足/);assert.equal(equippedWeapon(f.player).durability,29);assert.equal(f.world.maps.get(1).projectiles.size,before+1);
});

test('server projectile motion stops at walls and configured range; club hits multiple nearby targets',async()=>{
  const f=await fixture();await f.equip('throw');const blocked=f.enemy(2),far=f.enemy(8);
  f.content.isPassable=(_id,x,_y,d)=>!(x===1&&d===6);
  await f.world.attack(f.player,1,'wall');const attack=[...f.world.maps.get(1).projectiles.values()][0];f.world.advanceProjectile(attack,2);assert.equal(blocked.hp,10000);assert.equal(attack.expires,0);
  f.content.isPassable=()=>true;f.world.maps.get(1).events.delete(blocked.id);f.advance();await f.world.attack(f.player,1,'range');const ranged=[...f.world.maps.get(1).projectiles.values()].at(-1);f.world.advanceProjectile(ranged,2);assert.equal(far.hp,10000);assert.ok(Math.abs(ranged.distance-6)<1e-8);
  await f.equip('club');f.advance();const close=f.enemy(3),side=f.enemy(1,3),outside=f.enemy(4);await f.world.attack(f.player,1,'club');assert.ok(close.hp<10000);assert.ok(side.hp<10000);assert.equal(outside.hp,10000);
});

test('red iron sword cleaves exactly three front tiles in all directions, once each, with authored effects',async()=>{
  const f=await fixture();await f.equip('cleave');const {world,player,content}=f,tool=content.getTool(105),skill=content.database.Skills[306];
  assert.equal(tool.skillId,306);assert.equal(tool.area,'wall');assert.equal(tool.projectile,false);assert.equal(tool.cooldown,.8);
  assert.equal(skill.animationId,125);assert.ok(content.database.Animations[125].frames.length);assert.equal(content.database.Animations[125].animation1Name,'SlashFire');
  for(const direction of [2,4,6,8]){
    f.advance();player.x=10;player.y=10;player.direction=direction;world.maps.get(1).events.clear();world.maps.get(1).projectiles.clear();
    const expected=new Set(cleaveTiles(player).map(p=>`${p.x},${p.y}`)),targets=[];
    for(let dx=-2;dx<=2;dx++)for(let dy=-2;dy<=2;dy++)if(dx||dy)targets.push(f.enemy(player.x+dx,player.y+dy));
    const messages=[];player._send=m=>messages.push(m);
    assert.equal(await world.attack(player,1,`cleave-${direction}`),true);
    const attack=[...world.maps.get(1).projectiles.values()][0],hpAfter=targets.map(t=>t.hp);world.resolveAttack(attack);
    assert.deepEqual(targets.map(t=>t.hp),hpAfter,'one swing cannot hit the same target twice');
    for(const target of targets)assert.equal(target.hp<10000,expected.has(`${target.x},${target.y}`),`direction ${direction} target ${target.x},${target.y}`);
    assert.equal(attack.hit.size,3);assert.equal(attack.projectile,false);
    const effects=messages.filter(m=>m.type==='effect'&&m.kind==='attack');assert.equal(effects.length,3);assert.ok(effects.every(e=>e.animationId===125));
    assert.deepEqual(new Set(effects.map(e=>`${e.x},${e.y}`)),expected);
    assert.ok(targets.filter(t=>t.hp<10000).every(t=>10000-t.hp>=player.stats.atk*3),'powerful physical damage');
  }
});

test('red sword respects walls, exact equipment, attack cost idempotency and the 25 percent speed penalty',async()=>{
  const f=await fixture(),{world,player,content}=f;const weapon=await f.equip('cleave');
  assert.equal(weaponMovementSpeed(content,player),.75);assert.equal(world.movementInterval(player),140/.75);assert.equal(world.snapshot(player).self.movementSpeed,.75);
  const start=world.now;player._lastMove=start;world.now=start+140;world.move(player,6);assert.equal(player.x,1);
  world.now=start+186;world.move(player,6);assert.equal(player.x,1);
  world.now=start+187;world.move(player,6);assert.equal(player.x,2);
  await world.equip(player,'weapon',0);assert.equal(world.movementInterval(player),140);world.now+=140;world.move(player,6);assert.equal(player.x,3);
  await assert.rejects(world.attack(player,306,'wrong-weapon'),/对应武器/);
  await world.equip(player,'weapon',66,weapon.instanceId);player.x=1;player.y=5;player.direction=6;f.advance();
  const center=f.enemy(2),side=f.enemy(2,6);content.isPassable=(_map,x,_y,d)=>!(x===1&&d===6);
  assert.equal(await world.attack(player,1,'blocked-cleave'),true);assert.equal(center.hp,10000);assert.equal(side.hp,10000);
  f.advance();assert.equal(await world.attack(player,1,'blocked-cleave'),false);assert.equal(equippedWeapon(player).durability,undefined);
  await world.inventoryAction(player,{action:'drop',kind:'weapon',itemId:66,instanceId:weapon.instanceId,quantity:1,requestId:'drop-heavy-sword'});
  assert.equal(world.snapshot(player).self.movementSpeed,1);assert.equal(player.equips.weapon,0);
});

test('weapon authoring rejects invalid movement multipliers and cleave ranges',async()=>{
  const {content}=await fixture(),original=content.database.Weapons[66];
  for(const patch of [{movementSpeed:0},{movementSpeed:-.1},{movementSpeed:1.1},{movementSpeed:'bad'},{range:2}]){
    const database={...content.database,Weapons:[...content.database.Weapons]},value={...content.weaponProfiles.get(66),...patch};
    database.Weapons[66]={...original,note:`<serverWeapon>${JSON.stringify(value)}</serverWeapon>`};
    assert.throws(()=>importWeaponProfiles(database),/Invalid weapon 66/);
  }
});

test('offline navigation preserves the same 25 percent equipped movement penalty',async()=>{
  const distances=[];
  for(const equipped of [false,true]){
    const f=await fixture(),{world,player}=f;if(equipped)await f.equip('cleave');
    player._connected=false;player.offlineBehavior='search';
    const drop={id:'distant-loot',kind:'item',itemId:7,quantity:1,mapId:1,x:22,y:5};world.maps.get(1).drops.set(drop.id,drop);
    world.offlineAI.update(player);const initial=player.x;
    for(let step=0;step<32;step++){world.now+=50;world.offlineAI.update(player);}
    distances.push(player.x-initial);
  }
  assert.deepEqual(distances,[8,6]);assert.equal(distances[1]/distances[0],.75);
});

test('DTS entry carries the red sword only after unlock and real overworld equipment, never a title shortcut',async()=>{
  const f=await fixture();await f.equip('cleave');const {player,content}=f;
  content.gameplay.titles['red-kill-sword']={id:'red-kill-sword',name:'红杀铁剑',weaponId:66,equipInWorld:true};
  const scenario={id:'entry-check',name:'装备检查',type:'dts',mapIds:[1],spawn:{mapId:1,x:1,y:5},allowedTitles:['red-kill-sword'],initialState:{inventory:[],skills:[1],equips:{weapon:0,armor:0}}};
  const seed=(state,patch={})=>new Round({id:'entry-check',content,store:{forRound:()=>f.store},host:{},scenario:{...scenario,...patch}}).seed(state);
  const count=state=>state.inventory.filter(i=>i.kind==='weapon'&&i.itemId===66).length;
  player.profile={titles:['red-kill-sword']};
  const initial=seed(player);assert.equal(count(initial),1);assert.equal(initial.entryWeapon,66);assert.notEqual(initial.inventory.find(i=>i.itemId===66).instanceId,player.equips.weaponInstanceId);
  assert.equal(count(seed({...player,profile:{titles:[]}})),0,'locked reward cannot be carried');
  assert.equal(count(seed({...player,equips:{weapon:0},profile:{titles:['red-kill-sword'],equippedTitle:'red-kill-sword'}})),0,'title selection cannot substitute for actual equipment');
  assert.equal(count(seed({...player,equips:{...player.equips,weaponInstanceId:'forged'}})),0,'missing equipped instance');
  assert.equal(count(seed({...player,inventory:[]})),0,'unowned equipment');
  assert.equal(count(seed(player,{allowedTitles:[]})),0,'scenario does not permit this reward');
  assert.equal(count(seed(player,{type:'adventure'})),0,'only DTS entry copies this weapon');
  assert.equal(count(seed(player,{initialState:{...scenario.initialState,inventory:[{kind:'weapon',itemId:66,quantity:1}]}})),1,'configured starting item is not duplicated');
});

test('a failed payment emits no attack and death during an in-flight payment cannot fire or reset spent durability',async()=>{
  const f=await fixture();await f.equip('throw');f.store.fail=true;await assert.rejects(f.world.attack(f.player,1,'failed'),/write failed/);assert.equal(equippedWeapon(f.player).durability,24);assert.equal(f.world.maps.get(1).projectiles.size,0);
  f.store.fail=false;f.store.gate=deferred();f.store.entered=deferred();const attack=f.world.attack(f.player,1,'dying');await f.store.entered.promise;
  f.world.kill(f.player,null);f.store.gate.resolve();assert.equal(await attack,false);await f.player._queue;
  const bag=[...f.store.drops.values()][0];assert.equal(bag.metadata.items.find(i=>i.itemId===f.profiles.throw.weaponId).durability,23);assert.equal(f.world.maps.get(1).projectiles.size,0);
});

test('queued transfer or equipment discard invalidates a submitted attack before payment',async()=>{
  const f=await fixture();const weapon=await f.equip('throw');
  const transfer=f.world.transfer(f.player,2,1,5),attack=f.world.attack(f.player,1,'old-map');await transfer;assert.equal(await attack,false);assert.equal(equippedWeapon(f.player).durability,24);
  const drop=f.world.inventoryAction(f.player,{action:'drop',kind:'weapon',itemId:weapon.itemId,instanceId:weapon.instanceId,quantity:1,requestId:'discard'}),after=f.world.attack(f.player,1,'old-equip');await drop;assert.equal(await after,false);assert.equal([...f.store.drops.values()][0].metadata.durability,24);
});

test('a lost COMMIT response recovers paid MP and weapon wear before any later save or retry',async()=>{
  const f=await fixture();await f.equip('staff');f.player.mp=12;
  const commit=f.store.commitPlayer.bind(f.store);let lost=true;
  f.store.commitPlayer=async(...args)=>{const response=await commit(...args);if(lost){lost=false;throw Object.assign(new Error('lost commit response'),{economyUncertain:true});}return response;};
  await assert.rejects(f.world.attack(f.player,1,'uncertain'),/lost commit response/);
  assert.equal(f.player.mp,8);assert.equal(equippedWeapon(f.player).durability,29);assert.equal(f.world.maps.get(1).projectiles.size,0);
  await f.world.persist(f.player);assert.equal(f.store.states.get(f.player.id).mp,8);
  f.advance();assert.equal(await f.world.attack(f.player,1,'uncertain'),false);assert.equal(f.player.mp,8);assert.equal(equippedWeapon(f.player).durability,29);
});

test('database normalization preserves legitimate per-item metadata and rejects corrupt durability',()=>{
  const store=new MySqlStore(),weapon={kind:'weapon',itemId:61,quantity:1,instanceId:randomUUID(),durability:7,maxDurability:24};
  assert.deepEqual(store.normalizeState({inventory:[weapon]}).inventory,[weapon]);
  assert.deepEqual(store.normalizeDrop({kind:'bag',mapId:1,x:2,y:3,itemId:0,quantity:1,metadata:{items:[weapon]}}).metadata.items,[weapon]);
  assert.throws(()=>store.normalizeState({inventory:[{...weapon,durability:25}]}),/durability/);
});

test('developer loadout saves usable normalized weapons and repeated grants never refresh existing wear',async()=>{
  const f=await fixture();f.world.devTools=true;const worn=await f.equip('throw');
  await f.world.attack(f.player,1,'wear-before-loadout');assert.equal(equippedWeapon(f.player).durability,23);
  await f.world.developer(f.player,'loadout');
  assert.ok(f.player.inventory.some(i=>i.kind==='item'&&i.itemId===7&&i.quantity===10));
  assert.ok(f.player.inventory.some(i=>i.kind==='weapon'&&i.itemId===1&&i.instanceId));
  const saved=f.store.states.get(f.player.id),identities=f.player.inventory.filter(i=>i.kind==='weapon').map(i=>i.instanceId);
  for(const profile of Object.values(f.profiles)){
    const weapon=saved.inventory.find(i=>i.kind==='weapon'&&i.itemId===profile.weaponId);assert.ok(weapon?.instanceId);assert.equal(weapon.quantity,1);
    if(profile.maxDurability){assert.equal(weapon.maxDurability,profile.maxDurability);assert.equal(weapon.durability,profile.mode==='throw'?23:profile.maxDurability);}
  }
  await f.world.developer(f.player,'loadout');
  assert.deepEqual(f.player.inventory.filter(i=>i.kind==='weapon').map(i=>i.instanceId),identities);
  assert.equal(f.player.inventory.find(i=>i.instanceId===worn.instanceId).durability,23);
  for(const mode of ['throw','firearm','staff','club']){
    f.advance();const weapon=f.player.inventory.find(i=>i.kind==='weapon'&&i.itemId===f.profiles[mode].weaponId);
    await f.world.equip(f.player,'weapon',weapon.itemId,weapon.instanceId);assert.equal(await f.world.attack(f.player,1,`dev-${mode}`),true);
  }
  assert.equal(f.player.inventory.find(i=>i.instanceId===worn.instanceId).durability,22);
  assert.equal(f.player.inventory.find(i=>i.kind==='item'&&i.itemId===f.profiles.firearm.ammoItemId).quantity,9);
});
