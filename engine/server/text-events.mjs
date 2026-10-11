// Data-only adapters for the editor's text plugins. Never evaluate event JavaScript.
const number=(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback;
const clamp=(value,min,max,fallback=min)=>Math.max(min,Math.min(max,number(value,fallback)));
const bool=(value,fallback=false)=>value===undefined?fallback:String(value).toLowerCase()==='true';
const pluginParameters=(content,name)=>content.plugins?.find(p=>p.name===name&&p.status!==false)?.parameters||{};
export function importTextConfig(plugins=[]) {
  return Object.fromEntries(Object.entries({messageCore:'YEP_MessageCore',extended1:'YEP_X_ExtMesPack1',extended2:'YEP_X_ExtMesPack2',shaking:'SRD_ShakingText',fonts:'YEP_LoadCustomFonts',gab:'YEP_GabWindow',popup:'MMO_iavra_event_popup'}).map(([key,name])=>[key,plugins.find(p=>p.name===name&&p.status!==false)?.parameters||{}]));
}

const GAB_COMMANDS=new Set(['GabText','GabFaceName','GabFaceIndex','GabSpriteName','GabSpriteIndex','GabActor','GabActorFace','GabActorSprite','GabParty','GabPartyFace','GabPartySprite','GabSound','GabSwitch','WaitForGab','ShowGab','ForceGab','ClearGab']);
const MESSAGE_COMMANDS=new Set(['MessageRows','MessageWidth','EnableWordWrap','DisableWordWrap','EnableFastForward','DisableFastForward','EnableLetterSound','DisableLetterSound','LetterSoundName','LetterSoundVolume','LetterSoundPitch','LetterSoundPitchVariance','LetterSoundPan','LetterSoundPanVariance','LetterSoundInterval','LetterSoundReset','ChoiceRowMax','HideChoice','ShowChoice','ClearHiddenChoices','DisableChoice','EnableChoice','ClearDisabledChoices','ClearChoiceSettings','MessagePositionX','MessagePositionY','MessagePositionXAuto','MessagePositionYAuto','MessageAnchorX','MessageAnchorY','MessagePositionReset']);
export function isTextPluginCommand(source) {const name=String(source).trim().split(/\s+/)[0];return GAB_COMMANDS.has(name)||MESSAGE_COMMANDS.has(name)||name==='EventPopup';}

/** A tiny JS literal reader, intentionally excluding calls, computed keys and prototypes. */
function popupArguments(source) {
  let index=0;
  const skip=()=>{while(/\s/.test(source[index]||'')&&index<source.length)index++;};
  const expect=token=>{skip();if(source[index++]!==token)throw new Error('Invalid popup arguments');};
  function string(){skip();const quote=source[index++];if(!['"',"'"].includes(quote))throw new Error('Popup text must be a quoted string');let out='';
    while(index<source.length){let c=source[index++];if(c===quote)return out;if(c==='\n'||c==='\r')throw new Error('Unescaped newline in string');if(c==='\\'){c=source[index++];if(c===undefined)throw new Error('Incomplete string escape');const escapes={n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v','0':'\0'};if(c==='u'||c==='x'){const size=c==='u'?4:2,hex=source.slice(index,index+size);if(!new RegExp(`^[0-9a-fA-F]{${size}}$`).test(hex))throw new Error('Invalid string escape');out+=String.fromCharCode(parseInt(hex,16));index+=size;}else out+=escapes[c]??c;}else out+=c;}throw new Error('Unterminated popup string');}
  function target(){skip();if(source.slice(index).startsWith('this.eventId()')){index+=14;return 'this';}const match=source.slice(index).match(/^-?\d+/);if(!match)throw new Error('Popup target must be an event ID');index+=match[0].length;return Number(match[0]);}
  function options(){expect('{');const result={};skip();while(source[index]!=='}'){const key=/^[A-Za-z]\w*/.exec(source.slice(index));let name;if(key){name=key[0];index+=name.length;}else name=string();expect(':');skip();if(!['width','x','y','duration','fadeIn','fadeOut','fontName','fontSize','lineHeight'].includes(name))throw new Error(`Unknown popup option ${name}`);if(name==='fontName')result[name]=string();else{const value=source.slice(index).match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)/);if(!value)throw new Error('Popup options must be literals');result[name]=Number(value[0]);index+=value[0].length;}skip();if(source[index]!==',')break;index++;skip();}expect('}');return result;}
  return {target,string,options,expect,end(){skip();return index===source.length;}};
}
export function parseTextScript(source) {
  const s=String(source).trim().replace(/;\s*$/,'');if(s.length>12000)throw new Error('Text script too long');
  let m=s.match(/^IAVRA\.EVENTPOPUP\.(popup|clear)\(([\s\S]*)\)$/);
  if(m){const read=popupArguments(m[2]);if(m[1]==='clear'){const target=read.end()?null:read.target();if(!read.end())throw new Error('Unexpected popup arguments');return {kind:'popupClear',target};}const target=read.target();read.expect(',');const text=read.string();let options={};if(!read.end()){read.expect(',');options=read.options();}if(!read.end())throw new Error('Unexpected popup arguments');return {kind:'popup',target,text,options};}
  m=s.match(/^\$gameSystem\.(hideChoice|showChoice|disableChoice|enableChoice)\(\s*(\d+)\s*\)$/);
  if(m)return{kind:'command',source:m[1][0].toUpperCase()+m[1].slice(1)+' '+m[2]};
  m=s.match(/^\$gameSystem\.(clearHiddenChoices|clearDisabledChoices|clearChoiceSettings)\(\s*\)$/);
  if(m)return{kind:'command',source:m[1][0].toUpperCase()+m[1].slice(1)};
  if(/^(?:MMO_Overhead\.forceRefresh|this\.refreshEventMiniLabel)\(\s*\)$/.test(s))return{kind:'refresh'};
  return null;
}

export class EventTextPresentation {
  constructor(runtime){this.runtime=runtime;this.settings=new Map();this.gabs=new Map();this.nextGabId=0;this.pageLabels=new WeakMap();}
  get content(){return this.runtime.content;}
  config(name){return this.content.textConfig?.[name]||pluginParameters(this.content,{messageCore:'YEP_MessageCore',extended1:'YEP_X_ExtMesPack1',gab:'YEP_GabWindow',popup:'MMO_iavra_event_popup'}[name]);}
  defaultSettings(){const core=this.config('messageCore'),ext=this.config('extended1');return{rows:clamp(core['Default Rows'],1,100,4),width:Number.isFinite(Number(core['Default Width']))?clamp(core['Default Width'],100,4096,816):null,wordWrap:bool(core['Word Wrapping']),fastForward:bool(core['Enable Fast Forward'],true),x:'auto',y:'auto',anchorX:/right/i.test(ext['Default X']||'')?1:/left/i.test(ext['Default X']||'')?0:.5,anchorY:/top/i.test(ext['Default Y']||'')?0:/center/i.test(ext['Default Y']||'')?.5:1,choiceRowMax:clamp(ext['Max Rows'],1,100,6),letterSoundRevision:0,letterSound:{enabled:bool(ext['Enable Sound']),name:ext['Sound Name']||'Cursor1',volume:clamp(ext['Sound Volume'],0,100,50),pitch:clamp(ext['Sound Pitch'],0,200,100),pitchVariance:clamp(ext['Pitch Variance'],0,200,10),pan:clamp(ext['Sound Pan'],-100,100,0),panVariance:clamp(ext['Pan Variance'],0,100,10),interval:clamp(ext['Sound Interval'],0,100,2)}};}
  state(player){if(!this.settings.has(player.id)){this.settings.set(player.id,{...this.defaultSettings(),hiddenChoices:new Set(),disabledChoices:new Set()});this.resetChoices(player,'hiddenChoices');this.resetChoices(player,'disabledChoices');}return this.settings.get(player.id);}
  resetChoices(player,key){const state=this.settings.get(player.id);state[key].clear();const ext=this.config('extended1'),type=key==='hiddenChoices'?'Show':'On';for(let i=1;i<=20;i++){const id=number(ext[`Choice ${i} ${type} Switch`]);if(id>0)this.runtime.setSwitch(player,id,true);}}
  messageSettings(player,params=[]){const {hiddenChoices,disabledChoices,...settings}=this.state(player);return{...settings,letterSound:{...settings.letterSound},faceName:String(params[0]||''),faceIndex:clamp(params[1],0,7,0),background:clamp(params[2],0,2,0),positionType:clamp(params[3],0,2,2)};}
  choiceMetadata(player,choices){const state=this.state(player),ext=this.config('extended1');return choices?.map((_,index)=>{const show=number(ext[`Choice ${index+1} Show Switch`]),on=number(ext[`Choice ${index+1} On Switch`]);return{index,hidden:state.hiddenChoices.has(index)||(show>0&&!this.runtime.switch(player,show)),disabled:state.disabledChoices.has(index)||(on>0&&!this.runtime.switch(player,on))};});}
  textContext(player,text=null){
    const r=this.runtime,db=this.content.database||{},actorId=player.actorId||db.System?.partyMembers?.[0]||1,rawActor=db.Actors?.[actorId]||{},actor={id:actorId,name:player.name||rawActor.name||'',nickname:player.nickname??rawActor.nickname??'',classId:player.classId||rawActor.classId||1,faceName:player.faceName??rawActor.faceName??'',faceIndex:player.faceIndex??rawActor.faceIndex??0,characterName:player.characterName??rawActor.characterName??'',characterIndex:player.characterIndex??rawActor.characterIndex??0,level:player.level||1,hp:number(player.hp),mp:number(player.mp),tp:number(player.tp),mhp:number(player.maxHp),mmp:number(player.maxMp),mtp:100,...player.stats};
    let variables={...player.variables},switches={...player.switches},inventory=(player.inventory||[]).map(x=>({kind:x.kind,itemId:x.itemId,quantity:x.quantity}));
    if(text!==null){variables={};switches={};let source=String(text);for(let pass=0;pass<4;pass++){for(const m of source.matchAll(/(?:\\V\[|\bv\[|\$gameVariables\.value\(\s*)(\d+)/gi))variables[m[1]]=r.variable(player,+m[1]);const expanded=source.replace(/\\V\[(\d+)\]/gi,(_,id)=>String(variables[id]??0));if(expanded===source)break;source=expanded;}for(const m of source.matchAll(/(?:\bs\[|\$gameSwitches\.value\(\s*|\\caseSwitch\{\s*)(\d+)/gi))switches[m[1]]=r.switch(player,+m[1]);const counts=new Set([...source.matchAll(/\\Q([IWA])\[(\d+)\]/gi)].map(m=>`${{I:'item',W:'weapon',A:'armor'}[m[1].toUpperCase()]}:${m[2]}`));inventory=inventory.filter(item=>counts.has(`${item.kind}:${item.itemId}`));}
    else{for(const id of Object.keys(variables))variables[id]=r.variable(player,+id);for(const id of Object.keys(switches))switches[id]=r.switch(player,+id);}
    return{variables,switches,actors:{[actorId]:actor},party:[actorId],inventory,enemies:[],mapId:player.mapId,playtime:Math.floor(r.time),gold:text===null||/\$gameParty\.gold\(\)/.test(String(text))?number(player.gold):0,currencyUnit:db.System?.currencyUnit||'Gold'};
  }
  overheadFor(player,event,selected){const page=selected?.page||selected;if(!page||event.erased||page.engineDisabledReason)return null;let label=this.pageLabels.get(page);if(label===undefined){const comments=(page.list||[]).filter(c=>c.code===108||c.code===408).map(c=>c.parameters?.[0]||'').join('\n');const names=[...comments.matchAll(/<Name:\s*([^\r\n]*?)>/gi)];const text=names.at(-1)?.[1]||'';label=text?{text,quest:/<Is\s+Quest>/i.test(comments),fontSize:14,range:5,offsetY:36}:null;this.pageLabels.set(page,label);}if(!label)return null;return {...label,...(label.text.includes('\\')?{textContext:this.textContext(player,label.text)}:{})};}
  popupOptions(overrides={}){const p=this.config('popup'),defaults={width:number(p['Popup Width'],200),x:number(p['Offset X']),y:number(p['Offset Y'],-50),duration:number(p['Display Duration'],200),fadeIn:number(p['Fade In Duration'],10),fadeOut:number(p['Fade Out Duration'],60),fontName:p['Font Name']||'',fontSize:number(p['Font Size'],12),lineHeight:number(p['Line Height'],18)},out={...defaults,...overrides};for(const key of ['width','fontSize','lineHeight'])out[key]=clamp(out[key],1,key==='width'?2048:200,defaults[key]);for(const key of ['duration','fadeIn','fadeOut'])out[key]=clamp(out[key],0,36000,defaults[key]);for(const key of ['x','y'])out[key]=clamp(out[key],-4096,4096);out.fontName=String(out.fontName).slice(0,200);return out;}
  popup(task,player,parsed){const r=this.runtime;let target;if(parsed.target!==null){target=parsed.target==='this'||parsed.target===0?task.event:parsed.target===-1?player:r.character(task,player,parsed.target);if(!target)throw new Error(`Missing popup event ${parsed.target}`);}const packet={type:'eventEffect',code:parsed.kind,mapId:task.mapId,eventId:target?.id??target?.eventId??null};if(parsed.kind==='popup')Object.assign(packet,{text:parsed.text,options:this.popupOptions(parsed.options),textContext:this.textContext(player,parsed.text)});r.world.broadcast(task.mapId,packet);}
  script(task,player,parsed){if(parsed.kind==='command')return this.plugin(task,player,parsed.source);if(parsed.kind==='refresh')return true;this.popup(task,player,parsed);return true;}
  plugin(task,player,source){const [name,...parts]=String(source).trim().split(/\s+/),arg=parts.join(' ');if(name==='EventPopup'){const action=parts.shift(),raw=parts.shift();if(action==='popup'){if(raw===undefined)throw new Error('Missing popup event');this.popup(task,player,{kind:'popup',target:raw==='this'?'this':this.eventTarget(raw),text:parts.join(' '),options:{}});}else if(action==='clear'||action==='clean')this.popup(task,player,{kind:'popupClear',target:raw===undefined?null:raw==='this'?'this':this.eventTarget(raw)});else throw new Error(`Unsupported EventPopup action ${action}`);return true;}
    if(GAB_COMMANDS.has(name)){this.gabCommand(task,player,name,arg);return true;}
    if(!MESSAGE_COMMANDS.has(name))return false;const s=this.state(player),positive=()=>{if(!/^\d+$/.test(arg))throw new Error(`${name} requires a positive integer`);return Number(arg);};
    if(name.startsWith('LetterSound')||name==='EnableLetterSound'||name==='DisableLetterSound')s.letterSoundRevision++;
    switch(name){
      case 'MessageRows':s.rows=clamp(positive(),1,100,4);break;
      case 'MessageWidth':s.width=arg==='Graphics.boxWidth'?null:arg==='auto'?'auto':clamp(positive(),100,4096,816);break;
      case 'EnableWordWrap':case 'DisableWordWrap':s.wordWrap=name==='EnableWordWrap';break;
      case 'EnableFastForward':case 'DisableFastForward':s.fastForward=name==='EnableFastForward';break;
      case 'MessagePositionX':case 'MessagePositionY':if(!/^-?\d+$/.test(arg))throw new Error('Message position must be numeric');s[name.endsWith('X')?'x':'y']=clamp(arg,-4096,4096);break;
      case 'MessagePositionXAuto':case 'MessagePositionYAuto':s[name.includes('X')?'x':'y']='auto';break;
      case 'MessageAnchorX':case 'MessageAnchorY':s[name.endsWith('X')?'anchorX':'anchorY']=/center/i.test(arg)?.5:/right|bottom/i.test(arg)?1:0;break;
      case 'MessagePositionReset':{const defaults=this.defaultSettings();for(const key of ['x','y','anchorX','anchorY','rows','width'])s[key]=defaults[key];break;}
      case 'ChoiceRowMax':s.choiceRowMax=clamp(positive(),1,100,6);break;
      case 'HideChoice':case 'ShowChoice':case 'DisableChoice':case 'EnableChoice':{const id=positive()-1;if(id<0)break;const hidden=name==='HideChoice'||name==='ShowChoice',key=hidden?'hiddenChoices':'disabledChoices',enabled=name==='ShowChoice'||name==='EnableChoice';s[key][enabled?'delete':'add'](id);const switchId=number(this.config('extended1')[`Choice ${id+1} ${hidden?'Show':'On'} Switch`]);if(switchId)this.runtime.setSwitch(player,switchId,enabled);break;}
      case 'ClearHiddenChoices':this.resetChoices(player,'hiddenChoices');break;
      case 'ClearDisabledChoices':this.resetChoices(player,'disabledChoices');break;
      case 'ClearChoiceSettings':this.resetChoices(player,'hiddenChoices');this.resetChoices(player,'disabledChoices');break;
      case 'EnableLetterSound':case 'DisableLetterSound':s.letterSound.enabled=name==='EnableLetterSound';break;
      case 'LetterSoundReset':s.letterSound=this.defaultSettings().letterSound;break;
      case 'LetterSoundName':s.letterSound.name=arg.slice(0,200);break;
      default:{if(!/^-?\d+$/.test(arg))throw new Error('Letter sound setting must be numeric');const keys={LetterSoundVolume:'volume',LetterSoundPitch:'pitch',LetterSoundPitchVariance:'pitchVariance',LetterSoundPan:'pan',LetterSoundPanVariance:'panVariance',LetterSoundInterval:'interval'},key=keys[name];s.letterSound[key]=clamp(arg,key==='pan'?-100:0,key==='pitch'||key==='pitchVariance'?200:100);}
    }return true;
  }
  eventTarget(value){if(!/^-?\d+$/.test(value))throw new Error('Invalid popup event');return Number(value);}
  gabState(player){if(!this.gabs.has(player.id))this.gabs.set(player.id,{queue:[],current:null,lastKey:null});return this.gabs.get(player.id);}
  gabCommand(task,player,name,arg){task.gab??={text:'',graphicType:'none',graphicName:'',graphicIndex:0,soundName:'',switchId:0};const g=task.gab;
    if(name==='GabText')g.text=arg;
    else if(name==='GabSound')g.soundName=arg;
    else if(name==='GabSwitch')g.switchId=clamp(arg,0,100000);
    else if(/Name$/.test(name)){g.graphicType=name==='GabFaceName'?'face':'character';g.graphicName=arg;g.appearance=null;}
    else if(/Index$/.test(name)){g.graphicType=name==='GabFaceIndex'?'face':'character';g.graphicIndex=clamp(arg,0,7);g.appearance=null;}
    else if(/^Gab(?:Actor|Party)/.test(name)){const actorId=name.startsWith('GabParty')?(Number(arg)===1?player.actorId||this.content.database.System?.partyMembers?.[0]||1:0):number(arg),actor=this.content.database.Actors?.[actorId];if(actor){const own=actorId===(player.actorId||this.content.database.System?.partyMembers?.[0]||1),character=name.endsWith('Sprite');g.appearance=own?player.appearance||null:null;g.graphicType=character?'character':'face';g.graphicName=own?(player[character?'characterName':'faceName']??actor[character?'characterName':'faceName']):actor[character?'characterName':'faceName'];g.graphicIndex=own?(player[character?'characterIndex':'faceIndex']??actor[character?'characterIndex':'faceIndex']):actor[character?'characterIndex':'faceIndex'];}}
    else if(name==='ClearGab'){this.clearGab(player);task.gab=null;}
    else if(name==='WaitForGab'){if(this.gabRunning(player))task.waiting={kind:'gab'};}
    else if(name==='ShowGab'||name==='ForceGab'){if(g.text){this.enqueueGab(player,{...g},name==='ForceGab');task.gab=null;}}
  }
  enqueueGab(player,gab,force=false){const state=this.gabState(player),config=this.config('gab'),key=JSON.stringify(gab);if(force)this.clearGab(player);else if(bool(config['Anti-Repeat'],true)&&(state.lastKey===key||state.queue.some(g=>g.key===key)))return;if(state.queue.length>=100)throw new Error('Gab queue limit');state.queue.push({...gab,key});this.startNextGab(player,state);}
  startNextGab(player,state){if(state.current||!state.queue.length)return;const gab=state.queue.shift(),config=this.config('gab'),visible=gab.text.replace(/\\[a-z]+\[[^\]]*\]/gi,'').replace(/\\[a-z]+<[^>]*>/gi,'').replace(/\\[.!|^><{}$]/g,'').replace(/<\/?(?:WordWrap|br)>/gi,'');const durationFrames=clamp(number(config['Base Wait Time'],90)+[...visible].length*number(config['Time Per Character'],4),1,36000),fadeFrames=Math.ceil(255/clamp(config['Fade Rate'],1,255,16));state.current={...gab,until:this.runtime.time+(durationFrames+fadeFrames)/60};state.lastKey=gab.key;this.runtime.world.send(player.id,{type:'gab',action:'show',id:++this.nextGabId,text:gab.text,graphicType:gab.graphicType,graphicName:gab.graphicName,graphicIndex:gab.graphicIndex,appearance:gab.appearance||null,soundName:gab.soundName,durationFrames,fadeFrames,y:number(config['Map Y Location'],72),fontName:config['Gab Font Name']||'GameFont',fontSize:clamp(config['Gab Font Size'],1,144,28),textContext:this.textContext(player)});}
  clearGab(player){const state=this.gabs.get(player.id);if(state){state.current=null;state.queue=[];state.lastKey=null;this.runtime.world.send(player.id,{type:'gab',action:'clear'});}}
  gabRunning(player){const state=this.gabs.get(player.id);return !!(state?.current||state?.queue.length);}
  update(){for(const id of this.settings.keys())if(!this.runtime.world.players.has(id))this.settings.delete(id);for(const [id,state]of this.gabs){const player=this.runtime.world.players.get(id);if(!player){this.gabs.delete(id);continue;}if(state.current&&state.current.until<=this.runtime.time){if(state.current.switchId)this.runtime.setSwitch(player,state.current.switchId,true);state.current=null;this.startNextGab(player,state);}}}
  cancel(playerId){const player=this.runtime.world.players.get(playerId);if(player)this.clearGab(player);this.gabs.delete(playerId);}
}
