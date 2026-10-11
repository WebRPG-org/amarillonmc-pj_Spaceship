import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {createApplication} from '../server/index.mjs';

// This fixture exercises the real HTTP and WebSocket handlers without a database.
class MemoryStore{
  constructor(){this.states=new Map();this.accounts=new Map();}
  async init(){}
  async close(){}
  async abortUnfinishedRounds(){return[];}
  async listDrops(){return[];}
  async loadProfile(){return{offlineBehavior:'stay'};}
  async login(username,password){
    if(password!=='protocol-fixture-password')throw new Error('密码错误');
    const account={id:`account:${username}`,username};this.accounts.set(account.id,account);return account;
  }
  async loadPlayer(id){const account=this.accounts.get(id);return account?{...account,state:structuredClone(this.states.get(id)||{mapId:40,x:20,y:23,direction:6})}:null;}
  async savePlayer(id,state){this.states.set(id,structuredClone(state));}
}
const command=(code,parameters=[])=>({code,parameters,indent:0});
async function client(base,token){
  const ws=new WebSocket(`${base.replace('http:','ws:')}/ws?token=${token}`),messages=[];
  ws.on('message',raw=>messages.push(JSON.parse(raw.toString())));ws.on('error',()=>{});await once(ws,'open');
  const result={ws,messages,send:message=>ws.send(JSON.stringify({contextInstanceId:null,...message})),
    async wait(predicate,after=0){const deadline=Date.now()+4000;while(Date.now()<deadline){const packet=messages.slice(after).find(predicate);if(packet)return packet;await delay(10);}assert.fail(`Expected protocol packet; received types: ${messages.slice(after).map(m=>m.type).join(', ')}`);},
    async close(){if(ws.readyState===WebSocket.CLOSED)return;const closed=once(ws,'close');ws.close();await closed;}};
  await result.wait(message=>message.type==='snapshot');return result;
}

test('real HTTP and authenticated WebSockets carry chat and authored text presentation', {timeout:15000}, async t=>{
  const app=await createApplication({store:new MemoryStore()}),clients=[];
  try{
    const rawText='\\N<通信测试员>\\C[17]控制符保持原样\\C[0]：\\V[1] \\I[64] \\Wave[0.5,4]波浪\\ResetShake';
    const popupText='头顶弹窗 \\V[1]',gabText='\\C[3]仅本人可见的 Gab';
    const map=app.content.getMap(40);
    map.events.push({id:900,name:'通信测试员',x:21,y:23,pages:[{conditions:{},image:{characterName:'People1',characterIndex:0,direction:2,pattern:1},priorityType:1,through:false,trigger:0,list:[
      command(108,['<Name: 通信测试员>']),command(408,['<Is Quest>']),command(122,[1,1,0,0,42]),
      command(356,['MessageRows 2']),command(356,['MessageWidth 420']),command(356,['MessagePositionX 123']),command(356,['MessageAnchorX right']),
      command(356,['HideChoice 2']),command(356,['DisableChoice 3']),
      command(356,[`GabText ${gabText}`]),command(356,['GabSpriteName People1']),command(356,['GabSpriteIndex 2']),command(356,['ShowGab']),
      command(356,[`EventPopup popup this ${popupText}`]),
      command(101,['Actor1',2,1,0]),command(401,[rawText]),command(102,[['\\C[3]继续','隐藏','禁用'],-2,0,2,0]),command(0)
    ]}]});
    app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base=`http://127.0.0.1:${app.server.address().port}`;
    await t.test('content endpoint exposes all text plugin configuration and unauthenticated upgrades fail',async()=>{
      const response=await fetch(`${base}/api/content`);assert.equal(response.status,200);const content=await response.json();
      for(const key of ['messageCore','extended1','extended2','shaking','fonts','gab','popup'])assert.ok(Object.hasOwn(content.textConfig,key),key);
      assert.equal(content.textConfig.popup['Popup Width'],'200');assert.ok(content.textConfig.fonts['Font Filenames']);
      const unauthorized=new WebSocket(`${base.replace('http:','ws:')}/ws?token=invalid`);
      const error=await new Promise((resolve,reject)=>{unauthorized.once('error',resolve);unauthorized.once('open',()=>{unauthorized.terminate();reject(new Error('Unauthenticated socket opened'));});});
      assert.match(error.message,/401/);
    });
    async function session(username){const response=await fetch(`${base}/api/session`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'login',username,password:'protocol-fixture-password'})});assert.equal(response.status,200);return response.json();}
    const aliceAccount=await session('Alice'),bobAccount=await session('Bob');
    const alice=await client(base,aliceAccount.token);clients.push(alice);const bob=await client(base,bobAccount.token);clients.push(bob);
    await t.test('chat authenticates the sender, broadcasts literal text and includes a same-map bubble snapshot',async()=>{
      const text='<img src=x onerror=alert(1)> \\C[2] 玩家消息';
      alice.send({type:'chat',channel:'global',text,senderId:bobAccount.playerId,senderName:'Admin',mapId:999,instanceId:'forged'});
      const [own,peer]=await Promise.all([alice.wait(m=>m.type==='chat'),bob.wait(m=>m.type==='chat')]);
      assert.deepEqual(peer,own);assert.equal(peer.senderId,aliceAccount.playerId);assert.equal(peer.senderName,'Alice');assert.equal(peer.mapId,40);assert.equal(peer.instanceId,null);assert.equal(peer.text,text);
      const snapshot=await bob.wait(m=>m.type==='snapshot'&&m.players.some(p=>p.id===aliceAccount.playerId&&p.chatBubble?.id===peer.id));
      const bubble=snapshot.players.find(p=>p.id===aliceAccount.playerId).chatBubble;
      assert.equal(bubble.text,text);assert.equal(bubble.y,-42);assert.ok(bubble.expiresAt>bubble.createdAt);assert.equal(snapshot.chat.maxLength,280);
    });
    await t.test('malformed chat returns an error notice without broadcasting a message',async()=>{
      const marker=alice.messages.length,aliceCount=alice.messages.filter(m=>m.type==='chat').length,bobCount=bob.messages.filter(m=>m.type==='chat').length;
      alice.send({type:'chat',text:{html:'not a string'}});const error=await alice.wait(m=>m.type==='notice'&&/聊天内容格式无效/.test(m.message),marker);
      assert.match(error.message,/无效/);assert.equal(alice.messages.filter(m=>m.type==='chat').length,aliceCount);assert.equal(bob.messages.filter(m=>m.type==='chat').length,bobCount);
    });
    await t.test('editor Show Text stays raw with context and choices while Gab is private and popup broadcasts',async()=>{
      const player=app.host.getPlayer(aliceAccount.playerId),event=[...app.world.maps.get(40).events.values()].find(entry=>entry.eventId===900);
      await player._queue;assert.ok(event);const aliceMarker=alice.messages.length,bobMarker=bob.messages.length;assert.equal(app.world.events.start(player,event),true);
      const [dialogue,gab,popup,peerPopup]=await Promise.all([
        alice.wait(m=>m.type==='dialogue'&&!m.close,aliceMarker),alice.wait(m=>m.type==='gab'&&m.action==='show',aliceMarker),
        alice.wait(m=>m.type==='eventEffect'&&m.code==='popup',aliceMarker),bob.wait(m=>m.type==='eventEffect'&&m.code==='popup',bobMarker)
      ]);
      assert.equal(dialogue.text,rawText);assert.equal(dialogue.eventId,event.id);assert.equal(dialogue.textContext.variables[1],42);assert.equal(dialogue.textContext.actors[1].name,'Alice');
      assert.equal(dialogue.messageSettings.faceName,'Actor1');assert.equal(dialogue.messageSettings.faceIndex,2);assert.equal(dialogue.messageSettings.background,1);assert.equal(dialogue.messageSettings.positionType,0);
      assert.equal(dialogue.messageSettings.rows,2);assert.equal(dialogue.messageSettings.width,420);assert.equal(dialogue.messageSettings.x,123);assert.equal(dialogue.messageSettings.anchorX,1);
      assert.deepEqual(dialogue.choices,['\\C[3]继续','隐藏','禁用']);assert.equal(dialogue.choiceMetadata[1].hidden,true);assert.equal(dialogue.choiceMetadata[2].disabled,true);
      assert.equal(gab.text,gabText);assert.equal(gab.graphicType,'character');assert.equal(gab.graphicName,'People1');assert.equal(gab.graphicIndex,2);assert.ok(gab.durationFrames>0);
      assert.deepEqual(popup,peerPopup);assert.equal(popup.text,popupText);assert.equal(popup.textContext.variables[1],42);assert.equal(popup.mapId,40);assert.equal(popup.eventId,event.id);assert.equal(popup.options.duration,200);
      assert.equal(bob.messages.slice(bobMarker).some(m=>m.type==='gab'||m.type==='dialogue'),false);
      const snapshot=await alice.wait(m=>m.type==='snapshot'&&m.events.some(e=>e.id===event.id&&e.overhead?.quest),aliceMarker);assert.equal(snapshot.events.find(e=>e.id===event.id).overhead.text,'通信测试员');
    });
  }finally{await Promise.all(clients.map(connection=>connection.close()));await app.close();}
});
