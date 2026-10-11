import test from 'node:test';
import assert from 'node:assert/strict';
import {ChatLog,CHAT_HISTORY_LIMIT} from './chat.mjs';
const packet=(id,extra={})=>({type:'chat',id,senderId:'sender',senderName:'<b>Alice</b>',text:'<img src=x> \\C[2]',channel:'global',mapId:1,instanceId:null,createdAt:100,...extra});

test('chat log preserves literal text, deduplicates and bounds retained history',()=>{
  const log=new ChatLog();log.updateSnapshot({playerId:'self',mapId:1});
  assert.equal(log.receive(packet('one')).text,'<img src=x> \\C[2]');assert.equal(log.receive(packet('one')),null);
  for(let i=0;i<CHAT_HISTORY_LIMIT+1;i++)log.receive(packet(`id-${i}`));assert.equal(log.messages.length,CHAT_HISTORY_LIMIT);assert.equal(log.messages[0].id,'id-1');
  log.updateSnapshot({playerId:'other',mapId:1});assert.equal(log.messages.length,0);
});
test('chat log rejects stale map/instance packets and malformed channels',()=>{
  const log=new ChatLog();assert.equal(log.receive(packet('none')),null);log.updateSnapshot({playerId:'self',mapId:1,instance:{id:'first'}});
  assert.equal(log.receive(packet('public')),null);assert.equal(log.receive(packet('wrong',{instanceId:'second',channel:'instance'})),null);
  assert.equal(log.receive(packet('map',{instanceId:'first',channel:'map',mapId:2})),null);assert.ok(log.receive(packet('team',{instanceId:'first',channel:'instance',mapId:2})));
  assert.equal(log.receive(packet('invalid',{instanceId:'first',channel:'admin'})),null);
});
