import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {MySqlStore} from '../server/persistence.mjs';
import {loadContent} from '../server/content.mjs';
import {World} from '../server/world.mjs';
import {equippedWeapon} from '../server/weapons.mjs';

test('MySQL preserves individual weapon wear, atomic ammunition/MP costs and death-bag ownership across reopening', {skip:process.env.MYSQL_TEST!=='1',timeout:30000},async()=>{
  const env=Object.fromEntries((await readFile(new URL('../.env',import.meta.url),'utf8')).split(/\r?\n/).filter(s=>/^[A-Z_]+=/.test(s)).map(s=>[s.slice(0,s.indexOf('=')),s.slice(s.indexOf('=')+1)]));
  assert.equal(env.MYSQL_HOST,'127.0.0.1');assert.equal(env.MYSQL_PORT,'3317');assert.equal(env.MYSQL_DATABASE,'spaceship_engine');
  const options={host:env.MYSQL_HOST,port:Number(env.MYSQL_PORT),user:env.MYSQL_USER,password:env.MYSQL_PASSWORD,database:env.MYSQL_DATABASE};
  const store=await new MySqlStore(options).init(),content=await loadContent(fileURLToPath(new URL('../../',import.meta.url))),ids=[],drops=[];let world;
  try{
    let now=100000;world=new World({content,store,clock:()=>now,random:()=>.5});
    const prefix=`weapon_${randomBytes(5).toString('hex')}`,a=await store.register(prefix+'_a','weapon-test-123'),b=await store.register(prefix+'_b','weapon-test-123');ids.push(a.id,b.id);
    const player=await world.connect(a,()=>{}),other=await world.connect(b,()=>{});other.mapId=player.mapId;other.x=player.x;other.y=player.y;
    const profiles=Object.fromEntries([...content.weaponProfiles.values()].map(p=>[p.mode,p]));
    for(const profile of Object.values(profiles))await world.grant(player,'weapon',profile.weaponId,1);
    await world.grant(player,'weapon',profiles.throw.weaponId,1);await world.grant(player,'item',profiles.firearm.ammoItemId,3);
    const pieces=player.inventory.filter(i=>i.kind==='weapon'&&i.itemId===profiles.throw.weaponId),worn=pieces[0];
    await world.equip(player,'weapon',worn.itemId,worn.instanceId);assert.equal(await world.attack(player,1,'durability-once'),true);assert.equal(equippedWeapon(player).durability,23);
    now+=2000;world.now=now;assert.equal(await world.attack(player,1,'durability-once'),false);assert.equal(equippedWeapon(player).durability,23);
    await world.inventoryAction(player,{action:'drop',kind:'weapon',itemId:worn.itemId,instanceId:worn.instanceId,quantity:1,requestId:'drop-worn'});
    const drop=[...world.maps.get(player.mapId).drops.values()].find(d=>d.metadata.instanceId===worn.instanceId);assert.ok(drop);drops.push(drop.id);
    await world.pickup(other,drop.id,'claim-worn');assert.equal(other.inventory.find(i=>i.instanceId===worn.instanceId).durability,23);
    await world.equip(player,'weapon',profiles.firearm.weaponId);now+=2000;world.now=now;
    assert.equal(await world.attack(player,1,'ammo-once'),true);assert.equal(player.inventory.find(i=>i.kind==='item'&&i.itemId===profiles.firearm.ammoItemId).quantity,2);
    await world.equip(player,'weapon',profiles.staff.weaponId);player.mp=12;now+=2000;world.now=now;assert.equal(await world.attack(player,1,'magic-once'),true);assert.equal(player.mp,8);
    const staffId=equippedWeapon(player).instanceId;
    world.kill(player,null);await player._queue;const bag=[...world.maps.get(player.mapId).drops.values()].find(d=>d.kind==='bag'&&d.metadata.ownerId===player.id);assert.ok(bag);drops.push(bag.id);
    await world.pickup(other,bag.id,'claim-bag');await world.close();world=null;
    const reopened=await new MySqlStore(options).init();
    try{
      const restored=(await reopened.loadPlayer(other.id)).state;
      assert.equal(restored.inventory.find(i=>i.instanceId===worn.instanceId).durability,23);
      assert.equal(restored.inventory.find(i=>i.instanceId===pieces[1].instanceId).durability,24);
      assert.equal(restored.inventory.find(i=>i.instanceId===staffId).durability,29);
      assert.equal(restored.inventory.find(i=>i.kind==='item'&&i.itemId===profiles.firearm.ammoItemId).quantity,2);
      assert.equal((await reopened.loadPlayer(player.id)).state.mp,8);
      assert.equal((await reopened.loadPlayer(player.id)).state.dead,true);
    }finally{await reopened.close();}
  }finally{
    if(world)await world.close();
    for(const id of drops)await store.pool.execute('DELETE FROM world_drops WHERE id = ?',[id]);
    for(const id of ids)await store.pool.execute('DELETE FROM players WHERE id = ?',[id]);
    await store.close();
  }
});
