import {randomUUID} from 'node:crypto';
import {equippedWeapon} from './weapons.mjs';

export const METEOR_WEAPON_ID=65,METEOR_SKILL_ID=305;
const positive=(value,fallback)=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):fallback;
export const insideMeteor=(entity,x,y)=>Math.abs(entity.x-x)<=1&&Math.abs(entity.y-y)<=1;

/** Uses the authoritative clock; queued strikes continue even on an empty map. */
export class HazardRuntime {
  constructor(world){this.world=world;this.strikes=new Map();this.channels=new Map();this.nextWeather=world.now+5000;}
  outdoor(mapId){return this.world.scenario?.outdoorMapIds?.includes(Number(mapId))===true;}
  supportsWeapon(){return this.world.scenario?.allowedTitles?.includes('meteor')===true;}
  validateWeapon(player) {
    if(!this.supportsWeapon())throw new Error('本副本不支持飞火流星');
    if(player.equips?.weapon!==METEOR_WEAPON_ID||equippedWeapon(player)?.itemId!==METEOR_WEAPON_ID)throw new Error('需要装备飞火流星');
    if(!this.outdoor(player.mapId))throw new Error('飞火流星只能在室外发动');
    if(this.channels.has(player.id))throw new Error('飞火流星正在引导中');
    if(!(player.mp>0))throw new Error('MP 不足');
  }
  start(player,mpCost){
    const delayMs=positive(this.world.scenario?.meteorWeapon?.delayMs,10000);
    this.channels.set(player.id,{id:randomUUID(),ownerId:player.id,startedAt:this.world.now,impactAt:this.world.now+delayMs,mpCost});
    this.world.notice(player,`飞火流星引导开始：消耗 ${mpCost} MP，${delayMs/1000} 秒后在你届时的位置落下，包含自身及友方。死亡或进入室内会取消。`);
  }
  cancel(player,reason=''){
    // Also invalidates an in-flight MP transaction whose channel is not live yet.
    player._meteorCancellation=(player._meteorCancellation||0)+1;
    if(!this.channels.delete(player.id))return false;
    if(reason)this.world.notice(player,`飞火流星已取消：${reason}。消耗的 MP 不返还。`);
    return true;
  }
  strike({mapId,x,y,damage,ownerId=null,animationId=123,structures=ownerId===null}) {
    const world=this.world,map=world.maps.get(mapId);if(!map)return;
    // Snapshot recipients before self damage can trigger asynchronous settlement.
    const targets=[...world.players.values()].filter(p=>p.mapId===mapId&&!p.dead&&!p._dying&&!p._transferring&&insideMeteor(p,x,y))
      .concat([...map.events.values()].filter(e=>(e.enemyId||structures&&e.structureKey)&&!e.dead&&!e.erased&&insideMeteor(e,x,y)));
    const owner=ownerId?world.players.get(ownerId):null;
    world.broadcast(mapId,{type:'effect',kind:'meteor',x,y,animationId,radius:1});
    for(const target of targets){
      world.broadcast(mapId,{type:'effect',kind:'damage',x:target.x,y:target.y,value:damage,targetId:target.id});
      world.damage(target,damage,owner||null);
    }
  }
  update(){
    const world=this.world,now=world.now;
    for(const [id,channel] of this.channels){
      const player=world.players.get(id);
      if(!player||player.dead||player._dying||player._transferring){this.channels.delete(id);continue;}
      if(!this.outdoor(player.mapId)){this.cancel(player,'已进入室内');continue;}
      if(now>=channel.impactAt){
        this.channels.delete(id);
        this.strike({mapId:player.mapId,x:player.x,y:player.y,ownerId:player.id,damage:Math.round(channel.mpCost*positive(world.scenario?.meteorWeapon?.mpMultiplier,8))});
      }
    }
    for(const [id,strike] of this.strikes)if(now>=strike.impactAt){this.strikes.delete(id);this.strike(strike);}
    const rule=world.scenario?.type==='adventure'&&world.scenario?.meteor;
    if(rule&&now>=this.nextWeather){
      this.nextWeather=now+positive(rule.intervalMs,5000);
      for(const player of world.players.values())if(!player.dead&&!player._dying&&!player._transferring&&this.outdoor(player.mapId)){
        const strike={id:randomUUID(),kind:'meteor',mapId:player.mapId,x:player.x,y:player.y,radius:1,startedAt:now,impactAt:now+positive(rule.warningMs,1000),damage:positive(rule.damage,400)};
        this.strikes.set(strike.id,strike);
      }
    }
  }
  snapshot(mapId){
    const warnings=[...this.strikes.values()].filter(s=>s.mapId===mapId).map(({damage,...view})=>view);
    for(const channel of this.channels.values()){
      const player=this.world.players.get(channel.ownerId);if(player?.mapId===mapId)warnings.push({...channel,kind:'meteor-channel',mapId,x:player.x,y:player.y,radius:1});
    }
    return warnings;
  }
  close(){this.strikes.clear();this.channels.clear();}
}
