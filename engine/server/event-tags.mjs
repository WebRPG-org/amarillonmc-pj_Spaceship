const comments = page => (page?.list || []).filter(command => [108,408].includes(command.code)).map(command => command.parameters?.[0] || '').join('\n');
/** Explicit note tags override the same legacy comment key; the first occurrence wins within each source. */
export function parseEngineTags(text) {
  const tags = {};
  for (const match of String(text || '').matchAll(/^[ \t]*<?(engine_[a-z0-9_]+)[ \t]*:[ \t]*([\w-]*)[ \t]*>?[ \t]*$/gim)) {
    const key = match[1].toLowerCase();
    if (!Object.hasOwn(tags,key)) tags[key] = match[2];
  }
  return tags;
}
export function eventTags(raw,page) {
  const legacy = page ? comments(page) : (raw?.pages || []).map(comments).join('\n');
  return {...parseEngineTags(legacy),...parseEngineTags(raw?.note)};
}
export function eventNotes(raw,page) {
  const canonical = Object.entries(eventTags(raw,page)).map(([key,value]) => `${key}: ${value}`).join('\n');
  return [canonical,raw?.note || '',page ? comments(page) : (raw?.pages || []).map(comments).join('\n')].join('\n');
}
export const npcTag = tags => Object.hasOwn(tags,'engine_npc') ? tags.engine_npc : tags.engine_enemy;
