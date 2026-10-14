import {randomUUID} from 'node:crypto';
import {findPath,getPortals} from './navigation.mjs';
import {METEOR_WEAPON_ID,METEOR_SKILL_ID} from './hazards.mjs';
const distance=(a,b)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
const face=(a,b)=>Math.abs(b.x-a.x)>Math.abs(b.y-a.y)?(b.x>a.x?6:4):(b.y>a.y?2:8);
const directions={2:[0,1],4:[-1,0],6:[1,0],8:[0,-1]};

/** Mouse/touch input supplies an intention; this controller performs ordinary server actions. */
export class MouseNavigation {
  constructor(world){this.world=world;this.plans=new Map();}
  cancel(player){this.plans.delete(player.id);player.navigation=null;}
  resolve(player,plan){
    const map=this.world.maps.get(player.mapId);
    if(plan.entityId){const drop=map?.drops.get(plan.entityId);return drop?{entity:drop,action:'pickup',range:1}:null;}
    if(plan.targetPlayerId){const target=this.world.players.get(plan.targetPlayerId);return target&&target.mapId===player.mapId&&!target.dead&&this.world.targets(player).includes(target)?{entity:target,action:'attack',range:1}:null;}
    if(plan.targetId){
      const event=map?.events.get(plan.targetId),page=event&&this.world.events.pageFor(player,event,player.mapId);
      if(!event||event.dead||event.erased||!page||page.engineDisabledReason)return null;
      if(!event.enemyId&&![0,1,2].includes(page.trigger??0))return null;
      if(getPortals(this.world,player).some(p=>p.eventId===event.id))return{entity:event,action:'move',range:0,portal:true};
      return{entity:event,action:event.enemyId?'attack':'interact',range:1};
    }
    const portal=getPortals(this.world,player).find(p=>p.x===plan.x&&p.y===plan.y);
    return{entity:{x:plan.x,y:plan.y},action:'move',range:0,portal:!!portal};
  }
  set(player,message){
    this.cancel(player);if(message.cancel)return;
    if(!player._connected||player.dead||player._dying||player._transferring||this.world.paused)return;
    const raw=this.world.content.getMap(player.mapId);
    if(!Number.isInteger(message.x)||!Number.isInteger(message.y)||message.x<0||message.y<0||message.x>=raw.width||message.y>=raw.height)throw new Error('目标不在当前地图内');
    const plan={x:message.x,y:message.y,targetId:message.targetId,entityId:message.entityId,targetPlayerId:message.targetPlayerId,skillId:Number(message.skillId)||1,requestId:message.requestId||randomUUID(),mapId:player.mapId,nextAt:0,nextPlan:0,path:[],pending:false,steps:0};
    const target=this.resolve(player,plan);if(!target)throw new Error('目标已不存在或不可攻击');
    this.plans.set(player.id,plan);player.navigation={x:target.entity.x,y:target.entity.y,targetId:plan.targetId,entityId:plan.entityId,targetPlayerId:plan.targetPlayerId};
    this.update(player);
  }
  attackReady(player,target,skillId){
    // This is a self-centered channel; selecting an enemy must not walk into melee first.
    if(player.equips?.weapon===METEOR_WEAPON_ID&&[1,METEOR_SKILL_ID].includes(skillId))return true;
    const tool=skillId===1?this.world.content.getTool(this.world.content.weaponTools.get(player.equips.weapon)):this.world.content.getToolForSkill(skillId);
    const range=Math.max(1,Math.min(10,(skillId===1?this.world.content.weaponProfiles?.get(player.equips.weapon)?.range:0)||tool?.range||1));
    const deltaX=Math.abs(target.x-player.x),deltaY=Math.abs(target.y-player.y);
    if(deltaX===0&&deltaY===0)return false;
    const profile=this.world.content.weaponProfiles?.get(player.equips.weapon);
    if(profile?.mode==='cleave'&&(skillId===1||skillId===profile.skillId)){
      return Math.max(deltaX,deltaY)===1&&this.world.attackLineClear(player.mapId,player.x,player.y,target.x,target.y);
    }
    // Area melee (including the authored club rhombus) does not need axis alignment.
    if(tool&&!tool.projectile&&!/front|wall|line/.test(tool.area||'')){
      const inArea=(tool.area||'').includes('square')?Math.max(deltaX,deltaY)<=range:deltaX+deltaY<=range;
      return inArea&&this.world.attackLineClear(player.mapId,player.x,player.y,target.x,target.y);
    }
    if(deltaX+deltaY>range||(deltaX!==0&&deltaY!==0))return false;
    const d=face(player,target),[dx,dy]=directions[d];let x=player.x,y=player.y;
    for(let i=0;i<distance(player,target);i++){if(!this.world.content.isPassable(player.mapId,x,y,d))return false;x+=dx;y+=dy;}return true;
  }
  attackPath(player,target,skillId){
    const portals=new Set(getPortals(this.world,player).map(p=>`${p.x},${p.y}`)),candidates=[];
    for(const [dx,dy]of Object.values(directions))for(let n=1;n<=10;n++){
      const point={...player,x:target.x+dx*n,y:target.y+dy*n};
      if(!portals.has(`${point.x},${point.y}`)&&this.attackReady(point,target,skillId))candidates.push(point);
    }
    candidates.sort((a,b)=>distance(player,a)-distance(player,b));
    for(const point of candidates){const path=findPath(this.world,player,{x:point.x,y:point.y,maxNodes:2048});if(path)return path;}
    return null;
  }
  update(player){
    const plan=this.plans.get(player.id);if(!plan)return;
    if(!player._connected||player.dead||player._dying||player._transferring||player.mapId!==plan.mapId||this.world.paused){this.cancel(player);return;}
    if(plan.pending||player._economyBusy||player._economyUncertain||this.world.now+1e-6<plan.nextAt)return;
    const target=this.resolve(player,plan);if(!target){this.cancel(player);return;}
    const ready=target.action==='attack'?this.attackReady(player,target.entity,plan.skillId):distance(player,target.entity)<=target.range;
    if(ready){
      this.cancel(player);if(target.action==='move')return;
      player.direction=face(player,target.entity);
      Promise.resolve().then(()=>{if(player.dead||!player._connected||player.mapId!==plan.mapId||!this.world.players.has(player.id))return;
        if(target.action==='attack')return this.world.attack(player,plan.skillId,plan.requestId);
        if(target.action==='pickup')return this.world.pickup(player,target.entity.id,plan.requestId);
        return this.world.interact(player,target.entity.id);
      }).catch(error=>this.world.notice(player,error.message));return;
    }
    const interval=this.world.movementInterval(player,200);
    plan.nextAt=Math.max(plan.nextAt||this.world.now,this.world.now-interval)+interval;
    if(!plan.path.length||this.world.now>=plan.nextPlan){
      plan.nextPlan=this.world.now+600;plan.path=target.action==='attack'?this.attackPath(player,target.entity,plan.skillId):findPath(this.world,player,{x:target.entity.x,y:target.entity.y,range:target.range,allowBlockedGoal:target.portal,maxNodes:4096});
      if(!plan.path){this.cancel(player);this.world.notice(player,'无法走到目标附近');return;}
    }
    if(!plan.path.length||plan.steps++>1024){this.cancel(player);return;}
    const direction=plan.path[0],before={x:player.x,y:player.y};this.world.move(player,direction);
    if(player.x!==before.x||player.y!==before.y)plan.path.shift();else plan.path=[];
  }
}
