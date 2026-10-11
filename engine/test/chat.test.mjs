import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {ChatService,CHAT_LIMITS,chatSettings,normalizeChatText} from '../server/chat.mjs';
import {World,cloneState} from '../server/world.mjs';
import {GameHost} from '../server/instances.mjs';
import {loadContent} from '../server/content.mjs';
import {PUBLIC_CITY_SERVICES,PUBLIC_CITY_SPAWN} from '../server/public-city.mjs';

class MemoryStore{
  constructor(){this.states=new Map();this.rounds=new Map();}
  async savePlayer(id,state){this.states.set(id,structuredClone(state));}
  async loadPlayer(id){return{id,username:`User ${id}`,state:structuredClone(this.states.get(id)||{})};}
  async listDrops(){return[];}
  async loadProfile(){return{};}
  async createRound(data){this.rounds.set(data.id,{...data,store:new MemoryStore()});}
  forRound(id){return this.rounds.get(id).store;}
  async joinRound(id,playerId,state){await this.forRound(id).savePlayer(playerId,state);return{id:playerId,username:`User ${playerId}`,state};}
  async leaveRound(){return{};}
  async finishRound(id,result){return{result};}
}
async function fixture(){
  const content=await loadContent(fileURLToPath(new URL('../../',import.meta.url))),store=new MemoryStore(),messages=new Map();let time=100000;
  const host=new GameHost({content,store,clock:()=>time});await host.init();
  async function connect(id){messages.set(id,[]);const p=await host.connect(await store.loadPlayer(id),packet=>messages.get(id).push(packet)),entry=PUBLIC_CITY_SERVICES.instance;await host.world.transfer(p,entry.mapId,entry.x,entry.y+1);return p;}
  const send=(id,message={})=>host.command(host.getPlayer(id),{type:'chat',text:'hello',contextInstanceId:host.locations.get(id)?.id||null,...message});
  const chats=id=>messages.get(id).filter(message=>message.type==='chat');
  return{content,store,host,messages,connect,send,chats,advance:ms=>{time+=ms;},now:()=>time};
}

test('chat validates text and preserves HTML and event controls as literal player input',()=>{
  assert.equal(normalizeChatText('  你好\n世界\u001b\u202e  '),'你好 世界');
  assert.equal(normalizeChatText('<img src=x onerror=alert(1)> \\C[2] \\V[1]'),'<img src=x onerror=alert(1)> \\C[2] \\V[1]');
  assert.equal([...normalizeChatText('😀'.repeat(280))].length,280);
  assert.throws(()=>normalizeChatText('😀'.repeat(281)),/最多/);
  for(const value of [null,123,{},' \n\t\u0000 ','x'.repeat(4097)])assert.throws(()=>normalizeChatText(value));
});

test('chat derives identities, delivers public global messages and restricts map messages',async()=>{
  const f=await fixture(),a=await f.connect('alice'),b=await f.connect('bob'),c=await f.connect('charlie');
  await f.host.world.transfer(c,PUBLIC_CITY_SPAWN.mapId,PUBLIC_CITY_SPAWN.x,PUBLIC_CITY_SPAWN.y);
  const result=await f.send(a.id,{senderId:'fake',senderName:'Admin',mapId:99,createdAt:0,instanceId:'fake',text:'公共消息'});
  assert.equal(result.senderId,a.id);assert.equal(result.senderName,'User alice');assert.equal(result.createdAt,f.now());assert.equal(result.mapId,a.mapId);assert.equal(result.instanceId,null);
  for(const p of [a,b,c])assert.equal(f.chats(p.id).length,1);
  f.advance(801);await f.send(a.id,{channel:'map',text:'同地图消息'});
  assert.equal(f.chats(a.id).length,2);assert.equal(f.chats(b.id).length,2);assert.equal(f.chats(c.id).length,1);
  await assert.rejects(f.send(a.id,{channel:'instance'}),/不在副本/);
  await assert.rejects(f.send(a.id,{channel:'admin'}),/未知聊天频道/);
});

test('waiting instances can chat across their maps but never leak to another instance or public world',async()=>{
  const f=await fixture();for(const id of ['a','b','c','d'])await f.connect(id);
  const instanceCommand=(id,message)=>f.host.command(f.host.getPlayer(id),{type:'instance',contextInstanceId:f.host.locations.get(id)?.id||null,...message});
  await instanceCommand('a',{action:'create',mode:'pve'});const first=f.host.locations.get('a');await instanceCommand('b',{action:'join',instanceId:first.id});await instanceCommand('c',{action:'create',mode:'pve'});
  assert.equal(first.status,'waiting');const b=f.host.getPlayer('b');await first.world.transfer(b,12,1,1);
  await f.send('a',{text:'副本团队消息'});assert.equal(f.chats('a').length,1);assert.equal(f.chats('b').length,1);assert.equal(f.chats('c').length,0);assert.equal(f.chats('d').length,0);
  f.advance(801);await f.send('a',{channel:'map'});assert.equal(f.chats('a').length,2);assert.equal(f.chats('b').length,1);
  await f.send('d',{channel:'global'});assert.equal(f.chats('a').length,2);assert.equal(f.chats('c').length,0);assert.equal(f.chats('d').length,1);
  await assert.rejects(f.send('a',{channel:'global'}),/副本内/);
  await assert.rejects(f.send('a',{contextInstanceId:'old-round'}),/旧世界/);
});

test('rate limits survive reconnect and world switches and release after their rolling window',async()=>{
  const f=await fixture(),p=await f.connect('a');await f.send('a');
  await assert.rejects(f.send('a'),/发送太快/);
  await f.host.disconnect(p.id);await f.host.connect(await f.store.loadPlayer(p.id),packet=>f.messages.get(p.id).push(packet));await assert.rejects(f.send('a'),/发送太快/);
  await f.host.command(f.host.getPlayer('a'),{type:'instance',action:'create',mode:'pve',contextInstanceId:null});await assert.rejects(f.send('a'),/发送太快/);
  for(let i=1;i<CHAT_LIMITS.windowMessages;i++){f.advance(800);await f.send('a');}
  f.advance(800);await assert.rejects(f.send('a'),/过于频繁/);f.advance(CHAT_LIMITS.windowMs);await f.send('a');
});

test('chat bubbles follow the authenticated player, replace prior text, expire and never persist',async()=>{
  const f=await fixture(),p=await f.connect('a');await f.connect('b');const first=await f.send('a',{text:'first'}),world=f.host.world;
  let bubble=world.snapshot(p).players.find(entry=>entry.id===p.id).chatBubble;
  assert.equal(bubble.text,'first');assert.equal(bubble.y,-42);assert.equal(bubble.expiresAt,first.expiresAt);assert.equal(bubble.expiresAt-bubble.createdAt,4500);assert.equal(cloneState(p)._chatBubble,undefined);
  f.advance(801);await f.send('a',{text:'second'});bubble=world.snapshot(p).players.find(entry=>entry.id===p.id).chatBubble;assert.equal(bubble.text,'second');
  f.advance(4500);assert.equal(world.snapshot(p).players.find(entry=>entry.id===p.id).chatBubble,null);
  await f.send('a');await world.transfer(p,PUBLIC_CITY_SPAWN.mapId,PUBLIC_CITY_SPAWN.x,PUBLIC_CITY_SPAWN.y);assert.equal(world.snapshot(p).players.find(entry=>entry.id===p.id).chatBubble,null);
  f.advance(801);await f.send('a');await f.host.disconnect('a');assert.equal(p._chatBubble,undefined);
});

test('standalone World chat rejects unregistered and disconnected entities',async()=>{
  const f=await fixture(),world=new World({content:f.content,store:new MemoryStore(),clock:f.now}),messages=[];
  const player=await world.connect({id:'a',username:'Alice'},message=>messages.push(message));
  await assert.rejects(world.command({...player},{type:'chat',text:'forged'}),/当前角色/);
  await world.command(player,{type:'chat',text:'hello'});assert.equal(messages.filter(m=>m.type==='chat').length,1);
  await world.disconnect(player.id);assert.throws(()=>world.chat.send(world,player,{text:'offline'}),/当前角色/);
});

test('popup configuration imports frame durations and clamps unsafe geometry',()=>{
  const config=chatSettings({plugins:[{name:'MMO_ChatBox',parameters:{chatPosition:'TOP RIGHT'}},{name:'MMO_iavra_event_popup',parameters:{'Popup Width':'300','Offset Y':'-99','Display Duration':'60','Fade In Duration':'0','Fade Out Duration':'30','Font Size':'900'}}]});
  assert.equal(config.position,'TOP RIGHT');assert.equal(config.popup.width,300);assert.equal(config.popup.y,-42);assert.equal(config.popup.duration,1000);assert.equal(config.popup.fadeIn,0);assert.equal(config.popup.fadeOut,500);assert.equal(config.popup.fontSize,72);
});
