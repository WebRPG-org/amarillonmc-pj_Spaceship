// RM-native authoring helpers. Unknown fields remain on the cloned document.
export const clone=value=>structuredClone(value);
export function newPage(){return {conditions:{actorId:1,actorValid:false,itemId:1,itemValid:false,selfSwitchCh:'A',selfSwitchValid:false,switch1Id:1,switch1Valid:false,switch2Id:1,switch2Valid:false,variableId:1,variableValid:false,variableValue:0},directionFix:false,image:{characterIndex:0,characterName:'',direction:2,pattern:1,tileId:0},list:[{code:0,indent:0,parameters:[]}],moveFrequency:3,moveRoute:{list:[{code:0,parameters:[]}],repeat:true,skippable:false,wait:false},moveSpeed:3,moveType:0,priorityType:1,stepAnime:false,through:false,trigger:0,walkAnime:true};}
export function newEvent(map,position={x:0,y:0},type='blank',context={}){
  const id=Math.max(1,map.events.length),page=newPage(),event={id,name:`事件 ${id}`,x:position.x,y:position.y,note:'',pages:[page]};
  const names={dialogue:'对话',transfer:'传送点',npc:'NPC',structure:'可破坏结构',shop:'商店',container:'物资箱',meteorDisk:'回收目标',meteorExit:'撤离入口',instance:'副本入口'};
  event.name=names[type]||event.name;
  const command=(code,parameters)=>({code,indent:0,parameters});
  if(type==='dialogue')page.list=[command(101,['',0,0,2]),command(401,['你好。']),command(0,[])];
  if(type==='tool'){event.name=`实时工具 ${id}`;page.list=[command(108,['tool_range : 1']),command(408,['tool_duration : 10']),command(408,['tool_pose_duration : 18']),command(408,['tool_skill_id : 1']),command(408,['tool_area : square']),command(0,[])];}
  if(type==='transfer'){page.priorityType=0;page.trigger=1;page.list=[command(201,[0,context.mapId||1,position.x,position.y,0,0]),command(0,[])];}
  if(type==='npc')event.note=`engine_npc: ${Object.keys(context.gameplay?.npcs||{})[0]||'scavenger'}`;
  if(type==='structure')event.note=`engine_structure: ${Object.keys(context.gameplay?.structures||{})[0]||'wall'}`;
  if(type==='shop')event.note=`engine_shop: ${Object.keys(context.gameplay?.shops||{})[0]||'worldGeneral'}`;
  if(type==='container'){const key=Object.values(context.gameplay?.scenarios||{}).flatMap(s=>Object.keys(s.containerLoot||{}))[0];if(key)event.note=`engine_container: ${key}`;}
  if(['meteorDisk','meteorExit','instance'].includes(type))event.note=`engine_service: ${type}`;
  return event;
}
export function toolValue(page,key){const text=(page.list||[]).filter(c=>[108,408].includes(c.code)).map(c=>c.parameters?.[0]||'').join('\n');const line=text.split(/\r?\n/).find(s=>new RegExp(`^\\s*${key.replaceAll('_','[ _]')}\\s*(?::|$)`,'i').test(s));return line===undefined?undefined:line.includes(':')?line.slice(line.indexOf(':')+1).trim():true;}
export function setToolValue(page,key,value){
  if(!/^tool_(range|duration|pose_duration|skill_id|item_id|item_cost|area|projectile|disable_piercing)$/.test(key))throw new Error('未知工具属性');
  const pattern=new RegExp(`^\\s*${key.replaceAll('_','[ _]')}\\s*(?::.*)?$`,'i');let continuation=false;
  page.list=page.list.flatMap(c=>{if(![108,408].includes(c.code)){continuation=false;return[c];}if(c.code===108)continuation=false;const lines=String(c.parameters?.[0]||'').split(/\r?\n/).filter(line=>!pattern.test(line));if(!lines.length)return[];const next=clone(c);next.code=continuation?408:108;next.parameters[0]=lines.join('\n');continuation=true;return[next];});
  if(value!==false)page.list.unshift({code:108,indent:0,parameters:[value===true?key.replaceAll('_',' '):`${key} : ${value}`]});
}
export function eventTag(event,key){const text=[event.note||'',...(event.pages||[]).flatMap(p=>(p.list||[]).filter(c=>[108,408].includes(c.code)).map(c=>c.parameters?.[0]||''))].join('\n');const current=text.match(new RegExp(`(?:^|\\n)\\s*<?${key}\\s*:\\s*([\\w-]+)`, 'i'))?.[1];return current||(key==='engine_npc'?eventTag(event,'engine_enemy'):'');}
// Only tags the author explicitly changed are normalized. Other comments retain
// their original commands, including extension metadata and indentation.
export function setEventTag(event,key,value){
  if(!/^engine_(npc|structure|shop|container|service)$/.test(key))throw new Error('未知实体属性');
  const tag=new RegExp(`^\\s*<?${key==='engine_npc'?'(?:engine_npc|engine_enemy)':key}\\s*:[^\\r\\n]*>?\\s*$`,'i');
  event.note=String(event.note||'').split(/\r?\n/).filter(line=>!tag.test(line)).join('\n').trimEnd();
  if(value)event.note+=(event.note?'\n':'')+`${key}: ${value}`;
  for(const page of event.pages||[]){let continuation=false;page.list=page.list.flatMap(c=>{
    if(![108,408].includes(c.code)){continuation=false;return [c];}
    if(c.code===108)continuation=false;
    const lines=String(c.parameters?.[0]||'').split(/\r?\n/).filter(line=>!tag.test(line));
    if(!lines.length)return [];
    const result=clone(c);result.code=continuation?408:108;result.parameters[0]=lines.join('\n');continuation=true;return[result];
  });}
}
export const mapProperties=['displayName','tilesetId','width','height','scrollType','autoplayBgm','bgm','autoplayBgs','bgs','disableDashing','encounterStep','parallaxName','parallaxLoopX','parallaxLoopY','parallaxSx','parallaxSy','parallaxShow','battleback1Name','battleback2Name','specifyBattleback','note'];
export function mapPatch(original,draft){
  const properties={},tiles=[],events=[];
  for(const key of mapProperties)if(JSON.stringify(original[key])!==JSON.stringify(draft[key]))properties[key]=clone(draft[key]);
  for(let z=0;z<6;z++)for(let y=0;y<draft.height;y++)for(let x=0;x<draft.width;x++){
    const before=x<original.width&&y<original.height?original.data[(z*original.height+y)*original.width+x]||0:0,tileId=draft.data[(z*draft.height+y)*draft.width+x]||0;
    if(before!==tileId)tiles.push({x,y,z,tileId});
  }
  for(let id=1;id<Math.max(original.events.length,draft.events.length);id++){
    const before=original.events[id],after=draft.events[id];if(JSON.stringify(before??null)===JSON.stringify(after??null))continue;
    if(!after)events.push({id,remove:true});else events.push({id,name:after.name,x:after.x,y:after.y,note:after.note,pages:clone(after.pages),...(!before?{template:clone(after)}:{})});
  }
  return {properties,tiles,events};
}
