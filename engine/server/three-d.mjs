/** MV3D/MZ3D 0.9.2.8 presentation bridge. This module never executes plugin code. */
export const THREE_D_VERSION='0.9.2.8';
const PLUGIN=/^(?:mv3d|mz3d)$/i;
const NUMBER=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const TARGET=/^[@＠]?(?:p(?:layer)?|s(?:elf)?|e(?:vent)?\d*|f(?:ollower)?\d*|v(?:ehicle)?\d*|\d+)$/i;
const COLOR=/^(?:#[\da-f]{3,8}|0x[\da-f]{1,8}|[a-z]+|\d+)$/i;
const BOOLEAN=/^(?:true|false|on|off|yes|no|enable|disable|enabled|disabled|1|0)$/i;
const FALSE=/^(?:false|off|no|disable|disabled|0|null|none|clear|cleared|undefined)$/i;
const CONFIG_FUNCTIONS=new Set('height elevation z x y xoff yoff zoff offset doff scale rot yaw pitch roll bush shadow shape lamp flashlight flashlightpitch flashlightyaw lightoffset lampoffset flashlightoffset lightheight lampheight flashlightheight alpha glow ambient dirfix texture side alphatest backface model mesh'.split(' '));
const BOOLEAN_PROPERTIES=new Set('lockcamera allowrotation allowpitch inputcameramouse inputcameragamepad animationdepth glowthroughwalls highlightthroughwalls'.split(' '));
const NUMBER_PROPERTIES=new Set('turnincrement turnspeed alphafog glowintensity glowradius highlight highlightradius chromaticaberration chromaticaberrationangle aperture blurstrength focusdistance bloom bloomthreshold bloomradius'.split(' '));
const SKYBOX_SIDES=new Set(['default','north','south','east','west','top','bottom']);

export function importThreeD(plugins=[]) {
  const candidates=plugins.filter(p=>PLUGIN.test(p.name));
  const plugin=candidates.findLast(p=>p.status)||candidates.at(-1);
  return {pluginName:plugin?.name.toLowerCase()||'mv3d',version:THREE_D_VERSION,defaultEnabled:false,parameters:{...plugin?.parameters},commandSemantics:'Personal presentation cues; no durable camera/light replay across reloads, no 3D physics or arbitrary JavaScript'};
}

export function threeDNoteBlocks(note) {
  const blocks=[];
  const re=/<(mv3d|mz3d)(?:\s*>([\s\S]*?)<\/\1\s*>|[: ]([^>]*?)>)/gi;
  for(const m of String(note||'').matchAll(re))blocks.push({pluginName:m[1].toLowerCase(),text:m[2]??m[3]});
  return blocks;
}

export function threeDVariables(...texts) {
  const ids=new Set();
  for(const text of texts)for(const m of String(text||'').matchAll(/\bvar\(\s*(\d+)\s*\)/gi))if(+m[1]>0&&+m[1]<=100000)ids.add(+m[1]);
  return [...ids].sort((a,b)=>a-b);
}

export function mapThreeD(map,tileset,config) {
  const blocks=threeDNoteBlocks(map.note);
  let enabled=false;const pluginName=config?.pluginName||'mv3d';
  for(const block of blocks){
    for(const m of block.text.matchAll(/\benable\(\s*([^()]*)\s*\)/gi)){
      const value=m[1].trim();
      // The historical enable() spelling has the same effect as enable(true).
      if(!value||BOOLEAN.test(value))enabled=!FALSE.test(value);
    }
  }
  const eventConfigs=(map.events||[]).filter(Boolean).flatMap(event=>[event.note,...(event.pages||[]).flatMap(page=>(page.list||[]).filter(c=>c.code===108||c.code===408).map(c=>c.parameters?.[0]))]);
  // Include map-local tile/region/terrain blocks as well as the main map block.
  const variableIds=threeDVariables(map.note,tileset?.note,...eventConfigs,...Object.values(config?.parameters||{}));
  return {enabled,pluginName,declared:blocks.length>0,variableIds};
}

const fail=reason=>{throw new Error(`Unsupported MV3D/MZ3D command: ${reason}`);};
function number(value){const text=String(value).replace(/^\+/,'');return NUMBER.test(text)&&Number.isFinite(Number(text));}
function time(value){return value===undefined||NUMBER.test(String(value))&&Number.isFinite(Number(value))&&Number(value)>=0;}
function count(args,min,max=min){return args.length>=min&&args.length<=max;}
function numeric(args,n){return count(args,n,n+1)&&args.slice(0,n).every(number)&&time(args[n]);}
function color(args,n=0){return count(args,n+1,n+2)&&COLOR.test(args[0])&&args.slice(1,n+1).every(number)&&time(args[n+1]);}
function absoluteNumber(value){return NUMBER.test(String(value))&&Number.isFinite(Number(value));}
function skyIndex(value){return /^\d+$/.test(String(value))&&Number.isSafeInteger(Number(value));}
function skyTexture(value){
  // Sky images are local files below img/parallaxes. Reject protocol URLs and
  // traversal even when URL-encoded; MZ filenames containing spaces are encoded.
  if(typeof value!=='string'||!value||value.length>1024)return false;
  let decoded;try{decoded=decodeURIComponent(value);}catch{return false;}
  if(!/^[\p{L}\p{N}_ .!$@()+,\-/]+$/u.test(decoded))return false;
  return decoded.split('/').every(part=>part.trim()&&part!=='.'&&part!=='..'&&!/^\s|\s$/.test(part));
}
function skyCommand(name,args){
  if(!args.length)return false;
  if(FALSE.test(args[0])&&!absoluteNumber(args[0]))return args.length===1||args.length===2&&skyIndex(args[1]);
  let i=skyIndex(args[0])?1:0,hasTexture=false,hasSetting=false;
  if(i&&args.length===2&&FALSE.test(args[1]))return true;
  for(;i<args.length;i++){
    const key=args[i].toLowerCase();
    if(name==='skybox'?SKYBOX_SIDES.has(key):key==='texture'){
      if(!skyTexture(args[++i]))return false;hasSetting=true;
      if(key===(name==='skybox'?'default':'texture'))hasTexture=true;
    }else if(key==='alpha'||name==='skyball'&&key==='repeat'){
      if(!absoluteNumber(args[++i]))return false;hasSetting=true;
    }else if(key==='autorotate'){
      if(/^(?:yaw|pitch|roll)$/i.test(args[i+1]||'')){
        if(!absoluteNumber(args[i+2]))return false;i+=2;
      }else{
        if(!args.slice(i+1,i+4).every(absoluteNumber)||i+3>=args.length)return false;i+=3;
      }
      hasSetting=true;
    }else if(i===args.length-1&&absoluteNumber(args[i])){
      if(!time(args[i]))return false;
    }else if(!hasTexture&&skyTexture(args[i])){
      hasTexture=hasSetting=true;
    }else return false;
  }
  return hasSetting;
}
function mzSkyTexture(value){
  const source=safeValue(value);if(!skyTexture(source))fail('sky texture must be a local filename or subpath');
  return decodeURIComponent(source).split('/').map(segment=>encodeURIComponent(segment)).join('/');
}
function mzSkyCommand(name,args,duration){
  const index=args.index??'0';if(!skyIndex(index))fail('invalid sky layer index');
  if(args.clear===true||String(args.clear).toLowerCase()==='true')return `${name} clear ${index}`;
  const parts=[name,String(index)],textureKeys=name==='skybox'?[...SKYBOX_SIDES]:['texture'];
  for(const key of textureKeys)if(supplied(args[key]))parts.push(key,mzSkyTexture(args[key]));
  for(const key of name==='skyball'?['repeat','alpha']:['alpha'])if(supplied(args[key]))parts.push(key,safeValue(args[key]));
  if(supplied(args.autoRotate)){
    let vector;try{vector=typeof args.autoRotate==='string'?JSON.parse(args.autoRotate):args.autoRotate;}catch{fail('invalid sky autoRotate');}
    if(!vector||typeof vector!=='object')fail('invalid sky autoRotate');
    const pitch=Array.isArray(vector)?vector[0]:vector.x,yaw=Array.isArray(vector)?vector[1]:vector.y,roll=Array.isArray(vector)?vector[2]:vector.z;
    if(![yaw,pitch,roll].every(absoluteNumber))fail('invalid sky rotation components');
    parts.push('autoRotate',String(yaw),String(pitch),String(roll));
  }
  parts.push(duration);return parts.join(' ');
}
function configText(source){
  if(!source||source.length>4096||/[;{}=`\\\x00-\x08]/.test(source))return false;
  let rest=source.trim(),found=false;
  while(rest){
    rest=rest.replace(/^[,\s]+/,'');if(!rest)break;
    const m=rest.match(/^([a-z][a-z\d_]*)\s*\(/i);if(!m||!CONFIG_FUNCTIONS.has(m[1].toLowerCase()))return false;
    let depth=1,i=m[0].length;
    for(;i<rest.length&&depth;i++){if(rest[i]==='(')depth++;if(rest[i]===')')depth--;}
    if(depth)return false;
    const body=rest.slice(m[0].length,i-1);
    if(!/^[\w\s#.,:+*/%|()[\]!?'"\-]*$/.test(body)||/\b(?:constructor|prototype|__proto__|eval|function|import|fetch|process|window|document|globalThis)\b/i.test(body))return false;
    // Nested expressions are restricted to arithmetic and the documented var(n).
    if([...body.matchAll(/([a-z_]\w*)\s*\(/gi)].some(x=>x[1].toLowerCase()!=='var'))return false;
    found=true;rest=rest.slice(i);
  }
  return found;
}

/** Return null for another plugin; throw for unknown/invalid 3D commands. */
export function parseThreeDCommand(source,{bare=false}={}) {
  let text=String(source||'').trim();
  const prefix=text.match(/^(mv3d|mz3d)\b\s*/i);
  if(prefix)text=text.slice(prefix[0].length);else if(!bare)return null;
  if(text.length>8192||/[\x00-\x1f;{}=`]/.test(text))fail('invalid command text');
  const tokens=text.split(/\s+/),target=/^[@＠]/.test(tokens[0])?tokens.shift():null;
  if(target&&!TARGET.test(target))fail('invalid character target');
  const name=tokens.shift()?.toLowerCase(),a=tokens;
  let valid=false;
  if(['yaw','pitch','roll','dist','zoom','height','elevation'].includes(name))valid=numeric(a,1);
  else if(name==='pan')valid=numeric(a,2);
  else if(['allowrotation','allowpitch','lockcamera','rotationmode','pitchmode'].includes(name))valid=count(a,1)&&BOOLEAN.test(a[0]);
  else if(['enable','disable'].includes(name))valid=count(a,0,1)&&(a[0]===undefined||/^[012]$/.test(a[0]));
  else if(name==='cameramode')valid=count(a,1)&&/^(?:perspective|orthographic|ortho|2d)$/i.test(a[0]);
  else if(name==='camera'){
    const sub=a[0]?.toLowerCase(),v=a.slice(1);
    if(['yaw','pitch','roll','dist','distance','zoom','height'].includes(sub))valid=numeric(v,1);
    else if(sub==='pan')valid=numeric(v,2);
    else if(sub==='mode')valid=count(v,1)&&/^(?:perspective|orthographic|ortho|2d)$/i.test(v[0]);
    else if(['follow','target'].includes(sub))valid=count(v,1,2)&&TARGET.test(v[0])&&time(v[1]);
    else if(sub==='track'){
      if(/^(?:pitch|yaw)$/i.test(v[0]))v.shift();
      valid=count(v,1,2)&&(TARGET.test(v[0])||FALSE.test(v[0]))&&time(v[1]);
    }
  }else if(name==='fog'){
    const sub=a[0]?.toLowerCase(),v=a.slice(1);
    valid=sub==='color'?color(v):['near','far'].includes(sub)?numeric(v,1):['dist','distance'].includes(sub)?numeric(v,2):color(a,2);
  }else if(['light','ambient'].includes(name))valid=color(a[0]?.toLowerCase()==='color'?a.slice(1):a);
  else if(name==='sun'){
    const sub=a[0]?.toLowerCase(),v=a.slice(1);
    valid=sub==='color'?color(v):['yaw','pitch'].includes(sub)?numeric(v,1):sub==='angle'?numeric(v,2):color(a,2);
  }else if(['lamp','flashlight'].includes(name)){
    const sub=a[0]?.toLowerCase(),v=a.slice(1);
    if(sub==='color')valid=color(v);
    else if(['intensity','dist','distance',...(name==='flashlight'?['angle','pitch','yaw']:[])].includes(sub))valid=numeric(v,1);
    else if(sub==='shadow')valid=count(v,0);
    else valid=color(a,name==='lamp'?2:3);
  }else if(name==='resolution')valid=a[0]?.toLowerCase()==='scale'&&numeric(a.slice(1),1);
  else if(name==='skybox'||name==='skyball')valid=skyCommand(name,a);
  else if(name==='set'){
    const property=a[0]?.toLowerCase(),values=a.slice(1);
    if(BOOLEAN_PROPERTIES.has(property))valid=count(values,1,2)&&BOOLEAN.test(values[0])&&time(values[1]);
    else if(NUMBER_PROPERTIES.has(property))valid=numeric(values,1);
  }
  else if(name==='configure'){
    const parts=[...a];if(parts.length>=2&&number(parts.at(-1)))parts.pop();
    valid=configText(parts.join(' '))&&(parts.length===a.length||time(a.at(-1)));
  }
  if(!valid)fail(text.slice(0,180));
  return [target,name,...a].filter(v=>v!=null).join(' ');
}

function supplied(value){return value!==undefined&&value!==null&&String(value)!=='';}
function safeValue(value){const str=String(value);if(str.length>4096||/[\r\n\x00]/.test(str))fail('invalid MZ argument');return str;}

/** MZ command357 [pluginName,commandName,displayName,args] -> MV-style cues. */
export function parseThreeDPluginCommand(command) {
  if(command.code===356){const result=parseThreeDCommand(command.parameters?.[0]);return result===null?null:[result];}
  if(command.code!==357||!PLUGIN.test(command.parameters?.[0]||''))return null;
  const [,rawName,,rawArgs]=command.parameters,name=String(rawName).toLowerCase();
  if(!rawArgs||typeof rawArgs!=='object'||Array.isArray(rawArgs))fail('invalid MZ arguments');
  const args=rawArgs,out=[],duration=supplied(args.time)?safeValue(args.time):'0';
  const push=s=>out.push(parseThreeDCommand(s,{bare:true}));
  const target=()=>{const t=supplied(args.target)?safeValue(args.target):'@s';if(!TARGET.test(t))fail('invalid character target');return /^[@＠]/.test(t)?t:`@${t}`;};
  const blend=(property,prefix)=>{if(supplied(args[property]))push(`${prefix} ${safeValue(args[property])} ${duration}`);};
  if(name==='command'){
    if(!supplied(args.command))fail('empty command');
    push(safeValue(args.command));
  }else if(name==='camera'){
    for(const key of ['pitch','yaw','roll','dist','zoom','height'])blend(key,`camera ${key}`);
    if(supplied(args.mode))push(`camera mode ${safeValue(args.mode)}`);
    blend('follow','camera follow');
    if(supplied(args.pan)){let pan;try{pan=typeof args.pan==='string'?JSON.parse(args.pan):args.pan;}catch{fail('invalid camera pan');}if(!pan||!supplied(pan.x)||!supplied(pan.y))fail('camera pan requires x/y');push(`camera pan ${safeValue(pan.x)} ${safeValue(pan.y)} ${duration}`);}
  }else if(name==='cameratrack'){
    const yaw=!FALSE.test(String(args.trackYaw??'true')),pitch=!FALSE.test(String(args.trackPitch??'true'));
    if(!yaw&&!pitch)fail('cameraTrack requires at least one axis');
    push(`camera track ${yaw&&pitch?'':yaw?'yaw ':'pitch '}${safeValue(args.target??'false')} ${duration}`);
  }else if(name==='fog')for(const key of ['color','near','far'])blend(key,`fog ${key}`);
  else if(name==='light'){blend('color','light color');blend('sunColor','sun color');blend('sunYaw','sun yaw');blend('sunPitch','sun pitch');}
  else if(['lamp','flashlight'].includes(name)){
    for(const key of ['color','intensity','dist',...(name==='flashlight'?['angle','pitch','yaw']:[])])blend(key,`${target()} ${name} ${key}`);
    if(supplied(args.shadow)&&!FALSE.test(String(args.shadow)))push(`${target()} ${name} shadow`);
  }else if(name==='resolution')blend('scale','resolution scale');
  else if(name==='skybox'||name==='skyball')push(mzSkyCommand(name,args,duration));
  else if(name==='set')push(`set ${safeValue(args.property)} ${safeValue(args.value)} ${duration}`);
  else if(name==='enable'){
    if(!BOOLEAN.test(String(args.enabled)))fail('invalid enabled flag');
    push(`${FALSE.test(String(args.enabled))?'disable':'enable'} ${safeValue(args.fadeType??'2')}`);
  }else if(name==='elevation')blend('elevation',`${target()} elevation`);
  else if(name==='configure'){
    if(!supplied(args.config))fail('empty configure');
    let config=String(args.config);if(config.startsWith('"')){try{config=JSON.parse(config);}catch{fail('invalid configuration note');}}
    if(typeof config!=='string')fail('invalid configuration note');
    push(`${target()} configure ${safeValue(config.replace(/\r?\n/g,' '))}${supplied(args.time)?` ${duration}`:''}`);
  }else fail(`MZ ${name}`);
  if(!out.length)fail(`MZ ${name} has no implemented arguments`);
  return out;
}

export function resolveThreeDVariables(command,variable) {
  return command.replace(/\bvar\(\s*(\d+)\s*\)/gi,(_,id)=>{const value=Number(variable(+id));if(!Number.isFinite(value))fail(`var(${id}) must be numeric`);return String(value);});
}

export function eventThreeDSource(event,page,mapId) {
  if(event.id===`map:${mapId}:event:${event.eventId}`)return undefined;
  const displayPage=page?Object.fromEntries(['image','directionFix','walkAnime','stepAnime','moveSpeed','priorityType'].filter(key=>page[key]!==undefined).map(key=>[key,structuredClone(page[key])])):null;
  if(displayPage)displayPage.list=[...(page.list||[]).filter(c=>c.code===108||c.code===408).map(c=>({code:c.code,indent:0,parameters:[String(c.parameters?.[0]||'')]})),{code:0,indent:0,parameters:[]}];
  return {note:String(event.note||event.raw?.note||''),page:displayPage};
}

export function threeDSnapshot(map,player,variable,eventViews=[]) {
  const ids=[...new Set([...(map?.threeD?.variableIds||[]),...eventViews.flatMap(event=>event.threeDSource?threeDVariables(event.threeDSource.note,...(event.threeDSource.page?.list||[]).map(command=>command.parameters?.[0])):[])])];
  if(!ids.length)return undefined;
  return {variables:Object.fromEntries(ids.map(id=>{const value=Number(variable(player,id));return[id,Number.isFinite(value)?value:0];}))};
}
