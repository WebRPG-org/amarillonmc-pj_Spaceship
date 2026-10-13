import path from 'node:path';
import {readFile,writeFile,mkdir,rename,realpath,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {EMPTY_GAMEPLAY,assertSafeData,validateGameplay} from './gameplay-content.mjs';
import {importWeaponProfiles} from './weapons.mjs';

const fail=(status,message)=>Object.assign(new Error(message),{status});
const hash=text=>createHash('sha256').update(text).digest('hex');
const local=value=>value==='127.0.0.1'||value==='::1'||value==='::ffff:127.0.0.1';
const hostLocal=value=>['localhost','127.0.0.1','[::1]','::1'].includes(value);
/** Never trust HOST, forwarded headers, or a reverse proxy to establish local access. */
export function editorAllowed(req,devTools){
  if(!devTools||!local(req.socket?.remoteAddress)||req.headers.forwarded||req.headers['x-forwarded-for']||req.headers['x-forwarded-host']||req.headers['x-real-ip'])return false;
  try{
    const host=new URL(`http://${req.headers.host}`);if(!hostLocal(host.hostname))return false;
    if(req.headers.origin){const origin=new URL(req.headers.origin);if(!['http:','https:'].includes(origin.protocol)||origin.host!==host.host||!hostLocal(origin.hostname))return false;}
    if(!['GET','HEAD'].includes(req.method)&&req.headers['x-editor-request']!=='1')return false;
    return true;
  }catch{return false;}
}

const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
function merge(base,patch){const result=structuredClone(base);for(const[k,v]of Object.entries(patch))result[k]=object(v)&&object(result[k])?merge(result[k],v):structuredClone(v);return result;}
function keys(value,allowed){if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw fail(400,'配置包含不允许修改的字段');}
function integer(value,min,max,label){if(!Number.isSafeInteger(value)||value<min||value>max)throw fail(400,`${label} 超出范围`);}
function string(value,max,label){if(typeof value!=='string'||value.length>max)throw fail(400,`${label} 内容无效`);}
function safeAsset(value){return typeof value==='string'&&value.length<=180&&!value.includes('..')&&!/[\\\/:\u0000-\u001f]/.test(value);}
function serialize(kind,value,original=''){
  if(kind==='map'||kind==='tools'){const{data,events,...head}=value;return '{\n'+JSON.stringify(head).slice(1,-1)+',\n"data":'+JSON.stringify(data)+',\n"events":[\n'+events.map(event=>JSON.stringify(event)).join(',\n')+'\n]\n}\n';}
  if(Array.isArray(value))return /^\s*\[\r?\n/.test(original)?'[\n'+value.map(entry=>JSON.stringify(entry)).join(',\n')+'\n]\n':JSON.stringify(value)+'\n';
  return JSON.stringify(value,null,2)+'\n';
}
function eventTemplate(id){return{id,name:`事件 ${id}`,note:'',x:0,y:0,pages:[{conditions:{actorId:1,actorValid:false,itemId:1,itemValid:false,selfSwitchCh:'A',selfSwitchValid:false,switch1Id:1,switch1Valid:false,switch2Id:1,switch2Valid:false,variableId:1,variableValid:false,variableValue:0},directionFix:false,image:{characterIndex:0,characterName:'',direction:2,pattern:1,tileId:0},list:[{code:0,indent:0,parameters:[]}],moveFrequency:3,moveRoute:{list:[{code:0,parameters:[]}],repeat:true,skippable:false,wait:false},moveSpeed:3,moveType:0,priorityType:1,stepAnime:false,through:false,trigger:0,walkAnime:true}]};}
function setTag(note,key,value){const lines=String(note||'').split(/\r?\n/).filter(line=>!new RegExp(`^\\s*${key}\\s*:`,'i').test(line));if(value)lines.push(`${key}:${value}`);return lines.filter(Boolean).join('\n');}

export class ContentWorkbench {
  constructor({projectRoot,content}){this.projectRoot=path.resolve(projectRoot);this.content=content;this.queues=new Map();}
  documentPath(kind,id){
    if(kind==='gameplay')return path.join(this.projectRoot,'engine','content','gameplay.json');
    if(kind==='map'){if(!/^\d{1,6}$/.test(String(id))||!this.content.maps.has(Number(id)))throw fail(404,'地图不存在');return path.join(this.projectRoot,'data',`Map${String(Number(id)).padStart(3,'0')}.json`);}
    const name={animations:'Animations',weapons:'Weapons',items:'Items',tools:null}[kind];
    if(name)return path.join(this.projectRoot,'data',`${name}.json`);
    if(kind==='tools')return this.documentPath('map',id);
    throw fail(400,'未知文档类型');
  }
  async safePath(file){
    const root=await realpath(this.projectRoot);let candidate=file,suffix=[];
    while(true){try{candidate=path.join(await realpath(candidate),...suffix.reverse());break;}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(candidate);if(parent===candidate)throw error;suffix.push(path.basename(candidate));candidate=parent;}}
    const relative=path.relative(root,candidate);if(relative.startsWith('..'+path.sep)||relative==='..'||path.isAbsolute(relative))throw fail(403,'文档路径超出工程');return file;
  }
  async read(kind,id){const file=await this.safePath(this.documentPath(kind,id));let source;try{source=await readFile(file,'utf8');}catch(error){if(kind!=='gameplay'||error.code!=='ENOENT')throw error;source='';}const document={kind,id:id?Number(id):undefined,revision:hash(source),data:source?JSON.parse(source):structuredClone(EMPTY_GAMEPLAY)};Object.defineProperty(document,'source',{value:source});return document;}
  async save(kind,id,{revision,patch}){
    assertSafeData(patch);if(typeof revision!=='string'||!object(patch))throw fail(400,'缺少文档版本或修改内容');
    const file=this.documentPath(kind,id),previous=this.queues.get(file)||Promise.resolve();
    const job=previous.catch(()=>{}).then(async()=>{
      const current=await this.read(kind,id);if(current.revision!==revision)throw fail(409,'文件已被 RM、其他窗口或开发者修改；请重新载入后再编辑');
      const next=this.apply(kind,current.data,patch,id);await this.safePath(file);
      const directory=path.join(this.projectRoot,'engine','.artifacts','editor-backups');await this.safePath(directory);await mkdir(directory,{recursive:true});await this.safePath(directory);
      const backup=path.join(directory,`${Date.now()}-${randomUUID()}-${path.basename(file)}`);
      await writeFile(backup,current.source||JSON.stringify(current.data,null,2)+'\n',{flag:'wx'});
      await mkdir(path.dirname(file),{recursive:true});await this.safePath(file);
      const source=serialize(kind,next,current.source),temporary=`${file}.${randomUUID()}.tmp`;
      try{await writeFile(temporary,source,{flag:'wx'});if((await this.read(kind,id)).revision!==revision)throw fail(409,'保存期间文件已变化，请重新载入');await rename(temporary,file);}finally{await unlink(temporary).catch(()=>{});}
      return{kind,id:id?Number(id):undefined,revision:hash(source),data:next,restartRequired:true,backup:path.relative(this.projectRoot,backup).replaceAll('\\','/')};
    });this.queues.set(file,job);try{return await job;}finally{if(this.queues.get(file)===job)this.queues.delete(file);}
  }
  apply(kind,current,patch,id){
    if(kind==='gameplay'){keys(patch,['version','scenarios','titles','shops','npcs','structures']);return validateGameplay(merge(current,patch),this.content);}
    if(kind==='map'){
      keys(patch,['events']);if(!Array.isArray(patch.events)||patch.events.length>2000)throw fail(400,'事件列表无效');
      const next=structuredClone(current);for(const change of patch.events){
        keys(change,['id','name','x','y','note','tags','image']);integer(change.id,1,999999,'事件 ID');
        if(change.id>next.events.length)throw fail(400,'新事件必须使用下一个事件 ID');
        const event=next.events[change.id]||eventTemplate(change.id);
        for(const key of ['x','y'])if(change[key]!==undefined){integer(change[key],0,(key==='x'?current.width:current.height)-1,`事件 ${key}`);event[key]=change[key];}
        if(change.name!==undefined){string(change.name,200,'事件名称');event.name=change.name;}
        if(change.note!==undefined){string(change.note,16000,'事件备注');event.note=change.note;}
        if(change.tags){keys(change.tags,['engine_npc','engine_structure','engine_service','engine_shop','engine_container']);for(const[key,value]of Object.entries(change.tags)){if(!/^[A-Za-z0-9_-]{0,80}$/.test(value))throw fail(400,'实体标签无效');event.note=setTag(event.note,key,value);}}
        if(change.image){keys(change.image,['characterName','characterIndex','tileId']);if(change.image.characterName!==undefined&&!safeAsset(change.image.characterName))throw fail(400,'角色图路径无效');if(change.image.characterIndex!==undefined)integer(change.image.characterIndex,0,7,'角色图编号');if(change.image.tileId!==undefined)integer(change.image.tileId,0,8191,'图块编号');event.pages[0].image={...event.pages[0].image,...change.image};}
        next.events[change.id]=event;
      }return next;
    }
    if(kind==='weapons'){
      keys(patch,['id','name','description','price','profile']);integer(patch.id,1,current.length-1,'武器 ID');const next=structuredClone(current),weapon=next[patch.id];if(!weapon)throw fail(404,'武器不存在');
      for(const key of ['name','description'])if(patch[key]!==undefined){string(patch[key],key==='name'?200:4000,key);weapon[key]=patch[key];}
      if(patch.price!==undefined){integer(patch.price,0,999999999,'价格');weapon.price=patch.price;}
      if(patch.profile!==undefined){keys(patch.profile,['mode','skillId','toolId','range','maxDurability','durabilityCost','ammoItemId','ammoCost','mpCost']);const match=String(weapon.note||'').match(/<serverWeapon>([\s\S]*?)<\/serverWeapon>/i);const value=merge(match?JSON.parse(match[1]):{},patch.profile),note=`<serverWeapon>${JSON.stringify(value)}</serverWeapon>`;weapon.note=match?weapon.note.replace(match[0],note):`${weapon.note||''}\n${note}`;importWeaponProfiles({...this.content.database,Weapons:next});}return next;
    }
    if(kind==='items'){
      keys(patch,['id','name','description','price']);integer(patch.id,1,current.length-1,'物品 ID');const next=structuredClone(current),item=next[patch.id];if(!item)throw fail(404,'物品不存在');
      for(const key of ['name','description'])if(patch[key]!==undefined){string(patch[key],key==='name'?200:4000,key);item[key]=patch[key];}
      if(patch.price!==undefined){integer(patch.price,0,999999999,'价格');item.price=patch.price;}return next;
    }
    if(kind==='animations'){
      keys(patch,['id','changes']);integer(patch.id,1,current.length-1,'动画 ID');keys(patch.changes,['name','effectName','displayType','alignBottom','scale','speed','rotation','offsetX','offsetY','rotationX','rotationY','rotationZ','position','animation1Name','animation2Name','animation1Hue','animation2Hue','soundTimings','flashTimings']);
      const next=structuredClone(current),animation=next[patch.id];if(!animation)throw fail(404,'动画不存在');
      for(const[key,value]of Object.entries(patch.changes)){
        if(['effectName','animation1Name','animation2Name'].includes(key)){if(!safeAsset(value))throw fail(400,'动画素材路径无效');}
        else if(key==='name')string(value,200,'动画名称');
        else if(['soundTimings','flashTimings'].includes(key)){if(!Array.isArray(value)||value.length>1000)throw fail(400,'动画时序无效');for(const timing of value){integer(timing.frame,0,36000,'动画帧');if(key==='soundTimings'){keys(timing,['frame','se']);keys(timing.se,['name','volume','pitch','pan']);if(!safeAsset(timing.se.name))throw fail(400,'音效路径无效');integer(timing.se.volume,0,100,'音量');integer(timing.se.pitch,50,150,'音调');integer(timing.se.pan,-100,100,'声像');}else{keys(timing,['frame','duration','color']);integer(timing.duration,1,36000,'闪光时长');if(!Array.isArray(timing.color)||timing.color.length!==4)throw fail(400,'闪光颜色无效');timing.color.forEach(n=>integer(n,0,255,'颜色'));}}}
        else if(key==='rotation'){keys(value,['x','y','z']);for(const n of Object.values(value))integer(n,-36000,36000,'旋转');}
        else if(key==='alignBottom'){if(typeof value!=='boolean')throw fail(400,'动画对齐参数无效');}
        else integer(value,-10000,10000,key);
        animation[key]=structuredClone(value);
      }return next;
    }
    if(kind==='tools'){
      keys(patch,['eventId','values']);integer(patch.eventId,1,current.events.length-1,'工具事件 ID');
      keys(patch.values,['tool_range','tool_area','tool_position','tool_duration','tool_pose_duration','tool_skill_id','tool_item_id','tool_item_cost','tool_projectile','tool_disable_piercing']);
      const next=structuredClone(current),event=next.events[patch.eventId];if(!event?.pages?.[0])throw fail(404,'工具事件不存在');
      const page=event.pages[0],commands=page.list.filter(c=>[108,408].includes(c.code)),values={...patch.values};
      for(const[key,value]of Object.entries(values)){if(['tool_projectile','tool_disable_piercing'].includes(key)){if(typeof value!=='boolean')throw fail(400,'工具开关无效');}else if(['tool_area','tool_position'].includes(key)){if(!/^[a-z_]{1,24}$/.test(value))throw fail(400,'工具枚举值无效');}else integer(value,0,36000,key);}
      for(const command of commands)for(const key of Object.keys(values))if(new RegExp(`^\\s*${key.replaceAll('_','[ _]')}\\s*(?::|$)`,'i').test(command.parameters?.[0]||''))command.parameters[0]='';
      page.list=page.list.filter(c=>!([108,408].includes(c.code)&&!c.parameters?.[0]));
      const newCommands=Object.entries(values).filter(([,v])=>v!==false).map(([key,value])=>({code:108,indent:0,parameters:[`${key.replaceAll('_',' ')}${value===true?'':` : ${value}`}`]}));page.list.unshift(...newCommands);for(let i=0;i<page.list.length;i++)if(page.list[i].code===408&&![108,408].includes(page.list[i-1]?.code))page.list[i].code=108;return next;
    }
    throw fail(400,'未知文档类型');
  }
}

const respond=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
async function requestBody(req){let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw fail(413,'修改内容超过 1 MB');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail(400,'JSON 无效');}}
function playerSummary(host,p){return{id:p.id,name:p.name,connected:p._connected,mapId:p.mapId,x:p.x,y:p.y,hp:p.hp,mp:p.mp,dead:!!p.dead,instanceId:host.locations.get(p.id)?.id||null};}
export function createWorkbenchHandler({projectRoot,content,host,connections,devTools}){
  const editor=new ContentWorkbench({projectRoot,content});
  return async(req,res,url)=>{
    if(!url.pathname.startsWith('/api/editor/'))return false;
    if(!editorAllowed(req,devTools)){respond(res,403,{error:'内容工作台仅允许 DEV_TOOLS=1 的本机直连请求'});return true;}
    try{
      if(url.pathname==='/api/editor/document'){
        const kind=url.searchParams.get('kind'),id=url.searchParams.get('id');
        if(req.method==='GET')respond(res,200,await editor.read(kind,id));
        else if(req.method==='PUT')respond(res,200,await editor.save(kind,id,await requestBody(req)));
        else throw fail(405,'仅支持 GET / PUT');return true;
      }
      if(url.pathname==='/api/editor/admin'&&req.method==='GET'){
        const playerId=url.searchParams.get('playerId');if(playerId){const p=host.players.get(Number(playerId))||host.players.get(playerId);if(!p)throw fail(404,'玩家不在线');respond(res,200,{...playerSummary(host,p),state:{level:p.level,gold:p.gold,inventory:p.inventory,equips:p.equips,skills:p.skills,states:p.states},profile:p.profile});}
        else respond(res,200,{players:[...host.players.values()].map(p=>playerSummary(host,p)),rounds:[...host.rounds.values()].map(r=>r.snapshot()),diagnostics:[...host.runtimeDiagnostics].slice(-50)});return true;
      }
      if(url.pathname==='/api/editor/admin'&&req.method==='POST'){
        const data=await requestBody(req);keys(data,['action','playerId','instanceId','message']);
        if(data.action==='announce'){string(data.message,500,'公告');if(!data.message.trim())throw fail(400,'公告不能为空');for(const p of host.players.values())host.notice(p,`【管理员公告】${data.message}`);}
        else if(data.action==='kick'){const p=host.players.get(Number(data.playerId))||host.players.get(data.playerId);if(!p)throw fail(404,'玩家不存在');connections.get(p.id)?.close(1008,'Disconnected by local administrator');await host.disconnect(p.id);}
        else if(data.action==='finishRound'){const r=host.rounds.get(data.instanceId);if(!r)throw fail(404,'副本不存在');await host.finishRound(r,{reason:'admin-stopped',success:false});}
        else throw fail(400,'未知管理操作');respond(res,200,{ok:true});return true;
      }
      throw fail(404,'编辑接口不存在');
    }catch(error){respond(res,error.status||400,{error:error.message});return true;}
  };
}
