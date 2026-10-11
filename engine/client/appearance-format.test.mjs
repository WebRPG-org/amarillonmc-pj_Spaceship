import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { paletteMatrix, appearanceLayers, appearanceKey } from './appearance-format.mjs';
import { loadAppearanceCatalog } from '../server/appearance.mjs';
import { loadContent } from '../server/content.mjs';

const projectRoot=fileURLToPath(new URL('../../',import.meta.url));
test('CharacterCreator colors match the original isolated PIXI matrices, including zero brightness',()=>{
  const source=fs.readFileSync(new URL('../../js/libs/pixi.js',import.meta.url),'utf8');
  const sandbox={ColorMatrixFilter:function(){this.uniforms={m:[1,0,0,0,0,0,1,0,0,0,0,0,1,0,0,0,0,0,1,0]};}};vm.createContext(sandbox);
  for(const method of ['_loadMatrix','_multiply','_colorMatrix','hue','saturate','brightness','greyscale']){
    const expression=source.match(new RegExp(`ColorMatrixFilter\\.prototype\\.${method} = function[^]*?\\n    };`))?.[0];assert.ok(expression,method);vm.runInContext(expression,sandbox);
  }
  const config=JSON.parse(fs.readFileSync(new URL('../../data/CharacterCreator.json',import.meta.url),'utf8'));
  for(const definition of Object.values(config))for(const [label,hue,saturation,brightness,grayscale]of definition.colors||[]){
    const filter=new sandbox.ColorMatrixFilter();filter.hue(0);if(grayscale)filter.greyscale(grayscale,true);if(brightness)filter.brightness(brightness,true);if(saturation)filter.saturate(saturation,true);if(hue)filter.hue(hue,true);
    const actual=paletteMatrix({hue,saturation,brightness,grayscale}),expected=[0,1,2,5,6,7,10,11,12].map(i=>filter.uniforms.m[i]);
    for(let i=0;i<9;i++)assert.ok(Math.abs(actual[i]-expected[i])<0.000001,`${label} component ${i}: ${actual[i]} != ${expected[i]}`);
  }
  assert.deepEqual(paletteMatrix({brightness:0}),[1,0,0,0,1,0,0,0,1]);
});

test('creator combines front/back sections in global layer order with a shared selected color',()=>{
  const red={id:2,hue:300};
  const catalog={creator:{groups:[{key:'Hair',colors:[red],options:[{id:'hair-1',layers:[{key:'front',order:13,walk:'/front.png'},{key:'back',order:2,walk:'/back.png'}]}]},{key:'Body',colors:[],options:[{id:'body-1',layers:[{key:'body',order:5,walk:'/body.png'}]}]}]}};
  const appearance={kind:'creator',pieces:{Hair:{id:'hair-1',color:2},Body:{id:'body-1',color:0}}};
  const layers=appearanceLayers(catalog,appearance);assert.deepEqual(layers.map(l=>l.key),['back','body','front']);assert.equal(layers[0].color,red);assert.equal(layers[2].color,red);
  assert.deepEqual(appearanceLayers(catalog,{kind:'actor',actorId:1}),[]);
  assert.deepEqual(appearanceLayers(catalog,{kind:'creator',pieces:{Hair:{id:'unknown',color:2}}}),[]);
});

test('appearance composition cache ignores object insertion order while retaining selection/color',()=>{
  const a={kind:'creator',pieces:{Eyes:{id:'eye',color:1},Body:{id:'body',color:0}}},b={kind:'creator',pieces:{Body:{id:'body',color:0},Eyes:{id:'eye',color:1}}};
  assert.equal(appearanceKey(a),appearanceKey(b));assert.notEqual(appearanceKey(a,'face'),appearanceKey(a,'walk'));b.pieces.Eyes.color=2;assert.notEqual(appearanceKey(a),appearanceKey(b));
});

test('actual restored creator catalog resolves defaults for walk, face and side-view assets',async()=>{
  const content=await loadContent(projectRoot),catalog=await loadAppearanceCatalog(projectRoot,content);
  assert.ok(catalog.creator.available);assert.ok(catalog.actors.length>0);
  for(const type of ['walk','face','sv']){
    const layers=appearanceLayers(catalog,catalog.creator.defaults,type);assert.ok(layers.length>=5);
    for(let i=1;i<layers.length;i++)assert.ok(layers[i-1].order<=layers[i].order);
    for(const layer of layers){assert.match(layer.url,/^\/assets\/img\/SumRndmDde\//);const relative=layer.url.slice('/assets/'.length).split('/').map(decodeURIComponent).join('/');assert.ok(fs.existsSync(`${projectRoot}/${relative}`),relative);}
  }
});
