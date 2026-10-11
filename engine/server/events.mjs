import { classifyScript, classifyCommand } from './content.mjs';
import {EventTextPresentation,parseTextScript} from './text-events.mjs';
import {parseThreeDPluginCommand,resolveThreeDVariables} from './three-d.mjs';

const finite=(n,fallback=0)=>Number.isFinite(Number(n))?Number(n):fallback;
const entityId=e=>e.eventId??e.id;
const mapIdOf=(player,event)=>Number(event.mapId??player?.mapId);

/** Arithmetic-only expression parser. No JS engine, property traversal or arbitrary calls. */
export function evaluateExpression(source, {variable=()=>0, player={}, random=Math.random}={}) {
  let s=String(source).trim();if(s.length>2048)throw new Error('Expression too long');
  s=s.replace(/\$gameVariables\.value\(\s*(\d+)\s*\)/g,(_,id)=>String(finite(variable(+id))));
  s=s.replace(/\$gameActors\.actor\(\s*\d+\s*\)\.(hp|mp|mhp|mmp|level)/g,(_,key)=>String(finite(player[{mhp:'maxHp',mmp:'maxMp'}[key]||key])));
  const tokens=s.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|Math\.(?:round|floor|ceil|abs|min|max|randomInt)|true|false|===|!==|==|!=|>=|<=|&&|\|\||[()+\-*/%!,<>]/g)||[];
  if(tokens.join('')!==s.replace(/\s+/g,'')||tokens.length>256)throw new Error('Unsupported expression');
  let i=0;
  const ops={'||':1,'&&':2,'==':3,'===':3,'!=':3,'!==':3,'>':4,'<':4,'>=':4,'<=':4,'+':5,'-':5,'*':6,'/':6,'%':6};
  function atom(){const t=tokens[i++];if(t==='('){const n=expression(0);if(tokens[i++]!==')')throw new Error('Expected closing parenthesis');return n;}if(t==='-'||t==='+'||t==='!'){const n=atom();return t==='-'?-n:t==='+'?+n:!n;}if(t==='true'||t==='false')return t==='true';if(t?.startsWith('Math.')){if(tokens[i++]!=='(')throw new Error('Expected function arguments');const args=[];if(tokens[i]!==')'){args.push(expression(0));while(tokens[i]===','){i++;args.push(expression(0));}}if(tokens[i++]!==')')throw new Error('Expected closing function');const name=t.slice(5);if(name==='randomInt')return Math.floor(random()*Math.max(0,finite(args[0])));return Math[name](...args);}if(t!==undefined&&Number.isFinite(Number(t)))return Number(t);throw new Error('Expected number');}
  function expression(min){let left=atom();while(i<tokens.length&&(ops[tokens[i]]??-1)>=min){const op=tokens[i++],right=expression(ops[op]+1);switch(op){case '+':left+=right;break;case '-':left-=right;break;case '*':left*=right;break;case '/':left/=right;break;case '%':left%=right;break;case '>':left=left>right;break;case '<':left=left<right;break;case '>=':left=left>=right;break;case '<=':left=left<=right;break;case '==':case '===':left=left===right;break;case '!=':case '!==':left=left!==right;break;case '&&':left=!!left&&!!right;break;case '||':left=!!left||!!right;break;}}return left;}
  const result=expression(0);if(i!==tokens.length||typeof result==='number'&&!Number.isFinite(result))throw new Error('Invalid expression result');return result;
}

/** Server-owned scheduling; waits never depend on a client's scene or frame rate. */
export class EventRuntime {
  constructor({content,world}) {this.content=content;this.world=world;this.tasks=new Map();this.dialogues=new Map();this.notified=new Set();this.cooldowns=new Map();this.erasedViews=new Map();this.templateSpawns=new Map();this.time=0;this.sequence=0;this.nextTaskIndex=0;this.budgetPerTask=80;this.budgetPerTick=1200;this.maxTasks=512;this.presentation=new EventTextPresentation(this);}
  variable(player,id){return this.world.getVariable?.(player,id)??player?.variables?.[id]??0;}
  switch(player,id){return this.world.getSwitch?.(player,id)??player?.switches?.[id]??false;}
  setVariable(player,id,value){if(!Number.isInteger(+id)||+id<=0||+id>100000)return;value=typeof value==='number'?Math.floor(value):value;if(this.world.setVariable)this.world.setVariable(player,+id,value);else(player.variables??={})[id]=value;}
  setSwitch(player,id,value){if(!Number.isInteger(+id)||+id<=0||+id>100000)return;if(this.world.setSwitch)this.world.setSwitch(player,+id,!!value);else(player.switches??={})[id]=!!value;}
  selfKey(player,event,mapId=mapIdOf(player,event),letter='A'){return `${mapId}:${event.id??entityId(event)}:${letter}`;}
  diagnostic(player,message,key=message){const id=`${player?.id||'system'}:${key}`;if(this.notified.has(id))return;this.notified.add(id);if(this.notified.size>10000)this.notified.delete(this.notified.values().next().value);if(this.world.runtimeDiagnostics instanceof Map){this.world.runtimeDiagnostics.set(`event:${key}`,message);if(this.world.runtimeDiagnostics.size>2000)this.world.runtimeDiagnostics.delete(this.world.runtimeDiagnostics.keys().next().value);}this.world.notice?.(player,message);}
  expression(source,player){return evaluateExpression(source,{variable:id=>this.variable(player,id),player,random:this.world.random?.bind(this.world)||Math.random});}
  inventory(player,kind,id){return(player?.inventory||[]).filter(x=>x.kind===kind&&x.itemId===Number(id)).reduce((n,x)=>n+finite(x.quantity),0);}
  pageFor(player,event,mapId=mapIdOf(player,event)){
    let erased=this.erasedViews.get(player?.id);if(erased&&erased.mapId!==mapId){this.erasedViews.delete(player.id);erased=null;}
    if(event.erased||erased?.ids.has(event.id??entityId(event)))return null;
    const pages=event.pages||event.raw?.pages||[];
    for(let i=pages.length-1;i>=0;i--){const page=pages[i],c=page.conditions||{};
      if(c.switch1Valid&&!this.switch(player,c.switch1Id)||c.switch2Valid&&!this.switch(player,c.switch2Id)||c.variableValid&&this.variable(player,c.variableId)<c.variableValue||c.selfSwitchValid&&!player?.selfSwitches?.[this.selfKey(player,event,mapId,c.selfSwitchCh)]||c.itemValid&&!this.inventory(player,'item',c.itemId)||c.actorValid&&c.actorId!==(player?.actorId||1))continue;
      return {...page,page,index:i};
    }return null;
  }
  refreshMap(mapState){
    for(const event of mapState.events.values()){
      event.mapId=mapState.id;event.pages??=event.raw?.pages||[];
      const publicPage=[...event.pages].reverse().find(p=>{const c=p.conditions||{};return!c.switch1Valid&&!c.switch2Valid&&!c.variableValid&&!c.selfSwitchValid&&!c.itemValid&&!c.actorValid;});
      if(publicPage){event.image??={...publicPage.image};event.priorityType??=publicPage.priorityType;event.direction??=publicPage.image?.direction||2;}
    }
  }
  start(player,eventEntity){
    if(!player||player.dead||player._dying||player._economyBusy||!eventEntity||this.dialogues.has(player.id))return false;
    const selected=this.pageFor(player,eventEntity);if(!selected)return false;
    if(selected.page.engineDisabledReason){this.diagnostic(player,selected.page.engineDisabledReason,`disabled:${mapIdOf(player,eventEntity)}:${entityId(eventEntity)}`);return false;}
    const key=`${player.id}:interactive`;if(this.tasks.has(key))return false;
    const task=this.makeTask(player,eventEntity,selected.page.list||[],key,selected.index,false);if(!task)return false;
    this.run(task,this.budgetPerTask);return true;
  }
  makeTask(player,event,list,key,pageIndex,automatic){if(this.tasks.size>=this.maxTasks){this.diagnostic(player,'Event task limit reached');return null;}const task={id:++this.sequence,key,playerId:player.id,event,mapId:mapIdOf(player,event),pageIndex,automatic,list,index:0,stack:[],branches:{},choiceBranches:{},wait:0,waiting:null,steps:0};this.tasks.set(key,task);return task;}
  finish(task){this.tasks.delete(task.key);for(const entity of task.claimedEntities||[])if(entity._eventRouteOwner===task.key)delete entity._eventRouteOwner;if(this.dialogues.get(task.playerId)===task){this.dialogues.delete(task.playerId);this.world.send(task.playerId,{type:'dialogue',close:true});}if(task.automatic)this.cooldowns.set(task.key,this.time+.25);}
  cancel(player){const id=typeof player==='object'?player.id:player;for(const task of [...this.tasks.values()])if(task.playerId===id)this.finish(task);this.dialogues.delete(id);this.erasedViews.delete(id);this.presentation.cancel(id);for(const key of this.cooldowns.keys())if(key.startsWith(`${id}:`))this.cooldowns.delete(key);}
  onTransfer(player){this.cancel(player);}
  choose(player,choice){const task=this.dialogues.get(player.id);if(!task)return false;
    if(task.waiting?.kind==='choice'){
      const index=typeof choice==='object'?choice?.index:Number(choice);
      if(!Number.isInteger(index)||index<0||index>=task.waiting.choices.length){if(index===-1&&task.waiting.cancelType>=0){const target=task.waiting.cancelType,meta=task.waiting.choiceMetadata?.[target];if(target>=task.waiting.choices.length||meta?.hidden||meta?.disabled)return false;task.choiceBranches[task.waiting.indent]=target;}else if(index===-1&&task.waiting.cancelType===-2)task.choiceBranches[task.waiting.indent]=-2;else return false;}
      else {const meta=task.waiting.choiceMetadata?.[index];if(meta?.hidden||meta?.disabled)return false;task.choiceBranches[task.waiting.indent]=index;}
    }
    task.waiting=null;this.dialogues.delete(player.id);this.world.send(player.id,{type:'dialogue',close:true});this.run(task,this.budgetPerTask);return true;
  }
  update(dtSeconds){this.time+=Math.max(0,Math.min(1,finite(dtSeconds)));this.presentation.update();let budget=this.budgetPerTick;
    for(const player of this.world.players.values()){
      if(player._connected===false||player.dead||player._dying||player._economyBusy||player._economyUncertain||player._transferring)continue;
      const mapState=this.world.maps.get(player.mapId);if(!mapState)continue;
      for(const event of mapState.events.values()){
        const selected=this.pageFor(player,event);if(!selected)continue;const {page,index}=selected;
        if(page.engineDisabledReason)continue;
        if(![3,4].includes(page.trigger))continue;
        const key=`${player.id}:auto:${player.mapId}:${event.id}:${index}`;
        if(!this.tasks.has(key)&&(this.cooldowns.get(key)||0)<=this.time)this.makeTask(player,event,page.list||[],key,index,true);
      }
      for(const ce of this.content.database.CommonEvents||[])if(ce&&[1,2].includes(ce.trigger)&&this.switch(player,ce.switchId)){
        const key=`${player.id}:common:${ce.id}`;if(!this.tasks.has(key)&&(this.cooldowns.get(key)||0)<=this.time)this.makeTask(player,{id:`common:${ce.id}`,eventId:0,mapId:player.mapId,name:ce.name},ce.list||[],key,0,true);
      }
    }
    const scheduled=[...this.tasks.values()],start=this.nextTaskIndex%Math.max(1,scheduled.length);
    for(let offset=0;offset<scheduled.length;offset++){
      const index=(start+offset)%scheduled.length,task=scheduled[index];this.nextTaskIndex=index+1;
      const player=this.world.players.get(task.playerId);if(!player||player.dead||player._dying||player.mapId!==task.mapId){this.finish(task);continue;}if(player._economyBusy)continue;
      if(task.automatic&&task.event.pages){const page=this.pageFor(player,task.event);if(!page||page.index!==task.pageIndex){this.finish(task);continue;}}
      if(task.waiting?.kind==='queued'&&!this.dialogues.has(player.id)){const message=task.waiting.message;task.waiting=null;this.dialogue(task,player,...message);}
      if(task.waiting?.kind==='gab'&&!this.presentation.gabRunning(player))task.waiting=null;
      if(task.waiting)continue;if(task.wait>0){task.wait=Math.max(0,task.wait-dtSeconds);if(task.wait>0)continue;}
      if(budget<=0){this.nextTaskIndex=index;break;}budget-=this.run(task,Math.min(this.budgetPerTask,budget));
    }
  }
  run(task,budget){let used=0;const player=this.world.players.get(task.playerId);if(!player){this.finish(task);return used;}
    while(this.tasks.has(task.key)&&!task.waiting&&task.wait<=0&&used<budget){
      if(player._economyBusy||player._economyUncertain||player._transferring)break;
      if(task.forcedRoute){
        const route=task.forcedRoute,instruction=route.list[route.index++];used++;task.steps++;
        if(task.steps>20000){this.diagnostic(player,'Movement route exceeded instruction budget');this.finish(task);break;}
        if(!instruction||instruction.code===0){if(route.repeat){route.index=0;task.wait=.25;}else {if(route.target._eventRouteOwner===task.key)delete route.target._eventRouteOwner;task.forcedRoute=null;}continue;}
        try{this.route(task,player,route.target,instruction);}catch(error){this.diagnostic(player,`Event route: ${error.message}`,`${task.mapId}:${entityId(task.event)}:route:${error.message}`);this.finish(task);}continue;
      }
      if(task.index>=task.list.length){if(task.stack.length){Object.assign(task,task.stack.pop());continue;}this.finish(task);break;}
      const command=task.list[task.index++];used++;task.steps++;
      if(task.steps>20000){this.diagnostic(player,'Event exceeded total instruction budget',`budget:${task.mapId}:${entityId(task.event)}`);this.finish(task);break;}
      try{this.execute(task,player,command);}catch(error){this.diagnostic(player,`Event ${entityId(task.event)} command ${command.code}: ${error.message}`,`${task.mapId}:${entityId(task.event)}:${command.code}:${error.message}`);this.finish(task);}
    }return used;
  }
  skipTo(task,indent,codes){while(task.index<task.list.length){const c=task.list[task.index];if(c.indent<indent||c.indent===indent&&codes.includes(c.code))return;task.index++;}}
  text(text){return String(text);}
  textContext(player,text=null){return this.presentation.textContext(player,text);}
  overheadFor(player,event,page=this.pageFor(player,event)){return this.presentation.overheadFor(player,event,page);}
  dialogue(task,player,text,choices,params,indent,messageSettings=this.presentation.messageSettings(player)){
    if(this.dialogues.has(player.id)&&this.dialogues.get(player.id)!==task){task.waiting={kind:'queued',message:[text,choices,params,indent,messageSettings]};return;}
    const choiceMetadata=this.presentation.choiceMetadata(player,choices);
    task.waiting=choices?{kind:'choice',choices,cancelType:params?.[1]??-1,indent,choiceMetadata}:{kind:'text'};this.dialogues.set(player.id,task);
    this.world.send(player.id,{type:'dialogue',eventId:task.event.id??entityId(task.event),text:this.text(text),choices:choices?.map(x=>this.text(x)),choiceMetadata,defaultChoice:params?.[2]??0,cancelType:params?.[1]??-1,choicePosition:params?.[3]??2,choiceBackground:params?.[4]??0,messageSettings,textContext:this.textContext(player)});
  }
  character(task,player,id){if(id===-1)return player;if(id===0)return task.event;return [...(this.world.maps.get(task.mapId)?.events.values()||[])].find(e=>entityId(e)===id);}
  gameData(task,player,p){const kind=p[4],id=p[5],field=p[6];if(kind<=2)return this.inventory(player,['item','weapon','armor'][kind],id);if(kind===3)return finite(player[['level','exp','hp','mp','maxHp','maxMp'][field]]??player.stats?.[['atk','def','mat','mdf','agi','luk'][field-6]]);if(kind===5){const c=this.character(task,player,id);return finite(c?.[['x','y','direction','screenX','screenY'][field]]);}if(kind===6)return id===0?player.actorId||1:0;if(kind===7)return[task.mapId,1,player.gold||0,player.steps||0,this.time,this.timerRemaining(player),0,0][id]||0;return 0;}
  timerRemaining(player){return Math.max(0,Math.ceil((player.eventTimer?.until||0)-this.time));}
  condition(task,player,p){switch(p[0]){
    case 0:return this.switch(player,p[1])===(p[2]===0);
    case 1:{const a=this.variable(player,p[1]),b=p[2]===0?p[3]:this.variable(player,p[3]);return[a===b,a>=b,a<=b,a>b,a<b,a!==b][p[4]];}
    case 2:return!!player.selfSwitches?.[this.selfKey(player,task.event,task.mapId,p[1])] ===(p[2]===0);
    case 3:return p[2]===0?this.timerRemaining(player)>=p[1]:this.timerRemaining(player)<=p[1];
    case 4:if(p[1]!==0&&p[1]!== (player.actorId||1))return false;return p[2]===0?true:p[2]===1?player.name===p[3]:p[2]===2?player.classId===p[3]:p[2]===3?player.skills?.includes(p[3]):p[2]===4?player.equips?.weapon===p[3]:p[2]===5?Object.values(player.equips||{}).includes(p[3]):p[2]===6?player.states?.some(s=>(s.id??s)===p[3]):false;
    case 6:return this.character(task,player,p[1])?.direction===p[2];
    case 7:return p[2]===0?player.gold>=p[1]:p[2]===1?player.gold<=p[1]:player.gold<p[1];
    case 8:return this.inventory(player,'item',p[1])>0;
    case 9:return this.inventory(player,'weapon',p[1])>0||p[2]&&player.equips?.weapon===p[1];
    case 10:return this.inventory(player,'armor',p[1])>0||p[2]&&Object.values(player.equips||{}).includes(p[1]);
    case 12:return!!this.expression(p[1],player);
    default:throw new Error(`Unsupported condition kind ${p[0]}`);
  }}
  amount(player,operation,type,value){return(type===0?finite(value):finite(this.variable(player,value)))*(operation===0?1:-1);}
  refreshPlayer(player){this.world.markDirty?.(player);this.world.send(player.id,{type:'player',player});}
  grant(task,player,kind,id,amount){
    if(!Number.isFinite(amount))throw new Error('Invalid inventory amount');
    const result=this.world.grant(player,kind,+id,Math.trunc(amount));
    if(result?.then){const waiting={kind:'promise'};task.waiting=waiting;Promise.resolve(result).then(()=>{if(this.tasks.get(task.key)===task&&task.waiting===waiting)task.waiting=null;},error=>{this.diagnostic(player,`Inventory operation failed: ${error.message}`);if(this.tasks.get(task.key)===task)this.finish(task);});}
  }
  execute(task,player,command){const p=command.parameters||[],indent=command.indent||0;
    switch(command.code){
      case 0:case 108:case 408:case 401:case 505:return;
      case 101:{
        const lines=[],settings=this.presentation.messageSettings(player,p);
        do {
          while(task.list[task.index]?.code===401)lines.push(task.list[task.index++].parameters[0]);
          const next=task.list[task.index];
          // Keep the editor's face/background/position boundaries and never discard overflow lines.
          if(settings.rows<=4||lines.length>=settings.rows||next?.code!==101||JSON.stringify(next.parameters)!==JSON.stringify(p))break;
          task.index++;
        }while(true);
        const next=task.list[task.index];if(next?.code===102){task.index++;this.dialogue(task,player,lines.join('\n'),next.parameters[0],next.parameters,next.indent,settings);}else this.dialogue(task,player,lines.join('\n'),undefined,undefined,undefined,settings);return;
      }
      case 102:this.dialogue(task,player,'',p[0],p,indent);return;
      case 402:if(task.choiceBranches[indent]!==p[0])this.skipTo(task,indent,[402,403,404]);return;
      case 403:if(task.choiceBranches[indent]!==-2)this.skipTo(task,indent,[404]);return;
      case 404:delete task.choiceBranches[indent];return;
      case 111:task.branches[indent]=this.condition(task,player,p);if(!task.branches[indent])this.skipTo(task,indent,[411,412]);return;
      case 411:if(task.branches[indent])this.skipTo(task,indent,[412]);return;
      case 412:delete task.branches[indent];return;
      case 112:return;
      case 113:this.skipTo(task,indent,[413]);task.index++;return;
      case 413:{for(let i=task.index-2;i>=0;i--)if(task.list[i].code===112&&task.list[i].indent===indent){task.index=i+1;task.wait=1/60;break;}return;}
      case 115:this.finish(task);return;
      case 117:{const ce=this.content.database.CommonEvents?.[p[0]];if(!ce)throw new Error(`Missing common event ${p[0]}`);if(task.stack.length>=16)throw new Error('Common event recursion limit');task.stack.push({list:task.list,index:task.index,branches:task.branches,choiceBranches:task.choiceBranches});task.list=ce.list;task.index=0;task.branches={};task.choiceBranches={};return;}
      case 118:return;
      case 119:{const i=task.list.findIndex(c=>c.code===118&&c.parameters[0]===p[0]);if(i>=0)task.index=i+1;return;}
      case 121:if(p[1]-p[0]>1000)throw new Error('Switch range limit');for(let id=p[0];id<=p[1];id++)this.setSwitch(player,id,p[2]===0);return;
      case 122:{if(p[1]-p[0]>1000)throw new Error('Variable range limit');let value=p[3]===0?p[4]:p[3]===1?this.variable(player,p[4]):p[3]===2?p[4]+Math.floor((this.world.random?.()??Math.random())*(p[5]-p[4]+1)):p[3]===3?this.gameData(task,player,p):p[3]===4?this.expression(p[4],player):0;for(let id=p[0];id<=p[1];id++){const old=finite(this.variable(player,id));const next=[()=>value,()=>old+value,()=>old-value,()=>old*value,()=>value?old/value:0,()=>value?old%value:0][p[2]]?.();this.setVariable(player,id,next??0);}return;}
      case 123:(player.selfSwitches??={})[this.selfKey(player,task.event,task.mapId,p[0])]=p[1]===0;return;
      case 124:player.eventTimer=p[0]===0?{until:this.time+p[1]}:null;return;
      case 125:this.grant(task,player,'gold',0,this.amount(player,p[0],p[1],p[2]));return;
      case 126:case 127:case 128:this.grant(task,player,{126:'item',127:'weapon',128:'armor'}[command.code],p[0],this.amount(player,p[1],p[2],p[3]));return;
      case 129:this.diagnostic(player,'Party-member event command has no meaning for one network player',`party:${task.mapId}:${entityId(task.event)}`);return;
      case 135:player.menuEnabled=p[0]===0;return;
      case 201:{const ids=p[0]===0?p.slice(1,4):p.slice(1,4).map(id=>this.variable(player,id));if(p[4])player.direction=p[4];this.transfer(task,player,ids);return;}
      case 203:{const c=this.character(task,player,p[0]);if(!c)throw new Error('Move target missing');if(p[1]===2){const other=this.character(task,player,p[2]);if(other){[c.x,other.x]=[other.x,c.x];[c.y,other.y]=[other.y,c.y];}}else{const x=p[1]===1?this.variable(player,p[2]):p[2],y=p[1]===1?this.variable(player,p[3]):p[3],map=this.content.getMap(task.mapId);if(x<0||y<0||x>=map.width||y>=map.height)throw new Error('Event destination outside map');c.x=x;c.y=y;}if(p[4])c.direction=p[4];return;}
      case 205:{const c=this.character(task,player,p[0]);if(!c)throw new Error('Route target missing');const route=p[1];if((route.list||[]).length>500)throw new Error('Route budget exceeded');if(c._eventRouteOwner&&this.tasks.has(c._eventRouteOwner)&&c._eventRouteOwner!==task.key){this.diagnostic(player,'Another server event already owns this movement route',`route-owner:${task.mapId}:${c.id}`);return;}const forcedRoute={target:c,list:route.list||[],index:0,repeat:!!route.repeat,skippable:!!route.skippable};const owner=route.wait?task:this.makeTask(player,task.event,[],`${task.key}:route:${++this.sequence}`,task.pageIndex,false);if(owner){owner.forcedRoute=forcedRoute;c._eventRouteOwner=owner.key;(owner.claimedEntities??=new Set()).add(c);}return;}
      case 214:{let state=this.erasedViews.get(player.id);if(!state||state.mapId!==task.mapId){state={mapId:task.mapId,ids:new Set()};this.erasedViews.set(player.id,state);}state.ids.add(task.event.id??entityId(task.event));this.finish(task);return;}
      case 230:task.wait=Math.max(0,finite(p[0]))/60;return;
      case 311:{const v=this.amount(player,p[2],p[3],p[4]);player.hp=Math.max(p[5]?0:1,Math.min(player.maxHp,player.hp+v));if(player.hp===0&&this.world.damage)this.world.damage(player,0,{source:'event'});this.refreshPlayer(player);return;}
      case 312:player.mp=Math.max(0,Math.min(player.maxMp,player.mp+this.amount(player,p[2],p[3],p[4])));this.refreshPlayer(player);return;
      case 313:player.states??=[];if(p[2]===0&&!player.states.some(s=>(s.id??s)===p[3]))player.states.push({id:p[3],expires:Number.MAX_SAFE_INTEGER});if(p[2]===1)player.states=player.states.filter(s=>(s.id??s)!==p[3]);this.refreshPlayer(player);return;
      case 314:player.hp=player.maxHp;player.mp=player.maxMp;player.states=[];player.dead=false;this.refreshPlayer(player);return;
      case 315:player.exp=Math.max(0,(player.exp||0)+this.amount(player,p[2],p[3],p[4]));this.refreshPlayer(player);return;
      case 316:player.level=Math.max(1,Math.min(99,player.level+this.amount(player,p[2],p[3],p[4])));this.refreshPlayer(player);return;
      case 317:{if(p[2]<0||p[2]>7)throw new Error('Invalid parameter index');const value=this.amount(player,p[3],p[4],p[5]);player.paramPlus??=Array(8).fill(0);player.paramPlus[p[2]]=finite(player.paramPlus[p[2]])+value;this.refreshPlayer(player);return;}
      case 318:player.skills??=[];if(p[2]===0&&!player.skills.includes(p[3]))player.skills.push(p[3]);if(p[2]===1)player.skills=player.skills.filter(x=>x!==p[3]);this.refreshPlayer(player);return;
      case 319:{const kind=p[1]===1?'weapon':'armor';if(p[2]&&!this.inventory(player,kind,p[2]))throw new Error('Requested equipment is not in inventory');(player.equips??={})[kind]=p[2];if(p[1]>2)this.diagnostic(player,'Armor slots use the engine single armor slot; detailed slot migration is pending','armor-slots');this.refreshPlayer(player);return;}
      case 320:player.name=String(p[1]).slice(0,40);this.refreshPlayer(player);return;
      case 321:player.classId=p[1];this.refreshPlayer(player);return;
      case 324:player.nickname=p[1];return;
      case 325:player.profile=p[1];return;
      case 355:{let script=p[0];while(task.list[task.index]?.code===655)script+='\n'+task.list[task.index++].parameters[0];if(parseTextScript(script))this.script(task,player,script,task.event);else for(const line of script.split(/\r?\n/).filter(x=>x.trim()))this.script(task,player,line,task.event);return;}
      case 655:throw new Error('Orphan script continuation');
      case 356:this.plugin(task,player,p[0]);return;
      case 357:if(this.threeD(task,player,command))return;throw new Error('Unsupported MZ plugin command');
      default:{const status=classifyCommand(command);if(status.status==='presentation'){const parameters=structuredClone(p);if([231,232].includes(command.code)&&parameters[3]===1){parameters[4]=this.variable(player,parameters[4]);parameters[5]=this.variable(player,parameters[5]);parameters[3]=0;}this.world.send(player.id,{type:'eventEffect',code:command.code,parameters,eventId:entityId(task.event)});return;}throw new Error(`Unsupported command ${command.code}`);}
    }
  }
  route(task,player,c,command){const p=command.parameters||[],delta={1:[0,1,2],2:[-1,0,4],3:[1,0,6],4:[0,-1,8]};
    if(command.code===0)return;
    if(delta[command.code]){const [dx,dy,d]=delta[command.code];if(!c.directionFix)c.direction=d;if(this.content.isPassable(task.mapId,Math.floor(c.x),Math.floor(c.y),d)){const wrapped=this.content.wrapPosition?.(task.mapId,c.x+dx,c.y+dy)||{x:c.x+dx,y:c.y+dy};Object.assign(c,wrapped);}else if(task.forcedRoute&&!task.forcedRoute.skippable)task.forcedRoute.index--;task.wait=Math.max(task.wait,1/Math.max(1,2**finite(c.moveSpeed,4)/4));return;}
    if(command.code>=5&&command.code<=8){const dirs={5:[1,2],6:[1,3],7:[4,2],8:[4,3]}[command.code];for(const code of dirs)this.route(task,player,c,{code,parameters:[]});return;}
    if(command.code>=9&&command.code<=13){let direction=c.direction||2;if(command.code===9)direction=[2,4,6,8][Math.floor((this.world.random?.()??Math.random())*4)];if(command.code===10||command.code===11){const dx=player.x-c.x,dy=player.y-c.y;direction=Math.abs(dx)>Math.abs(dy)?dx>0?6:4:dy>0?2:8;if(command.code===11)direction=10-direction;}if(command.code===13)direction=10-direction;this.route(task,player,c,{code:{2:1,4:2,6:3,8:4}[direction],parameters:[]});return;}
    if(command.code===14){const x=c.x+finite(p[0]),y=c.y+finite(p[1]),m=this.content.getMap(task.mapId);if(x>=0&&y>=0&&x<m.width&&y<m.height){c.x=x;c.y=y;}task.wait=.3;return;}
    if(command.code>=16&&command.code<=19){c.direction=[2,4,6,8][command.code-16];return;}
    if(command.code===15){task.wait+=p[0]/60;return;}
    if(command.code>=20&&command.code<=26){const d=c.direction||2,clockwise={2:4,4:8,8:6,6:2},counter={2:6,6:8,8:4,4:2};if(command.code===20)c.direction=clockwise[d];if(command.code===21)c.direction=counter[d];if(command.code===22)c.direction=10-d;if(command.code===23)c.direction=(this.world.random?.()??Math.random())<.5?clockwise[d]:counter[d];if(command.code===24)c.direction=[2,4,6,8][Math.floor((this.world.random?.()??Math.random())*4)];if(command.code===25||command.code===26){const dx=player.x-c.x,dy=player.y-c.y;c.direction=Math.abs(dx)>Math.abs(dy)?dx>0?6:4:dy>0?2:8;if(command.code===26)c.direction=10-c.direction;}return;}
    if(command.code===27||command.code===28){this.setSwitch(player,p[0],command.code===27);return;}
    if(command.code===29){c.moveSpeed=p[0];return;}
    if(command.code===30){c.moveFrequency=p[0];return;}
    if(command.code>=31&&command.code<=40){const key={31:'walkAnime',32:'walkAnime',33:'stepAnime',34:'stepAnime',35:'directionFix',36:'directionFix',37:'through',38:'through',39:'transparent',40:'transparent'}[command.code];c[key]=command.code%2===1;return;}
    if(command.code===41){c.image={...(c.image||{}),characterName:p[0],characterIndex:p[1]};return;}
    if(command.code===42){c.opacity=p[0];return;}
    if(command.code===43){c.blendMode=p[0];return;}
    if(command.code===44){this.world.send(player.id,{type:'eventEffect',code:250,parameters:p,eventId:entityId(c)});return;}
    if(command.code===45){this.script(task,player,p[0],c);return;}
    throw new Error(`Unsupported movement route ${command.code}`);
  }
  script(task,player,source,target){const s=String(source).trim().replace(/;\s*$/,'');if(classifyScript(s).status!=='adapted')throw new Error(`Script requires migration: ${s.slice(0,100)}`);
    const textScript=parseTextScript(s);if(textScript){this.presentation.script(task,player,textScript);return;}let m;
    if((m=s.match(/^\$gameMap\.copyEventFromMapToRegion\(([^)]+)\)$/))){const [sourceMapId,eventId,regionId]=m[1].split(',').map(Number),map=this.content.getMap(task.mapId),tiles=[];for(let y=0;y<map.height;y++)for(let x=0;x<map.width;x++)if(map.data[5*map.width*map.height+y*map.width+x]===regionId)tiles.push({x,y});if(!tiles.length){this.diagnostic(player,`Region ${regionId} has no spawn tiles`,`${task.mapId}:region:${regionId}`);return;}const tile=tiles[Math.floor((this.world.random?.()??Math.random())*tiles.length)];this.spawnTemplate(task,player,sourceMapId,eventId,tile.x,tile.y,`region:${regionId}`);return;}
    if((m=s.match(/^\$gameMap\.copyEventFrom\(([^)]+)\)$/))){const [sourceMapId,eventId,x,y]=m[1].split(',').map(Number);this.spawnTemplate(task,player,sourceMapId,eventId,x,y,`position:${x},${y}`);return;}
    if((m=s.match(/^\$gamePlayer\.(locate|reserveTransfer)\(([^)]+)\)$/))){const values=m[2].split(',').map(Number);if(m[1]==='locate'){const spawn=this.content.findSpawn(player.mapId,...values);if(spawn)Object.assign(player,spawn);}else this.transfer(task,player,values);return;}
    if((m=s.match(/^\$gameActors\.actor\(\d+\)\.(learnSkill|forgetSkill|clearEquipments)\((\d*)\)$/))){player.skills??=[];if(m[1]==='learnSkill'&&!player.skills.includes(+m[2]))player.skills.push(+m[2]);if(m[1]==='forgetSkill')player.skills=player.skills.filter(x=>x!==+m[2]);if(m[1]==='clearEquipments')player.equips={};this.refreshPlayer(player);return;}
    if(s==='$gameParty.initAllItems()'){player.inventory=[];this.refreshPlayer(player);return;}
    if((m=s.match(/^\$gameMap\._interpreter\.wait\((.*)\)$/))){task.wait=this.expression(m[1],player)/60;return;}
    if((m=s.match(/^this\.act\((.*)\)$/))){if(!this.world.useTool)throw new Error('Tool execution unavailable');this.world.useTool(target,this.expression(m[1],player));return;}
    if((m=s.match(/\.setDirection\((.*)\)$/))){task.event.direction=this.expression(m[1],player);return;}
    throw new Error('Adapter is unavailable');
  }
  transfer(task,player,values){const result=this.world.transfer(player,...values);if(result?.then)Promise.resolve(result).then(()=>this.onTransfer(player),error=>this.diagnostic(player,`Transfer failed: ${error.message}`));else this.onTransfer(player);this.finish(task);}
  spawnTemplate(task,player,sourceMapId,eventId,x,y,location){const key=`${task.mapId}:${sourceMapId}:${eventId}:${location}`,previous=this.templateSpawns.get(key),map=this.world.maps.get(task.mapId);if(previous&&map?.events.has(previous))return;const event=this.world.spawnTemplate(task.mapId,sourceMapId,eventId,x,y);if(event)this.templateSpawns.set(key,event.id);else this.diagnostic(player,`Template ${sourceMapId}/${eventId} is unavailable or quarantined`,key);}
  threeD(task,player,command){
    const commands=parseThreeDPluginCommand(command);if(commands===null)return false;
    for(const source of commands)this.world.send(player.id,{type:'threeD',mapId:task.mapId,instanceId:this.world.hooks?.snapshot?.(player)?.id||null,eventId:Number(entityId(task.event))||0,entityId:String(task.event.id??entityId(task.event)),command:resolveThreeDVariables(source,id=>this.variable(player,id))});
    return true;
  }
  plugin(task,player,source){if(this.threeD(task,player,{code:356,parameters:[source]}))return;if(this.presentation.plugin(task,player,source))return;let m;if((m=source.match(/^set_actor_(skill|item)\s*:\s*\d+\s*:\s*(\d+)/i))){player[m[1]==='skill'?'selectedSkill':'selectedItem']=+m[2];this.refreshPlayer(player);return;}
    if(/^(CraftingSystem\s+open|Composition)\b/i.test(source)){this.world.send(player.id,{type:'openCrafting',recipes:this.content.recipes});return;}
    if(/^OpenNewWindow\s+/i.test(source)){this.diagnostic(player,`External link: ${source.replace(/^\S+\s+/,'')}`);return;}
    if(/^(force_damage|tool_turn_end|tool_collision|tool_position|chrono_mode)\b/i.test(source)){this.diagnostic(player,`Legacy Chrono command ${source.split(' ')[0]} uses the new server combat implementation`,`chrono:${source.split(' ')[0]}`);return;}
    throw new Error(`Unsupported plugin command: ${source}`);
  }
}
