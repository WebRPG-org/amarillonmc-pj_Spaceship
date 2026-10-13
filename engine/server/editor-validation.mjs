import {assertSafeData} from './gameplay-content.mjs';

export const MAP_LIMIT=256;
export const EVENT_LIMIT=10000;
const fail=message=>Object.assign(new Error(message),{status:400});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function integer(value,min,max,label){if(!Number.isSafeInteger(value)||value<min||value>max)throw fail(`${label} 必须是 ${min}–${max} 的整数`);}
function string(value,max,label){if(typeof value!=='string'||value.length>max||value.includes('\0'))throw fail(`${label} 必须是最多 ${max} 字的文字`);}
function boolean(value,label){if(typeof value!=='boolean')throw fail(`${label} 必须是布尔值`);}
function keys(value,allowed){if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw fail('配置包含不允许修改的字段');}
export function validateAsset(value,label='素材名称'){string(value,240,label);if(value.includes('\\')||value.startsWith('/')||/[:\u0000-\u001f]/.test(value)||value.split('/').some(segment=>segment==='.'||segment==='..'))throw fail(`${label} 必须是工程内相对素材名称`);}
function audio(value,label){
  if(!object(value))throw fail(`${label} 配置无效`);validateAsset(value.name,`${label} 名称`);integer(value.pan,-100,100,`${label} 声像`);integer(value.pitch,50,150,`${label} 音调`);integer(value.volume,0,100,`${label} 音量`);
}
function jsonValue(value,depth=0,budget={nodes:0}){
  if(++budget.nodes>1500000||depth>24)throw fail('事件数据过大或嵌套过深');
  if(value===null||typeof value==='boolean')return;
  if(typeof value==='number'){if(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)throw fail('事件数字无效');return;}
  if(typeof value==='string'){string(value,100000,'事件文本');return;}
  if(Array.isArray(value)){if(value.length>20000)throw fail('事件数组过长');for(const item of value)jsonValue(item,depth+1,budget);return;}
  if(object(value)){if(Object.keys(value).length>2000)throw fail('事件对象字段过多');for(const item of Object.values(value))jsonValue(item,depth+1,budget);return;}
  throw fail('事件只接受 JSON 数据');
}
function commands(list,label,{route=false}={}){
  if(!Array.isArray(list)||list.length<1||list.length>20000)throw fail(`${label} 必须包含 1–20000 条指令`);
  for(const command of list){
    if(!object(command))throw fail(`${label} 指令无效`);integer(command.code,0,9999,`${label} 指令编号`);
    if(!route)integer(command.indent,0,100,`${label} 缩进`);
    if(!(route&&command.parameters===undefined)&&(!Array.isArray(command.parameters)||command.parameters.length>1000))throw fail(`${label} 指令参数无效`);
  }
  if(list.at(-1)?.code!==0)throw fail(`${label} 缺少末尾结束指令`);
}
export function validateEventImage(image){
  if(!object(image))throw fail('事件图像无效');
  validateAsset(image.characterName,'角色图名称');integer(image.characterIndex,0,7,'角色图索引');integer(image.tileId,0,8191,'事件图块');
  if(![2,4,6,8].includes(image.direction))throw fail('事件方向必须为 2、4、6、8');integer(image.pattern,0,2,'事件图像帧');
}
function moveRoute(route){
  if(!object(route))throw fail('移动路线无效');for(const key of ['repeat','skippable','wait'])boolean(route[key],`路线 ${key}`);commands(route.list,'移动路线',{route:true});
}
export function validateEventPages(pages){
  assertSafeData(pages);if(!Array.isArray(pages)||pages.length<1||pages.length>99)throw fail('事件须有 1–99 个页面');jsonValue(pages);
  for(const page of pages){
    if(!object(page)||!object(page.conditions))throw fail('事件页条件无效');
    const c=page.conditions;for(const key of ['actorValid','itemValid','selfSwitchValid','switch1Valid','switch2Valid','variableValid'])boolean(c[key],`条件 ${key}`);
    for(const key of ['actorId','itemId','switch1Id','switch2Id','variableId'])integer(c[key],1,999999,`条件 ${key}`);
    if(!['A','B','C','D'].includes(c.selfSwitchCh))throw fail('独立开关必须为 A、B、C、D');integer(c.variableValue,-999999999,999999999,'变量条件值');
    validateEventImage(page.image);commands(page.list,'事件页');moveRoute(page.moveRoute);
    integer(page.trigger,0,4,'触发条件');integer(page.priorityType,0,2,'优先级');integer(page.moveType,0,3,'移动类型');integer(page.moveSpeed,1,6,'移动速度');integer(page.moveFrequency,1,5,'移动频率');
    for(const key of ['directionFix','stepAnime','through','walkAnime'])boolean(page[key],`事件 ${key}`);
  }
  return pages;
}
export function validateEventTemplate(event,id){
  assertSafeData(event);jsonValue(event);if(!object(event)||event.id!==id)throw fail('事件模板 ID 必须与新事件 ID 相同');
  integer(event.id,1,EVENT_LIMIT,'事件模板 ID');string(event.name,200,'事件名称');string(event.note,16000,'事件备注');
  integer(event.x,0,MAP_LIMIT-1,'事件 X');integer(event.y,0,MAP_LIMIT-1,'事件 Y');validateEventPages(event.pages);
  return event;
}
export const MAP_PROPERTIES=['displayName','tilesetId','width','height','scrollType','autoplayBgm','bgm','autoplayBgs','bgs','disableDashing','encounterStep','parallaxName','parallaxLoopX','parallaxLoopY','parallaxSx','parallaxSy','parallaxShow','battleback1Name','battleback2Name','specifyBattleback','note'];
export function validateMapProperties(properties,content){
  keys(properties,MAP_PROPERTIES);assertSafeData(properties);
  for(const[key,value]of Object.entries(properties)){
    if(key==='width'||key==='height')integer(value,1,MAP_LIMIT,`地图 ${key}`);
    else if(key==='tilesetId'){integer(value,1,999999,'图块集');if(content?.database?.Tilesets&&!content.database.Tilesets[value])throw fail('图块集不存在');}
    else if(key==='displayName')string(value,200,'地图显示名称');
    else if(key==='note')string(value,64000,'地图备注');
    else if(key==='scrollType')integer(value,0,3,'循环类型');
    else if(key==='encounterStep')integer(value,0,9999,'遇敌步数');
    else if(key==='parallaxSx'||key==='parallaxSy')integer(value,-32,32,'远景滚动速度');
    else if(['parallaxName','battleback1Name','battleback2Name'].includes(key))validateAsset(value,key);
    else if(key==='bgm'||key==='bgs')audio(value,key);
    else boolean(value,key);
  }
}
export function resizeMapData(map,width,height){
  integer(width,1,MAP_LIMIT,'地图宽度');integer(height,1,MAP_LIMIT,'地图高度');
  const next=new Array(width*height*6).fill(0),oldSize=map.width*map.height,newSize=width*height;
  for(let z=0;z<6;z++)for(let y=0;y<Math.min(map.height,height);y++)for(let x=0;x<Math.min(map.width,width);x++)next[z*newSize+y*width+x]=map.data?.[z*oldSize+y*map.width+x]??0;
  return next;
}
export function applyMapPropertiesAndTiles(map,properties={},tiles=[],content){
  validateMapProperties(properties,content);
  const next=structuredClone(map),width=properties.width??map.width,height=properties.height??map.height;
  if(!Array.isArray(tiles)||tiles.length>MAP_LIMIT*MAP_LIMIT*6)throw fail('图块修改数量无效');
  if((tiles.length||width!==map.width||height!==map.height)&&(!Array.isArray(map.data)||map.data.length!==map.width*map.height*6))throw fail('原地图图块数据不是完整六层，请先修复源地图');
  if(width!==map.width||height!==map.height)next.data=resizeMapData(map,width,height);
  Object.assign(next,structuredClone(properties));
  for(const key of ['bgm','bgs'])if(properties[key])next[key]={...structuredClone(map[key]),...structuredClone(properties[key])};
  const size=width*height;
  for(const tile of tiles){keys(tile,['x','y','z','tileId']);integer(tile.x,0,width-1,'图块 X');integer(tile.y,0,height-1,'图块 Y');integer(tile.z,0,5,'图层');integer(tile.tileId,0,tile.z===4?15:tile.z===5?255:8191,'图块值');next.data[tile.z*size+tile.y*width+tile.x]=tile.tileId;}
  return next;
}
export function validateEventBounds(map){
  if(!Array.isArray(map.events)||map.events.length>EVENT_LIMIT+1)throw fail(`事件数量不可超过 ${EVENT_LIMIT}`);
  for(let id=1;id<map.events.length;id++){const event=map.events[id];if(!event)continue;if(event.id!==id)throw fail(`事件 ${id} 的 ID 与槽位不一致`);integer(event.x,0,map.width-1,`事件 ${id} X（请先移动或删除越界事件）`);integer(event.y,0,map.height-1,`事件 ${id} Y（请先移动或删除越界事件）`);}
}
export function newMapTemplate({width,height,tilesetId,name}){
  return{autoplayBgm:false,autoplayBgs:false,battleback1Name:'',battleback2Name:'',bgm:{name:'',pan:0,pitch:100,volume:90},bgs:{name:'',pan:0,pitch:100,volume:90},disableDashing:false,displayName:name,encounterList:[],encounterStep:30,height,note:'',parallaxLoopX:false,parallaxLoopY:false,parallaxName:'',parallaxShow:true,parallaxSx:0,parallaxSy:0,scrollType:0,specifyBattleback:false,tilesetId,width,data:new Array(width*height*6).fill(0),events:[null]};
}
