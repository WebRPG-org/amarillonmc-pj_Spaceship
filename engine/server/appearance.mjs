import {readdir,readFile} from 'node:fs/promises';
import path from 'node:path';

const STYLES=['walk','face','sv','dead'];
const SAFE=/^[^/\\\u0000]+$/u;
const LABELS={'Body':'体型','Eyes':'眼睛','Eyebrows':'眉毛','Nose':'鼻子','Mouth':'嘴巴','Clothing':'服装','Front Hair':'前发','Rear Hair':'后发','Accessory A':'饰品 A','Accessory B':'饰品 B','Glasses':'眼镜','Beast Ears':'兽耳','Wing':'翅膀','Tail':'尾巴'};
const DEFAULT_LAYERS='Tail Part2,Wing Part2,Body,Eyes,Eyebrows,Nose,Mouth,Rear Hair Part1,Front Hair Part2,Rear Hair Part2,Clothing,Accessory A,Glasses,Front Hair Part1,Beast Ears,Accessory B,Tail Part1,Wing Part1'.split(',');
const DEFAULT_ORDER='Body,Eyes,Eyebrows,Nose,Mouth,Clothing,Front Hair,Rear Hair,Accessory A,Accessory B,Glasses,Beast Ears,Wing,Tail'.split(',');
const list=async directory=>{try{return await readdir(directory);}catch(error){if(error.code==='ENOENT')return[];throw error;}};
const asset=relative=>'/assets/'+relative.split('/').map(encodeURIComponent).join('/');

/** Read the original creator's data and PNG files; never execute plugin JS or conditions. */
export async function loadAppearanceCatalog(projectRoot,content){
  const parameters=content.plugins?.find(p=>p.name==='SRD_CharacterCreatorEX')?.parameters||{};
  const layers=parameters.Layers?.split(/\s*,\s*/)||DEFAULT_LAYERS;
  const order=parameters.Order?.split(/\s*,\s*/)||DEFAULT_ORDER;
  const mandatory=new Set((parameters.Mandatory||'Body,Eyes,Eyebrows,Nose,Mouth').split(/\s*,\s*/));
  const base='img/SumRndmDde/character-creator-ex';
  const settings=JSON.parse(await readFile(path.join(projectRoot,'data/CharacterCreator.json'),'utf8').catch(error=>{if(error.code==='ENOENT')return'{}';throw error;}));
  const groups=[];
  for(const key of order){
    const matching=layers.filter(layer=>layer.replace(/ Part\d+$/,'')===key);
    const byId=new Map();
    for(const layer of matching){
      if(!SAFE.test(layer))continue;
      const files=Object.fromEntries(await Promise.all(STYLES.map(async style=>[style,new Set(await list(path.join(projectRoot,base,layer,style)))])));
      for(const filename of [...files.walk].filter(f=>/\.png$/i.test(f)&&SAFE.test(f)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}))){
        const id=filename.slice(0,-4);
        if(!byId.has(id))byId.set(id,{id,label:id,layers:[]});
        const view={key:layer,order:layers.indexOf(layer)};
        for(const style of STYLES)view[style]=files[style].has(filename)?asset(`${base}/${layer}/${style}/${filename}`):null;
        byId.get(id).layers.push(view);
      }
    }
    const colors=(settings[key]?.colors?.length?settings[key].colors:[['原色',0]]).map((c,id)=>({id,label:String(c[0]),hue:Number(c[1])||0,saturation:Number(c[2])||0,brightness:Number(c[3])||0,grayscale:Number(c[4])||0}));
    groups.push({key,label:LABELS[key]||key,mandatory:mandatory.has(key),colors,options:[...byId.values()]});
  }
  const characterFiles=new Set(await list(path.join(projectRoot,'img/characters'))),faceFiles=new Set(await list(path.join(projectRoot,'img/faces')));
  const actors=(content.database.Actors||[]).filter(a=>a?.name&&characterFiles.has(a.characterName+'.png')&&faceFiles.has(a.faceName+'.png')).map(a=>({id:a.id,name:a.name,characterName:a.characterName,characterIndex:a.characterIndex,faceName:a.faceName,faceIndex:a.faceIndex,battlerName:a.battlerName||''}));
  const pieces={};
  for(const group of groups)if(group.options.length&&(group.mandatory||['Clothing','Front Hair','Rear Hair'].includes(group.key)))pieces[group.key]={id:group.options.find(p=>!/\(0\)$/.test(p.id))?.id||group.options[0].id,color:0};
  const dimension=(key,fallback)=>{const n=Number(parameters[key]);return Number.isInteger(n)&&n>0&&n<=1024?n:fallback;};
  return{version:1,actors,creator:{available:groups.filter(g=>g.mandatory).every(g=>g.options.length>0),groups,defaults:{kind:'creator',pieces},frame:{walk:{width:dimension('Character Width',48),height:dimension('Character Height',48),columns:3,rows:4},face:{width:dimension('Face Width',144),height:dimension('Face Height',144),columns:1,rows:1},sv:{width:dimension('SV Char Width',64),height:dimension('SV Char Height',64),columns:9,rows:6},dead:{width:dimension('Character Width',48),height:dimension('Character Height',48),columns:3,rows:1}}}};
}

/** Persist only catalog identities; paths, render layers and arbitrary scripts are never client supplied. */
export function normalizeAppearance(input,catalog){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('外观配置无效');
  if(input.kind==='actor'){
    const actor=catalog.actors.find(a=>a.id===input.actorId);if(!actor)throw new Error('该角色皮肤不存在');
    const {id,name,...graphics}=actor;return{kind:'actor',actorId:id,...graphics};
  }
  if(input.kind!=='creator'||!catalog.creator.available)throw new Error('角色创建素材不可用');
  if(!input.pieces||typeof input.pieces!=='object'||Array.isArray(input.pieces))throw new Error('缺少角色部件');
  const pieces={};
  for(const key of Object.keys(input.pieces))if(!catalog.creator.groups.some(g=>g.key===key))throw new Error('角色部件分类无效');
  for(const group of catalog.creator.groups){
    const selected=input.pieces[group.key];
    if(selected==null){if(group.mandatory)throw new Error(`请先选择${group.label}`);continue;}
    if(!selected||typeof selected!=='object'||!group.options.some(option=>option.id===selected.id))throw new Error(`${group.label}部件不存在`);
    const color=selected.color??0;if(!Number.isInteger(color)||color<0||color>=group.colors.length)throw new Error(`${group.label}配色不存在`);
    pieces[group.key]={id:selected.id,color};
  }
  const fallback=catalog.actors[0]||{characterName:'Actor1',characterIndex:0,faceName:'Actor1',faceIndex:0};
  return{kind:'creator',pieces,characterName:fallback.characterName,characterIndex:fallback.characterIndex,faceName:fallback.faceName,faceIndex:fallback.faceIndex};
}
