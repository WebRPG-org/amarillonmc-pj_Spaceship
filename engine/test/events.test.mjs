import test from 'node:test';
import assert from 'node:assert/strict';
import { EventRuntime, evaluateExpression } from '../server/events.mjs';
import {classifyScript,classifyCommand} from '../server/content.mjs';
import {parseTextScript} from '../server/text-events.mjs';

const cmd=(code,parameters=[],indent=0)=>({code,parameters,indent});
function fixture(list=[],extra={}){
  const player={id:'p1',name:'Explorer',mapId:1,x:1,y:1,hp:40,maxHp:100,mp:10,maxMp:30,level:1,gold:0,inventory:[],skills:[],equips:{},switches:{},variables:{},selfSwitches:{},stats:{atk:10},...extra};
  const other={...player,id:'p2',switches:{},variables:{},selfSwitches:{}};
  const event={id:1,eventId:1,mapId:1,x:2,y:1,pages:[{conditions:{},trigger:0,list}]};
  const messages=[],notices=[],usedTools=[];
  const content={database:{CommonEvents:[],Actors:[null,{name:'Actor'}],System:{}},recipes:[],getMap:()=>({id:1,width:10,height:10,data:[]}),isPassable:()=>true,findSpawn:(id,x,y)=>({x,y}),wrapPosition:(id,x,y)=>({x,y})};
  const world={players:new Map([[player.id,player],[other.id,other]]),maps:new Map([[1,{id:1,events:new Map([[1,event]])}]]),send:(id,msg)=>messages.push({id,...msg}),notice:(p,msg)=>notices.push(msg),broadcast:()=>{},getVariable:(p,id)=>p.variables[id]??0,setVariable:(p,id,v)=>p.variables[id]=v,getSwitch:(p,id)=>p.switches[id]??false,setSwitch:(p,id,v)=>p.switches[id]=v,transfer:(p,mapId,x,y)=>Object.assign(p,{mapId,x,y}),grant:(p,kind,id,n)=>{if(kind==='gold')p.gold+=n;else{let item=p.inventory.find(x=>x.kind===kind&&x.itemId===id);if(!item){item={kind,itemId:id,quantity:0};p.inventory.push(item);}item.quantity+=n;}},spawnTemplate:()=>{},useTool:(actor,id)=>usedTools.push({actor,id}),random:()=>.5};
  const runtime=new EventRuntime({content,world});
  return{player,other,event,content,world,runtime,messages,notices,usedTools};
}

test('expression parser supports current arithmetic without executing JavaScript',()=>{
  assert.equal(evaluateExpression('Math.round(($gameVariables.value(1) / 7) * 100)',{variable:()=>3}),43);
  assert.equal(evaluateExpression('2 + 3 * 4 >= 14 && !false'),true);
  assert.equal(evaluateExpression('Math.randomInt(600)',{random:()=>.5}),300);
  for(const source of ['process.exit()','globalThis.x=1','(1).constructor.constructor("return process")()','Math.random()','1/0'])assert.throws(()=>evaluateExpression(source));
});

test('break loop inside a condition exits the nearest loop and keeps the surrounding loop running',()=>{
  const f=fixture([
    cmd(112),cmd(122,[1,1,1,0,1],1),
    cmd(112,[],1),cmd(111,[0,1,0],2),cmd(113,[],3),cmd(412,[],2),cmd(122,[2,2,1,0,100],2),cmd(413,[],1),
    cmd(122,[2,2,1,0,1],1),cmd(111,[1,1,0,2,1],1),cmd(113,[],2),cmd(412,[],1),cmd(413),
    cmd(122,[3,3,0,0,42]),cmd(0)
  ],{switches:{1:true}});
  f.runtime.start(f.player,f.event);for(let i=0;i<10&&f.runtime.tasks.size;i++)f.runtime.update(.1);
  assert.equal(f.player.variables[1],2);assert.equal(f.player.variables[2],2);assert.equal(f.player.variables[3],42);assert.equal(f.runtime.tasks.size,0);assert.deepEqual(f.notices,[]);
});

test('break outside a loop diagnoses malformed authored commands instead of skipping the next branch',()=>{
  const f=fixture([cmd(113),cmd(122,[1,1,0,0,42]),cmd(0)]);f.runtime.start(f.player,f.event);
  assert.equal(f.player.variables[1],undefined);assert.match(f.notices[0],/no enclosing loop/);
});

test('text and choices suspend only the interaction and execute one selected branch',()=>{
  const f=fixture([cmd(101),cmd(401,['Choose']),cmd(102,[['Potion','Gold'],-1,0]),cmd(402,[0,'Potion']),cmd(126,[1,0,0,2],1),cmd(402,[1,'Gold']),cmd(125,[0,0,10],1),cmd(404),cmd(0)]);
  assert.equal(f.runtime.start(f.player,f.event),true);
  assert.deepEqual(f.messages.at(-1).choices,['Potion','Gold']);
  assert.equal(f.player.gold,0);
  assert.equal(f.runtime.choose(f.player,1),true);
  assert.equal(f.player.gold,10);assert.equal(f.player.inventory.length,0);
  assert.equal(f.runtime.tasks.size,0);
});

test('personal variables, self switches and event pages do not leak to another player',()=>{
  const f=fixture([cmd(121,[1,1,0]),cmd(122,[2,2,0,0,42]),cmd(123,['A',0]),cmd(0)]);
  f.event.pages.push({conditions:{selfSwitchValid:true,selfSwitchCh:'A'},trigger:0,list:[cmd(0)]});
  f.runtime.start(f.player,f.event);
  assert.equal(f.player.variables[2],42);assert.equal(f.other.variables[2],undefined);
  assert.equal(f.runtime.pageFor(f.player,f.event).index,1);
  assert.equal(f.runtime.pageFor(f.other,f.event).index,0);
});

test('server waits complete while client menu state is open',()=>{
  const f=fixture([cmd(230,[60]),cmd(125,[0,0,7]),cmd(0)]);
  f.player.menuOpen=true;f.runtime.start(f.player,f.event);
  f.runtime.update(.5);assert.equal(f.player.gold,0);
  f.runtime.update(.5);assert.equal(f.player.gold,7);
});

test('common events preserve branch context and reject recursive overflow',()=>{
  const f=fixture([cmd(111,[0,1,1]),cmd(117,[1],1),cmd(411),cmd(125,[0,0,99],1),cmd(412),cmd(0)]);
  f.content.database.CommonEvents[1]={id:1,list:[cmd(125,[0,0,3]),cmd(0)]};
  f.runtime.start(f.player,f.event);assert.equal(f.player.gold,3);
  f.content.database.CommonEvents[2]={id:2,list:[cmd(117,[2])]};
  f.event.pages[0].list=[cmd(117,[2])];f.runtime.start(f.player,f.event);
  assert.ok(f.notices.some(x=>x.includes('recursion limit')));
  assert.equal(f.runtime.tasks.size,0);
});

test('unknown scripts are diagnosed and never run subsequent grants',()=>{
  const f=fixture([cmd(355,['globalThis.PWNED = true;']),cmd(125,[0,0,1000])]);
  f.runtime.start(f.player,f.event);assert.equal(f.player.gold,0);assert.equal(globalThis.PWNED,undefined);
  assert.ok(f.notices.some(x=>x.includes('requires migration')));
});

test('movement waits are sequential and tool scripts act through server entities',()=>{
  const f=fixture([cmd(205,[0,{wait:true,repeat:false,list:[{code:15,parameters:[30]},{code:45,parameters:['this.act(99)']},{code:0}]}]),cmd(125,[0,0,2])]);
  f.runtime.start(f.player,f.event);assert.equal(f.usedTools.length,0);
  f.runtime.update(.5);assert.equal(f.usedTools[0].actor,f.event);assert.equal(f.usedTools[0].id,99);assert.equal(f.player.gold,2);
});

test('per-tick instruction budget prevents zero-wait label loops from monopolizing server',()=>{
  const f=fixture([cmd(118,['loop']),cmd(122,[1,1,1,0,1]),cmd(119,['loop'])]);
  f.runtime.start(f.player,f.event);const before=f.player.variables[1];
  f.runtime.update(.05);assert.ok(f.player.variables[1]>before);assert.ok(f.player.variables[1]<100);
  for(let i=0;i<300;i++)f.runtime.update(.05);
  assert.equal(f.runtime.tasks.size,0);assert.ok(f.notices.some(x=>x.includes('instruction budget')));
});

test('quarantined legacy multiplayer templates cannot run their shared-variable program',()=>{
  const f=fixture([cmd(125,[0,0,1000])]);f.event.pages[0].engineDisabledReason='Legacy PvP requires replacement';
  assert.equal(f.runtime.start(f.player,f.event),false);assert.equal(f.player.gold,0);assert.ok(f.notices.length);
});

test('runtime diagnostics are exposed and a disconnected player releases event routes',()=>{
  const f=fixture([cmd(205,[0,{wait:true,list:[{code:15,parameters:[600]},{code:0}]}])]);
  f.world.runtimeDiagnostics=new Map();f.runtime.start(f.player,f.event);
  assert.ok(f.event._eventRouteOwner);f.runtime.cancel(f.player);assert.equal(f.event._eventRouteOwner,undefined);
  f.event.pages[0].list=[cmd(999)];f.runtime.start(f.player,f.event);
  assert.ok([...f.world.runtimeDiagnostics.values()].some(x=>x.includes('Unsupported command 999')));
});

test('dynamic event copies have distinct personal self switches',()=>{
  const f=fixture([cmd(123,['A',0])]);const copy={...f.event,id:'dynamic-copy',eventId:1};
  f.runtime.start(f.player,copy);
  assert.equal(f.player.selfSwitches['1:dynamic-copy:A'],true);
  assert.equal(f.player.selfSwitches['1:1:A'],undefined);
});

test('server template adapter is idempotent across player-triggered copies',()=>{
  const f=fixture([cmd(355,['$gameMap.copyEventFrom(2, 3, 4, 5, true);'])]);let calls=0;
  f.world.spawnTemplate=()=>{calls++;const e={id:'spawned'};f.world.maps.get(1).events.set(e.id,e);return e;};
  f.runtime.start(f.player,f.event);f.runtime.start(f.other,f.event);assert.equal(calls,1);
});

test('growth commands store permanent modifiers and picture variables resolve before sending',()=>{
  const f=fixture([cmd(317,[0,1,2,0,0,5]),cmd(231,[1,'Picture',0,1,4,5,100,100,255,0])]);
  f.player.variables={4:120,5:240};f.runtime.start(f.player,f.event);
  assert.equal(f.player.paramPlus[2],5);const effect=f.messages.find(m=>m.type==='eventEffect');
  assert.deepEqual(effect.parameters.slice(3,6),[0,120,240]);
});

test('inventory promises suspend dependent conditions until the transaction commits',async()=>{
  const f=fixture([cmd(125,[0,0,10]),cmd(111,[7,10,0]),cmd(122,[1,1,0,0,99],1),cmd(412)]);let commit;
  f.world.grant=()=>{f.player._economyBusy=true;return new Promise(resolve=>{commit=()=>{f.player.gold=10;f.player._economyBusy=false;resolve();};});};
  f.runtime.start(f.player,f.event);f.runtime.update(.1);
  assert.equal(f.player.variables[1],undefined);assert.equal(f.runtime.tasks.get('p1:interactive').waiting.kind,'promise');
  commit();await Promise.resolve();f.runtime.update(.1);
  assert.equal(f.player.variables[1],99);assert.equal(f.runtime.tasks.size,0);
});

test('a rejected inventory commit ends the event without advancing rewards',async()=>{
  const f=fixture([cmd(125,[0,0,10]),cmd(122,[1,1,0,0,99])]);
  f.world.grant=()=>Promise.reject(new Error('Commit failed'));
  f.runtime.start(f.player,f.event);await Promise.resolve();f.runtime.update(.1);
  assert.equal(f.player.variables[1],undefined);assert.equal(f.runtime.tasks.size,0);
  assert.ok(f.notices.some(n=>n.includes('Commit failed')));
});

test('erase event is personal and temporary for the current map visit',()=>{
  const f=fixture([cmd(214)]);f.runtime.start(f.player,f.event);
  assert.equal(f.runtime.pageFor(f.player,f.event),null);assert.ok(f.runtime.pageFor(f.other,f.event));
  assert.deepEqual(f.player.selfSwitches,{});
  f.runtime.onTransfer(f.player);assert.ok(f.runtime.pageFor(f.player,f.event));
});

test('text adapters retain escape codes, face settings and all lines in small message windows',()=>{
  const f=fixture([cmd(356,['MessageRows 2']),cmd(356,['MessagePositionX 150']),cmd(356,['MessageAnchorX right']),cmd(356,['EnableWordWrap']),cmd(101,['Actor1',3,1,0]),...['\\C[3]Hello \\V[2]','\\N[1]','\\GOLD','last line'].map(text=>cmd(401,[text]))]);
  f.player.variables[2]=42;f.runtime.start(f.player,f.event);const message=f.messages.find(m=>m.type==='dialogue'&&!m.close);
  assert.equal(message.text,'\\C[3]Hello \\V[2]\n\\N[1]\n\\GOLD\nlast line');
  assert.equal(message.textContext.variables[2],42);assert.equal(message.textContext.actors[1].name,'Explorer');
  assert.deepEqual([message.messageSettings.faceName,message.messageSettings.faceIndex,message.messageSettings.background,message.messageSettings.positionType],['Actor1',3,1,0]);
  assert.equal(message.messageSettings.rows,2);assert.equal(message.messageSettings.x,150);assert.equal(message.messageSettings.anchorX,1);assert.equal(message.messageSettings.wordWrap,true);
  assert.equal(f.runtime.presentation.messageSettings(f.other).rows,4);
  assert.equal(f.runtime.presentation.messageSettings(f.other).width,null);
});

test('extended message rows merge compatible text blocks but preserve changed faces',()=>{
  const f=fixture([cmd(356,['MessageRows 6']),cmd(101,['A',0,0,2]),cmd(401,['one']),cmd(101,['A',0,0,2]),cmd(401,['two']),cmd(101,['B',0,0,2]),cmd(401,['three'])]);
  f.runtime.start(f.player,f.event);assert.equal(f.messages.at(-1).text,'one\ntwo');
  f.runtime.choose(f.player,0);assert.equal(f.messages.at(-1).text,'three');assert.equal(f.messages.at(-1).messageSettings.faceName,'B');
});

test('explicit letter sound commands revise client defaults even when resetting to the same values',()=>{
  const f=fixture([cmd(356,['EnableLetterSound']),cmd(356,['LetterSoundInterval 0']),cmd(101),cmd(401,['first']),cmd(356,['LetterSoundReset']),cmd(101),cmd(401,['second']),cmd(356,['LetterSoundName Cursor1']),cmd(101),cmd(401,['third'])]);
  f.runtime.start(f.player,f.event);let settings=f.messages.at(-1).messageSettings;assert.equal(settings.letterSoundRevision,2);assert.equal(settings.letterSound.interval,0);
  f.runtime.choose(f.player,0);settings=f.messages.at(-1).messageSettings;assert.equal(settings.letterSoundRevision,3);assert.equal(settings.letterSound.enabled,false);assert.equal(settings.letterSound.name,'Cursor1');
  f.runtime.choose(f.player,0);settings=f.messages.at(-1).messageSettings;assert.equal(settings.letterSoundRevision,4);assert.equal(settings.letterSound.name,'Cursor1');
});

test('choice visibility and disabled state are enforced by server using original indices',()=>{
  const f=fixture([cmd(356,['HideChoice 1']),cmd(355,['$gameSystem.disableChoice(2);']),cmd(102,[['Hidden','Disabled','Allowed'],-1,0]),cmd(402,[0]),cmd(125,[0,0,1],1),cmd(402,[1]),cmd(125,[0,0,2],1),cmd(402,[2]),cmd(125,[0,0,4],1),cmd(404)]);
  f.runtime.start(f.player,f.event);const message=f.messages.at(-1);
  assert.deepEqual(message.choiceMetadata,[{index:0,hidden:true,disabled:false},{index:1,hidden:false,disabled:true},{index:2,hidden:false,disabled:false}]);
  assert.equal(f.runtime.choose(f.player,0),false);assert.equal(f.runtime.choose(f.player,1),false);assert.equal(f.runtime.choose(f.player,2),true);assert.equal(f.player.gold,4);
});

test('cancellation cannot select a hidden or disabled choice but retains separate cancel branches',()=>{
  for(const plugin of ['HideChoice 1','DisableChoice 1']){
    const f=fixture([cmd(356,[plugin]),cmd(102,[['Restricted','Allowed'],0,1]),cmd(402,[0]),cmd(125,[0,0,99],1),cmd(402,[1]),cmd(125,[0,0,4],1),cmd(404)]);
    f.runtime.start(f.player,f.event);assert.equal(f.runtime.choose(f.player,-1),false);assert.equal(f.player.gold,0);assert.equal(f.runtime.dialogues.has(f.player.id),true);
    assert.equal(f.runtime.choose(f.player,1),true);assert.equal(f.player.gold,4);
  }
  const f=fixture([cmd(356,['DisableChoice 1']),cmd(102,[['Restricted'],-2,0]),cmd(402,[0]),cmd(125,[0,0,99],1),cmd(403),cmd(125,[0,0,7],1),cmd(404)]);
  f.runtime.start(f.player,f.event);assert.equal(f.runtime.choose(f.player,-1),true);assert.equal(f.player.gold,7);
});

test('overhead comments track the visible page and keep quest styling independent of tag order',()=>{
  const f=fixture([cmd(108,['<Is Quest>']),cmd(408,['<Name: Guide \\V[2]>'])]);f.player.variables[2]=7;
  let overhead=f.runtime.overheadFor(f.player,f.event);assert.equal(overhead.text,'Guide \\V[2]');assert.equal(overhead.quest,true);assert.equal(overhead.textContext.variables[2],7);
  f.event.pages.push({conditions:{switch1Valid:true,switch1Id:3},trigger:0,list:[cmd(108,['<Name: Done>'])]});
  f.player.switches[3]=true;assert.equal(f.runtime.overheadFor(f.player,f.event).text,'Done');assert.equal(f.runtime.overheadFor(f.other,f.event).text,'Guide \\V[2]');
  f.event.erased=true;assert.equal(f.runtime.overheadFor(f.player,f.event),null);
});

test('popup scripts parse literal options and escape strings without evaluating code',()=>{
  const source=String.raw`IAVRA.EVENTPOPUP.popup(this.eventId(), 'It\'s \\V[2]', {width:75, y:-50, fontSize:10, duration:30, fontName:'Test Font'});`;
  assert.deepEqual(parseTextScript(source),{kind:'popup',target:'this',text:"It's \\V[2]",options:{width:75,y:-50,fontSize:10,duration:30,fontName:'Test Font'}});
  assert.equal(classifyScript(source).status,'adapted');
  for(const source of ['IAVRA.EVENTPOPUP.popup(1, "x", {duration:process.exit()});','IAVRA.EVENTPOPUP.popup(1, "x", {__proto__:1});','IAVRA.EVENTPOPUP.popup(1, "x" + globalThis.PWNED);'])assert.equal(classifyScript(source).status,'unsupported');
  assert.equal(globalThis.PWNED,undefined);
});

test('popup targets use dynamic entity IDs, preserve options, and broadcast only map-scoped data',()=>{
  const f=fixture([cmd(355,['IAVRA.EVENTPOPUP.popup(this.eventId(),']),cmd(655,['"\\\\V[2] \\\\QI[1] \\\\caseSwitch{4?Y:N}", {width:75, duration:30});']),cmd(356,['EventPopup clean this'])]);
  f.event.id='dynamic:copy';f.player.variables={2:42,99:'private'};f.player.switches={4:true,88:true};f.player.inventory=[{kind:'item',itemId:1,quantity:3},{kind:'item',itemId:2,quantity:9}];
  const broadcasts=[];f.world.broadcast=(mapId,message)=>broadcasts.push({mapId,...message});
  f.runtime.start(f.player,f.event);assert.equal(f.notices.length,0);assert.equal(broadcasts.length,2);
  const popup=broadcasts[0];assert.equal(popup.eventId,'dynamic:copy');assert.equal(popup.mapId,1);assert.equal(popup.options.width,75);assert.equal(popup.options.duration,30);assert.equal(popup.options.fadeOut,60);
  assert.deepEqual(popup.textContext.variables,{2:42});assert.deepEqual(popup.textContext.switches,{4:true});assert.deepEqual(popup.textContext.inventory,[{kind:'item',itemId:1,quantity:3}]);assert.equal(broadcasts[1].code,'popupClear');
});

test('Gab queues run on the server, enable completion switches and resume WaitForGab',()=>{
  const f=fixture([cmd(356,['GabText first']),cmd(356,['GabActorFace 1']),cmd(356,['GabSound Bell1']),cmd(356,['GabSwitch 5']),cmd(356,['ShowGab']),cmd(356,['GabText second']),cmd(356,['GabSwitch 6']),cmd(356,['ShowGab']),cmd(356,['WaitForGab']),cmd(125,[0,0,7])]);
  f.content.textConfig={gab:{'Base Wait Time':'1','Time Per Character':'0','Fade Rate':'255'}};f.player.appearance={version:1};
  f.runtime.start(f.player,f.event);let messages=f.messages.filter(m=>m.type==='gab'&&m.action==='show');assert.equal(messages.length,1);assert.equal(messages[0].soundName,'Bell1');assert.deepEqual(messages[0].appearance,{version:1});assert.equal(f.player.gold,0);
  f.runtime.update(.1);assert.equal(f.player.switches[5],true);assert.equal(f.player.switches[6],undefined);messages=f.messages.filter(m=>m.type==='gab'&&m.action==='show');assert.equal(messages[1].text,'second');
  f.runtime.update(.1);assert.equal(f.player.switches[6],true);assert.equal(f.player.gold,7);assert.equal(f.runtime.tasks.size,0);
});

test('ForceGab and ClearGab cancel queued completion switches; repeated gab settings are suppressed',()=>{
  const f=fixture([cmd(356,['GabText original']),cmd(356,['GabSwitch 5']),cmd(356,['ShowGab']),cmd(356,['GabText original']),cmd(356,['GabSwitch 5']),cmd(356,['ShowGab']),cmd(356,['GabText replacement']),cmd(356,['GabSwitch 6']),cmd(356,['ForceGab']),cmd(356,['ClearGab']),cmd(356,['WaitForGab']),cmd(125,[0,0,2])]);
  f.runtime.start(f.player,f.event);assert.equal(f.messages.filter(m=>m.type==='gab'&&m.action==='show').length,2);assert.equal(f.player.gold,2);
  for(let i=0;i<20;i++)f.runtime.update(1);assert.equal(f.player.switches[5],undefined);assert.equal(f.player.switches[6],undefined);
  assert.equal(classifyCommand(cmd(356,['GabText \\C[2]test'])).status,'adapted');assert.equal(classifyCommand(cmd(356,['UnknownTextPlugin'])).status,'unsupported');
});
