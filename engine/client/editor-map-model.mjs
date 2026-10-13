import {A1,A2,A3,A4,A5,mapTile} from './tile-format.mjs';
import {FLOOR} from './autotile-tables.mjs';

export const SLOT_NAMES=['A1','A2','A3','A4','A5','B','C','D','E'];
export const tileKind=id=>id>=A1&&id<8192?Math.floor((id-A1)/48):-1;
export const sameTile=(a,b)=>a===b||(tileKind(a)>=0&&tileKind(a)===tileKind(b));
export const tileIndex=(map,x,y,z)=>(z*map.height+y)*map.width+x;
export const inside=(map,x,y)=>Number.isInteger(x)&&Number.isInteger(y)&&x>=0&&y>=0&&x<map.width&&y<map.height;

// The three RM formats use the exact tables in rpg_core.js, not a shared
// four-neighbour approximation. Floor corners also depend on their diagonals.
export function autotileType(id){
  const kind=tileKind(id);if(kind<0)return null;
  if(id<A2)return kind>=4&&kind%2?'waterfall':'floor';
  if(id<A3)return 'floor';
  if(id<A4)return 'wall';
  return Math.floor(kind/8)%2?'wall':'floor';
}

export function autotileShape(type,{n,e,s,w,nw,ne,se,sw}){
  if(type==='waterfall')return (!w?1:0)+(!e?2:0);
  if(type==='wall')return (!w?1:0)+(!n?2:0)+(!e?4:0)+(!s?8:0);
  const quarters=[
    n?(w?(nw?[2,4]:[2,0]):[0,4]):(w?[2,2]:[0,2]),
    n?(e?(ne?[1,4]:[3,0]):[3,4]):(e?[1,2]:[3,2]),
    s?(w?(sw?[2,3]:[2,1]):[0,3]):(w?[2,5]:[0,5]),
    s?(e?(se?[1,3]:[3,1]):[3,3]):(e?[1,5]:[3,5]),
  ];
  return FLOOR.findIndex(row=>row.every((q,i)=>q[0]===quarters[i][0]&&q[1]===quarters[i][1]));
}

function wrapped(map,x,y){
  if(map.scrollType===2||map.scrollType===3)x=(x%map.width+map.width)%map.width;
  if(map.scrollType===1||map.scrollType===3)y=(y%map.height+map.height)%map.height;
  return {x,y};
}

export function connectedTile(map,x,y,z){
  const id=mapTile(map,x,y,z),kind=tileKind(id);if(kind<0)return id;
  const connected=(dx,dy)=>{const p=wrapped(map,x+dx,y+dy);
    // A non-looping map's outer edge continues its material off-screen.
    return !inside(map,p.x,p.y)||tileKind(mapTile(map,p.x,p.y,z))===kind;};
  const shape=autotileShape(autotileType(id),{n:connected(0,-1),e:connected(1,0),s:connected(0,1),w:connected(-1,0),
    nw:connected(-1,-1),ne:connected(1,-1),se:connected(1,1),sw:connected(-1,1)});
  return A1+kind*48+Math.max(0,shape);
}

// Palette coordinates match each sheet's actual 48px layout. B–E's right
// eight columns live 128 IDs later; A1–A4 select kinds, never raw quarters.
export function paletteTiles(slot){
  if(slot<0||slot>8)return {width:0,height:0,ids:[]};
  if(slot<4){const starts=[A1,A2,A3,A4],counts=[16,32,32,48],count=counts[slot];
    return {width:8,height:count/8,ids:Array.from({length:count},(_,i)=>starts[slot]+i*48)};}
  const width=slot===4?8:16,height=16;
  return {width,height,ids:Array.from({length:width*height},(_,i)=>{
    const x=i%width,y=Math.floor(i/width);return slot===4?A5+y*8+x:(slot-5)*256+(x>=8?128:0)+y*8+x%8;
  })};
}

export function paletteStamp(palette,from,to){
  const left=Math.max(0,Math.min(from.x,to.x)),top=Math.max(0,Math.min(from.y,to.y));
  const right=Math.min(palette.width-1,Math.max(from.x,to.x)),bottom=Math.min(palette.height-1,Math.max(from.y,to.y));
  const width=right-left+1,height=bottom-top+1,tiles=[];
  for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++)tiles.push(palette.ids[y*palette.width+x]);
  return {width,height,tiles};
}

export function lineCells(from,to){
  let x=from.x,y=from.y;const cells=[],dx=Math.abs(to.x-x),sx=x<to.x?1:-1,dy=-Math.abs(to.y-y),sy=y<to.y?1:-1;let err=dx+dy;
  while(true){cells.push({x,y});if(x===to.x&&y===to.y)break;const e=2*err;if(e>=dy){err+=dy;x+=sx;}if(e<=dx){err+=dx;y+=sy;}}
  return cells;
}

export class MapPaintModel{
  constructor(map){this.load(map);}
  load(map){this.map=structuredClone(map);this.undoStack=[];this.redoStack=[];this.transaction=null;}
  begin(){if(this.transaction)this.commit();this.transaction=new Map();}
  write(x,y,z,value){
    if(!inside(this.map,x,y)||z<0||z>5||!Number.isInteger(value))return;
    if(z===4)value=Math.max(0,Math.min(15,value));if(z===5)value=Math.max(0,Math.min(255,value));
    const i=tileIndex(this.map,x,y,z),old=this.map.data[i]||0;if(old===value)return;
    if(!this.transaction)this.begin();
    if(!this.transaction.has(i))this.transaction.set(i,{before:old,after:value});else this.transaction.get(i).after=value;
    this.map.data[i]=value;
  }
  paint(cells,z,stamp,{connect=true,origin=cells[0]||{x:0,y:0}}={}){
    if(!stamp?.width||!stamp?.height)return;
    const affected=new Map();
    for(const {x,y}of cells){if(!inside(this.map,x,y))continue;
      const sx=((x-origin.x)%stamp.width+stamp.width)%stamp.width,sy=((y-origin.y)%stamp.height+stamp.height)%stamp.height;
      this.write(x,y,z,stamp.tiles[sy*stamp.width+sx]??0);
      if(connect&&z<4)for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const p=wrapped(this.map,x+dx,y+dy);if(inside(this.map,p.x,p.y))affected.set(`${p.x},${p.y}`,p);}
    }
    for(const {x,y}of affected.values())this.write(x,y,z,connectedTile(this.map,x,y,z));
  }
  stamp(x,y,z,stamp,options={}){
    const cells=[];for(let dy=0;dy<stamp.height;dy++)for(let dx=0;dx<stamp.width;dx++)cells.push({x:x+dx,y:y+dy});
    this.paint(cells,z,stamp,{...options,origin:{x,y}});
  }
  rectangle(from,to,z,stamp,options={}){
    const left=Math.min(from.x,to.x),top=Math.min(from.y,to.y),cells=[];
    for(let y=top;y<=Math.max(from.y,to.y);y++)for(let x=left;x<=Math.max(from.x,to.x);x++)cells.push({x,y});
    this.paint(cells,z,stamp,{...options,origin:{x:left,y:top}});
  }
  fill(x,y,z,stamp,options={}){
    if(!inside(this.map,x,y))return;
    const target=mapTile(this.map,x,y,z),seen=new Set(),queue=[{x,y}],cells=[];
    for(let cursor=0;cursor<queue.length;cursor++){
      const p=queue[cursor],key=p.y*this.map.width+p.x;if(seen.has(key))continue;seen.add(key);
      if(!sameTile(mapTile(this.map,p.x,p.y,z),target))continue;cells.push(p);
      for(const [dx,dy]of [[0,-1],[1,0],[0,1],[-1,0]]){const next=wrapped(this.map,p.x+dx,p.y+dy);if(inside(this.map,next.x,next.y))queue.push(next);}
    }
    this.paint(cells,z,stamp,{...options,origin:{x,y}});
  }
  commit(){
    if(!this.transaction)return false;
    const changes=[...this.transaction].filter(([,v])=>v.before!==v.after);this.transaction=null;
    if(!changes.length)return false;
    this.record({kind:'tiles',changes});return true;
  }
  record(entry){this.undoStack.push(entry);if(this.undoStack.length>100)this.undoStack.shift();this.redoStack=[];}
  updateEvent(event,id=event?.id){
    if(!Number.isInteger(id)||id<1||id>10000)throw new Error('事件 ID 必须是 1–10000 的整数');
    this.commit();const events=this.map.events||[null],before=structuredClone(events[id]??null),beforeLength=events.length,after=event?structuredClone({...event,id}):null;
    if(JSON.stringify(before)===JSON.stringify(after))return false;
    while(events.length<=id)events.push(null);events[id]=after;this.map.events=events;
    // Event history does not duplicate all six tile planes for every dialog edit.
    this.record({kind:'event',id,before,after:structuredClone(after),beforeLength,afterLength:events.length});return true;
  }
  applyProperties(properties){
    this.commit();const width=Number(properties.width??this.map.width),height=Number(properties.height??this.map.height);
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>256||height>256)throw new Error('地图宽高必须是 1–256 的整数');
    if((this.map.events||[]).some(e=>e&&(e.x>=width||e.y>=height)))throw new Error('缩小后有事件超出地图，请先移动或删除这些事件');
    const before=structuredClone(this.map),data=Array(width*height*6).fill(0);
    for(let z=0;z<6;z++)for(let y=0;y<Math.min(height,this.map.height);y++)for(let x=0;x<Math.min(width,this.map.width);x++)data[(z*height+y)*width+x]=mapTile(this.map,x,y,z);
    const {data:ignoredData,events:ignoredEvents,id:ignoredId,...safe}=properties;
    this.map={...this.map,...structuredClone(safe),width,height,data};
    if(JSON.stringify(before)===JSON.stringify(this.map))return false;
    this.record({kind:'document',before,after:structuredClone(this.map)});return true;
  }
  cancel(){if(this.transaction)for(const[i,v]of this.transaction)this.map.data[i]=v.before;this.transaction=null;}
  restore(entry,side){
    if(entry.kind==='document')this.map=structuredClone(entry[side]);
    else if(entry.kind==='event'){this.map.events[entry.id]=structuredClone(entry[side]);this.map.events.length=entry[`${side}Length`];}
    else for(const[i,v]of entry.changes)this.map.data[i]=v[side];
  }
  undo(){this.cancel();const entry=this.undoStack.pop();if(!entry)return false;this.restore(entry,'before');this.redoStack.push(entry);return true;}
  redo(){this.cancel();const entry=this.redoStack.pop();if(!entry)return false;this.restore(entry,'after');this.undoStack.push(entry);return true;}
}
