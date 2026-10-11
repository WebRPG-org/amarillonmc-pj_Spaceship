import { characterFrame } from './tile-format.mjs';
import { appearanceKey, appearanceLayers, paletteMatrix } from './appearance-format.mjs';
const canvasOf=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c;};
const imageUrl=(folder,name)=>`/assets/img/${folder}/${encodeURIComponent(name)}.png`;

export class AppearanceComposer {
  constructor(){this.catalog=null;this.images=new Map();this.tinted=new Map();this.compositions=new Map();this.missing=new Set();}
  setCatalog(catalog){this.catalog=catalog;this.compositions.clear();}
  image(url){
    if(!url)return null;
    if(!this.images.has(url)){
      const image=new Image();image.onload=()=>{image.ready=true;};image.onerror=()=>{image.failed=true;this.missing.add(url);};image.src=url;this.images.set(url,image);
    }
    return this.images.get(url);
  }
  tint(image,color){
    const matrix=paletteMatrix(color),key=`${image.src}:${matrix.join(',')}`;
    if(matrix.every((v,i)=>Math.abs(v-([0,4,8].includes(i)?1:0))<1e-10))return image;
    if(this.tinted.has(key))return this.tinted.get(key);
    const canvas=canvasOf(image.width,image.height),ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height),d=pixels.data;
    for(let i=0;i<d.length;i+=4){if(!d[i+3])continue;const r=d[i],g=d[i+1],b=d[i+2];d[i]=matrix[0]*r+matrix[1]*g+matrix[2]*b;d[i+1]=matrix[3]*r+matrix[4]*g+matrix[5]*b;d[i+2]=matrix[6]*r+matrix[7]*g+matrix[8]*b;}
    ctx.putImageData(pixels,0,0);this.tinted.set(key,canvas);
    if(this.tinted.size>80)this.tinted.delete(this.tinted.keys().next().value);
    return canvas;
  }
  get(appearance,type='walk'){
    if(!appearance||!this.catalog)return null;
    const key=appearanceKey(appearance,type),cached=this.compositions.get(key);if(cached)return cached;
    if(appearance.kind==='actor')return this.actor(appearance,type,key);
    const layers=appearanceLayers(this.catalog,appearance,type),spec=this.catalog.creator.frame[type];
    if(!spec||!layers.length)return null;
    const assets=layers.map(layer=>({layer,image:this.image(layer.url)}));
    if(assets.some(({image})=>image&&!image.ready&&!image.failed))return null;
    const canvas=canvasOf(spec.width*spec.columns,spec.height*spec.rows),ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;
    for(const {layer,image}of assets)if(image?.ready)ctx.drawImage(this.tint(image,layer.color),0,0);
    canvas.ready=true;canvas.frameWidth=spec.width;canvas.frameHeight=spec.height;canvas.columns=spec.columns;canvas.rows=spec.rows;
    return this.cache(key,canvas);
  }
  actor(appearance,type,key){
    const actor=this.catalog.actors.find(a=>a.id===Number(appearance.actorId));if(!actor)return null;
    const folder=type==='walk'?'characters':type==='face'?'faces':'sv_actors',name=type==='walk'?actor.characterName:type==='face'?actor.faceName:actor.battlerName;
    if(!name||type==='dead')return null;
    const image=this.image(imageUrl(folder,name));if(!image?.ready)return null;
    let canvas,ctx;
    if(type==='walk'){
      const f=characterFrame(name,actor.characterIndex||0,0,2,image.width,image.height);canvas=canvasOf(f.sw*3,f.sh*4);ctx=canvas.getContext('2d');
      ctx.drawImage(image,f.sx,f.sy,f.sw*3,f.sh*4,0,0,f.sw*3,f.sh*4);canvas.frameWidth=f.sw;canvas.frameHeight=f.sh;canvas.columns=3;canvas.rows=4;
    }else if(type==='face'){
      const w=image.width/4,h=image.height/2,index=actor.faceIndex||0;canvas=canvasOf(w,h);ctx=canvas.getContext('2d');ctx.drawImage(image,index%4*w,Math.floor(index/4)*h,w,h,0,0,w,h);canvas.frameWidth=w;canvas.frameHeight=h;canvas.columns=1;canvas.rows=1;
    }else{canvas=canvasOf(image.width,image.height);ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);canvas.frameWidth=image.width/9;canvas.frameHeight=image.height/6;canvas.columns=9;canvas.rows=6;}
    canvas.ready=true;return this.cache(key,canvas);
  }
  cache(key,canvas){this.compositions.set(key,canvas);if(this.compositions.size>48)this.compositions.delete(this.compositions.keys().next().value);return canvas;}
  preview(canvas,appearance,type,time=0){
    const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);ctx.imageSmoothingEnabled=false;
    const image=this.get(appearance,type);
    if(!image){ctx.fillStyle='#a4b797';ctx.font='11px sans-serif';ctx.textAlign='center';ctx.fillText(type==='sv'?'侧视素材载入中 / 不可用':'正在组合素材…',canvas.width/2,canvas.height/2);return;}
    const pattern=[0,1,2,1][Math.floor(time/180)%4],direction=[0,1,3,2][Math.floor(time/1800)%4];
    const sx=type==='face'?0:pattern*image.frameWidth,sy=type==='walk'?direction*image.frameHeight:0;
    const scale=Math.min(canvas.width/image.frameWidth,canvas.height/image.frameHeight,type==='face'?1.5:3);
    const dw=image.frameWidth*scale,dh=image.frameHeight*scale;ctx.drawImage(image,sx,sy,image.frameWidth,image.frameHeight,(canvas.width-dw)/2,(canvas.height-dh)/2,dw,dh);
  }
}

const make=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const LABELS={'Body':'身体','Eyes':'眼睛','Eyebrows':'眉毛','Nose':'鼻子','Mouth':'嘴巴','Clothing':'服装','Front Hair':'前发','Rear Hair':'后发','Accessory A':'饰品 A','Accessory B':'饰品 B','Glasses':'眼镜','Beast Ears':'兽耳','Wing':'翅膀','Tail':'尾巴'};
export class AppearanceEditor {
  constructor({root,catalog,composer,current,onSave}){
    Object.assign(this,{root,catalog,composer,onSave});this.value=structuredClone(current?.kind?current:catalog.creator.defaults);this.creatorDraft=structuredClone(this.value.kind==='creator'?this.value:catalog.creator.defaults);this.disposed=false;this.render();this.animate=this.animate.bind(this);this.frame=requestAnimationFrame(this.animate);
  }
  dispose(){this.disposed=true;cancelAnimationFrame(this.frame);}
  render(){
    this.root.replaceChildren();
    const tabs=make('div','appearance-tabs');
    for(const[kind,label]of [['creator','分层角色创建'],['actor','已有角色外观']]){const b=make('button',this.value.kind===kind?'selected':'secondary',label);b.onclick=()=>{if(this.value.kind==='creator')this.creatorDraft=structuredClone(this.value);this.value=kind==='creator'?structuredClone(this.creatorDraft):{kind:'actor',actorId:this.catalog.actors[0]?.id};this.render();};tabs.append(b);}
    this.root.append(tabs);
    const layout=make('div','appearance-layout'),preview=make('div','appearance-preview'),controls=make('div','appearance-controls');
    this.previews=[];
    for(const[type,label]of [['face','脸图'],['walk','行走 · 四方向'],['sv','侧视动作']]){const box=make('div',`appearance-preview-${type}`),c=make('canvas');c.width=type==='face'?168:128;c.height=type==='face'?168:128;box.append(c,make('small','',label));preview.append(box);this.previews.push({canvas:c,type});}
    preview.append(make('p','hint','预览同步组合脸图、行走图和侧视素材。保存后其他玩家也会看到你的新外观。'));
    if(this.value.kind==='actor'){
      const label=make('label','appearance-label','选择角色外观'),select=make('select');select.setAttribute('aria-label','选择角色外观');
      for(const actor of this.catalog.actors)select.add(new Option(`${actor.name || '角色'} #${actor.id}`,String(actor.id)));
      select.value=String(this.value.actorId);select.onchange=()=>{this.value.actorId=Number(select.value);};label.append(select);controls.append(label,make('p','hint','切换外观仅改变图像，不改变角色属性、等级或装备。'));
    }else{
      for(const group of this.catalog.creator.groups){
        const row=make('div','appearance-piece'),label=make('label','appearance-label',`${LABELS[group.key]||group.label||group.key}${group.mandatory?' · 必选':''}`),select=make('select');select.setAttribute('aria-label',`${LABELS[group.key]||group.key}部件`);
        if(!group.mandatory)select.add(new Option('无',''));
        for(const option of group.options)select.add(new Option(option.label||option.id,option.id));
        const selected=this.value.pieces[group.key];select.value=selected?.id||'';
        if(group.mandatory&&!select.value&&group.options[0]){select.value=group.options[0].id;this.value.pieces[group.key]={id:select.value,color:0};}
        select.onchange=()=>{if(!select.value)delete this.value.pieces[group.key];else this.value.pieces[group.key]={id:select.value,color:Number(row.querySelector('.appearance-color')?.value||0)};};
        label.append(select);row.append(label);
        if(group.colors?.length){const colors=make('select','appearance-color');colors.setAttribute('aria-label',`${LABELS[group.key]||group.key}颜色`);for(const color of group.colors)colors.add(new Option(color.label||`色板 ${color.id+1}`,String(color.id)));colors.value=String(selected?.color||0);colors.onchange=()=>{if(this.value.pieces[group.key])this.value.pieces[group.key].color=Number(colors.value);};row.append(colors);}
        controls.append(row);
      }
    }
    layout.append(preview,controls);this.root.append(layout);
    const actions=make('div','panel-actions'),reset=make('button','secondary','恢复默认'),save=make('button','','保存外观');reset.onclick=()=>{this.value=structuredClone(this.catalog.creator.defaults);this.creatorDraft=structuredClone(this.value);this.render();};save.onclick=()=>{if(this.onSave(structuredClone(this.value))!==false){save.textContent='已提交保存';setTimeout(()=>{if(save.isConnected)save.textContent='保存外观';},1800);}};actions.append(reset,save);this.root.append(actions);
  }
  animate(time){if(this.disposed)return;for(const preview of this.previews)this.composer.preview(preview.canvas,this.value,preview.type,time);this.frame=requestAnimationFrame(this.animate);}
}
