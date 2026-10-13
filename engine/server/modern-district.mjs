import {configureNpc} from './npcs.mjs';
import {eventTags,npcTag} from './event-tags.mjs';
/** Authoring contract: map.note contains <modernRound>; event.note overrides legacy RM comments. */
export const MODERN_ROUND_MAPS = Object.freeze([31, 32, 33, 34, 35, 36, 37, 38, 39]);

// Keep the original routes' timing. The new districts close in three later waves.
export const MODERN_ZONE_SCHEDULE = Object.freeze([
  {mapId: 33, seconds: 360}, {mapId: 34, seconds: 360}, {mapId: 35, seconds: 360},
  {mapId: 36, seconds: 510}, {mapId: 37, seconds: 510}, {mapId: 38, seconds: 510},
  {mapId: 39, seconds: 660}, {mapId: 32, seconds: 660}, {mapId: 31, seconds: 660}
]);

export const isModernRoundMap = map => MODERN_ROUND_MAPS.includes(map.id) && /<modernRound>/i.test(map.note || '');

export function modernEventTags(raw,page) {
  // Keep the former page-only helper usable by integrations.
  if(raw?.list&&!page){page=raw;raw={};}
  const tags=eventTags(raw,page);
  return {container:tags.engine_container,enemy:npcTag(tags)};
}

function weaponProfile(content, mode) {
  const profile = [...(content.weaponProfiles?.values() || [])].find(entry => entry.mode === mode);
  if (!profile) throw new Error(`现代区补给缺少 ${mode} 武器定义`);
  return profile;
}

function containerItems(content, type) {
  const item = (itemId, quantity) => ({kind: 'item', itemId, quantity});
  if (type === 'medical') return [item(7, 2), item(13, 1)];
  if (type === 'supplies') return [item(47, 2), item(48, 2), item(58, 1), item(59, 1)];
  if (type === 'ammo') {
    const firearm = weaponProfile(content, 'firearm');
    return [item(firearm.ammoItemId, 18), item(14, 1)];
  }
  const mode = type.match(/^weapon_(throw|firearm|staff|club)$/)?.[1];
  if (!mode) throw new Error(`未知现代区补给类型：${type}`);
  const weapon = weaponProfile(content, mode), items = [{kind: 'weapon', itemId: weapon.weaponId, quantity: 1}];
  if (weapon.ammoCost) items.push(item(weapon.ammoItemId, 12));
  if (mode === 'staff') items.push(item(14, 2));
  else items.push(item(7, 1));
  return items;
}

/** Convert the authored events in place, preserving their editor-visible positions and images. */
export function decorateModernDistrict(round, map) {
  for (const event of map.events.values()) {
    const page = event.pages[0], tags = modernEventTags(event.raw,page);
    if(page?.engineDisabledReason)continue;
    if (tags.container && tags.enemy) throw new Error(`地图 ${map.id} 事件 ${event.eventId} 同时标记为箱子与敌人`);
    if (tags.container) {
      const containerId = `modern:${map.id}:${event.eventId}`;
      event.service = {kind: 'round', action: 'container', containerId};
      round.containers.set(containerId, {items: structuredClone(round.scenario?.containerLoot?.[tags.container] || containerItems(round.world.content, tags.container)), opened: false});
    }
    if (tags.enemy) {
      if (!configureNpc(event,`engine_npc:${tags.enemy}`,round.world.content)) throw new Error(`地图 ${map.id} 事件 ${event.eventId} 的实时 NPC 模板不存在：${tags.enemy}`);
      Object.assign(event, {name: event.raw.name, noRespawn: true});
    }
  }
}
