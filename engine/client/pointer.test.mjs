import test from 'node:test';
import assert from 'node:assert/strict';
import {PointerGesture, pointerCommand, weaponDetails} from './pointer.mjs';

test('map pointing submits targets, never direct movement or remote item pickup', () => {
  const snapshot={playerId:'me',pvp:false,events:[{id:'npc',x:3,y:2,image:{characterName:'People1'}},{id:'enemy',enemyId:1,hp:5,x:7,y:2}],drops:[{id:'bag',x:9,y:5}],players:[{id:'me',x:1,y:1},{id:'other',x:4,y:4}]};
  assert.deepEqual(pointerCommand({x:2.2,y:1.8},snapshot),{type:'navigate',x:2,y:1});
  assert.deepEqual(pointerCommand({x:3.5,y:2.5},snapshot),{type:'navigate',x:3,y:2,targetId:'npc'});
  assert.deepEqual(pointerCommand({x:9.5,y:5.5},snapshot,{requestId:'claim'}),{type:'navigate',x:9,y:5,entityId:'bag',requestId:'claim'});
  assert.deepEqual(pointerCommand({x:7.5,y:2.5},snapshot,{skillId:5,requestId:'attack'}),{type:'navigate',x:7,y:2,targetId:'enemy',skillId:5,requestId:'attack'});
  assert.equal(pointerCommand({x:4.5,y:4.5},snapshot).targetPlayerId,undefined);
  assert.equal(pointerCommand({x:4.5,y:4.5},{...snapshot,pvp:true}).targetPlayerId,'other');
  assert.equal(pointerCommand({x:Infinity,y:1},snapshot),null);
});

test('erased or disabled events cannot steal pointer selection from ground or loot',()=>{
  const snapshot={events:[{id:'bad',x:1,y:1,disabled:true},{id:'gone',x:1,y:1,erased:true}],drops:[{id:'loot',x:1,y:1}]};
  assert.equal(pointerCommand({x:1.5,y:1.5},snapshot).entityId,'loot');
  assert.deepEqual(pointerCommand({x:2.5,y:2.5},{events:[{id:'portal',x:2,y:2,image:{}}]}),{type:'navigate',x:2,y:2});
});

test('two-finger cancellation suppresses both release clicks while a later single tap works',()=>{
  const gesture=new PointerGesture(), p=(id,x=10)=>({pointerId:id,button:0,clientX:x,clientY:15});
  assert.equal(gesture.down(p(1)),null);assert.deepEqual(gesture.held(),{x:10,y:15});
  assert.deepEqual(gesture.down(p(2)),{kind:'cancel'});assert.equal(gesture.held(),null);
  assert.equal(gesture.up(p(1)),null);assert.equal(gesture.up(p(2)),null);
  gesture.down(p(3));gesture.move(p(3,25));assert.deepEqual(gesture.held(),{x:25,y:15});
  assert.deepEqual(gesture.up(p(3,25)),{kind:'navigate',x:25,y:15});
  gesture.down(p(4));assert.deepEqual(gesture.down({...p(5),button:2}),{kind:'cancel'});assert.equal(gesture.up(p(4)),null);
});

test('weapon display preserves individual durability and reports real shared ammo quantity',()=>{
  const profile={mode:'gun',range:8,ammoItemId:9,ammoCost:2,maxDurability:30};
  const text=weaponDetails({durability:8,maxDurability:30},profile,[{kind:'item',itemId:9,quantity:3},{kind:'weapon',itemId:9,quantity:1}],()=> '子弹');
  assert.match(text,/枪械 · 距离 8 格/);assert.match(text,/子弹 2（持有 3）/);assert.match(text,/耐久 8 \/ 30/);
  assert.match(weaponDetails({durability:0,maxDurability:30},profile),/已损坏/);
  assert.match(weaponDetails({durability:5},{mode:'staff',range:4,mpCost:3,durabilityCost:1}),/耐久 1 \/ MP 3/);
});
