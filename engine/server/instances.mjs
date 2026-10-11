import {randomUUID} from 'node:crypto';
import {World} from './world.mjs';
import {Round,ensureGameContent} from './rounds.mjs';
import {normalizeOfflineBehavior} from './offline-ai.mjs';
import {PUBLIC_CITY_SERVICES,bindPublicCityServices,publicCityArrival} from './public-city.mjs';

/** Routes each account to exactly one authoritative world; map ids are local to that world. */
export class GameHost {
  constructor({content,store,devTools=false,appearanceCatalog=null,clock=Date.now,random=Math.random}){
    Object.assign(this,{content,store,devTools,appearanceCatalog,clock,random});this.scenario=ensureGameContent(content);this.rounds=new Map();this.locations=new Map();this.connecting=new Set();this.transitions=new Map();this._diagnostics=new Map();
    this.world=this.lobbyWorld=new World({content,store,devTools,clock,random,retainDisconnected:true,hooks:{onMapReady:map=>this.decorateLobby(map),onService:(player,event)=>this.serviceOpen(player,event.service.kind)}});
    this.ready=Promise.resolve();this.initialized=false;
  }
  init(){if(!this.initialized){this.initialized=true;this.ready=this.initialize();}return this.ready;}
  async initialize(){if(this.store.abortUnfinishedRounds)await this.store.abortUnfinishedRounds();}
  get players(){const result=new Map(this.world.players);for(const r of this.rounds.values())for(const [id,p]of r.world.players)result.set(id,p);return result;}
  get tick(){return this.world.tick;}
  get runtimeDiagnostics(){for(const[k,v]of this.world.runtimeDiagnostics)this._diagnostics.set(k,v);for(const[id,r]of this.rounds)for(const[k,v]of r.world.runtimeDiagnostics)this._diagnostics.set(`${id}:${k}`,v);while(this._diagnostics.size>2000)this._diagnostics.delete(this._diagnostics.keys().next().value);return this._diagnostics;}
  playerWorld(id){return this.locations.get(id)?.world||this.world;}
  getPlayer(id){return this.playerWorld(id).players.get(id);}
  notice(player,message){if(player)this.playerWorld(player.id).notice(this.getPlayer(player.id)||player,message);}
  async decorateLobby(map){bindPublicCityServices(map);}
  serviceOpen(player,service='instance'){
    const world=this.playerWorld(player.id);if(service==='appearance'){world.send(player.id,{type:'service',service:'appearance',action:'open'});return;}
    world.send(player.id,{type:'service',service:'instance',action:'open',scenario:this.scenario,instances:[...this.rounds.values()].filter(r=>r.status==='waiting').map(r=>r.snapshot()),modes:['pve','pvpve'],current:this.locations.get(player.id)?.snapshot()||null});
  }
  async connect(account,send){await this.init();if(this.connecting.has(account.id))throw new Error('角色正在连接');this.connecting.add(account.id);
    try{while(this.transitions.has(account.id))await this.transitions.get(account.id).catch(()=>{});const settling=this.locations.get(account.id);if(settling?.status==='ending'){await (settling._finishPromise||this.finishRound(settling,settling.pendingResult));}const existing=this.getPlayer(account.id);if(existing){const p=await this.playerWorld(account.id).reconnect(account.id,send);return p;}
      account=await this.store.loadPlayer(account.id)||account;
      account={...account,state:publicCityArrival(account.state?.mapId?account.state:this.world.defaultState())};
      const profile=await this.store.loadProfile?.(account.id)||{offlineBehavior:'stay'};
      const player=await this.world.connect(account,send,{announce:false});this.applyProfile(player,profile);this.world.sendSnapshot(player);return player;
    }finally{this.connecting.delete(account.id);}
  }
  applyProfile(player,profile){player.profile=structuredClone(profile);player.appearance=structuredClone(profile.appearance||null);player.offlineBehavior=normalizeOfflineBehavior(profile.offlineBehavior);this.playerWorld(player.id).offlineAI.cancel(player);if(profile.appearance?.characterName){player.characterName=profile.appearance.characterName;player.characterIndex=profile.appearance.characterIndex||0;}}
  async latestProfile(id,fallback={}){try{return await this.store.loadProfile?.(id)||fallback;}catch(error){this._diagnostics.set(`profile:${id}`,error.message);return fallback;}}
  updateProfile(id,profile){const p=this.getPlayer(id);if(p){this.applyProfile(p,profile);this.playerWorld(id).markDirty(p);this.playerWorld(id).sendSnapshot(p);}return p;}
  assertAtEntrance(player){const entrance=PUBLIC_CITY_SERVICES.instance,guide=this.world.maps.get(entrance.mapId)?.events.get(`service:${entrance.id}`);if(player.dead||player._dying||player.mapId!==entrance.mapId||!guide||Math.abs(player.x-guide.x)+Math.abs(player.y-guide.y)>1)throw new Error('请到中央广场的远征接引员旁进入副本');}
  async disconnect(id){if(this.transitions.has(id))await this.transitions.get(id).catch(()=>{});const r=this.locations.get(id);if(r?.status==='ending')await (r._finishPromise||this.finishRound(r,r.pendingResult)).catch(()=>{});return this.playerWorld(id).disconnect(id);}
  exclusive(id,operation){if(this.transitions.has(id))return Promise.reject(new Error('正在切换世界，请稍候'));const work=Promise.resolve().then(operation);this.transitions.set(id,work);return work.finally(()=>{if(this.transitions.get(id)===work)this.transitions.delete(id);});}
  async create(player,mode){if(!['pve','pvpve'].includes(mode))throw new Error('请选择PvE或PvPvE');if(this.locations.has(player.id))throw new Error('你已经在副本内');this.assertAtEntrance(player);
    const id=randomUUID();await this.store.createRound({id,definitionId:this.scenario.id,metadata:{mode,ownerId:player.id}});
    const round=new Round({id,mode,ownerId:player.id,content:this.content,store:this.store,host:this,clock:this.clock,random:this.random});this.rounds.set(id,round);
    try{await this.join(player,id);return round;}catch(error){await this.store.finishRound(id,{reason:'creation-failed'});this.rounds.delete(id);throw error;}
  }
  async join(player,instanceId){if(this.locations.has(player.id))throw new Error('你已经在副本内');this.assertAtEntrance(player);const round=this.rounds.get(instanceId);if(!round||round.status!=='waiting')throw new Error('该等待副本不存在');if(round.members.size>=this.scenario.maxPlayers)throw new Error('副本已满');
    return round.serialize(async()=>{
      if(round.status!=='waiting'||round.members.size>=this.scenario.maxPlayers)throw new Error('副本已开始或已满');
      const state=round.seed(player),account=await this.store.joinRound(round.id,player.id,state);
      const send=player._send,profile=player.profile||{};let joined;
      try{await this.world.detach(player.id);joined=await round.world.connect({...account,id:player.id,username:player.name,state:account.state||state},send,{announce:false});this.locations.set(player.id,round);this.applyProfile(joined,await this.latestProfile(player.id,profile));round.members.set(player.id,{id:player.id,name:player.name,result:null});round.announce(`${player.name} 已加入；创建者可在副本面板开始。`);round.world.sendSnapshot(joined);this.serviceOpen(joined);return joined;}
      catch(error){await round.world.detach(player.id,{save:false});this.locations.delete(player.id);round.members.delete(player.id);await this.store.leaveRound(round.id,player.id,{reason:'join-failed'});if(!this.world.players.has(player.id)){const original=await this.store.loadPlayer(player.id);const restored=await this.world.connect(original,send,{announce:false});this.applyProfile(restored,await this.latestProfile(player.id,profile));this.world.sendSnapshot(restored);}throw error;}
    });
  }
  returnPlayer(round,player,outcome='left'){return this.exclusive(player.id,()=>this.returnPlayerNow(round,player,outcome));}
  async returnPlayerNow(round,player,outcome='left'){
    if(this.locations.get(player.id)!==round)return;
    player._transferring=true;player._departure||={outcome,recorded:false};outcome=player._departure.outcome;
    if(!player._departure.recorded){if(!player._departure.flushed){await round.world.flush(player);player._departure.flushed=true;}await this.store.leaveRound(round.id,player.id,{outcome});player._departure.recorded=true;}
    const member=round.members.get(player.id);if(member)member.result=outcome;
    const restored=await this.restoreLobby(round,player);
    this.world.send(player.id,{type:'instanceResult',result:{instanceId:round.id,outcome,reason:outcome}});this.world.sendSnapshot(restored);
    if(round.status==='waiting'){round.members.delete(player.id);if(round.ownerId===player.id)round.ownerId=round.members.keys().next().value||null;}
    if(round.world.players.size===0&&['waiting','active'].includes(round.status))await this.finishRoundNow(round,{reason:'all-left',success:false});
    return restored;
  }
  async restoreLobby(round,player){
    const connected=player._connected,account=await this.store.loadPlayer(player.id),profile=await this.store.loadProfile?.(player.id)||player.profile||{};
    // Keep the old entity until the destination is durable, so a failed connect can be retried.
    const restored=await this.world.connect(account,player._send,{announce:false});this.applyProfile(restored,profile);restored._connected=connected;
    await round.world.detach(player.id,{save:false});this.locations.delete(player.id);return restored;
  }
  finishRound(round,result){return round.serialize(()=>this.finishRoundNow(round,result));}
  async finishRoundNow(round,result){
    if(round.status==='ended')return round.result;if(round._finishPromise)return round._finishPromise;
    round.status='ending';round.world.paused=true;round.pendingResult=result;
    round._finishPromise=(async()=>{const players=[...round.world.players.values()];
      if(!round.result){if(!round._settlementFlushed){for(const p of players)if(!p._departure?.flushed)await round.world.flush(p);round._settlementFlushed=true;}
        const full={...result,instanceId:round.id,mode:round.mode,finishedAt:this.clock(),participants:[...round.members.values()].map(m=>({...m,outcome:m.result||((result.success&&!round.world.players.get(m.id)?.dead)?'completed':round.world.players.get(m.id)?.dead?'dead':'failed')}))};
        const committed=await this.store.finishRound(round.id,full);round.result=committed.result||full;
      }
      const full=round.result;
      for(const p of players){while(this.transitions.has(p.id))await this.transitions.get(p.id).catch(()=>{});await this.exclusive(p.id,async()=>{const restored=await this.restoreLobby(round,p);this.world.send(p.id,{type:'instanceResult',result:{...full,outcome:full.participants.find(m=>m.id===p.id)?.outcome}});this.world.sendSnapshot(restored);});}
      round.status='ended';round.phase='completed';round.world.maps.clear();round.world.events.tasks.clear();round.world.events.dialogues.clear();this.rounds.delete(round.id);return full;
    })().catch(error=>{round._finishPromise=null;round.retryFinishAt=this.clock()+1000;round.world.runtimeDiagnostics.set('settlement',error.message);throw error;});return round._finishPromise;
  }
  async command(player,message){await this.ready;player=this.getPlayer(player?.id);if(!player?._connected)return;
    if(this.transitions.has(player.id)||player._transferring)throw new Error('正在切换世界');const round=this.locations.get(player.id);
    if(!(message.type==='instance'&&['list','open'].includes(message.action))&&(round||message.contextInstanceId!==undefined)&&message.contextInstanceId!==(round?.id||null))throw new Error('操作来自旧世界或上一局，已忽略');
    if(message.type==='instance'){
      if(message.action==='list'||message.action==='open')return this.serviceOpen(player);
      if(message.action==='create')return this.exclusive(player.id,()=>this.create(player,message.mode||'pve'));
      if(message.action==='join')return this.exclusive(player.id,()=>this.join(player,message.instanceId));
      if(message.action==='start'){if(!round)throw new Error('尚未加入副本');return round.start(player);}
      if(message.action==='leave'){if(!round)throw new Error('尚未加入副本');return round.serialize(()=>this.returnPlayer(round,player,player.dead?'dead':'left'));}
      throw new Error('未知副本操作');
    }
    if(message.type==='navigate'&&message.cancel)return this.playerWorld(player.id).navigation.cancel(player);
    if(round){if(round.status!=='active')throw new Error('副本尚未开始或正在结算');if(['respawn','travel','dev'].includes(message.type))throw new Error('正式副本不能重生或使用开发功能');}
    return this.playerWorld(player.id).command(player,message);
  }
  update(dt=.05){this.world.update(dt);for(const round of this.rounds.values()){round.update(dt);if(['active','waiting'].includes(round.status))for(const p of round.world.players.values())if(p._departure&&!this.transitions.has(p.id)&&this.clock()>=(p._retryDepartureAt||0)){p._retryDepartureAt=this.clock()+1000;round.serialize(()=>this.returnPlayer(round,p,p._departure.outcome)).catch(e=>round.world.runtimeDiagnostics.set('departure',e.message));}}}
  async close(){for(const round of this.rounds.values())if(['waiting','active','ending'].includes(round.status))await this.finishRound(round,round.pendingResult||{reason:'server-shutdown',success:false});await this.world.close();}
}
