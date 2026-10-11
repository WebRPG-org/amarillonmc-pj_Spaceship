import test from 'node:test';
import assert from 'node:assert/strict';
import {Renderer} from './renderer.mjs';

function fixture(animation) {
  const calls=[];
  return {calls,effects:[],database:{Animations:[null,animation]},
    effekseer:{play:(...args)=>calls.push(['effekseer',...args])},
    images:{get:(...args)=>calls.push(['sheet',...args])}};
}

test('native MZ impact keeps its damage number, and effectName wins over empty MV placeholder frames',()=>{
  const animation={effectName:'ArrowSpecial',frames:[]},renderer=fixture(animation);
  const impact={kind:'damage',animationId:1,targetId:'enemy',x:2,y:3,value:45};
  Renderer.prototype.effect.call(renderer,impact);
  assert.deepEqual(renderer.calls,[['effekseer',animation,impact]]);
  assert.equal(renderer.effects.length,1);
  assert.equal(renderer.effects[0].value,45);
  assert.equal(renderer.effects[0].targetId,'enemy');
  assert.equal(renderer.effects[0].animation,null);
  Renderer.prototype.effect.call(renderer,{kind:'animation',animationId:1,x:2,y:3});
  assert.equal(renderer.effects.length,1,'A visual-only MZ cue must not add a fake MV animation');
});

test('legacy MV sheet animation keeps its original frame duration and image dependencies',()=>{
  const animation={animation1Name:'Slash',animation2Name:'Hit',frames:Array(30).fill([])},renderer=fixture(animation);
  Renderer.prototype.effect.call(renderer,{kind:'damage',animationId:1,value:12,x:2,y:3});
  assert.deepEqual(renderer.calls,[['sheet','img/animations','Slash'],['sheet','img/animations','Hit']]);
  assert.equal(renderer.effects[0].animation,animation);
  assert.equal(renderer.effects[0].duration,2000);
  assert.equal(renderer.effects[0].value,12);
});

function drawingFixture(animation) {
  const renderer=fixture(animation),arcs=[],images=[];
  renderer.ctx={
    save(){},restore(){},beginPath(){},stroke(){},translate(){},rotate(){},scale(){},
    arc(x,y,radius){
      // Canvas throws on the negative radius that previously stopped the RAF loop.
      if(radius<0)throw new DOMException('The radius is negative','IndexSizeError');
      assert.ok(Number.isFinite(radius));arcs.push(radius);
    },
    drawImage(...args){images.push(args);}
  };
  renderer.point=(x,y)=>({x,y});renderer.label=()=>{};
  renderer.images.get=()=>({ready:true});
  return {renderer,arcs,images};
}

test('a death received after the RAF timestamp starts at radius zero and then expands normally',()=>{
  const {renderer,arcs}=drawingFixture();
  const frameTime=performance.now()-5;
  Renderer.prototype.effect.call(renderer,{kind:'death',x:2,y:3});
  const effect=renderer.effects[0];
  assert.ok(frameTime<effect.start);
  assert.doesNotThrow(()=>Renderer.prototype.drawEffect.call(renderer,effect,frameTime));
  assert.deepEqual(arcs,[0]);
  assert.equal(renderer.ctx.globalAlpha,1);
  Renderer.prototype.drawEffect.call(renderer,effect,effect.start+effect.duration/2);
  assert.deepEqual(arcs,[0,22.5]);
  assert.equal(renderer.ctx.globalAlpha,.5);
});

test('a just-received MV animation or balloon uses its first frame even when RAF time is older',()=>{
  const animation={animation1Name:'Slash',frames:[[[0,0,0,100,0,false,255,0]]]};
  for(const [cue,sourceWidth]of [[{kind:'animation',animationId:1},192],[{kind:'balloon',balloonId:1},48]]){
    const {renderer,images}=drawingFixture(animation),frameTime=performance.now()-5;
    Renderer.prototype.effect.call(renderer,cue);
    Renderer.prototype.drawEffect.call(renderer,renderer.effects[0],frameTime);
    assert.equal(images.length,1);
    assert.deepEqual(images[0].slice(1,5),[0,0,sourceWidth,sourceWidth]);
  }
});

test('a render exception remains visible but does not cancel subsequent animation frames',t=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'requestAnimationFrame'),scheduled=[];
  globalThis.requestAnimationFrame=callback=>{scheduled.push(callback);return scheduled.length;};
  t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'requestAnimationFrame',descriptor);else delete globalThis.requestAnimationFrame;});
  const failure=new Error('Transient draw failure'),deltas=[];
  const renderer={lastTime:105,draw(time,dt){deltas.push(dt);if(deltas.length===1)throw failure;}};
  renderer.drawLoop=Renderer.prototype.drawLoop.bind(renderer);
  assert.throws(()=>renderer.drawLoop(100),error=>error===failure);
  assert.equal(scheduled.length,1,'The next frame must survive a draw failure');
  assert.doesNotThrow(()=>scheduled.shift()(116));
  assert.equal(scheduled.length,1);
  assert.deepEqual(deltas,[0,.016]);
});
