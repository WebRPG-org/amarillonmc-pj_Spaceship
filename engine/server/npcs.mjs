const number=(value,fallback)=>Number.isFinite(Number(value))?Number(value):fallback;
export const eventNotes=(raw,page)=>[raw.note||'',...(page?.list||[]).filter(c=>[108,408].includes(c.code)).map(c=>c.parameters?.[0]||'')].join('\n');

/** Real-time NPCs are independent of RPG Maker's turn-based enemy database. */
export function configureNpc(event,text,content) {
  const key=text.match(/engine_(?:npc|enemy)\s*:\s*([\w-]+)/i)?.[1],template=content.gameplay?.npcs?.[key];
  if(!template)return false;
  // enemyId remains a truthy compatibility flag for the existing navigation/UI.
  Object.assign(event,{npcKey:key,enemyId:-1,npcTemplate:structuredClone(template),noRespawn:template.respawnMs===0});
  resetNpc(event);return true;
}
export function resetNpc(event) {
  const template=event.npcTemplate;
  Object.assign(event,{name:template.name||event.name,hp:Math.max(1,number(template.hp,100)),mp:Math.max(0,number(template.mp,0)),stats:{atk:10,def:5,mat:10,mdf:5,agi:10,luk:10,...template.stats},states:[]});
  event.maxHp=event.hp;event.maxMp=event.mp;
}
export function configureStructure(event,text,content) {
  const key=text.match(/engine_structure\s*:\s*([\w-]+)/i)?.[1];if(!key)return false;
  const template=content.gameplay?.structures?.[key]||{};
  const hp=Math.max(1,number(template.hp,300));
  Object.assign(event,{structureKey:key,hp,maxHp:hp,enemyId:0,name:template.name||event.name});return true;
}
export function npcRewards(entity,content,random) {
  const template=entity.npcTemplate||content.database.Enemies?.[entity.enemyId]||{};
  const authored=entity.customDrops||template.drops;
  const drops=authored?authored.filter(d=>random()<Math.max(0,Math.min(1,number(d.chance,1)))).map(d=>({kind:d.kind,itemId:d.itemId,quantity:d.quantity||1,metadata:d.metadata||{}})):
    (template.dropItems||[]).filter(d=>d.kind&&d.dataId&&random()<1/(d.denominator||1)).map(d=>({kind:['','item','weapon','armor'][d.kind],itemId:d.dataId,quantity:1}));
  return {gold:Math.max(0,Math.floor(number(template.gold,0))),exp:Math.max(0,Math.floor(number(template.exp,0))),drops:drops.map(d=>({...d,mapId:entity.mapId,x:entity.x,y:entity.y}))};
}
