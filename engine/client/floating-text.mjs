import { parseRichText, renderRichText } from './rich-text.mjs';
import { characterFrame } from './tile-format.mjs';

const frames = value => Math.max(0, Number(value) || 0) * 1000 / 60;
const number = (value, fallback) => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback;
const scene = snapshot => `${snapshot?.instance?.id || ''}:${snapshot?.mapId}`;
export function popupOpacity(elapsed, {fadeIn = 10, duration = 200, fadeOut = 60} = {}) {
  const fade = frames(fadeIn), hold = frames(duration), end = frames(fadeOut);
  if (elapsed < 0) return 0;
  if (elapsed < fade) return fade ? elapsed / fade : 1;
  if (elapsed < fade + hold) return 1;
  return end ? Math.max(0, 1 - (elapsed - fade - hold) / end) : 0;
}
export function overheadPosition(entity, camera, zoom, options = {}) {
  return {x: ((entity.x + .5 - camera.x) * 48 + (options.x || 0)) * zoom,
    y: ((entity.y + 1 - camera.y) * 48 + (options.y ?? -54)) * zoom};
}
export function resolveFloatingEntity(renderer, entry) {
  const entity = entry.entityId == null ? null : renderer.entities.get(entry.entityId);
  if (entity || entry.eventId == null) return entity || null;
  if (entry.eventId === -1) return renderer.entities.get(renderer.snapshot.playerId) || null;
  return [...renderer.entities.values()].find(candidate => candidate.id === entry.eventId || candidate.eventId === entry.eventId) || null;
}
export function overheadInRange(entity, self, range) {
  // MMO_Overhead uses a square tile range, so diagonally adjacent labels stay visible.
  return !self || range == null || range >= 500 || Math.abs(self.x-entity.x) <= range && Math.abs(self.y-entity.y) <= range;
}

// Uses DOM glyphs to share text effects with message windows; positions follow the interpolated map entities.
export class FloatingTextLayer {
  constructor({root, gab, portrait, gabText, renderer, context, defaults, config, sound, diagnostic}) {
    Object.assign(this, {root, gab, portrait, gabText, renderer, context, defaults, config, sound, diagnostic});
    this.entries = new Map(); this.sequence = 0; this.gabController = null;
    this.animate = this.animate.bind(this); this.frame = requestAnimationFrame(this.animate);
  }
  remove(key) { const entry = this.entries.get(key); entry?.controller?.destroy(); entry?.node.remove(); this.entries.delete(key); }
  clearMap() { for (const key of [...this.entries.keys()]) this.remove(key); }
  clear() { this.clearMap(); this.showGab({action:'clear'}); }
  text(node, text, context, overrides) {
    const defaults = {...this.defaults(), ...overrides};
    const parsed = parseRichText(text, this.context(context), defaults);
    return renderRichText(node, parsed, {instant:true, onDiagnostic:this.diagnostic});
  }
  add(key, {entityId, eventId, text, options = {}, textContext, plain = false, start = performance.now(), permanent = false, range}) {
    this.remove(key);
    const node = document.createElement('div'); node.className = `overhead-text ${permanent ? 'event-label' : 'speech-popup'}`;
    const body = document.createElement('div'); node.append(body); this.root.append(node);
    if (options.width) node.style.width = `${options.width}px`;
    node.style.maxWidth = `${Math.min(600, options.width || 300)}px`;
    if (options.lineHeight) body.style.lineHeight = `${options.lineHeight}px`;
    let controller;
    if (plain) { body.textContent = text; body.style.fontSize = `${options.fontSize || 14}px`; if(options.fontName)body.style.fontFamily=options.fontName; }
    else controller = this.text(body, text, textContext, {fontSize:options.fontSize || 14, fontFace:options.fontName || this.defaults().fontFace});
    this.entries.set(key, {node, controller, entityId, eventId, options, start, permanent, range});
  }
  accept(snapshot) {
    const signature = scene(snapshot);
    if (this.scene !== signature) { this.clearMap(); this.scene = signature; }
    const keep = new Set();
    for (const entity of snapshot.events || []) {
      if (!entity.overhead?.text || entity.erased) continue;
      const key = `label:${entity.id}`, label = entity.overhead;
      const content = JSON.stringify([label, entity.textContext]); keep.add(key);
      if (this.entries.get(key)?.signature === content) continue;
      this.add(key, {entityId:entity.id, text:(label.quest ? '\\C[17]' : '')+label.text, textContext:label.textContext || entity.textContext,
        options:{fontSize:label.fontSize || 14, y:-(label.offsetY ?? 36)-18}, permanent:true, range:label.range ?? 5});
      this.entries.get(key).signature = content;
    }
    for (const player of snapshot.players || []) {
      const key = `chat:${player.id}`, bubble = player.chatBubble;
      if (!bubble || bubble.expiresAt <= snapshot.serverTime) continue;
      keep.add(key); const content = JSON.stringify(bubble);
      if (this.entries.get(key)?.signature === content) continue;
      const age = Math.max(0, snapshot.serverTime - bubble.createdAt);
      this.add(key, {entityId:player.id, text:bubble.text, plain:true,
        start:performance.now()-age,
        options:{...bubble, y:(bubble.y ?? -42)-28, fadeIn:bubble.fadeIn*60/1000, duration:bubble.duration*60/1000, fadeOut:bubble.fadeOut*60/1000}});
      this.entries.get(key).signature = content;
    }
    for (const key of [...this.entries.keys()]) if ((key.startsWith('label:') || key.startsWith('chat:')) && !keep.has(key)) this.remove(key);
  }
  popup(message) {
    if (message.mapId != null && this.scene !== undefined && !this.scene.endsWith(`:${message.mapId}`)) return;
    if (message.code === 'popupClear') {
      for (const [key, value] of this.entries) if (key.startsWith('popup:') && (message.eventId == null || value.eventId === message.eventId)) this.remove(key);
      return;
    }
    const params = this.config()?.popup || {};
    const options = {width:number(params['Popup Width'],200), x:number(params['Offset X'],0),
      y:number(params['Offset Y'],-50), duration:number(params['Display Duration'],200),
      fadeIn:number(params['Fade In Duration'],10), fadeOut:number(params['Fade Out Duration'],60),
      fontSize:number(params['Font Size'],12), fontName:params['Font Name'], lineHeight:number(params['Line Height'],18), ...message.options};
    this.add(`popup:${++this.sequence}`, {...message, options});
    if (this.entries.size > 200) this.remove([...this.entries.keys()].find(key => key.startsWith('popup:')));
  }
  showGab(message) {
    this.gabController?.destroy(); this.gabController = null; this.gab.hidden = true; this.gabMessage = null;
    if (message.action === 'clear') return;
    this.gabMessage = message; this.gabStart = performance.now(); this.gab.hidden = false;
    this.gab.style.top = `${Math.max(0, message.y ?? 72)}px`; this.gab.style.opacity = '1';
    this.gabController = this.text(this.gabText, message.text, message.textContext, {fontSize:message.fontSize || 28, fontFace:message.fontName || this.defaults().fontFace});
    this.portrait.hidden = !message.graphicName && !message.appearance;
    if (message.soundName) this.sound('se', {name:message.soundName, volume:90, pitch:100});
  }
  drawGabPortrait(message, time) {
    if (this.portrait.hidden) return;
    const ctx = this.portrait.getContext('2d'); ctx.clearRect(0,0,144,144); ctx.imageSmoothingEnabled = false;
    const sprite = message.graphicType === 'character' || message.graphicType === 'sprite';
    if (message.appearance) { this.renderer.appearances.preview(this.portrait, message.appearance, sprite ? 'walk' : 'face', time); return; }
    const image = this.renderer.images.get(sprite ? 'img/characters' : 'img/faces', message.graphicName);
    if (!image?.ready) return;
    const index = message.graphicIndex || 0;
    const f = sprite ? characterFrame(message.graphicName, index, [0,1,2,1][Math.floor(time/180)%4], 2, image.width, image.height) : {sx:index%4*image.width/4, sy:Math.floor(index/4)*image.height/2, sw:image.width/4, sh:image.height/2};
    const scale = Math.min(144/f.sw, 144/f.sh, sprite ? 2 : 1);
    ctx.drawImage(image,f.sx,f.sy,f.sw,f.sh,(144-f.sw*scale)/2,(144-f.sh*scale)/2,f.sw*scale,f.sh*scale);
  }
  animate(time) {
    this.frame = requestAnimationFrame(this.animate);
    const self = this.renderer.entities.get(this.renderer.snapshot.playerId);
    for (const [key, entry] of this.entries) {
      const entity = resolveFloatingEntity(this.renderer, entry);
      const opacity = entry.permanent ? 1 : popupOpacity(time-entry.start, entry.options);
      if (!entry.permanent && opacity <= 0 && time > entry.start+frames(entry.options.fadeIn)) { this.remove(key); continue; }
      entry.node.hidden = scene(this.renderer.snapshot) !== this.scene || !entity || entity.erased || !overheadInRange(entity,self,entry.range);
      if (!entity) continue;
      const pos = overheadPosition(entity, this.renderer.camera, this.renderer.zoom, entry.options);
      entry.node.style.left = `${pos.x}px`; entry.node.style.top = `${pos.y}px`; entry.node.style.opacity = String(opacity);
    }
    if (this.gabMessage) {
      const message = this.gabMessage, elapsed = time-this.gabStart;
      this.gab.style.opacity = String(popupOpacity(elapsed, {fadeIn:0,duration:message.durationFrames ?? 180,fadeOut:message.fadeFrames ?? 16}));
      if (elapsed >= frames((message.durationFrames ?? 180)+(message.fadeFrames ?? 16))) this.showGab({action:'clear'});
      else this.drawGabPortrait(message,time);
    }
  }
  destroy() { cancelAnimationFrame(this.frame); this.clear(); }
}
