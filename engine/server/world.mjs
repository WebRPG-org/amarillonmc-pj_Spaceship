import {randomUUID} from 'node:crypto';
import {EventRuntime} from './events.mjs';
import {addInventory,applyRecipe,computeDamage} from './combat.mjs';
import {normalizeWeapons,weaponAttack,consumeAttackCost,equippedWeapon} from './weapons.mjs';
import {OfflineAI,normalizeOfflineBehavior} from './offline-ai.mjs';
import {MouseNavigation} from './mouse-navigation.mjs';

export const DIRECTIONS={2:[0,1],4:[-1,0],6:[1,0],8:[0,-1]};
const persistedKeys=['schemaVersion','mapId','x','y','direction','characterName','characterIndex','hp','maxHp','mp','maxMp','level','exp','gold','inventory','skills','equips','switches','variables','selfSwitches','stats','dead','classId','states','ending','paramPlus'];
export const cloneState=p=>structuredClone(Object.fromEntries(persistedKeys.filter(k=>p[k]!==undefined).map(k=>[k,p[k]])));
const distance=(a,b)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
const finite=(v,fallback=0)=>Number.isFinite(Number(v))?Number(v):fallback;
const comments=page=>(page?.list||[]).filter(c=>[108,408].includes(c.code)).map(c=>c.parameters[0]).join('\n');

/** One authority owns each map. UI scenes never affect this simulation clock. */
export class World {
  constructor({content,store,devTools=false,clock=Date.now,random=Math.random,retainDisconnected=false,hooks={}}) {
    Object.assign(this,{content,store,devTools,clock,random,retainDisconnected,hooks});
    this.players=new Map();this.connecting=new Set();this.maps=new Map();this.tick=0;this.now=clock();this.lastSave=this.now;
    this.events=new EventRuntime({content,world:this});this.runtimeDiagnostics=new Map();this.offlineAI=new OfflineAI(this);this.navigation=new MouseNavigation(this);
  }
  async ensureMap(id) {
    id=Number(id);if(this.maps.has(id)){const map=this.maps.get(id);await map.ready;return map;}
    const raw=this.content.getMap(id);if(!raw)throw new Error('地图不存在');
    const map={id,raw,events:new Map(),drops:new Map(),projectiles:new Map(),zone:null,pvp:[9,11,30].includes(id)};
    this.maps.set(id,map);
    for(const event of raw.events.filter(Boolean))this.addEvent(map,event,id);
    this.events.refreshMap(map);
    map.ready=(async()=>{for(const drop of await this.store.listDrops(id))map.drops.set(drop.id,{...drop,kind:drop.kind||drop.metadata?.kind||'item'});if(this.hooks.onMapReady)await this.hooks.onMapReady(map);})();
    await map.ready;return map;
  }
  addEvent(map,raw,sourceMapId=map.id,position=null) {
    const page=raw.pages.find(p=>!p.conditions?.switch1Valid&&!p.conditions?.switch2Valid&&!p.conditions?.variableValid&&!p.conditions?.selfSwitchValid&&!p.conditions?.actorValid&&!p.conditions?.itemValid)||raw.pages[0];
    const text=comments(page), enemyId=page?.engineDisabledReason?0:Number(text.match(/enemy_id\s*:\s*(\d+)/i)?.[1]||0);
    const enemy=this.content.database.Enemies[enemyId];
    const event={...structuredClone(raw),id:`map:${map.id}:event:${raw.id}${position?':'+randomUUID():''}`,eventId:raw.id,sourceMapId,mapId:map.id,raw,pages:raw.pages,x:position?.x??raw.x,y:position?.y??raw.y,direction:page?.image?.direction||2,image:page?.image||{},priorityType:page?.priorityType??1,through:page?.through||false,name:text.match(/<Name:\s*([^>]+)>/i)?.[1]||raw.name,enemyId:enemy?enemyId:0,erased:false,homeX:position?.x??raw.x,homeY:position?.y??raw.y,nextMove:0,nextAttack:0,states:[]};
    if(enemy)this.setEnemyStats(event,enemy);
    map.events.set(event.id,event);return event;
  }
  setEnemyStats(entity,enemy) {
    const p=enemy.params;Object.assign(entity,{maxHp:p[0],hp:p[0],maxMp:p[1],mp:p[1],stats:{atk:p[2],def:p[3],mat:p[4],mdf:p[5],agi:p[6],luk:p[7]},name:enemy.name});
  }
  defaultState() {
    const db=this.content.database,actor=db.Actors[db.System.partyMembers?.[0]||1]||db.Actors[1];
    const state={schemaVersion:1,mapId:db.System.startMapId||1,x:db.System.startX||0,y:db.System.startY||0,direction:2,characterName:actor.characterName,characterIndex:actor.characterIndex,level:actor.initialLevel||1,classId:actor.classId,exp:0,gold:0,inventory:[],skills:[1],equips:{weapon:actor.equips?.[0]||0,armor:actor.equips?.find((v,i)=>i>0&&v>0)||0},switches:{},variables:{},selfSwitches:{},states:[],dead:false};
    if(state.equips.weapon)addInventory(state,'weapon',state.equips.weapon,1);
    if(state.equips.armor)addInventory(state,'armor',state.equips.armor,1);
    for(const learn of db.Classes[actor.classId]?.learnings||[])if(learn.level<=state.level&&!state.skills.includes(learn.skillId))state.skills.push(learn.skillId);
    this.recalculate(state);state.hp=state.maxHp;state.mp=state.maxMp;return state;
  }
  recalculate(player) {
    const db=this.content.database,cl=db.Classes[player.classId||1];
    normalizeWeapons(player,this.content.weaponProfiles);
    player.equips||={};
    for(const kind of ['weapon','armor'])if(player.equips[kind]&&!player.inventory?.some(i=>i.kind===kind&&i.itemId===player.equips[kind]&&i.quantity>0))player.equips[kind]=0;
    const p=Array.from({length:8},(_,i)=>finite(cl?.params?.[i]?.[Math.max(1,Math.min(99,player.level||1))],[150,60,25,15,25,15,15,15][i]));
    for(const item of [db.Weapons[player.equips?.weapon],db.Armors[player.equips?.armor]])if(item)for(let i=0;i<8;i++)p[i]+=item.params[i]||0;
    for(let i=0;i<8;i++)p[i]+=finite(player.paramPlus?.[i]);
    player.maxHp=Math.max(1,p[0]);player.maxMp=Math.max(0,p[1]);player.stats={atk:p[2],def:p[3],mat:p[4],mdf:p[5],agi:p[6],luk:p[7]};
    player.hp=Math.min(player.maxHp,player.hp??player.maxHp);player.mp=Math.min(player.maxMp,player.mp??player.maxMp);
  }
  async connect(account,send,{announce=true}={}) {
    if(this.players.has(account.id)||this.connecting.has(account.id))throw new Error('该角色已在另一窗口连接；请先断开原连接');
    this.connecting.add(account.id);
    try {
    const initial=account.state?.mapId?account.state:this.defaultState();
    const player={...this.defaultState(),...structuredClone(initial),id:account.id,name:account.username,_send:send,_queue:Promise.resolve(),_lastMove:0,_lastAttack:0,_lastSeq:-1,_connected:true};
    this.recalculate(player);if(!this.content.getMap(player.mapId))player.mapId=1;
    const map=await this.ensureMap(player.mapId),spawn=this.content.findSpawn(map.id,player.x,player.y);
    if(spawn)Object.assign(player,spawn);
    await this.store.savePlayer(player.id,cloneState(player));this.players.set(player.id,player);
    if(announce){this.send(player.id,{type:'notice',message:'已连接服务端权威世界。菜单期间世界仍会运行。'});this.sendSnapshot(player);}return player;
    } finally {this.connecting.delete(account.id);}
  }
  async disconnect(id) {
    const player=this.players.get(id);if(!player)return;
    if(player._disconnecting)return player._disconnecting;
    player._connected=false;this.events.cancel?.(player);this.offlineAI.cancel(player);this.navigation.cancel(player);
    player._disconnecting=(async()=>{await this.flush(player);if(!this.retainDisconnected)this.players.delete(id);})().finally(()=>{delete player._disconnecting;});
    return player._disconnecting;
  }
  async flush(player){let queued;do{queued=player._queue;await queued;}while(queued!==player._queue);if(player._economyUncertain)await this.recoverEconomy(player);await this.store.savePlayer(player.id,cloneState(player));}
  async detach(id,{save=true}={}){const p=this.players.get(id);if(!p)return;const connected=p._connected;p._connected=false;this.events.cancel?.(p);this.offlineAI.cancel(p);this.navigation.cancel(p);try{if(save)await this.flush(p);else await p._queue;}catch(error){p._connected=connected;throw error;}this.players.delete(id);return p;}
  async reconnect(id,send){const p=this.players.get(id);if(!p||p._connected)throw new Error('该角色已在另一窗口连接');if(p._disconnecting)await p._disconnecting;p._send=send;p._connected=true;p._lastSeq=-1;this.offlineAI.cancel(p);this.events.cancel?.(p);this.sendSnapshot(p);return p;}
  send(id,message){const p=this.players.get(id);if(p?._connected)p._send(message);}
  broadcast(mapId,message){for(const p of this.players.values())if(p.mapId===mapId)this.send(p.id,message);}
  notice(player,message){this.send(player.id,{type:'notice',message});}
  async recoverEconomy(player){const account=await this.store.loadPlayer(player.id);if(!account?.state)throw new Error('库存提交状态仍待确认');this.adoptEconomy(player,account.state);if(Number.isFinite(account.state.mp))player.mp=Math.max(0,Math.min(player.maxMp,account.state.mp));player._economyUncertain=false;}
  enqueue(player,operation){const job=player._queue.then(async()=>{player._economyBusy=true;try{if(player._economyUncertain)await this.recoverEconomy(player);return await operation();}catch(error){if(error.economyUncertain){player._economyUncertain=true;try{await this.recoverEconomy(player);}catch{/* Keep writes blocked until an authoritative read succeeds. */}}throw error;}finally{player._economyBusy=false;}});player._queue=job.catch(error=>{this.notice(player,error.message||'操作失败');});return job;}
  persist(player){this.enqueue(player,()=>this.store.savePlayer(player.id,cloneState(player))).catch(()=>{});return player._queue;}
  markDirty(player){this.recalculate(player);player._dirty=true;}
  getSwitch(player,id){return !!player.switches?.[id];}
  setSwitch(player,id,value){player.switches[id]=!!value;}
  getVariable(player,id){return player.variables?.[id]??0;}
  setVariable(player,id,value){if(Number.isFinite(value)||typeof value==='string')player.variables[id]=value;}
  grant(player,kind,itemId,amount) {
    return this.enqueue(player,async()=>{
    const next=cloneState(player);
    if(kind==='gold')next.gold=Math.max(0,next.gold+amount);
    else {const db=this.content.database[{item:'Items',weapon:'Weapons',armor:'Armors'}[kind]];if(!db?.[itemId])throw new Error('事件引用了不存在的物品');const current=next.inventory.find(i=>i.kind===kind&&i.itemId===itemId)?.quantity||0;addInventory(next,kind,itemId,Math.max(-current,amount));}
    await this.store.savePlayer(player.id,next);this.adoptEconomy(player,next);
    });
  }
  async transfer(player,mapId,x,y) {
    this.navigation.cancel(player);
    return this.enqueue(player,async()=>{
    if(this.hooks.beforeTransfer)this.hooks.beforeTransfer(player,Number(mapId));
    await this.ensureMap(mapId);const spawn=this.content.findSpawn(Number(mapId),x,y);if(!spawn)throw new Error('地图没有可用出生点');
    player.mapId=Number(mapId);Object.assign(player,spawn);player._lastMove=this.now;this.events.onTransfer?.(player);this.sendSnapshot(player);await this.store.savePlayer(player.id,cloneState(player));
    });
  }
  spawnTemplate(mapId,sourceMapId,eventId,x,y) {
    const map=this.maps.get(Number(mapId)),source=this.content.getMap(Number(sourceMapId))?.events[Number(eventId)];if(!map||!source)return null;
    if(source.pages.every(p=>p.engineDisabledReason))return null;
    return this.addEvent(map,source,Number(sourceMapId),{x,y});
  }
  canMove(entity,direction,ignoreEntities=false) {
    if(!DIRECTIONS[direction]||!this.content.isPassable(entity.mapId,entity.x,entity.y,direction))return false;
    const [dx,dy]=DIRECTIONS[direction],dest=this.content.wrapPosition(entity.mapId,entity.x+dx,entity.y+dy);
    if(ignoreEntities)return true;
    const map=this.maps.get(entity.mapId);
    for(const event of map?.events.values()||[]){if(event.id===entity.id||event.erased||event.dead)continue;
      const page=this.events.pageFor?.(entity,event,map.id);if(!page||page.engineDisabledReason||(page.through??event.through))continue;
      const priority=page?.priorityType??event.priorityType;
      if(priority===1&&event.x===dest.x&&event.y===dest.y&&(event.enemyId||page?.image?.characterName||page?.image?.tileId))return false;
    }return true;
  }
  move(player,direction,seq) {
    if(!DIRECTIONS[direction]||player.dead||player._dying||player._economyBusy)return;
    if(Number.isSafeInteger(seq)){if(seq<=player._lastSeq)return;player._lastSeq=seq;}
    player.direction=direction;
    if(this.now-player._lastMove<140)return;
    player._lastMove=this.now;
    if(!this.canMove(player,direction)){this.triggerTouch(player,direction);return;}
    const [dx,dy]=DIRECTIONS[direction];Object.assign(player,this.content.wrapPosition(player.mapId,player.x+dx,player.y+dy));
    this.triggerTouch(player);
  }
  triggerTouch(player,direction=null) {
    const [dx,dy]=direction?DIRECTIONS[direction]:[0,0],pos=this.content.wrapPosition(player.mapId,player.x+dx,player.y+dy);
    for(const event of this.maps.get(player.mapId)?.events.values()||[]){if(event.erased||event.enemyId||event.x!==pos.x||event.y!==pos.y)continue;const page=this.events.pageFor?.(player,event,player.mapId);if([1,2].includes(page?.trigger))this.events.start(player,event);}
  }
  interact(player,targetId) {
    if(player.dead||player._dying||player._economyBusy)return;
    const map=this.maps.get(player.mapId),[dx,dy]=DIRECTIONS[player.direction]||[0,1];
    const candidates=[...map.events.values()].filter(e=>{
      if(e.erased||e.enemyId||distance(player,e)>1)return false;
      const page=this.events.pageFor(player,e,map.id);
      return page&&!page.engineDisabledReason&&[0,1,2].includes(page.trigger??0);
    });
    const event=targetId?candidates.find(e=>e.id===targetId):candidates.find(e=>e.x===player.x+dx&&e.y===player.y+dy)||candidates.find(e=>e.x===player.x&&e.y===player.y);
    if(event){if(event.service)return this.hooks.onService?.(player,event);this.events.start(player,event);return;}
    const drop=[...map.drops.values()].find(d=>distance(player,d)<=1.5);if(drop)return this.pickup(player,drop.id,randomUUID());
    this.notice(player,'面向事件按 E 交互，靠近地上物品可拾取。');
  }
  targets(source) {
    const map=this.maps.get(source.mapId);if(!map)return[];
    const players=[...this.players.values()].filter(p=>p.mapId===source.mapId&&!p.dead&&!p._dying&&!p._transferring&&p.id!==source.id);
    if(source.enemyId)return players;
    return [...map.events.values()].filter(e=>e.enemyId&&!e.erased&&!e.dead).concat(map.pvp?players:[]);
  }
  attack(player,skillId=1,requestId=randomUUID()) {
    skillId=Number(skillId);
    if(player.dead||player._dying||player._transferring||player._attackPending||player._economyBusy)return Promise.resolve(false);
    const expectedMap=player.mapId,expectedWeapon=player.equips?.weaponInstanceId,expectedDirection=player.direction;
    player._attackPending=true;
    return this.enqueue(player,async()=>{
      if(player.dead||player._dying||player._transferring||player.mapId!==expectedMap||player.equips?.weaponInstanceId!==expectedWeapon)return false;
      this.validateRequest(requestId);
      const definition=weaponAttack(this.content,player,skillId),{skill,tool}=definition;
      if(!skill||(!player.skills.includes(skillId)&&definition.profile?.skillId!==skillId))return false;
      if(this.now-player._lastAttack<Math.max(200,(tool?.cooldown||.45)*1000))return false;
      // Persist current movement/HP, then lock and pay before publishing any attack.
      await this.store.savePlayer(player.id,cloneState(player));
      const outcome=await this.store.commitPlayer(player.id,requestId,state=>{
        if(player.dead||player._dying||player._transferring||player.mapId!==expectedMap||player.equips?.weaponInstanceId!==expectedWeapon)throw new Error('角色状态已变化，攻击取消');
        normalizeWeapons(state,this.content.weaponProfiles);
        const cost=consumeAttackCost(state,weaponAttack(this.content,state,skillId));
        return{attack:true,...cost};
      });
      if(outcome.duplicate)return false;
      this.adoptEconomy(player,outcome.state);player.mp=Math.max(0,player.mp-(outcome.result?.mpCost||0));player._lastAttack=this.now;
      if(player.dead||player._dying||player._transferring||player.mapId!==expectedMap)return false;
      player.direction=expectedDirection;
      if([7,8,9,10,11].includes(skill.scope))this.hit(player,player,skill,tool);
      else this.performAttack(player,skill,tool,definition.profile);
      return true;
    }).finally(()=>{player._attackPending=false;});
  }
  useTool(player,toolId) {
    const tool=this.content.getTool(Number(toolId));if(!tool)return;
    if(!player.enemyId)return this.attack(player,tool.skillId||1).catch(()=>false);
    const skill=this.content.database.Skills[tool.skillId||1];if(skill)this.performAttack(player,skill,tool);
  }
  performAttack(source,skill,tool,profile=null) {
    const [dx,dy]=DIRECTIONS[source.direction]||[0,1],map=this.maps.get(source.mapId);
    const delayed=Math.max(0,Number(tool?.meta?.tool_wait_collision)||0)/60;
    const duration=Math.max(.15,Math.min(5,tool?.duration||.25));
    const projectile=!!tool?.projectile;
    const maxDistance=Math.max(1,Math.min(20,profile?.range||Number(tool?.meta?.tool_max_distance)||6));
    const attack={id:randomUUID(),ownerId:source.id,source,mapId:source.mapId,x:source.x,y:source.y,originX:source.x,originY:source.y,maxDistance,distance:0,direction:source.direction,skillId:skill.id,skill,tool,dx,dy,speed:projectile?Number(tool?.meta?.tool_speed)||6:0,range:Math.max(1,Math.min(10,profile?.range||tool?.range||1)),area:tool?.area||'front_rhombus',born:this.now,expires:this.now+(projectile?Math.max(duration,maxDistance/6):duration)*1000,activeAt:this.now+delayed*1000,hit:new Map(),projectile};
    map.projectiles.set(attack.id,attack);
    // New ranged weapon animations represent impact and are emitted by hit().
    this.broadcast(source.mapId,{type:'effect',kind:'attack',x:source.x+(profile?0:dx),y:source.y+(profile?0:dy),animationId:profile?.projectile?0:tool?.animationId||skill.animationId,skillId:skill.id,direction:source.direction});
    if(!delayed)this.resolveAttack(attack);
  }
  resolveAttack(attack) {
    if(this.now<attack.activeAt)return;
    const source=attack.source;if(source.dead||source._dying||source._transferring||source.erased||source.mapId!==attack.mapId)return;
    for(const target of this.targets(source)) {
      const dx=target.x-attack.x,dy=target.y-attack.y,forward=dx*attack.dx+dy*attack.dy,side=Math.abs(dx*attack.dy-dy*attack.dx);
      let inside=attack.projectile?Math.abs(dx)<=.65&&Math.abs(dy)<=.65:attack.area.includes('square')?Math.max(Math.abs(dx),Math.abs(dy))<=attack.range:Math.abs(dx)+Math.abs(dy)<=attack.range;
      if(!attack.projectile&&(/front|wall|line/.test(attack.area)||!attack.tool))inside=forward>0&&forward<=attack.range&&side<=(attack.area==='wall'?1:0);
      if(!inside)continue;
      // Wide melee swings do not damage through impassable map tiles.
      if(!this.attackLineClear(attack.mapId,attack.x,attack.y,target.x,target.y))continue;
      if(attack.projectile&&Math.abs(target.x-attack.originX)+Math.abs(target.y-attack.originY)>attack.maxDistance)continue;
      const last=attack.hit.get(target.id),multi=Number(attack.tool?.meta?.tool_multihit)||0;
      if(last!==undefined&&(!multi||this.now-last<multi/60*1000))continue;
      attack.hit.set(target.id,this.now);this.hit(source,target,attack.skill,attack.tool);
      if(attack.projectile&&!attack.tool?.piercing){attack.expires=0;break;}
    }
  }
  attackLineClear(mapId,x,y,targetX,targetY){
    let cx=Math.round(x),cy=Math.round(y);const tx=Math.round(targetX),ty=Math.round(targetY);
    for(let n=0;n<40&&(cx!==tx||cy!==ty);n++){
      const dx=tx-cx,dy=ty-cy,direction=Math.abs(dx)>=Math.abs(dy)&&dx?(dx>0?6:4):(dy>0?2:8);
      if(!this.content.isPassable(mapId,cx,cy,direction))return false;
      const [sx,sy]=DIRECTIONS[direction];cx+=sx;cy+=sy;
    }
    return cx===tx&&cy===ty;
  }
  advanceProjectile(attack,dt){
    let remaining=Math.min(attack.speed*dt,attack.maxDistance-attack.distance);
    while(remaining>0){
      const step=Math.min(.2,remaining),nx=attack.x+attack.dx*step,ny=attack.y+attack.dy*step;
      const oldX=Math.round(attack.x),oldY=Math.round(attack.y),newX=Math.round(nx),newY=Math.round(ny);
      if((oldX!==newX||oldY!==newY)&&!this.content.isPassable(attack.mapId,oldX,oldY,attack.direction)){attack.expires=0;return;}
      attack.x=nx;attack.y=ny;attack.distance+=step;remaining-=step;
      this.resolveAttack(attack);if(!attack.expires)return;
    }
    if(attack.distance>=attack.maxDistance-1e-8)attack.expires=0;
  }
  hit(source,target,skill,tool) {
    let result;try{result=computeDamage(skill,source,target,this.random);}catch(error){this.runtimeDiagnostics.set(`formula:${skill.id}`,error.message);return;}
    if(result.missed){this.broadcast(source.mapId,{type:'effect',kind:'damage',x:target.x,y:target.y,value:'MISS',targetId:target.id});return;}
    const type=skill.damage?.type||0,heal=[3,4].includes(type),mp=[2,4,6].includes(type),field=mp?'mp':'hp',max=mp?'maxMp':'maxHp';
    if(type)target[field]=Math.max(0,Math.min(target[max],target[field]+(heal?result.value:-result.value)));
    if([5,6].includes(type))source[field]=Math.min(source[max],source[field]+result.value);
    for(const effect of skill.effects||[]) {
      if(effect.code===11)target.hp=Math.max(0,Math.min(target.maxHp,target.hp+Math.round(target.maxHp*effect.value1+effect.value2)));
      if(effect.code===12)target.mp=Math.max(0,Math.min(target.maxMp,target.mp+Math.round(target.maxMp*effect.value1+effect.value2)));
      if(effect.code===21&&effect.dataId>1&&this.random()<(effect.value1||1)){target.states||=[];if(!target.states.some(s=>s.id===effect.dataId))target.states.push({id:effect.dataId,expires:this.now+10000});}
      if(effect.code===22)target.states=(target.states||[]).filter(s=>s.id!==effect.dataId);
    }
    this.broadcast(source.mapId,{type:'effect',kind:heal?'heal':'damage',x:target.x,y:target.y,value:result.value,targetId:target.id,critical:result.critical,animationId:skill.animationId});
    if(target.hp<=0){this.kill(target,source);return;}
    const knockback=Math.min(3,Number(tool?.meta?.tool_knockback_power)||0);
    if(knockback&&!heal)for(let i=0;i<knockback;i++){if(!this.canMove(target,source.direction,true))break;const [dx,dy]=DIRECTIONS[source.direction];Object.assign(target,this.content.wrapPosition(target.mapId,target.x+dx,target.y+dy));}
  }
  damage(player,amount,source=null){if(player.dead)return;player.hp=Math.max(0,player.hp-Math.max(0,finite(amount)));if(player.hp===0)this.kill(player,source);}
  heal(player,amount){if(!player.dead)player.hp=Math.min(player.maxHp,player.hp+Math.max(0,finite(amount)));}
  kill(entity,killer) {
    if(entity.dead||entity._dying)return;
    entity.hp=0;entity.dead=true;this.broadcast(entity.mapId,{type:'effect',kind:'death',x:entity.x,y:entity.y,targetId:entity.id});
    if(entity.enemyId){
      entity.erased=true;entity.respawnAt=entity.noRespawn?Infinity:this.now+30000;
      const enemy=this.content.database.Enemies[entity.enemyId],owner=killer&&!killer.enemyId?killer:null;
      if(owner)this.enqueue(owner,async()=>{
        await this.store.savePlayer(owner.id,cloneState(owner));
        const drops=(entity.customDrops||((enemy.dropItems||[]).filter(d=>d.kind&&d.dataId&&this.random()<1/(d.denominator||1)).map(d=>({kind:['','item','weapon','armor'][d.kind],itemId:d.dataId,quantity:1})))).map(d=>({...d,mapId:entity.mapId,x:entity.x,y:entity.y}));
        const outcome=await this.store.createDrops({playerId:owner.id,requestId:`enemy:${entity.id}:${this.tick}`,drops,mutator:state=>{state.gold=(state.gold||0)+(enemy.gold||0);state.exp=(state.exp||0)+(enemy.exp||0);return{gold:enemy.gold,exp:enemy.exp};}});
        this.adoptEconomy(owner,outcome.state);for(const drop of outcome.drops)this.maps.get(entity.mapId).drops.set(drop.id,drop);await this.hooks.onEnemyDeath?.(entity,owner,outcome);
      }).catch(()=>{});
    } else {
      entity._dying=true;
      this.enqueue(entity,async()=>{try{
        // Persist the terminal state and remove all carried stacks in the SAME transaction as drops.
        const terminal=cloneState(entity),drops=entity.inventory.length?[{kind:'bag',itemId:0,quantity:1,mapId:entity.mapId,x:entity.x,y:entity.y,metadata:{items:structuredClone(entity.inventory),ownerId:entity.id,ownerName:entity.name,reason:'death'}}]:[];
        const outcome=await this.store.createDrops({playerId:entity.id,requestId:`death:${randomUUID()}`,drops,mutator:state=>{Object.assign(state,terminal,{inventory:[],equips:{weapon:0,armor:0},hp:0,dead:true});return{dead:true};}});
        this.adoptEconomy(entity,outcome.state);this.recalculate(entity);for(const drop of outcome.drops)this.maps.get(entity.mapId).drops.set(drop.id,drop);
        this.notice(entity,this.hooks.onPlayerDeath?'你已死亡，全部背包物品留在一个遗物背包中。':'你已死亡，全部背包物品留在一个遗物背包中。可选择重生。');await this.hooks.onPlayerDeath?.(entity,killer);
      }catch(error){entity.dead=false;entity.hp=1;throw error;}finally{entity._dying=false;}}).catch(()=>{});
    }
  }
  adoptEconomy(player,state){for(const key of ['inventory','gold','exp','skills','equips'])if(state[key]!==undefined)player[key]=structuredClone(state[key]);this.recalculate(player);}
  validateRequest(id){if(typeof id!=='string'||id.length<1||id.length>128)throw new Error('缺少有效的操作编号');return id;}
  pickup(player,dropId,requestId) {
    return this.enqueue(player,async()=>{
      if(player.dead||player._dying)throw new Error('死亡状态无法拾取');
      this.validateRequest(requestId);player._economyBusy=true;
      try{await this.store.savePlayer(player.id,cloneState(player));const outcome=await this.store.claimDrop({playerId:player.id,requestId,dropId,mutator:(state,drop)=>{
        if(drop.mapId!==player.mapId||distance(player,drop)>1.5)throw new Error('物品不在可拾取范围');
        if(drop.kind==='bag'||drop.metadata?.kind==='bag'){for(const item of drop.metadata?.items||[])addInventory(state,item.kind,item.itemId,item.quantity,item);}
        else addInventory(state,drop.kind||drop.metadata?.kind||'item',drop.itemId,drop.quantity,drop.metadata);normalizeWeapons(state,this.content.weaponProfiles);return{picked:drop.id};
      }});if(!outcome.duplicate)this.adoptEconomy(player,outcome.state);this.maps.get(outcome.drop.mapId)?.drops.delete(outcome.drop.id);this.notice(player,'已拾取物品');}
      finally{player._economyBusy=false;}
    });
  }
  craft(player,recipeId,requestId) {
    return this.enqueue(player,async()=>{if(player.dead)throw new Error('死亡状态无法合成');this.validateRequest(requestId);
      await this.store.savePlayer(player.id,cloneState(player));
      const outcome=await this.store.commitPlayer(player.id,requestId,state=>applyRecipe(state,this.content.getRecipe(recipeId),this.content.database));if(!outcome.duplicate)this.adoptEconomy(player,outcome.state);this.notice(player,'合成成功');
    });
  }
  inventoryAction(player,message){return this.enqueue(player,async()=>{
    if(player.dead||player._dying)throw new Error('死亡状态无法整理或丢弃');this.validateRequest(message.requestId||`sort:${randomUUID()}`);
    await this.store.savePlayer(player.id,cloneState(player));
    if(message.action==='sort'){
      const outcome=await this.store.commitPlayer(player.id,message.requestId||`sort:${randomUUID()}`,state=>{const next={inventory:[]};for(const i of state.inventory||[])addInventory(next,i.kind,i.itemId,i.quantity,i);state.inventory=next.inventory.sort((a,b)=>['item','weapon','armor'].indexOf(a.kind)-['item','weapon','armor'].indexOf(b.kind)||a.itemId-b.itemId);return{sorted:true};});
      if(!outcome.duplicate)this.adoptEconomy(player,outcome.state);this.notice(player,'背包已整理');return;
    }
    if(message.action!=='drop')throw new Error('未知背包操作');this.validateRequest(message.requestId);
    const kind=message.kind,itemId=Number(message.itemId),quantity=Number(message.quantity);
    if(!Number.isSafeInteger(quantity)||quantity<=0||!['item','weapon','armor'].includes(kind)||!Number.isSafeInteger(itemId)||itemId<=0)throw new Error('丢弃数量或物品无效');
    const entry=kind==='weapon'?player.inventory.find(i=>i.kind===kind&&i.itemId===itemId&&(!message.instanceId||i.instanceId===message.instanceId)):null;
    if(kind==='weapon'&&(!entry||quantity!==1))throw new Error('请选择一件具体武器丢弃');
    const metadata=entry?structuredClone(entry):{};
    const outcome=await this.store.createDrops({playerId:player.id,requestId:message.requestId,drops:[{kind,itemId,quantity,mapId:player.mapId,x:player.x,y:player.y,metadata}],mutator:state=>{addInventory(state,kind,itemId,-quantity,metadata);if(state.equips?.[kind]===itemId&&(!state.inventory.some(i=>i.kind===kind&&i.itemId===itemId)||state.equips.weaponInstanceId===entry?.instanceId)){state.equips[kind]=0;if(kind==='weapon')state.equips.weaponInstanceId=null;}return{dropped:true};}});
    if(!outcome.duplicate){this.adoptEconomy(player,outcome.state);for(const d of outcome.drops)this.maps.get(d.mapId)?.drops.set(d.id,d);}this.notice(player,'物品已丢在脚下');
  });}
  useItem(player,itemId,requestId) {
    return this.enqueue(player,async()=>{if(player.dead)throw new Error('死亡状态无法使用物品');this.validateRequest(requestId);itemId=Number(itemId);
      const item=this.content.database.Items[itemId];if(!item||!item.effects?.some(e=>[11,12,22].includes(e.code)))throw new Error('该物品暂无可用的场景效果');
      await this.store.savePlayer(player.id,cloneState(player));
      const outcome=await this.store.commitPlayer(player.id,requestId,state=>{if(!(state.inventory||[]).some(i=>i.kind==='item'&&i.itemId===itemId&&i.quantity>0))throw new Error('没有该物品');if(item.consumable)addInventory(state,'item',itemId,-1);return{itemId};});
      if(outcome.duplicate)return;this.adoptEconomy(player,outcome.state);
      this.hit(player,player,item,null);this.persist(player);
    });
  }
  equip(player,kind,itemId,instanceId=null) {
    return this.enqueue(player,async()=>{if(player.dead)throw new Error('死亡状态无法装备');itemId=Number(itemId);if(!['weapon','armor'].includes(kind))throw new Error('无效装备类型');
      const entry=player.inventory.find(i=>i.kind===kind&&i.itemId===itemId&&i.quantity>0&&(!instanceId||i.instanceId===instanceId));
      if(itemId&&!entry)throw new Error('没有该装备');const next=cloneState(player);next.equips[kind]=itemId;if(kind==='weapon')next.equips.weaponInstanceId=entry?.instanceId||null;this.recalculate(next);await this.store.savePlayer(player.id,next);this.adoptEconomy(player,next);this.recalculate(player);
    });
  }
  async respawn(player) {
    if(!player.dead||player._dying)return;player.dead=false;this.recalculate(player);player.hp=player.maxHp;player.mp=player.maxMp;player.states=[];
    await this.transfer(player,this.content.database.System.startMapId||1,this.content.database.System.startX||0,this.content.database.System.startY||0);
  }
  async developer(player,action) {
    if(!this.devTools)throw new Error('开发工具未启用');
    if(action==='loadout'){
      return this.enqueue(player,async()=>{player.dead=false;player.skills=this.content.database.Skills.filter(s=>s?.name&&s.damage?.type).map(s=>s.id);player.skills=[...new Set([1,...player.skills])];player.gold=10000;
        for(const [kind,db]of [['item','Items'],['weapon','Weapons'],['armor','Armors']])for(const item of this.content.database[db])if(item?.name&&!/^-|spare/i.test(item.name)){const owned=player.inventory.find(i=>i.kind===kind&&i.itemId===item.id)?.quantity||0;addInventory(player,kind,item.id,Math.max(0,(kind==='item'?10:1)-owned));}
        this.recalculate(player);player.hp=player.maxHp;player.mp=player.maxMp;await this.store.savePlayer(player.id,cloneState(player));this.notice(player,'开发测试物品和现有技能已发放');});
    }
    if(action==='spawnEnemies'){
      const map=this.maps.get(player.mapId);for(let i=0;i<3;i++){const pos=this.content.findSpawn(map.id,player.x+3+i,player.y+2),enemy=this.content.database.Enemies[i+1];if(!pos||!enemy)continue;const raw={id:100000+this.tick*3+i,name:enemy.name,x:pos.x,y:pos.y,pages:[{conditions:{},trigger:0,priorityType:1,image:{characterName:'Monster',characterIndex:i,direction:2,pattern:1,tileId:0},list:[{code:108,parameters:[`enemy_id : ${i+1}`]},{code:0,parameters:[]}]}]};this.addEvent(map,raw,map.id,pos);}
      this.notice(player,'已生成三只测试怪物，使用现有敌人数据库');return;
    }
    if(action==='zone'){this.maps.get(player.mapId).zone={startsAt:this.now+10000,endsAt:this.now+40000,damage:10};this.notice(player,'测试禁区：10 秒后生效，持续30秒；离开本地图即可躲避');return;}
    throw new Error('未知开发操作');
  }
  async command(player,message) {
    if(!player?._connected||!message||typeof message.type!=='string')return;
    switch(message.type){
      case'navigate':return this.navigation.set(player,message);
      case'move':this.navigation.cancel(player);return this.move(player,Number(message.direction),message.seq);
      case'attack':return this.attack(player,Number(message.skillId||1),message.requestId||randomUUID());
      case'interact':return this.interact(player,message.targetId);
      case'dialogue':return this.events.choose(player,message.choice);
      case'pickup':return this.pickup(player,message.entityId,message.requestId);
      case'craft':return this.craft(player,message.recipeId,message.requestId);
      case'useItem':return this.useItem(player,message.itemId,message.requestId);
      case'equip':return this.equip(player,message.kind,message.itemId,message.instanceId);
      case'inventory':return this.inventoryAction(player,message);
      case'respawn':return this.respawn(player);
      case'travel':{if(!this.devTools)throw new Error('地图跳转仅限开发模式');if(player.dead)throw new Error('请先重生');const map=this.content.getMap(Number(message.mapId));if(!map)throw new Error('地图不存在');return this.transfer(player,map.id,Math.floor(map.width/2),Math.floor(map.height/2));}
      case'dev':return this.developer(player,message.action);
      default:throw new Error('未知操作');
    }
  }
  update(dt=.05) {
    this.now=this.clock();this.tick++;if(this.paused){if(this.tick%2===0)for(const p of this.players.values())this.sendSnapshot(p);return;}this.events.update(dt);
    for(const player of this.players.values()){if(player.hp<=0&&!player.dead)this.kill(player,null);player.states=(player.states||[]).filter(s=>s.expires>this.now);this.offlineAI.update(player);this.navigation.update(player);}
    for(const map of this.maps.values()) {
      if(![...this.players.values()].some(p=>p.mapId===map.id))continue;
      for(const event of map.events.values())if(event.enemyId){
        if(event.dead){if(event.respawnAt<=this.now){event.dead=false;event.erased=false;event.x=event.homeX;event.y=event.homeY;this.setEnemyStats(event,this.content.database.Enemies[event.enemyId]);}continue;}
        if(event._eventRouteOwner)continue;
        const target=this.targets(event).filter(p=>distance(p,event)<=7).sort((a,b)=>distance(a,event)-distance(b,event))[0];if(!target)continue;
        event.direction=Math.abs(target.x-event.x)>Math.abs(target.y-event.y)?(target.x>event.x?6:4):(target.y>event.y?2:8);
        if(distance(target,event)<=1&&this.now>=event.nextAttack){event.nextAttack=this.now+1100;this.hit(event,target,this.content.database.Skills[1]);}
        else if(this.now>=event.nextMove){event.nextMove=this.now+650;if(this.canMove(event,event.direction)){const[dx,dy]=DIRECTIONS[event.direction];Object.assign(event,this.content.wrapPosition(map.id,event.x+dx,event.y+dy));}}
      }
      for(const attack of map.projectiles.values()) {
        if(this.now>=attack.expires||attack.source.dead||attack.source.mapId!==map.id){map.projectiles.delete(attack.id);continue;}
        if(attack.projectile){this.advanceProjectile(attack,dt);if(!attack.expires){map.projectiles.delete(attack.id);continue;}}
        this.resolveAttack(attack);
      }
      if(map.zone&&this.now>map.zone.endsAt)map.zone=null;
      if(map.zone&&this.now>=map.zone.startsAt&&this.tick%20===0)for(const p of this.players.values())if(p.mapId===map.id&&!p.dead&&!p._transferring){this.damage(p,map.zone.damage);this.broadcast(map.id,{type:'effect',kind:'damage',x:p.x,y:p.y,value:map.zone.damage,targetId:p.id});}
    }
    if(this.tick%2===0)for(const p of this.players.values())this.sendSnapshot(p);
    if(this.now-this.lastSave>=5000){this.lastSave=this.now;for(const p of this.players.values())if(!p._dying&&!p._transferring)this.persist(p);}
  }
  snapshot(player) {
    const map=this.maps.get(player.mapId);if(!map)return null;
    const eventViews=[];for(const e of map.events.values()){
      const page=this.events.pageFor?.(player,e,map.id);
      eventViews.push({id:e.id,eventId:e.eventId,name:e.name,x:e.x,y:e.y,direction:e.direction,image:page?.image||e.image,priorityType:page?.priorityType??e.priorityType,enemyId:e.enemyId,hp:e.hp,maxHp:e.maxHp,erased:e.erased||!page,disabled:!!page?.engineDisabledReason,service:e.service});
    }
    return{type:'snapshot',tick:this.tick,serverTime:this.now,playerId:player.id,mapId:map.id,devTools:this.devTools,pvp:map.pvp,
      players:[...this.players.values()].filter(p=>p.mapId===map.id).map(p=>({id:p.id,name:p.name,x:p.x,y:p.y,direction:p.direction,characterName:p.characterName,characterIndex:p.characterIndex,hp:p.hp,maxHp:p.maxHp,mp:p.mp,maxMp:p.maxMp,level:p.level,dead:p.dead,connected:p._connected,appearance:p.appearance,offlineBehavior:normalizeOfflineBehavior(p.offlineBehavior),offlineActivity:p.offlineActivity||null})),events:eventViews,drops:[...map.drops.values()],projectiles:[...map.projectiles.values()].filter(p=>p.projectile).map(p=>({id:p.id,x:p.x,y:p.y,direction:p.direction,skillId:p.skillId,image:p.tool?.image})),self:{inventory:player.inventory,gold:player.gold,skills:player.skills,equips:player.equips,ending:player.ending,profile:player.profile,appearance:player.appearance,offlineBehavior:normalizeOfflineBehavior(player.offlineBehavior),offlineActivity:player.offlineActivity||null,navigation:player.navigation||null},zone:map.zone,instance:this.hooks.snapshot?.(player)||null};
  }
  sendSnapshot(player){const snapshot=this.snapshot(player);if(snapshot)this.send(player.id,snapshot);}
  async close(){for(const id of [...this.players.keys()])await this.detach(id);}
}
