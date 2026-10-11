import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {FLOOR} from '../client/autotile-tables.mjs';

// Authored demonstration layouts. This generator never copies Sample layouts,
// changes existing tilesets, changes the start map, or adds a public-city entrance.
const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const read = async file => JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
async function write(file, value) {
  let text;
  if (Array.isArray(value)) text = '[\n' + value.map(row => JSON.stringify(row)).join(',\n') + '\n]\n';
  else if (value.data && value.events) {
    const {data, events, ...header} = value;
    text = '{\n' + JSON.stringify(header).slice(1, -1) + ',\n"data":' + JSON.stringify(data) + ',\n"events":[\n' + events.map(row => JSON.stringify(row)).join(',\n') + '\n]\n}\n';
  } else text = JSON.stringify(value, null, 2) + '\n';
  await fs.writeFile(path.join(root, file), text);
}
const tilesets = await read('data/Tilesets.json');
const outside = structuredClone(tilesets[2]);
outside.id = 41;
outside.name = '3D Demo / Outside 0.9.2.8';
outside.note = `<mv3d>
// Cliff and slope syntax checked against MV3D 0.9.2.8 Sample Tileset 2.
A2,0,0:side(A4,0,5)
A5,0-3,3:slope(1,n),side(A4,0,5)
// Animated pond, from the same Sample; alpha is local to the water top.
A1,0,0:top(A1,.5,1.5|animx:2,alpha:0.75),side(A1,1,1|animy:1),inside(A1,31px,54px,31px,14px|animx:2),depth(0.3),float(0.1)
// Complete flower tiles and thin connected wooden fence.
B,0-3,12:shape(cross),height(0.6),fringe(0),pass(*)
A2,6,0:shape(fence),height(1),pass(x)
</mv3d>`;
const inside = structuredClone(tilesets[3]);
inside.id = 42;
inside.name = '3D Demo / Inside 0.9.2.8';
inside.note = `<mz3d>
// Cutaway walls: wall top is transparent, sides retain the original wall.
A4,3,2:height(3),top(B,0,0),side(A4,3,3),pass(x)
// Full two by two tables, using Sample Map002 cropped top and side syntax.
B,3-4,12:top(+0,+6px,1,26px),side(+0,+32px,1,16px),height(0.33),pass(x)
B,3-4,13:top(+0,+0,1,16px),side(+0,+16px,1,16px),height(0.33),pass(x)
// Shelves are complete two tile illustrations, anchored on their lower row.
B,2-5,6:alpha(0),height(0),pass(*)
B,2-5,7:texture(+0,-1,1,2),shape(board),height(2),pass(x)
</mz3d>`;
for (let t = 6800; t < 6848; t++) inside.flags[t] = (inside.flags[t] || 0) | 15;
for (const ts of [outside, inside]) {
  if (tilesets[ts.id] && tilesets[ts.id].name !== ts.name) throw new Error(`Tileset ${ts.id} is occupied`);
  for (const name of ts.tilesetNames.filter(Boolean)) await fs.access(path.join(root, 'img/tilesets', name + '.png'));
  tilesets[ts.id] = ts;
}

const condition = {actorId:1,actorValid:false,itemId:1,itemValid:false,selfSwitchCh:'A',selfSwitchValid:false,switch1Id:1,switch1Valid:false,switch2Id:1,switch2Valid:false,variableId:1,variableValid:false,variableValue:0};
const command = (code, ...parameters) => ({code, indent:0, parameters});
const message = (...lines) => [command(101, '', 0, 0, 2), ...lines.map(line => command(401, line))];
function page(image = {}, list = [], options = {}) {
  return {conditions:{...condition},directionFix:true,image:{tileId:0,characterName:'',characterIndex:0,direction:2,pattern:1,...image},list:[...list,command(0)],moveFrequency:3,moveRoute:{list:[{code:0,parameters:[]}],repeat:true,skippable:false,wait:false},moveSpeed:3,moveType:0,priorityType:1,stepAnime:false,through:false,trigger:0,walkAnime:false,...options};
}
function make(id, name, width, height, tilesetId, note) {
  const size = width * height;
  const data = Array(size * 6).fill(0), events = [null];
  const map = {autoplayBgm:false,autoplayBgs:false,battleback1Name:'',battleback2Name:'',bgm:{name:'',pan:0,pitch:100,volume:70},bgs:{name:'',pan:0,pitch:100,volume:70},disableDashing:false,displayName:name,encounterList:[],encounterStep:30,height,note,parallaxLoopX:false,parallaxLoopY:false,parallaxName:'',parallaxShow:false,parallaxSx:0,parallaxSy:0,scrollType:0,specifyBattleback:false,tilesetId,width,data,events};
  const put = (x,y,z,t) => {if(x<0||y<0||x>=width||y>=height)throw new Error(`Map ${id}: ${x},${y}`); data[(z*height+y)*width+x]=t;};
  const rect = (x,y,w,h,t,z=0) => {for(let dy=0;dy<h;dy++)for(let dx=0;dx<w;dx++)put(x+dx,y+dy,z,t);};
  const object = (sx,sy,w,h,x,y,z=2) => {for(let dy=0;dy<h;dy++)for(let dx=0;dx<w;dx++)put(x+dx,y+dy,z,(sy+dy)*8+sx+dx);};
  const event = (name,x,y,image,list=[],note='',options={}) => {const e={id:events.length,name,note,x,y,pages:[page(image,list,options)]};events.push(e);return e;};
  const guide = (name,x,y,lines) => event(name,x,y,{characterName:'People1',characterIndex:0},message(...lines));
  const exit = (name,x,y,mapId,tx,ty,direction=2) => event(name,x,y,{characterName:'!Crystal',characterIndex:mapId===40?1:3},[...(id===50?[command(356,'mv3d @player flashlight black 0 5 60')]:[]),command(201,0,mapId,tx,ty,direction,0)],'<mv3d:shape(sprite),glow(white,0.15)>',{stepAnime:true});
  function finish() {
    // Resolve all painted autotiles. Elevation boundaries are part of the grass
    // adjacency key, so their cliff lips remain visible in the MV/MZ editor.
    for(let z=0;z<4;z++){
      const raw=data.slice(z*size,(z+1)*size);
      const same=(x,y,t,region)=>x>=0&&y>=0&&x<width&&y<height&&raw[y*width+x]===t&&(t!==2816||data[5*size+y*width+x]===region);
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const t=raw[y*width+x];if(t<2048)continue;
        const region=data[5*size+y*width+x],s=(dx,dy)=>same(x+dx,y+dy,t,region),l=s(-1,0),r=s(1,0),u=s(0,-1),d=s(0,1);
        const wall=t>=4352&&t<5888||t>=5888&&Math.floor((t-5888)/384)%2===1;
        let shape;
        if(wall)shape=(!l?1:0)+(!u?2:0)+(!r?4:0)+(!d?8:0);
        else {
          const q=[!l?(!u?[0,2]:[0,4]):!u?[2,2]:!s(-1,-1)?[2,0]:[2,4],!r?(!u?[3,2]:[3,4]):!u?[1,2]:!s(1,-1)?[3,0]:[1,4],!l?(!d?[0,5]:[0,3]):!d?[2,5]:!s(-1,1)?[2,1]:[2,3],!r?(!d?[3,5]:[3,3]):!d?[1,5]:!s(1,1)?[3,1]:[1,3]];
          shape=FLOOR.findIndex(row=>JSON.stringify(row)===JSON.stringify(q));
          if(shape<0)throw new Error(`Autotile ${id} ${x},${y}`);
        }
        put(x,y,z,t+shape);
      }
    }
    return map;
  }
  return {id,name,map,put,rect,object,event,guide,exit,finish};
}
const maps=[];
{
  const m=make(49,'3D 示例 · 风阶观景台',26,22,41,`<mv3d>
enable(true)
camera(0,60,dist:9,height:0.75)
ambient(#c3d2dc)
fog(#c6f0f2|20,45)
sun(white|45,45)
base(0.25)
edge(false)
</mv3d>
<mv3d-regions>
60:height(1)
61:height(2)
62:height(0),slope(1,n)
63:height(1),slope(1,n)
</mv3d-regions>`);
  maps.push(m);
  m.rect(0,0,26,22,2816);
  m.rect(4,7,18,7,60,5);m.rect(13,3,9,4,61,5);
  m.rect(4,6,8,1,60,5);m.rect(14,2,8,1,61,5);
  m.rect(8,13,3,1,1561);m.rect(8,13,3,1,62,5);
  m.rect(17,7,3,1,1561);m.rect(17,7,3,1,63,5);
  m.rect(8,14,3,6,1586);m.rect(4,18,7,2,1586);m.rect(8,9,11,2,1586);m.rect(8,11,3,2,1586);
  m.rect(17,4,3,3,1586);m.rect(17,8,3,2,1586);
  m.rect(17,15,7,4,2048);
  for(const [x,y,t] of [[3,16,96],[4,16,97],[13,16,98],[14,16,99],[5,8,96],[6,8,97],[14,4,98],[15,4,99]])m.put(x,y,2,t);
  m.rect(4,6,8,1,3104,1);m.rect(14,2,8,1,3104,1);
  m.guide('观景台导览',6,17,['风阶观景台：沿石路到草坡，再到北侧高台。','两段坡各升高 1 格；草地侧面使用岩壁贴图。','蓝水晶连接 3D 展区，绿水晶回到 2D 城市。']);
  m.guide('高台观测员',20,4,['这里是第二层平台。可比较坡面、侧壁和人物脚底高度。','这些配置都保存在地图备注、区域和独立图块集备注中。']);
  m.exit('前往灯光阅览室',21,10,50,4,13,8);
  m.exit('前往水镜材质园',23,20,51,4,13,8);
  m.exit('返回榆风市（2D）',3,19,40,20,24,2);
}
{
  const m=make(50,'3D 示例 · 灯光阅览室',22,18,42,`<mz3d>
enable(true)
camera(0,65,dist:8,height:0.75)
edge(false)
ambient(#30384d)
sun(black)
fog(#172134|18,35)
ceiling(A4,3,2|3,backface:false)
</mz3d>
<mz3d-regions>
70:ceiling(A4,3,2|2.5,backface:false)
</mz3d-regions>`);
  maps.push(m);
  m.rect(0,0,22,18,6800);m.rect(2,3,18,13,1555);
  m.rect(10,3,1,4,6800);
  m.rect(3,11,16,3,3680);m.rect(12,4,6,6,70,5);
  m.object(2,6,4,2,3,3);m.object(2,6,4,2,13,3);
  m.object(3,12,2,2,5,7);m.object(3,12,2,2,14,7);
  // A wall-backed whole chair image is cropped from the same Sample artwork.
  m.event('阅览椅（西）',5,6,{tileId:184},[], '<mz3d:shape(board),texture(+0,-1,1,2),scale(1),shadow(0.4)>');
  m.event('阅览椅（东）',14,6,{tileId:184},[], '<mz3d:shape(board),texture(+0,-1,1,2),scale(1),shadow(0.4)>');
  m.event('暖色阅读灯',6,9,{characterName:'!Flame',characterIndex:3,direction:4},[], '<mz3d:lamp(#ffcc88,1.5,6|shadow:true),glow(#ffcc88,1),z(1.8),scale(.45)>',{stepAnime:true,through:true,priorityType:0});
  m.event('冷色阅读灯',16,9,{characterName:'!Flame',characterIndex:3,direction:4},[], '<mz3d:lamp(#7cb8ff,1.5,6|shadow:true),glow(#7cb8ff,1),z(1.8),scale(.45)>',{stepAnime:true,through:true,priorityType:0});
  m.guide('室内导览',8,13,['灯光阅览室：西侧暖光，东侧冷光，中间保留暗部。','房间有 3 格高天花板，东侧阅读区为 2.5 格。','天花板从上方不遮挡俯视相机；降低相机可观察底面。']);
  m.event('开启手电筒',12,13,{characterName:'People1',characterIndex:1},[...message('已开启手电筒。转动角色可观察锥形照明。','东边的同事可以关闭它；离开本地图时自动关闭。'),command(356,'mv3d @player flashlight white 1.5 6 60')]);
  m.exit('返回风阶观景台',3,14,49,20,10,4);
  m.exit('前往水镜材质园',18,14,51,4,13,8);
  m.exit('返回榆风市（2D）',3,15,40,20,24,2);
  m.event('关闭手电筒',14,13,{characterName:'People1',characterIndex:2},[...message('手电筒已关闭。'),command(356,'mv3d @player flashlight black 0 6 60')]);
}
{
  const m=make(51,'3D 示例 · 水镜材质园',26,18,41,`<mv3d>
enable(true)
camera(0,62,dist:9,height:0.75)
ambient(#bec5d9)
sun(white|35,65)
fog(#bcd9e7|22,42)
base(0.25)
edge(false)
</mv3d>
<mv3d-tiles>
// Transparent ice panel; copied texture stays on its own display tile.
A5,3,6:height(1.5),alpha(0.45),side(A5,3,6),pass(x)
// Short solid plinth and emissive flower specimen.
A5,1,6:height(0.5),side(A4,1,5),pass(x)
B,3,12:shape(cross),height(0.8),glow(#dd6699,0.6),pass(*)
</mv3d-tiles>`);
  maps.push(m);
  m.rect(0,0,26,18,2816);m.rect(2,11,22,4,1586);m.rect(11,3,3,11,1586);
  m.rect(3,4,5,5,2048);m.rect(17,4,6,5,2048);
  m.rect(3,3,5,1,3104,1);m.rect(17,3,6,1,3104,1);
  m.rect(11,3,3,2,1585);m.put(12,4,1,1587);
  for(const [x,y,t]of [[3,10,96],[7,10,97],[18,10,98],[22,10,99],[3,16,96],[4,16,97],[21,16,98],[22,16,99]])m.put(x,y,2,t);
  const shapes=[['sprite',4],['board',8],['cross',17],['xcross',21]];
  for(const [shape,x]of shapes)m.event(`植物形状 · ${shape}`,x,12,{tileId:96},message(`同一花丛贴图：shape(${shape})。`,`绕行或旋转相机，比较朝向与相交面。`),`<mv3d:shape(${shape}),scale(1.4),shadow(.5),collide(.3)>`);
  m.guide('材质园导览',12,10,['水镜材质园：两侧是三帧动画水面与下沉池壁。','北侧展台是半透明冰板；花丛比较四种立面形状。','粉花使用 glow，北侧木栏使用相连的 fence 图块。']);
  m.exit('返回风阶观景台',3,14,49,22,20,4);
  m.exit('前往灯光阅览室',22,14,50,17,14,4);
  m.exit('返回榆风市（2D）',12,16,40,20,24,2);
}

const infos=await read('data/MapInfos.json');
for(const m of maps){
  if(infos[m.id]&&!infos[m.id].name.startsWith('3D 示例'))throw new Error(`Map ${m.id} is occupied`);
  await write(`data/Map${String(m.id).padStart(3,'0')}.json`,m.finish());
  infos[m.id]={id:m.id,expanded:false,name:m.name,order:m.id,parentId:6,scrollX:0,scrollY:0};
}
await write('data/MapInfos.json',infos);
await write('data/Tilesets.json',tilesets);
await write('doc/3d-demo-sources.json',{
  schema:1,authoredDate:'2026-10-11',generator:'engine/tools/build-3d-maps.mjs',pluginVersion:'0.9.2.8',
  scope:'Three original layouts; existing Map006, maps 001–048, tilesets 001–040 and System start location are preserved.',
  entry:'Development map selector; no new entrance on the ordinary 2D city.',return2d:{mapId:40,x:20,y:24,direction:2},
  sources:[
    {path:'D:/Resources/mv3d-project 0.9.2.8',packId:null,role:'Configuration reference only; not copied as game assets',credit:'Cutievirus',creditSource:'js/plugins/mv3d.js header (@author Cutievirus)',maps:[2,8,12,15,18,21,23],data:['data/Tilesets.json #2/#3','data/Map002.json','data/Map008.json','data/Map012.json','data/Map015.json','data/Map018.json','data/Map021.json','data/Map023.json'],indexStatus:'Newly added sample directory is not in the earlier seven-category resource index.'},
    {path:'D:/Resources/mz3d-project 0.9.2.8',packId:null,role:'Cross-check MZ tags, ceiling, light and region syntax',credit:'Cutievirus',creditSource:'js/plugins/mz3d.js header',maps:[3,7,8,11,15]},
    {path:'img/tilesets',packId:null,role:'Existing project RTP images reused without modification or copying',files:[...new Set([...outside.tilesetNames,...inside.tilesetNames].filter(Boolean))].map(n=>n+'.png'),creditStatus:'Retains the existing project asset provenance; no source package or new credit obligation inferred from filenames.'},
    {path:'img/characters',packId:null,role:'Existing project event images',files:['People1.png','!Flame.png','!Crystal.png']}
  ],
  sampleObservations:[
    {source:'MV Map015 and Outside_A5.png',combination:'Grass cliff and 1-tile north-facing stairs',tiles:['A2,0,0 (2816+shape)','A5,1,3 (1561)','A4,0,5 side texture'],evidence:'engine/.artifacts/3d-demos/sample-2d/Map015-full.png',reuse:'Tile grammar only; new two-level outdoor route'},
    {source:'MV Map002 and Inside_B.png',combination:'Wood room, whole bookcases and 2x2 tables',tiles:['A4,3,2 (6800+shape)','A5,3,2 (1555)','B,2-5,6-7','B,3-4,12-13'],evidence:'engine/.artifacts/3d-demos/sample-2d/Map002-full.png',reuse:'Complete object footprints and cropped textures; new two-room reading plan'},
    {source:'MV Map018 and Outside_B.png',combination:'Connected wooden fence with posts and whole flower tiles',tiles:['A2,6,0 (3104+shape)','B,0-3,12 (96–99)'],evidence:'engine/.artifacts/3d-demos/sample-2d/Map018-full.png',reuse:'Fence grammar and four identical-image shape specimens'}
  ],
  maps:[
    {id:49,tilesetId:41,size:[26,22],entry:{x:9,y:18,direction:8},purpose:'Outdoor elevation, side textures, north-facing slopes and character grounding',design:'Lower arrival plaza leads up a broad stair to a middle traverse, then a separate stair to the northern lookout. Pond and side garden are viewed from the terrace.',requiredPoints:[[9,18],[9,13],[18,7],[20,5],[20,10],[22,20],[3,18]],regions:{60:'height(1)',61:'height(2)',62:'height(0),slope(1,n)',63:'height(1),slope(1,n)'}},
    {id:50,tilesetId:42,size:[22,18],entry:{x:4,y:13,direction:8},purpose:'Indoor walls, two ceiling heights, local colored lights, player flashlight and MZ note alias',design:'West and east reading rooms share a low southern cross-gallery. Central openings reveal warm and cool reading tables while the dividing wall preserves contrasting pools of light.',requiredPoints:[[4,13],[5,9],[15,9],[12,12],[17,14]],regions:{70:'ceiling(A4,3,2|2.5,backface:false)'},pluginCommands:['mv3d @player flashlight white 1.5 6 60','mv3d @player flashlight black 0 6 60']},
    {id:51,tilesetId:41,size:[26,18],entry:{x:4,y:13,direction:8},purpose:'Animated water, depth, local texture alpha, glow, fence and four event shapes',design:'A central stone viewing spine separates two ponds; the north plinth frames transparent ice, while the southern garden walk compares four flower projections.',requiredPoints:[[4,13],[12,9],[12,5],[21,13],[12,15]],eventShapes:['sprite','board','cross','xcross']}
  ],
  verification:{
    sampleStatic:'Rendered MV Sample Maps 002/015/018 with existing client Tilemap renderer; inspected the full images and RTP sheets. This verifies composition only.',
    newMapStatic:'Inspected all three full-map images in engine/.artifacts/3d-demos/authored-2d after rendering temporary map copies with enable(false); original maps remain enable(true). Checked whole table/bookcase footprints, corridor openings, water boundaries and event placement. Preview renderer reported zero missing assets, errors and failed requests.',
    data:'Six-plane lengths, event IDs/coordinates and all nine transfer destinations checked. Original MapInfos 001–048 and Tilesets 001–040 are JSON-equal to HEAD. Existing unrelated project missing characters: 4scientist, DF_Actor.',
    runtime3d:{
      renderer:'Bundled original MV3D 0.9.2.8 in the replacement client WebGL host',
      screenshots:['engine/.artifacts/3d-demos/Map49-reviewed-3d.png','engine/.artifacts/3d-demos/Map50-reviewed-3d.png','engine/.artifacts/3d-demos/Map50-ceiling-underside.png','engine/.artifacts/3d-demos/Map51-reviewed-3d.png'],
      reviewed:'Actually opened all four 816x624 captures. Slopes now meet both platforms, fence posts stand above terrain, indoor gallery remains visible without a foreground dividing wall, warm/cool lights illuminate separate bays, and water/fences/transparent ice are visible. First-person camera at (7,10), height 1.3, pitch105, distance0 confirms that the ceiling underside is visible from inside while its top does not obscure the normal overhead view.',
      corrections:['MV3D adds slopeHeight to height: region62 changed from height(1) to height(0), region63 from height(2) to height(1).','Removed the southern central indoor wall that obscured the shared gallery.','Raised ground beneath the terrace fences to prevent buried fence posts.','Separate flashlight on/off events avoid persisted self-switch state conflicting with a recreated render host.'],
      slopeSampling:'Original mv3d.getWalkHeight: south slope (x9, y14→12) = 0,.01,.25,.5,.75,.99,1; north slope (x18, y8→6) = 1,1.01,1.25,1.5,1.75,1.99,2. All 14 samples passed tolerance 0.001.',
      interactionReachability:'Replacement World.canMove BFS with real event collisions reaches an adjacent interaction cell for all 19 guide, display, light-control and exit events across the three maps.',
      report:'engine/.artifacts/3d-demos/layout-verification.json',
      remaining:'Native MV3D player collision/physics is not supplied by these map checks. Root integration verification covers avatar, camera rotation, plugin commands and return to 2D; complete animated-water frame parity is not asserted by the still captures.'
    }
  }
});
console.log('Built Map049–051 with dedicated Tilesets 41–42. No game assets copied.');
