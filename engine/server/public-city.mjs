import {eventTags} from './event-tags.mjs';
/** Shared public-world locations. NPCs themselves remain authored in RPG Maker. */
export const PUBLIC_CITY_MAPS=Object.freeze([40,41,42,43,44,45,46,47,48]);
export const PUBLIC_CITY_SPAWN=Object.freeze({mapId:40,x:20,y:23,direction:2});
export const PUBLIC_CITY_SERVICES=Object.freeze({
  instance:Object.freeze({id:'instance-guide',mapId:41,x:23,y:12}),
  appearance:Object.freeze({id:'appearance-guide',mapId:43,x:10,y:8})
});
export const PUBLIC_CITY_VERSION=1;

export function bindPublicCityServices(map){
  for(const [kind,location]of Object.entries(PUBLIC_CITY_SERVICES)){
    if(map.id!==location.mapId)continue;
    const matches=[...map.events.values()].filter(event=>eventTags(event.raw||event).engine_service?.toLowerCase()===kind.toLowerCase());
    if(matches.length!==1)throw new Error(`公共地图 ${map.id} 需要且只能有一个 engine_service: ${kind} 事件`);
    const event=matches[0];map.events.delete(event.id);
    event.id=`service:${location.id}`;event.service={kind};map.events.set(event.id,event);
  }
}

/** Migrate the retired starting room once; retain inventories and other saved locations. */
export function publicCityArrival(state){
  if(Number(state.publicCityVersion)>=PUBLIC_CITY_VERSION)return state;
  return{...state,...(Number(state.mapId)===1?PUBLIC_CITY_SPAWN:{}),publicCityVersion:PUBLIC_CITY_VERSION};
}
