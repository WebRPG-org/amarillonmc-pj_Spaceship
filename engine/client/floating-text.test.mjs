import test from 'node:test';
import assert from 'node:assert/strict';
import { FloatingTextLayer, popupOpacity, overheadPosition, resolveFloatingEntity, overheadInRange } from './floating-text.mjs';

test('popup fades use the original plugin 60fps durations, including zero', () => {
  assert.equal(popupOpacity(0), 0);
  assert.equal(popupOpacity(1000/12), .5);
  assert.equal(popupOpacity(1000), 1);
  assert.equal(popupOpacity(4000), .5);
  assert.equal(popupOpacity(4501), 0);
  assert.equal(popupOpacity(1, {fadeIn:0,duration:60,fadeOut:0}), 1);
  assert.equal(popupOpacity(1000, {fadeIn:0,duration:60,fadeOut:0}), 0);
});
test('head text follows the interpolated entity and zoomed camera', () => {
  assert.deepEqual(overheadPosition({x:10.5,y:8.25},{x:5,y:3},2,{x:4,y:-42}),{x:584,y:516});
});

test('missing entity IDs never attach a label to an unrelated player',()=>{
  const self={id:'self',x:5,y:5},event={id:'map:1:event:2',eventId:2,x:10,y:10},renderer={entities:new Map([[self.id,self],[event.id,event]]),snapshot:{playerId:self.id}};
  assert.equal(resolveFloatingEntity(renderer,{entityId:'removed'}),null);
  assert.equal(resolveFloatingEntity(renderer,{eventId:-1}),self);
  assert.equal(resolveFloatingEntity(renderer,{eventId:2}),event);
  assert.equal(resolveFloatingEntity(renderer,{eventId:event.id}),event);
  assert.equal(overheadInRange(event,self,5),true);
  assert.equal(overheadInRange({...event,x:10.01},self,5),false);
  assert.equal(overheadInRange(event,self,0),false);
});

test('quest labels use quest color and a map change replaces old labels',()=>{
  const layer=Object.create(FloatingTextLayer.prototype);layer.entries=new Map();layer.add=(key,data)=>layer.entries.set(key,data);layer.remove=key=>layer.entries.delete(key);
  layer.accept({mapId:1,serverTime:100,events:[{id:'one',overhead:{text:'任务',quest:true}}],players:[]});
  assert.equal(layer.entries.get('label:one').text,'\\C[17]任务');
  layer.accept({mapId:2,serverTime:100,events:[{id:'two',overhead:{text:'商人'}}],players:[]});
  assert.equal(layer.entries.has('label:one'),false);assert.equal(layer.entries.get('label:two').text,'商人');
});

test('popup data can arrive while the destination map loads and preserves zero frame options',()=>{
  const layer=Object.create(FloatingTextLayer.prototype);layer.scene=':2';layer.sequence=0;layer.entries=new Map();layer.renderer={snapshot:{mapId:1}};
  layer.config=()=>({popup:{'Offset Y':'0','Display Duration':'0','Fade In Duration':'0','Fade Out Duration':'0'}});layer.add=(key,data)=>layer.entries.set(key,data);
  layer.popup({mapId:1,code:'popup',eventId:1,text:'old map'});assert.equal(layer.entries.size,0);
  layer.popup({mapId:2,code:'popup',eventId:1,text:'current map'});const popup=[...layer.entries.values()][0];
  assert.equal(popup.text,'current map');for(const key of ['y','duration','fadeIn','fadeOut'])assert.equal(popup.options[key],0);
});

test('GabSprite packets load character sheets and generated appearances use walk preview',()=>{
  const calls=[],layer=Object.create(FloatingTextLayer.prototype),ctx={clearRect(){},drawImage(...args){calls.push(args);}};
  layer.portrait={hidden:false,getContext:()=>ctx};layer.renderer={images:{get(folder,name){calls.push({folder,name});return{ready:true,width:576,height:384};}},appearances:{preview(...args){calls.push(args);}}};
  layer.drawGabPortrait({graphicType:'character',graphicName:'Actor1',graphicIndex:2},0);assert.deepEqual(calls[0],{folder:'img/characters',name:'Actor1'});assert.equal(calls[1][3],48);assert.equal(calls[1][4],48);
  layer.drawGabPortrait({graphicType:'character',appearance:{kind:'generated'}},0);assert.equal(calls.at(-1)[2],'walk');
});
