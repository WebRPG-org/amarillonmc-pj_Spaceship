import {commandCatalog,decodeCommands,encodeCommands,createBlock,commandSummary} from './editor-commands.mjs';
import {clone,newPage,eventTag,setEventTag,toolValue,setToolValue} from './editor-document.mjs';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const options=(items,current)=>{const rows=[...items];if(!rows.some(r=>String(r[0])===String(current)))rows.unshift([current,`${current??''}（原配置）`]);return rows.map(([v,n])=>`<option value="${esc(v)}" ${String(v)===String(current)?'selected':''}>${esc(n)}</option>`).join('');};
const directions=[[2,'下'],[4,'左'],[6,'右'],[8,'上']];
const routeNames={1:'向下移动',2:'向左移动',3:'向右移动',4:'向上移动',5:'左下移动',6:'右下移动',7:'左上移动',8:'右上移动',9:'随机移动',10:'接近玩家',11:'远离玩家',12:'前进一步',13:'后退一步',14:'跳跃',15:'等待',16:'面向下',17:'面向左',18:'面向右',19:'面向上',20:'右转 90°',21:'左转 90°',22:'转身 180°',23:'随机左 / 右转',24:'随机朝向',25:'面向玩家',26:'背向玩家',27:'开关 ON',28:'开关 OFF',29:'移动速度',30:'移动频率',31:'行走动画 ON',32:'行走动画 OFF',33:'踏步动画 ON',34:'踏步动画 OFF',35:'固定朝向 ON',36:'固定朝向 OFF',37:'穿透 ON',38:'穿透 OFF',39:'透明 ON',40:'透明 OFF'};

/** Modal event draft. Applying creates a single undoable map transaction. */
export class EventEditor{
  constructor({event,map,mapId,content,gameplay,assets,onApply,onClose,onDelete,onDuplicate,onDirty=()=>{}}){
    Object.assign(this,{event:clone(event),map,mapId,content,gameplay,assets,onApply,onClose,onDelete,onDuplicate,onDirty});
    this.original=JSON.stringify(event);this.pageIndex=0;this.blocks=event.pages.map(p=>decodeCommands(p.list));this.refs=new Map();this.serial=0;this.pendingTools=new Map();
    this.dialog=document.createElement('dialog');this.dialog.className='event-editor';document.body.append(this.dialog);
    this.dialog.addEventListener('cancel',e=>{e.preventDefault();this.close();});
    this.dialog.addEventListener('input',e=>this.input(e));this.dialog.addEventListener('change',e=>this.change(e));
    this.dialog.addEventListener('click',e=>{const b=e.target.closest('button[data-action]');if(b){try{this.action(b);}catch(error){this.error(error.message);}}});
    this.render();this.dialog.showModal();
  }
  ref(value){const id=String(++this.serial);this.refs.set(id,value);return id;}
  control(label,object,key,type='text',items,extra=''){
    const value=object[key],valueType=items?(typeof value==='number'||typeof items[0]?.[0]==='number'?'number':'text'):type;
    const ref=this.ref({object,key,type:valueType});
    const attrs=`data-field="${ref}" ${extra}`;
    if(items)return `<label>${esc(label)}<select ${attrs}>${options(items,value)}</select></label>`;
    if(type==='checkbox')return `<label class="check"><input type="checkbox" ${attrs} ${value?'checked':''}>${esc(label)}</label>`;
    if(type==='textarea')return `<label class="wide">${esc(label)}<textarea ${attrs}>${esc(value)}</textarea></label>`;
    return `<label>${esc(label)}<input type="${type}" ${attrs} value="${esc(value)}"></label>`;
  }
  db(key){return(this.content.database[key]||[]).filter(Boolean).map(v=>[v.id,`${v.id} · ${v.name||'未命名'}`]);}
  named(key){return(this.content.database.System?.[key]||[]).slice(1).map((v,i)=>[i+1,`${i+1} · ${v||'未命名'}`]);}
  asset(kind){return[['','无'],...(this.assets[kind]||[]).map(n=>[n,n])];}
  dirty(){this.changed=true;this.onDirty();this.dialog.querySelector('[data-draft-state]').textContent='事件草稿有修改';}
  flushTools(){if(!this.pendingTools.size)return;const page=this.event.pages[0];page.list=encodeCommands(this.blocks[0]);for(const[key,value]of this.pendingTools)setToolValue(page,key,value);this.blocks[0]=decodeCommands(page.list);this.pendingTools.clear();}
  flush(){this.flushTools();for(let i=0;i<this.event.pages.length;i++)this.event.pages[i].list=encodeCommands(this.blocks[i]);return this.event;}
  input(e){if(e.target.dataset.tool){this.pendingTools.set(e.target.dataset.tool,e.target.type==='checkbox'?e.target.checked:e.target.type==='number'?Number(e.target.value):e.target.value);this.dirty();return;}const f=this.refs.get(e.target.dataset.field);if(!f)return;f.object[f.key]=f.type==='checkbox'?e.target.checked:f.type==='number'?Number(e.target.value):e.target.value;this.dirty();}
  change(e){
    if(e.target.dataset.tag){this.flush();setEventTag(this.event,e.target.dataset.tag,e.target.value);this.blocks=this.event.pages.map(p=>decodeCommands(p.list));this.dirty();const scroll=this.dialog.querySelector('.ee-body').scrollTop;this.render();this.dialog.querySelector('.ee-body').scrollTop=scroll;return;}
    if(e.target.dataset.refresh){const scroll=this.dialog.querySelector('.ee-body').scrollTop;this.render();this.dialog.querySelector('.ee-body').scrollTop=scroll;}
  }
  error(message){this.dialog.querySelector('.ee-error').textContent=message;}
  close(force=false){if(!force&&this.changed&&!confirm('放弃这个事件尚未应用的修改？'))return;this.dialog.close();this.dialog.remove();this.onClose?.();}
  render(){
    const expandedSections=['ee-entity','ee-tools'].filter(name=>this.dialog.querySelector(`.${name}[open]`));
    this.flushTools();this.refs.clear();this.serial=0;const e=this.event,p=e.pages[this.pageIndex],c=p.conditions,img=p.image;
    this.dialog.innerHTML=`<div class="ee-heading"><div><h2>事件 ${e.id} · ${esc(e.name)}</h2><span data-draft-state>${this.changed?'事件草稿有修改':'编辑后应用到地图草稿，再保存地图'}</span></div><button data-action="duplicateEvent">复制事件</button><button data-action="deleteEvent" class="danger">删除事件</button><button data-action="close">取消</button><button data-action="apply" class="primary">应用事件</button></div><p class="ee-error" role="alert"></p><div class="ee-body"><section class="ee-basics"><div class="fields">${this.control('事件名称',e,'name')}${this.control('X',e,'x','number',null,`min="0" max="${this.map.width-1}"`)}${this.control('Y',e,'y','number',null,`min="0" max="${this.map.height-1}"`)}</div><details class="ee-entity"><summary>副本实体与服务 · 无需手写标签</summary><p class="hint">这些属性作用于整个事件；条件页控制对话与原生事件内容。NPC 的战斗属性和掉落在“经济与奖励”配置。原有主城副本入口和外观服务保留，分别由地图 41 / 43 的唯一入口提供。</p><div class="fields">${this.tags()}</div></details></section>
      <div class="ee-pages"><strong>事件页</strong>${e.pages.map((_,i)=>`<button data-action="page" data-index="${i}" class="${i===this.pageIndex?'active':''}">${i+1}</button>`).join('')}<button data-action="newPage">＋ 新页</button><button data-action="copyPage">复制页</button><button data-action="pageLeft" ${this.pageIndex===0?'disabled':''}>前移</button><button data-action="pageRight" ${this.pageIndex===e.pages.length-1?'disabled':''}>后移</button><button data-action="deletePage" ${e.pages.length===1?'disabled':''}>删除页</button></div>
      <p class="hint">多个页面满足条件时，编号最大的页面生效。独立开关适合一次性对话、任务进度和箱子状态。</p>
      <div class="ee-columns"><section class="ee-settings"><h3>出现条件</h3><div class="fields">${this.condition(c,'switch1Valid','开关 1','switch1Id',this.named('switches'))}${this.condition(c,'switch2Valid','开关 2','switch2Id',this.named('switches'))}${this.condition(c,'variableValid','变量 ≥','variableId',this.named('variables'))}${this.control('变量阈值',c,'variableValue','number')}${this.condition(c,'selfSwitchValid','独立开关','selfSwitchCh',['A','B','C','D'].map(x=>[x,x]),'text')}${this.condition(c,'itemValid','持有物品','itemId',this.db('Items'))}${this.condition(c,'actorValid','角色在队伍','actorId',this.db('Actors'))}</div>
      <h3>触发与显示</h3><div class="fields">${this.control('触发方式',p,'trigger','number',[[0,'确定键'],[1,'玩家接触'],[2,'事件接触'],[3,'自动执行'],[4,'并行处理']])}${this.control('优先级',p,'priorityType','number',[[0,'人物下方'],[1,'与人物相同'],[2,'人物上方']])}${this.control('角色图',img,'characterName','text',this.asset('characters'),'data-refresh="image"')}${this.control('角色编号',img,'characterIndex','number',Array.from({length:8},(_,i)=>[i,`${i+1}（索引 ${i}）`]),'data-refresh="image"')}${this.control('朝向',img,'direction','number',directions,'data-refresh="image"')}${this.control('图案帧',img,'pattern','number',[[0,'左帧'],[1,'中帧'],[2,'右帧']],'data-refresh="image"')}${this.control('图块图像 ID（0 使用角色图）',img,'tileId','number')}${['walkAnime','stepAnime','directionFix','through'].map((k,i)=>this.control(['行走动画','踏步动画','固定朝向','穿透'][i],p,k,'checkbox')).join('')}</div><canvas class="ee-sprite" width="144" height="144" aria-label="事件角色图预览"></canvas>
      <details><summary>原生自主移动与兼容字段</summary><p class="hint">保留 MV / MZ 自主移动设置。当前在线运行时的普通事件请使用“设置移动路线”指令控制移动；NPC 使用服务器 AI。</p><div class="fields">${this.control('自主移动',p,'moveType','number',[[0,'固定'],[1,'随机'],[2,'接近'],[3,'自定义']])}${this.control('速度',p,'moveSpeed','number',[1,2,3,4,5,6].map(n=>[n,n]))}${this.control('频率',p,'moveFrequency','number',[1,2,3,4,5].map(n=>[n,n]))}</div>${this.routeEditor(p.moveRoute.list)}<div class="fields">${['repeat','skippable','wait'].map((k,i)=>this.control(['循环','受阻跳过','等待完成'][i],p.moveRoute,k,'checkbox')).join('')}</div></details>
      <details><summary>其他插件 Note（原样保留）</summary>${this.control('事件 Note',e,'note','textarea')}</details></section>
      <section class="ee-commands">${[25,27].includes(this.mapId)?this.pageIndex===0?this.toolPanel(p):'<p class="hint">实时工具定义只读取第 1 页，请切换到第 1 页编辑工具参数。</p>':''}<h3>第 ${this.pageIndex+1} 页 · 执行内容</h3><p class="hint">添加指令后展开填写参数。分支内可继续添加指令；特殊脚本和未适配指令显示为只读块，不会在编辑时执行。</p>${this.commandList(this.blocks[this.pageIndex])}</section></div></div>`;
    for(const name of expandedSections){const section=this.dialog.querySelector(`.${name}`);if(section)section.open=true;}
    this.drawSprite();
  }
  condition(c,enabled,label,key,items,type='number'){return `<div class="ee-condition">${this.control(label,c,enabled,'checkbox')}${this.control('条件值',c,key,type,items)}</div>`;}
  tags(){const g=this.gameplay||{},rows=[['engine_npc','NPC 模板',Object.entries(g.npcs||{}).map(([k,v])=>[k,v.name||k])],['engine_structure','可破坏结构',Object.keys(g.structures||{}).map(k=>[k,k])],['engine_shop','商店',Object.entries(g.shops||{}).map(([k,v])=>[k,v.name||k])],['engine_container','物资箱模板',[...new Set([...Object.values(g.scenarios||{}).flatMap(s=>Object.keys(s.containerLoot||{})),...([31,32,33,34,35,36,37,38,39].includes(this.mapId)?['medical','supplies','ammo','weapon_throw','weapon_firearm','weapon_staff','weapon_club']:[])])].map(k=>[k,k])],['engine_service','冒险服务',[['meteorDisk','回收目标'],['meteorExit','入口撤离']]]];return rows.map(([key,label,items])=>`<label>${label}<select data-tag="${key}">${options([['','无'],...items],eventTag(this.event,key))}</select></label>`).join('');}
  commandList(blocks){const ref=this.ref(blocks);return `<div class="ee-command-list">${blocks.map((block,index)=>this.commandBlock(block,ref,index)).join('')}<div class="ee-add"><select aria-label="添加指令类型" data-add-type="${ref}">${[...new Set(commandCatalog.map(c=>c.category))].map(cat=>`<optgroup label="${esc(cat)}">${commandCatalog.filter(c=>c.category===cat).map(c=>`<option value="${c.type}">${esc(c.label)}</option>`).join('')}</optgroup>`).join('')}</select><button data-action="addCommand" data-ref="${ref}">＋ 添加指令</button></div></div>`;}
  commandBlock(b,listRef,index){
    const ref=this.ref(b),definition=commandCatalog.find(c=>c.type===b.type),title=definition?.label||'保留的特殊指令';
    let fields=b.type==='raw'?`<p class="hint">${esc(b.reason)}。可移动或删除，原参数保持不变。</p><pre>${esc(JSON.stringify(b.raw,null,2))}</pre>`:`<div class="fields">${(definition?.fields||[]).filter(f=>!f.when||(f.when.values||[f.when.value]).includes(b.values[f.when.key])).map(f=>this.commandField(b,f)).join('')}</div>`;
    if(b.type==='conditional'){fields+=`<h4>条件成立</h4>${this.commandList(b.children)}${b.elseChildren?`<h4>否则 <button data-action="deleteElse" data-ref="${ref}">移除否则分支</button></h4>${this.commandList(b.elseChildren)}`:`<button data-action="addElse" data-ref="${ref}">＋ 否则分支</button>`}`;}
    if(b.type==='loop')fields+=this.commandList(b.children);
    if(b.type==='choices')fields+=b.branches.map((branch,i)=>`<section class="ee-branch">${this.control(`选项 ${i+1}`,branch,'label')}<button data-action="deleteChoice" data-ref="${ref}" data-index="${i}" ${b.branches.length<2?'disabled':''}>移除此选项</button>${this.commandList(branch.commands)}</section>`).join('')+`<button data-action="addChoice" data-ref="${ref}" ${b.branches.length>=6?'disabled':''}>＋ 选项分支</button>${b.values.cancelType===-2?`<h4>按取消键时</h4>${this.commandList(b.cancel??(b.cancel=[]))}`:''}`;
    if(b.type==='moveRoute')fields+=this.routeEditor(b.route);
    return `<details class="ee-block" ${this.openBlocks?.has(b)||!b.raw?'open':''} data-block-ref="${ref}"><summary><span>${esc(title)} <small>${esc(commandSummary(b,{database:this.content.database,maps:this.content.maps})).slice(0,180)}</small></span></summary><div class="ee-block-tools">${['up','down','copy','remove'].map((action,i)=>`<button data-action="${action}Command" data-ref="${listRef}" data-index="${index}">${['上移','下移','复制','删除'][i]}</button>`).join('')}</div><div class="ee-block-body">${fields}</div></details>`;
  }
  commandField(b,f){let items=f.options,type=f.type;const db={itemId:'Items',weaponId:'Weapons',armorId:'Armors',commonEventId:'CommonEvents',animationId:'Animations'}[f.key];
    if(db)items=this.db(db);if(f.key==='mapId')items=this.content.maps.map(m=>[m.id,`${m.id} · ${m.name}`]);
    if(f.key==='faceName')items=this.asset('faces');if(f.key==='faceIndex')items=Array.from({length:8},(_,i)=>[i,`${i+1}（索引 ${i}）`]);
    if(f.key==='targetId')items=[[-1,'玩家'],[0,'本事件'],...this.map.events.filter(Boolean).map(e=>[e.id,`${e.id} · ${e.name}`])];
    if(f.key==='name'&&['sound','bgm'].includes(b.type))items=this.asset(b.type==='sound'?'se':'bgm');
    if(['switchId','variableId'].includes(f.key))items=this.named(f.key==='switchId'?'switches':'variables');
    if(['startId','endId'].includes(f.key)&&['switches','variables'].includes(b.type))items=this.named(b.type);
    if(f.key==='cancelType')items=[[-2,'进入取消分支'],[-1,'禁止取消'],...b.branches.map((v,i)=>[i,`选择：${v.label}`])];
    if(f.key==='defaultType')items=[[-1,'不选择默认项'],...b.branches.map((v,i)=>[i,v.label])];
    const refresh=['condition','operandType','cancelType'].includes(f.key)?'data-refresh="command"':'';
    const compatibility=(f.key==='speakerName'||f.key==='fade'||f.key==='includeEquipment'||(f.key==='wait'&&['animation','balloon'].includes(b.type)))?'（保留 RM 字段，在线效果未适配）':'';
    return this.control(f.label+compatibility,b.values,f.key,type,items,refresh);
  }
  toolPanel(page){const fields=[['tool_range','范围（格）',1],['tool_duration','持续（帧）',10],['tool_pose_duration','动作／冷却（帧）',18],['tool_skill_id','技能 ID',1],['tool_item_id','物品 ID',0],['tool_item_cost','消耗物品 ID',0]];return `<details class="ee-tools"><summary>实时工具参数 · 自动生成 Tool Map 注释</summary><p class="hint">本事件 ID 就是 Tool ID。将武器的实时攻击配置引用到此工具。其余旧工具注释保留。</p><div class="fields">${fields.map(([key,label,value])=>`<label>${label}<input type="number" min="0" max="36000" data-tool="${key}" value="${esc(toolValue(page,key)??value)}"></label>`).join('')}<label>范围形状<select data-tool="tool_area">${options(['square','line','rhombus','front_square','front_rhombus'].map(s=>[s,s]),toolValue(page,'tool_area')||'square')}</select></label>${['tool_projectile','tool_disable_piercing'].map((key,i)=>`<label class="check"><input type="checkbox" data-tool="${key}" ${toolValue(page,key)?'checked':''}>${['飞行投射物','禁止穿透'][i]}</label>`).join('')}</div></details>`;}
  routeEditor(route){const ref=this.ref(route);return `<div class="ee-route"><h4>移动步骤</h4>${route.map((step,index)=>{if(step.code===0)return'';let fields='';const labels=step.code===14?['跳跃 X','跳跃 Y']:step.code===15?['等待帧数']:[27,28].includes(step.code)?['开关 ID']:[29,30].includes(step.code)?['数值']:[];for(let i=0;i<labels.length;i++)fields+=this.control(labels[i],step.parameters,i,'number');return `<div class="ee-route-step"><span>${index+1}. ${routeNames[step.code]||`保留步骤 ${step.code}`}</span>${fields}${!routeNames[step.code]?`<code>${esc(JSON.stringify(step.parameters))}</code>`:''}<button data-action="routeUp" data-ref="${ref}" data-index="${index}">↑</button><button data-action="routeDown" data-ref="${ref}" data-index="${index}">↓</button><button data-action="routeRemove" data-ref="${ref}" data-index="${index}">×</button></div>`;}).join('')}<div class="ee-add"><select data-route-type="${ref}" aria-label="移动步骤类型">${options(Object.entries(routeNames),1)}</select><button data-action="routeAdd" data-ref="${ref}">＋ 移动步骤</button></div></div>`;}
  action(button){
    const action=button.dataset.action,ref=this.refs.get(button.dataset.ref),index=Number(button.dataset.index);
    this.openBlocks=new Set([...this.dialog.querySelectorAll('details[data-block-ref][open]')].map(d=>this.refs.get(d.dataset.blockRef)));
    if(action==='close')return this.close();
    if(action==='deleteEvent'){if(!confirm('从地图草稿删除整个事件？可在地图中撤销。'))return;this.onDelete?.();return this.close(true);}
    if(action==='duplicateEvent'){this.onDuplicate?.(clone(this.flush()));return this.close(true);}
    if(action==='apply'){
      if(!this.event.name.trim())throw new Error('请填写事件名称');
      if(!Number.isInteger(this.event.x)||!Number.isInteger(this.event.y)||this.event.x<0||this.event.y<0||this.event.x>=this.map.width||this.event.y>=this.map.height)throw new Error('事件坐标必须在地图内');
      const event=this.flush();this.onApply(clone(event));return this.close(true);
    }
    if(action==='page'){this.pageIndex=index;this.render();return;}
    if(action==='newPage'||action==='copyPage'){if(this.event.pages.length>=99)throw new Error('每个事件最多 99 页');const page=action==='copyPage'?clone(this.flush().pages[this.pageIndex]):newPage();this.event.pages.push(page);this.blocks.push(decodeCommands(page.list));this.pageIndex=this.event.pages.length-1;}
    if(['deletePage','pageLeft','pageRight'].includes(action))this.flushTools();
    if(action==='deletePage'){if(this.event.pages.length<=1)return;if(!confirm('删除这一页及其全部指令？'))return;this.event.pages.splice(this.pageIndex,1);this.blocks.splice(this.pageIndex,1);this.pageIndex=Math.min(this.pageIndex,this.event.pages.length-1);}
    if(action==='pageLeft'||action==='pageRight'){const to=this.pageIndex+(action==='pageLeft'?-1:1);for(const rows of[this.event.pages,this.blocks])[rows[this.pageIndex],rows[to]]=[rows[to],rows[this.pageIndex]];this.pageIndex=to;}
    if(action==='addCommand'){ref.push(createBlock(this.dialog.querySelector(`[data-add-type="${button.dataset.ref}"]`).value));}
    if(action==='removeCommand'){if(!confirm('删除这条指令及其中的分支内容？'))return;ref.splice(index,1);}
    if(action==='copyCommand')ref.splice(index+1,0,clone(ref[index]));
    if(action==='upCommand'&&index>0)[ref[index-1],ref[index]]=[ref[index],ref[index-1]];
    if(action==='downCommand'&&index<ref.length-1)[ref[index+1],ref[index]]=[ref[index],ref[index+1]];
    if(action==='addElse')ref.elseChildren=[];
    if(action==='deleteElse'){if(!confirm('移除否则分支及其指令？'))return;delete ref.elseChildren;}
    if(action==='addChoice')ref.branches.push({label:`选项 ${ref.branches.length+1}`,commands:[]});
    if(action==='deleteChoice'){if(!confirm('移除此选项及其指令？'))return;ref.branches.splice(index,1);for(const key of['cancelType','defaultType'])if(ref.values[key]>=index)ref.values[key]=Math.max(key==='cancelType'?-1:0,ref.values[key]-1);}
    if(action==='routeAdd'){const code=Number(this.dialog.querySelector(`[data-route-type="${button.dataset.ref}"]`).value),parameters=code===14?[0,0]:code===15?[60]:[27,28,29,30].includes(code)?[1]:[];ref.splice(Math.max(0,ref.length-1),0,{code,parameters});}
    if(action==='routeRemove')ref.splice(index,1);
    if(action==='routeUp'&&index>0)[ref[index-1],ref[index]]=[ref[index],ref[index-1]];
    if(action==='routeDown'&&index<ref.length-2)[ref[index+1],ref[index]]=[ref[index],ref[index+1]];
    this.dirty();const scroll=this.dialog.querySelector('.ee-body').scrollTop;this.render();this.dialog.querySelector('.ee-body').scrollTop=scroll;
  }
  drawSprite(){
    const canvas=this.dialog.querySelector('.ee-sprite'),ctx=canvas.getContext('2d'),img=this.event.pages[this.pageIndex].image;
    if(!img.characterName||img.tileId)return;const bitmap=new Image();bitmap.onload=()=>{if(!canvas.isConnected)return;const big=/(?:^|\/)\$/.test(img.characterName),w=bitmap.width/(big?3:12),h=bitmap.height/(big?4:8),index=big?0:img.characterIndex,x=((index%4)*3+(img.pattern??1))*w,y=(Math.floor(index/4)*4+Math.max(0,(img.direction-2)/2))*h,scale=Math.min(2,128/w,128/h);ctx.imageSmoothingEnabled=false;ctx.drawImage(bitmap,x,y,w,h,(144-w*scale)/2,(144-h*scale)/2,w*scale,h*scale);};bitmap.src=`/assets/img/characters/${encodeURIComponent(img.characterName)}.png`;
  }
}
