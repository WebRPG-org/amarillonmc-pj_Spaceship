import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {Renderer} from '../client/renderer.mjs';

const animations=JSON.parse(await readFile(new URL('../../data/Animations.json',import.meta.url),'utf8'));

test('the four MZ imports run to completion as safe empty animations in the actual legacy MV Sprite_Animation',async()=>{
  const source=await readFile(new URL('../../js/rpg_sprites.js',import.meta.url),'utf8');
  const start=source.indexOf('function Sprite_Animation()'),end=source.indexOf('function Sprite_Damage()',start);assert.ok(start>=0&&end>start);
  // Only rendering primitives are stubs: setup/load/update/completion are the
  // project's actual MV implementation, rather than mirrored test logic.
  function Sprite(){this.initialize();}
  Sprite.prototype.initialize=function(){this.anchor={};this.children=[];};
  Sprite.prototype.addChild=function(child){this.children.push(child);};
  Sprite.prototype.update=function(){};
  const loads=[],context=vm.createContext({Sprite,ScreenSprite:Sprite,ImageManager:{loadAnimation(name,hue){assert.equal(typeof name,'string');assert.equal(typeof hue,'number');loads.push([name,hue]);return{isReady:()=>true};}}});
  vm.runInContext(source.slice(start,end),context,{filename:'actual-project-Sprite_Animation.js'});
  for(const id of [121,122,123,124]){
    const animation=animations[id],sprite=new context.Sprite_Animation();
    const originalMZ={...animation};for(const key of ['animation1Name','animation1Hue','animation2Name','animation2Hue','frames','timings','position'])delete originalMZ[key];
    // The regression would throw before entering playback without placeholders.
    assert.throws(()=>new context.Sprite_Animation().setup({},originalMZ,false,0));
    sprite.setup({x:10,y:20,height:48,parent:{}},animation,false,0);
    assert.equal(sprite.isPlaying(),true);assert.equal(sprite._duration,1);
    assert.doesNotThrow(()=>sprite.update());assert.equal(sprite.isPlaying(),false);
    assert.deepEqual(animation.frames,[]);assert.deepEqual(animation.timings,[]);assert.ok(animation.effectName);
  }
  assert.equal(loads.length,8);assert.ok(loads.every(([name,hue])=>name===''&&hue===0));
});

test('new renderer retains Effekseer priority for hybrid records and accepts pure MZ records',()=>{
  const played=[],renderer=Object.create(Renderer.prototype);renderer.database={Animations:animations};renderer.effects=[];renderer.images={get(){throw new Error('Must not select MV sprite sheet renderer');}};renderer.effekseer={play(animation,effect){played.push({animation,effect});}};
  for(const id of [121,122,123,124])renderer.effect({kind:'attack',animationId:id,x:3,y:4});
  assert.equal(played.length,4);assert.equal(renderer.effects.length,0);
  const pure={...animations[123]};delete pure.frames;delete pure.timings;renderer.database={Animations:[pure]};renderer.effect({kind:'damage',animationId:0,value:17,x:3,y:4});
  assert.equal(played.length,5);assert.equal(played[4].animation.effectName,'FireOne1');assert.equal(renderer.effects[0].value,17);
});
