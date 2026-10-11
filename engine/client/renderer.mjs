import { TILE, A3, A4, tileParts, tableEdgeParts, mapTile, isHigher, isTable, characterFrame } from './tile-format.mjs';
import { zoneView, sceneKey } from './protocol.mjs';
import { AppearanceComposer } from './appearance.mjs';
import { EffekseerLayer } from './effekseer.mjs';

const color = { text: '#f3eee0', blue: '#7ecee3', enemy: '#ef8e79', gold: '#e7c878' };
export const assetUrl = (folder, name, ext = 'png') => `/assets/${folder}/${encodeURIComponent(name)}.${ext}`;

class ImageStore {
  cache = new Map();
  missing = new Set();
  get(folder, name) {
    if (!name) return null;
    const url = assetUrl(folder, name);
    if (!this.cache.has(url)) {
      const image = new Image();
      image.onload = () => { image.ready = true; };
      image.onerror = () => { this.missing.add(`${folder}/${name}`); };
      image.src = url;
      this.cache.set(url, image);
    }
    return this.cache.get(url);
  }
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.images = new ImageStore();
    this.appearances = new AppearanceComposer();
    this.effekseer = new EffekseerLayer({onSound:se=>canvas.dispatchEvent(new CustomEvent('effectaudio',{detail:se})),onError:message=>{this.images.missing.add(message);canvas.dataset.effekseerError=message;}});
    this.entities = new Map();
    this.effects = [];
    this.pictures = new Map();
    this.camera = { x: 0, y: 0 };
    this.viewCenter = null;
    this.zoom = 1;
    this.showGrid = false;
    this.showRegions = false;
    this.snapshot = { players: [], events: [], drops: [], projectiles: [] };
    this.lastTime = performance.now();
    this.drawLoop = this.drawLoop.bind(this);
    requestAnimationFrame(this.drawLoop);
  }

  setMap(map, tileset, database) {
    this.map = map;
    this.tileset = tileset || {};
    this.database = database || {};
    this.effekseer.reset();this.effekseer.preload(this.database);
    this.sheets = (tileset?.tilesetNames || []).map(n => this.images.get('img/tilesets', n));
    this.parallax = this.images.get('img/parallaxes', map.parallaxName);
    this.entities.clear();
    this.effects = [];
    this.viewCenter = { x: map.width / 2, y: map.height / 2 };
  }

  accept(snapshot) {
    const sameMap = sceneKey(this.snapshot) === sceneKey(snapshot);
    if ((this.snapshot?.instance?.id || null) !== (snapshot.instance?.id || null)) this.resetPresentation();
    this.snapshot = snapshot;
    const active = new Set();
    for (const e of [...(snapshot.events || []), ...(snapshot.players || [])]) {
      active.add(e.id);
      const previous = sameMap && this.entities.get(e.id);
      const distance = previous ? Math.hypot(previous.x - e.x, previous.y - e.y) : Infinity;
      this.entities.set(e.id, { ...e, x: previous && distance < 3 ? previous.x : e.x,
        y: previous && distance < 3 ? previous.y : e.y, targetX: e.x, targetY: e.y,
        walkUntil: previous && (previous.targetX !== e.x || previous.targetY !== e.y) ? performance.now() + 180 : previous?.walkUntil || 0 });
    }
    for (const id of this.entities.keys()) if (!active.has(id)) this.entities.delete(id);
  }

  effect(effect) {
    const animation = this.database?.Animations?.[effect.animationId];
    if(animation?.effectName){
      this.effekseer.play(animation,effect);
      // Impact visuals and floating damage/healing are independent layers.
      if(effect.value!==undefined)this.effects.push({...effect,animation:null,start:performance.now(),duration:650});
      return;
    }
    if (animation?.animation1Name) this.images.get('img/animations', animation.animation1Name);
    if (animation?.animation2Name) this.images.get('img/animations', animation.animation2Name);
    this.effects.push({ ...effect, animation, start: performance.now(), duration: animation?.frames?.length ? Math.max(500, animation.frames.length * 1000 / 15) : 650 });
  }

  presentation(code, p) {
    const now = performance.now();
    if (code === 221 || code === 222) this.fade = { start: now, from: this.fadeValue || 0, to: code === 221 ? 1 : 0, duration: 400 };
    if (code === 223) this.tint = p[0];
    if (code === 224) this.flash = { color: p[0], start: now, duration: Math.max(1, p[1]) * 1000 / 60 };
    if (code === 225) this.shake = { power: p[0], speed: p[1], start: now, duration: Math.max(1, p[2]) * 1000 / 60 };
    if (code === 231) this.pictures.set(p[0], { name: p[1], origin: p[2], x: p[4], y: p[5], scaleX: p[6], scaleY: p[7], opacity: p[8], blend: p[9], angle: 0 });
    if (code === 232 && this.pictures.has(p[0])) {
      const picture = this.pictures.get(p[0]);
      picture.move = { from: { ...picture, move: undefined }, to: { origin: p[2], x: p[4], y: p[5], scaleX: p[6], scaleY: p[7], opacity: p[8], blend: p[9] }, start: now, duration: Math.max(1, p[10]) * 1000 / 60 };
    }
    if (code === 233 && this.pictures.has(p[0])) this.pictures.get(p[0]).rotationSpeed = p[1];
    if (code === 235) this.pictures.delete(p[0]);
  }

  resetPresentation() {
    this.effekseer.reset();
    this.pictures.clear(); this.effects = []; this.tint = null; this.flash = null;
    this.shake = null; this.fade = null; this.fadeValue = 0;
  }

  pan(dx, dy) {
    if (!this.map) return;
    this.viewCenter ||= { x: this.map.width / 2, y: this.map.height / 2 };
    this.viewCenter.x = Math.max(0, Math.min(this.map.width, this.viewCenter.x + dx));
    this.viewCenter.y = Math.max(0, Math.min(this.map.height, this.viewCenter.y + dy));
  }

  screenToMap(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (clientX - rect.left) / this.zoom / TILE + this.camera.x,
      y: (clientY - rect.top) / this.zoom / TILE + this.camera.y };
  }

  drawLoop(time) {
    // Schedule first so a single drawing error cannot stop the render loop.
    requestAnimationFrame(this.drawLoop);
    const dt = Math.max(0, Math.min(0.1, (time - this.lastTime) / 1000));
    this.lastTime = time;
    this.draw(time, dt);
  }

  draw(time, dt) {
    const rect = this.canvas.getBoundingClientRect(), ratio = Math.min(2, devicePixelRatio || 1);
    if (rect.width <= 0 || rect.height <= 0) return;
    if (this.canvas.width !== Math.round(rect.width * ratio) || this.canvas.height !== Math.round(rect.height * ratio)) {
      this.canvas.width = Math.round(rect.width * ratio);
      this.canvas.height = Math.round(rect.height * ratio);
    }
    const ctx = this.ctx, w = rect.width / this.zoom, h = rect.height / this.zoom;
    ctx.setTransform(ratio * this.zoom, 0, 0, ratio * this.zoom, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#172120'; ctx.fillRect(0, 0, w, h);
    if (!this.map) { this.label('载入地图素材…', w / 2, h / 2, color.text, 16); return; }
    ctx.save();
    if (this.shake && time - this.shake.start < this.shake.duration) ctx.translate(Math.sin(time / 100 * this.shake.speed) * this.shake.power, 0);
    for (const e of this.entities.values()) {
      const alpha = Math.min(1, dt * 18);
      e.x += (e.targetX - e.x) * alpha;
      e.y += (e.targetY - e.y) * alpha;
    }
    const player = this.entities.get(this.snapshot.playerId), center = player || this.viewCenter;
    const desiredX = (center?.x || 0) + .5 - w / TILE / 2, desiredY = (center?.y || 0) + .5 - h / TILE / 2;
    this.camera.x = this.map.width * TILE < w ? (this.map.width - w / TILE) / 2 : Math.max(0, Math.min(this.map.width - w / TILE, desiredX));
    this.camera.y = this.map.height * TILE < h ? (this.map.height - h / TILE) / 2 : Math.max(0, Math.min(this.map.height - h / TILE, desiredY));
    const startX = Math.max(0, Math.floor(this.camera.x) - 1), endX = Math.min(this.map.width, Math.ceil(this.camera.x + w / TILE) + 1);
    const startY = Math.max(0, Math.floor(this.camera.y) - 2), endY = Math.min(this.map.height, Math.ceil(this.camera.y + h / TILE) + 2);
    if (this.parallax?.ready) {
      const zero = this.map.parallaxName.startsWith('!');
      ctx.drawImage(this.parallax, -this.camera.x * TILE * (zero ? 1 : .5), -this.camera.y * TILE * (zero ? 1 : .5));
    }
    const frame = Math.floor(time / 500) % 12;
    for (let y = startY; y < endY; y++) for (let x = startX; x < endX; x++) this.cell(x, y, frame, false);
    this.drawZone(time);
    for (const drop of this.snapshot.drops || []) this.drop(drop, time);
    const sorted = [...this.entities.values()].filter(e => !e.erased).sort((a, b) => (a.priorityType ?? 1) - (b.priorityType ?? 1) || a.y - b.y || String(a.id).localeCompare(String(b.id)));
    for (const entity of sorted.filter(e => (e.priorityType ?? 1) < 2)) this.character(entity, time);
    for (let y = startY; y < endY; y++) for (let x = startX; x < endX; x++) this.cell(x, y, frame, true);
    for (const entity of sorted.filter(e => e.priorityType === 2)) this.character(entity, time);
    for (const projectile of this.snapshot.projectiles || []) {
      if (projectile.image?.characterName || projectile.image?.tileId) { this.character({ ...projectile, priorityType: 2 }, time); continue; }
      const p = this.point(projectile.x + .5, projectile.y + .5);
      ctx.fillStyle = color.gold; ctx.shadowColor = color.gold; ctx.shadowBlur = 15;
      ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    }
    this.effects = this.effects.filter(e => time - e.start < e.duration);
    for (const effect of this.effects) this.drawEffect(effect, time);
    this.effekseer.draw({ctx,width:this.canvas.width,height:this.canvas.height,pixelScale:ratio*this.zoom,point:(x,y)=>this.point(x,y),entity:id=>this.entities.get(id),dt});
    this.canvas.dataset.effekseer=this.effekseer.status;this.canvas.dataset.effekseerFrames=String(this.effekseer.renderedFrames);
    if (this.showGrid || this.showRegions) for (let y = startY; y < endY; y++) for (let x = startX; x < endX; x++) {
      const p = this.point(x, y), region = mapTile(this.map, x, y, 5);
      if (this.showGrid) { ctx.strokeStyle = '#fff3'; ctx.lineWidth = 1; ctx.strokeRect(p.x, p.y, TILE, TILE); }
      if (this.showRegions && region) { ctx.fillStyle = `hsla(${region * 47 % 360},70%,55%,.30)`; ctx.fillRect(p.x, p.y, TILE, TILE); this.label(String(region), p.x + 24, p.y + 27, '#fff', 12); }
    }
    this.drawPresentation(time, dt, w, h);
    if (this.portraitCanvas && player?.appearance) this.appearances.preview(this.portraitCanvas, player.appearance, 'face', time);
    ctx.restore();
  }

  point(x, y) { return { x: Math.round((x - this.camera.x) * TILE), y: Math.round((y - this.camera.y) * TILE) }; }

  parts(parts, x, y) {
    for (const p of parts) {
      const image = this.sheets[p.sheet];
      if (!image?.ready) continue;
      this.ctx.drawImage(image, p.sx, p.sy, p.sw, p.sh, x + p.dx, y + p.dy, p.dw, p.dh);
    }
  }

  cell(x, y, frame, upper) {
    const pos = this.point(x, y), flags = this.tileset.flags || [], ids = [0, 1, 2, 3].map(z => mapTile(this.map, x, y, z));
    for (let z = 0; z < 4; z++) {
      if (z === 2 && !upper) {
        const shadow = mapTile(this.map, x, y, 4);
        this.ctx.fillStyle = 'rgba(0,0,0,.5)';
        for (let i = 0; i < 4; i++) if (shadow & (1 << i)) this.ctx.fillRect(pos.x + i % 2 * 24, pos.y + Math.floor(i / 2) * 24, 24, 24);
        const above = mapTile(this.map, x, y - 1, 1);
        if (isTable(above, flags) && !isTable(ids[1], flags) && !(ids[0] >= A3 && ids[0] < A4 + 2304)) this.parts(tableEdgeParts(above), pos.x, pos.y);
      }
      if (isHigher(ids[z], flags) === upper) this.parts(tileParts(ids[z], flags, frame), pos.x, pos.y);
    }
  }

  character(e, time) {
    const image = e.image || e, name = image.characterName || '', isPlayer = !e.image, isService = Boolean(e.service) || String(e.id).startsWith('service:');
    if (!name && !image.tileId && !isPlayer && !e.enemyId) return;
    const p = this.point(e.x + .5, e.y + 1), ctx = this.ctx;
    ctx.save();
    if (e.dead) ctx.globalAlpha = .4;
    else ctx.globalAlpha = (e.opacity ?? 255) / 255;
    if (isPlayer || e.enemyId) { ctx.fillStyle = '#0005'; ctx.beginPath(); ctx.ellipse(p.x, p.y - 3, 13, 5, 0, 0, Math.PI * 2); ctx.fill(); }
    if (image.tileId > 0) this.parts(tileParts(image.tileId, this.tileset.flags), p.x - 24, p.y - 48);
    else {
      const composed = e.appearance && this.appearances.get(e.appearance, 'walk');
      const bitmap = composed || this.images.get('img/characters', name);
      if (bitmap?.ready) {
        const moving = time < e.walkUntil, pattern = moving ? [0, 1, 2, 1][Math.floor(time / 115) % 4] : image.pattern ?? 1;
        const frame = characterFrame(composed ? '$created' : name, composed ? 0 : image.characterIndex || 0, pattern, e.direction || 2, bitmap.width, bitmap.height);
        ctx.drawImage(bitmap, frame.sx, frame.sy, frame.sw, frame.sh, Math.round(p.x - frame.sw / 2), Math.round(p.y - frame.sh - frame.shiftY), frame.sw, frame.sh);
      } else if (isPlayer || e.enemyId) { ctx.fillStyle = e.enemyId ? color.enemy : color.blue; ctx.fillRect(p.x - 9, p.y - 30, 18, 27); }
    }
    ctx.restore();
    if (isPlayer || e.enemyId || isService) {
      if (!e.overhead?.text) this.label((e.name || (e.enemyId ? '敌人' : '玩家')) + (isPlayer && e.connected === false ? ' · 离线' : ''), p.x, p.y - 55, e.id === this.snapshot.playerId ? color.gold : e.enemyId ? color.enemy : color.text, 11);
      if (e.maxHp) { ctx.fillStyle = '#101918dd'; ctx.fillRect(p.x - 19, p.y - 48, 38, 4); ctx.fillStyle = e.enemyId ? color.enemy : '#98bd99'; ctx.fillRect(p.x - 19, p.y - 48, Math.max(0, Math.min(1, e.hp / e.maxHp)) * 38, 4); }
      if (e.id === this.snapshot.playerId) { ctx.strokeStyle = color.gold; ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(p.x, p.y - 2, 18, 7, 0, 0, Math.PI * 2); ctx.stroke(); }
    }
  }

  drop(drop, time) {
    const p = this.point(drop.x + .5, drop.y + .65), ctx = this.ctx, data = this.item(drop.kind, drop.itemId);
    const icon = this.images.get('img/system', 'IconSet'), bob = Math.sin(time / 250 + drop.x) * 2;
    ctx.strokeStyle = '#e9ca7888'; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(p.x, p.y + 11, 14, 5, 0, 0, Math.PI * 2); ctx.stroke();
    if (drop.kind === 'bag') {
      ctx.fillStyle='#8b7045';ctx.fillRect(p.x-11,p.y-12+bob,22,23);ctx.strokeStyle='#e8cf88';ctx.lineWidth=2;ctx.strokeRect(p.x-7,p.y-16+bob,14,8);ctx.strokeRect(p.x-11,p.y-12+bob,22,23);this.label('遗落背包',p.x,p.y-25+bob,color.gold,10);
    } else if (icon?.ready && data?.iconIndex) ctx.drawImage(icon, data.iconIndex % 16 * 32, Math.floor(data.iconIndex / 16) * 32, 32, 32, p.x - 12, p.y - 17 + bob, 24, 24);
    else { ctx.fillStyle = color.gold; ctx.fillRect(p.x - 7, p.y - 9 + bob, 14, 14); }
  }

  item(kind, id) { return this.database?.[{ item: 'Items', weapon: 'Weapons', armor: 'Armors' }[kind] || 'Items']?.[id]; }

  drawZone(time) {
    const zone = this.snapshot.zone;
    const view = zoneView(zone, this.snapshot.serverTime);
    if (!view.visible || !view.active) return;
    const rectangles = zone.rectangles || (Number.isFinite(zone.x) ? [zone] : [{ x: 0, y: 0, width: this.map.width, height: this.map.height }]);
    this.ctx.fillStyle = `rgba(197,65,44,${.12 + Math.sin(time / 800) * .03})`;
    this.ctx.strokeStyle = '#f07f55'; this.ctx.lineWidth = 2;
    for (const r of rectangles) { const p = this.point(r.x, r.y); this.ctx.fillRect(p.x, p.y, (r.width || 1) * TILE, (r.height || 1) * TILE); this.ctx.strokeRect(p.x, p.y, (r.width || 1) * TILE, (r.height || 1) * TILE); }
  }

  drawEffect(e, time) {
    // A RAF timestamp can precede performance.now() used by a just-received cue.
    const elapsed = Math.max(0, time - e.start), t = Math.min(1, elapsed / e.duration), p = this.point((e.x || 0) + .5, (e.y || 0) + .5), ctx = this.ctx;
    ctx.save(); ctx.globalAlpha = Math.max(0, 1 - t);
    if (e.animation?.frames?.length) {
      const cells = e.animation.frames[Math.min(e.animation.frames.length - 1, Math.floor(elapsed * 15 / 1000))];
      for (const cell of cells || []) {
        if (!cell || cell[0] < 0) continue;
        const [pattern, dx, dy, scale, rotation, mirror, opacity, blend] = cell;
        const sheet = this.images.get('img/animations', pattern < 100 ? e.animation.animation1Name : e.animation.animation2Name);
        if (!sheet?.ready) continue;
        ctx.save(); ctx.globalAlpha = (opacity ?? 255) / 255; ctx.globalCompositeOperation = blend === 1 ? 'lighter' : 'source-over';
        ctx.translate(p.x + dx, p.y + dy); ctx.rotate(rotation * Math.PI / 180); ctx.scale((mirror ? -1 : 1) * scale / 100, scale / 100);
        ctx.drawImage(sheet, pattern % 5 * 192, Math.floor(pattern % 100 / 5) * 192, 192, 192, -96, -96, 192, 192); ctx.restore();
      }
    } else if (e.kind === 'balloon') {
      const sheet = this.images.get('img/system', 'Balloon'), frame = Math.min(7, Math.floor(elapsed / 80));
      if (sheet?.ready) ctx.drawImage(sheet, frame * 48, ((e.balloonId || 1) - 1) * 48, 48, 48, p.x - 24, p.y - 72, 48, 48);
    } else if (e.kind === 'attack') {
      ctx.strokeStyle = '#ffe9ae'; ctx.lineWidth = Math.max(1, 7 * (1 - t)); ctx.beginPath(); ctx.arc(p.x, p.y, 14 + t * 35, -.8, 2.2); ctx.stroke();
    } else if (e.kind === 'death') {
      ctx.strokeStyle = color.enemy; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p.x, p.y, t * 45, 0, Math.PI * 2); ctx.stroke();
    }
    if (e.value !== undefined) this.label(`${e.kind === 'heal' ? '+' : ''}${e.value}`, p.x, p.y - 28 - t * 40, e.kind === 'heal' ? '#b4e1a1' : '#ffd8ba', 20);
    ctx.restore();
  }

  drawPresentation(time, dt, width, height) {
    const ctx = this.ctx;
    if (this.tint?.some(Boolean)) {
      const [r, g, b, gray] = this.tint, light = Math.max(0, -Math.min(r, g, b));
      if (light) { ctx.fillStyle = `rgba(0,0,0,${light / 255})`; ctx.fillRect(0, 0, width, height); }
      if (gray) { ctx.fillStyle = `rgba(128,128,128,${gray / 510})`; ctx.fillRect(0, 0, width, height); }
      const top = Math.max(r, g, b, 0);
      if (top) { ctx.fillStyle = `rgba(${Math.max(r, 0)},${Math.max(g, 0)},${Math.max(b, 0)},${top / 510})`; ctx.fillRect(0, 0, width, height); }
    }
    const pictureScale = Math.min(width / 816, height / 624), ox = (width - 816 * pictureScale) / 2, oy = (height - 624 * pictureScale) / 2;
    for (const [, pic] of [...this.pictures].sort((a, b) => a[0] - b[0])) {
      const image = this.images.get('img/pictures', pic.name); if (!image?.ready) continue;
      if (pic.move) {
        const move = pic.move, t = Math.min(1, (time - move.start) / move.duration);
        for (const key of ['x', 'y', 'scaleX', 'scaleY', 'opacity']) pic[key] = move.from[key] + (move.to[key] - move.from[key]) * t;
        pic.origin = move.to.origin; pic.blend = move.to.blend; if (t === 1) pic.move = null;
      }
      pic.angle = (pic.angle || 0) + (pic.rotationSpeed || 0) * dt * 30;
      ctx.save(); ctx.globalAlpha = (pic.opacity ?? 255) / 255; ctx.globalCompositeOperation = pic.blend === 1 ? 'lighter' : pic.blend === 2 ? 'multiply' : pic.blend === 3 ? 'screen' : 'source-over';
      ctx.translate(ox + pic.x * pictureScale, oy + pic.y * pictureScale); ctx.rotate(pic.angle * Math.PI / 180); ctx.scale(pictureScale * pic.scaleX / 100, pictureScale * pic.scaleY / 100);
      ctx.drawImage(image, pic.origin === 1 ? -image.width / 2 : 0, pic.origin === 1 ? -image.height / 2 : 0); ctx.restore();
    }
    if (this.flash) {
      const t = Math.min(1, (time - this.flash.start) / this.flash.duration), [r,g,b,a] = this.flash.color;
      ctx.fillStyle = `rgba(${r},${g},${b},${(a || 0) / 255 * (1 - t)})`; ctx.fillRect(0, 0, width, height); if (t === 1) this.flash = null;
    }
    if (this.fade) { const t = Math.min(1, (time - this.fade.start) / this.fade.duration); this.fadeValue = this.fade.from + (this.fade.to - this.fade.from) * t; if (t === 1) this.fade = null; }
    if (this.fadeValue) { ctx.fillStyle = `rgba(0,0,0,${this.fadeValue})`; ctx.fillRect(0, 0, width, height); }
  }

  label(text, x, y, fill = color.text, size = 12) {
    const ctx = this.ctx; ctx.font = `600 ${size}px system-ui, "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111c1c'; ctx.lineWidth = 3; ctx.strokeText(text, x, y); ctx.fillStyle = fill; ctx.fillText(text, x, y);
  }
}
