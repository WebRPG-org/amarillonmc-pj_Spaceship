import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {FLOOR} from '../client/autotile-tables.mjs';

// Hand-authored layouts. Sample projects supply tile flags only, never map layouts.
// Running this explicitly rebuilds Map031–039 and the named Road connector.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const resources=process.argv[2]||'D:/Resources/RM_Resources/RMTiles';
const sources=[
 ['Subway','RJ01027714','mapchip_subway/tilesets','mapchip_subway_samplegame/www/data',5,31],
 ['Underground_Passageway','RJ01130991','Underground_Passageway_Materials/tilesets','Underground_Passageway_Sample/www/data',31,32],
 ['GameCenter','RJ01120128','Tileset_GameCenter_Materials/tilesets','Tileset_GameCenter_game_sample/www/data',21,33],
 ['NightClub','RJ01030634','material/tilesets','NightClub_GameSample/www/data',6,34],
 ['Hotel','RJ01182082','Tileset_Hotel_Assets/tilesets','Tileset_Hotel_SampleGame/www/data',35,35],
 ['gakuseiryou','RJ01045102','Tileset_gakuseiryou_materials/tilesets','Tileset_gakuseiryou_game_sample/www/data',15,36],
 ['Pool','RJ01048967','Tileset_poolgym_materials/tilesets','Tileset_poolgym_game_sample/www/data',16,37],
 ['Cinema','RJ01331088','Tileset_Cinema_Assets/tilesets','Tileset_Cinema_SampleGame/www/data',42,38]
];
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const write=async(p,v)=>{let text;if(Array.isArray(v))text='[\n'+v.map(x=>JSON.stringify(x)).join(',\n')+'\n]\n';else if(v.data&&v.events){const {data,events,...header}=v;text='{\n'+JSON.stringify(header).slice(1,-1)+',\n\"data\":'+JSON.stringify(data)+',\n\"events\":[\n'+events.map(x=>JSON.stringify(x)).join(',\n')+'\n]\n}\n';}else text=JSON.stringify(v,null,2)+'\n';return fs.writeFile(p,text);};
const tilesets=await read(path.join(root,'data/Tilesets.json')),provenance=[];
for(const [key,pack,assets,sample,sampleId,id] of sources){
 const src=(await read(path.join(resources,pack,sample,'Tilesets.json')))[sampleId];
 const ts=structuredClone(src); ts.id=id;ts.name=`BR Modern / ${key}`;
 ts.note=`Sample flags: ${pack}/${sample}/Tilesets.json #${sampleId}. Cutaway roof blocked; Pool basin blocked. See modern-map-sources.json.`;
 // Sample roofs are walkable tops. These maps use cutaway ceilings as solid boundaries.
 const overrides=[{start:5888,end:5935,reason:'Cutaway ceiling is a solid map boundary'}];
 if(key==='Pool')overrides.push({start:2960,end:3007,reason:'Deep pool: no swimming mechanic in this scenario'});
 for(const o of overrides)for(let t=o.start;t<=o.end;t++)ts.flags[t]=(ts.flags[t]||0)|15;
 const assetsCopied=[];
 for(let slot=0;slot<9;slot++){const name=src.tilesetNames[slot];if(!name)continue;const target=`BR_${name}`;await fs.copyFile(path.join(resources,pack,assets,name+'.png'),path.join(root,'img/tilesets',target+'.png'));ts.tilesetNames[slot]=target;assetsCopied.push({slot,source:`${pack}/${assets}/${name}.png`,target:`img/tilesets/${target}.png`});}
 tilesets[id]=ts;provenance.push({tilesetId:id,key,pack,sample:`${pack}/${sample}/Tilesets.json`,sampleTilesetId:sampleId,collisionOverrides:overrides,assets:assetsCopied});
}
const condition={actorId:1,actorValid:false,itemId:1,itemValid:false,selfSwitchCh:'A',selfSwitchValid:false,switch1Id:1,switch1Valid:false,switch2Id:1,switch2Valid:false,variableId:1,variableValid:false,variableValue:0};
function page(image={},list=[],trigger=0,priorityType=1){return{conditions:{...condition},directionFix:true,image:{tileId:0,characterName:'',characterIndex:0,direction:2,pattern:1,...image},list:[...list,{code:0,indent:0,parameters:[]}],moveFrequency:3,moveRoute:{list:[{code:0,parameters:[]}],repeat:true,skippable:false,wait:false},moveSpeed:3,moveType:0,priorityType,stepAnime:false,through:false,trigger,walkAnime:true};}
const comment=text=>({code:108,indent:0,parameters:[text]});
function make(id,name,w,h,tilesetId,floor=2816,wall=6272){
 const size=w*h,terrain=Array(size).fill(0),data=Array(size*6).fill(0),events=[null];
 const map={autoplayBgm:false,autoplayBgs:false,battleback1Name:'',battleback2Name:'',bgm:{name:'',pan:0,pitch:100,volume:70},bgs:{name:'',pan:0,pitch:100,volume:70},disableDashing:false,displayName:name,encounterList:[],encounterStep:30,height:h,note:'<modernRound>\nAuthored modern battle royale district. Source and collision notes: data/modern-map-sources.json',parallaxLoopX:false,parallaxLoopY:false,parallaxName:'',parallaxShow:true,parallaxSx:0,parallaxSy:0,scrollType:0,specifyBattleback:false,tilesetId,width:w,data,events};
 const put=(x,y,z,t)=>{if(x<0||y<0||x>=w||y>=h)throw Error(`out of bounds ${id} ${x},${y}`);data[z*size+y*w+x]=t;};
 const rect=(x,y,rw,rh,t=floor)=>{for(let yy=y;yy<y+rh;yy++)for(let xx=x;xx<x+rw;xx++)terrain[yy*w+xx]=t;};
 const object=(sx,sy,rw,rh,x,y,sheet=0)=>{for(let yy=0;yy<rh;yy++)for(let xx=0;xx<rw;xx++){const tx=sx+xx,ty=sy+yy;put(x+xx,y+yy,2,sheet*256+Math.floor(tx/8)*128+ty*8+tx%8);}};
 const event=(name,x,y,p)=>{const e={id:events.length,name,note:'',x,y,pages:[p]};events.push(e);return e;};
 const chest=(name,x,y,type='supplies')=>event(name,x,y,page({characterName:'!Chest',characterIndex:0},[comment(`engine_container : ${type}`)]));
 const enemy=(name,x,y,type='scavenger')=>event(name,x,y,page({characterName:'Fronterworks-SF-1',characterIndex:type==='guard'?0:3},[comment(`enemy_id : ${type==='guard'?9:4}`),comment(`engine_enemy : ${type}`)]));
 const exit=(label,x,y,mapId,tx,ty,d=2)=>event(`通往${label}`,x,y,page({characterName:'!Crystal',characterIndex:1},[{code:201,indent:0,parameters:[0,mapId,tx,ty,d,0]}],1,1));
 const finalize=()=>{
  const base=terrain.map(t=>t||5888);
  // Two-tile back walls above room floors; cutaway ceilings surround the remaining edges.
  for(let y=2;y<h;y++)for(let x=1;x<w-1;x++)if(terrain[y*w+x]&&!terrain[(y-1)*w+x]){base[(y-1)*w+x]=wall;if(!terrain[(y-2)*w+x])base[(y-2)*w+x]=wall;}
  const same=(x,y,t)=>x>=0&&y>=0&&x<w&&y<h&&base[y*w+x]===t;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
   const t=base[y*w+x],l=same(x-1,y,t),r=same(x+1,y,t),u=same(x,y-1,t),d=same(x,y+1,t);let shape=0;
   if(t>=6272){shape=(!l?1:0)+(!u?2:0)+(!r?4:0)+(!d?8:0);}
   else{
    const q=[!l?(!u?[0,2]:[0,4]):!u?[2,2]:!same(x-1,y-1,t)?[2,0]:[2,4], !r?(!u?[3,2]:[3,4]):!u?[1,2]:!same(x+1,y-1,t)?[3,0]:[1,4], !l?(!d?[0,5]:[0,3]):!d?[2,5]:!same(x-1,y+1,t)?[2,1]:[2,3], !r?(!d?[3,5]:[3,3]):!d?[1,5]:!same(x+1,y+1,t)?[3,1]:[1,3]];
    shape=FLOOR.findIndex(v=>JSON.stringify(v)===JSON.stringify(q));if(shape<0)throw Error('Unknown autotile shape');
   }
   put(x,y,0,t+shape);
   if(terrain[y*w+x]&&!terrain[y*w+x-1]&&x>0)put(x,y,4,5);
  }
  return map;
 };
 return{id,name,rect,object,event,chest,enemy,exit,finalize};
}
const maps=[];
// 31: A broad transport concourse, with ticket office, service bay and separated waiting islands.
{
 const m=make(31,'换乘站 · 灰线站厅',42,30,31,2816,6368);maps.push(m);
 m.rect(2,15,38,11);m.rect(4,4,12,9);m.rect(19,4,19,9);m.rect(7,11,5,7);m.rect(27,11,5,7);
 m.rect(3,19,36,3,2864);m.rect(21,5,15,6,2912);
 for(const x of [6,12,22,28,34])m.object(4,6,3,1,x,17);
 for(const x of [21,26,31])m.object(5,0,2,2,x,4);
 for(const x of [6,10,14])m.object(4,3,1,2,x,9);
 m.object(1,4,3,2,5,4);m.object(4,0,1,2,15,5);m.object(7,2,1,3,34,9);
 m.object(3,0,1,3,18,22);m.object(3,0,1,3,30,22);
 m.chest('站务急救箱',5,7,'medical');m.chest('票务保管箱',14,11,'weapon_club');m.chest('遗失行李箱',35,12,'supplies');
 m.enemy('游荡拾荒者',16,20);m.enemy('站厅巡逻员',25,9,'guard');m.enemy('站台拾荒者',35,24);
 m.exit('乡野道路',3,18,20,34,8);m.exit('地下维护通道',38,24,32,4,18);m.exit('电玩城',37,16,33,4,22);m.exit('酒店',29,5,35,20,26);
}
// 32: Loop around two sealed utility cores, with a northern control room and south bypass.
{
 const m=make(32,'地下维护 · 双环管廊',44,32,32,3584,6272);maps.push(m);
 m.rect(2,15,40,8);m.rect(6,5,32,7);m.rect(6,10,5,16);m.rect(33,10,5,16);m.rect(6,25,32,4);m.rect(18,10,7,8);
 m.rect(7,6,29,4,2816);
 for(const x of [8,16,27,34])m.object(9,1,3,2,x,5);
 for(const x of [12,28]){m.object(0,7,4,1,x,13);m.object(0,11,3,1,x,21);}
 m.object(10,5,2,2,39,16);m.object(6,3,1,4,20,11);m.object(3,5,1,2,24,26);
 m.chest('维修工具箱',22,14,'weapon_throw');m.chest('控制室储备箱',36,10,'ammo');m.chest('应急医药箱',8,26,'medical');m.chest('管廊封存箱',40,21,'supplies');
 m.enemy('维修区拾荒者',14,18);m.enemy('管廊巡查员',30,26,'guard');m.enemy('控制室守卫',24,8,'guard');
 m.exit('地铁站厅',3,18,31,37,24);m.exit('夜店后门',40,18,34,4,23);m.exit('学生宿舍',35,27,36,4,27);
}
// 33: Arcade machine lanes leave a central spine and rear cross-aisle; prize room to the northeast.
{
 const m=make(33,'霓虹电玩城',40,30,33,2816,6272);maps.push(m);
 m.rect(2,17,36,10);m.rect(3,4,22,11);m.rect(28,4,10,11);m.rect(4,12,5,8);m.rect(19,12,5,8);m.rect(30,12,6,8);
 m.rect(3,20,34,3,2864);m.rect(29,5,8,9,3200);
 for(const x of [4,9,14,19])for(const y of [4,10])m.object(0,1,3,2,x,y);
 for(const x of [6,13,23,30])m.object(3,9,1,2,x,24);
 m.object(0,5,2,3,29,5);m.object(1,9,2,2,33,10);m.object(6,9,1,2,35,5);
 m.object(0,3,4,2,17,17);m.object(7,5,1,2,25,18);
 m.chest('柜台零钱箱',22,18,'supplies');m.chest('奖品库保管箱',36,13,'weapon_firearm');m.chest('街机维修箱',23,8,'ammo');
 m.enemy('机厅拾荒者',12,14);m.enemy('奖品库看守',32,8,'guard');m.enemy('霓虹游荡者',28,23);
 m.exit('地铁站厅',3,22,31,36,16);m.exit('夜店',36,22,34,4,14);m.exit('影院',32,17,39,4,25);
}
// 34: Dance floor, raised DJ stage, pool lounge and bar service loop.
{
 const m=make(34,'零点夜店',40,30,34,2816,6272);maps.push(m);
 m.rect(2,12,36,15);m.rect(5,4,18,7);m.rect(27,4,11,7);m.rect(7,9,5,6);m.rect(18,9,4,6);m.rect(29,9,5,6);
 m.rect(9,14,17,10,3632);m.rect(6,4,16,6,3200);m.rect(28,5,9,5,3584);
 m.object(3,10,2,1,12,6);m.object(10,4,2,2,16,5);m.object(0,3,2,4,6,4);m.object(0,3,2,4,20,4);
 m.object(12,0,3,3,30,5);m.object(12,3,3,3,29,16);
 m.object(0,7,3,4,31,22);m.object(3,11,2,1,30,21);
 for(const [x,y]of [[4,17],[4,25],[35,12],[35,19]])m.object(7,12,1,2,x,y);
 for(const x of [9,23]){m.object(2,0,1,3,x,14);m.object(2,0,1,3,x,21);}
 m.chest('DJ器材箱',17,8,'weapon_staff');m.chest('吧台储备箱',35,25,'medical');m.chest('贵宾储物箱',36,8,'supplies');
 m.enemy('舞池巡游者',17,19);m.enemy('包厢守卫',32,10,'guard');m.enemy('后门拾荒者',11,25);
 m.exit('电玩城',3,14,33,35,22);m.exit('地下维护通道',3,23,32,39,18);m.exit('室内泳池',36,14,38,4,24);
}
// 35: Reception island in the lobby; two guest suites connect through both side galleries.
{
 const m=make(35,'泊岸酒店 · 大堂与客房',40,32,35,3200,6272);maps.push(m);
 m.rect(3,19,34,10);m.rect(3,5,13,11);m.rect(24,5,13,11);m.rect(4,13,5,9);m.rect(31,13,5,9);m.rect(12,15,17,4);
 m.rect(17,19,6,10,3680);m.rect(4,6,11,8,2816);m.rect(25,6,11,8,2864);
 m.object(2,9,3,2,16,21);m.object(0,9,1,3,15,22);
 for(const x of [5,30]){m.object(8,8,2,3,x,5);m.object(6,8,2,2,x+3,4);m.object(7,1,1,1,x+4,9);m.object(6,0,1,1,x+3,9);m.object(6,1,1,1,x+5,9);}
 m.object(0,14,2,2,26,21);m.object(6,2,2,2,7,19);
 for(const [x,y]of [[4,24],[34,24],[13,12],[25,12]])m.object(1,2,1,2,x,y);
 m.object(6,6,2,2,18,15);
 m.chest('接待台保管箱',19,23,'weapon_firearm');m.chest('西客房旅行箱',13,8,'medical');m.chest('东客房贵重箱',35,12,'supplies');
 m.enemy('大堂巡查员',28,25,'guard');m.enemy('客房拾荒者',9,12);m.enemy('连廊巡查员',22,17,'guard');
 m.exit('地铁站厅',20,28,31,29,6);m.exit('学生宿舍',35,18,36,4,16);m.exit('健身房',4,18,37,35,24);
}
// 36: Four dormitory rooms, communal kitchen and a shared lounge joined by a ring corridor.
{
 const m=make(36,'学生宿舍 · 生活区',42,34,36,2816,6272);maps.push(m);
 m.rect(2,14,38,7);m.rect(3,4,14,8);m.rect(25,4,14,8);m.rect(3,24,14,7);m.rect(25,24,14,7);
 m.rect(6,10,5,16);m.rect(31,10,5,16);m.rect(13,28,18,3);
 m.rect(3,15,36,4,3200);
 for(const x of [4,26]){for(const dx of [0,5])m.object(6,4,2,2,x+dx,4);m.object(1,0,3,2,x+1,9);m.object(5,4,1,2,x+10,5);}
 m.object(8,0,3,3,5,24);m.object(0,13,3,1,11,25);m.object(6,0,2,2,12,22);
 m.object(0,14,6,1,26,24);m.object(5,12,1,2,36,24);m.object(4,0,1,2,34,24);
 m.object(0,2,4,2,19,14);m.object(5,0,1,2,23,19);
 m.chest('宿舍急救箱',15,6,'medical');m.chest('社团器材箱',36,9,'weapon_throw');m.chest('公共厨房储物箱',37,28,'supplies');m.chest('休息室工具箱',14,27,'ammo');
 m.enemy('走廊拾荒者',20,18);m.enemy('东楼巡查员',33,12,'guard');m.enemy('宿舍游荡者',12,29);
 m.exit('酒店',3,16,35,34,18);m.exit('地下维护通道',3,27,32,34,27);m.exit('健身房',38,17,37,4,14);
}
// 37: Fitness islands, a mirrored stretching room and lockers; three exits form a circulation loop.
{
 const m=make(37,'训练中心 · 健身房',40,30,37,3248,6272);maps.push(m);
 m.rect(2,12,36,15);m.rect(4,4,15,6);m.rect(24,4,13,6);m.rect(6,8,5,7);m.rect(27,8,6,7);
 m.rect(4,14,14,10,3392);m.rect(23,14,13,10,3200);
 for(const x of [6,11,16]){m.object(7,11,1,3,x,15);m.object(5,11,1,3,x,21);}
 for(const x of [25,29,33])m.object(5,9,1,2,x,16);
 for(const x of [25,30])m.object(0,6,3,3,x,4);
 for(const x of [5,9,13])m.object(4,9,1,2,x,4);
 m.object(11,5,2,2,20,12);m.object(2,0,1,2,35,20);
 m.chest('训练补给箱',17,8,'medical');m.chest('器械维护箱',34,8,'weapon_club');m.chest('教练保管箱',35,25,'supplies');
 m.enemy('训练场巡查员',20,20,'guard');m.enemy('更衣室拾荒者',28,10);m.enemy('器械区游荡者',10,25);
 m.exit('学生宿舍',3,14,36,37,17);m.exit('酒店',36,24,35,5,18);m.exit('室内泳池',36,13,38,4,14);
}
// 38: Deep basin is impassable; a wide deck surrounds it and links first aid, showers and stands.
{
 const m=make(38,'蓝湾游泳馆',42,32,37,2816,6320);maps.push(m);
 m.rect(2,12,38,17);m.rect(4,4,14,6);m.rect(25,4,13,6);m.rect(6,8,5,7);m.rect(28,8,6,7);
 m.rect(11,15,21,10,2960);m.rect(11,15,21,1,2816); // pale coping at the north edge
 for(const x of [13,18,23,28])m.object(4,2,1,1,x,14);
 for(const x of [5,34]){m.object(0,2,2,1,x,17);m.object(0,2,2,1,x,23);}
 m.object(2,1,2,1,8,5);m.object(11,5,2,2,26,4);m.object(7,1,1,1,33,5);
 m.object(0,6,3,3,5,6);m.object(0,6,3,3,12,6);
 m.object(0,3,1,2,10,20);m.object(0,3,1,2,32,20);
 m.chest('救生员急救箱',36,7,'medical');m.chest('更衣柜储备箱',16,5,'supplies');m.chest('看台器材箱',36,27,'ammo');
 m.enemy('泳馆巡查员',23,12,'guard');m.enemy('看台拾荒者',7,26);m.enemy('救生室游荡者',30,9);
 m.exit('健身房',3,14,37,35,13);m.exit('夜店',3,24,34,35,14);m.exit('影院',38,24,39,35,25);
}
// 39: Ticket foyer, two screening rooms with distinct seating blocks and accessible side aisles.
{
 const m=make(39,'星幕影院',42,34,38,2816,6272);maps.push(m);
 m.rect(2,23,38,8);m.rect(3,5,15,15);m.rect(24,5,15,15);m.rect(4,18,5,7);m.rect(32,18,5,7);m.rect(16,17,10,4);
 m.rect(3,24,36,3,2912);m.rect(4,6,13,12,2864);m.rect(25,6,13,12,2864);
 for(const x of [7,28])m.object(13,8,3,2,x,4);
 for(const x0 of [3,24])for(const y of [9,13,17])for(const dx of [3,5,8,10])m.object(6,4,1,2,x0+dx,y);
 m.object(0,5,4,2,15,23);m.object(0,3,1,2,22,23);m.object(10,4,3,2,24,24);m.object(4,2,1,1,25,23);
 for(const x of [4,36])m.object(6,2,1,2,x,28);
 m.chest('售票台保管箱',28,25,'supplies');m.chest('一号厅应急箱',15,7,'medical');m.chest('放映设备箱',36,7,'weapon_staff');m.chest('二号厅储备箱',37,19,'ammo');
 m.enemy('一号厅拾荒者',5,15);m.enemy('放映厅守卫',34,15,'guard');m.enemy('售票厅游荡者',29,28);m.enemy('联络通道巡查员',20,19,'guard');
 m.exit('电玩城',3,25,33,32,18);m.exit('室内泳池',36,25,38,37,24);
}
const infos=await read(path.join(root,'data/MapInfos.json'));
for(const m of maps){await write(path.join(root,`data/Map${String(m.id).padStart(3,'0')}.json`),m.finalize());infos[m.id]={id:m.id,expanded:false,name:m.name,order:m.id,parentId:9,scrollX:0,scrollY:0};}
// Touch portals are shared by keyboard, mouse navigation and offline escape routing.
const roadPath=path.join(root,'data/Map020.json'),road=await read(roadPath),old=road.events.find(e=>e?.name==='通往现代区 · 灰线地铁');
const entrance={id:old?.id||road.events.length,name:'通往现代区 · 灰线地铁',note:'modern district connector',x:35,y:8,pages:[page({characterName:'!Crystal',characterIndex:1},[{code:201,indent:0,parameters:[0,31,4,18,6,0]}],1,1)]};
road.events[entrance.id]=entrance;
await write(roadPath,road);await write(path.join(root,'data/MapInfos.json'),infos);await write(path.join(root,'data/Tilesets.json'),tilesets);
await write(path.join(root,'data/modern-map-sources.json'),{description:'Nine original layouts assembled from local licensed RMTiles assets. Sample projects used for collision flags, not copied as layouts.',resourceRoot:'D:/Resources/RM_Resources/RMTiles',maps:maps.map(m=>({id:m.id,name:m.name})),tilesets:provenance});
console.log(JSON.stringify({maps:maps.map(m=>({id:m.id,name:m.name,events:m.finalize().events.length-1})),tilesets:provenance.length,assets:provenance.reduce((n,p)=>n+p.assets.length,0)}));
