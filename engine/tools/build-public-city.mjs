import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {FLOOR} from '../client/autotile-tables.mjs';

// Authored public-city layouts. Samples supply object grammar and flags, not layouts.
// Explicit rebuild only: overwrites Map040–048 and their two dedicated tilesets.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const resources=process.env.CITY_RESOURCES||'D:/Resources';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const write=async(p,v)=>{
 let text;
 if(Array.isArray(v))text='[\n'+v.map(x=>JSON.stringify(x)).join(',\n')+'\n]\n';
 else if(v.data&&v.events){const{data,events,...head}=v;text='{\n'+JSON.stringify(head).slice(1,-1)+',\n"data":'+JSON.stringify(data)+',\n"events":[\n'+events.map(x=>JSON.stringify(x)).join(',\n')+'\n]\n}\n';}
 else text=JSON.stringify(v,null,2)+'\n';
 await fs.writeFile(p,text);
};
const packs=[
 {id:39,packId:'P67086633a25e',name:'Public City / Living Good City',base:'MZDLC/SERIALGAMES Living Good City Tileset',sample:'sample project_en/data',assets:'tileset',sourceId:7,credit:'(C) 2022 SERIALGAMES Inc.',creditSource:'readme.pdf'},
 {id:40,packId:'P8633265806b8',name:'Public City / Modern JP Interiors',base:'MVDLC/DorapixelMapChips - Modern JP Interiors',sample:'Samplemap/MV/samplemap_en/data',assets:'tilesets',sourceId:1,credit:"(C) 2021 Pika's Game",creditSource:'readme.pdf'}
];
const tilesets=await read(path.join(root,'data/Tilesets.json')),sources=[];
for(const pack of packs){
 const ts=structuredClone((await read(path.join(resources,pack.base,pack.sample,'Tilesets.json')))[pack.sourceId]);
 ts.id=pack.id;ts.name=pack.name;ts.note='Public city dedicated copy. Sample flags retained except solid roof/cutaway boundary. See public-city-sources.json.';
 const copied=[];
 for(let slot=0;slot<9;slot++){const name=ts.tilesetNames[slot];if(!name)continue;const target=`CITY_${name}`;await fs.copyFile(path.join(resources,pack.base,pack.assets,`${name}.png`),path.join(root,'img/tilesets',`${target}.png`));ts.tilesetNames[slot]=target;copied.push({slot,source:`${pack.base}/${pack.assets}/${name}.png`,target:`img/tilesets/${target}.png`});}
 const ranges=pack.id===39?[[5888,6079]]:[[5888,5935]];
 for(const[start,end]of ranges)for(let t=start;t<=end;t++)ts.flags[t]=(ts.flags[t]||0)|15;
 tilesets[pack.id]=ts;sources.push({...pack,engineScope:'Source EULA names RPG Maker MV/MZ and other RPG Maker series entries; no broader custom-engine license is asserted here.',assets:copied,collisionOverrides:ranges.map(([start,end])=>({start,end,reason:'Solid building roof / cutaway boundary, inaccessible in public city'}))});
}
await write(path.join(root,'data/Tilesets.json'),tilesets);
await write(path.join(root,'data/public-city-sources.json'),{resourceRoot:resources,tilesets:sources});

const conditions={actorId:1,actorValid:false,itemId:1,itemValid:false,selfSwitchCh:'A',selfSwitchValid:false,switch1Id:1,switch1Valid:false,switch2Id:1,switch2Valid:false,variableId:1,variableValid:false,variableValue:0};
const command=(code,...parameters)=>({code,indent:0,parameters});
function page(image={},commands=[],trigger=0,priorityType=1){return{conditions:{...conditions},directionFix:true,image:{tileId:0,characterName:'',characterIndex:0,direction:2,pattern:1,...image},list:[...commands,command(0)],moveFrequency:3,moveRoute:{list:[{code:0,parameters:[]}],repeat:true,skippable:false,wait:false},moveSpeed:3,moveType:0,priorityType,stepAnime:false,through:false,trigger,walkAnime:true};}
const tile=(sx,sy,sheet=0)=>sheet*256+Math.floor(sx/8)*128+sy*8+sx%8;
function make(id,name,w,h,ts,{indoor=false,floor=3584,wall=6272}={}){
 const n=w*h,data=Array(n*6).fill(0),ground=Array(n).fill(indoor?0:floor),events=[null];
 const map={autoplayBgm:false,autoplayBgs:false,battleback1Name:'',battleback2Name:'',bgm:{name:'',pan:0,pitch:100,volume:70},bgs:{name:'',pan:0,pitch:100,volume:70},disableDashing:false,displayName:name,encounterList:[],encounterStep:30,height:h,note:'<publicCity>\nShared non-instance public city. Authored layouts; see public-city-sources.json.',parallaxLoopX:false,parallaxLoopY:false,parallaxName:'',parallaxShow:true,parallaxSx:0,parallaxSy:0,scrollType:0,specifyBattleback:false,tilesetId:ts,width:w,data,events};
 const check=(x,y)=>{if(x<0||y<0||x>=w||y>=h)throw Error(`Map${id} out of bounds ${x},${y}`);};
 const put=(x,y,z,t)=>{check(x,y);data[z*n+y*w+x]=t;};
 const rect=(x,y,rw,rh,t=floor)=>{for(let yy=y;yy<y+rh;yy++)for(let xx=x;xx<x+rw;xx++){check(xx,yy);ground[yy*w+xx]=t;}};
 const object=(sx,sy,rw,rh,x,y,sheet=0,z=2)=>{for(let yy=0;yy<rh;yy++)for(let xx=0;xx<rw;xx++)put(x+xx,y+yy,z,tile(sx+xx,sy+yy,sheet));};
 const event=(name,x,y,p,note='',id=events.length)=>{check(x,y);while(events.length<=id)events.push(null);events[id]={id,name,note,x,y,pages:[p]};return events[id];};
 const portal=(label,x,y,mapId,tx,ty,d=2)=>event(`前往${label}`,x,y,page({},[command(201,0,mapId,tx,ty,d,0)],1,0));
 const npc=(name,x,y,text,index=0)=>event(name,x,y,page({characterName:'People1',characterIndex:index},[command(101,'',0,0,2),...text.split('\n').map(t=>command(401,t))]));
 const sign=(name,x,y,text)=>event(name,x,y,page({},[command(101,'',0,0,2),...text.split('\n').map(t=>command(401,t))],0,0));
 const service=(name,x,y,kind,index)=>event(name,x,y,page({characterName:'Actor1',characterIndex:index},[command(101,'',0,0,2),command(401,kind==='instance'?'请在在线世界与我交谈，创建或加入远征。':'请在在线世界与我交谈，调整并保存外观。')]),`engine_service: ${kind}`);
 const tree=(x,y)=>object(4,0,1,2,x,y);
 const bench=(x,y)=>object(4,2,2,1,x,y);
 const lamp=(x,y)=>object(1,2,1,2,x,y);
 const building=(x,y,bw,bh,roof=5888,face=6272)=>{rect(x,y,bw,bh-3,roof);rect(x,y+bh-3,bw,3,face);for(let xx=x+1;xx<x+bw-2;xx+=3)object(9,3,2,1,xx,y+bh-3);};
 const finish=()=>{
  const base=ground.map(t=>t||5888);
  if(indoor)for(let y=2;y<h;y++)for(let x=1;x<w-1;x++)if(ground[y*w+x]&&!ground[(y-1)*w+x]){base[(y-1)*w+x]=wall;if(!ground[(y-2)*w+x])base[(y-2)*w+x]=wall;}
  // A cutaway's black exterior continues beyond the map; do not outline the canvas.
  const same=(x,y,t)=>x<0||y<0||x>=w||y>=h?indoor&&t===5888:base[y*w+x]===t;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
   const t=base[y*w+x];if(t<2048){put(x,y,0,t);continue;}
   const l=same(x-1,y,t),r=same(x+1,y,t),u=same(x,y-1,t),d=same(x,y+1,t);
   const kind=Math.floor((t-2048)/48),isWall=t>=4352&&(t<5888||Math.floor((kind-80)/8)%2===1);let shape;
   if(isWall)shape=(!l?1:0)+(!u?2:0)+(!r?4:0)+(!d?8:0);
   else{const q=[!l?(!u?[0,2]:[0,4]):!u?[2,2]:!same(x-1,y-1,t)?[2,0]:[2,4],!r?(!u?[3,2]:[3,4]):!u?[1,2]:!same(x+1,y-1,t)?[3,0]:[1,4],!l?(!d?[0,5]:[0,3]):!d?[2,5]:!same(x-1,y+1,t)?[2,1]:[2,3],!r?(!d?[3,5]:[3,3]):!d?[1,5]:!same(x+1,y+1,t)?[3,1]:[1,3]];shape=FLOOR.findIndex(v=>JSON.stringify(v)===JSON.stringify(q));if(shape<0)throw Error(`Unmatched autotile ${t}`);}
   put(x,y,0,t+shape);
   if(indoor&&ground[y*w+x]&&x>0&&!ground[y*w+x-1])put(x,y,4,5);
  }
  return map;
 };
 return {id,name,w,h,map,rect,put,object,event,portal,npc,sign,service,tree,bench,lamp,building,finish};
}
const maps=[];
// 40: a walkable arrival boulevard, small shopfronts and north park approach.
{
 const m=make(40,'榆风市 · 中央街区',42,32,39,{floor:2816});maps.push(m);
 m.rect(2,12,38,16,3728);m.rect(17,0,8,32,3728);m.rect(2,30,16,2,3728);
 m.rect(0,17,42,4,3968);m.rect(19,0,4,22,3968);
 m.rect(17,22,8,10,4064); // pedestrian arrival court, south of the crossing
 // Crossing stripes use the complete source A5 stripe row, rotated variants are never invented.
 for(const y of [17,18,19,20])for(const x of [19,20,21,22])m.put(x,y,1,1536+8*2+0);
 m.building(3,3,12,9,5936,6320);m.building(28,3,11,9,5888,6272);
 m.building(3,23,12,7,5984,6368);
 for(const[x,y]of[[5,5],[8,5],[30,5],[33,5],[5,24]])m.object(9,4,1,1,x,y);
 m.object(10,4,2,1,10,7);m.object(10,4,2,1,35,7);
 // Glass entrance and shop fascia: whole units from Living Good City B.
 m.object(14,11,1,1,8,11);m.object(14,11,1,1,33,11);
 m.object(2,8,4,2,5,28);m.object(14,11,1,1,10,29);
 m.portal('街角便利商店',10,30,42,12,18,8);
 m.portal('换装美容工作室',8,12,43,11,17,8);
 m.portal('榆风公寓',33,12,45,12,17,8);
 for(const y of [14,15,16])m.portal('榆风广场',41,y,41,2,18,6);
 for(const x of [17,18])m.portal('榆风公园',x,0,48,16,28,8);
 for(const[x,y]of[[1,3],[1,8],[16,4],[26,4],[40,4],[40,9],[1,23],[16,26],[27,26],[38,27],[3,0],[9,0],[31,0],[37,0]])m.tree(x,y);
 m.bench(28,24);m.bench(35,24);m.lamp(16,13);m.lamp(26,13);m.lamp(16,23);m.lamp(38,13);
 m.rect(27,21,11,2,2816);m.object(0,1,3,1,28,22);m.object(0,1,3,1,34,22);
 m.object(6,0,2,1,30,18);m.object(6,1,2,1,5,19);
 m.npc('城市向导',24,23,'欢迎来到榆风市。\n东侧是远征广场；北面通往公园。\n美容工作室在西北，便利商店在西南，公寓在东北。',2);
 m.sign('街区导览',20,23,'东行：远征广场、市民大厅、政务服务厅。\n西北：美容工作室；西南：便利商店与合成台。\n东北：公寓；北行：榆风公园。');
 m.sign('美容工作室门牌',8,13,'换装美容工作室 · 外观调整服务');
 m.sign('便利商店门牌',10,31,'街角便利商店 · 商品陈列与合成台');
}
// 43 is deliberately compact: reception on arrival, mirror stations to the right,
// private changing bays behind a partial wall, a lounge along the west frontage.
{
 const m=make(43,'换装美容工作室',24,22,40,{indoor:true,floor:2864,wall:6320});maps.push(m);
 m.rect(2,5,20,14);m.rect(15,3,7,4);m.rect(2,13,7,6,3584);m.rect(14,6,8,11,3200);
 m.rect(9,15,5,4,3680);
 // Two complete mirror-and-wash stations, each with an individual seat.
 for(const x of [15,19]){m.object(14,9,2,3,x,5);m.object(15,5,1,1,x,9);}
 m.object(10,14,2,2,9,5,1);m.service('外观调整师',10,8,'appearance',1);
 m.object(1,8,1,2,3,5);m.object(1,8,1,2,20,15);
 m.object(14,0,2,3,4,5);m.object(11,3,2,2,4,10);
 m.object(1,14,2,2,4,15);m.object(15,5,1,1,3,15);m.object(15,5,1,1,6,15);
 m.object(14,0,2,3,15,12);m.object(14,0,2,3,19,12);
 m.portal('中央街区',11,19,40,8,14,2);m.rect(10,18,3,2,3680);
 m.npc('造型助理',7,11,'造型师就在接待台旁。\n可以组合角色部件和色板，也可以选择已有角色外观。',4);
}

// 41: the civic forecourt has a broad gathering apron, a flower garden and a
// separate expedition service; it is a destination square, not another road.
{
 const m=make(41,'榆风广场 · 远征集合处',34,30,39,{floor:2816});maps.push(m);
 m.rect(1,8,32,21,3680);m.rect(1,0,5,29,3584);m.rect(7,10,23,16,3728);
 m.building(9,0,22,8,5888,6272);m.object(13,11,1,1,19,7);
 m.object(9,4,1,1,11,2);m.object(9,4,1,1,13,2);m.object(10,4,2,1,26,2);
 m.portal('市民大厅',19,8,44,16,21,8);
 m.rect(11,14,8,5,2816);m.rect(12,15,6,3,3008);
 m.object(0,1,3,1,13,16);m.tree(11,13);m.tree(18,13);
 m.bench(8,13);m.bench(20,18);m.bench(12,22);m.bench(25,22);
 m.lamp(7,9);m.lamp(29,9);m.lamp(6,24);m.lamp(30,24);
 for(const[x,y]of[[0,3],[7,2],[32,2],[32,6],[1,26],[8,27],[18,27],[28,27]])m.tree(x,y);
 m.service('远征接引员 · 进入副本',23,12,'instance',5);
 m.object(6,7,1,2,25,10);m.npc('广场志愿者',6,18,'远征接引员在东侧集合区。\n北面的大楼是市民大厅，再往里是政务服务厅。\n沿西北侧步道可以进入公园。',1);
 for(const y of [17,18,19])m.portal('中央街区',0,y,40,39,15,4);
 for(const x of [2,3,4])m.portal('榆风公园',x,0,48,32,17,4);
 m.sign('远征集合区',23,15,'与远征接引员交谈可创建 PvE / PvPvE 副本。\n撤离后会返回入局前的位置。');
}
// 42: the short shop aisles lead to a checkout and an existing crafting service.
{
 const m=make(42,'街角便利商店',26,22,40,{indoor:true,floor:3584,wall:6368});maps.push(m);
 m.rect(2,4,22,15);m.rect(11,17,3,3,3680);
 m.object(8,10,7,2,3,3,1);m.object(8,4,5,3,4,8,1);m.object(8,7,6,3,4,13,1);
 m.object(8,4,5,3,11,8,1);m.object(8,12,3,2,11,13,1);
 m.object(10,14,2,2,18,5,1);m.object(14,2,1,2,21,4,1);
 m.object(4,10,2,3,19,10);m.object(14,0,2,3,22,10);
 m.object(1,8,1,2,21,16);m.npc('商店店员',17,7,'欢迎光临。\n制作台在右侧，已开放的合成配方沿用原来的材料要求。',3);
 const old=await read(path.join(root,'data/Map003.json'));
 let source=old.events[8];
 if(!source){try{source=(await read(path.join(root,'data/Map042.json'))).events[8];}catch{}}
 if(!source)throw Error('Missing original crafting event Map003:8');
 const craft=structuredClone(source);craft.id=8;craft.name='合成工匠';craft.note='Migrated from Map003 event 8; command list and choices retained.';craft.x=18;craft.y=13;
 craft.pages[0].image={...craft.pages[0].image,characterName:'People1',characterIndex:6,direction:2};
 while(m.map.events.length<=8)m.map.events.push(null);m.map.events[8]=craft;
 if(old.events[8]){old.events[8]=null;await write(path.join(root,'data/Map003.json'),old);}
 m.portal('中央街区',12,19,40,10,31,2);
}
// 44: a civic reception hall has a central assembly floor and side lounges.
{
 const m=make(44,'市民大厅',34,26,40,{indoor:true,floor:3584,wall:6368});maps.push(m);
 m.rect(2,5,30,17);m.rect(14,20,5,4);m.rect(12,8,10,11,3632);m.rect(25,3,5,4);
 m.object(0,2,2,2,4,3);m.object(4,2,2,2,11,3);m.object(0,2,2,2,19,3);
 m.object(10,14,2,2,9,17,1);m.npc('市民大厅接待员',10,20,'欢迎来到市民大厅。\n政务服务厅在右后方；休息区在两侧。',2);
 for(const[x,y]of[[4,13],[8,13],[4,17]])m.object(8,5,2,1,x,y,2);
 for(const[x,y]of[[24,13],[28,13],[24,17],[28,17]])m.object(8,5,2,1,x,y,2);
 m.object(1,14,2,2,5,14);m.object(1,14,2,2,25,14);
 for(const[x,y]of[[3,5],[30,5],[3,19],[30,19]])m.object(1,8,1,2,x,y);
 m.object(12,12,2,1,25,6,1);m.portal('政务服务厅',27,4,47,16,21,8);
 // A complete A5 office door sits in the back wall above the approach trigger.
 m.put(27,1,2,1536+9*8+5);m.put(27,2,2,1536+10*8+5);
 m.portal('榆风广场',16,23,41,19,10,2);
 m.sign('政务导览',26,8,'政务服务厅 · 请沿右侧走廊前往。');
}
// 45: residential entrance, delivery lockers, shared sitting room and north stairs.
{
 const m=make(45,'榆风公寓 · 门厅',24,22,40,{indoor:true,floor:2864,wall:6320});maps.push(m);
 m.rect(2,5,20,13);m.rect(10,16,5,4);m.rect(15,3,5,5);m.rect(3,10,9,7,3728);
 m.object(10,3,3,3,3,5);m.object(14,0,2,3,7,5);
 m.object(1,14,2,2,6,12);m.object(15,5,1,1,5,12);m.object(15,5,1,1,8,12);
 m.object(0,8,1,2,3,15);m.object(1,8,1,2,20,15);
 m.object(4,8,2,2,16,11);m.object(2,6,2,1,16,11,0,3);
 m.put(16,13,2,126);m.put(17,13,2,127);
 m.npc('公寓管理员',17,14,'欢迎回家。\n住户信箱在左侧，楼梯在北侧。\n楼上的两户与公共走廊可以自由参观。',7);
 // Whole wooden stairs: A5 three-column run with its top landing.
 for(let y=0;y<3;y++)for(let x=0;x<3;x++)m.put(16+x,4+y,1,1536+(13+y)*8+x);
 m.portal('公寓住宅层',17,6,46,16,10,2);
 m.portal('中央街区',12,19,40,33,14,2);
}
// 46: two independent homes share only the central landing and front corridor.
{
 const m=make(46,'榆风公寓 · 住宅层',34,25,40,{indoor:true,floor:2864,wall:6320});maps.push(m);
 m.rect(2,5,12,13,2912);m.rect(20,5,12,13,2960);m.rect(15,5,4,17);m.rect(2,19,30,3);
 m.rect(11,15,6,5);m.rect(18,15,6,5);m.rect(3,5,5,5,3200);m.rect(26,5,5,5,3200);
 // West home: kitchen beside dining, then a bed at the quieter back corner.
 m.object(8,11,4,2,3,5);m.object(12,11,1,3,7,5);m.object(1,14,2,2,4,11);
 m.object(15,5,1,1,3,11);m.object(15,5,1,1,6,11);m.object(8,0,1,3,10,5);
 m.object(14,0,2,3,11,9);m.object(0,8,1,2,3,15);
 // East home: twin sleeping space and a work corner adjoining a kitchenette.
 m.object(8,0,1,3,21,5);m.object(8,0,1,3,23,5);m.object(8,11,4,2,27,5);
 m.object(4,8,2,2,26,11);m.object(2,6,2,1,26,11,0,3);m.object(14,0,2,3,29,10);
 m.put(26,13,2,126);m.put(27,13,2,127);
 m.object(1,8,1,2,29,15);m.object(15,5,1,1,26,14);
 m.object(0,2,2,2,4,3);m.object(0,2,2,2,21,3);m.object(0,2,2,2,28,3);
 for(let y=0;y<3;y++)for(let x=0;x<3;x++)m.put(15+x,5+y,1,1536+(13+y)*8+x);
 m.portal('公寓门厅',16,8,45,17,8,2);
 m.npc('公寓住户',10,13,'左边这户把餐桌放在厨房旁。\n沿公共走廊可以去另一户，不用穿过卧室。',4);
 m.sign('楼层导览',17,18,'榆风公寓 · 2F\n左：201；右：202；北侧楼梯返回门厅。');
}
// 47: a working civic office: counters across the north, queue seating centrally,
// a consultation booth to the west and reference shelves to the east.
{
 const m=make(47,'政务服务厅',34,26,40,{indoor:true,floor:3584,wall:6368});maps.push(m);
 m.rect(2,5,22,17);m.rect(26,5,6,16);m.rect(22,17,10,5);m.rect(14,20,5,4);m.rect(3,15,18,5,3632);
 for(const x of [12,17,22]){m.object(4,8,2,2,x,6);m.object(2,6,2,1,x,6,0,3);m.put(x,8,2,126);m.put(x+1,8,2,127);m.npc('政务窗口',x+1,9,'这里是市民服务窗口。\n后续城市功能将从这里接入，当前可自由参观。',2);}
 m.object(10,3,3,3,26,4);m.object(11,0,3,3,4,4);
 m.object(4,8,2,2,4,10);m.object(2,6,2,1,4,10,0,3);m.put(4,12,2,126);m.put(5,12,2,127);m.npc('咨询员',6,13,'办理区在北侧，右侧独立房间是资料阅览室。\n可以在等候区休息。',1);
 for(const x of [5,10,15])for(const y of [16,19])m.object(8,5,2,1,x,y,2);
 m.object(1,14,2,2,27,13);m.object(15,5,1,1,26,13);m.object(15,5,1,1,29,13);
 for(const[x,y]of[[3,18],[30,18],[3,8]])m.object(1,8,1,2,x,y);
 m.portal('市民大厅',16,23,44,27,7,2);
}
// 48: a pond-side walk and a separate playground, with a direct accessible spine.
{
 const m=make(48,'榆风公园',36,32,39,{floor:2816});maps.push(m);
 m.rect(14,0,5,32,3584);m.rect(2,14,34,5,3584);m.rect(2,4,11,5,3200);m.rect(7,6,5,20,3200);
 m.rect(14,0,5,3,2816);m.tree(16,0);m.bench(15,3);
 m.rect(20,4,13,9,3200);m.rect(22,11,5,5,3200);m.rect(20,22,12,6,3200);
 m.rect(2,20,9,9,2048);m.rect(10,24,3,4,2048);m.object(0,4,2,1,4,22);m.object(0,5,2,1,8,25);
 m.rect(2,18,11,2,4112);m.bench(5,19);
 m.object(2,2,2,1,22,5);m.object(0,6,2,2,28,7);m.bench(28,11);m.bench(22,11);
 m.bench(4,7);m.bench(21,24);m.bench(28,24);m.bench(11,20);
 for(const[x,y]of[[2,2],[6,1],[10,2],[20,1],[25,1],[31,2],[34,4],[34,9],[1,10],[4,11],[7,11],[20,20],[33,21],[33,26],[3,30],[9,30],[21,29],[27,29],[34,29]])m.tree(x,y);
 for(const[x,y]of[[12,12],[19,12],[12,27],[31,14]])m.lamp(x,y);
 for(const[x,y]of[[3,4],[7,4],[22,22],[28,22]])m.object(0,1,3,1,x,y);
 m.npc('公园管理员',19,20,'池边适合散步，游乐区在东北。\n南出口回中央街区，东出口通往远征广场。',7);
 for(const x of [15,16,17])m.portal('中央街区',x,31,40,18,2,2);
 for(const y of [16,17,18])m.portal('榆风广场',35,y,41,3,2,2);
}

const infos=await read(path.join(root,'data/MapInfos.json'));
for(const m of maps){await write(path.join(root,`data/Map${String(m.id).padStart(3,'0')}.json`),m.finish());while(infos.length<=m.id)infos.push(null);infos[m.id]={id:m.id,expanded:true,name:m.name,order:m.id,parentId:m.id===40?0:40,scrollX:0,scrollY:0};}
await write(path.join(root,'data/MapInfos.json'),infos);
const system=await read(path.join(root,'data/System.json'));
Object.assign(system,{startMapId:40,startX:20,startY:23});
// Preserve the database's compact native serialization to keep the diff reviewable.
await fs.writeFile(path.join(root,'data/System.json'),JSON.stringify(system)+'\n');
console.log(`Built ${maps.map(m=>m.id).join(', ')} public maps.`);
