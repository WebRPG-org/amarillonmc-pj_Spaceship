import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {FLOOR} from '../client/autotile-tables.mjs';

// Explicitly rebuilds the four ROSE lessons. Shared tilesets and existing event
// identities are preserved. Gameplay gates and Gab guidance live in the server.
const root = fileURLToPath(new URL('../../', import.meta.url));
const command = (code, ...parameters) => ({code, indent:0, parameters});
const conditions = {actorId:1,actorValid:false,itemId:1,itemValid:false,selfSwitchCh:'A',selfSwitchValid:false,switch1Id:1,switch1Valid:false,switch2Id:1,switch2Valid:false,variableId:1,variableValid:false,variableValue:0};
const tile = (x,y,sheet=0) => sheet*256+Math.floor(x/8)*128+y*8+x%8;
const roseImage = {characterName:'$ROSE',characterIndex:0};
function page(image={},commands=[],{trigger=0,priorityType=1,through=false}={}) {
  return {conditions:{...conditions},directionFix:true,image:{tileId:0,characterName:'',characterIndex:0,direction:2,pattern:1,...image},
    list:[...commands,command(0)],moveFrequency:3,moveRoute:{list:[{code:0,parameters:[]}],repeat:true,skippable:false,wait:false},
    moveSpeed:3,moveType:0,priorityType,stepAnime:false,through,trigger,walkAnime:true};
}
function make(id,name,width,height,{indoor=false,floor=2816,wall=6368}={}) {
  const size=width*height,ground=Array(size).fill(indoor?0:floor),data=Array(size*6).fill(0),events=[null];
  const map={autoplayBgm:false,autoplayBgs:false,battleback1Name:'',battleback2Name:'',bgm:{name:'',pan:0,pitch:100,volume:70},bgs:{name:'',pan:0,pitch:100,volume:70},
    disableDashing:false,displayName:name,encounterList:[],encounterStep:30,height,
    note:`<localAdventure>\nengine_adventure: tutorial\nengine_environment: ${indoor?'indoor':'outdoor'}\nROSE single-player lesson. See doc/2026-10-14-rose-tutorial-maps.md.`,
    parallaxLoopX:false,parallaxLoopY:false,parallaxName:'',parallaxShow:false,parallaxSx:0,parallaxSy:0,scrollType:0,specifyBattleback:false,
    tilesetId:indoor?40:39,width,data,events};
  const check=(x,y)=>{if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=width||y>=height)throw Error(`Map ${id}: invalid ${x},${y}`);};
  const put=(x,y,z,value)=>{check(x,y);data[z*size+y*width+x]=value;};
  const rect=(x,y,w,h,value=floor)=>{for(let dy=0;dy<h;dy++)for(let dx=0;dx<w;dx++){check(x+dx,y+dy);ground[(y+dy)*width+x+dx]=value;}};
  const object=(sx,sy,w,h,x,y,sheet=0,z=2)=>{for(let dy=0;dy<h;dy++)for(let dx=0;dx<w;dx++)put(x+dx,y+dy,z,tile(sx+dx,sy+dy,sheet));};
  const event=(name,x,y,image,commands=[],note='',options={})=>{check(x,y);const event={id:events.length,name,note,x,y,pages:[page(image,commands,options)]};events.push(event);return event;};
  const text=(...lines)=>[command(101,'ROSE',1,0,2),...lines.map(line=>command(401,line))];
  const service=(name,x,y,kind,image,lines)=>event(name,x,y,image,text(...lines),`engine_service: ${kind}`);
  const guide=(x,y)=>service('ROSE · 教学向导',x,y,'tutorialGuide',roseImage,['我是 ROSE！需要提示就来找我。','教学会显示在 Gab 提示窗，边看边操作就好。']);
  const portal=(name,x,y,mapId,tx,ty,direction=2)=>event(`前往${name}`,x,y,{characterName:'!Crystal',characterIndex:mapId<id?2:1},[command(201,0,mapId,tx,ty,direction,0)],'',{trigger:1,priorityType:0});
  const checkpoint=(id,x,y)=>event(`机动检查点 ${id.toUpperCase()}`,x,y,{characterName:'!Crystal',characterIndex:3},[command(108,`engine_tutorial_checkpoint: ${id}`)],`engine_tutorial_checkpoint: ${id}`,{priorityType:0,through:true});
  const dummy=(kind,x,y,name)=>event(name,x,y,{characterName:'Fronterworks-SF-1',characterIndex:3},[command(108,`engine_tutorial_target: ${kind}`)],`engine_npc: tutorial-dummy\nengine_tutorial_target: ${kind}`);
  const final=(x,y,last=false)=>event(last?'毕业考核员 · 最终目标':'毕业考核员 · 前哨',x,y,{characterName:'Fronterworks-SF-1',characterIndex:3},[command(108,'engine_npc: tutorial-final')],`engine_npc: tutorial-final${last?'\nengine_tutorial_target: final':''}`);
  const tree=(x,y)=>object(4,0,1,2,x,y);
  const bench=(x,y)=>object(4,2,2,1,x,y);
  const lamp=(x,y)=>object(1,2,1,2,x,y);
  const building=(x,y,w,h,roof=5888,face=6272)=>{rect(x,y,w,h-3,roof);rect(x,y+h-3,w,3,face);for(let dx=1;dx<w-2;dx+=3)object(9,3,2,1,x+dx,y+h-3);};
  const workstation=(x,y)=>{put(x,y,2,83);for(const[dy,row]of[[1,[68,69]],[2,[76,77]],[3,[126,127]]])for(let dx=0;dx<2;dx++)put(x+dx,y+dy,2,row[dx]);put(x,y+1,3,50);put(x+1,y+1,3,51);put(x,y+3,3,82);put(x,y+4,2,90);};
  function finish() {
    const base=ground.map(t=>t||5888);
    if(indoor)for(let y=2;y<height;y++)for(let x=1;x<width-1;x++)if(ground[y*width+x]&&!ground[(y-1)*width+x]){base[(y-1)*width+x]=wall;if(!ground[(y-2)*width+x])base[(y-2)*width+x]=wall;}
    const same=(x,y,t)=>x<0||y<0||x>=width||y>=height?indoor&&t===5888:base[y*width+x]===t;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
      const t=base[y*width+x];if(t<2048){put(x,y,0,t);continue;}
      const l=same(x-1,y,t),r=same(x+1,y,t),u=same(x,y-1,t),d=same(x,y+1,t),kind=Math.floor((t-2048)/48);
      const wallTile=t>=4352&&(t<5888||Math.floor((kind-80)/8)%2===1);let shape;
      if(wallTile)shape=(!l?1:0)+(!u?2:0)+(!r?4:0)+(!d?8:0);
      else{const q=[!l?(!u?[0,2]:[0,4]):!u?[2,2]:!same(x-1,y-1,t)?[2,0]:[2,4],!r?(!u?[3,2]:[3,4]):!u?[1,2]:!same(x+1,y-1,t)?[3,0]:[1,4],!l?(!d?[0,5]:[0,3]):!d?[2,5]:!same(x-1,y+1,t)?[2,1]:[2,3],!r?(!d?[3,5]:[3,3]):!d?[1,5]:!same(x+1,y+1,t)?[3,1]:[1,3]];shape=FLOOR.findIndex(row=>JSON.stringify(row)===JSON.stringify(q));if(shape<0)throw Error(`Map ${id}: invalid autotile ${t}`);}
      put(x,y,0,t+shape);if(indoor&&ground[y*width+x]&&x>0&&!ground[y*width+x-1])put(x,y,4,5);
    }
    return map;
  }
  return {id,name,map,put,rect,object,event,service,guide,portal,checkpoint,dummy,final,tree,bench,lamp,building,workstation,finish};
}
const maps=[];
// The school-like outdoor course teaches actual steering. Water forces the two
// offset causeways; short planted islands then require alternating turns.
{
  const m=make(57,'ROSE 教室 · 机动水庭',32,24);maps.push(m);
  m.rect(0,0,32,24,2048);m.rect(1,1,9,22);m.rect(13,1,7,22);m.rect(23,1,8,22);
  m.rect(2,15,8,6,3584);m.rect(9,17,6,3,3584);m.rect(14,5,5,15,2864);
  m.rect(18,5,7,3,3584);m.rect(24,5,5,16,2864);m.rect(27,18,3,4,3584);
  m.rect(13,12,4,2,2048);m.rect(17,9,3,2,2048);
  m.rect(3,3,5,8,3008);m.rect(24,16,3,2,3008);
  m.bench(3,12);m.bench(25,3);m.lamp(8,15);m.lamp(24,5);m.lamp(27,18);
  for(const[x,y]of[[2,2],[8,3],[7,7],[2,9],[2,21],[16,2],[18,20],[24,1],[29,10],[29,21]])m.tree(x,y);
  m.guide(4,17);m.checkpoint('a',14,18);m.checkpoint('b',17,6);m.checkpoint('c',26,13);
  m.portal('武器训练馆',29,20,58,4,23,8);
  m.event('机动训练出口',28,21,{},[command(108,'Complete the three checkpoints before moving to the weapon hall.')],'',{priorityType:0});
}
// Six marked training aprons open onto a shared transverse concourse. Every
// target has five unobstructed tiles in front; the lesson never demands firing
// through another target or through decorative furniture.
{
  const m=make(58,'ROSE 教室 · 六式武器馆',36,27,{indoor:true,floor:3584,wall:6368});maps.push(m);
  m.rect(2,5,32,20);m.rect(3,23,3,3,3680);m.rect(31,23,3,3,3680);
  for(const x of [4,15,26]){m.rect(x,5,7,7,2864);m.rect(x,16,7,7,2864);m.rect(x+2,9,3,3,3632);m.rect(x+2,20,3,3,3632);}
  for(const x of [12,23]){m.rect(x,5,2,6,0);m.rect(x,16,2,6,0);}
  m.rect(2,12,32,3,3680);
  for(const x of [5,16,27])m.object(0,2,2,2,x,3);
  m.object(14,0,2,3,2,5);m.object(14,0,2,3,32,5);
  m.object(1,8,1,2,2,12);m.object(1,8,1,2,33,12);
  m.guide(4,21);
  for(const [kind,x,y,name]of[['unarmed',7,6,'拳脚训练员'],['slash',18,6,'劈斩训练员'],['throw',29,6,'投掷训练员'],['club',7,17,'钝击训练员'],['firearm',18,17,'枪械训练员'],['staff',29,17,'杖术训练员']])m.dummy(kind,x,y,name);
  m.portal('机动水庭',4,25,57,29,19,8);m.portal('搜刮工坊',33,24,59,4,18,8);
}
// Storage and fabrication have distinct rooms, joined by a broad handling aisle.
// The supply chest is reached at the end of the shelving row; the desk faces an
// open work apron so its service remains approachable from several directions.
{
  const m=make(59,'ROSE 教室 · 搜刮工坊',27,23,{indoor:true,floor:3584,wall:6368});maps.push(m);
  m.rect(2,5,11,15);m.rect(16,5,9,15);m.rect(10,10,10,4);m.rect(9,15,11,5);m.rect(3,18,3,4,3680);m.rect(23,18,2,4,3680);
  m.rect(2,5,11,9,2864);m.rect(16,5,9,8,3632);m.rect(3,15,21,5,3680);
  m.object(8,4,5,3,3,9,1);m.object(8,10,7,2,3,3,1);
  m.object(8,12,3,2,9,6,1);m.object(14,0,2,3,17,5);m.workstation(19,5);
  m.object(0,2,2,2,20,3);m.object(1,8,1,2,23,14);
  m.object(8,5,2,1,9,17,2);m.object(8,5,2,1,17,17,2);
  m.guide(5,16);
  m.event('教学物资箱',8,7,{characterName:'!Chest',characterIndex:0},[command(108,'engine_container: tutorial-supplies')],'engine_container: tutorial-supplies');
  m.service('合成教学台',20,10,'tutorialCraft',{characterName:'People1',characterIndex:6},['搜到材料后，在背包内选择配方完成制作。','不确定步骤时，找 ROSE 重播当前提示。']);
  m.portal('六式武器馆',4,21,58,32,23,8);m.portal('毕业演练庭',24,21,60,4,20,8);
}
// A compact final training yard changes from a wide south staging apron into a
// choice around a central practice building, then opens into the exit forecourt.
{
  const m=make(60,'ROSE 教室 · 毕业演练庭',32,25);maps.push(m);
  m.rect(0,0,32,25,5888);m.rect(1,3,30,21);m.rect(2,14,28,9,3584);m.rect(16,5,14,15,3728);m.rect(24,4,5,8,3680);
  m.building(9,7,6,7,5936,6320);m.object(14,11,1,1,12,13);
  m.building(18,0,12,5,5888,6272);m.object(14,11,1,1,27,4);
  m.rect(2,4,5,8,3008);m.rect(18,14,4,3,3008);m.rect(24,19,5,3,3008);
  m.bench(3,12);m.bench(26,16);m.lamp(7,15);m.lamp(16,6);m.lamp(29,6);
  for(const[x,y]of[[2,3],[6,6],[3,9],[17,12],[22,15],[25,21],[29,21]])m.tree(x,y);
  m.guide(5,19);m.final(13,18);m.final(24,9,true);
  m.service('毕业撤离信标',27,5,'tutorialExit',{characterName:'!Crystal',characterIndex:1},['最后的考核完成后，在这里领取毕业奖励。','首次通过会获得劈斩武器【红杀铁剑】。']);
  m.portal('搜刮工坊',4,23,59,24,19,8);
}

async function write(file,value) {
  const text=Array.isArray(value)?'[\n'+value.map(row=>JSON.stringify(row)).join(',\n')+'\n]\n':(()=>{const{data,events,...head}=value;return'{\n'+JSON.stringify(head).slice(1,-1)+',\n"data":'+JSON.stringify(data)+',\n"events":[\n'+events.map(row=>JSON.stringify(row)).join(',\n')+'\n]\n}\n';})();
  await fs.writeFile(path.join(root,file),text);
}
const infos=JSON.parse(await fs.readFile(path.join(root,'data/MapInfos.json'),'utf8'));
for(const m of maps){const filename=`data/Map${String(m.id).padStart(3,'0')}.json`;try{const old=JSON.parse(await fs.readFile(path.join(root,filename),'utf8'));if(!/engine_adventure: tutorial/.test(old.note))throw Error(`${filename} is occupied`);}catch(error){if(error.code!=='ENOENT')throw error;}await write(filename,m.finish());infos[m.id]={id:m.id,expanded:m.id===57,name:m.name,order:m.id,parentId:m.id===57?2:57,scrollX:0,scrollY:0};}
await write('data/MapInfos.json',infos);
const plaza=JSON.parse(await fs.readFile(path.join(root,'data/Map041.json'),'utf8'));
let entrance=plaza.events.find(event=>event&&/engine_service:\s*tutorialEntrance/.test(event.note));
if(!entrance){entrance={id:plaza.events.length};plaza.events.push(entrance);}
Object.assign(entrance,{name:'ROSE · 新手教学',note:'engine_service: tutorialEntrance',x:25,y:14,pages:[page(roseImage,[command(101,'ROSE',0,0,2),command(401,'嗨，我是 ROSE！新手训练营现在开课。'),command(401,'一起练移动、六类武器、搜刮和合成吧。'),command(401,'首次毕业还会得到【红杀铁剑】！')])]});
await write('data/Map041.json',plaza);
console.log(JSON.stringify({maps:maps.map(m=>({mapId:m.id,name:m.name,width:m.map.width,height:m.map.height,events:m.map.events.length-1})),entrance:{mapId:41,eventId:entrance.id,x:entrance.x,y:entrance.y}}));
