export function effectUrl(name) {
  if(typeof name!=='string'||!name||name.includes('\\')||name.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('无效粒子效果路径');
  return '/assets/effects/'+name.split('/').map(encodeURIComponent).join('/')+'.efkefc';
}
export function effectGeometry(animation={}) {
  const clamp=(value,min,max,fallback)=>Number.isFinite(Number(value))?Math.max(min,Math.min(max,Number(value))):fallback;
  return {scale:clamp(animation.scale,1,2000,100)/100,speed:clamp(animation.speed,1,1000,100)/100,
    rotation:['x','y','z'].map(k=>clamp(animation.rotation?.[k],-36000,36000,0)*Math.PI/180),
    offsetX:clamp(animation.offsetX,-4096,4096,0),offsetY:clamp(animation.offsetY,-4096,4096,0)};
}
export function effectViewport(animation,point,width,height,pixelScale,maxViewport=16384) {
  const geometry=effectGeometry(animation),size=Math.min(maxViewport,Math.round(4096*pixelScale));
  const center=animation.displayType===2?{x:width/2,y:height/2}:{x:point.x*pixelScale,y:point.y*pixelScale};
  return {x:Math.round(center.x+geometry.offsetX*pixelScale-size/2),y:Math.round(height-center.y-geometry.offsetY*pixelScale-size/2),size,
    projection:[animation.mirror?-1:1,0,0,0,0,1,0,0,0,0,1,-size/(816*pixelScale),0,0,0,1]};
}
