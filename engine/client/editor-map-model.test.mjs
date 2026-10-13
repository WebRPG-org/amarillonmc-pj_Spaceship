import test from 'node:test';
import assert from 'node:assert/strict';
import {A1,A2,A3,A4,A5,tileParts,mapTile} from './tile-format.mjs';
import {FLOOR,WALL,WATERFALL} from './autotile-tables.mjs';
import {MapPaintModel,autotileShape,autotileType,connectedTile,paletteTiles,paletteStamp,lineCells,tileKind} from './editor-map-model.mjs';

const makeMap=(width=7,height=7)=>({width,height,tilesetId:1,scrollType:0,note:'keep me',events:[null],data:Array(width*height*6).fill(0)});
const stamp=id=>({width:1,height:1,tiles:[id]});
const at=(m,x,y,z=0)=>mapTile(m.map,x,y,z);
const neighbors=mask=>Object.fromEntries(['n','e','s','w','nw','ne','se','sw'].map((name,i)=>[name,Boolean(mask&(1<<i))]));

test('every floor neighborhood produces a real RM shape, including all 47 connected shapes',()=>{
  const shapes=new Set();for(let mask=0;mask<256;mask++){
    const shape=autotileShape('floor',neighbors(mask));assert.ok(shape>=0&&shape<47,`mask ${mask}`);shapes.add(shape);
  }
  assert.equal(shapes.size,47);
  assert.equal(autotileShape('floor',neighbors(255)),0);
  assert.equal(autotileShape('floor',neighbors(255^16)),1,'missing northwest diagonal cuts only the northwest corner');
  assert.equal(autotileShape('floor',neighbors(0)),46,'isolated island');
  assert.deepEqual(FLOOR[autotileShape('floor',neighbors(15))],[[2,0],[3,0],[2,1],[3,1]],'four missing diagonals have four inner corners');
});

test('wall and waterfall edge bits correspond to RM quarter tables and ignore diagonals',()=>{
  for(let mask=0;mask<16;mask++){
    const n=neighbors(mask),shape=autotileShape('wall',n);assert.deepEqual(WALL[shape][0],[n.w?2:0,n.n?2:0]);
    assert.deepEqual(WALL[shape][3],[n.e?1:3,n.s?1:3]);
    assert.equal(autotileShape('wall',{...n,nw:true,ne:true,sw:true,se:true}),shape);
    const water=autotileShape('waterfall',n);assert.deepEqual(WATERFALL[water][0],[n.w?2:0,0]);assert.deepEqual(WATERFALL[water][1],[n.e?1:3,0]);
  }
  assert.equal(autotileType(A1+48),'floor','A1 kind 1 is animated water, not waterfall');
  assert.equal(autotileType(A1+3*48),'floor');assert.equal(autotileType(A1+5*48),'waterfall');
  assert.equal(autotileType(A2),'floor');assert.equal(autotileType(A3),'wall');assert.equal(autotileType(A4),'floor');assert.equal(autotileType(A4+8*48),'wall');
});

test('painting, erasing and undo restore actual neighboring shapes as one gesture',()=>{
  const model=new MapPaintModel(makeMap());model.begin();model.stamp(2,2,0,stamp(A2));model.stamp(3,2,0,stamp(A2));model.stamp(3,3,0,stamp(A2));model.commit();
  assert.equal(model.undoStack.length,1);assert.notEqual(at(model,2,2),A2+46);assert.equal(tileKind(at(model,3,3)),tileKind(A2));
  const connected=structuredClone(model.map.data);model.begin();model.stamp(3,2,0,stamp(0));model.commit();assert.equal(at(model,2,2),A2+46);assert.equal(at(model,3,3),A2+46);
  model.undo();assert.deepEqual(model.map.data,connected);model.undo();assert.ok(model.map.data.every(id=>id===0));model.redo();assert.deepEqual(model.map.data,connected);
  model.begin();model.stamp(1,1,1,stamp(A3));model.cancel();assert.deepEqual(model.map.data,connected);
});

test('fill compares autotile kinds, respects barriers, and preserves other five planes',()=>{
  const model=new MapPaintModel(makeMap());model.begin();model.rectangle({x:1,y:1},{x:5,y:5},0,stamp(A2));model.rectangle({x:3,y:1},{x:3,y:5},0,stamp(100));model.stamp(2,2,4,stamp(11));model.stamp(2,2,5,stamp(42));model.commit();
  model.begin();model.fill(1,1,0,stamp(A2+48));model.commit();
  for(let y=1;y<=5;y++){assert.equal(tileKind(at(model,1,y)),tileKind(A2+48));assert.equal(tileKind(at(model,2,y)),tileKind(A2+48));assert.equal(at(model,3,y),100);assert.equal(tileKind(at(model,4,y)),tileKind(A2));}
  assert.equal(at(model,0,0),0);assert.equal(at(model,2,2,4),11);assert.equal(at(model,2,2,5),42);
});

test('multi-cell furniture stamps keep the B–E source layout across the 128-ID split',()=>{
  const p=paletteTiles(5),s=paletteStamp(p,{x:7,y:4},{x:9,y:5});assert.deepEqual(s,{width:3,height:2,tiles:[39,160,161,47,168,169]});
  const model=new MapPaintModel(makeMap());model.begin();model.stamp(2,3,2,s);model.commit();assert.deepEqual([at(model,2,3,2),at(model,3,3,2),at(model,4,3,2),at(model,2,4,2),at(model,3,4,2),at(model,4,4,2)],s.tiles);
  model.begin();model.rectangle({x:1,y:1},{x:5,y:2},3,s);model.commit();assert.deepEqual([1,2,3,4,5].map(x=>at(model,x,1,3)),[39,160,161,39,160]);
});

test('all standard palette slots point to their correct engine source sheet',()=>{
  const counts=[16,32,32,48,128,256,256,256,256];for(let slot=0;slot<9;slot++){
    const p=paletteTiles(slot);assert.equal(p.ids.length,counts[slot]);for(const id of p.ids){if(!id)continue;assert.ok(tileParts(id).length);assert.ok(tileParts(id).every(part=>part.sheet===slot));}
  }
  assert.equal(paletteTiles(4).ids.at(-1),A5+127);assert.equal(paletteTiles(8).ids.at(-1),1023);
});

test('loop seams join neighbors; non-looping map edges continue off-screen material',()=>{
  const map=makeMap(3,3);map.scrollType=2;const model=new MapPaintModel(map);model.begin();model.stamp(0,1,0,stamp(A2));model.stamp(2,1,0,stamp(A2));model.commit();
  assert.notEqual(at(model,0,1),A2+46);assert.notEqual(at(model,2,1),A2+46);
  assert.equal(connectedTile(model.map,0,1,0),at(model,0,1));
  const oneMap=new MapPaintModel(makeMap(1,1));oneMap.stamp(0,0,0,stamp(A2));oneMap.commit();assert.equal(at(oneMap,0,0),A2);
});

test('shift-style raw paint, empty gestures and new edits preserve meaningful history',()=>{
  const m=new MapPaintModel(makeMap());m.begin();m.stamp(1,1,0,stamp(A2+5),{connect:false});m.commit();assert.equal(at(m,1,1),A2+5);
  m.begin();m.stamp(1,1,0,stamp(A2+5),{connect:false});assert.equal(m.commit(),false);assert.equal(m.undoStack.length,1);
  m.undo();m.begin();m.stamp(2,2,3,stamp(128));m.commit();assert.equal(m.redo(),false);
  assert.deepEqual(lineCells({x:1,y:1},{x:5,y:3}),[{x:1,y:1},{x:2,y:2},{x:3,y:2},{x:4,y:3},{x:5,y:3}]);
});

test('event changes and six-plane resize share undo history without mutating inputs',()=>{
  const source=makeMap(3,3),m=new MapPaintModel(source);for(let z=0;z<6;z++)m.stamp(1,1,z,stamp(z+1),{connect:false});m.commit();
  const event={id:1,x:1,y:1,name:'Door',pages:[{list:[{code:0,parameters:[]}]}]};m.updateEvent(event);event.name='outside mutation';assert.equal(m.map.events[1].name,'Door');
  m.applyProperties({width:5,height:4,tilesetId:2,note:'new note'});for(let z=0;z<6;z++)assert.equal(at(m,1,1,z),z+1);
  assert.equal(m.map.data.length,5*4*6);assert.equal(m.map.tilesetId,2);assert.equal(source.data.every(v=>v===0),true);assert.equal(source.events.length,1);
  m.undo();assert.equal(m.map.width,3);assert.equal(m.map.tilesetId,1);assert.equal(m.map.note,'keep me');m.undo();assert.equal(m.map.events.length,1);assert.equal(at(m,1,1,5),6);m.undo();assert.ok(m.map.data.every(v=>v===0));
  m.redo();m.redo();m.redo();assert.equal(m.map.width,5);assert.equal(m.map.events[1].name,'Door');m.updateEvent(null,1);assert.equal(m.map.events[1],null);m.undo();assert.equal(m.map.events[1].name,'Door');
  assert.throws(()=>m.applyProperties({width:1}),/事件超出地图/);assert.throws(()=>m.applyProperties({height:0}),/1–256/);
});
