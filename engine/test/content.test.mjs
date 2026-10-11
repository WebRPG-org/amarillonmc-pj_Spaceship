import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadContent, classifyScript } from '../server/content.mjs';

const projectRoot=fileURLToPath(new URL('../../',import.meta.url));
const content=await loadContent(projectRoot);

test('imports every existing map, database and enabled plugin as data',()=>{
  assert.equal(content.maps.size,48);
  const events=[...content.maps.values()].flatMap(map=>map.events.filter(Boolean));
  assert.equal(content.coverage.summary.events,events.length);
  assert.equal(content.coverage.summary.pages,events.reduce((total,event)=>total+event.pages.length,0));
  assert.equal(content.coverage.summary.plugins,44);
  assert.equal(content.getMap(11).width,59);
  assert.equal(content.database.Items[40].name,'Curry Bread');
  assert.equal(content.getTileset(11).id,content.getMap(11).tilesetId);
});

test('Chrono tool import preserves real skills and projectile metadata',()=>{
  assert.equal(content.getToolForSkill(99).id,99);
  assert.equal(content.getTool(99).projectile,true);
  assert.equal(content.getTool(99).skillId,99);
  assert.equal(content.weaponTools.get(1),80);
  assert.ok(content.getTool(99).damage.formula);
  assert.equal(content.getTool(1).itemId,1);
  assert.equal(content.coverage.summary.tools,76);
  for(const id of [100,101,102,103])assert.ok(content.getTool(id));
});

test('imports recipe ingredients, unlock books and composition output',()=>{
  const curry=content.getRecipe('item:40');
  assert.deepEqual(curry.ingredients,[{kind:'item',itemId:47,amount:1},{kind:'item',itemId:48,amount:1}]);
  assert.deepEqual(curry.books,[38]);
  const composition=content.recipes.find(r=>r.source==='KJ_Composition');
  assert.equal(composition.result.itemId,14);
  assert.deepEqual(composition.ingredients.map(x=>x.itemId),[8,10]);
});

test('coverage makes unsupported scripts and retired PvP pages visible',()=>{
  assert.ok(content.describeMap(26).quarantinedPages.length>0);
  assert.ok(content.describeMap(29).scripts.some(s=>s.text.includes('Galv.')&&s.status==='unsupported'));
  assert.ok(content.describeMap(3).plugins.some(s=>s.parameters[0]==='OpenCharacterCreator 1'&&s.status==='unsupported'));
  assert.equal(content.coverage.commonEvents.source,'CommonEvents.json');
  assert.equal(classifyScript('process.exit()').status,'unsupported');
  assert.equal(classifyScript('$gameMap.copyEventFromMapToRegion(26, 2, 21, true);').status,'adapted');
});

test('spawn selection stays within a map and has a traversable edge',()=>{
  for(const map of content.maps.values()){
    const spawn=content.findSpawn(map.id,-10,100000);
    if(!spawn)continue;
    assert.ok(spawn.x>=0&&spawn.x<map.width&&spawn.y>=0&&spawn.y<map.height);
    assert.ok([2,4,6,8].some(d=>content.isPassable(map.id,spawn.x,spawn.y,d)));
  }
  assert.equal(content.findSpawn(99999),null);
  assert.equal(content.isPassable(1,0,0,3),false);
});
