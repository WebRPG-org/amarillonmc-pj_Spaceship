import {World} from './world.mjs';
import {addInventory} from './combat.mjs';
import {MODERN_ROUND_MAPS, MODERN_ZONE_SCHEDULE, isModernRoundMap, modernEventTags, decorateModernDistrict} from './modern-district.mjs';

export const ROUND_MAPS=[11,12,13,20,21,22,...MODERN_ROUND_MAPS];
const distance=(a,b)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
const has=(p,id)=>p.inventory.some(i=>i.kind==='item'&&i.itemId===id&&i.quantity>0);

/** New scenario definitions are appended in memory; original RM files are untouched. */
export function ensureGameContent(content){
  if(content.scenario)return content.scenario;
  const items=content.database.Items,itemIds={};
  let next=Math.max(items.length-1,...items.filter(Boolean).map(i=>i.id||0))+1;
  for(const [key,name,description]of [
    ['ordinary','巡回通行证','在村口解锁本局共享出口。不会消耗，可以丢弃和转交。'],
    ['final','终局钥匙','击败封锁守卫获得，在矿道终局出口使用后结束本局。不会消耗。'],
    ['control','封锁解除组件','用于村屋控制台，解除普通禁区并开启持续禁区内的最终挑战。']]){
    const id=next++;itemIds[key]=id;items[id]={id,name,description,itypeId:2,iconIndex:key==='final'?83:84,price:0,consumable:false,scope:0,occasion:0,note:'engine scenario key',effects:[],damage:{type:0,formula:'0'}};
  }
  content.scenario={id:'rural-lockdown',name:'封锁乡野',mapIds:[...ROUND_MAPS],itemIds,maxPlayers:8,durationSeconds:1200};
  return content.scenario;
}

/** Keep authored map transitions, replace old test rewards/PvP scripts with scoped services. */
function roundContent(content){
  const maps=new Map();
  for(const id of ROUND_MAPS){
    const original=content.getMap(id);if(!original)throw new Error(`副本地图 ${id} 不存在`);
    if(MODERN_ROUND_MAPS.includes(id)&&!isModernRoundMap(original))throw new Error(`副本地图 ${id} 缺少 <modernRound> 标记`);
    const map={...original,events:original.events.map(event=>{
      if(!event)return null;
      const pages=event.pages.filter(p=>p.list.some(c=>c.code===201&&c.parameters[0]===0&&ROUND_MAPS.includes(c.parameters[1])));
      if(pages.length)return{...event,pages:pages.map(p=>({...p,conditions:{},list:p.list.filter(c=>[0,201,250].includes(c.code))}))};
      // Noninteractive decorations are safe to retain; no old autorun scripts enter a round.
      const page=event.pages.find(p=>p.list.every(c=>[0,108,408].includes(c.code)));
      if(page&&isModernRoundMap(original)){
        const tags=modernEventTags(page);
        if(tags.container||tags.enemy)return{...event,pages:[{...page,conditions:{},trigger:0,list:page.list}]};
      }
      return page?{...event,pages:[{...page,conditions:{},trigger:0,list:[{code:0,parameters:[]}]}]}:null;
    })};maps.set(id,map);
  }
  return{...content,maps,getMap:id=>maps.get(Number(id))};
}

export function addService(world,map,{id,name,x,y,service,characterName='!Crystal',characterIndex=0}){
  const spawn=world.content.findSpawn(map.id,x,y);if(!spawn)throw new Error(`服务 ${id} 没有可用位置`);
  const image={characterName,characterIndex,direction:2,pattern:1,tileId:0};
  const raw={id,name,...spawn,pages:[{conditions:{},trigger:0,priorityType:1,through:false,image,list:[{code:0,parameters:[]}]}]};
  const event=world.addEvent(map,raw,map.id);event.id=`service:${id}`;event.service=service;map.events.delete([...map.events].find(([,e])=>e===event)?.[0]);map.events.set(event.id,event);return event;
}

export class Round {
  constructor({id,mode='pve',ownerId,content,store,host,clock=Date.now,random=Math.random,durationSeconds=1200}){
    Object.assign(this,{id,mode,ownerId,host,store,clock,durationSeconds});this.scenario=ensureGameContent(content);this.status='waiting';this.phase='waiting';this.members=new Map();this.createdAt=clock();this.startedAt=null;this.ordinaryExitUnlocked=false;this.ordinaryZonesDisabled=false;this.finalExitUnlocked=false;this.boss={spawned:false,dead:false,mapId:22};this.containers=new Map();this._queue=Promise.resolve();
    this.world=new World({content:roundContent(content),store:store.forRound(id),devTools:false,clock,random,retainDisconnected:true,hooks:{
      onMapReady:map=>this.decorate(map),beforeTransfer:(player,mapId)=>{if(!ROUND_MAPS.includes(mapId))throw new Error('请通过副本出口返回外部世界');},
      onService:(player,event)=>this.interact(player,event),snapshot:()=>this.snapshot(),
      onPlayerDeath:player=>{const m=this.members.get(player.id);if(m)m.result='dead';},
      onEnemyDeath:enemy=>{if(enemy.isBoss){this.boss.dead=true;this.announce('封锁守卫已被击败，终局钥匙掉落在原地。带到终局出口结束本局。');}}
    }});this.world.paused=true;
  }
  serialize(operation){const promise=this._queue.then(operation);this._queue=promise.catch(error=>{this.world.runtimeDiagnostics.set('round-operation',error.message);});return promise;}
  snapshot(){return{id:this.id,name:this.scenario.name,mode:this.mode,status:this.status,phase:this.phase,ownerId:this.ownerId,players:[...this.members.values()].map(m=>({id:m.id,name:m.name,connected:this.world.players.get(m.id)?._connected||false,dead:this.world.players.get(m.id)?.dead||m.result==='dead',result:m.result||null})),remainingSeconds:this.startedAt?Math.max(0,Math.ceil((this.startedAt+this.durationSeconds*1000-this.clock())/1000)):this.durationSeconds,ordinaryExitUnlocked:this.ordinaryExitUnlocked,ordinaryZonesDisabled:this.ordinaryZonesDisabled,finalExitUnlocked:this.finalExitUnlocked,boss:{...this.boss},keyItems:this.scenario.itemIds,result:this.result};}
  announce(message){for(const p of this.world.players.values())this.world.notice(p,message);}
  seed(player){
    const state=this.world.defaultState();Object.assign(state,{mapId:11,x:22,y:24,characterName:player.characterName,characterIndex:player.characterIndex,skills:[1,99,231],inventory:[],equips:{weapon:1,armor:0},gold:0,switches:{},variables:{},selfSwitches:{},states:[],dead:false});
    for(const [kind,id,qty]of [['weapon',1,1],['item',7,2],['item',38,1]])if(this.world.content.database[{weapon:'Weapons',item:'Items'}[kind]][id])addInventory(state,kind,id,qty);
    this.world.recalculate(state);state.hp=state.maxHp;state.mp=state.maxMp;return state;
  }
  async decorate(map){
    map.pvp=this.mode==='pvpve';
    decorateModernDistrict(this,map);
    const service=(id,name,x,y,action,extra={})=>addService(this.world,map,{id:`${this.id}:${id}`,name,x,y,service:{kind:'round',action,...extra},characterName:action==='container'?'!Chest':'!Crystal'});
    if(map.id===11){service('exit','共享出口 · 通行证解锁',23,22,'ordinaryExit');service('supply','村口补给箱',24,22,'container',{containerId:'village'});this.containers.set('village',{items:[{kind:'item',itemId:7,quantity:3},{kind:'item',itemId:47,quantity:2},{kind:'item',itemId:48,quantity:2}],opened:false});}
    if(map.id===12){service('key','旅店保管箱 · 通行证',8,13,'container',{containerId:'inn'});this.containers.set('inn',{items:[{kind:'item',itemId:this.scenario.itemIds.ordinary,quantity:1},{kind:'item',itemId:13,quantity:2}],opened:false});}
    if(map.id===13)service('control','封锁控制台 · 需要组件',8,8,'control');
    if(map.id===20){service('parts','道路工具箱 · 解除组件',27,3,'container',{containerId:'road'});this.containers.set('road',{items:[{kind:'item',itemId:this.scenario.itemIds.control,quantity:1},{kind:'item',itemId:58,quantity:2},{kind:'item',itemId:59,quantity:2}],opened:false});}
    if(map.id===21){service('medicine','洞穴补给箱',26,12,'container',{containerId:'cave'});this.containers.set('cave',{items:[{kind:'item',itemId:7,quantity:4},{kind:'item',itemId:61,quantity:1},{kind:'item',itemId:62,quantity:1}],opened:false});}
    if(map.id===22)service('final','终局出口 · 需要守卫钥匙',12,7,'finalExit');
    // Authored weapon IDs come from validated RPG Maker note definitions.
    const profile=mode=>[...(this.world.content.weaponProfiles?.values()||[])].find(p=>p.mode===mode);
    const cache=this.containers.get(({11:'village',12:'inn',20:'road',21:'cave'})[map.id]);
    for(const mode of ({11:['throw','club'],12:['firearm'],20:['staff'],21:['throw','firearm']})[map.id]||[]){
      const weapon=profile(mode);if(!cache||!weapon)continue;
      cache.items.push({kind:'weapon',itemId:weapon.weaponId,quantity:1});
      if(weapon.ammoCost)cache.items.push({kind:'item',itemId:weapon.ammoItemId,quantity:map.id===12?20:12});
      if(mode==='staff')cache.items.push({kind:'item',itemId:14,quantity:3});
    }
  }
  async start(player){return this.serialize(async()=>{
    if(this.status!=='waiting')throw new Error('该副本已经开始');if(player.id!==this.ownerId)throw new Error('只有创建者可以开始');
    for(const id of ROUND_MAPS)await this.world.ensureMap(id);
    const startedAt=this.clock();await this.store.updateRound(this.id,{status:'active',metadata:{mode:this.mode,startedAt}});
    this.startedAt=startedAt;this.status='active';this.phase='exploration';this.world.paused=false;
    this.announce('副本开始：旅店寻找通行证，道路寻找组件，村屋控制台可解除普通禁区并开启矿道挑战。道路接驳口通往现代城区，可搜刮补给并遭遇巡逻敌人。');
    for(const p of this.world.players.values())this.world.sendSnapshot(p);
  });}
  async interact(player,event){return this.serialize(async()=>{
    if(this.status!=='active')throw new Error('等待创建者开始副本');
    if(!this.world.players.has(player.id)||player.dead||player._dying||player.mapId!==event.mapId||distance(player,event)>1)throw new Error('请靠近目标操作');
    const action=event.service.action;
    if(action==='container'){
      const container=this.containers.get(event.service.containerId);if(!container||container.opened){this.world.notice(player,'容器已被搜刮');return;}
      await this.world.enqueue(player,async()=>{const outcome=await this.world.store.claimContainer({playerId:player.id,containerId:event.service.containerId,mutator:state=>{for(const i of container.items)addInventory(state,i.kind,i.itemId,i.quantity);this.world.recalculate(state);return{container:event.service.containerId};}});if(outcome.claimed||String(outcome.claimedBy)===String(player.id))this.world.adoptEconomy(player,outcome.state);container.opened=true;event.name='已搜刮 · '+event.name;});
      this.announce(`${player.name} 搜刮了 ${event.name.replace('已搜刮 · ','')}`);return;
    }
    if(action==='ordinaryExit'){
      if(!this.ordinaryExitUnlocked){if(!has(player,this.scenario.itemIds.ordinary))throw new Error('需要持有巡回通行证；解锁后所有人可使用，通行证不消耗');this.ordinaryExitUnlocked=true;this.announce('普通出口已为本局所有人解锁。再次交互即可撤离，通行证不会消耗。');return;}
      return this.host.returnPlayer(this,player,'escaped');
    }
    if(action==='control'){
      if(this.ordinaryZonesDisabled){this.world.notice(player,'普通禁区已经解除；矿道持续禁区仍生效');return;}
      if(!has(player,this.scenario.itemIds.control))throw new Error('需要从道路工具箱取得封锁解除组件');
      this.ordinaryZonesDisabled=true;this.phase='boss';for(const map of this.world.maps.values())if(map.id!==22)map.zone=null;
      await this.spawnBoss();this.announce('普通禁区解除。矿道仍处于持续禁区，击败守卫获得终局钥匙。');return;
    }
    if(action==='finalExit'){
      if(!this.boss.dead||!has(player,this.scenario.itemIds.final))throw new Error('击败矿道守卫并携带终局钥匙才能结束本局');
      this.finalExitUnlocked=true;return this.host.finishRoundNow(this,{reason:'boss-exit',winnerId:player.id,success:true});
    }
    throw new Error('未知副本机关');
  });}
  async spawnBoss(){
    if(this.boss.spawned)return;const map=await this.world.ensureMap(22),pos=this.world.content.findSpawn(22,10,12);if(!pos)throw new Error('Boss没有可用出生点');
    const enemyId=this.world.content.database.Enemies[22]?22:this.world.content.database.Enemies.find(e=>e)?.id;if(!enemyId)throw new Error('缺少Boss数据库');
    const event=this.world.addEvent(map,{id:99001,name:'封锁守卫',...pos,pages:[{conditions:{},trigger:0,priorityType:1,image:{characterName:'$E_Ghost',characterIndex:0,direction:2,pattern:1,tileId:0},list:[{code:108,parameters:[`enemy_id : ${enemyId}`]},{code:0,parameters:[]}]}]},22);
    event.name='封锁守卫';event.isBoss=true;event.noRespawn=true;event.maxHp=event.hp=350*Math.max(1,this.members.size);event.stats={atk:35,def:10,mat:20,mdf:10,agi:10,luk:10};event.customDrops=[{kind:'item',itemId:this.scenario.itemIds.final,quantity:1,metadata:{source:'round-boss'}}];this.boss.spawned=true;this.boss.entityId=event.id;
    map.zone={startsAt:this.clock(),endsAt:this.clock()+this.durationSeconds*1000+60000,damage:5,persistent:true,label:'矿道持续禁区'};
  }
  update(dt){
    if(this.status==='ended')return;
    if(this.status==='ending'){if(!this._finishPromise&&this.clock()>=(this.retryFinishAt||0))this.host.finishRound(this,this.pendingResult||{reason:'settlement-retry',success:false}).catch(()=>{});return;}
    if(this.status==='active'){
      const elapsed=this.clock()-this.startedAt;
      if(!this.ordinaryZonesDisabled){
        const schedule=[...[12,20,21,13,11].map((mapId,index)=>({mapId,seconds:180+index*150})),...MODERN_ZONE_SCHEDULE];
        for(const {mapId,seconds}of schedule){const map=this.world.maps.get(mapId),startsAt=this.startedAt+seconds*1000;if(map&&!map.zone&&this.clock()>=startsAt-30000)map.zone={startsAt,endsAt:this.startedAt+this.durationSeconds*1000,damage:8,label:'普通禁区'};}
      }
      const allDead=this.world.players.size>0&&[...this.world.players.values()].every(p=>p.dead&&!p._dying);
      if((elapsed>=this.durationSeconds*1000||allDead)&&!this._finishing){this._finishing=this.host.finishRound(this,{reason:allDead?'all-dead':'timeout',success:false}).catch(e=>{this._finishing=null;this.world.runtimeDiagnostics.set('round-finish',e.message);});return;}
    }
    this.world.update(dt);
  }
}
