import test from 'node:test';
import assert from 'node:assert/strict';
import {ThreeDLayer} from './three-d.mjs';
import {Renderer} from './renderer.mjs';

function frameFixture(t, load = async()=>{}) {
  const commands=[],frames=[],statuses=[],errors=[];
  const host={load,dispose(){this.disposed=true;},command:m=>commands.push(m),resize(){},update(){},
    canvas:{width:816},project:(x,y)=>({x:x*10,y:y*10}),pick:(x,y)=>({x:x/10,y:y/10})};
  t.mock.method(globalThis,'setTimeout',()=>1);
  t.mock.method(globalThis,'clearTimeout',()=>{});
  const previous=globalThis.document;
  globalThis.document={createElement(){const frame={contentWindow:{threeDHost:host},style:{},setAttribute(){},remove(){this.removed=true;}};frames.push(frame);return frame;},
    body:{append(frame){queueMicrotask(()=>frame.onload());}}};
  t.after(()=>{globalThis.document=previous;});
  const layer=new ThreeDLayer({onStatus:s=>statuses.push(s),onError:e=>errors.push(e)});
  return {layer,host,frames,commands,statuses,errors};
}
test('2D layer allocates no runtime; leaving a loading map cannot resurrect its frame',async t=>{
  let resolveLoad;const fixture=frameFixture(t,()=>new Promise(resolve=>{resolveLoad=resolve;}));
  assert.equal(fixture.frames.length,0);assert.equal(fixture.layer.status,'off');
  const loading=fixture.layer.load({map:{id:49}});
  await new Promise(resolve=>queueMicrotask(resolve));
  fixture.layer.dispose();resolveLoad();await loading;
  assert.equal(fixture.layer.status,'off');assert.equal(fixture.frames[0].removed,true);
  assert.equal(fixture.host.disposed,true);assert.equal(fixture.layer.host,null);
});
test('camera cues wait for the runtime, projection/picking use host pixels and teardown releases it',async t=>{
  const {layer,commands,host}=frameFixture(t);
  const pending=layer.load({map:{id:49}});
  layer.command({command:'camera yaw 90 0'});await pending;
  assert.deepEqual(commands,[{command:'camera yaw 90 0'}]);
  assert.deepEqual(layer.project(2,3),{x:20,y:30});assert.deepEqual(layer.pick(20,30),{x:2,y:3});
  const images=[];
  assert.equal(layer.draw({ctx:{drawImage:(...args)=>images.push(args)},width:816,height:624,zoom:2}),true);
  assert.deepEqual(images[0],[host.canvas,0,0,408,312]);
  layer.dispose();assert.equal(layer.pick(20,30),null);assert.equal(host.disposed,true);
});
test('3D failures report an error instead of silently pretending a 2D fallback is equivalent',async t=>{
  const {layer,errors}=frameFixture(t,async()=>{throw Error('Missing texture');});
  await layer.load({});assert.equal(layer.status,'error');assert.equal(layer.enabled,true);
  assert.deepEqual(errors,['Missing texture']);layer.dispose();
});

test('async light commands preserve event order and pending commands are cancelled when leaving',async t=>{
  const {layer,host}=frameFixture(t),applied=[];
  let finishLamp;
  host.command=async message=>{
    if(message.command==='lamp')await new Promise(resolve=>{finishLamp=resolve;});
    applied.push(message.command);
  };
  const loading=layer.load({map:{id:49}});
  layer.command({command:'lamp'});layer.command({command:'configure'});
  await loading;
  assert.deepEqual(applied,[]);
  finishLamp();await layer.commandTail;
  assert.deepEqual(applied,['lamp','configure']);
  layer.command({command:'lamp'});const cancelled=layer.command({command:'old-map-configure'});
  await new Promise(resolve=>queueMicrotask(resolve));
  layer.dispose();finishLamp();await cancelled;
  assert.deepEqual(applied,['lamp','configure','lamp']);
});
test('presentation commands from a previous map cannot enable or disable the current renderer',()=>{
  const calls=[],renderer={map:{id:49},threeD:{enabled:false,dispose:()=>calls.push('dispose'),command:m=>calls.push(m)},startThreeD(){this.threeD.enabled=true;calls.push('start');}};
  Renderer.prototype.threeDCommand.call(renderer,{mapId:50,command:'enable'});
  assert.deepEqual(calls,[]);
  Renderer.prototype.threeDCommand.call(renderer,{mapId:49,command:'enable'});
  assert.equal(calls[0],'start');assert.equal(calls[1].command,'enable');
});

test('camera and light settings issued while 2D are applied in order when enabling 3D',()=>{
  const calls=[],renderer={map:{id:49},threeD:{enabled:false,command:m=>calls.push(m.command)},
    startThreeD(){this.threeD.enabled=true;calls.push('start');}};
  for(const command of ['camera yaw 90 0','@player lamp white 1 3 0'])Renderer.prototype.threeDCommand.call(renderer,{mapId:49,command});
  assert.deepEqual(calls,[]);
  Renderer.prototype.threeDCommand.call(renderer,{mapId:49,command:'enable'});
  assert.deepEqual(calls,['start','camera yaw 90 0','@player lamp white 1 3 0','enable']);
  assert.deepEqual(renderer.pendingThreeDCommands,[]);
});

test('3D overhead UI follows the projected character head and disappears behind the camera',()=>{
  const labels=[],bars=[],entity={id:'p',name:'Player',x:9,y:18,maxHp:100,hp:75};
  let projected={x:400,y:150};
  const renderer={zoom:2,ctx:{fillRect:(...args)=>bars.push(args)},threeD:{enabled:true,draw:()=>true,
    projectEntity:()=>projected,project:()=>{throw Error('Floor projection must not position character UI');}},
    entities:new Map([['p',entity]]),snapshot:{},effects:[],canvas:{width:816,height:624},
    entityScreenPoint:Renderer.prototype.entityScreenPoint,label:(...args)=>labels.push(args),
    effekseer:{draw(){}},drawPresentation(){}};
  Renderer.prototype.drawThreeD.call(renderer,0,0,{width:816,height:624},1,{},entity);
  assert.deepEqual(labels[0].slice(0,3),['Player',200,75]);
  assert.deepEqual(bars[0],[181,82,38,4]);
  labels.length=bars.length=0;projected={x:400,y:150,behindCamera:true};
  Renderer.prototype.drawThreeD.call(renderer,0,0,{width:816,height:624},1,{},entity);
  assert.deepEqual(labels,[]);assert.deepEqual(bars,[]);
});
