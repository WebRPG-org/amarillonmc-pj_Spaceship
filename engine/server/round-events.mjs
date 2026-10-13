import {classifyCommand,classifyScript} from './content.mjs';
import {eventNotes,eventTags,npcTag} from './event-tags.mjs';

const legacyCombat=/\b(?:force_damage|tool_turn_end|tool_collision|tool_position|chrono_mode)\b|\bthis\.act\s*\(/i;
function scriptReason(source,content){
  if(legacyCombat.test(source))return '旧 Chrono 战斗脚本须迁移为服务器实体';
  const copy=source.match(/\$gameMap\.copyEventFrom(?:MapToRegion)?\(\s*(\d+)\s*,\s*(\d+)/);
  if(copy){const mapId=Number(copy[1]),event=content.getMap(mapId)?.events?.[Number(copy[2])];if([25,26,27,29].includes(mapId)||event?.pages?.every(page=>page.engineDisabledReason))return '旧战斗／联网模板复制已隔离';}
  const status=classifyScript(source);return status.status==='unsupported'?status.reason:null;
}
/** Keep native authoring intact. A quarantined page is visible and diagnosable, never partly executed. */
export function prepareRoundEvents(content,scenario){
  const commonEvents=structuredClone(content.database.CommonEvents||[]),maps=new Map(),commonReasons=new Map();
  function commonReason(id,visiting=new Set()){
    if(commonReasons.has(id))return commonReasons.get(id);
    const event=commonEvents[id];if(!event)return `公共事件 ${id} 不存在`;
    if(visiting.has(id))return null; // The interpreter's bounded stack handles recursive native calls.
    const reason=event.engineDisabledReason||listReason(event.list||[],new Set([...visiting,id]));
    if(reason)event.engineDisabledReason=`公共事件 ${id}：${reason}`;
    if(reason)commonReasons.set(id,reason);return reason;
  }
  function routeReason(route){
    for(const command of route?.list||[]){if(command.code>45)return `移动路线指令 ${command.code} 尚未实现`;if(command.code===45){const reason=scriptReason(String(command.parameters?.[0]||''),content);if(reason)return reason;}}
    return null;
  }
  function listReason(list,visiting=new Set()){
    for(let index=0;index<list.length;index++){
      const command=list[index],p=command.parameters||[];
      if(command.code===355){let source=String(p[0]||'');while(list[index+1]?.code===655)source+='\n'+list[++index].parameters?.[0];const reason=scriptReason(source,content);if(reason)return reason;continue;}
      if(command.code===356&&legacyCombat.test(String(p[0])))return '旧 Chrono 战斗指令须迁移为服务器实体';
      if(command.code===201&&p[0]===0&&!scenario.mapIds.includes(p[1]))return `传送目标地图 ${p[1]} 不属于当前副本，请改用副本出口`;
      if(command.code===205){const reason=routeReason(p[1]);if(reason)return reason;}
      if(command.code===117){const reason=commonReason(p[0],visiting);if(reason)return `调用公共事件 ${p[0]}：${reason}`;}
      const status=classifyCommand(command);if(status.status==='unsupported')return `指令 ${command.code}：${status.reason}`;
    }
    return null;
  }
  for(const event of commonEvents)if(event)commonReason(event.id);
  for(const id of scenario.mapIds){
    const original=content.getMap(id);if(!original)throw new Error(`副本地图 ${id} 不存在`);
    const map=structuredClone(original);
    for(const event of map.events.filter(Boolean))for(const[index,page]of event.pages.entries()){
      const native=npcTag(eventTags(event,page));
      const reason=page.engineDisabledReason||(!native&&/\benemy_id\s*:\s*\d+/i.test(eventNotes(event,page))?'旧 RM 战斗敌人须迁移为实时 NPC':null)||routeReason(page.moveRoute)||listReason(page.list||[]);
      if(reason)page.engineDisabledReason=`地图 ${id} 事件 ${event.id} 第 ${index+1} 页：${reason}`;
    }
    maps.set(id,map);
  }
  return {...content,database:{...content.database,CommonEvents:commonEvents},maps,getMap:id=>maps.get(Number(id))};
}
