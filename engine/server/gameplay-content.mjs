import {readFile} from 'node:fs/promises';
import path from 'node:path';

export const EMPTY_GAMEPLAY=Object.freeze({version:1,scenarios:{},titles:{},shops:{},npcs:{},structures:{}});
export async function loadGameplay(projectRoot){
  try{return JSON.parse(await readFile(path.join(projectRoot,'engine','content','gameplay.json'),'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;return structuredClone(EMPTY_GAMEPLAY);}
}

const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
function integer(value,min,max,label){if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`${label} 必须是 ${min}–${max} 的整数`);}
function text(value,max,label){if(typeof value!=='string'||value.length>max)throw new Error(`${label} 必须是最多 ${max} 字的文字`);}
export function assertSafeData(value,depth=0){
  if(depth>24)throw new Error('配置嵌套过深');
  if(value&&typeof value==='object')for(const[key,child]of Object.entries(value)){if(['__proto__','prototype','constructor'].includes(key))throw new Error('不允许的配置键');assertSafeData(child,depth+1);}
}

/** Validate authored rules without rewriting unknown fields from future versions. */
export function validateGameplay(value,content){
  assertSafeData(value);if(!object(value)||value.version!==1)throw new Error('仅支持 version: 1');
  const maps=content?.maps,db=content?.database;
  const mapId=(id,label)=>{integer(id,1,999999,label);if(maps&&!maps.has(id))throw new Error(`${label} 的地图不存在：${id}`);};
  const item=(entry,label)=>{
    if(!object(entry)||!['item','weapon','armor'].includes(entry.kind))throw new Error(`${label} 的物品类型无效`);
    integer(entry.itemId,1,999999,label);const table={item:'Items',weapon:'Weapons',armor:'Armors'}[entry.kind];
    if(db&&!db[table]?.[entry.itemId])throw new Error(`${label} 的物品不存在：${entry.itemId}`);
    if(entry.quantity!==undefined)integer(entry.quantity,1,999999,label);
  };
  for(const group of ['scenarios','titles','shops','npcs','structures'])if(value[group]!==undefined&&!object(value[group]))throw new Error(`${group} 必须是对象`);
  for(const[id,s]of Object.entries(value.scenarios||{})){
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id)||!object(s))throw new Error('副本标识无效');
    if(s.id!==undefined&&s.id!==id)throw new Error('副本 id 必须与对象标识相同');
    text(s.name,120,'副本名称');if(!['dts','adventure'].includes(s.type))throw new Error('副本类型无效');
    if(!Array.isArray(s.mapIds)||!s.mapIds.length||s.mapIds.length>500)throw new Error('副本地图不能为空');
    s.mapIds.forEach(id=>mapId(id,'副本地图'));
    if(s.type==='dts'&&[11,12,13,20,21,22].some(id=>!s.mapIds.includes(id)))throw new Error('当前 DTS 模板必须包含 11、12、13、20、21、22 六张核心地图；可另外添加扩展地图');
    if(!object(s.spawn))throw new Error('副本缺少出生点');mapId(s.spawn.mapId,'出生地图');
    if(!s.mapIds.includes(s.spawn.mapId))throw new Error('出生地图必须属于副本');
    for(const key of ['x','y'])integer(s.spawn[key],0,9999,`出生点 ${key}`);
    const map=maps?.get(s.spawn.mapId);if(map&&(s.spawn.x>=map.width||s.spawn.y>=map.height))throw new Error('出生点超出地图');
    integer(s.maxPlayers,1,64,'最大人数');integer(s.durationSeconds,1,86400,'副本时限');
    if(s.outdoorMapIds!==undefined&&(!Array.isArray(s.outdoorMapIds)||s.outdoorMapIds.some(id=>!s.mapIds.includes(id))))throw new Error('室外地图必须属于副本');
    if(s.allowedTitles!==undefined&&(!Array.isArray(s.allowedTitles)||s.allowedTitles.some(id=>!value.titles?.[id])))throw new Error('允许头衔包含不存在的头衔');
    if(s.reward?.titleId&&!value.titles?.[s.reward.titleId])throw new Error('奖励头衔不存在');
    if(s.diskItemId!==undefined)item({kind:'item',itemId:s.diskItemId},'目标磁盘');
    if(s.reward?.gold!==undefined)integer(s.reward.gold,0,999999999,'奖励金钱');
    for(const entry of s.reward?.items||[]){item(entry,'奖励物品');integer(entry.quantity,1,999999,'奖励数量');}
    if(s.containerLoot!==undefined){
      if(!object(s.containerLoot))throw new Error('箱子模板必须是对象');
      for(const[key,entries]of Object.entries(s.containerLoot)){if(!/^[A-Za-z0-9_-]{1,80}$/.test(key)||!Array.isArray(entries)||entries.length>1000)throw new Error('箱子模板无效');for(const entry of entries){item(entry,'箱子物品');integer(entry.quantity,1,999999,'箱子数量');}}
    }
    if(s.meteor)for(const key of ['intervalMs','warningMs','damage'])integer(s.meteor[key],1,key==='damage'?999999:3600000,`陨石 ${key}`);
    if(s.meteorWeapon)for(const key of ['delayMs','mpMultiplier'])integer(s.meteorWeapon[key],1,3600000,`流星武器 ${key}`);
    if(s.initialState){
      if(s.initialState.level!==undefined)integer(s.initialState.level,1,999,'初始等级');
      if(s.initialState.gold!==undefined)integer(s.initialState.gold,0,999999999,'初始金钱');
      if(s.initialState.classId!==undefined){integer(s.initialState.classId,1,999999,'初始职业');if(db&&!db.Classes?.[s.initialState.classId])throw new Error('初始职业不存在');}
      for(const i of s.initialState.inventory||[]){item(i,'初始物品');integer(i.quantity,1,999999,'初始物品数量');}
      for(const skillId of s.initialState.skills||[]){integer(skillId,1,999999,'初始技能');if(db&&!db.Skills?.[skillId])throw new Error('初始技能不存在');}
      for(const kind of ['weapon','armor']){const id=s.initialState.equips?.[kind];if(id!==undefined&&id!==0)item({kind,itemId:id},'初始装备');}
    }
  }
  for(const t of Object.values(value.titles||{})){text(t.name,120,'头衔名称');if(t.description!==undefined)text(t.description,4000,'头衔说明');if(t.weaponId!==undefined)item({kind:'weapon',itemId:t.weaponId},'头衔武器');}
  for(const shop of Object.values(value.shops||{})){
    text(shop.name,120,'商店名称');mapId(shop.mapId,'商店地图');if(shop.eventId!==undefined)integer(shop.eventId,1,999999,'商店事件');
    if(!Array.isArray(shop.goods)||shop.goods.length>1000)throw new Error('商品列表无效');
    for(const good of shop.goods){item(good,'商品');integer(good.price,0,999999999,'商品价格');}
    if(shop.scope!==undefined&&!['world','dts'].includes(shop.scope))throw new Error('商店作用域无效');
    if(shop.buyOnly!==undefined&&typeof shop.buyOnly!=='boolean')throw new Error('仅购买必须是布尔值');
    if(shop.sellRate!==undefined&&(!Number.isFinite(shop.sellRate)||shop.sellRate<0||shop.sellRate>1))throw new Error('回收比例必须为 0–1');
  }
  for(const npc of Object.values(value.npcs||{})){
    text(npc.name,120,'NPC 名称');integer(npc.hp,1,99999999,'NPC HP');
    for(const key of ['mp','gold','exp'])if(npc[key]!==undefined)integer(npc[key],0,99999999,`NPC ${key}`);
    for(const[key,n]of Object.entries(npc.stats||{})){if(!['atk','def','mat','mdf','agi','luk'].includes(key))continue;integer(n,0,999999,`NPC ${key}`);}
    for(const drop of npc.drops||[]){item(drop,'掉落');if(!Number.isFinite(drop.chance)||drop.chance<0||drop.chance>1)throw new Error('掉落概率必须为 0–1');}
  }
  for(const structure of Object.values(value.structures||{}))integer(structure.hp,1,99999999,'结构耐久');
  return value;
}
