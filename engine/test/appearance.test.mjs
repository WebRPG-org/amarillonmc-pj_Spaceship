import test from 'node:test';
import assert from 'node:assert/strict';
import {stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {loadContent} from '../server/content.mjs';
import {loadAppearanceCatalog,normalizeAppearance} from '../server/appearance.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const content=await loadContent(root),catalog=await loadAppearanceCatalog(root,content);

test('the existing SRD creator catalog preserves paired layers, palettes and required parts',async()=>{
  assert.equal(catalog.creator.available,true);assert.equal(catalog.creator.groups.length,14);
  const hair=catalog.creator.groups.find(g=>g.key==='Front Hair');
  const option=hair.options.find(o=>o.id==='Front Hair (1)');
  assert.deepEqual(option.layers.map(l=>l.key).sort(),['Front Hair Part1','Front Hair Part2']);
  assert.equal(hair.colors.find(c=>c.label==='Blue').hue,180);
  for(const group of catalog.creator.groups)for(const option of group.options)for(const layer of option.layers)for(const style of ['walk','face','sv','dead'])if(layer[style]){
    const local=path.join(root,decodeURIComponent(layer[style].slice('/assets/'.length)));assert.equal((await stat(local)).isFile(),true);
  }
});

test('appearance validation persists identities and rejects fabricated paths, parts, palettes and incomplete bodies',()=>{
  const valid=normalizeAppearance(catalog.creator.defaults,catalog);assert.equal(valid.kind,'creator');assert.ok(valid.pieces.Body);
  const skin=normalizeAppearance({kind:'actor',actorId:catalog.actors[0].id,characterName:'../../secret'},catalog);
  assert.equal(skin.characterName,catalog.actors[0].characterName);
  assert.throws(()=>normalizeAppearance({kind:'creator',pieces:{}},catalog),/选择/);
  assert.throws(()=>normalizeAppearance({kind:'actor',actorId:999999},catalog),/不存在/);
  const corrupt=structuredClone(catalog.creator.defaults);corrupt.pieces.Body.id='../private';assert.throws(()=>normalizeAppearance(corrupt,catalog),/不存在/);
  corrupt.pieces.Body={...valid.pieces.Body,color:999};assert.throws(()=>normalizeAppearance(corrupt,catalog),/配色/);
});
