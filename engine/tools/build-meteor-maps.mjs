import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {FLOOR} from '../client/autotile-tables.mjs';

// Explicit rebuild of the five authored meteor-adventure maps. Existing source
// tilesets are reused unchanged; no Sample layout, database, or public map edits.
const root = fileURLToPath(new URL('../../', import.meta.url));
const command = (code, ...parameters) => ({code, indent: 0, parameters});
const conditions = {actorId:1,actorValid:false,itemId:1,itemValid:false,selfSwitchCh:'A',selfSwitchValid:false,switch1Id:1,switch1Valid:false,switch2Id:1,switch2Valid:false,variableId:1,variableValid:false,variableValue:0};
const tile = (x, y, sheet = 0) => sheet * 256 + Math.floor(x / 8) * 128 + y * 8 + x % 8;
function page(image = {}, commands = [], {trigger = 0, priorityType = 1} = {}) {
  return {conditions:{...conditions},directionFix:true,image:{tileId:0,characterName:'',characterIndex:0,direction:2,pattern:1,...image},
    list:[...commands,command(0)],moveFrequency:3,moveRoute:{list:[{code:0,parameters:[]}],repeat:true,skippable:false,wait:false},
    moveSpeed:3,moveType:0,priorityType,stepAnime:false,through:false,trigger,walkAnime:true};
}
function make(id, name, width, height, {indoor = false, floor = 2816, wall = 6368} = {}) {
  const size = width * height, ground = Array(size).fill(indoor ? 0 : floor), data = Array(size * 6).fill(0), events = [null];
  const map = {autoplayBgm:false,autoplayBgs:false,battleback1Name:'',battleback2Name:'',bgm:{name:'',pan:0,pitch:100,volume:70},bgs:{name:'',pan:0,pitch:100,volume:70},
    disableDashing:false,displayName:name,encounterList:[],encounterStep:30,height,
    note:`<localAdventure>\nengine_adventure: meteor\nengine_environment: ${indoor ? 'indoor' : 'outdoor'}\nAuthored meteor adventure; see doc/2026-10-13-meteor-maps.md.`,
    parallaxLoopX:false,parallaxLoopY:false,parallaxName:'',parallaxShow:false,parallaxSx:0,parallaxSy:0,scrollType:0,specifyBattleback:false,
    tilesetId:indoor ? 40 : 39,width,data,events};
  const check = (x, y) => {if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) throw new Error(`Map ${id}: ${x},${y} outside map`);};
  const put = (x, y, z, value) => {check(x, y); data[z * size + y * width + x] = value;};
  const rect = (x, y, w, h, value = floor) => {for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {check(x + dx, y + dy); ground[(y + dy) * width + x + dx] = value;}};
  const object = (sx, sy, w, h, x, y, sheet = 0, z = 2) => {for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) put(x + dx, y + dy, z, tile(sx + dx, sy + dy, sheet));};
  const event = (name, x, y, image, commands = [], note = '', options = {}) => {
    check(x, y); const e = {id:events.length,name,note,x,y,pages:[page(image, commands, options)]}; events.push(e); return e;
  };
  const text = (...lines) => [command(101, '', 0, 0, 2), ...lines.map(line => command(401, line))];
  const service = (name, x, y, kind, image, lines) => event(name, x, y, image, text(...lines), `engine_service: ${kind}`);
  const portal = (name, x, y, mapId, tx, ty, direction = 2) => event(`前往${name}`, x, y, {}, [command(201, 0, mapId, tx, ty, direction, 0)], '', {trigger:1,priorityType:0});
  const sign = (name, x, y, ...lines) => event(name, x, y, {}, text(...lines), '', {priorityType:0});
  const npc = (name, x, y) => event(name, x, y, {characterName:'Fronterworks-SF-1',characterIndex:3}, [command(108,'engine_npc: scavenger')], 'engine_npc: scavenger');
  const structure = (name, x, y) => event(name, x, y, {characterName:'!Other1',characterIndex:1}, [command(108,'engine_structure: barricade')], 'engine_structure: barricade');
  const chest = (name, x, y, kind) => event(name, x, y, {characterName:'!Chest',characterIndex:0}, [command(108, `engine_container: ${kind}`)], `engine_container: ${kind}`);
  const tree = (x, y) => object(4, 0, 1, 2, x, y);
  const building = (x, y, w, h, roof = 5888, face = 6272) => {
    rect(x, y, w, h - 3, roof); rect(x, y + h - 3, w, 3, face);
    for (let dx = 1; dx < w - 2; dx += 3) object(9, 3, 2, 1, x + dx, y + h - 3);
  };
  const collapse = (x, y, w, h) => {
    rect(x,y,w,h,3344);
    for(let dy=0;dy<h;dy++)for(let dx=0;dx<w;dx++)for(const z of [1,2,3])put(x+dx,y+dy,z,0);
  };
  // Complete two-sided office desk from Modern JP Interiors Sample Map008,
  // (7..8,7..11): chairs, three desk rows, and equipment on the upper layer.
  const workstation = (x, y) => {
    put(x,y,2,83);
    for (const [dy, row] of [[1,[68,69]],[2,[76,77]],[3,[126,127]]]) for (let dx=0;dx<2;dx++) put(x+dx,y+dy,2,row[dx]);
    put(x,y+1,3,50);put(x+1,y+1,3,51);put(x,y+3,3,82);put(x,y+4,2,90);
  };
  function finish() {
    const base = ground.map(t => t || 5888);
    if (indoor) for (let y = 2; y < height; y++) for (let x = 1; x < width - 1; x++) if (ground[y * width + x] && !ground[(y - 1) * width + x]) {
      base[(y - 1) * width + x] = wall; if (!ground[(y - 2) * width + x]) base[(y - 2) * width + x] = wall;
    }
    const same = (x, y, t) => x < 0 || y < 0 || x >= width || y >= height ? indoor && t === 5888 : base[y * width + x] === t;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const t = base[y * width + x]; if (t < 2048) {put(x, y, 0, t); continue;}
      const l = same(x-1,y,t), r = same(x+1,y,t), u = same(x,y-1,t), d = same(x,y+1,t);
      const kind = Math.floor((t - 2048) / 48), wallTile = t >= 4352 && (t < 5888 || Math.floor((kind - 80) / 8) % 2 === 1);
      let shape;
      if (wallTile) shape = (!l?1:0)+(!u?2:0)+(!r?4:0)+(!d?8:0);
      else {
        const q = [!l?(!u?[0,2]:[0,4]):!u?[2,2]:!same(x-1,y-1,t)?[2,0]:[2,4],!r?(!u?[3,2]:[3,4]):!u?[1,2]:!same(x+1,y-1,t)?[3,0]:[1,4],!l?(!d?[0,5]:[0,3]):!d?[2,5]:!same(x-1,y+1,t)?[2,1]:[2,3],!r?(!d?[3,5]:[3,3]):!d?[1,5]:!same(x+1,y+1,t)?[3,1]:[1,3]];
        shape = FLOOR.findIndex(row => JSON.stringify(row) === JSON.stringify(q)); if (shape < 0) throw new Error(`Map ${id}: autotile ${t}`);
      }
      put(x, y, 0, t + shape);
      if (indoor && ground[y*width+x] && x > 0 && !ground[y*width+x-1]) put(x, y, 4, 5);
    }
    return map;
  }
  return {id,name,map,put,rect,object,event,service,portal,sign,npc,structure,chest,tree,building,collapse,workstation,finish};
}

const maps = [];
// 52: The evacuation checkpoint opens into a wide, broken suburban arterial.
// Short safe manoeuvring space introduces the warning before the first street.
{
  const m = make(52, '流星废城 · 郊区检查站', 34, 25); maps.push(m);
  m.rect(0,12,34,9,3728); m.rect(0,14,34,4,3968); m.rect(1,15,7,7,3344);
  m.building(3,2,10,9,5936,6320); m.building(23,3,9,8,5984,6368);
  // One destroyed house: exposed gravel foundation and two surviving wall ends.
  m.rect(15,4,6,7,3344); m.rect(15,4,2,2,6032); m.rect(15,6,2,2,6416); m.rect(20,6,1,4,6416);
  m.object(14,11,1,1,8,10); m.object(14,11,1,1,27,10);
  m.collapse(29,3,3,8);
  m.object(6,0,2,1,11,15); m.object(6,3,2,1,25,17);
  m.object(1,2,1,2,9,10); m.object(1,2,1,2,29,19);
  for (const [x,y] of [[0,2],[1,7],[14,0],[22,1],[32,6],[8,21],[14,22],[24,22],[31,22]]) m.tree(x,y);
  m.rect(18,12,4,3,3344); m.rect(17,13,3,2,3344); m.rect(27,19,4,2,3344);
  m.service('撤离信标',4,17,'meteorExit',{characterName:'!Crystal',characterIndex:1},['流星废城 · 撤离信标','取回市中心磁盘后，返回这里撤离。']);
  m.portal('商业废墟街区',32,15,53,3,15,6);
  m.sign('检查站任务板',6,19,'目标：穿过街区，进入市中心大楼取回磁盘。','带回磁盘后，在西侧金色信标撤离。','户外每五秒会有陨石锁定当前位置；红色预警后有一秒可以躲开。');
  m.structure('坍塌围墙',18,13); m.structure('断裂承重块',19,13); m.structure('路面碎墙',22,17);
  m.npc('郊区拾荒者',21,16); m.chest('检查站应急箱',6,21,'medical');
  for (const y of [12,13,14,16,17,18,19,20]) m.portal('商业废墟街区',32,y,53,3,15,6);
}
// 53: The commercial strip bends north to the civic district. The shelter is a
// clearly signed side destination; frontage ruins leave a broad southern bypass.
{
  const m = make(53, '流星废城 · 断街商业区', 38, 28, {floor:3728}); maps.push(m);
  m.rect(0,13,30,5,3968); m.rect(28,9,10,5,3968); m.rect(28,12,5,7,3968);
  m.building(2,2,11,9,5936,6320); m.object(2,8,4,2,5,9);
  m.building(15,2,10,7,5888,6272); m.object(14,11,1,1,17,8);
  m.building(28,1,8,7,5984,6368); m.object(10,4,2,1,31,3);
  m.building(5,21,13,7,5984,6368); m.object(0,10,3,1,9,27);
  m.collapse(5,21,3,7);
  m.rect(24,19,11,8,3344); m.rect(24,19,3,2,6032); m.rect(24,21,3,3,6416); m.rect(33,21,2,5,6416);
  m.rect(12,12,6,3,3344); m.rect(14,16,5,3,3344); m.rect(21,24,4,3,3344);
  m.object(6,1,2,1,21,15); m.object(6,3,2,1,29,10);
  m.object(6,4,1,2,12,9); m.object(1,2,1,2,25,9); m.object(1,2,1,2,3,18);
  for (const [x,y] of [[0,0],[13,1],[36,2],[1,24],[19,24],[36,24]]) m.tree(x,y);
  m.portal('郊区检查站',1,15,52,31,15,4);
  m.portal('市中心广场',36,10,54,3,19,6);
  m.portal('临时避难所',17,9,55,11,17,8);
  m.sign('避难所门牌',18,10,'临时避难所 · 有完整屋顶，可躲避陨石。','市中心大楼：沿街东行，在前方转向北侧。');
  m.structure('倒塌店墙',14,14); m.structure('倒塌店墙',15,14); m.structure('道路混凝土块',16,14);
  m.structure('楼体残块',29,22); m.structure('楼体残块',30,22);
  m.npc('商街拾荒者',9,16); m.npc('路口拾荒者',30,16); m.chest('商街遗留箱',25,25,'supplies');
  for (const y of [12,13,14,16,17,18,19]) m.portal('郊区检查站',1,y,52,31,15,4);
  for (const y of [8,9,11,12,13,14,15]) m.portal('市中心广场',36,y,54,3,19,6);
}
// 54: A broad, exposed civic forecourt announces the destination. Low plinths
// divide the plaza without imposing a single-tile choke or mandatory destruction.
{
  const m = make(54, '流星废城 · 中心广场', 34, 30, {floor:3728}); maps.push(m);
  m.rect(0,17,11,5,3968); m.rect(8,10,19,17,3632); m.rect(14,9,7,18,3680);
  m.building(8,1,20,8,5888,6272); m.object(14,11,1,1,17,8);
  m.object(10,4,2,1,11,3); m.object(10,4,2,1,23,3);
  m.collapse(25,1,3,8);
  // Destroyed memorial and broken paving leave all four approach sides usable.
  m.rect(11,15,3,3,3344); m.rect(22,20,3,3,3344); m.rect(22,15,2,2,6032); m.rect(22,17,2,1,6416);
  m.rect(27,22,5,6,3344); m.rect(29,23,3,2,6416);
  m.object(4,2,2,1,9,23); m.object(4,2,2,1,23,12);
  for (const [x,y] of [[5,11],[28,11],[5,24],[28,18]]) m.object(1,2,1,2,x,y);
  for (const [x,y] of [[1,2],[4,4],[30,2],[32,6],[1,26],[6,27],[16,28],[23,27]]) m.tree(x,y);
  m.portal('商业废墟街区',1,19,53,35,10,4);
  m.portal('市中心大楼',17,9,56,14,20,8);
  m.sign('中心大楼导向',18,11,'市中心数据保管室位于前方大楼。','回收磁盘后，原路返回郊区检查站。');
  m.structure('纪念台碎块',12,16); m.structure('纪念台碎块',13,16); m.structure('广场破损围栏',23,21);
  m.npc('广场拾荒者',16,20); m.npc('大楼外拾荒者',25,10); m.chest('广场急救箱',7,26,'medical');
  for (const y of [16,17,18,20,21,22]) m.portal('商业废墟街区',1,y,53,35,10,4);
}
// 55: A requisitioned corner shop. Resting benches face a compact supply counter;
// the broad central aisle lets the player wait out hazards and plan the return.
{
  const m = make(55, '流星废城 · 临时避难所', 24, 22, {indoor:true,floor:3584,wall:6368}); maps.push(m);
  m.rect(2,5,20,14); m.rect(10,17,3,3,3680); m.rect(3,6,8,6,2864);
  m.object(8,10,7,2,3,3,1); m.object(8,4,5,3,3,8,1);
  m.object(10,14,2,2,16,5,1); m.object(14,0,2,3,19,5);
  m.object(8,5,2,1,15,12,2); m.object(8,5,2,1,19,12,2);
  m.object(1,14,2,2,16,15); m.object(15,5,1,1,15,15); m.object(15,5,1,1,18,15);
  m.object(1,8,1,2,3,16);
  m.portal('商业废墟街区',11,19,53,17,10,2);
  m.sign('避难所须知',12,17,'这里仍有完整屋顶，可以暂避陨石。','计时仍在继续。取到磁盘后，记得返回郊区信标。');
  m.chest('避难所急救箱',18,7,'medical');
}
// 56: A reception lobby connects around a collapsed central partition into the
// east archive. The terminal is the visual destination; office furniture is whole.
{
  const m = make(56, '流星废城 · 中心数据室', 30, 24, {indoor:true,floor:3584,wall:6368}); maps.push(m);
  m.rect(3,13,24,8); m.rect(4,5,9,11); m.rect(17,5,10,11); m.rect(10,9,10,4); m.rect(13,19,3,4,3680);
  m.rect(17,5,10,7,2864); m.rect(13,13,4,7,3632);
  m.object(10,14,2,2,7,14,1); m.object(8,5,2,1,20,17,2); m.object(8,5,2,1,23,17,2);
  m.object(11,0,3,2,18,3); m.object(11,0,3,2,24,3);
  m.workstation(6,6); m.object(14,0,2,3,10,4);
  m.workstation(23,8);
  m.object(1,8,1,2,4,18); m.object(1,8,1,2,25,19);
  m.service('磁盘保管箱',22,6,'meteorDisk',{characterName:'!Chest',characterIndex:3},['数据保管箱','回收磁盘后，返回郊区检查站的撤离信标。']);
  m.portal('市中心广场',14,22,54,17,10,2);
  m.sign('保管室指示牌',15,18,'档案保管室在右上方。','回收完毕后，从南门离开，原路返回检查站。');
  m.structure('坍塌隔墙',13,12); m.structure('坍塌隔墙',14,12); m.structure('坍塌隔墙',15,12);
  m.npc('资料室拾荒者',19,11); m.npc('门厅拾荒者',9,18);
}

async function write(file, value) {
  let text;
  if (Array.isArray(value)) text = '[\n' + value.map(row => JSON.stringify(row)).join(',\n') + '\n]\n';
  else {const {data, events, ...head} = value; text = '{\n' + JSON.stringify(head).slice(1,-1) + ',\n"data":' + JSON.stringify(data) + ',\n"events":[\n' + events.map(row => JSON.stringify(row)).join(',\n') + '\n]\n}\n';}
  await fs.writeFile(path.join(root, file), text);
}
const infos = JSON.parse(await fs.readFile(path.join(root, 'data/MapInfos.json'), 'utf8'));
for (const m of maps) {
  const filename = `data/Map${String(m.id).padStart(3,'0')}.json`;
  try {const old = JSON.parse(await fs.readFile(path.join(root, filename), 'utf8')); if (!/engine_adventure: meteor/.test(old.note)) throw new Error(`${filename} is already occupied`);}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
  await write(filename, m.finish());
  infos[m.id] = {id:m.id,expanded:m.id === 52,name:m.name,order:m.id,parentId:m.id === 52 ? 2 : 52,scrollX:0,scrollY:0};
}
await write('data/MapInfos.json', infos);
console.log(JSON.stringify(maps.map(m => ({mapId:m.id,name:m.name,width:m.map.width,height:m.map.height,events:m.map.events.length-1}))));
