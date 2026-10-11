import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {importThreeD,mapThreeD,parseThreeDCommand,parseThreeDPluginCommand,resolveThreeDVariables} from '../server/three-d.mjs';
import {loadContent,classifyCommand} from '../server/content.mjs';
import {EventRuntime} from '../server/events.mjs';
import {World} from '../server/world.mjs';
import {createApplication} from '../server/index.mjs';

const cmd=(code,parameters=[])=>({code,parameters,indent:0});
const mz=(name,args)=>cmd(357,['mz3d',name,'Display name',args]);
const projectRoot=fileURLToPath(new URL('../../',import.meta.url));

test('3D imports disabled plugin settings verbatim and never changes the 2D default',()=>{
  const parameters={mapDefaults:JSON.stringify('enable(true)\nfog(black|20,100)'),regions:'["height(2)"]'};
  const config=importThreeD([{name:'mv3d',status:false,parameters}]);
  assert.equal(config.defaultEnabled,false);assert.equal(config.version,'0.9.2.8');
  assert.deepEqual(config.parameters,parameters);assert.notEqual(config.parameters,parameters);
  assert.equal(mapThreeD({note:''},null,config).enabled,false);
  assert.equal(mapThreeD({note:'enable(true)'},null,config).enabled,false);
  assert.equal(mapThreeD({note:'<mv3d>fog(black|1,10)</mv3d>'},null,config).enabled,false);
});

test('map opt-in supports both note spellings, explicit disable, legacy enable() and source ordering',()=>{
  const config=importThreeD([]),read=note=>mapThreeD({note},null,config);
  for(const note of ['<mv3d>enable(true)</mv3d>','<MV3D>\nenable()\n</MV3D>','<mz3d:enable(1)>','<mv3d enable(true)>'])assert.equal(read(note).enabled,true);
  assert.equal(read('<mv3d>enable(false)</mv3d>').enabled,false);
  assert.equal(read('<mv3d:enable(true)><mz3d>enable(false)</mz3d>').enabled,false);
  assert.equal(read('<mz3d>enable(false)</mz3d><mv3d:enable(true)>').enabled,true);
  assert.equal(read('<mz3d>enable(true)</mz3d>').pluginName,'mv3d','tag alias must not select a different engine core');
  assert.equal(read('<mv3d>enable(process.exit())</mv3d>').enabled,false);
});

test('only declared variable references are sent for map/tileset/event visual expressions',()=>{
  const config=importThreeD([{name:'mz3d',parameters:{eventCharDefaults:'"scale(var(7))"'}}]);
  const map={note:'<mv3d>enable(true)</mv3d><mv3d-regions>1:height(var(8))</mv3d-regions>',events:[null,{note:'<mv3d:alpha(var(2))>',pages:[{list:[cmd(108,['<mv3d>elevation(var(5))</mv3d>']),cmd(355,['var(999)'])]}]}]};
  const metadata=mapThreeD(map,{note:'<mv3d>A2,0,0:height(var(3))</mv3d>'},config);
  assert.deepEqual(metadata.variableIds,[2,3,5,7,8]);
  assert.equal(metadata.pluginName,'mz3d');
  assert.equal(resolveThreeDVariables('@e3 configure scale(var(2)*2) 0',id=>id===2?1.5:0),'@e3 configure scale(1.5*2) 0');
  assert.throws(()=>resolveThreeDVariables('configure scale(var(2))',()=>Infinity));
});

test('MV visual commands preserve values and support camera/light/fog/enable/configure',()=>{
  for(const command of ['camera yaw +90 0.5','camera yaw +-90 0','@p lamp #ff8800 2 8 1','@e3 flashlight pitch 75 0','fog #001122 2 18 0','light color white 1','sun angle 120 55 0','enable','disable 2','set glowIntensity 1.25 2','@s configure shape(sprite),scale(var(2)*2) 0']){
    assert.equal(parseThreeDCommand(`mv3d ${command}`),command);
    assert.equal(classifyCommand(cmd(356,[`mv3d ${command}`])).status,'presentation');
  }
  assert.equal(parseThreeDCommand('CraftingSystem open'),null);
});

test('unknown or executable-looking commands cannot reach the render host',()=>{
  for(const source of ['mv3d constructor','mv3d __proto__','mv3d camera unknown 90','mv3d camera yaw NaN','mv3d camera yaw 90 -1','mv3d configure foo(1)','mv3d configure scale(eval(1))','mv3d configure scale(1);fetch("x")','mv3d set gravity 0','mv3d action jump','mv3d camera yaw 90;process.exit()']){
    assert.throws(()=>parseThreeDCommand(source),/Unsupported/);
    assert.equal(classifyCommand(cmd(356,[source])).status,'unsupported');
  }
  assert.equal(classifyCommand(mz('unimplemented',{value:'1'})).status,'unsupported');
  assert.equal(parseThreeDPluginCommand(cmd(357,['otherPlugin','camera','',{}])),null);
});

test('MZ structured visual commands convert to equivalent MV commands including zero times',()=>{
  assert.deepEqual(parseThreeDPluginCommand(mz('camera',{yaw:'+90',pitch:'60',time:'0',pan:'{"x":"1","y":"2"}',follow:'player'})),['camera pitch 60 0','camera yaw +90 0','camera follow player 0','camera pan 1 2 0']);
  assert.deepEqual(parseThreeDPluginCommand(mz('fog',{color:'#112233',near:'1',far:'24',time:'1.5'})),['fog color #112233 1.5','fog near 1 1.5','fog far 24 1.5']);
  assert.deepEqual(parseThreeDPluginCommand(mz('light',{color:'white',sunColor:'#ffeebb',sunYaw:'-30',sunPitch:'45'})),['light color white 0','sun color #ffeebb 0','sun yaw -30 0','sun pitch 45 0']);
  assert.deepEqual(parseThreeDPluginCommand(mz('enable',{enabled:'false',fadeType:'2'})),['disable 2']);
  assert.deepEqual(parseThreeDPluginCommand(mz('lamp',{target:'2',color:'red',shadow:'true'})),['@2 lamp color red 0','@2 lamp shadow']);
  assert.deepEqual(parseThreeDPluginCommand(mz('configure',{target:'player',config:JSON.stringify('shape(sprite)\nscale(2)'),time:'0'})),['@player configure shape(sprite) scale(2) 0']);
  assert.deepEqual(parseThreeDPluginCommand(mz('command',{command:'camera yaw +45 0'})),['camera yaw +45 0']);
  assert.equal(classifyCommand(mz('camera',{yaw:'90'})).status,'presentation');
});

test('native skybox and skyball commands preserve layers, faces, rotation, transitions and clearing',()=>{
  for(const command of ['skybox BlueSky.png autoRotate yaw 1 1','skybox CloudySky2.png autoRotate 1 0 0 1','skybox StarlitSky.png 1','skybox 1 Mountains1_transparent.png top clear bottom clear','skybox clear 1','skybox 1 clear','skyball 2 CloudySky1.png repeat 2 autoRotate 1 0 0 alpha 0.75 1','skyball 0 Ocean2.png repeat 2 1','skyball clear 0','skybox 1 north sky/North.png south sky/South.png alpha 0.5 2','camera mode 2D','cameramode 2d']){
    assert.equal(parseThreeDCommand(`mv3d ${command}`),command);
    assert.equal(classifyCommand(cmd(356,[`mv3d ${command}`])).status,'presentation');
  }
});

test('MZ sky settings convert vector x/y/z to native pitch/yaw/roll without interpreting filenames',()=>{
  assert.deepEqual(parseThreeDPluginCommand(mz('skybox',{index:'2',default:'BlueSky',top:'sky/Top.png',north:'clear',alpha:'0.75',time:'1.5',autoRotate:'{"x":"2","y":"1","z":"3"}'})),['skybox 2 default BlueSky north clear top sky/Top.png alpha 0.75 autoRotate 1 2 3 1.5']);
  assert.deepEqual(parseThreeDPluginCommand(mz('skyball',{index:'1',texture:'Sky/Sunset clouds.png',repeat:'2',alpha:'1',time:'0'})),['skyball 1 texture Sky/Sunset%20clouds.png repeat 2 alpha 1 0']);
  assert.deepEqual(parseThreeDPluginCommand(mz('skybox',{index:'3',default:'clear'})),['skybox 3 default clear 0']);
  assert.deepEqual(parseThreeDPluginCommand(mz('camera',{mode:'2D'})),['camera mode 2D']);
});

test('sky image paths and scalar arguments reject traversal, remote protocols and command injection',()=>{
  for(const command of ['skybox ../faces/Actor1.png','skybox /absolute.png','skybox //server/remote.png','skybox https://example.com/sky.png','skybox javascript:alert(1)','skybox data:image/png;base64,AAA','skybox %2e%2e/secret.png','skybox sky/%252e%252e/secret.png','skybox C:/secret.png','skybox BlueSky.png autoRotate yaw NaN 1','skyball Sky.png repeat Infinity','skybox Sky.png autoRotate 1 0','skybox Sky.png alpha .5 -1','skybox Sky.png extra ignored']){
    assert.throws(()=>parseThreeDCommand(`mv3d ${command}`),/Unsupported/);
  }
  assert.throws(()=>parseThreeDPluginCommand(mz('skyball',{texture:'javascript:alert(1)'})),/local filename/);
  assert.throws(()=>parseThreeDPluginCommand(mz('skybox',{default:'Sky.png',autoRotate:'{"x":"1","y":"NaN","z":"0"}'})),/rotation/);
});

function runtimeFixture(list){
  const player={id:'p1',mapId:7,variables:{2:3},switches:{},selfSwitches:{},inventory:[]};
  const event={id:'map:7:event:3',eventId:3,mapId:7,pages:[{conditions:{},list}]};
  const messages=[],notices=[];
  const world={players:new Map([[player.id,player]]),maps:new Map(),send:(id,message)=>messages.push({id,...message}),notice:(p,message)=>notices.push(message)};
  const runtime=new EventRuntime({content:{database:{}},world});
  return {player,event,messages,notices,runtime};
}

test('server emits personal visual cues with map/event context and continues normal event commands',()=>{
  const f=runtimeFixture([cmd(356,['mv3d camera yaw 90 0']),mz('configure',{target:'player',config:'scale(var(2))'}),cmd(122,[9,9,0,0,42]),cmd(0)]);
  f.runtime.start(f.player,f.event);
  assert.deepEqual(f.messages,[{id:'p1',type:'threeD',mapId:7,instanceId:null,eventId:3,entityId:'map:7:event:3',command:'camera yaw 90 0'},{id:'p1',type:'threeD',mapId:7,instanceId:null,eventId:3,entityId:'map:7:event:3',command:'@player configure scale(3)'}]);
  assert.equal(f.player.variables[9],42);assert.deepEqual(f.notices,[]);
  const bad=runtimeFixture([cmd(356,['mv3d constructor']),cmd(122,[9,9,0,0,42])]);bad.runtime.start(bad.player,bad.event);
  assert.equal(bad.messages.length,0);assert.equal(bad.player.variables[9],undefined);assert.match(bad.notices[0],/Unsupported MV3D/);
});

test('snapshots expose authoritative active event page index and only referenced visual variables',()=>{
  const world=new World({content:{database:{}},store:{}});
  const player={id:'p',mapId:1,variables:{3:4,999:'private'},switches:{1:true},selfSwitches:{}};
  const event={id:'event',eventId:1,mapId:1,pages:[{conditions:{},image:{characterName:'A'}},{conditions:{switch1Valid:true,switch1Id:1},image:{characterName:'B'}}]};
  world.players.set(player.id,player);world.maps.set(1,{id:1,raw:{threeD:{variableIds:[3]}},events:new Map([[event.id,event]]),drops:new Map(),projectiles:new Map()});
  let snapshot=world.snapshot(player);assert.equal(snapshot.events[0].pageIndex,1);assert.deepEqual(snapshot.threeD.variables,{3:4});
  player.switches[1]=false;snapshot=world.snapshot(player);assert.equal(snapshot.events[0].pageIndex,0);
  event.erased=true;snapshot=world.snapshot(player);assert.equal(snapshot.events[0].pageIndex,-1);
});

test('cloned events retain unique visual sources without exporting interpreter code or routes',()=>{
  const world=new World({content:{database:{Enemies:[]}},store:{},hooks:{snapshot:()=>({id:'round-a'})}});
  const messages=[],player={id:'p',mapId:1,variables:{4:12,5:2,6:1,999:'private'},switches:{},selfSwitches:{},_connected:true,_send:m=>messages.push(m)};
  const page={conditions:{},image:{characterName:'Actor1',characterIndex:0,direction:2},directionFix:true,walkAnime:false,stepAnime:true,moveSpeed:3,priorityType:1,moveRoute:{list:[cmd(45,['process.exit()'])]},list:[cmd(108,['<mv3d>']),cmd(408,['elevation(var(6))</mv3d>']),cmd(356,['mv3d @self lamp white 1 3 0']),cmd(355,['process.exit()']),cmd(0)]};
  const source={id:1,name:'Clone',note:'<mv3d:scale(var(4))>',x:2,y:2,pages:[page]};
  const map={id:1,raw:{},events:new Map(),drops:new Map(),projectiles:new Map()};
  world.players.set(player.id,player);world.maps.set(1,map);
  const native=world.addEvent(map,source),cloneA=world.addEvent(map,source,9,{x:3,y:3}),cloneB=world.addEvent(map,{...source,note:'<mv3d:scale(var(5))>'},9,{x:4,y:4});
  const snapshot=world.snapshot(player),original=snapshot.events.find(e=>e.id===native.id),first=snapshot.events.find(e=>e.id===cloneA.id),second=snapshot.events.find(e=>e.id===cloneB.id);
  assert.equal(original.threeDSource,undefined);assert.notEqual(first.id,second.id);assert.equal(first.eventId,second.eventId);assert.equal(first.sourceMapId,9);assert.equal(second.sourceMapId,9);
  assert.equal(first.threeDSource.note,'<mv3d:scale(var(4))>');assert.equal(second.threeDSource.note,'<mv3d:scale(var(5))>');
  assert.equal(first.pageIndex,0);assert.equal(first.threeDSource.page.directionFix,true);assert.equal(first.threeDSource.page.moveRoute,undefined);
  assert.deepEqual(first.threeDSource.page.list.map(c=>c.code),[108,408,0]);assert.equal(JSON.stringify(first.threeDSource).includes('process.exit'),false);
  assert.deepEqual(snapshot.threeD.variables,{4:12,5:2,6:1});
  world.events.start(player,cloneB);
  const cue=messages.find(m=>m.type==='threeD');assert.equal(cue.entityId,cloneB.id);assert.equal(cue.eventId,1);assert.equal(cue.instanceId,'round-a');
});

test('project API exposes original plugin parameters and map-specific opt-in metadata',async()=>{
  const content=await loadContent(projectRoot);
  assert.equal(content.threeD.parameters.mapDefaults.includes('enable(false)'),true);
  assert.equal(content.getMap(6).threeD.enabled,true);
  assert.equal(content.getMap(1).threeD.enabled,false);
  const app=await createApplication({projectRoot,store:{async init(){},async close(){}}});
  try{
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${app.server.address().port}`;
    const data=await (await fetch(`${base}/api/content`)).json();
    assert.equal(data.threeD.version,'0.9.2.8');assert.deepEqual(data.threeD.parameters,content.threeD.parameters);
    assert.equal(data.maps.find(m=>m.id===6).threeD.enabled,true);
    const map=await (await fetch(`${base}/api/maps/6`)).json();assert.equal(map.id,6);assert.equal(map.threeD.enabled,true);
  }finally{await app.close();}
});
