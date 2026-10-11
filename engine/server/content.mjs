import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {importWeaponProfiles} from './weapons.mjs';

const DATABASES = ['Actors', 'Classes', 'Skills', 'Items', 'Weapons', 'Armors', 'Enemies', 'Troops', 'States', 'Animations', 'Tilesets', 'CommonEvents', 'System'];
export const SUPPORTED_COMMANDS = new Set([0,101,102,108,111,112,113,115,117,118,119,121,122,123,124,125,126,127,128,129,135,201,203,205,211,212,213,214,216,221,222,223,224,225,230,231,232,233,234,235,236,241,242,243,244,245,246,249,250,251,261,311,312,313,314,315,316,317,318,319,320,321,322,323,324,325,401,402,403,404,408,411,412,413,505]);
const PRESENTATION = new Set([211,212,213,216,221,222,223,224,225,231,232,233,234,235,236,241,242,243,244,245,246,249,250,251,261,322,323]);
const ADAPTED_PLUGINS = /^(set_actor_(?:skill|item)|CraftingSystem|Composition|OpenNewWindow|force_damage|tool_turn_end|tool_collision|tool_position|chrono_mode)\b/i;

/** An allowlist, never an evaluator. The runtime must implement each accepted form. */
export function classifyScript(script) {
  const s = String(script).trim().replace(/;\s*$/, '');
  if (/Input\.|Galv\.|\.prototype\s*\.|\b(?:eval|require|fetch|process|globalThis|window|document)\b/.test(s)) return {status:'unsupported', reason:'Legacy browser/plugin or input script requires migration'};
  const patterns = [
    /^\$gameMap\.copyEventFromMapToRegion\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*(?:true|false))?\s*\)$/,
    /^\$gameMap\.copyEventFrom\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*(?:true|false))?\s*\)$/,
    /^\$gamePlayer\.(?:locate|reserveTransfer)\([\d\s,]+\)$/,
    /^\$gameActors\.actor\(\d+\)\.(?:learnSkill|forgetSkill|clearEquipments)\(\d*\)$/,
    /^\$gameParty\.initAllItems\(\)$/,
    /^\$gameMap\._interpreter\.wait\((?:\d+|\$gameVariables\.value\(\d+\))\)$/,
    /^this\.act\((?:\d+|\$gameVariables\.value\(\d+\))\)$/,
    /^\$gameMap\.event\(this\.eventId\(\)\)\.setDirection\((?:\d+|\$gameVariables\.value\(\d+\))\)$/,
    /^IAVRA\.EVENTPOPUP\.popup\(this\.eventId\(\),\s*"[^"\n]*",\s*\{[^{}]*\}\)$/
  ];
  return patterns.some(p=>p.test(s)) ? {status:'adapted'} : {status:'unsupported',reason:'Unrecognized JavaScript is preserved but never evaluated'};
}

export function classifyCommand(command) {
  if ([355,655].includes(command.code)) return classifyScript(command.parameters?.[0]);
  if (command.code === 356) {
    const name=command.parameters?.[0]||'';
    if(/^(force_damage|tool_turn_end|tool_collision|tool_position|chrono_mode)\b/.test(name))return{status:'limited',reason:'Replaced by server combat; standalone legacy command emits a diagnostic'};
    return ADAPTED_PLUGINS.test(name) ? {status:'adapted'} : {status:'unsupported',reason:'Plugin command has no server adapter'};
  }
  if (command.code === 357) return {status:'unsupported',reason:'MZ plugin command needs an explicit adapter'};
  if (command.code === 111 && command.parameters?.[0] === 12) return {status:'limited',reason:'Only allowlisted arithmetic/variable expressions; browser input conditions are not executable'};
  if (command.code === 122 && command.parameters?.[3] === 4) return {status:'limited',reason:'Restricted expression parser; no arbitrary JavaScript'};
  if (command.code === 205) return {status:'limited',reason:'Movement routes use server collision and supported route commands'};
  if ([129,315,316,317,319,321].includes(command.code))return{status:'limited',reason:'Adapted to one network player; party, experience curves and equipment slots differ from RPG Maker'};
  if (PRESENTATION.has(command.code)) return {status:'presentation',reason:'Forwarded as a presentation cue; client support is reported independently'};
  return SUPPORTED_COMMANDS.has(command.code) ? {status:'supported'} : {status:'unsupported',reason:'Event command is not implemented'};
}

function tags(text) {
  const out={};
  for (const line of String(text||'').split(/\r?\n/)) {
    const m=line.trim().match(/^([\w ]+?)(?:\s*:\s*(.*))?$/);
    if(m) out[m[1].trim().toLowerCase().replace(/\s+/g,'_')]=m[2]===undefined?true:m[2].trim();
  }
  return out;
}
const num=(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback;
const noteTool=(entry)=>num(String(entry?.note||'').match(/tool\s+id\s*:\s*(\d+)/i)?.[1]);

function importTools(maps,plugins,database) {
  const configured=num(plugins.find(p=>p.name==='MOG_ChronoEngine')?.parameters?.['Tool Map ID'],25);
  const tools=new Map(),skillTools=new Map(),itemTools=new Map(),weaponTools=new Map();
  for(const mapId of [...new Set([configured,25,27])]) {
    for(const event of maps.get(mapId)?.events||[]) {
      if(!event||tools.has(event.id)) continue;
      const page=event.pages?.[0];
      const meta=tags((page?.list||[]).filter(c=>[108,408].includes(c.code)).map(c=>c.parameters[0]).join('\n'));
      if(!Object.keys(meta).some(k=>k.startsWith('tool_')))continue;
      const skillId=num(meta.tool_skill_id),itemId=num(meta.tool_item_id),skill=database.Skills?.[skillId],item=database.Items?.[itemId];
      const tool={id:event.id,name:event.name,mapId,skillId,itemId,range:num(meta.tool_range,1),area:meta.tool_area||'square',position:meta.tool_position||'user',duration:num(meta.tool_duration,30)/60,durationFrames:num(meta.tool_duration,30),cooldown:Math.max(.15,num(meta.tool_pose_duration,20)/60),projectile:!!meta.tool_projectile,piercing:!meta.tool_disable_piercing,itemCost:num(meta.tool_item_cost),animationId:num((skill||item)?.animationId),damage:(skill||item)?.damage||null,meta,image:page?.image||{},route:page?.moveRoute||{},commands:page?.list||[]};
      tools.set(tool.id,tool);
      if(skillId&&!skillTools.has(skillId))skillTools.set(skillId,tool.id);
      if(itemId&&!itemTools.has(itemId))itemTools.set(itemId,tool.id);
    }
  }
  for(const [key,map] of [['Skills',skillTools],['Items',itemTools],['Weapons',weaponTools]]) for(const entry of database[key]||[])if(entry&&tools.has(noteTool(entry)))map.set(entry.id,noteTool(entry));
  return {tools,skillTools,itemTools,weaponTools};
}

function importRecipes(database,plugins,diagnostics) {
  const recipes=[],kindNames={i:'item',w:'weapon',a:'armor',c:'gold'};
  for(const [db,kind]of [['Items','item'],['Weapons','weapon'],['Armors','armor']])for(const item of database[db]||[]){
    if(!item)continue;
    const match=String(item.note||'').match(/<recipe>([\s\S]*?)<\/recipe>/i);if(!match)continue;
    const ingredients=[];
    for(const line of match[1].split(/\r?\n/)){
      const m=line.trim().match(/^([iwa]):\s*(\d+)\s*,\s*(\d+)/i),g=line.trim().match(/^c:\s*(\d+)/i);
      if(m)ingredients.push({kind:kindNames[m[1].toLowerCase()],itemId:+m[2],amount:+m[3]});
      else if(g)ingredients.push({kind:'gold',itemId:0,amount:+g[1]});
      else if(line.trim())diagnostics.push({source:`${db}:${item.id}`,reason:`Unknown recipe line: ${line}`});
    }
    if(ingredients.length)recipes.push({id:`${kind}:${item.id}`,name:item.name,source:'CraftingSystem',result:{kind,itemId:item.id,amount:1},ingredients,books:[]});
  }
  for(const book of database.Items||[]){
    const m=String(book?.note||'').match(/<recipe_book>([\s\S]*?)<\/recipe_book>/i);if(!m)continue;
    const category=num(m[1].match(/category:\s*(\d+)/i)?.[1]);
    for(const line of m[1].split(/\r?\n/)) {const x=line.match(/^\s*([iwa]):\s*([\d,\s]+)/i);if(x)for(const id of x[2].split(',').map(Number)){const recipe=recipes.find(r=>r.id===`${kindNames[x[1].toLowerCase()]}:${id}`);if(recipe){recipe.books.push(book.id);recipe.category=category;}}}
  }
  const kj=plugins.find(p=>p.name==='KJ_Composition')?.parameters?.Recipes;
  if(kj)try{for(const raw of JSON.parse(kj)){
    const r=typeof raw==='string'?JSON.parse(raw):raw;
    const entries=[];
    for(let i=0;i<10;i++){if(!r[`item${i}`])continue;const v=typeof r[`item${i}`]==='string'?JSON.parse(r[`item${i}`]):r[`item${i}`];for(const kind of ['item','weapon','armor'])if(num(v[kind])>0)entries.push({kind,itemId:+v[kind],amount:1});}
    if(entries.length>1)recipes.push({id:`composition:${recipes.length+1}`,name:r.name,source:'KJ_Composition',result:entries[0],ingredients:entries.slice(1),level:num(r.level),maxNumber:num(r.maxNumber),books:[]});
  }}catch(error){diagnostics.push({source:'KJ_Composition',reason:`Recipe parsing failed: ${error.message}`});}
  return recipes;
}

function coverageFor(map,source) {
  const report={source,mapId:map.id,events:0,pages:0,commands:0,counts:{},statuses:{},scripts:[],plugins:[],diagnostics:[],quarantinedPages:[]};
  for(const event of map.events||[]){if(!event)continue;report.events++;for(let pageIndex=0;pageIndex<(event.pages||[]).length;pageIndex++){
    const page=event.pages[pageIndex],location={eventId:event.id,page:pageIndex+1};report.pages++;
    // These old networking templates use shared scalar variables as an unreliable command bus.
    if(map.id===26 || (map.id===29&&(page.list||[]).some(c=>/Input\.isTriggered|Galv\./.test(String(c.parameters?.[0]))))){page.engineDisabledReason='Legacy PvP/shared-variable network template replaced by server entities';report.quarantinedPages.push({...location,reason:page.engineDisabledReason});}
    for(let index=0;index<(page.list||[]).length;index++){
      const command=page.list[index],result=classifyCommand(command);report.commands++;report.counts[command.code]=(report.counts[command.code]||0)+1;report.statuses[result.status]=(report.statuses[result.status]||0)+1;
      const entry={...location,index,code:command.code,...result};
      if([355,655].includes(command.code))report.scripts.push({...entry,text:command.parameters[0]});
      if([356,357].includes(command.code))report.plugins.push({...entry,parameters:command.parameters});
      if(result.status==='unsupported'||result.status==='limited')report.diagnostics.push(entry);
      if(command.code===205)for(const route of command.parameters?.[1]?.list||[])if(route.code===45)report.scripts.push({...location,index,code:45,...classifyScript(route.parameters?.[0]),text:route.parameters?.[0]});
    }
    for(const route of page.moveRoute?.list||[])if(route.code===45)report.scripts.push({...location,code:45,...classifyScript(route.parameters?.[0]),text:route.parameters?.[0]});
  }}
  return report;
}

export async function loadContent(projectRoot) {
  const dataDir=path.join(projectRoot,'data'),files=await readdir(dataDir),database={},maps=new Map(),diagnostics=[];
  await Promise.all(DATABASES.map(async key=>{try{database[key]=JSON.parse(await readFile(path.join(dataDir,`${key}.json`),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;database[key]=key==='System'?{}:[];diagnostics.push({source:key,reason:'Database file is missing'});}}));
  for(const file of files.filter(f=>/^Map\d+\.json$/i.test(f)).sort()) {const raw=JSON.parse(await readFile(path.join(dataDir,file),'utf8'));raw.id=Number(file.match(/\d+/)[0]);maps.set(raw.id,raw);}
  const mapInfos=JSON.parse(await readFile(path.join(dataDir,'MapInfos.json'),'utf8'));
  let plugins=[];
  try{
    const source=await readFile(path.join(projectRoot,'js','plugins.js'),'utf8');
    // RPG Maker writes a JSON array. Parse just that data, never execute even a VM script.
    const match=source.match(/\bvar\s+\$plugins\s*=\s*([\s\S]*);\s*$/);
    if(!match)throw new Error('Expected RPG Maker JSON plugin declaration');
    plugins=JSON.parse(match[1]);
  }catch(error){diagnostics.push({source:'js/plugins.js',reason:error.message});}
  const imported=importTools(maps,plugins,database),recipes=importRecipes(database,plugins,diagnostics),weaponProfiles=importWeaponProfiles(database);
  const mapCoverage=[...maps.values()].map(map=>coverageFor(map,`Map${String(map.id).padStart(3,'0')}.json`));
  const commonCoverage=coverageFor({events:(database.CommonEvents||[]).filter(Boolean).map(e=>({...e,pages:[{list:e.list}]}))},'CommonEvents.json');
  const troopCoverage=coverageFor({events:database.Troops||[]},'Troops.json');
  const coverage={maps:mapCoverage,commonEvents:commonCoverage,troops:troopCoverage,diagnostics,summary:{maps:maps.size,events:mapCoverage.reduce((n,m)=>n+m.events,0),pages:mapCoverage.reduce((n,m)=>n+m.pages,0),plugins:plugins.filter(p=>p.status).length,tools:imported.tools.size,recipes:recipes.length},semantics:{switches:'personal by default; configured shared switches are server-owned',variables:'personal by default; world/round variables require explicit server APIs',selfSwitches:'personal per map/event; server entities own shared state',scripts:'restricted adapters only, no eval',parallel:'bounded server tasks; legacy PvP templates quarantined'}};
  const getMap=id=>maps.get(Number(id));
  const getTileset=mapId=>database.Tilesets?.[getMap(mapId)?.tilesetId];
  function inside(map,x,y){return Number.isInteger(x)&&Number.isInteger(y)&&x>=0&&y>=0&&x<map.width&&y<map.height;}
  function tilePass(map,x,y,bit){
    if(!inside(map,x,y))return false;
    const flags=getTileset(map.id)?.flags||[],size=map.width*map.height;
    for(let z=3;z>=0;z--){const tile=map.data?.[z*size+y*map.width+x]||0,flag=flags[tile]||0;if(flag&0x10)continue;if((flag&bit)===0)return true;if((flag&bit)===bit)return false;}
    return false;
  }
  function isPassable(mapId,x,y,direction){
    const map=getMap(mapId),delta={2:[0,1],4:[-1,0],6:[1,0],8:[0,-1]}[direction];if(!map||!delta||!inside(map,x,y))return false;
    const target=wrapPosition(mapId,x+delta[0],y+delta[1]);
    return tilePass(map,x,y,1<<(direction/2-1))&&tilePass(map,target.x,target.y,1<<((10-direction)/2-1));
  }
  function wrapPosition(mapId,x,y){const m=getMap(mapId);if(!m)return{x,y};if([2,3].includes(m.scrollType))x=(x%m.width+m.width)%m.width;if([1,3].includes(m.scrollType))y=(y%m.height+m.height)%m.height;return{x,y};}
  function findSpawn(mapId,x=0,y=0){const map=getMap(mapId);if(!map)return null;x=Math.max(0,Math.min(map.width-1,Math.floor(num(x))));y=Math.max(0,Math.min(map.height-1,Math.floor(num(y))));const seen=new Set(),queue=[[x,y]];for(let i=0;i<queue.length;i++){const [cx,cy]=queue[i],key=`${cx},${cy}`;if(seen.has(key)||!inside(map,cx,cy))continue;seen.add(key);if([2,4,6,8].some(d=>isPassable(mapId,cx,cy,d)))return{x:cx,y:cy};for(const [dx,dy]of [[0,1],[-1,0],[1,0],[0,-1]])queue.push([cx+dx,cy+dy]);}return null;}
  return {version:1,projectRoot,maps,mapInfos,database,plugins,recipes,weaponProfiles,...imported,coverage,getMap,getTileset,isPassable,findSpawn,wrapPosition,getTool:id=>imported.tools.get(Number(id)),getSkillToolId:id=>imported.skillTools.get(Number(id)),getToolForSkill:id=>imported.tools.get(imported.skillTools.get(Number(id))),getRecipe:id=>recipes.find(r=>r.id===id),describeMap:id=>mapCoverage.find(m=>m.mapId===Number(id))};
}
