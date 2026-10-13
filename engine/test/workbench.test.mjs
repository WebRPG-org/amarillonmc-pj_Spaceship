import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ContentWorkbench,editorAllowed,createWorkbenchHandler} from '../server/workbench.mjs';
import {loadGameplay,validateGameplay} from '../server/gameplay-content.mjs';

const map={width:10,height:10,tilesetId:1,note:'preserve map',data:[0,0,0],pluginExtra:{keep:true},events:[null,{id:1,name:'original',x:2,y:3,note:'<other-plugin:keep>',futureProperty:{keep:1},pages:[{image:{characterName:'Actor1',characterIndex:0,tileId:0,direction:2,pattern:1},list:[{code:101,indent:0,parameters:['',0,0,2]},{code:401,indent:0,parameters:['Keep dialogue']},{code:0,indent:0,parameters:[]}],conditions:{keep:true}}]}]};
async function fixture(t){const projectRoot=await mkdtemp(path.join(os.tmpdir(),'spaceship-editor-'));t.after(()=>rm(projectRoot,{recursive:true,force:true}));await mkdir(path.join(projectRoot,'data'));await writeFile(path.join(projectRoot,'data','Map001.json'),JSON.stringify(map));const content={maps:new Map([[1,map]]),database:{Items:[null,{id:1,name:'bread'}],Weapons:[null,{id:1,name:'club'}],Armors:[null,{id:1,name:'uniform'}],Skills:[null,{id:1}],Classes:[null,{id:1}]}};return{projectRoot,content,editor:new ContentWorkbench({projectRoot,content})};}
const request=(overrides={})=>({method:'GET',socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:8098'},...overrides});

test('editor access requires dev mode, actual loopback, local host and same origin',()=>{
  assert.equal(editorAllowed(request(),true),true);assert.equal(editorAllowed(request(),false),false);
  assert.equal(editorAllowed(request({socket:{remoteAddress:'203.0.113.1'}}),true),false);
  assert.equal(editorAllowed(request({headers:{host:'public.example'}}),true),false);
  assert.equal(editorAllowed(request({headers:{host:'127.0.0.1:8098',origin:'http://evil.example'}}),true),false);
  assert.equal(editorAllowed(request({headers:{host:'127.0.0.1:8098','x-forwarded-for':'203.0.113.1'}}),true),false);
  assert.equal(editorAllowed(request({method:'PUT'}),true),false);
  assert.equal(editorAllowed(request({method:'PUT',headers:{host:'127.0.0.1:8098',origin:'http://127.0.0.1:8098','x-editor-request':'1'}}),true),true);
  assert.equal(editorAllowed(request({socket:{remoteAddress:'::1'},headers:{host:'[::1]:8098'}}),true),true);
});

test('map save merges one event, keeps RM fields and creates a recoverable backup',async t=>{
  const {editor,projectRoot}=await fixture(t),document=await editor.read('map',1);
  const saved=await editor.save('map',1,{revision:document.revision,patch:{events:[{id:1,name:'路障',x:4,y:5,tags:{engine_structure:'barricade'}}]}});
  assert.equal(saved.data.events[1].x,4);assert.match(saved.data.events[1].note,/engine_structure:barricade/);
  assert.match(saved.data.events[1].note,/<other-plugin:keep>/);assert.deepEqual(saved.data.events[1].pages,map.events[1].pages);assert.deepEqual(saved.data.pluginExtra,map.pluginExtra);assert.deepEqual(saved.data.data,map.data);
  assert.equal(saved.restartRequired,true);assert.notEqual(saved.revision,document.revision);
  assert.deepEqual(JSON.parse(await readFile(path.join(projectRoot,saved.backup),'utf8')),map);
  assert.equal(await readFile(path.join(projectRoot,saved.backup),'utf8'),JSON.stringify(map),'Backup preserves the exact original source bytes');
  assert.ok((await readFile(path.join(projectRoot,'data','Map001.json'),'utf8')).includes('"data":[0,0,0]'),'Map tile array remains compact in the RM format');
});

test('external saves and competing editor saves reject stale revisions',async t=>{
  const {editor,projectRoot}=await fixture(t),document=await editor.read('map',1);
  await writeFile(path.join(projectRoot,'data','Map001.json'),JSON.stringify({...map,note:'RM changed'}));
  await assert.rejects(editor.save('map',1,{revision:document.revision,patch:{events:[]}}),e=>e.status===409);
  const fresh=await editor.read('map',1),results=await Promise.allSettled([editor.save('map',1,{revision:fresh.revision,patch:{events:[{id:1,x:4}]}}),editor.save('map',1,{revision:fresh.revision,patch:{events:[{id:1,x:5}]}})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
});

test('path boundaries and allowlists reject traversal, arbitrary map keys and prototype keys',async t=>{
  const {editor}=await fixture(t);await assert.rejects(editor.read('map','../Weapons'));await assert.rejects(editor.read('../../other'));
  const document=await editor.read('map',1);await assert.rejects(editor.save('map',1,{revision:document.revision,patch:{data:[999]}}));
  await assert.rejects(editor.save('map',1,{revision:document.revision,patch:{events:[{id:1,x:10}]}}));
  await assert.rejects(editor.save('map',1,{revision:document.revision,patch:JSON.parse('{"__proto__":{"polluted":true}}')}));
  assert.equal({}.polluted,undefined);
});

test('symlink documents cannot escape the project',async t=>{
  const {editor,projectRoot}=await fixture(t),outside=await mkdtemp(path.join(os.tmpdir(),'spaceship-editor-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));await mkdir(path.join(outside,'content'));await writeFile(path.join(outside,'content','gameplay.json'),'{"version":1}');
  try{await symlink(outside,path.join(projectRoot,'engine'),process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Host does not allow creating symlinks');return;}throw error;}
  await assert.rejects(editor.read('gameplay'),error=>error.status===403);
});

test('gameplay missing-file compatibility and partial saves preserve future keys',async t=>{
  const {editor,projectRoot,content}=await fixture(t);assert.deepEqual((await loadGameplay(projectRoot)).scenarios,{});
  await mkdir(path.join(projectRoot,'engine','content'),{recursive:true});const original={version:1,future:{keep:1},scenarios:{},titles:{},npcs:{},shops:{},structures:{wall:{hp:100,future:'keep'}}};await writeFile(path.join(projectRoot,'engine','content','gameplay.json'),JSON.stringify(original));
  const document=await editor.read('gameplay'),saved=await editor.save('gameplay',null,{revision:document.revision,patch:{structures:{wall:{hp:200}}}});assert.equal(saved.data.structures.wall.future,'keep');assert.equal(saved.data.future.keep,1);assert.equal((await loadGameplay(projectRoot)).structures.wall.hp,200);
  assert.throws(()=>validateGameplay({...original,scenarios:{bad:{name:'bad',type:'adventure',mapIds:[2],spawn:{mapId:2,x:0,y:0},durationSeconds:10,maxPlayers:1}}},content));
});

test('new entities are legal RM events and cannot insert arbitrary event scripts',async t=>{
  const {editor}=await fixture(t),document=await editor.read('map',1);
  const result=await editor.save('map',1,{revision:document.revision,patch:{events:[{id:2,name:'回收磁盘',x:1,y:1,tags:{engine_service:'meteorDisk'}}]}});
  assert.equal(result.data.events[2].pages[0].list.at(-1).code,0);assert.ok(result.data.events[2].pages[0].conditions);assert.match(result.data.events[2].note,/engine_service:meteorDisk/);
  assert.throws(()=>editor.apply('map',map,{events:[{id:1,pages:[{list:[{code:355,parameters:['eval()']}]}]}]},1));
  assert.throws(()=>editor.apply('map',map,{events:[{id:map.events.length+1,x:1,y:1}]},1),'New event IDs cannot create sparse invalid JSON arrays');
});

test('MV and MZ animation edits preserve frames, timings and unrelated metadata',async t=>{
  const {editor,projectRoot}=await fixture(t),animations=[null,{id:1,name:'MV',animation1Name:'Hit',frames:[[[1,2,3]]],timings:[{frame:0}],custom:'keep'},{id:2,name:'MZ',effectName:'Fire',frames:[],rotation:{x:0,y:0,z:0},soundTimings:[],flashTimings:[]}];await writeFile(path.join(projectRoot,'data','Animations.json'),JSON.stringify(animations));
  const document=await editor.read('animations');let result=await editor.save('animations',null,{revision:document.revision,patch:{id:2,changes:{scale:150,rotation:{x:20,y:0,z:0}}}});assert.deepEqual(result.data[1],animations[1]);assert.deepEqual(result.data[2].frames,[]);
  result=await editor.save('animations',null,{revision:result.revision,patch:{id:1,changes:{name:'New MV'}}});assert.deepEqual(result.data[1].frames,animations[1].frames);assert.deepEqual(result.data[1].timings,animations[1].timings);assert.equal(result.data[1].custom,'keep');
});

test('nonlocal HTTP workbench handler rejects before inspecting documents',async()=>{
  let status,result;const handle=createWorkbenchHandler({projectRoot:'unused',content:{},host:{},connections:new Map(),devTools:true});const response={writeHead(code){status=code;},end(value){result=JSON.parse(value);}};
  assert.equal(await handle(request({socket:{remoteAddress:'203.0.113.7'}}),response,new URL('http://localhost/api/editor/document?kind=gameplay')),true);assert.equal(status,403);assert.match(result.error,/本机/);
});

test('gameplay validates container references, rewards and the current DTS template requirements',async t=>{
  const {content}=await fixture(t),definition={id:'story',name:'Story',type:'adventure',mapIds:[1],spawn:{mapId:1,x:1,y:1},durationSeconds:600,maxPlayers:1,diskItemId:1,initialState:{classId:1,level:1,skills:[1],equips:{weapon:1}},containerLoot:{medical:[{kind:'item',itemId:1,quantity:2}]},reward:{gold:10,items:[{kind:'item',itemId:1,quantity:1}]}};
  const config={version:1,scenarios:{story:definition},titles:{},shops:{},npcs:{},structures:{}};
  assert.equal(validateGameplay(config,content),config);
  for(const patch of [{id:'wrong'},{type:'dts'},{diskItemId:999},{initialState:{skills:[999]}},{reward:{gold:-1}},{containerLoot:{medical:[{kind:'item',itemId:999,quantity:1}]}}])assert.throws(()=>validateGameplay({...config,scenarios:{story:{...definition,...patch}}},content));
});
