import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,rename,link,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ContentWorkbench,createWorkbenchHandler} from '../server/workbench.mjs';
import {newMapTemplate,validateEventPages} from '../server/editor-validation.mjs';
import {classifyCommand} from '../server/content.mjs';
import {mapPatch,newEvent} from '../client/editor-document.mjs';

const page=()=>({conditions:{actorId:1,actorValid:false,itemId:1,itemValid:false,selfSwitchCh:'A',selfSwitchValid:false,switch1Id:1,switch1Valid:false,switch2Id:1,switch2Valid:false,variableId:1,variableValid:false,variableValue:0},directionFix:false,image:{characterIndex:0,characterName:'Actor1',direction:2,pattern:1,tileId:0},list:[{code:101,indent:0,parameters:['Actor1',0,0,2]},{code:401,indent:0,parameters:['hello']},{code:0,indent:0,parameters:[]}],moveFrequency:3,moveRoute:{list:[{code:1},{code:0}],repeat:true,skippable:false,wait:false},moveSpeed:3,moveType:0,priorityType:1,stepAnime:false,through:false,trigger:0,walkAnime:true});
async function fixture(t,options={}){
  const projectRoot=await mkdtemp(path.join(os.tmpdir(),'spaceship-map-edit-'));t.after(()=>rm(projectRoot,{recursive:true,force:true}));await mkdir(path.join(projectRoot,'data'));
  const map=newMapTemplate({width:4,height:3,tilesetId:1,name:'Native'});map.customMap={plugin:'preserved'};map.bgm.customSound='keep';map.events.push({id:1,name:'Guide',note:'keep\n\nengine_npc: old',x:3,y:2,pages:[page(),{...page(),trigger:2,customPage:'preserve'}],customEvent:{keep:true}});
  for(let z=0;z<6;z++)for(let i=0;i<12;i++)map.data[z*12+i]=z===4?i%16:z===5?100+i:z*100+i;
  const infos=[null,{id:1,name:'Native',parentId:0,order:1,expanded:true,scrollX:2,scrollY:3,customInfo:'keep'}];
  await writeFile(path.join(projectRoot,'data','Map001.json'),JSON.stringify(map));await writeFile(path.join(projectRoot,'data','MapInfos.json'),JSON.stringify(infos));
  const content={maps:new Map([[1,structuredClone(map)]]),mapInfos:infos,database:{Tilesets:[null,{id:1}, {id:2}],Items:[null,{id:1}],Skills:[null,{id:1}],Classes:[null,{id:1}],Weapons:[null,{id:1}],Armors:[null,{id:1}]}};
  const editor=new ContentWorkbench({projectRoot,content,...options});return{projectRoot,content,editor,map,infos};
}

test('six map layers paint independently and native properties preserve unknown fields',async t=>{
  const {editor,map,projectRoot}=await fixture(t),doc=await editor.read('map',1);
  const properties={displayName:'新名字',tilesetId:2,scrollType:3,autoplayBgm:true,bgm:{name:'Town',pan:10,pitch:100,volume:80},autoplayBgs:true,bgs:{name:'Rain',pan:0,pitch:100,volume:50},disableDashing:true,encounterStep:0,parallaxName:'sky/clouds',parallaxLoopX:true,parallaxLoopY:false,parallaxSx:-2,parallaxSy:3,parallaxShow:false,battleback1Name:'Castle',battleback2Name:'Wall',specifyBattleback:true,note:'<custom metadata>'};
  const tiles=[0,1,2,3,4,5].map(z=>({x:1,y:1,z,tileId:z===4?15:z===5?255:8191-z}));
  const result=await editor.save('map',1,{revision:doc.revision,patch:{properties,tiles}});
  for(const tile of tiles)assert.equal(result.data.data[tile.z*12+5],tile.tileId);
  assert.equal(result.data.data[0],map.data[0]);assert.deepEqual(result.data.customMap,map.customMap);assert.equal(result.data.bgm.customSound,'keep');assert.deepEqual(result.data.events,map.events);
  const loaded=JSON.parse(await readFile(path.join(projectRoot,'data','Map001.json'),'utf8'));assert.deepEqual(loaded,result.data);assert.equal(loaded.scrollType,3);assert.equal(loaded.data.length,72);
});

test('resize reindexes all six layers, fills new cells and rejects cropped events without implicit deletion',async t=>{
  const {editor,map}=await fixture(t);const expanded=editor.apply('map',map,{properties:{width:6,height:4}},1);
  assert.equal(expanded.data.length,6*4*6);for(let z=0;z<6;z++)for(let y=0;y<3;y++)for(let x=0;x<4;x++)assert.equal(expanded.data[z*24+y*6+x],map.data[z*12+y*4+x]);
  for(let z=0;z<6;z++){assert.equal(expanded.data[z*24+5],0);assert.equal(expanded.data[z*24+23],0);}
  assert.throws(()=>editor.apply('map',map,{properties:{width:2,height:2}},1),/事件 1/);
  const moved=editor.apply('map',map,{properties:{width:2,height:2},events:[{id:1,x:1,y:1}]},1);assert.equal(moved.events[1].x,1);assert.equal(moved.data[4*4+3],map.data[4*12+5]);
  const removed=editor.apply('map',map,{properties:{width:2,height:2},events:[{id:1,remove:true}]},1);assert.equal(removed.events[1],null);assert.equal(removed.events.length,2);
});

test('map editing rejects bad layers, coordinates, asset paths, dimensions and oversized payload shapes',async t=>{
  const {editor,map}=await fixture(t);for(const patch of [
    {tiles:[{x:0,y:0,z:6,tileId:0}]},{tiles:[{x:4,y:0,z:0,tileId:0}]},{tiles:[{x:0,y:0,z:4,tileId:16}]},{tiles:[{x:0,y:0,z:5,tileId:256}]},{tiles:[{x:0,y:0,z:0,tileId:-1}]},{tiles:[{x:0,y:0,z:0,tileId:8192}]},
    {properties:{width:0}},{properties:{height:257}},{properties:{tilesetId:999}},{properties:{parallaxName:'../private'}},{properties:{bgm:{name:'http://other',pan:0,pitch:100,volume:90}}},{properties:{scrollType:4}},{properties:{autoplayBgm:'true'}},{properties:{forbidden:1}},
    {events:[{id:1,remove:true,name:'extra'}]},{events:[{id:10001,x:0,y:0}]}
  ])assert.throws(()=>editor.apply('map',map,patch,1));
  await assert.rejects(editor.save('map',1,{revision:'x',patch:JSON.parse('{"properties":{"__proto__":{"evil":true}}}')}));
});

test('draft create-delete-create saves sparse native event IDs through mapPatch without renumbering',async t=>{
  const {editor,map,projectRoot}=await fixture(t),doc=await editor.read('map',1),draft=structuredClone(doc.data);
  const discarded=newEvent(draft,{x:0,y:0},'dialogue');draft.events[discarded.id]=discarded;draft.events[discarded.id]=null;
  const kept=newEvent(draft,{x:1,y:1},'dialogue');kept.futureEvent={preserve:true};draft.events[kept.id]=kept;
  const patch=mapPatch(doc.data,draft);assert.deepEqual(patch.events.map(event=>event.id),[3]);
  const saved=await editor.save('map',1,{revision:doc.revision,patch});assert.deepEqual(saved.data.events,draft.events);
  assert.equal(saved.data.events[2],null);assert.equal(saved.data.events[3].id,3);assert.deepEqual(saved.data.events[1],map.events[1]);
  assert.deepEqual(JSON.parse(await readFile(path.join(projectRoot,'data','Map001.json'),'utf8')).events,draft.events);
  const edge=editor.apply('map',map,{events:[{id:10000,x:0,y:0}]},1);assert.equal(edge.events.length,10001);assert.equal(edge.events[9999],null);assert.equal(edge.events[10000].id,10000);
  for(const id of [0,-1,10001,Number.MAX_SAFE_INTEGER])assert.throws(()=>editor.apply('map',map,{events:[{id,x:0,y:0}]},1));
  assert.throws(()=>editor.apply('map',map,{events:[{id:3,remove:true}]},1),/存在的事件 ID/);
});

test('complete event pages roundtrip unknown native/plugin commands without evaluating scripts',async t=>{
  const {editor,projectRoot}=await fixture(t),doc=await editor.read('map',1),pages=structuredClone(doc.data.events[1].pages);
  pages[0].conditions.switch1Valid=true;pages[0].conditions.switch1Id=7;pages[0].image.characterName='custom/Hero';pages[0].moveRoute.list=[{code:45,parameters:['globalThis.__editorExecuted = true']},{code:0}];pages[0].unknownPage={x:1};
  pages[0].list=[{code:357,indent:0,parameters:['MZPlugin','futureCommand','显示',{argument:'keep'}],futureCommandMetadata:{keep:true}},{code:355,indent:0,parameters:['globalThis.__editorExecuted = true']},{code:999,indent:0,parameters:[{future:['keep']}]},{code:0,indent:0,parameters:[]}];
  const saved=await editor.save('map',1,{revision:doc.revision,patch:{events:[{id:1,pages}]}});assert.deepEqual(saved.data.events[1].pages,pages);assert.equal(globalThis.__editorExecuted,undefined);assert.equal(classifyCommand(pages[0].list[1]).status,'unsupported');
  assert.deepEqual(JSON.parse(await readFile(path.join(projectRoot,'data','Map001.json'),'utf8')).events[1].pages,pages);
  assert.deepEqual(saved.data.events[1].customEvent,{keep:true});
  for(const malformed of [[],[{}],[{...page(),trigger:5}],[{...page(),conditions:{...page().conditions,selfSwitchCh:'Z'}}],[{...page(),list:[{code:355,parameters:['x']}]}],[{...page(),moveRoute:{...page().moveRoute,list:[{code:1}]}}]])assert.throws(()=>editor.apply('map',doc.data,{events:[{id:1,pages:malformed}]},1));
});

test('explicit tags become event note source and remove only their stale per-page comment lines',async t=>{
  const {editor,map}=await fixture(t);map.events[1].pages[0].list=[{code:108,indent:0,parameters:['engine_npc: stale']},{code:408,indent:0,parameters:['keep comment']},{code:108,indent:0,parameters:['engine_shop: shop\nengine_npc: duplicate\nuntouched']},{code:0,indent:0,parameters:[]}];map.events[1].pages[1].list=[{code:108,indent:0,parameters:['engine_npc: another']},{code:0,indent:0,parameters:[]}];
  const plain=editor.apply('map',map,{events:[{id:1,name:'Changed'}]},1);assert.deepEqual(plain.events[1].pages,map.events[1].pages);
  const changed=editor.apply('map',map,{events:[{id:1,tags:{engine_npc:'guard'}}]},1);assert.equal(changed.events[1].note,'keep\n\nengine_npc:guard');
  assert.equal(changed.events[1].pages[0].list[0].code,108);assert.equal(changed.events[1].pages[0].list[0].parameters[0],'keep comment');assert.equal(changed.events[1].pages[0].list[1].parameters[0],'engine_shop: shop\nuntouched');
  assert.equal(changed.events[1].pages[1].list.length,1);const cleared=editor.apply('map',map,{events:[{id:1,tags:{engine_npc:''}}]},1);assert.doesNotMatch(JSON.stringify(cleared.events[1]),/engine_npc/);
});

test('new event templates preserve copied unknown fields, even after the source event is removed',async t=>{
  const {editor,map}=await fixture(t),doc=await editor.read('map',1),template={...structuredClone(map.events[1]),id:2};
  template.futureNative={nested:['keep',2]};template.pages[0].futurePage='retain';
  const saved=await editor.save('map',1,{revision:doc.revision,patch:{events:[{id:1,remove:true},{id:2,template,name:'Copy',x:1,y:1}]}});
  assert.equal(saved.data.events[1],null);assert.equal(saved.data.events[2].name,'Copy');assert.deepEqual(saved.data.events[2].futureNative,template.futureNative);assert.deepEqual(saved.data.events[2].customEvent,{keep:true});assert.equal(saved.data.events[2].pages[0].futurePage,'retain');
  assert.throws(()=>editor.apply('map',map,{events:[{id:1,template:{...template,id:1}}]},1),/只可用于新建/);
  assert.throws(()=>editor.apply('map',map,{events:[{id:2,template:{...template,id:1}}]},1),/ID/);
  assert.throws(()=>editor.apply('map',map,{events:[{id:2,template:{...template,pages:[]}}]},1));
  assert.throws(()=>editor.apply('map',map,{events:[{id:2,template:{...template,futureNative:JSON.parse('{"__proto__":{"evil":true}}')}}]},1));
  assert.throws(()=>editor.apply('map',map,{events:[{id:2,template:{...template,futureNative:new Array(20001)}}]},1));
});

test('new map creation commits MapInfos and native map with catalog revision and validation registration',async t=>{
  const {editor,projectRoot,content,infos}=await fixture(t),catalog=await editor.mapCatalog();
  const result=await editor.createMap({name:'New Local',width:8,height:6,tilesetId:2,parentId:1,revision:catalog.revision});
  assert.equal(result.map.id,2);assert.equal(result.map.data.data.length,8*6*6);assert.deepEqual(result.map.data.events,[null]);assert.notEqual(result.catalog.revision,catalog.revision);assert.equal(result.catalog.maps.at(-1).parentId,1);assert.equal(result.restartRequired,true);assert.equal(content.maps.get(2).width,8);
  assert.deepEqual(JSON.parse(await readFile(path.join(projectRoot,result.backups[0]),'utf8')),infos);const savedInfos=JSON.parse(await readFile(path.join(projectRoot,'data','MapInfos.json'),'utf8'));assert.equal(savedInfos[1].customInfo,'keep');assert.equal(savedInfos[2].id,2);
  assert.equal((await editor.read('map',2)).revision,result.map.revision);await assert.rejects(editor.createMap({name:'stale',width:2,height:2,tilesetId:1,revision:catalog.revision}),e=>e.status===409);
});

test('copy preserves source events and unknown fields, checks source revisions, and rejects destructive cropping',async t=>{
  const {editor,map,projectRoot}=await fixture(t),catalog=await editor.mapCatalog(),source=await editor.read('map',1);
  await assert.rejects(editor.createMap({name:'crop',width:2,height:2,tilesetId:1,revision:catalog.revision,sourceMapId:1,sourceRevision:source.revision}),/事件 1/);
  const copied=await editor.createMap({name:'Copy',width:6,height:4,tilesetId:2,revision:catalog.revision,sourceMapId:1,sourceRevision:source.revision});assert.deepEqual(copied.map.data.events,map.events);assert.deepEqual(copied.map.data.customMap,map.customMap);assert.equal(copied.map.data.data[24+6+2],map.data[12+4+2]);assert.equal(copied.backups.length,2);
  await writeFile(path.join(projectRoot,'data','Map001.json'),JSON.stringify({...map,note:'external change'}));await assert.rejects(editor.createMap({name:'stale source',width:4,height:3,tilesetId:1,revision:copied.catalog.revision,sourceMapId:1,sourceRevision:source.revision}),e=>e.status===409);
});

test('parallel new maps with the same catalog revision cannot duplicate IDs or overwrite each other',async t=>{
  const {editor}=await fixture(t),catalog=await editor.mapCatalog(),input={name:'Parallel',width:3,height:3,tilesetId:1,revision:catalog.revision};const results=await Promise.allSettled([editor.createMap(input),editor.createMap(input)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);assert.equal((await editor.mapCatalog()).maps.length,2);
});

test('a failed MapInfos publication rolls back the new map and cleans temporary files',async t=>{
  const {editor,projectRoot,infos}=await fixture(t);editor.files.rename=async()=>{throw new Error('injected disk failure');};const catalog=await editor.mapCatalog();
  await assert.rejects(editor.createMap({name:'failed',width:3,height:3,tilesetId:1,revision:catalog.revision}),/injected/);assert.deepEqual(JSON.parse(await readFile(path.join(projectRoot,'data','MapInfos.json'),'utf8')),infos);assert.deepEqual((await readdir(path.join(projectRoot,'data'))).sort(),['Map001.json','MapInfos.json']);
});

test('an uncertain MapInfos publication restores only this transaction bytes',async t=>{
  const {editor,projectRoot,infos}=await fixture(t);editor.files.rename=async(...args)=>{await rename(...args);throw new Error('injected uncertain outcome');};const catalog=await editor.mapCatalog();
  await assert.rejects(editor.createMap({name:'failed',width:3,height:3,tilesetId:1,revision:catalog.revision}),/uncertain/);assert.deepEqual(JSON.parse(await readFile(path.join(projectRoot,'data','MapInfos.json'),'utf8')),infos);assert.deepEqual((await readdir(path.join(projectRoot,'data'))).sort(),['Map001.json','MapInfos.json']);
});

test('rollback retains external MapInfos and changed new-map contents',async t=>{
  const {editor,projectRoot,infos}=await fixture(t),externalInfos=structuredClone(infos);externalInfos[1].name='RM edited';editor.files.rename=async()=>{await writeFile(path.join(projectRoot,'data','MapInfos.json'),JSON.stringify(externalInfos));await writeFile(path.join(projectRoot,'data','Map002.json'),'external map bytes');throw new Error('external edit during failure');};
  const catalog=await editor.mapCatalog();await assert.rejects(editor.createMap({name:'failed',width:3,height:3,tilesetId:1,revision:catalog.revision}),/external edit/);assert.deepEqual(JSON.parse(await readFile(path.join(projectRoot,'data','MapInfos.json'),'utf8')),externalInfos);assert.equal(await readFile(path.join(projectRoot,'data','Map002.json'),'utf8'),'external map bytes');
});

test('copy rechecks source after map publication and rolls back on an RM edit',async t=>{
  const {editor,projectRoot,map}=await fixture(t);editor.files.link=async(...args)=>{await link(...args);await writeFile(path.join(projectRoot,'data','Map001.json'),JSON.stringify({...map,note:'RM newer source'}));};const catalog=await editor.mapCatalog();
  await assert.rejects(editor.createMap({name:'copy race',width:4,height:3,tilesetId:1,sourceMapId:1,revision:catalog.revision}),e=>e.status===409);assert.deepEqual((await readdir(path.join(projectRoot,'data'))).sort(),['Map001.json','MapInfos.json']);assert.equal(JSON.parse(await readFile(path.join(projectRoot,'data','Map001.json'),'utf8')).note,'RM newer source');
});

test('asset inventory is allowlisted, deduplicates audio formats, supports subfolders and handles missing folders',async t=>{
  const {editor,projectRoot}=await fixture(t);await mkdir(path.join(projectRoot,'audio','bgm'),{recursive:true});await mkdir(path.join(projectRoot,'img','characters','custom'),{recursive:true});for(const file of ['Town.ogg','Town.m4a','Rain.ogg','not-a-sound.json'])await writeFile(path.join(projectRoot,'audio','bgm',file),'');await writeFile(path.join(projectRoot,'img','characters','custom','Hero.png'),'');
  for(const name of ['Unsupported.jpg','Unsupported.jpeg','Unsupported.webp'])await writeFile(path.join(projectRoot,'img','characters',name),'');
  assert.deepEqual((await editor.assets('bgm')).names,['Rain','Town']);assert.deepEqual((await editor.assets('characters')).names,['custom/Hero']);assert.deepEqual((await editor.assets('faces')).names,[]);await assert.rejects(editor.assets('../data'));await assert.rejects(editor.assets('__proto__'));
});

test('asset directory junction outside the project is rejected',async t=>{
  const {editor,projectRoot}=await fixture(t),outside=await mkdtemp(path.join(os.tmpdir(),'spaceship-assets-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));await mkdir(path.join(projectRoot,'img'));await writeFile(path.join(outside,'Secret.png'),'');
  try{await symlink(outside,path.join(projectRoot,'img','faces'),process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Host forbids junctions');return;}throw error;}
  await assert.rejects(editor.assets('faces'),e=>e.status===403);
});

test('existing repository native event pages satisfy bounded serialization validation',async()=>{
  const directory=new URL('../../data/',import.meta.url);let pages=0;for(const filename of await readdir(directory))if(/^Map\d+\.json$/i.test(filename)){const map=JSON.parse(await readFile(new URL(filename,directory),'utf8'));for(const event of map.events||[])if(event){validateEventPages(event.pages);pages+=event.pages.length;}}
  assert.ok(pages>600);
});
