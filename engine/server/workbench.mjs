import path from 'node:path';
import {readFile,writeFile,mkdir,rename,realpath,unlink,readdir,link} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {EMPTY_GAMEPLAY,assertSafeData,validateGameplay} from './gameplay-content.mjs';
import {importWeaponProfiles} from './weapons.mjs';
import {applyMapPropertiesAndTiles,validateEventBounds,validateEventPages,validateEventImage,validateEventTemplate,validateMapProperties,newMapTemplate,EVENT_LIMIT} from './editor-validation.mjs';

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
function setTag(note,key,value){const lines=note?String(note).split(/\r?\n/).filter(line=>!new RegExp(`^\\s*<?${key}\\s*:`,'i').test(line)):[];if(value)lines.push(`${key}:${value}`);return lines.join('\n');}
function clearCommentTag(pages,key){
  const pattern=new RegExp(`^\\s*<?${key}\\s*:`,'i');
  for(const page of pages||[]){
    page.list=(page.list||[]).flatMap(command=>{
      if(![108,408].includes(command.code)||typeof command.parameters?.[0]!=='string')return[command];
      const original=command.parameters[0].split(/\r?\n/),lines=original.filter(line=>!pattern.test(line));if(lines.length===original.length)return[command];
      return lines.length?[{...command,parameters:[lines.join('\n'),...command.parameters.slice(1)]}]:[];
    });
    for(let i=0;i<page.list.length;i++)if(page.list[i].code===408&&![108,408].includes(page.list[i-1]?.code))page.list[i].code=108;
  }
}

export class ContentWorkbench {
  constructor({projectRoot,content,fileOps={}}){this.projectRoot=path.resolve(projectRoot);this.content=content;this.validationContent={...content,maps:new Map(content.maps||[])};this.queues=new Map();this.files={readFile,writeFile,mkdir,rename,realpath,unlink,readdir,link,...fileOps};}
  documentPath(kind,id){
    if(kind==='gameplay')return path.join(this.projectRoot,'engine','content','gameplay.json');
    if(kind==='map'){if(!/^\d{1,6}$/.test(String(id))||Number(id)<1)throw fail(404,'地图不存在');return path.join(this.projectRoot,'data',`Map${String(Number(id)).padStart(3,'0')}.json`);}
    if(kind==='mapInfos')return path.join(this.projectRoot,'data','MapInfos.json');
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
  async read(kind,id){const file=await this.safePath(this.documentPath(kind,id));let source;try{source=await readFile(file,'utf8');}catch(error){if(kind!=='gameplay'||error.code!=='ENOENT')throw error;source='';}const document={kind,id:id?Number(id):undefined,revision:hash(source),data:source?JSON.parse(source):structuredClone(EMPTY_GAMEPLAY)};Object.defineProperty(document,'source',{value:source});if(kind==='map'||kind==='tools')this.validationContent.maps.set(Number(id),{...structuredClone(document.data),id:Number(id)});return document;}
  async assets(kind){
    const folders={characters:['img','characters'],faces:['img','faces'],parallaxes:['img','parallaxes'],bgm:['audio','bgm'],bgs:['audio','bgs'],se:['audio','se'],me:['audio','me']};
    if(!Object.hasOwn(folders,kind))throw fail(400,'未知素材类型');
    const base=await this.safePath(path.join(this.projectRoot,...folders[kind])),names=new Set(),extensions=folders[kind][0]==='img'?new Set(['.png']):new Set(['.ogg','.m4a','.mp3','.wav']);
    const walk=async(directory,relative='',depth=0)=>{if(depth>6)throw fail(400,'素材目录嵌套过深');await this.safePath(directory);let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
      for(const entry of entries){const file=path.join(directory,entry.name),name=relative+entry.name;if(entry.isDirectory())await walk(file,name+'/',depth+1);else if(entry.isFile()&&extensions.has(path.extname(entry.name).toLowerCase())){await this.safePath(file);names.add(name.slice(0,-path.extname(entry.name).length));if(names.size>10000)throw fail(400,'素材数量超出限制');}}
    };await walk(base);return{names:[...names].sort((a,b)=>a.localeCompare(b,'zh-CN'))};
  }
  async mapCatalog(document){
    document||=await this.read('mapInfos');if(!Array.isArray(document.data)||document.data.length>10000)throw fail(400,'MapInfos 格式或数量无效');
    const maps=[];for(let id=1;id<document.data.length;id++){
      const info=document.data[id];if(!info)continue;if(info.id!==id)throw fail(400,`MapInfos 的地图 ${id} 标识不一致`);
      let map;try{map=await this.read('map',id);}catch(error){if(error.code==='ENOENT')continue;throw error;}
      maps.push({id,name:String(info.name||`Map${id}`),parentId:info.parentId||0,width:map.data.width,height:map.data.height,tilesetId:map.data.tilesetId});
    }return{revision:document.revision,maps};
  }
  async backupDocument(file,source){
    const directory=path.join(this.projectRoot,'engine','.artifacts','editor-backups');await this.safePath(directory);await mkdir(directory,{recursive:true});await this.safePath(directory);
    const backup=path.join(directory,`${Date.now()}-${randomUUID()}-${path.basename(file)}`);await this.files.writeFile(backup,source,{flag:'wx'});return path.relative(this.projectRoot,backup).replaceAll('\\','/');
  }
  async createMap(input){
    assertSafeData(input);keys(input,['name','width','height','tilesetId','sourceMapId','sourceRevision','parentId','revision']);
    string(input.name,200,'地图名称');if(!input.name.trim())throw fail(400,'地图名称不能为空');
    validateMapProperties({width:input.width,height:input.height,tilesetId:input.tilesetId},this.content);
    integer(input.parentId??0,0,9999,'父地图 ID');if(typeof input.revision!=='string')throw fail(400,'缺少地图目录版本');
    if(input.sourceMapId!==undefined){integer(input.sourceMapId,1,9999,'源地图 ID');if(input.sourceRevision!==undefined&&typeof input.sourceRevision!=='string')throw fail(400,'源地图版本无效');}
    else if(input.sourceRevision!==undefined)throw fail(400,'源版本需要同时指定源地图');
    const previous=this.queues.get('map-files')||Promise.resolve();
    const job=previous.catch(()=>{}).then(async()=>{
      const infos=await this.read('mapInfos');if(infos.revision!==input.revision)throw fail(409,'地图目录已变化，请重新载入后创建');
      const catalog=await this.mapCatalog(infos);if(input.parentId&&!infos.data[input.parentId])throw fail(400,'父地图不存在');
      const source=input.sourceMapId?await this.read('map',input.sourceMapId):null;
      if(source&&input.sourceRevision!==undefined&&source.revision!==input.sourceRevision)throw fail(409,'复制源地图已变化，请重新载入');
      const occupied=(await readdir(path.join(this.projectRoot,'data'))).filter(name=>/^Map\d+\.json$/i.test(name)).map(name=>Number(name.match(/\d+/)[0]));
      const id=Math.max(0,infos.data.length-1,...occupied)+1;if(id>9999)throw fail(400,'地图数量超出限制');
      const map=source?applyMapPropertiesAndTiles(source.data,{width:input.width,height:input.height,tilesetId:input.tilesetId,displayName:input.name},[],this.content):newMapTemplate(input);
      validateEventBounds(map);for(const event of map.events)if(event)validateEventPages(event.pages);
      const nextInfos=structuredClone(infos.data);while(nextInfos.length<id)nextInfos.push(null);nextInfos[id]={id,expanded:false,name:input.name,order:Math.max(0,...nextInfos.filter(Boolean).map(info=>Number(info.order)||0))+1,parentId:input.parentId||0,scrollX:0,scrollY:0};
      const mapFile=await this.safePath(this.documentPath('map',id)),infosFile=await this.safePath(this.documentPath('mapInfos')),mapText=serialize('map',map),infosText=serialize('mapInfos',nextInfos,infos.source),mapTemp=`${mapFile}.${randomUUID()}.tmp`,infosTemp=`${infosFile}.${randomUUID()}.tmp`;
      const backups=[await this.backupDocument(infosFile,infos.source)];if(source)backups.push(await this.backupDocument(this.documentPath('map',input.sourceMapId),source.source));
      let publishedMap=false,attemptedInfos=false;
      const assertUnchanged=async()=>{if((await this.read('mapInfos')).revision!==infos.revision)throw fail(409,'创建期间地图目录已被其他编辑器修改');if(source&&(await this.read('map',input.sourceMapId)).revision!==source.revision)throw fail(409,'创建期间复制源地图已被其他编辑器修改');};
      try{
        await this.files.writeFile(mapTemp,mapText,{flag:'wx'});await this.files.writeFile(infosTemp,infosText,{flag:'wx'});await assertUnchanged();await this.safePath(mapFile);await this.safePath(infosFile);
        // A hard link publishes a complete new file without replacing an existing map.
        await this.files.link(mapTemp,mapFile);publishedMap=true;await assertUnchanged();
        if(hash(await readFile(mapFile,'utf8'))!==hash(mapText))throw fail(409,'新地图在提交前被外部修改，已保留该文件');
        attemptedInfos=true;await this.files.rename(infosTemp,infosFile);
      }catch(error){
        // Only undo bytes owned by this transaction; never clobber an RM save.
        if(attemptedInfos){
          const restore=`${infosFile}.${randomUUID()}.restore`;
          try{if(hash(await readFile(infosFile,'utf8'))===hash(infosText)){await writeFile(restore,infos.source,{flag:'wx'});await rename(restore,infosFile);}}
          catch{error.message+='；地图目录恢复失败，请依据备份检查目录';}
          finally{await unlink(restore).catch(()=>{});}
        }
        if(publishedMap){try{
          // An external directory edit may have adopted the new map. Keep it.
          const latestInfos=JSON.parse(await readFile(infosFile,'utf8'));
          if(!latestInfos[id]&&hash(await readFile(mapFile,'utf8'))===hash(mapText))await unlink(mapFile);
        }catch{error.message+='；新地图已保留，请检查目录与备份';}}
        throw error;
      }finally{await unlink(mapTemp).catch(()=>{});await unlink(infosTemp).catch(()=>{});}
      this.content.maps.set(id,{...structuredClone(map),id});this.validationContent.maps.set(id,{...structuredClone(map),id});this.content.mapInfos=nextInfos;
      const row={id,name:input.name,parentId:input.parentId||0,width:map.width,height:map.height,tilesetId:map.tilesetId};
      return{map:{kind:'map',id,revision:hash(mapText),data:map},catalog:{revision:hash(infosText),maps:[...catalog.maps,row]},restartRequired:true,backups};
    });this.queues.set('map-files',job);try{return await job;}finally{if(this.queues.get('map-files')===job)this.queues.delete('map-files');}
  }
  async save(kind,id,{revision,patch}){
    assertSafeData(patch);if(typeof revision!=='string'||!object(patch))throw fail(400,'缺少文档版本或修改内容');
    const file=this.documentPath(kind,id),queueKey=['map','tools'].includes(kind)?'map-files':file,previous=this.queues.get(queueKey)||Promise.resolve();
    const job=previous.catch(()=>{}).then(async()=>{
      const current=await this.read(kind,id);if(current.revision!==revision)throw fail(409,'文件已被 RM、其他窗口或开发者修改；请重新载入后再编辑');
      if(kind==='gameplay')try{await this.mapCatalog();}catch(error){if(error.code!=='ENOENT')throw error;}
      const next=this.apply(kind,current.data,patch,id);await this.safePath(file);
      const directory=path.join(this.projectRoot,'engine','.artifacts','editor-backups');await this.safePath(directory);await mkdir(directory,{recursive:true});await this.safePath(directory);
      const backup=path.join(directory,`${Date.now()}-${randomUUID()}-${path.basename(file)}`);
      await writeFile(backup,current.source||JSON.stringify(current.data,null,2)+'\n',{flag:'wx'});
      await mkdir(path.dirname(file),{recursive:true});await this.safePath(file);
      const source=serialize(kind,next,current.source),temporary=`${file}.${randomUUID()}.tmp`;
      try{await writeFile(temporary,source,{flag:'wx'});if((await this.read(kind,id)).revision!==revision)throw fail(409,'保存期间文件已变化，请重新载入');await rename(temporary,file);}finally{await unlink(temporary).catch(()=>{});}
      if(kind==='map'||kind==='tools')this.validationContent.maps.set(Number(id),{...structuredClone(next),id:Number(id)});
      return{kind,id:id?Number(id):undefined,revision:hash(source),data:next,restartRequired:true,backup:path.relative(this.projectRoot,backup).replaceAll('\\','/')};
    });this.queues.set(queueKey,job);try{return await job;}finally{if(this.queues.get(queueKey)===job)this.queues.delete(queueKey);}
  }
  apply(kind,current,patch,id){
    if(kind==='gameplay'){keys(patch,['version','scenarios','titles','shops','npcs','structures']);return validateGameplay(merge(current,patch),this.validationContent);}
    if(kind==='map'){
      keys(patch,['properties','tiles','events']);if(patch.events!==undefined&&(!Array.isArray(patch.events)||patch.events.length>EVENT_LIMIT))throw fail(400,'事件列表无效');
      const next=applyMapPropertiesAndTiles(current,patch.properties,patch.tiles,this.content);for(const change of patch.events||[]){
        keys(change,['id','name','x','y','note','tags','image','pages','remove','template']);integer(change.id,1,EVENT_LIMIT,'事件 ID');
        if(change.remove!==undefined){if(change.remove!==true||Object.keys(change).some(key=>!['id','remove'].includes(key))||!next.events[change.id])throw fail(400,'删除事件需指定存在的事件 ID，不可同时修改字段');next.events[change.id]=null;continue;}
        if(change.template!==undefined){if(next.events[change.id])throw fail(400,'事件模板只可用于新建事件');validateEventTemplate(change.template,change.id);}
        const event=next.events[change.id]||(change.template?structuredClone(change.template):eventTemplate(change.id));
        for(const key of ['x','y'])if(change[key]!==undefined){integer(change[key],0,(key==='x'?next.width:next.height)-1,`事件 ${key}`);event[key]=change[key];}
        if(change.name!==undefined){string(change.name,200,'事件名称');event.name=change.name;}
        if(change.note!==undefined){string(change.note,16000,'事件备注');event.note=change.note;}
        if(change.pages!==undefined){validateEventPages(change.pages);event.pages=structuredClone(change.pages);}
        if(change.tags){keys(change.tags,['engine_npc','engine_structure','engine_service','engine_shop','engine_container']);for(const[key,value]of Object.entries(change.tags)){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{0,80}$/.test(value))throw fail(400,'实体标签无效');event.note=setTag(event.note,key,value);clearCommentTag(event.pages,key);}}
        if(change.image){keys(change.image,['characterName','characterIndex','tileId','direction','pattern']);if(!event.pages[0])throw fail(400,'事件缺少图像页');const image={...event.pages[0].image,...change.image};validateEventImage(image);event.pages[0].image=image;}
        // A newly authored event may follow a deleted unsaved draft. Keep its ID
        // and serialize the skipped native event slots explicitly as null.
        while(next.events.length<=change.id)next.events.push(null);
        next.events[change.id]=event;
      }validateEventBounds(next);return next;
    }
    if(kind==='weapons'){
      keys(patch,['id','name','description','price','profile']);integer(patch.id,1,current.length-1,'武器 ID');const next=structuredClone(current),weapon=next[patch.id];if(!weapon)throw fail(404,'武器不存在');
      for(const key of ['name','description'])if(patch[key]!==undefined){string(patch[key],key==='name'?200:4000,key);weapon[key]=patch[key];}
      if(patch.price!==undefined){integer(patch.price,0,999999999,'价格');weapon.price=patch.price;}
      if(patch.profile!==undefined){keys(patch.profile,['mode','skillId','toolId','range','maxDurability','durabilityCost','ammoItemId','ammoCost','mpCost','movementSpeed']);const match=String(weapon.note||'').match(/<serverWeapon>([\s\S]*?)<\/serverWeapon>/i);const value=merge(match?JSON.parse(match[1]):{},patch.profile),note=`<serverWeapon>${JSON.stringify(value)}</serverWeapon>`;weapon.note=match?weapon.note.replace(match[0],note):`${weapon.note||''}\n${note}`;importWeaponProfiles({...this.content.database,Weapons:next});}return next;
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
async function requestBody(req){let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>16*1024*1024)throw fail(413,'修改内容超过 16 MB');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail(400,'JSON 无效');}}
function playerSummary(host,p){return{id:p.id,name:p.name,connected:p._connected,mapId:p.mapId,x:p.x,y:p.y,hp:p.hp,mp:p.mp,dead:!!p.dead,instanceId:host.locations.get(p.id)?.id||null};}
export function createWorkbenchHandler({projectRoot,content,host,connections,devTools}){
  const editor=new ContentWorkbench({projectRoot,content});
  return async(req,res,url)=>{
    if(!url.pathname.startsWith('/api/editor/'))return false;
    if(!editorAllowed(req,devTools)){respond(res,403,{error:'内容工作台仅允许 DEV_TOOLS=1 的本机直连请求'});return true;}
    try{
      if(url.pathname==='/api/editor/maps'){
        if(req.method==='GET')respond(res,200,await editor.mapCatalog());
        else if(req.method==='POST')respond(res,201,await editor.createMap(await requestBody(req)));
        else throw fail(405,'仅支持 GET / POST');return true;
      }
      if(url.pathname==='/api/editor/assets'){
        if(req.method!=='GET')throw fail(405,'仅支持 GET');respond(res,200,await editor.assets(url.searchParams.get('kind')));return true;
      }
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
    }catch(error){respond(res,error.status||(error.code==='ENOENT'?404:400),{error:error.message});return true;}
  };
}
