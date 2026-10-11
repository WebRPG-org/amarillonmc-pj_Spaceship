// Character Creator EX palette math, independent of the old PIXI runtime.
const IDENTITY = [1,0,0,0,1,0,0,0,1];
// This project's PIXI filter writes into its right operand while multiplying.
// Preserve that observable palette behavior so old SRD colors remain identical.
const multiply = (a,b) => {const out=b.slice();for(let r=0;r<3;r++)for(let c=0;c<3;c++)out[r*3+c]=a[r*3]*out[c]+a[r*3+1]*out[c+3]+a[r*3+2]*out[c+6];return Array.from(new Float32Array(out));};
export function paletteMatrix(color = {}) {
  let matrix = IDENTITY.slice();
  const apply = m => { matrix = multiply(matrix,m); };
  const gray=Number(color.grayscale)||0,brightness=Number(color.brightness)||0,saturation=Number(color.saturation)||0,hue=Number(color.hue)||0;
  // Match SRD's truthy checks: a palette brightness of zero means no adjustment.
  if(gray) apply(Array(9).fill(gray));
  if(brightness) apply([brightness,0,0,0,brightness,0,0,0,brightness]);
  if(saturation){const x=saturation*2/3+1,y=(x-1)*-.5;apply([x,y,y,y,x,y,y,y,x]);}
  if(hue){const angle=hue/180*Math.PI,c=Math.cos(angle),s=Math.sin(angle),w=(1-c)/3,q=Math.sqrt(1/3)*s;apply([c+w,w-q,w+q,w+q,c+w,w-q,w-q,w+q,c+w]);}
  return matrix;
}
export function transformPixel(r,g,b,m){return [m[0]*r+m[1]*g+m[2]*b,m[3]*r+m[4]*g+m[5]*b,m[6]*r+m[7]*g+m[8]*b].map(v=>Math.max(0,Math.min(255,Math.round(v))));}
export function appearanceLayers(catalog,appearance,type='walk') {
  if(appearance?.kind!=='creator')return[];
  const result=[];
  for(const group of catalog?.creator?.groups||[]){
    const selection=appearance.pieces?.[group.key];
    const option=group.options.find(o=>o.id===selection?.id);if(!option)continue;
    const color=group.colors?.find(c=>c.id===selection.color)||group.colors?.[selection.color]||{};
    for(const layer of option.layers||[])if(layer[type])result.push({key:layer.key,order:layer.order,url:layer[type],color,group:group.key});
  }
  return result.sort((a,b)=>a.order-b.order);
}
export function appearanceKey(appearance,type='walk'){
  if(appearance?.kind==='actor')return `actor:${appearance.actorId}:${type}`;
  return `${type}:${JSON.stringify(Object.entries(appearance?.pieces||{}).sort(([a],[b])=>a.localeCompare(b)))}`;
}
