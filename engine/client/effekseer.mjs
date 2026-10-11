import {effectUrl,effectGeometry,effectViewport} from './effekseer-format.mjs';

let runtimePromise;
function runtime(){
  if(!runtimePromise)runtimePromise=new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src='/client/vendor/effekseer/effekseer.min.js';
    script.onerror=()=>reject(new Error('Effekseer运行库加载失败'));
    script.onload=()=>{try{globalThis.effekseer.initRuntime('/client/vendor/effekseer/effekseer.wasm',()=>resolve(globalThis.effekseer),()=>reject(new Error('Effekseer WASM初始化失败')));}catch(error){reject(error);}};
    document.head.append(script);
  });return runtimePromise;
}

/** Real MZ particles render in an isolated transparent WebGL canvas, then join the 2D world. */
export class EffekseerLayer {
  constructor({onSound=()=>{},onError=()=>{}}={}){
    Object.assign(this,{onSound,onError});this.canvas=document.createElement('canvas');this.effects=new Map();this.playing=[];this.generation=0;this.status='idle';this.renderedFrames=0;
  }
  initialize(){
    if(this.initializing)return this.initializing;
    this.status='loading';this.initializing=(async()=>{
      this.gl=this.canvas.getContext('webgl',{alpha:true,premultipliedAlpha:true,preserveDrawingBuffer:true});
      if(!this.gl)throw new Error('浏览器未提供WebGL，无法显示Effekseer粒子');
      const api=await runtime();this.context=api.createContext();if(this.context.init(this.gl)===false)throw new Error('Effekseer WebGL初始化失败');
      this.maxViewport=Math.min(...this.gl.getParameter(this.gl.MAX_VIEWPORT_DIMS));this.status='ready';return this.context;
    })().catch(error=>{this.status='failed';this.onError(error.message);return null;});return this.initializing;
  }
  load(name){
    const url=effectUrl(name);
    if(!this.effects.has(name))this.effects.set(name,this.initialize().then(context=>context&&new Promise((resolve,reject)=>{
      const effect=context.loadEffect(url,1,()=>resolve(effect),()=>reject(new Error(`粒子素材加载失败：${name}`)));
    })).catch(error=>{this.onError(error.message);return null;}));return this.effects.get(name);
  }
  preload(database){for(const animation of database?.Animations||[])if(animation?.effectName)this.load(animation.effectName);}
  async play(animation,cue){
    const generation=this.generation,effect=await this.load(animation.effectName);if(!effect||generation!==this.generation)return;
    while(this.playing.length>=48)this.playing.shift().handle.stop();
    const handle=this.context.play(effect,0,0,0);if(!handle)return;
    const geometry=effectGeometry(animation);handle.setRotation(...geometry.rotation);handle.setScale(geometry.scale,geometry.scale,geometry.scale);handle.setSpeed(geometry.speed);
    this.playing.push({handle,animation,cue,frame:-1,age:0,flash:null});
  }
  reset(){this.generation++;for(const p of this.playing)p.handle.stop();this.playing=[];if(this.gl){this.gl.clearColor(0,0,0,0);this.gl.clear(this.gl.COLOR_BUFFER_BIT|this.gl.DEPTH_BUFFER_BIT);}}
  draw({ctx,width,height,pixelScale,point,entity,dt}){
    if(!this.context||this.status!=='ready')return;
    const canvas=this.canvas,gl=this.gl;
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    gl.viewport(0,0,width,height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    this.context.update(Math.max(0,Math.min(.1,dt))*60);
    for(const p of this.playing){
      const previous=p.frame;p.age+=dt;p.frame=p.age*60;
      for(const timing of p.animation.soundTimings||[])if(timing.frame>previous&&timing.frame<=p.frame)this.onSound(timing.se);
      for(const timing of p.animation.flashTimings||[])if(timing.frame>previous&&timing.frame<=p.frame)p.flash={...timing,start:p.frame};
      const target=entity(p.cue.targetId),position=target?point(target.x+.5,target.y+(p.animation.alignBottom?1:.5)):point(p.cue.x+.5,p.cue.y+.5);
      p.position=position;
      if(p.handle.exists){
        const view=effectViewport({...p.animation,mirror:p.cue.mirror},position,width,height,pixelScale,this.maxViewport);
        this.context.setProjectionMatrix(view.projection);this.context.setCameraMatrix([1,0,0,0,0,1,0,0,0,0,1,0,0,0,-10,1]);
        gl.viewport(view.x,view.y,view.size,view.size);this.context.beginDraw();this.context.drawHandle(p.handle);this.context.endDraw();this.renderedFrames++;
      }
    }
    ctx.drawImage(canvas,0,0,width,height,0,0,width/pixelScale,height/pixelScale);
    // MZ target flashes are composited at the target; they do not mutate gameplay state.
    for(const p of this.playing)if(p.flash){const remaining=1-(p.frame-p.flash.start)/Math.max(1,p.flash.duration);if(remaining>0){const [r,g,b,a]=p.flash.color;ctx.save();ctx.fillStyle=`rgba(${r},${g},${b},${a/255*remaining*.45})`;ctx.beginPath();ctx.arc(p.position.x,p.position.y,23,0,Math.PI*2);ctx.fill();ctx.restore();}}
    this.playing=this.playing.filter(p=>{const timingEnd=Math.max(0,...(p.animation.soundTimings||[]).map(t=>t.frame),...(p.animation.flashTimings||[]).map(t=>t.frame+t.duration));if(p.age>20){p.handle.stop();return false;}return p.handle.exists||p.frame<=timingEnd;});
  }
}
