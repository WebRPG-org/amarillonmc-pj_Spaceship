import {Renderer} from './renderer.mjs';
import {TILE,tileParts,mapTile,snapshotPreview} from './tile-format.mjs';
import {SLOT_NAMES,MapPaintModel,paletteTiles,paletteStamp,tileKind,lineCells,inside} from './editor-map-model.mjs';

const TOOLS=[['pencil','铅笔','P'],['rectangle','矩形','R'],['fill','填充','F'],['erase','橡皮','E'],['picker','吸管','I'],['event','事件','V'],['pan','平移','H']];
const one=tile=>({width:1,height:1,tiles:[tile]});
// Renderer owns a perpetual animation loop. The editor variant retains the
// actual draw path while allowing tab changes to release its loop/resources.
class EditorRenderer extends Renderer{
  drawLoop(time){if(this.disposed)return;this.frame=requestAnimationFrame(this.drawLoop);const dt=Math.max(0,Math.min(.1,(time-this.lastTime)/1000));this.lastTime=time;this.draw(time,dt);}
  dispose(){this.disposed=true;cancelAnimationFrame(this.frame);this.threeD.dispose();this.effekseer.reset();this.entities.clear();}
}

export class MapEditor{
  constructor({root,content,map,mapId,onChange=()=>{},onSelectEvent=()=>{},onStatus=()=>{}}){
    this.root=root;this.content=content;this.onChange=onChange;this.onSelectEvent=onSelectEvent;this.onStatus=onStatus;
    this.tool='event';this.layer=0;this.slot=0;this.stamp=one(0);this.selectedEvent=null;this.autoConnect=true;this.listeners=new AbortController();
    root.classList.add('map-editor');
    root.innerHTML=`<div class="me-toolbar" role="toolbar" aria-label="地图绘制工具">${TOOLS.map(([id,name,key])=>`<button type="button" data-map-tool="${id}" title="${name} (${key})">${name}</button>`).join('')}<span class="me-separator"></span><button type="button" data-map-action="undo" title="撤销 (Ctrl+Z)">撤销</button><button type="button" data-map-action="redo" title="重做 (Ctrl+Shift+Z)">重做</button></div>
      <div class="me-options"><label>数据层 <select aria-label="地图数据层" data-map-layer>${['0 · 底层图块','1 · 图块层','2 · 图块层','3 · 上层图块','4 · 阴影','5 · 区域 ID'].map((name,i)=>`<option value="${i}">${name}</option>`).join('')}</select></label><label class="me-check"><input type="checkbox" data-map-connect checked>自动接边</label><label class="me-check"><input type="checkbox" data-map-grid checked>网格</label><label class="me-check"><input type="checkbox" data-map-regions>区域</label><button type="button" data-map-action="fit">适合窗口</button><label>缩放 <select aria-label="地图缩放" data-map-zoom>${[.25,.5,.75,1,1.5,2,3].map(n=>`<option value="${n}" ${n===1?'selected':''}>${n*100}%</option>`).join('')}</select></label></div>
      <div class="me-workarea"><div class="me-viewport"><canvas class="me-map" tabindex="0" aria-label="地图画布"></canvas><div class="me-position" aria-live="off"></div></div><aside class="me-palette"><div class="me-slots" role="tablist" aria-label="图块槽位">${SLOT_NAMES.map((name,i)=>`<button type="button" role="tab" data-map-slot="${i}">${name}</button>`).join('')}</div><p class="me-palette-status" role="status"></p><div class="me-palette-scroll"><canvas class="me-palette-canvas" aria-label="图块图集；拖动选择多格家具" tabindex="0"></canvas></div><div class="me-special" hidden><label>绘制数值 <input data-map-value aria-label="阴影或区域数值" type="number" value="1" min="0" max="255"></label><div class="me-shadow-bits">${['左上','右上','左下','右下'].map((s,i)=>`<label><input type="checkbox" data-map-shadow="${i}">${s}</label>`).join('')}</div></div><div class="me-stamp"><canvas class="me-stamp-canvas" aria-label="当前多格笔刷预览"></canvas><span></span></div></aside></div><p class="me-help">图集可拖选整件家具 · 右键 / 空格拖动平移 · 滚轮缩放 · Shift 绘制保留原形状 · 事件工具点击格子选择或添加事件</p>`;
    this.canvas=root.querySelector('.me-map');this.paletteCanvas=root.querySelector('.me-palette-canvas');this.stampCanvas=root.querySelector('.me-stamp-canvas');
    this.renderer=new EditorRenderer(this.canvas);const draw=this.renderer.draw.bind(this.renderer);
    this.renderer.draw=(time,dt)=>{draw(time,dt);if(this.model){this.drawOverlay();this.drawPalette(time);}};
    this.renderer.showGrid=true;this.bind();this.loadMap(map,mapId);
  }
  listen(target,event,fn,options={}){target.addEventListener(event,fn,{...options,signal:this.listeners.signal});}
  bind(){
    this.listen(this.root,'click',e=>{const b=e.target.closest('button');if(!b)return;
      if(b.dataset.mapTool)this.setTool(b.dataset.mapTool);
      if(b.dataset.mapSlot!==undefined)this.selectSlot(Number(b.dataset.mapSlot));
      if(b.dataset.mapAction==='undo'||b.dataset.mapAction==='redo'){this.finishGesture();if(this.model[b.dataset.mapAction]())this.changed('history');}
      if(b.dataset.mapAction==='fit')this.fit();
    });
    this.listen(this.root.querySelector('[data-map-layer]'),'change',e=>{this.finishGesture();this.layer=Number(e.target.value);this.updateLayer();});
    this.listen(this.root.querySelector('[data-map-connect]'),'change',e=>this.autoConnect=e.target.checked);
    this.listen(this.root.querySelector('[data-map-grid]'),'change',e=>this.renderer.showGrid=e.target.checked);
    this.listen(this.root.querySelector('[data-map-regions]'),'change',e=>this.renderer.showRegions=e.target.checked||this.layer===5);
    this.listen(this.root.querySelector('[data-map-zoom]'),'change',e=>this.setZoom(Number(e.target.value)));
    this.listen(this.root.querySelector('[data-map-value]'),'input',()=>this.syncSpecial());
    for(const input of this.root.querySelectorAll('[data-map-shadow]'))this.listen(input,'change',()=>{this.root.querySelector('[data-map-value]').value=[...this.root.querySelectorAll('[data-map-shadow]')].reduce((n,i)=>n+(i.checked?1<<Number(i.dataset.mapShadow):0),0);this.syncSpecial();});
    this.listen(this.canvas,'contextmenu',e=>e.preventDefault());
    this.listen(this.canvas,'pointerdown',e=>this.pointerDown(e));
    this.listen(this.canvas,'pointermove',e=>this.pointerMove(e));
    this.listen(this.canvas,'pointerup',()=>this.finishGesture());
    this.listen(this.canvas,'pointercancel',()=>this.cancelGesture());
    this.listen(this.canvas,'lostpointercapture',()=>{if(this.gesture)this.finishGesture();});
    this.listen(this.canvas,'pointerleave',()=>{if(!this.gesture)this.hover=null;});
    this.listen(this.canvas,'wheel',e=>{e.preventDefault();this.finishGesture();this.setZoom(this.renderer.zoom*(e.deltaY>0?.9:1.1));},{passive:false});
    this.listen(this.paletteCanvas,'pointerdown',e=>{if(this.layer>=4||e.button!==0)return;const p=this.palettePoint(e);if(!p)return;this.paletteDrag={from:p,to:p};this.paletteCanvas.setPointerCapture(e.pointerId);this.choosePalette();});
    this.listen(this.paletteCanvas,'pointermove',e=>{if(!this.paletteDrag)return;const p=this.palettePoint(e);if(p){this.paletteDrag.to=p;this.choosePalette();}});
    this.listen(this.paletteCanvas,'pointerup',()=>{this.paletteSelection=this.paletteDrag;this.paletteDrag=null;});
    this.listen(this.paletteCanvas,'pointercancel',()=>this.paletteDrag=null);
    this.listen(window,'keydown',e=>this.keydown(e));
    this.listen(window,'keyup',e=>{if(e.code==='Space')this.space=false;});
    this.listen(window,'blur',()=>{this.space=false;this.finishGesture();});
  }
  loadMap(map,mapId){
    this.cancelGesture();this.model=new MapPaintModel(map);this.mapId=mapId;this.selectedEvent=null;this.hover=null;
    this.tileset=this.content?.database?.Tilesets?.[map.tilesetId]||{};
    this.renderer.setMap({...this.model.map,id:mapId,threeD:{enabled:false}},this.tileset,{...this.content?.database,Animations:[]});
    this.refreshEvents();this.fit();this.selectSlot(this.slot);this.updateLayer();this.updateButtons();
  }
  // Live draft for diff/save; use updateEvent/applyProperties for tracked edits.
  getMap(){return this.model.map;}
  updateEvent(event,id=event?.id){this.finishGesture();if(this.model.updateEvent(event,id)){this.refreshEvents();this.changed('event');}}
  applyProperties(properties){this.finishGesture();if(this.model.applyProperties(properties))this.changed('properties');}
  setSelectedEvent(id){this.selectedEvent=id==null?null:Number(id);this.refreshEvents();}
  refreshEvents(){this.renderer.accept(snapshotPreview(this.model.map,this.mapId));}
  dispose(){this.cancelGesture();this.listeners.abort();this.renderer.dispose();this.root.replaceChildren();this.root.classList.remove('map-editor');}
  changed(kind='tiles'){
    if(kind==='history'||kind==='properties'){
      const center=this.renderer.viewCenter,zoom=this.renderer.zoom;
      this.tileset=this.content?.database?.Tilesets?.[this.model.map.tilesetId]||{};
      this.renderer.setMap({...this.model.map,id:this.mapId,threeD:{enabled:false}},this.tileset,{...this.content?.database,Animations:[]});
      this.renderer.viewCenter=center;this.renderer.zoom=zoom;this.refreshEvents();this.selectSlot(this.slot);this.updateLayer();
      if(!this.model.map.events?.some(e=>e?.id===this.selectedEvent))this.selectedEvent=null;
    }
    this.updateButtons();this.onChange(this.model.map,{kind});
  }
  updateButtons(){for(const b of this.root.querySelectorAll('[data-map-tool]')){const active=b.dataset.mapTool===this.tool;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));}this.root.querySelector('[data-map-action=undo]').disabled=!this.model.undoStack.length;this.root.querySelector('[data-map-action=redo]').disabled=!this.model.redoStack.length;}
  setTool(tool){this.finishGesture();this.tool=tool;this.canvas.dataset.tool=tool;this.updateButtons();}
  setZoom(value){this.renderer.zoom=Math.max(.15,Math.min(3,value));const select=this.root.querySelector('[data-map-zoom]');for(const o of select.querySelectorAll('[data-custom]'))o.remove();if(![...select.options].some(o=>Number(o.value)===this.renderer.zoom)){const o=new Option(`${Math.round(this.renderer.zoom*100)}%`,String(this.renderer.zoom));o.dataset.custom='true';select.add(o);}select.value=String(this.renderer.zoom);}
  fit(){const r=this.canvas.getBoundingClientRect();this.setZoom(Math.min(1,(r.width-24)/(this.model.map.width*TILE),(r.height-24)/(this.model.map.height*TILE)));this.renderer.viewCenter={x:this.model.map.width/2-.5,y:this.model.map.height/2-.5};}
  updateLayer(){
    const special=this.layer>=4;this.root.querySelector('.me-special').hidden=!special;this.root.querySelector('.me-palette-scroll').hidden=special;this.root.querySelector('.me-slots').hidden=special;
    this.root.querySelector('.me-shadow-bits').hidden=this.layer!==4;this.root.querySelector('[data-map-value]').max=this.layer===4?15:255;
    this.root.querySelector('[data-map-connect]').disabled=special;this.renderer.showRegions=this.layer===5||this.root.querySelector('[data-map-regions]').checked;
    if(special)this.syncSpecial();else this.selectSlot(this.slot);
  }
  syncSpecial(){const input=this.root.querySelector('[data-map-value]');const value=Math.max(0,Math.min(this.layer===4?15:255,Math.trunc(Number(input.value)||0)));input.value=value;for(const c of this.root.querySelectorAll('[data-map-shadow]'))c.checked=Boolean(value&(1<<Number(c.dataset.mapShadow)));this.specialStamp=one(value);this.root.querySelector('.me-palette-status').textContent=this.layer===4?'阴影位：1 左上 · 2 右上 · 4 左下 · 8 右下':'区域 ID：0 清除，1–255 标记';}
  selectSlot(slot){
    this.slot=slot;this.palette=paletteTiles(slot);this.paletteSelection=null;this.paletteDrag=null;
    for(const b of this.root.querySelectorAll('[data-map-slot]')){const selected=Number(b.dataset.mapSlot)===slot;b.classList.toggle('active',selected);b.setAttribute('aria-selected',String(selected));b.title=this.tileset.tilesetNames?.[Number(b.dataset.mapSlot)]||'未配置此槽位';}
    this.paletteCanvas.width=this.palette.width*24;this.paletteCanvas.height=this.palette.height*24;
    const first=this.palette.ids.find(id=>id>0);this.stamp=one(first||0);this.paletteCanvas.dataset.slot=SLOT_NAMES[slot];
    this.lastPaletteFrame=-1;this.lastStamp='';
  }
  palettePoint(e){const rect=this.paletteCanvas.getBoundingClientRect();const x=Math.floor((e.clientX-rect.left)*this.paletteCanvas.width/rect.width/24),y=Math.floor((e.clientY-rect.top)*this.paletteCanvas.height/rect.height/24);return x>=0&&y>=0&&x<this.palette.width&&y<this.palette.height?{x,y}:null;}
  choosePalette(){this.stamp=paletteStamp(this.palette,this.paletteDrag.from,this.paletteDrag.to);this.paletteSelection=this.paletteDrag;this.lastPaletteFrame=-1;if(['event','pan','picker'].includes(this.tool))this.setTool('pencil');}
  activeStamp(){return this.tool==='erase'?one(0):this.layer>=4?this.specialStamp:this.stamp;}
  point(e){const p=this.renderer.screenToMap(e.clientX,e.clientY);return{x:Math.floor(p.x),y:Math.floor(p.y)};}
  pointerDown(e){
    if(![0,1,2].includes(e.button))return;e.preventDefault();this.canvas.focus();this.finishGesture();
    if(e.button===1||e.button===2||this.space||this.tool==='pan'){this.gesture={pan:true,clientX:e.clientX,clientY:e.clientY};this.canvas.setPointerCapture(e.pointerId);return;}
    const p=this.point(e);if(!inside(this.model.map,p.x,p.y))return;this.hover=p;
    if(this.tool==='event'){const events=(this.model.map.events||[]).filter(v=>v&&v.x===p.x&&v.y===p.y);const previous=events.findIndex(v=>v.id===this.selectedEvent);const event=events[(previous+1)%events.length];this.selectedEvent=event?.id??null;this.onSelectEvent(event?.id??null,p);return;}
    if(this.tool==='picker'){
      const value=mapTile(this.model.map,p.x,p.y,this.layer);if(this.layer>=4){this.root.querySelector('[data-map-value]').value=value;this.syncSpecial();}else this.stamp=one(value);
      this.onStatus(`已取样：层 ${this.layer} · ${value}。Shift 绘制可保留此形状。`);this.setTool('pencil');return;
    }
    const stamp=this.activeStamp();if(this.layer<4&&stamp.tiles.some(id=>!this.tileAvailable(id))){this.onStatus('所选图块的素材缺失或尚未载入，请选择已配置的槽位。',true);return;}
    this.gesture={from:p,to:p,last:p,stamp:structuredClone(stamp),connect:this.autoConnect&&!e.shiftKey,tool:this.tool};this.model.begin();this.canvas.setPointerCapture(e.pointerId);
    if(this.tool==='fill'){this.model.fill(p.x,p.y,this.layer,stamp,{connect:this.gesture.connect});this.finishGesture();}
    else if(this.tool!=='rectangle')this.model.stamp(p.x,p.y,this.layer,stamp,{connect:this.gesture.connect});
  }
  pointerMove(e){
    const p=this.point(e);this.hover=inside(this.model.map,p.x,p.y)?p:null;
    this.root.querySelector('.me-position').textContent=this.hover?`${p.x}, ${p.y} · 层 ${this.layer} · ID ${mapTile(this.model.map,p.x,p.y,this.layer)}`:'';
    const g=this.gesture;if(!g)return;
    if(g.pan){this.renderer.pan((g.clientX-e.clientX)/(this.renderer.zoom*TILE),(g.clientY-e.clientY)/(this.renderer.zoom*TILE));g.clientX=e.clientX;g.clientY=e.clientY;return;}
    if(!this.hover)return;g.to=p;
    if(g.tool!=='rectangle')for(const cell of lineCells(g.last,p))this.model.stamp(cell.x,cell.y,this.layer,g.stamp,{connect:g.connect});g.last=p;
  }
  finishGesture(){const g=this.gesture;if(!g)return;this.gesture=null;if(g.pan)return;if(g.tool==='rectangle')this.model.rectangle(g.from,g.to,this.layer,g.stamp,{connect:g.connect});if(this.model.commit())this.changed();}
  cancelGesture(){this.model?.cancel();this.gesture=null;}
  keydown(e){
    if(document.querySelector('dialog[open]'))return;
    if(!this.root.contains(document.activeElement)||e.target.closest('input,textarea,select,[contenteditable=true]'))return;
    if(e.code==='Space'){e.preventDefault();this.space=true;return;}
    if(e.key==='Escape'){e.preventDefault();this.cancelGesture();return;}
    if((e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase())){e.preventDefault();this.finishGesture();const method=e.key.toLowerCase()==='y'||e.shiftKey?'redo':'undo';if(this.model[method]())this.changed('history');return;}
    if(e.ctrlKey||e.metaKey||e.altKey)return;const tool=TOOLS.find(([, ,key])=>key===e.key.toUpperCase());if(tool){e.preventDefault();this.setTool(tool[0]);}
  }
  tileAvailable(id){if(id===0)return true;const parts=tileParts(id,this.tileset.flags);return parts.length>0&&parts.every(p=>{const image=this.renderer.sheets[p.sheet];return image?.ready&&p.sx+p.sw<=image.naturalWidth&&p.sy+p.sh<=image.naturalHeight;});}
  paintTile(ctx,id,x,y,scale=.5,frame=0){ctx.save();ctx.translate(x,y);ctx.scale(scale,scale);for(const p of tileParts(id,this.tileset.flags,frame)){const image=this.renderer.sheets[p.sheet];if(image?.ready)ctx.drawImage(image,p.sx,p.sy,p.sw,p.sh,p.dx,p.dy,p.dw,p.dh);}ctx.restore();}
  drawPalette(time){
    const frame=Math.floor(time/500)%12,image=this.renderer.sheets[this.slot],name=this.tileset.tilesetNames?.[this.slot];
    if(this.layer<4)this.root.querySelector('.me-palette-status').textContent=!name?`${SLOT_NAMES[this.slot]} 未配置图集`:this.renderer.images.missing.has(`img/tilesets/${name}`)?`${name} · 图片载入失败`:!image?.ready?`${name} · 载入中…`:`${name} · 拖选多格`;
    if(this.lastPaletteFrame!==frame||this.paletteWasReady!==image?.ready){
      this.lastPaletteFrame=frame;this.paletteWasReady=image?.ready;const ctx=this.paletteCanvas.getContext('2d');ctx.imageSmoothingEnabled=false;ctx.clearRect(0,0,this.paletteCanvas.width,this.paletteCanvas.height);
      for(let i=0;i<this.palette.ids.length;i++){const x=i%this.palette.width*24,y=Math.floor(i/this.palette.width)*24,id=this.palette.ids[i];ctx.fillStyle=(i+Math.floor(i/this.palette.width))%2?'#27333d':'#1f2b34';ctx.fillRect(x,y,24,24);this.paintTile(ctx,id,x,y,.5,frame);if(!this.tileAvailable(id)){ctx.strokeStyle='#dca48a55';ctx.beginPath();ctx.moveTo(x+4,y+4);ctx.lineTo(x+20,y+20);ctx.stroke();}}
      const selection=this.paletteDrag||this.paletteSelection;if(selection){ctx.strokeStyle='#f7d785';ctx.lineWidth=2;ctx.strokeRect(Math.min(selection.from.x,selection.to.x)*24+1,Math.min(selection.from.y,selection.to.y)*24+1,(Math.abs(selection.from.x-selection.to.x)+1)*24-2,(Math.abs(selection.from.y-selection.to.y)+1)*24-2);}
    }
    const stamp=this.activeStamp(),stampKey=JSON.stringify([stamp,this.layer,frame,image?.ready]);if(this.lastStamp===stampKey)return;this.lastStamp=stampKey;
    this.stampCanvas.width=stamp.width*24;this.stampCanvas.height=stamp.height*24;const ctx=this.stampCanvas.getContext('2d');ctx.imageSmoothingEnabled=false;ctx.fillStyle='#2c3842';ctx.fillRect(0,0,this.stampCanvas.width,this.stampCanvas.height);
    if(this.layer<4)stamp.tiles.forEach((id,i)=>this.paintTile(ctx,id,i%stamp.width*24,Math.floor(i/stamp.width)*24,.5,frame));
    else{ctx.fillStyle='#f7d785';ctx.font='12px sans-serif';ctx.fillText(String(stamp.tiles[0]),3,17);}
    this.root.querySelector('.me-stamp span').textContent=`${stamp.width} × ${stamp.height} · ${this.layer>=4?'数值':tileKind(stamp.tiles[0])>=0?'自动图块':'图块'} ${stamp.tiles.join(', ')}`;
  }
  drawOverlay(){
    const ctx=this.renderer.ctx,ratio=Math.min(2,devicePixelRatio||1),zoom=this.renderer.zoom,cell=TILE*zoom;
    ctx.save();ctx.setTransform(ratio,0,0,ratio,0,0);
    if(this.tool==='event'||this.selectedEvent!=null)for(const event of this.model.map.events||[]){if(!event)continue;const p=this.renderer.screenPoint(event.x,event.y),selected=event.id===this.selectedEvent;
      ctx.fillStyle=selected?'#ffdb7444':'#75c5e322';ctx.fillRect(p.x+1,p.y+1,cell-2,cell-2);ctx.strokeStyle=selected?'#ffe293':'#83d3ef';ctx.lineWidth=selected?3:1;ctx.strokeRect(p.x+1,p.y+1,cell-2,cell-2);ctx.font='11px sans-serif';ctx.fillStyle='#14242ee8';ctx.fillRect(p.x+2,p.y+2,Math.max(17,String(event.id).length*7+4),14);ctx.fillStyle='#fff';ctx.fillText(String(event.id),p.x+4,p.y+13);
    }
    if(this.hover&&this.tool!=='pan'){
      const g=this.gesture,rect=g?.tool==='rectangle',origin=rect?{x:Math.min(g.from.x,g.to.x),y:Math.min(g.from.y,g.to.y)}:this.hover;
      const stamp=this.activeStamp(),width=rect?Math.abs(g.from.x-g.to.x)+1:['event','picker','fill'].includes(this.tool)?1:stamp.width,height=rect?Math.abs(g.from.y-g.to.y)+1:['event','picker','fill'].includes(this.tool)?1:stamp.height,p=this.renderer.screenPoint(origin.x,origin.y);
      if(!g&&this.layer<4&&['pencil','rectangle'].includes(this.tool)){ctx.globalAlpha=.55;stamp.tiles.forEach((id,i)=>this.paintTile(ctx,id,p.x+i%stamp.width*cell,p.y+Math.floor(i/stamp.width)*cell,zoom));ctx.globalAlpha=1;}
      ctx.fillStyle='#f8dd831a';ctx.fillRect(p.x,p.y,width*cell,height*cell);ctx.strokeStyle='#fce299';ctx.lineWidth=2;ctx.strokeRect(p.x+1,p.y+1,width*cell-2,height*cell-2);
    }ctx.restore();
  }
}
