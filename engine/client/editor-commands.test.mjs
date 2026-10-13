import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {commandCatalog, commandSummary, createBlock, decodeCommands, encodeCommands} from './editor-commands.mjs';

const c = (code, indent = 0, parameters = [], extra = {}) => ({code, indent, parameters, ...extra});
const t = (text, indent = 0) => [c(101, indent, ['', 0, 0, 2]), c(401, indent, [text])];

test('all supported commands have usable defaults and survive native encode/decode', () => {
  for (const entry of commandCatalog) {
    const block = createBlock(entry.type);
    const list = encodeCommands([block]);
    assert.equal(list.at(-1).code, 0, entry.type);
    const decoded = decodeCommands(list);
    assert.equal(decoded[0].type, entry.type, entry.type);
    assert.deepEqual(encodeCommands(decoded), list, entry.type);
    assert.ok(commandSummary(decoded[0]).length, entry.type);
  }
  assert.throws(() => createBlock('script'), /不支持/);
});

test('native MV/MZ parameters, terminal metadata and unknown commands roundtrip without mutation', () => {
  const list = [
    c(101, 0, ['Faces', 2, 1, 0, 'MZ Speaker', {extension: true}], {editorColor: 3}),
    c(401, 0, ['Hello', 'extension'], {lineId: 1}), c(401, 0, ['World'], {lineId: 2}),
    c(250, 0, [{name: 'Bell', volume: 75, pitch: 95, pan: -10, pluginAudio: 'keep'}, 'tail']),
    c(9001, 0, ['plugin', {nested: ['keep']}], {unknown: true}),
    c(122, 0, [1, 1, 0, 4, '$gamePlayer.x']),
    c(201, 0, [1, 1, 2, 3, 0, 0]), c(0, 0, [], {endMarker: 'keep'})
  ];
  const before = structuredClone(list), blocks = decodeCommands(list);
  assert.deepEqual(encodeCommands(blocks), before);
  assert.deepEqual(list, before);
  assert.deepEqual(blocks.slice(2).map(block => [block.type, block.readonly]), [['raw', true], ['raw', true], ['raw', true]]);
  blocks[0].values.text = 'Changed\nWorld';
  blocks[1].values.volume = 50;
  const edited = encodeCommands(blocks);
  assert.equal(edited[0].editorColor, 3);
  assert.equal(edited[0].parameters[4], 'MZ Speaker');
  assert.deepEqual(edited[0].parameters[5], {extension: true});
  assert.deepEqual(edited[1], c(401, 0, ['Changed', 'extension'], {lineId: 1}));
  assert.deepEqual(edited[3].parameters, [{name: 'Bell', volume: 50, pitch: 95, pan: -10, pluginAudio: 'keep'}, 'tail']);
  assert.deepEqual(edited.slice(4), before.slice(4));
});

test('editing MV text and old two-parameter animation does not invent MZ/wait parameters', () => {
  const blocks = decodeCommands([...t('Old'), c(212, 0, [0, 5], {x: 1}), c(0)]);
  blocks[0].values.text = 'New'; blocks[1].values.animationId = 6;
  let result = encodeCommands(blocks);
  assert.equal(result[0].parameters.length, 4);
  assert.deepEqual(result[2], c(212, 0, [0, 6], {x: 1}));
  blocks[0].values.speakerName = 'New speaker'; blocks[1].values.wait = true;
  result = encodeCommands(blocks);
  assert.equal(result[0].parameters[4], 'New speaker');
  assert.equal(result[2].parameters[2], true);
});

test('nested choice, condition, else and loop edits preserve raw metadata and proper indentation', () => {
  const list = [
    c(102, 0, [['Take', 'Leave'], -2, 0, 2, 0], {choiceExtension: true}),
    c(402, 0, [0, 'Take'], {branchExtension: 'keep'}),
    c(111, 1, [0, 3, 0], {conditionExtension: true}), ...t('Reward', 2), c(0, 2),
    c(411, 1, [], {elseExtension: 'keep'}), c(112, 2), c(9002, 3, ['keep'], {extension: 8}), c(113, 3), c(0, 3), c(413, 2), c(0, 2), c(412, 1), c(0, 1),
    c(402, 0, [1, 'Leave']), c(115, 1), c(0, 1),
    c(403, 0, [], {cancelExtension: true}), ...t('Cancelled', 1), c(0, 1), c(404), c(0)
  ];
  const blocks = decodeCommands(list), choice = blocks[0], condition = choice.branches[0].commands[0];
  assert.deepEqual(encodeCommands(blocks), list);
  assert.equal(condition.type, 'conditional');
  assert.equal(condition.elseChildren[0].type, 'loop');
  choice.branches[0].label = 'Accept'; condition.values.switchId = 9; condition.children[0].values.text = 'Granted';
  const result = encodeCommands(blocks);
  assert.deepEqual(result[0], c(102, 0, [['Accept', 'Leave'], -2, 0, 2, 0], {choiceExtension: true}));
  assert.deepEqual(result[1], c(402, 0, [0, 'Accept'], {branchExtension: 'keep'}));
  assert.deepEqual(result[2], c(111, 1, [0, 9, 0], {conditionExtension: true}));
  assert.deepEqual(result[4], c(401, 2, ['Granted']));
  assert.deepEqual(result.find(command => command.code === 9002), c(9002, 3, ['keep'], {extension: 8}));
  assert.deepEqual(result.find(command => command.code === 411), c(411, 1, [], {elseExtension: 'keep'}));
  assert.equal(result.find(command => command.code === 403).cancelExtension, true);
  assert.deepEqual(encodeCommands(decodeCommands(result)), result);
});

test('moving a decoded subtree rebases all raw descendants and unknown commands', () => {
  const raw = [c(111, 0, [0, 1, 0]), c(9001, 1, ['opaque'], {id: 'preserve'}), c(0, 1), c(412), c(0)];
  const condition = decodeCommands(raw)[0], loop = createBlock('loop');
  loop.children.push(condition);
  const encoded = encodeCommands([loop]);
  assert.deepEqual(encoded, [c(112), c(111, 1, [0, 1, 0]), c(9001, 2, ['opaque'], {id: 'preserve'}), c(0, 2), c(412, 1), c(0, 1), c(413), c(0)]);
  condition.values.switchId = 6;
  assert.deepEqual(encodeCommands([loop]).find(command => command.code === 9001), c(9001, 2, ['opaque'], {id: 'preserve'}));
});

test('all supported conditional types encode native parameter forms; unsupported conditions are atomic raw blocks', () => {
  const cases = [
    [{condition: 'switch', switchId: 7, switchValue: 1}, [0, 7, 1]],
    [{condition: 'variable', variableId: 4, operandType: 1, operand: 9, comparison: 5}, [1, 4, 1, 9, 5]],
    [{condition: 'selfSwitch', selfSwitch: 'C', switchValue: 0}, [2, 'C', 0]],
    [{condition: 'item', itemId: 23}, [8, 23]],
    [{condition: 'gold', gold: 80, goldComparison: 2}, [7, 80, 2]]
  ];
  for (const [values, expected] of cases) {
    const block = createBlock('conditional'); Object.assign(block.values, values);
    const list = encodeCommands([block]); assert.deepEqual(list[0].parameters, expected);
    assert.deepEqual(encodeCommands(decodeCommands(list)), list);
  }
  const unsupported = [c(111, 0, [12, 'arbitrary()']), ...t('Inside', 1), c(0, 1), c(411), c(117, 1, [2]), c(0, 1), c(412), c(0)];
  const blocks = decodeCommands(unsupported);
  assert.equal(blocks.length, 1); assert.equal(blocks[0].type, 'raw'); assert.equal(blocks[0].readonly, true);
  assert.deepEqual(encodeCommands(blocks), unsupported);
});

test('choice branches can be added, removed and reordered with native indices and cancellation retained', () => {
  const choices = createBlock('choices');
  choices.branches[0].commands.push(createBlock('wait'));
  const blocks = decodeCommands(encodeCommands([choices]));
  const first = blocks[0];
  first.branches.reverse(); first.branches.push({label: 'Third', commands: [createBlock('erase')]});
  first.values.defaultType = 2;
  let result = encodeCommands(blocks);
  assert.deepEqual(result[0].parameters[0], ['选项 2', '选项 1', 'Third']);
  assert.deepEqual(result.filter(command => command.code === 402).map(command => command.parameters), [[0, '选项 2'], [1, '选项 1'], [2, 'Third']]);
  assert.equal(result.filter(command => command.code === 403).length, 1);
  first.branches.splice(1, 1); delete first.cancel; first.values.cancelType = -1;
  result = encodeCommands(blocks);
  assert.equal(result.filter(command => command.code === 402).length, 2);
  assert.equal(result.filter(command => command.code === 403).length, 0);
});

test('move routes retain opaque steps and extensions while synchronizing 205 and 505 after editing', () => {
  const route = {list: [{code: 1, parameters: []}, {code: 77, parameters: ['opaque'], pluginStep: true}, {code: 0, parameters: [], endExtension: true}], repeat: true, skippable: false, wait: false, routeExtension: 8};
  const list = [c(205, 0, [0, route, 'tail'], {headerExtension: 9}), c(505, 0, [route.list[0]], {stepExtension: 1}), c(505, 0, [route.list[1]], {stepExtension: 2}), c(0)];
  const blocks = decodeCommands(list);
  assert.equal(blocks[0].type, 'moveRoute'); assert.deepEqual(encodeCommands(blocks), list);
  blocks[0].values.wait = true; blocks[0].values.targetId = -1; blocks[0].route[0].code = 4;
  const result = encodeCommands(blocks);
  assert.equal(result[0].parameters[0], -1); assert.equal(result[0].parameters[1].wait, true);
  assert.equal(result[0].parameters[1].routeExtension, 8); assert.equal(result[0].parameters[2], 'tail'); assert.equal(result[0].headerExtension, 9);
  assert.deepEqual(result[1], c(505, 0, [{code: 4, parameters: []}], {stepExtension: 1}));
  assert.deepEqual(result[2], list[2]);
  assert.deepEqual(result[0].parameters[1].list.at(-1), route.list.at(-1));
  assert.deepEqual(encodeCommands(decodeCommands(result)), result);
});

test('native movement steps may omit parameters, including the route terminator', () => {
  const route = {list: [{code: 12}, {code: 17}, {code: 77, extension: true}, {code: 0}], repeat: false, skippable: true, wait: true};
  const list = [c(205, 0, [-1, route]), c(505, 0, [{code: 12}]), c(505, 0, [{code: 17}]), c(505, 0, [{code: 77, extension: true}]), c(0)];
  const blocks = decodeCommands(list);
  assert.equal(blocks[0].type, 'moveRoute');
  assert.deepEqual(encodeCommands(blocks), list);
  blocks[0].values.wait = false;
  const edited = encodeCommands(blocks);
  assert.deepEqual(edited[0].parameters[1].list, route.list);
  assert.deepEqual(edited.slice(1), list.slice(1));
});

test('unsupported variable operands, command continuations and malformed structures remain read-only', () => {
  const list = [c(122, 0, [1, 2, 0, 2, 5, 10]), c(355, 0, ['doSomething();']), c(655, 0, ['another();'], {extension: true}), c(111, 0, [0, 1, 0]), c(230, 1, [20]), c(0)];
  const blocks = decodeCommands(list);
  assert.equal(blocks[0].type, 'raw'); assert.equal(blocks[1].raw.length, 2); assert.equal(blocks[2].type, 'raw');
  assert.deepEqual(encodeCommands(blocks), list);
});

test('catalog exposes conditional visibility and context names without requiring a database', () => {
  const fields = commandCatalog.find(entry => entry.type === 'conditional').fields;
  assert.deepEqual(fields.find(field => field.key === 'switchId').when, {key: 'condition', value: 'switch'});
  assert.deepEqual(fields.find(field => field.key === 'switchValue').when, {key: 'condition', values: ['switch', 'selfSwitch']});
  const block = createBlock('item'); block.values.itemId = 3;
  assert.match(commandSummary(block, {database: {Items: [null, null, null, {name: '面包'}]}}), /面包/);
});

test('every checked-in map event page preserves its native command list exactly', async () => {
  const root = new URL('../../data/', import.meta.url), files = (await readdir(root)).filter(name => /^Map\d+\.json$/.test(name));
  let pages = 0;
  for (const name of files) {
    const map = JSON.parse(await readFile(new URL(name, root), 'utf8'));
    for (const event of map.events || []) for (const [pageIndex, page] of (event?.pages || []).entries()) {
      if (!Array.isArray(page.list)) continue;
      assert.deepEqual(encodeCommands(decodeCommands(page.list)), page.list, `${name} event ${event.id} page ${pageIndex + 1}`);
      for (const command of page.list.filter(command => command.code === 205)) {
        assert.equal(decodeCommands([command, c(0)])[0].type, 'moveRoute', `${name} event ${event.id}: native movement route must be editable`);
      }
      pages++;
    }
  }
  assert.ok(pages > 100, `Expected a meaningful native-map corpus, received ${pages} pages`);
});
