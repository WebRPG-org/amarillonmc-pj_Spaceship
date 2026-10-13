/** A lossless, data-only editor for the supported subset of native MV/MZ event lists.
 * No event scripts are evaluated or generated. Unsupported commands remain raw.
 * Arrays returned by decodeCommands carry their original terminal command in
 * _terminator; block.raw also retains the complete native representation.
 */
const copy = value => value === undefined ? undefined : structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const number = (key, label, extra = {}) => ({key, label, type: 'number', ...extra});
const text = (key, label, extra = {}) => ({key, label, type: 'text', ...extra});
const select = (key, label, options, extra = {}) => ({key, label, type: 'select', options, ...extra});
const checkbox = (key, label, extra = {}) => ({key, label, type: 'checkbox', ...extra});
const yesNo = [[0, 'ON'], [1, 'OFF']];
const operandOptions = [[0, '常数'], [1, '变量']];
const operationOptions = [[0, '增加'], [1, '减少']];
const variableOperations = [[0, '赋值'], [1, '加'], [2, '减'], [3, '乘'], [4, '除'], [5, '取余']];
const letters = ['A', 'B', 'C', 'D'].map(value => [value, value]);
const when = value => ({when: {key: 'condition', value}});
const audioFields = [text('name', '音频文件名'), number('volume', '音量'), number('pitch', '音调'), number('pan', '声像')];
const amountFields = [select('operation', '操作', operationOptions), select('operandType', '数量来源', operandOptions), number('operand', '数量 / 变量 ID')];

export const commandCatalog = [
  {type: 'text', label: '显示文字', category: '对话', fields: [
    {key: 'text', label: '正文', type: 'textarea'}, text('faceName', '头像文件名'), number('faceIndex', '头像编号'),
    select('background', '背景', [[0, '窗口'], [1, '暗色'], [2, '透明']]),
    select('positionType', '位置', [[0, '上'], [1, '中'], [2, '下']]), text('speakerName', '说话人（MZ）')
  ]},
  {type: 'choices', label: '显示选项', category: '对话', fields: [
    number('cancelType', '取消项（-2：取消分支，-1：禁止，其他：选项序号）'), number('defaultType', '默认项（从 0 开始，-1 无默认）'),
    select('positionType', '位置', [[0, '左'], [1, '中'], [2, '右']]), select('background', '背景', [[0, '窗口'], [1, '暗色'], [2, '透明']])
  ]},
  {type: 'conditional', label: '条件分支', category: '流程', fields: [
    select('condition', '判断对象', [['switch', '开关'], ['variable', '变量'], ['selfSwitch', '独立开关'], ['item', '持有物品'], ['gold', '金钱']]),
    number('switchId', '开关 ID', when('switch')), select('switchValue', '状态', yesNo, {when: {key: 'condition', values: ['switch', 'selfSwitch']}}),
    number('variableId', '变量 ID', when('variable')), select('operandType', '比较来源', operandOptions, when('variable')),
    number('operand', '比较值 / 变量 ID', when('variable')), select('comparison', '比较', [[0, '='], [1, '≥'], [2, '≤'], [3, '>'], [4, '<'], [5, '≠']], when('variable')),
    select('selfSwitch', '独立开关', letters, when('selfSwitch')), number('itemId', '物品 ID', when('item')),
    number('gold', '金钱数量', when('gold')), select('goldComparison', '比较', [[0, '≥'], [1, '≤'], [2, '<']], when('gold'))
  ]},
  {type: 'loop', label: '循环', category: '流程', fields: []},
  {type: 'break', label: '跳出循环', category: '流程', fields: []},
  {type: 'exit', label: '结束事件处理', category: '流程', fields: []},
  {type: 'common', label: '公共事件', category: '流程', fields: [number('commonEventId', '公共事件 ID')]},
  {type: 'label', label: '标签', category: '流程', fields: [text('name', '标签名')]},
  {type: 'jump', label: '跳转标签', category: '流程', fields: [text('name', '标签名')]},
  {type: 'switches', label: '控制开关', category: '进度', fields: [number('startId', '起始开关 ID'), number('endId', '结束开关 ID'), select('value', '状态', yesNo)]},
  {type: 'variables', label: '控制变量', category: '进度', fields: [number('startId', '起始变量 ID'), number('endId', '结束变量 ID'), select('operation', '操作', variableOperations), select('operandType', '来源', operandOptions), number('operand', '值 / 变量 ID')]},
  {type: 'selfSwitch', label: '控制独立开关', category: '进度', fields: [select('key', '独立开关', letters), select('value', '状态', yesNo)]},
  {type: 'gold', label: '增减金钱', category: '物品', fields: amountFields},
  ...[['item', '物品', 'itemId'], ['weapon', '武器', 'weaponId'], ['armor', '防具', 'armorId']].map(([type, label, key]) => ({
    type, label: `增减${label}`, category: '物品', fields: [number(key, `${label} ID`), ...amountFields, ...(type === 'item' ? [] : [checkbox('includeEquipment', '减少时包含已装备物品')])]
  })),
  {type: 'transfer', label: '场所移动', category: '地图', fields: [number('mapId', '地图 ID'), number('x', 'X'), number('y', 'Y'), select('direction', '朝向', [[0, '保持'], [2, '下'], [4, '左'], [6, '右'], [8, '上']]), select('fade', '淡出', [[0, '黑'], [1, '白'], [2, '无']])]},
  {type: 'moveRoute', label: '设置移动路线', category: '地图', fields: [number('targetId', '目标（-1 玩家，0 本事件）'), checkbox('repeat', '循环路线'), checkbox('skippable', '无法移动时跳过'), checkbox('wait', '等待路线完成')]},
  {type: 'wait', label: '等待', category: '流程', fields: [number('frames', '帧数（60 帧 / 秒）')]},
  {type: 'sound', label: '播放音效', category: '演出', fields: audioFields},
  {type: 'bgm', label: '播放 BGM', category: '演出', fields: audioFields},
  {type: 'animation', label: '显示动画', category: '演出', fields: [number('targetId', '目标（-1 玩家，0 本事件）'), number('animationId', '动画 ID'), checkbox('wait', '等待完成')]},
  {type: 'balloon', label: '显示气泡', category: '演出', fields: [number('targetId', '目标（-1 玩家，0 本事件）'), number('balloonId', '气泡 ID'), checkbox('wait', '等待完成')]},
  {type: 'erase', label: '暂时消除事件', category: '地图', fields: []},
  {type: 'comment', label: '注释', category: '其他', fields: [{key: 'text', label: '注释内容', type: 'textarea'}]}
];

const defaults = {
  text: {text: '', faceName: '', faceIndex: 0, background: 0, positionType: 2, speakerName: ''},
  choices: {cancelType: -2, defaultType: 0, positionType: 2, background: 0},
  conditional: {condition: 'switch', switchId: 1, switchValue: 0, variableId: 1, operandType: 0, operand: 0, comparison: 0, selfSwitch: 'A', itemId: 1, gold: 0, goldComparison: 0},
  loop: {}, break: {}, exit: {}, common: {commonEventId: 1}, label: {name: ''}, jump: {name: ''},
  switches: {startId: 1, endId: 1, value: 0}, variables: {startId: 1, endId: 1, operation: 0, operandType: 0, operand: 0}, selfSwitch: {key: 'A', value: 0},
  gold: {operation: 0, operandType: 0, operand: 1}, item: {itemId: 1, operation: 0, operandType: 0, operand: 1},
  weapon: {weaponId: 1, operation: 0, operandType: 0, operand: 1, includeEquipment: false}, armor: {armorId: 1, operation: 0, operandType: 0, operand: 1, includeEquipment: false},
  transfer: {mapId: 1, x: 0, y: 0, direction: 0, fade: 0}, moveRoute: {targetId: 0, repeat: false, skippable: false, wait: true},
  wait: {frames: 60}, sound: {name: '', volume: 90, pitch: 100, pan: 0}, bgm: {name: '', volume: 90, pitch: 100, pan: 0},
  animation: {targetId: 0, animationId: 1, wait: false}, balloon: {targetId: 0, balloonId: 1, wait: false}, erase: {}, comment: {text: ''}
};

export function createBlock(type) {
  if (!Object.hasOwn(defaults, type)) throw new Error(`不支持的可编辑命令：${type}`);
  const block = {type, values: copy(defaults[type])};
  if (type === 'choices') { block.branches = [{label: '选项 1', commands: []}, {label: '选项 2', commands: []}]; block.cancel = []; }
  if (type === 'conditional' || type === 'loop') block.children = [];
  if (type === 'moveRoute') block.route = [{code: 0, parameters: []}];
  return block;
}

const codeTypes = {101: 'text', 102: 'choices', 108: 'comment', 111: 'conditional', 112: 'loop', 113: 'break', 115: 'exit', 117: 'common', 118: 'label', 119: 'jump', 121: 'switches', 122: 'variables', 123: 'selfSwitch', 125: 'gold', 126: 'item', 127: 'weapon', 128: 'armor', 201: 'transfer', 205: 'moveRoute', 212: 'animation', 213: 'balloon', 214: 'erase', 230: 'wait', 241: 'bgm', 250: 'sound'};
const typeCodes = Object.fromEntries(Object.entries(codeTypes).map(([code, type]) => [type, Number(code)]));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const oneOf = (value, options) => options.includes(value);
const boolean = value => typeof value === 'boolean';
const string = value => typeof value === 'string';
const terminal = indent => ({code: 0, indent, parameters: []});

function decodeValues(command) {
  const p = command.parameters;
  if (!Array.isArray(p)) return null;
  const type = codeTypes[command.code];
  if (!type) return null;
  let v = {};
  switch (type) {
    case 'text':
      if (!string(p[0]) || !finite(p[1]) || !oneOf(p[2], [0, 1, 2]) || !oneOf(p[3], [0, 1, 2]) || (p.length > 4 && !string(p[4]))) return null;
      v = {faceName: p[0], faceIndex: p[1], background: p[2], positionType: p[3], speakerName: p[4] ?? '', text: ''}; break;
    case 'choices':
      if (!Array.isArray(p[0]) || !p[0].every(string) || !finite(p[1]) || !finite(p[2]) || !oneOf(p[3], [0, 1, 2]) || !oneOf(p[4], [0, 1, 2])) return null;
      v = {cancelType: p[1], defaultType: p[2], positionType: p[3], background: p[4]}; break;
    case 'conditional':
      if (p[0] === 0 && finite(p[1]) && oneOf(p[2], [0, 1])) v = {condition: 'switch', switchId: p[1], switchValue: p[2]};
      else if (p[0] === 1 && finite(p[1]) && oneOf(p[2], [0, 1]) && finite(p[3]) && oneOf(p[4], [0, 1, 2, 3, 4, 5])) v = {condition: 'variable', variableId: p[1], operandType: p[2], operand: p[3], comparison: p[4]};
      else if (p[0] === 2 && oneOf(p[1], ['A', 'B', 'C', 'D']) && oneOf(p[2], [0, 1])) v = {condition: 'selfSwitch', selfSwitch: p[1], switchValue: p[2]};
      else if (p[0] === 7 && finite(p[1]) && oneOf(p[2], [0, 1, 2])) v = {condition: 'gold', gold: p[1], goldComparison: p[2]};
      else if (p[0] === 8 && finite(p[1])) v = {condition: 'item', itemId: p[1]};
      else return null;
      break;
    case 'loop': case 'break': case 'exit': case 'erase': break;
    case 'common': if (!finite(p[0])) return null; v = {commonEventId: p[0]}; break;
    case 'label': case 'jump': if (!string(p[0])) return null; v = {name: p[0]}; break;
    case 'comment': if (!string(p[0])) return null; v = {text: p[0]}; break;
    case 'switches':
      if (!finite(p[0]) || !finite(p[1]) || !oneOf(p[2], [0, 1])) return null;
      v = {startId: p[0], endId: p[1], value: p[2]}; break;
    case 'variables':
      if (!finite(p[0]) || !finite(p[1]) || !oneOf(p[2], [0, 1, 2, 3, 4, 5]) || !oneOf(p[3], [0, 1]) || !finite(p[4])) return null;
      v = {startId: p[0], endId: p[1], operation: p[2], operandType: p[3], operand: p[4]}; break;
    case 'selfSwitch':
      if (!oneOf(p[0], ['A', 'B', 'C', 'D']) || !oneOf(p[1], [0, 1])) return null;
      v = {key: p[0], value: p[1]}; break;
    case 'gold': case 'item': case 'weapon': case 'armor': {
      const offset = type === 'gold' ? 0 : 1;
      if ((offset && !finite(p[0])) || !oneOf(p[offset], [0, 1]) || !oneOf(p[offset + 1], [0, 1]) || !finite(p[offset + 2])) return null;
      if (['weapon', 'armor'].includes(type) && !boolean(p[4])) return null;
      v = {operation: p[offset], operandType: p[offset + 1], operand: p[offset + 2]};
      if (offset) v[`${type}Id`] = p[0];
      if (type === 'weapon' || type === 'armor') v.includeEquipment = p[4];
      break;
    }
    case 'transfer':
      if (p[0] !== 0 || !p.slice(1, 4).every(finite) || p.length < 6 || !oneOf(p[4], [0, 2, 4, 6, 8]) || !oneOf(p[5], [0, 1, 2])) return null;
      v = {mapId: p[1], x: p[2], y: p[3], direction: p[4], fade: p[5]}; break;
    case 'moveRoute':
      if (!finite(p[0]) || !p[1] || !Array.isArray(p[1].list) || !['repeat', 'skippable', 'wait'].every(k => boolean(p[1][k])) || !p[1].list.every(step => step && Number.isInteger(step.code) && (step.parameters === undefined || Array.isArray(step.parameters)))) return null;
      v = {targetId: p[0], repeat: p[1].repeat, skippable: p[1].skippable, wait: p[1].wait}; break;
    case 'wait': if (!finite(p[0])) return null; v = {frames: p[0]}; break;
    case 'sound': case 'bgm':
      if (!p[0] || !string(p[0].name) || !['volume', 'pitch', 'pan'].every(k => finite(p[0][k]))) return null;
      v = {name: p[0].name, volume: p[0].volume, pitch: p[0].pitch, pan: p[0].pan}; break;
    case 'animation': case 'balloon':
      if (!finite(p[0]) || !finite(p[1]) || (p.length > 2 && !boolean(p[2]))) return null;
      v = {targetId: p[0], [type === 'animation' ? 'animationId' : 'balloonId']: p[1], wait: p[2] ?? false}; break;
  }
  return {...copy(defaults[type]), ...v};
}

function projection(block) {
  return {type: block.type, values: block.values, route: block.route,
    children: block.children?.map(projection), elseChildren: block.elseChildren?.map(projection),
    branches: block.branches?.map(branch => ({label: branch.label, commands: branch.commands?.map(projection)})),
    cancel: block.cancel?.map(projection), ...(block.type === 'raw' ? {raw: block.raw} : {})};
}

function remember(block, list, start, end, level) {
  block.raw = copy(list.slice(start, end)); block._level = level;
  block.originalValues = copy(block.values); block._original = JSON.stringify(projection(block));
  return block;
}

function findClose(list, index, end, code) {
  const indent = list[index].indent ?? 0;
  for (let i = index + 1; i < end; i++) {
    if ((list[i].indent ?? 0) < indent) return -1;
    if ((list[i].indent ?? 0) === indent && list[i].code === code) return i;
  }
  return -1;
}

function parseList(list, start, end, level) {
  const blocks = [];
  if (end > start && list[end - 1]?.code === 0 && (list[end - 1].indent ?? 0) === level) {
    blocks._terminator = copy(list[--end]);
  }
  for (let i = start; i < end;) {
    const command = list[i], type = codeTypes[command.code], values = decodeValues(command), indent = command.indent ?? 0;
    let next = i + 1, block;
    const endCode = {102: 404, 111: 412, 112: 413}[command.code];
    const close = endCode ? findClose(list, i, end, endCode) : -1;
    if (endCode && close >= 0) next = close + 1;
    if (!values || (endCode && close < 0)) {
      const continuation = {355: 655, 105: 405, 205: 505, 302: 605}[command.code];
      if (continuation) while (next < end && list[next].code === continuation && (list[next].indent ?? 0) === indent) next++;
      block = {type: 'raw', values: {}, readonly: true, reason: values ? '未闭合的流程命令' : '此命令或参数暂不支持可视化编辑'};
    } else {
      block = {type, values};
      if (type === 'text' || type === 'comment') {
        const continuation = type === 'text' ? 401 : 408;
        while (next < end && list[next].code === continuation && (list[next].indent ?? 0) === indent && string(list[next].parameters?.[0])) next++;
        values.text = (type === 'text' ? list.slice(i + 1, next) : list.slice(i, next)).map(c => c.parameters[0]).join('\n');
      } else if (type === 'conditional') {
        let split = -1;
        for (let j = i + 1; j < close; j++) if (list[j].code === 411 && (list[j].indent ?? 0) === indent) { if (split !== -1) { split = -2; break; } split = j; }
        if (split === -2) block = {type: 'raw', values: {}, readonly: true, reason: '条件分支结构无法安全编辑'};
        else {
          block.children = parseList(list, i + 1, split < 0 ? close : split, level + 1);
          if (split >= 0) { block.elseChildren = parseList(list, split + 1, close, level + 1); block._else = copy(list[split]); }
          block._end = copy(list[close]);
        }
      } else if (type === 'loop') {
        block.children = parseList(list, i + 1, close, level + 1); block._end = copy(list[close]);
      } else if (type === 'choices') {
        const markers = [];
        for (let j = i + 1; j < close; j++) if ([402, 403].includes(list[j].code) && (list[j].indent ?? 0) === indent) markers.push(j);
        let valid = markers.length > 0 && markers[0] === i + 1, choiceIndex = 0, seenCancel = false;
        block.branches = [];
        for (let j = 0; j < markers.length; j++) {
          const at = markers[j], marker = list[at], stop = markers[j + 1] ?? close;
          if (marker.code === 402) {
            valid &&= !seenCancel && marker.parameters?.[0] === choiceIndex && marker.parameters?.[1] === command.parameters[0][choiceIndex];
            block.branches.push({label: marker.parameters?.[1], commands: parseList(list, at + 1, stop, level + 1), _marker: copy(marker)}); choiceIndex++;
          } else {
            valid &&= !seenCancel; seenCancel = true; block.cancel = parseList(list, at + 1, stop, level + 1); block._cancel = copy(marker);
          }
        }
        valid &&= choiceIndex === command.parameters[0].length;
        if (!valid) block = {type: 'raw', values: {}, readonly: true, reason: '选项分支结构无法安全编辑'};
        else block._end = copy(list[close]);
      } else if (type === 'moveRoute') {
        block.route = copy(command.parameters[1].list);
        while (next < end && list[next].code === 505 && (list[next].indent ?? 0) === indent) next++;
      }
    }
    blocks.push(remember(block, list, i, next, level)); i = next;
  }
  return blocks;
}

export function decodeCommands(list) {
  if (!Array.isArray(list)) throw new TypeError('事件命令列表必须是数组');
  return parseList(copy(list), 0, list.length, 0);
}

function native(code, parameters, indent, original) {
  const command = original && original.code === code ? copy(original) : {code, indent, parameters: []};
  command.code = code; command.indent = indent;
  // Preserve engine/plugin extensions beyond the understood parameter prefix.
  command.parameters = Array.isArray(command.parameters) ? command.parameters : [];
  parameters.forEach((value, index) => { command.parameters[index] = copy(value); });
  return command;
}

function headerParameters(block) {
  const v = {...defaults[block.type], ...block.values}, original = block.raw?.[0]?.parameters;
  switch (block.type) {
    case 'text': {
      const p = [v.faceName, Number(v.faceIndex), Number(v.background), Number(v.positionType)];
      if (original?.length > 4 || v.speakerName) p.push(v.speakerName); return p;
    }
    case 'choices': return [(block.branches || []).map(b => b.label), Number(v.cancelType), Number(v.defaultType), Number(v.positionType), Number(v.background)];
    case 'conditional':
      switch (v.condition) {
        case 'switch': return [0, Number(v.switchId), Number(v.switchValue)];
        case 'variable': return [1, Number(v.variableId), Number(v.operandType), Number(v.operand), Number(v.comparison)];
        case 'selfSwitch': return [2, v.selfSwitch, Number(v.switchValue)];
        case 'gold': return [7, Number(v.gold), Number(v.goldComparison)];
        case 'item': return [8, Number(v.itemId)];
        default: throw new Error('不支持的条件类型');
      }
    case 'loop': case 'break': case 'exit': case 'erase': return [];
    case 'common': return [Number(v.commonEventId)];
    case 'label': case 'jump': return [v.name];
    case 'comment': return [String(v.text).split('\n')[0]];
    case 'switches': return [Number(v.startId), Number(v.endId), Number(v.value)];
    case 'variables': return [Number(v.startId), Number(v.endId), Number(v.operation), Number(v.operandType), Number(v.operand)];
    case 'selfSwitch': return [v.key, Number(v.value)];
    case 'gold': return [Number(v.operation), Number(v.operandType), Number(v.operand)];
    case 'item': return [Number(v.itemId), Number(v.operation), Number(v.operandType), Number(v.operand)];
    case 'weapon': case 'armor': return [Number(v[`${block.type}Id`]), Number(v.operation), Number(v.operandType), Number(v.operand), !!v.includeEquipment];
    case 'transfer': return [0, Number(v.mapId), Number(v.x), Number(v.y), Number(v.direction), Number(v.fade)];
    case 'moveRoute': {
      const route = copy(block.route || []);
      if (route.at(-1)?.code !== 0) route.push({code: 0, parameters: []});
      return [Number(v.targetId), {...copy(original?.[1] || {}), list: route, repeat: !!v.repeat, skippable: !!v.skippable, wait: !!v.wait}];
    }
    case 'wait': return [Number(v.frames)];
    case 'sound': case 'bgm': return [{...copy(original?.[0] || {}), name: v.name, volume: Number(v.volume), pitch: Number(v.pitch), pan: Number(v.pan)}];
    case 'animation': case 'balloon': {
      const p = [Number(v.targetId), Number(v[block.type === 'animation' ? 'animationId' : 'balloonId'])];
      if (!original || original.length > 2 || v.wait) p.push(!!v.wait); return p;
    }
    default: throw new Error(`不支持的可编辑命令：${block.type}`);
  }
}

function rebaseRaw(block, level) {
  const delta = level - (block._level ?? block.raw?.[0]?.indent ?? 0);
  return (block.raw || []).map(command => {
    const result = copy(command); if (delta) result.indent = (result.indent ?? 0) + delta; return result;
  });
}

function encodeBlock(block, level) {
  if (block.type === 'raw' || (block.raw && block._original === JSON.stringify(projection(block)))) return rebaseRaw(block, level);
  const code = typeCodes[block.type];
  if (!code) throw new Error(`不支持的可编辑命令：${block.type}`);
  const params = headerParameters(block);
  if (!decodeValues({code, parameters: params})) throw new Error(`命令参数无效：${block.type}`);
  const result = [native(code, params, level, block.raw?.[0])];
  if (block.type === 'text' || block.type === 'comment') {
    const isText = block.type === 'text', continuation = isText ? 401 : 408, lines = String(block.values.text ?? '').split('\n');
    const previous = (block.raw || []).filter(command => command.code === continuation);
    for (let i = isText ? 0 : 1; i < lines.length; i++) result.push(native(continuation, [lines[i]], level, previous[isText ? i : i - 1]));
  } else if (block.type === 'conditional' || block.type === 'loop') {
    result.push(...encodeList(block.children || [], level + 1, true));
    if (block.type === 'conditional' && Array.isArray(block.elseChildren)) {
      result.push(native(411, [], level, block._else), ...encodeList(block.elseChildren, level + 1, true));
    }
    result.push(native(block.type === 'loop' ? 413 : 412, [], level, block._end));
  } else if (block.type === 'choices') {
    for (let i = 0; i < (block.branches || []).length; i++) {
      const branch = block.branches[i];
      result.push(native(402, [i, branch.label], level, branch._marker), ...encodeList(branch.commands || [], level + 1, true));
    }
    if (Array.isArray(block.cancel)) result.push(native(403, [], level, block._cancel), ...encodeList(block.cancel, level + 1, true));
    result.push(native(404, [], level, block._end));
  } else if (block.type === 'moveRoute') {
    const old = (block.raw || []).filter(command => command.code === 505);
    for (let i = 0; i < params[1].list.length; i++) {
      const step = params[1].list[i]; if (step.code === 0) continue;
      result.push(native(505, [step], level, old[i]));
    }
  }
  return result;
}

function encodeList(blocks, level, appendTerminal) {
  const result = blocks.flatMap(block => encodeBlock(block, level));
  if (appendTerminal) result.push(blocks._terminator ? {...copy(blocks._terminator), indent: level} : terminal(level));
  return result;
}

export function encodeCommands(blocks) {
  if (!Array.isArray(blocks)) throw new TypeError('可编辑命令列表必须是数组');
  return encodeList(blocks, 0, true);
}

function nameFor(context, collection, id) {
  const source = context?.database?.[collection] ?? context?.content?.database?.[collection] ?? context?.[collection];
  const entry = source instanceof Map ? source.get(Number(id)) : source?.[id];
  return entry?.name ? `${id} · ${entry.name}` : String(id);
}

export function commandSummary(block, context = {}) {
  const v = block.values || {}, title = commandCatalog.find(item => item.type === block.type)?.label || '原生命令（只读）';
  const brief = value => String(value ?? '').replace(/\s+/g, ' ').slice(0, 100);
  let detail = '';
  switch (block.type) {
    case 'raw': return `原生命令 ${block.raw?.[0]?.code ?? '?'}（只读，${block.raw?.length || 0} 条）`;
    case 'text': case 'comment': detail = brief(v.text) || '（空）'; break;
    case 'choices': detail = (block.branches || []).map(b => brief(b.label)).join(' / '); break;
    case 'conditional': detail = ({switch: `开关 ${v.switchId} ${v.switchValue ? 'OFF' : 'ON'}`, variable: `变量 ${v.variableId} ${['=', '≥', '≤', '>', '<', '≠'][v.comparison]} ${v.operandType ? '变量 ' : ''}${v.operand}`, selfSwitch: `${v.selfSwitch} ${v.switchValue ? 'OFF' : 'ON'}`, item: `持有 ${nameFor(context, 'Items', v.itemId)}`, gold: `金钱 ${['≥', '≤', '<'][v.goldComparison]} ${v.gold}`})[v.condition]; break;
    case 'switches': detail = `${v.startId}–${v.endId} ${v.value ? 'OFF' : 'ON'}`; break;
    case 'variables': detail = `${v.startId}–${v.endId} ${variableOperations.find(([id]) => id === Number(v.operation))?.[1]} ${v.operandType ? '变量 ' : ''}${v.operand}`; break;
    case 'selfSwitch': detail = `${v.key} ${v.value ? 'OFF' : 'ON'}`; break;
    case 'gold': case 'item': case 'weapon': case 'armor': detail = `${v.operation ? '−' : '+'}${v.operandType ? '变量 ' : ''}${v.operand}${block.type === 'gold' ? '' : ` · ${nameFor(context, {item: 'Items', weapon: 'Weapons', armor: 'Armors'}[block.type], v[`${block.type}Id`])}`}`; break;
    case 'transfer': detail = `地图 ${v.mapId} (${v.x}, ${v.y})`; break;
    case 'moveRoute': detail = `目标 ${v.targetId} · ${(block.route || []).filter(step => step.code !== 0).length} 步`; break;
    case 'wait': detail = `${v.frames} 帧`; break;
    case 'common': detail = nameFor(context, 'CommonEvents', v.commonEventId); break;
    case 'label': case 'jump': case 'sound': case 'bgm': detail = brief(v.name); break;
    case 'animation': detail = `目标 ${v.targetId} · ${nameFor(context, 'Animations', v.animationId)}`; break;
    case 'balloon': detail = `目标 ${v.targetId} · ${v.balloonId}`; break;
  }
  return detail ? `${title}：${detail}` : title;
}
