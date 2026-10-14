import {randomUUID} from 'node:crypto';

/** Data-only weapon rules authored in the RPG Maker weapon note field. */
export function importWeaponProfiles(database) {
  const profiles=new Map();
  for(const weapon of database.Weapons||[]) {
    const match=String(weapon?.note||'').match(/<serverWeapon>([\s\S]*?)<\/serverWeapon>/i);
    if(!match)continue;
    const value=JSON.parse(match[1]);
    if(!['throw','firearm','staff','club','cleave'].includes(value.mode))throw new Error(`Invalid weapon mode: ${weapon.id}`);
    const profile={...value,weaponId:weapon.id,projectile:!['club','cleave'].includes(value.mode)};
    for(const key of ['skillId','toolId','range','maxDurability','durabilityCost','ammoItemId','ammoCost','mpCost']) {
      profile[key]=Number(value[key]||0);
      if(!Number.isSafeInteger(profile[key])||profile[key]<0)throw new Error(`Invalid weapon ${weapon.id} ${key}`);
    }
    if(!database.Skills[profile.skillId]||profile.range<1||profile.range>20||profile.durabilityCost>profile.maxDurability)throw new Error(`Invalid weapon ${weapon.id} attack`);
    if(profile.ammoCost&&!database.Items[profile.ammoItemId])throw new Error(`Invalid weapon ${weapon.id} ammunition`);
    profile.movementSpeed=Number(value.movementSpeed??1);
    if(!Number.isFinite(profile.movementSpeed)||profile.movementSpeed<=0||profile.movementSpeed>1)throw new Error(`Invalid weapon ${weapon.id} movementSpeed`);
    if(profile.mode==='cleave'&&profile.range!==1)throw new Error(`Invalid weapon ${weapon.id} cleave range`);
    profiles.set(weapon.id,profile);
  }
  return profiles;
}

/** Old stacks become individual identities once, then retain their own wear. */
export function normalizeWeapons(state,profiles=new Map()) {
  const next=[],seen=new Set();
  for(const entry of state.inventory||[]) {
    if(entry.kind!=='weapon'){next.push(entry);continue;}
    for(let n=0;n<entry.quantity;n++) {
      const item={...entry,quantity:1};
      if(n||typeof item.instanceId!=='string'||seen.has(item.instanceId))item.instanceId=randomUUID();
      seen.add(item.instanceId);
      const profile=profiles.get(item.itemId);
      if(profile?.maxDurability){item.maxDurability=profile.maxDurability;item.durability=Number.isSafeInteger(item.durability)?Math.max(0,Math.min(item.maxDurability,item.durability)):item.maxDurability;}
      next.push(item);
    }
  }
  state.inventory=next;state.equips||={};
  const equipped=next.find(i=>i.kind==='weapon'&&i.itemId===state.equips.weapon&&i.instanceId===state.equips.weaponInstanceId)||next.find(i=>i.kind==='weapon'&&i.itemId===state.equips.weapon);
  state.equips.weaponInstanceId=equipped?.instanceId||null;
  return state;
}

export const equippedWeapon=state=>state.inventory?.find(i=>i.kind==='weapon'&&i.itemId===state.equips?.weapon&&i.instanceId===state.equips?.weaponInstanceId);

/** A multiplier applies only to an owned, actually equipped weapon instance. */
export const weaponMovementSpeed=(content,state)=>equippedWeapon(state)?content.weaponProfiles?.get(state.equips?.weapon)?.movementSpeed??1:1;

/** Three neighboring tiles across the row immediately in front of the wielder. */
export function cleaveTiles(source){
  const [dx,dy]=({2:[0,1],4:[-1,0],6:[1,0],8:[0,-1]})[source.direction]||[0,1];
  return [-1,0,1].map(side=>({x:source.x+dx+dy*side,y:source.y+dy-dx*side}));
}

export function weaponAttack(content,state,requestedSkillId) {
  const profile=content.weaponProfiles?.get(state.equips?.weapon);
  const restricted=[...(content.weaponProfiles?.values()||[])].find(p=>p.skillId===requestedSkillId);
  if(restricted&&restricted!==profile)throw new Error('该攻击需要装备对应武器');
  const useWeapon=profile&&(requestedSkillId===1||requestedSkillId===profile.skillId);
  if(useWeapon&&!equippedWeapon(state))throw new Error('没有装备这件武器');
  const skillId=useWeapon?profile.skillId:requestedSkillId;
  const skill=content.database.Skills[skillId];
  const tool=useWeapon?content.getTool(profile.toolId):requestedSkillId===1?content.getTool(content.weaponTools.get(state.equips?.weapon))||content.getToolForSkill(1):content.getToolForSkill(skillId);
  return {profile:useWeapon?profile:null,skill,tool};
}

export function consumeAttackCost(state,{profile,skill,tool}) {
  const mpCost=profile?.mpCost??(skill.mpCost||0);
  if((state.mp||0)<mpCost)throw new Error('MP 不足');
  const weapon=profile?equippedWeapon(state):null;
  if(profile?.durabilityCost&&(!weapon||weapon.durability<profile.durabilityCost))throw new Error('武器耐久不足，请更换武器');
  const ammoItemId=profile?.ammoItemId||tool?.itemCost,ammoCost=profile?.ammoCost||(tool?.itemCost?1:0);
  const ammo=ammoCost?state.inventory.find(i=>i.kind==='item'&&i.itemId===ammoItemId):null;
  if(ammoCost&&(!ammo||ammo.quantity<ammoCost))throw new Error('弹药不足');
  state.mp-=mpCost;
  if(profile?.durabilityCost)weapon.durability-=profile.durabilityCost;
  if(ammoCost){ammo.quantity-=ammoCost;state.inventory=state.inventory.filter(i=>i.quantity>0);}
  return {mpCost,durabilityCost:profile?.durabilityCost||0,ammoItemId:ammoItemId||0,ammoCost,weaponInstanceId:weapon?.instanceId||null};
}
