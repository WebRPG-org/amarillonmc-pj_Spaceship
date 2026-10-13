import test from 'node:test';
import assert from 'node:assert/strict';
import {clone, newPage, newEvent, eventTag, setEventTag, toolValue, setToolValue, mapPatch} from './editor-document.mjs';
import {decodeCommands, encodeCommands} from './editor-commands.mjs';
import {ContentWorkbench} from '../server/workbench.mjs';
import {newMapTemplate, validateEventPages} from '../server/editor-validation.mjs';

const command = (code, parameters = [], indent = 0, extra = {}) => ({code, indent, parameters, ...extra});
function fixture() {
  const map = newMapTemplate({width: 3, height: 2, tilesetId: 1, name: '原生地图'});
  map.customMap = {weather: 'keep'};
  map.events.push({id: 1, name: '向导', note: '<plugin:preserve>', x: 0, y: 0, pages: [newPage()], customEvent: {actor: 'preserve'}});
  const content = {maps: new Map([[1, map]]), database: {Tilesets: [null, {id: 1}], Items: [null, {id: 1}], Weapons: [null, {id: 1}], Armors: [null, {id: 1}]}};
  const editor = new ContentWorkbench({projectRoot: process.cwd(), content});
  return {map, editor};
}

test('event templates produce editable native pages with independent defaults and preserve event ID slots', () => {
  const {map} = fixture(); map.events.push(null, {...clone(map.events[1]), id: 3, name: '已有事件'});
  const context = {mapId: 9, gameplay: {npcs: {guard: {}}, structures: {barricade: {}}, shops: {supplies: {}}, scenarios: {adventure: {containerLoot: {medicine: []}}}}};
  for (const type of ['blank', 'dialogue', 'transfer', 'npc', 'structure', 'shop', 'container', 'meteorDisk', 'meteorExit', 'tool']) {
    const event = newEvent(map, {x: 2, y: 1}, type, context);
    assert.equal(event.id, 4, type); assert.equal(event.x, 2); assert.equal(event.y, 1);
    assert.doesNotThrow(() => validateEventPages(event.pages), type);
    assert.deepEqual(encodeCommands(decodeCommands(event.pages[0].list)), event.pages[0].list, type);
    if (type === 'dialogue') assert.equal(event.pages[0].list[0].code, 101);
    if (type === 'tool') { assert.equal(toolValue(event.pages[0], 'tool_range'), '1'); assert.equal(toolValue(event.pages[0], 'tool_skill_id'), '1'); }
    if (type === 'transfer') {
      assert.equal(event.pages[0].trigger, 1); assert.equal(event.pages[0].priorityType, 0);
      assert.deepEqual(event.pages[0].list[0].parameters, [0, 9, 2, 1, 0, 0]);
    }
    const tags = {npc: ['engine_npc', 'guard'], structure: ['engine_structure', 'barricade'], shop: ['engine_shop', 'supplies'], container: ['engine_container', 'medicine'], meteorDisk: ['engine_service', 'meteorDisk'], meteorExit: ['engine_service', 'meteorExit']};
    if (tags[type]) assert.equal(eventTag(event, tags[type][0]), tags[type][1]);
  }
  const first = newPage(), second = newPage();
  first.conditions.switch1Valid = true; first.moveRoute.list.push({code: 12}); first.list[0].parameters.push('changed');
  assert.equal(second.conditions.switch1Valid, false);
  assert.equal(second.moveRoute.list.length, 1);
  assert.deepEqual(second.list[0].parameters, []);
  assert.equal(map.events[2], null); assert.equal(map.events[3].id, 3);
});

test('a resized six-layer draft saves only actual painted differences and reconstructs the visible map', () => {
  const {map, editor} = fixture();
  const layers = [[1, 2, 3, 4, 5, 6], [11, 12, 13, 14, 15, 16], [21, 22, 23, 24, 25, 26], [31, 32, 33, 34, 35, 36], [1, 2, 4, 8, 3, 5], [91, 92, 93, 94, 95, 96]];
  map.data = layers.flat(); const before = clone(map), draft = clone(map);
  draft.width = 4; draft.height = 3;
  draft.data = layers.flatMap(layer => [layer[0], layer[1], layer[2], 0, layer[3], layer[4], layer[5], 0, 0, 0, 0, 0]);
  const edits = [{x: 0, y: 0, z: 0, tileId: 0}, {x: 3, y: 2, z: 1, tileId: 101}, {x: 2, y: 1, z: 2, tileId: 202}, {x: 1, y: 2, z: 3, tileId: 303}, {x: 3, y: 0, z: 4, tileId: 15}, {x: 3, y: 2, z: 5, tileId: 255}];
  for (const {x, y, z, tileId} of edits) draft.data[z * 12 + y * 4 + x] = tileId;
  const patch = mapPatch(map, draft);
  assert.deepEqual(patch.properties, {width: 4, height: 3});
  assert.equal(patch.tiles.length, edits.length, 'dimension reindexing must not repaint unchanged cells');
  assert.deepEqual(patch.events, []);
  const saved = editor.apply('map', map, patch, 1);
  assert.deepEqual(saved, draft);
  assert.deepEqual(map, before, 'making a patch and saving a draft must not mutate the loaded original');
  assert.deepEqual(mapPatch(saved, clone(saved)), {properties: {}, tiles: [], events: []});
});

test('shrinking a map preserves surviving layers and explicit event deletion leaves later IDs in place', () => {
  const {map, editor} = fixture();
  map.events.push({...clone(map.events[1]), id: 2, name: '引用目标', x: 1, y: 0});
  map.events[2].pages[0].list = [command(205, [2, {list: [{code: 12}, {code: 0}], repeat: false, skippable: true, wait: false}]), command(0)];
  map.data = Array.from({length: 6}, (_, z) => z === 4 ? [1, 2, 3, 4, 5, 6] : [z + 1, z + 2, z + 3, z + 4, z + 5, z + 6]).flat();
  const draft = clone(map); draft.width = 2; draft.height = 1;
  draft.data = Array.from({length: 6}, (_, z) => [map.data[z * 6], map.data[z * 6 + 1]]).flat();
  draft.events[1] = null;
  const patch = mapPatch(map, draft);
  assert.deepEqual(patch.events, [{id: 1, remove: true}]); assert.deepEqual(patch.tiles, []);
  const saved = editor.apply('map', map, patch, 1);
  assert.deepEqual(saved, draft); assert.equal(saved.events[2].id, 2); assert.equal(saved.events.length, 3);
  assert.equal(saved.events[2].pages[0].list[0].parameters[0], 2, 'references to a later event ID must not be renumbered');
});

test('changing one entity tag resolves legacy aliases and preserves unrelated comments, commands and metadata', () => {
  const {map} = fixture(), event = clone(map.events[1]);
  event.note = '<plugin:keep>\nengine_enemy: note_old\nengine_shop: supplies';
  event.pages[0].list = [
    command(108, ['engine_enemy: old'], 1, {commentExtension: 'removed tag'}),
    command(408, ['preserve continuation', 'unknown parameter'], 1, {commentExtension: 'keep'}),
    command(108, ['engine_container: medicine\nengine_npc: obsolete\nother plugin text'], 0, {multilineExtension: true}),
    command(101, ['', 0, 0, 2]), command(401, ['engine_npc: dialogue_is_not_a_tag'], 0, {dialogueExtension: true}),
    command(357, ['Plugin', 'Command', 'Name', {value: 'opaque'}], 0, {commandExtension: true}), command(0)
  ];
  event.pages.push({...newPage(), customPage: {keep: true}, list: [command(108, ['<engine_enemy: second_page>']), command(408, ['second-page comment'], 0, {keep: 'metadata'}), command(0)]});
  assert.equal(eventTag(event, 'engine_npc'), 'obsolete', 'canonical tag takes precedence over the legacy alias');
  const unchanged = clone(event); setEventTag(event, 'engine_npc', 'guard');
  assert.equal(eventTag(event, 'engine_npc'), 'guard'); assert.equal(eventTag(event, 'engine_shop'), 'supplies'); assert.equal(eventTag(event, 'engine_container'), 'medicine');
  assert.equal(event.note, '<plugin:keep>\nengine_shop: supplies\nengine_npc: guard');
  assert.deepEqual(event.pages[0].list[0], command(108, ['preserve continuation', 'unknown parameter'], 1, {commentExtension: 'keep'}));
  assert.deepEqual(event.pages[0].list[1], command(108, ['engine_container: medicine\nother plugin text'], 0, {multilineExtension: true}));
  assert.deepEqual(event.pages[0].list.slice(2), unchanged.pages[0].list.slice(3));
  assert.deepEqual(event.pages[1].list[0], command(108, ['second-page comment'], 0, {keep: 'metadata'}));
  assert.deepEqual(event.pages[1].customPage, {keep: true}); assert.deepEqual(event.customEvent, unchanged.customEvent);
  const once = clone(event); setEventTag(event, 'engine_npc', 'guard'); assert.deepEqual(event, once, 'normalization is idempotent');
  setEventTag(event, 'engine_npc', ''); assert.equal(eventTag(event, 'engine_npc'), '');
  assert.equal(event.pages[0].list.find(c => c.code === 401).parameters[0], 'engine_npc: dialogue_is_not_a_tag');
  assert.equal(eventTag(event, 'engine_shop'), 'supplies'); assert.equal(eventTag(event, 'engine_container'), 'medicine');
  assert.throws(() => setEventTag(event, 'other_plugin', 'new'), /未知/);
});

test('changing a shop tag does not reinterpret NPC comments or touch other event pages', () => {
  const {map} = fixture(), event = clone(map.events[1]);
  event.note = 'engine_shop: old\n<other-note:preserve>';
  event.pages[0].list = [command(108, ['engine_enemy: guard'], 0, {legacy: true}), command(408, ['plugin: keep'], 0, {continuation: true}), command(0)];
  event.pages[0].customPage = {enabled: true};
  event.pages.push({...newPage(), list: [command(101, ['', 0, 0, 2]), command(401, ['unchanged']), command(0)]});
  const pages = clone(event.pages); setEventTag(event, 'engine_shop', 'supplies');
  assert.deepEqual(event.pages, pages); assert.equal(eventTag(event, 'engine_npc'), 'guard');
  assert.equal(event.note, '<other-note:preserve>\nengine_shop: supplies');
});

test('editing tool properties accepts legacy spelling and retains other tool commands and extensions', () => {
  const page = newPage();
  page.list = [
    command(108, ['tool duration : 12']),
    command(408, ['tool_position : target', 'extension parameter'], 0, {pluginMetadata: true}),
    command(108, ['tool_duration : 24\ntool_unknown_option : preserve'], 0, {multiline: 'keep'}),
    command(108, ['tool projectile']),
    command(357, ['CustomToolPlugin', 'Command', 'Name', {data: true}], 0, {commandMetadata: 'keep'}),
    command(0, [], 0, {endMetadata: 'keep'})
  ];
  assert.equal(toolValue(page, 'tool_duration'), '12'); assert.equal(toolValue(page, 'tool_projectile'), true);
  const original = clone(page); setToolValue(page, 'tool_duration', 60);
  assert.equal(toolValue(page, 'tool_duration'), '60'); assert.equal(toolValue(page, 'tool_projectile'), true);
  assert.deepEqual(page.list.find(c => c.pluginMetadata), command(108, ['tool_position : target', 'extension parameter'], 0, {pluginMetadata: true}));
  assert.deepEqual(page.list.find(c => c.multiline), command(108, ['tool_unknown_option : preserve'], 0, {multiline: 'keep'}));
  assert.deepEqual(page.list.slice(-2), original.list.slice(-2));
  const once = clone(page); setToolValue(page, 'tool_duration', 60); assert.deepEqual(page, once);
  setToolValue(page, 'tool_projectile', false); assert.equal(toolValue(page, 'tool_projectile'), undefined);
  setToolValue(page, 'tool_disable_piercing', true); assert.equal(toolValue(page, 'tool_disable_piercing'), true);
  setToolValue(page, 'tool_item_cost', 0); assert.equal(toolValue(page, 'tool_item_cost'), '0');
  assert.deepEqual(encodeCommands(decodeCommands(page.list)), page.list);
  assert.throws(() => setToolValue(page, 'tool_unsupported_generated_property', 1), /未知/);
});

test('editing an existing event preserves opaque plugin data across the client-to-server patch', () => {
  const {map, editor} = fixture();
  const event = map.events[1]; event.customEvent = {scriptText: 'not executed', value: [1, {preserved: true}]};
  event.pages[0].customPage = {opaque: true}; event.pages[0].image.pluginSprite = 'keep';
  event.pages[0].moveRoute.pluginRoute = {keep: true};
  event.pages[0].list = [command(999, ['unknown'], 0, {pluginCommand: {keep: true}}), command(0, [], 0, {endMetadata: true})];
  const draft = clone(map); draft.events[1].name = '改名'; draft.events[1].pages[0].conditions.switch1Valid = true;
  draft.events[1].pages[0].list = encodeCommands(decodeCommands(draft.events[1].pages[0].list));
  const saved = editor.apply('map', map, mapPatch(map, draft), 1);
  assert.deepEqual(saved, draft); assert.equal(map.events[1].name, '向导');
});

test('duplicating an event preserves top-level and nested extension data under the new native ID', () => {
  const {map, editor} = fixture();
  map.events[1].pluginIdentity = {category: 'character', data: [{enabled: true}]};
  map.events[1].pages[0].pluginPage = {keep: true};
  map.events[1].pages[0].list = [command(357, ['Custom', 'Command', 'Title', {keep: true}], 0, {editorMetadata: 7}), command(0)];
  const draft = clone(map), duplicate = clone(map.events[1]);
  duplicate.id = 2; duplicate.name = '复制后的事件'; duplicate.x = 2; draft.events.push(duplicate);
  const patch = mapPatch(map, draft), saved = editor.apply('map', map, patch, 1);
  assert.deepEqual(saved.events[2], duplicate);
  assert.deepEqual(saved.events[1], map.events[1]); assert.deepEqual(saved.customMap, map.customMap);
  saved.events[2].pluginIdentity.data[0].enabled = false;
  assert.equal(saved.events[1].pluginIdentity.data[0].enabled, true, 'a copied event must own its extension data');
});
