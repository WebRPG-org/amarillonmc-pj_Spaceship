import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {effectUrl,effectGeometry,effectViewport} from './effekseer-format.mjs';
test('MZ effect paths remain inside effects and preserve nested resource names',()=>{
 assert.equal(effectUrl('FireOne1'),'/assets/effects/FireOne1.efkefc');assert.equal(effectUrl('magic/冰'),'/assets/effects/magic/%E5%86%B0.efkefc');
 for(const name of ['../.env','a/../secret','a\\secret','/a',''])assert.throws(()=>effectUrl(name));
});
test('MZ transform settings and map anchors account for pixel density, zoom, mirror and bottom-origin WebGL',()=>{
 const animation={scale:50,speed:150,rotation:{x:90,y:0,z:180},offsetX:20,offsetY:-10};
 assert.deepEqual(effectGeometry(animation),{scale:.5,speed:1.5,rotation:[Math.PI/2,0,Math.PI],offsetX:20,offsetY:-10});
 const v=effectViewport(animation,{x:100,y:120},1600,1200,2);
 assert.equal(v.x+v.size/2,240);assert.equal(v.y+v.size/2,980);
 assert.equal(effectViewport({...animation,mirror:true},{x:0,y:0},800,600,1).projection[0],-1);
});
test('all selected actual MZ effects and declared texture dependencies are present',async()=>{
 const manifest=JSON.parse(await readFile(new URL('./vendor/effekseer/SOURCE.json',import.meta.url),'utf8'));
 const animations=JSON.parse(await readFile(new URL('../../data/Animations.json',import.meta.url),'utf8'));
 assert.equal(manifest.effects.length,4);
 for(const e of manifest.effects){assert.equal(animations[e.animationId].effectName,e.effectName);const bytes=await readFile(new URL(`../../effects/${e.effectName}.efkefc`,import.meta.url));assert.equal(bytes.subarray(0,4).toString(),'EFKE');for(const file of e.dependencies)await access(new URL(`../../effects/${file}`,import.meta.url));}
 const wasm=await readFile(new URL('./vendor/effekseer/effekseer.wasm',import.meta.url));assert.equal(wasm.readUInt32LE(0),0x6d736100);
});
