const distance = (point, entity) => Math.hypot(entity.x + .5 - point.x, entity.y + .5 - point.y);
const nearest = (point, entities) => entities.filter(e => distance(point, e) < .7).sort((a, b) => distance(point, a) - distance(point, b))[0];

// A pointer selects an intention. Routes, reach and attack costs remain server-owned.
export function pointerCommand(point, snapshot, {skillId, requestId} = {}) {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return null;
  const command = {type: 'navigate', x: Math.floor(point.x), y: Math.floor(point.y)};
  const events = (snapshot?.events || []).filter(e => !e.erased && !e.disabled);
  const enemy = nearest(point, events.filter(e => e.enemyId && e.hp > 0));
  const player = snapshot?.pvp && nearest(point, (snapshot.players || []).filter(p => p.id !== snapshot.playerId && !p.dead));
  const event = nearest(point, events.filter(e => !e.enemyId && (e.service || e.image?.characterName || e.image?.tileId)));
  const drop = nearest(point, snapshot?.drops || []);
  const target = enemy || player || event || drop;
  if (target) {command.x = target.x; command.y = target.y;}
  if (enemy || player) {
    if (enemy) command.targetId = enemy.id; else command.targetPlayerId = player.id;
    if (Number.isInteger(skillId) && skillId > 0) command.skillId = skillId;
    if (requestId) command.requestId = requestId;
  } else if (event) command.targetId = event.id;
  else if (drop) {command.entityId = drop.id; if (requestId) command.requestId = requestId;}
  return command;
}

/** Pointer Events work for mouse, touch and pen without synthetic click duplicates. */
export class PointerGesture {
  points = new Map();
  blocked = false;
  down(event) {
    if (event.button === 2) {this.cancel(); return {kind: 'cancel'};}
    if (event.button !== 0) return null;
    this.points.set(event.pointerId, {x: event.clientX, y: event.clientY});
    if (this.points.size > 1) {this.blocked = true; return {kind: 'cancel'};}
    return null;
  }
  move(event) {
    if (this.points.has(event.pointerId)) this.points.set(event.pointerId, {x: event.clientX, y: event.clientY});
  }
  up(event) {
    const known = this.points.has(event.pointerId), blocked = this.blocked;
    this.points.delete(event.pointerId);
    if (!this.points.size) this.blocked = false;
    return known && !blocked ? {kind: 'navigate', x: event.clientX, y: event.clientY} : null;
  }
  held() {return !this.blocked && this.points.size === 1 ? [...this.points.values()][0] : null;}
  cancel() {this.points.clear(); this.blocked = false;}
}

const modeNames = {throw: '投掷', thrown: '投掷', projectile: '远程', firearm: '枪械', gun: '枪械', staff: '法杖', magic: '法杖', melee: '近战', club: '范围近战', cleave: '劈斩'};
export function weaponDetails(entry, profile, inventory = [], itemName = id => `物品 #${id}`) {
  const details = [];
  if(entry?.itemId===65)details.push('飞火流星 · 以引导结束时自身位置为中心的 3×3 范围','消耗全部 MP · 敌我皆伤，包含自己','只能在室外发动；死亡或进入室内取消，MP 不返还');
  if (profile) {
    details.push(profile.mode === 'cleave' ? '劈斩 · 面前紧邻横排三格' : `${modeNames[profile.mode] || profile.mode || '近战'} · 距离 ${profile.range || 1} 格`);
    if (profile.movementSpeed > 0 && profile.movementSpeed < 1) details.push(`装备时移动速度降低 ${Math.round((1-profile.movementSpeed)*100)}%`);
    const costs = [];
    if (profile.durabilityCost > 0) costs.push(`耐久 ${profile.durabilityCost}`);
    if (profile.mpCost > 0) costs.push(`MP ${profile.mpCost}`);
    if (profile.ammoItemId) {
      const owned = inventory.filter(i => i.kind === 'item' && i.itemId === profile.ammoItemId).reduce((n, i) => n + i.quantity, 0);
      costs.push(`${itemName(profile.ammoItemId)} ${profile.ammoCost || 1}（持有 ${owned}）`);
    }
    if (costs.length) details.push(`每次攻击：${costs.join(' / ')}`);
  }
  if (Number.isFinite(entry?.durability)) details.push(`耐久 ${entry.durability} / ${entry.maxDurability ?? profile?.maxDurability ?? entry.durability}${entry.durability <= 0 ? ' · 已损坏，无法攻击' : ''}`);
  return details.join('\n');
}
