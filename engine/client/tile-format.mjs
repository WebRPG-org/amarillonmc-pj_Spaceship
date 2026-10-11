import { FLOOR, WALL, WATERFALL } from './autotile-tables.mjs';

export const TILE = 48;
export const A1 = 2048, A2 = 2816, A3 = 4352, A4 = 5888, A5 = 1536;
export const isTable = (id, flags = []) => id >= A2 && id < A3 && Boolean(flags[id] & 0x80);
export const isHigher = (id, flags = []) => Boolean(flags[id] & 0x10);

// Return drawImage rectangles in native tile pixels. Kept free of DOM for testing.
export function tileParts(id, flags = [], frame = 0, size = TILE) {
  if (!Number.isInteger(id) || id <= 0 || id >= 8192) return [];
  if (id < A1) {
    if (id >= 1024 && id < A5) return [];
    return [{ sheet: id >= A5 ? 4 : 5 + Math.floor(id / 256),
      sx: (Math.floor(id / 128) % 2 * 8 + id % 8) * size,
      sy: Math.floor(id % 256 / 8) % 16 * size, sw: size, sh: size,
      dx: 0, dy: 0, dw: size, dh: size }];
  }
  const kind = Math.floor((id - A1) / 48), shape = (id - A1) % 48;
  const tx = kind % 8, ty = Math.floor(kind / 8), half = size / 2;
  let sheet = 0, bx = 0, by = 0, table = FLOOR;
  if (id < A2) {
    const water = [0, 1, 2, 1][frame % 4];
    if (kind < 4) { bx = kind < 2 ? water * 2 : 6; by = kind % 2 * 3; }
    else {
      bx = Math.floor(tx / 4) * 8;
      by = ty * 6 + Math.floor(tx / 2) % 2 * 3;
      if (kind % 2 === 0) bx += water * 2;
      else { bx += 6; by += frame % 3; table = WATERFALL; }
    }
  } else if (id < A3) { sheet = 1; bx = tx * 2; by = (ty - 2) * 3; }
  else if (id < A4) { sheet = 2; bx = tx * 2; by = (ty - 6) * 2; table = WALL; }
  else { sheet = 3; bx = tx * 2; by = Math.floor((ty - 10) * 2.5 + (ty % 2 ? 0.5 : 0)); if (ty % 2) table = WALL; }
  if (!table[shape]) return [];
  return table[shape].flatMap(([qx, qy], i) => {
    const rect = { sheet, sx: (bx * 2 + qx) * half, sy: (by * 2 + qy) * half,
      sw: half, sh: half, dx: i % 2 * half, dy: Math.floor(i / 2) * half, dw: half, dh: half };
    if (!isTable(id, flags) || (qy !== 1 && qy !== 5)) return [rect];
    const qx2 = qy === 1 ? [0, 3, 2, 1][qx] : qx;
    return [{ ...rect, sx: (bx * 2 + qx2) * half, sy: (by * 2 + 3) * half },
      { ...rect, sh: half / 2, dh: half / 2, dy: rect.dy + half / 2 }];
  });
}

export function tableEdgeParts(id, size = TILE) {
  if (id < A2 || id >= A3) return [];
  const kind = Math.floor((id - A1) / 48), table = FLOOR[(id - A1) % 48], h = size / 2;
  return (table?.slice(2) || []).map(([qx, qy], i) => ({ sheet: 1,
    sx: (kind % 8 * 4 + qx) * h, sy: ((Math.floor(kind / 8) - 2) * 6 + qy) * h + h / 2,
    sw: h, sh: h / 2, dx: i * h, dy: 0, dw: h, dh: h / 2 }));
}

export function mapTile(map, x, y, z) {
  if (!map) return 0;
  if (map.scrollType === 2 || map.scrollType === 3) x = ((x % map.width) + map.width) % map.width;
  if (map.scrollType === 1 || map.scrollType === 3) y = ((y % map.height) + map.height) % map.height;
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return 0;
  return map.data[(z * map.height + y) * map.width + x] || 0;
}

export function characterFrame(name, index, pattern, direction, width, height) {
  const prefix = name.match(/^[!$]+/)?.[0] || '';
  const big = prefix.includes('$'), w = width / (big ? 3 : 12), h = height / (big ? 4 : 8);
  return { sx: ((big ? 0 : index % 4 * 3) + Math.min(2, Math.max(0, pattern))) * w,
    sy: ((big ? 0 : Math.floor(index / 4) * 4) + Math.max(0, direction / 2 - 1)) * h,
    sw: w, sh: h, shiftY: prefix.includes('!') ? 0 : 6 };
}

export function snapshotPreview(map, mapId) {
  return { type: 'snapshot', mapId, playerId: null, players: [], drops: [], projectiles: [],
    events: (map.events || []).filter(Boolean).flatMap(event => {
      // A preview cannot evaluate server/player conditions. Show the first unconditional page.
      const page = event.pages?.find(p => !p.conditions || !Object.entries(p.conditions).some(([k, v]) => k.endsWith('Valid') && v));
      const comments = (page?.list || []).filter(c => [108,408].includes(c.code)).map(c => c.parameters?.[0] || '').join('\n');
      const label = [...comments.matchAll(/<Name:\s*([^\r\n]*?)>/gi)].at(-1)?.[1];
      return page ? [{ id: `preview-${event.id}`, eventId: event.id, pageIndex:event.pages.indexOf(page), name: event.name, x: event.x, y: event.y,
        overhead:label ? {text:label,quest:/<Is\s+Quest>/i.test(comments),fontSize:14,range:5,offsetY:36} : null,
        direction: page.image?.direction || 2, image: page.image, priorityType: page.priorityType, opacity: page.opacity ?? 255 }] : [];
    }), self: { inventory: [], skills: [], equips: {} } };
}
