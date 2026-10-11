import {randomUUID} from 'node:crypto';
import {findPath,getPortals} from './navigation.mjs';

export const OFFLINE_BEHAVIORS=Object.freeze(['stay','evade','search','hunt']);
export const normalizeOfflineBehavior=value=>OFFLINE_BEHAVIORS.includes(value)?value:'stay';
const DIRECTIONS={2:[0,1],4:[-1,0],6:[1,0],8:[0,-1]};
const distance=(a,b)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
const facing=(a,b)=>Math.abs(b.x-a.x)>Math.abs(b.y-a.y)?(b.x>a.x?6:4):(b.y>a.y?2:8);
const tile=p=>`${p.mapId}:${p.x},${p.y}`;

/** Sight uses the same tile edges as movement; walls do not reveal remote targets. */
export function hasLineOfSight(world,source,target,range=8){
  if(source.mapId!==target.mapId||distance(source,target)>range)return false;
  let x=source.x,y=source.y,remaining=Math.ceil(distance(source,target))+2;
  while((x!==target.x||y!==target.y)&&remaining-->0){
    const dx=target.x-x,dy=target.y-y,d=Math.abs(dx)>=Math.abs(dy)?(dx>0?6:4):(dy>0?2:8);
    if(!world.content.isPassable(source.mapId,x,y,d))return false;
    const step=DIRECTIONS[d],pos=world.content.wrapPosition(source.mapId,x+step[0],y+step[1]);x=pos.x;y=pos.y;
  }
  return x===target.x&&y===target.y;
}

/** Input producer only: normal movement, attack, pickup and service transactions remain authoritative. */
export class OfflineAI {
  constructor(world){this.world=world;this.states=new Map();}
  cancel(player){this.states.delete(player.id);player.offlineActivity=null;}
  state(player){let state=this.states.get(player.id);if(!state){state={nextAt:0,nextPlanAt:0,path:[],mapId:player.mapId,visits:new Map(),maps:new Map([[player.mapId,1]]),failed:new Map(),pending:false};this.states.set(player.id,state);}return state;}
  hazardous(mapId){const z=this.world.maps.get(mapId)?.zone;return!!(z&&z.endsAt>this.world.now&&z.startsAt<=this.world.now+30000);}
  threats(player){return this.world.targets(player).filter(t=>!t._transferring&&hasLineOfSight(this.world,player,t,8));}
  action(player,state,operation){
    state.pending=true;
    Promise.resolve().then(()=>{if(this.states.get(player.id)!==state||player._connected||player.dead||this.world.paused)return;return operation();})
      .catch(error=>{if(this.states.get(player.id)===state){state.path=[];state.nextAt=state.nextPlanAt=this.world.now+1000;player.offlineActivity='操作暂不可用，等待重试';this.world.runtimeDiagnostics.set(`offline:${player.id}`,error.message);}})
      .finally(()=>{state.pending=false;});
  }
  update(player){
    const world=this.world,behavior=normalizeOfflineBehavior(player.offlineBehavior||player.profile?.offlineBehavior);
    if(player._connected||player.dead||player._dying||player._transferring||world.paused){this.cancel(player);return;}
    if(behavior==='stay'){this.cancel(player);player.offlineActivity='原地停留';return;}
    const state=this.state(player);
    if(player._disconnecting||player._economyBusy||player._economyUncertain||state.pending||world.now<state.nextAt)return;
    state.nextAt=world.now+200;
    if(state.mapId!==player.mapId){state.mapId=player.mapId;state.maps.set(player.mapId,(state.maps.get(player.mapId)||0)+1);state.path=[];state.nextPlanAt=0;state.goal=null;}
    if(this.hazardous(player.mapId)){this.escapeZone(player,state);return;}
    const threats=this.threats(player);
    if(threats.length&&(behavior!=='hunt'||player.hp<=player.maxHp*.3)){this.evade(player,state,threats);return;}
    if(behavior==='hunt'&&threats.length){this.hunt(player,state,threats);return;}
    if(behavior==='search'){this.search(player,state);return;}
    state.path=[];player.offlineActivity=behavior==='hunt'?'警戒：视野内没有敌对目标':'隐蔽待机';
  }
  step(player,state,path){
    if(!path?.length)return false;
    const direction=path[0],before=tile(player);this.world.move(player,direction);
    if(tile(player)!==before){path.shift();state.visits.set(before,(state.visits.get(before)||0)+1);if(state.visits.size>256)state.visits.delete(state.visits.keys().next().value);return true;}
    state.path=[];state.nextPlanAt=0;return false;
  }
  route(player,target){return findPath(this.world,player,{x:target.x,y:target.y,range:target.range??0,avoidPortals:true,maxNodes:1600,allowBlockedGoal:!!target.portal});}
  evade(player,state,threats){
    player.offlineActivity='躲避附近威胁';
    if(state.mode!=='evade'||this.world.now>=state.nextPlanAt||!state.path.length){
      state.mode='evade';state.nextPlanAt=this.world.now+600;
      const portals=new Set(getPortals(this.world,player).map(p=>`${p.x},${p.y}`)),queue=[{x:player.x,y:player.y,path:[]}],seen=new Set([`${player.x},${player.y}`]);
      const score=node=>Math.min(9,...threats.map(t=>distance(node,t)))*20-node.path.length-(state.visits.get(tile({...player,...node}))||0)*2;
      let best=queue[0],bestScore=score(best);
      for(let i=0;i<queue.length&&i<96;i++){
        const node=queue[i],value=score(node);if(value>bestScore){best=node;bestScore=value;}if(node.path.length>=6)continue;
        for(const[d,[dx,dy]]of Object.entries(DIRECTIONS)){
          if(!this.world.canMove({...player,...node},Number(d)))continue;
          const pos=this.world.content.wrapPosition(player.mapId,node.x+dx,node.y+dy),key=`${pos.x},${pos.y}`;
          if(seen.has(key)||portals.has(key))continue;seen.add(key);queue.push({...pos,path:[...node.path,Number(d)]});
        }
      }
      state.path=best.path;
      if(!state.path.length)for(const portal of getPortals(this.world,player).filter(p=>!this.hazardous(p.mapId)).sort((a,b)=>distance(player,a)-distance(player,b))){const path=this.route(player,{...portal,portal:true});if(path?.length){state.path=path;break;}}
    }
    if(!this.step(player,state,state.path))player.offlineActivity='躲避：暂时没有更安全的可达位置';
  }
  escapeZone(player,state){
    player.offlineActivity='撤离即将生效或已生效的禁区';
    if(state.mode!=='zone'||!state.path.length||this.world.now>=state.nextPlanAt){
      state.mode='zone';state.nextPlanAt=this.world.now+1200;state.path=[];
      const queue=[{mapId:player.mapId,first:null}],seen=new Set([player.mapId]);
      for(let i=0;i<queue.length&&i<32;i++){
        const node=queue[i];
        const portals=getPortals(this.world,{...player,mapId:node.mapId});if(!node.first)portals.sort((a,b)=>distance(player,a)-distance(player,b));
        for(const portal of portals){
          const target=Number(portal.mapId);if(seen.has(target)||!this.world.content.getMap(target))continue;
          const first=node.first||portal,path=node.first?null:this.route(player,{...portal,portal:true});
          if(!node.first&&!path)continue;
          seen.add(target);
          if(!this.hazardous(target)){state.path=node.first?this.route(player,{...first,portal:true})||[]:path;state.portal=first;break;}
          queue.push({mapId:target,first});
        }
        if(state.path.length)break;
      }
    }
    if(!this.step(player,state,state.path))player.offlineActivity='禁区撤离：暂时没有可达的安全出口';
  }
  hunt(player,state,threats){
    const target=threats.sort((a,b)=>distance(player,a)-distance(player,b))[0];
    player.offlineActivity=`追击 ${target.name||'敌对目标'}`;
    const profile=this.world.content.weaponProfiles?.get(player.equips.weapon),tool=this.world.content.getTool?.(this.world.content.weaponTools?.get(player.equips.weapon))||this.world.content.getToolForSkill?.(1);
    const range=Math.max(1,Math.min(8,profile?.range||tool?.range||1)),ranged=!!(profile?.projectile||tool?.projectile),aligned=target.x===player.x||target.y===player.y;
    if(distance(player,target)<=range&&(!ranged||aligned)){
      player.direction=facing(player,target);state.path=[];
      this.action(player,state,async()=>{const fired=await this.world.attack(player,1,`offline:${randomUUID()}`);if(fired===false)player.offlineActivity='追击：等待攻击冷却或所需资源';});return;
    }
    if(state.mode!=='hunt'||state.target!==target.id||this.world.now>=state.nextPlanAt||!state.path.length){state.mode='hunt';state.target=target.id;state.nextPlanAt=this.world.now+600;state.path=this.route(player,{...target,range:1})||[];}
    if(!this.step(player,state,state.path))player.offlineActivity='追击：目标暂不可达';
  }
  search(player,state){
    const map=this.world.maps.get(player.mapId);if(!map)return;
    player.offlineActivity='搜寻物品与补给箱';
    if(state.mode!=='search'||!state.goal||this.world.now>=state.nextPlanAt){
      state.mode='search';state.goal=null;state.path=[];state.nextPlanAt=this.world.now+1500;
      const targets=[...map.drops.values()].map(d=>({...d,kind:'drop',range:1})).concat([...map.events.values()].filter(e=>!e.erased&&e.service?.action==='container'&&!e.name.startsWith('已搜刮')).map(e=>({...e,kind:'container',range:1})));
      targets.sort((a,b)=>distance(player,a)-distance(player,b));
      for(const target of targets.slice(0,16)){
        if((state.failed.get(target.id)||0)>this.world.now)continue;
        const path=this.route(player,target);if(path){state.goal=target;state.path=path;break;}state.failed.set(target.id,this.world.now+5000);
      }
      if(!state.goal){
        const portals=getPortals(this.world,player).filter(p=>!this.hazardous(p.mapId)).sort((a,b)=>(state.maps.get(a.mapId)||0)-(state.maps.get(b.mapId)||0)||distance(player,a)-distance(player,b));
        for(const portal of portals.slice(0,12)){const path=this.route(player,{...portal,portal:true});if(path?.length){state.goal={...portal,kind:'portal',range:0};state.path=path;break;}}
      }
    }
    const goal=state.goal;
    if(!goal){player.offlineActivity='探物：附近没有可达物品或新区域';return;}
    if(goal.kind==='portal'){this.step(player,state,state.path);return;}
    const target=goal.kind==='drop'?map.drops.get(goal.id):map.events.get(goal.id);
    if(!target||target.name?.startsWith('已搜刮')){state.goal=null;return;}
    if(distance(player,target)<=1){
      state.goal=null;state.path=[];state.failed.set(target.id,this.world.now+3000);
      this.action(player,state,()=>goal.kind==='drop'?this.world.pickup(player,target.id,`offline:${randomUUID()}`):this.world.interact(player,target.id));return;
    }
    if(!this.step(player,state,state.path)){state.failed.set(target.id,this.world.now+3000);state.goal=null;}
  }
}
