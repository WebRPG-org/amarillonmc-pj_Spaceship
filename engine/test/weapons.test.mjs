import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {loadContent} from '../server/content.mjs';
import {World} from '../server/world.mjs';
import {normalizeWeapons,equippedWeapon} from '../server/weapons.mjs';
import {addInventory} from '../server/combat.mjs';
import {MySqlStore} from '../server/persistence.mjs';

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
  const f=await fixture();assert.equal(f.content.weaponProfiles.size,4);
  for(const [index,p]of [...f.content.weaponProfiles.values()].entries()){
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
