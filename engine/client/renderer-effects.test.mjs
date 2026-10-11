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
