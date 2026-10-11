// Derive display state only from the authoritative snapshot clock. Browser wall
// clocks may be wrong; the client must not activate damage or advance the zone.
export function zoneView(zone, serverTime) {
  if (!zone || !Number.isFinite(serverTime)) return { visible: false, active: false, seconds: 0 };
  if (Number.isFinite(zone.endsAt) && serverTime > zone.endsAt) return { visible: false, active: false, seconds: 0 };
  const active = zone.active ?? serverTime >= (zone.startsAt || 0);
  const target = active ? zone.endsAt : zone.startsAt;
  return { visible: true, active, seconds: Number.isFinite(target) ? Math.max(0, Math.ceil((target - serverTime) / 1000)) : null };
}

// Map numbers repeat between isolated instances; rendering identity includes both.
export function sceneKey(snapshot) { return JSON.stringify([snapshot?.instance?.id || null, snapshot?.mapId ?? null]); }
export function withCommandContext(message, snapshot) {
  return message.type === 'appearance' ? { ...message } : { ...message, contextInstanceId: snapshot?.instance?.id || null };
}
