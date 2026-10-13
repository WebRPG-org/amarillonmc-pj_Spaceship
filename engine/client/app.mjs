import { Renderer, assetUrl } from './renderer.mjs';
import { snapshotPreview } from './tile-format.mjs';
import { zoneView, withCommandContext } from './protocol.mjs';
import { AppearanceEditor } from './appearance.mjs';
import { PointerGesture, pointerCommand, weaponDetails } from './pointer.mjs';
import { parseRichText, renderRichText, richTextDefaults, applyMessageLayout, loadCustomFonts } from './rich-text.mjs';
import { FloatingTextLayer } from './floating-text.mjs';
import { createChatUI } from './chat.mjs';

const $ = id => document.getElementById(id);
const renderer = new Renderer($('world'));
renderer.portraitCanvas = $('player-portrait');
const pointer = new PointerGesture();
const state = { content: null, snapshot: null, mapId: null, preview: true, socket: null,
  token: sessionStorage.getItem('spaceship-token'), maps: new Map(), seq: 0, panel: null,
  reconnect: 0, reconnectTimer: null, sound: false, bgm: null, loading: 0, sessionGeneration: 0, ready: false, keys: new Set(), pendingDialogue: null };
const requestId = () => crypto.randomUUID();
const textDefaults = () => richTextDefaults(state.content?.textConfig || {});
const textContext = extra => ({database:{...state.content?.database, MapInfos:Object.fromEntries((state.content?.maps || []).map(map => [map.id,map]))},
  inventory:state.snapshot?.self?.inventory || [], gold:state.snapshot?.self?.gold || 0,
  currencyUnit:state.content?.database?.System?.currencyUnit || 'G', mapId:state.mapId, ...extra});
const cleanText = text => parseRichText(String(text ?? ''), textContext(), textDefaults()).plainText;
function textDiagnostic(message) { state.textDiagnostics ||= new Set(); state.textDiagnostics.add(typeof message === 'string' ? message : JSON.stringify(message)); }
const floatingText = new FloatingTextLayer({root:$('floating-text'), gab:$('gab-window'), portrait:$('gab-portrait'), gabText:$('gab-text'),
  renderer, context:textContext, defaults:textDefaults, config:() => state.content?.textConfig, sound:playAudio, diagnostic:textDiagnostic});
const chat = createChatUI({mount:$('chat-mount'), send,
  onFocusChange:focused => {if (focused) {state.keys.clear(); cancelNavigation();}},
  canFocus:() => $('welcome').hidden && !state.panel && !state.pendingDialogue && !state.preview});

function node(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }

function notice(message, level = 'info') {
  const item = node('li'), time = node('time', '', new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }));
  item.append(time, document.createTextNode(message)); $('activity-log').prepend(item);
  while ($('activity-log').children.length > 35) $('activity-log').lastElementChild.remove();
  const toast = node('div', `toast ${level === 'error' ? 'error' : ''}`, message);
  $('toast-stack').append(toast); setTimeout(() => toast.remove(), 4200);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options); let result;
  try { result = await response.json(); } catch { throw new Error(`服务返回了非 JSON 响应（HTTP ${response.status}）`); }
  if (!response.ok || result.error) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message || `请求失败（HTTP ${response.status}）`);
  return result;
}

function send(message) {
  if (state.preview) { notice('当前为内容预览。登录后可测试联网玩法。'); return false; }
  if (!state.ready || state.socket?.readyState !== WebSocket.OPEN) { notice('世界状态尚未同步，操作未发送。', 'error'); return false; }
  state.socket.send(JSON.stringify(withCommandContext(message, state.snapshot))); return true;
}

async function loadMap(id, preview = state.preview) {
  const generation = ++state.loading, sessionGeneration = state.sessionGeneration;
  state.loadingTarget=Number(id);
  $('map-loading').hidden = false;
  try {
    if (!state.maps.has(id)) state.maps.set(id, await fetchJson(`/api/maps/${id}`));
    if (generation !== state.loading || sessionGeneration !== state.sessionGeneration) return;
    const map = state.maps.get(id), entry = state.content.maps.find(m => Number(m.id) === Number(id));
    state.mapId = Number(id);
    renderer.setMap(map, state.content.database.Tilesets?.[map.tilesetId], state.content.database, state.content.threeD);
    $('map-name').textContent = `${entry?.name || `地图 ${id}`} · ${map.width} × ${map.height}`;
    $('map-select').value = String(id);
    if (preview) { state.snapshot = snapshotPreview(map, Number(id)); renderer.accept(state.snapshot); floatingText.accept(state.snapshot); }
    else if (state.snapshot?.mapId === Number(id)) renderer.accept(state.snapshot);
    for(const message of state.threeDCommands||[])if(Number(message.mapId)===Number(id))renderer.threeDCommand(message);
    state.threeDCommands=[];
    $('three-d-controls').hidden = !renderer.threeD.enabled;
    if (map.autoplayBgm && map.bgm?.name) playAudio('bgm', map.bgm);
  } catch (error) { notice(`地图载入失败：${error.message}`, 'error'); }
  finally { if (generation === state.loading) {state.loadingTarget=null;$('map-loading').hidden = true;} }
}

function setConnection(label, online = false) {
  $('connection-label').textContent = label;
  $('status-dot').classList.toggle('online', online);
}

function showSession() {
  $('welcome').hidden = true;
  $('mode-badge').textContent = state.preview ? '内容预览 · 不运行世界模拟' : '在线世界 · 服务端权威状态';
  $('session-description').textContent = state.preview ? '预览地图与素材。登录后进入在线世界。' : '打开菜单时，世界与网络仍持续运行。';
  $('travel-hint').textContent = state.preview ? '方向键移动预览视角。事件仅显示默认页面。' : '开发测试入口：由服务器执行地图传送。';
  $('travel-button').textContent = state.preview ? '预览所选地图' : '测试传送至所选地图';
  $('travel-button').disabled = !state.preview && !state.ready;
  $('logout-button').hidden = false;
  $('logout-button').textContent = state.preview ? '返回登录' : '退出账号';
  $('world').focus();
}

function scheduleReconnect(message = '连接中断') {
  const delay = Math.min(15000, 1000 * 2 ** state.reconnect++);
  notice(`${message}，${Math.round(delay / 1000)} 秒后自动重连。`, 'error');
  clearTimeout(state.reconnectTimer); state.reconnectTimer = setTimeout(connect, delay);
}

async function connect() {
  clearTimeout(state.reconnectTimer);
  if (!state.token) return;
  const token = state.token;
  state.sessionGeneration++; state.ready = false; state.keys.clear(); state.requestedMap = null;
  const generation = state.sessionGeneration;
  $('player-hud').hidden = true;
  state.preview = false;
  showSession(); setConnection(state.reconnect ? '正在重新连接' : '连接世界中');
  // An HTTP 401 WebSocket upgrade is exposed only as close code 1006 in browsers.
  // Validate explicitly so an expired or lost token does not retry forever.
  try {
    const response = await fetch('/api/session', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    // Finish the body too, so the timeout cannot abort an otherwise successful probe.
    await response.text();
    if (state.token !== token || generation !== state.sessionGeneration) return;
    if (response.status === 401) { logout(); $('login-error').textContent = '登录已失效或服务已重启，请重新登录。'; return; }
    if (!response.ok) throw new Error(response.status === 503 ? '数据库暂不可用' : `服务暂不可用（${response.status}）`);
  } catch (error) {
    if (state.token !== token || generation !== state.sessionGeneration) return;
    setConnection('等待服务恢复'); scheduleReconnect(error.message || '服务暂不可用'); return;
  }
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?token=${encodeURIComponent(token)}`);
  state.socket = ws;
  ws.onopen = () => { if (state.socket !== ws) return; setConnection('同步世界状态中'); };
  ws.onmessage = event => {
    if (state.socket !== ws) return;
    let message;
    try { message = JSON.parse(event.data); } catch { notice('收到无法读取的服务器消息。', 'error'); return; }
    if (message.type === 'snapshot') {
      if (!state.ready) { state.ready = true; state.reconnect = 0; setConnection('世界已连接', true); }
      const changedWorld = (state.snapshot?.instance?.id || null) !== (message.instance?.id || null);
      if (changedWorld) { state.keys.clear(); pointer.cancel(); closeDialogue(); floatingText.clear(); state.threeDCommands=[]; state.maintainedFont = state.messageSound = null; renderer.resetPresentation(); renderer.entities.clear(); }
      const changed = changedWorld || state.snapshot?.mapId !== message.mapId;
      if (changed) { pointer.cancel(); state.shop=null; if(state.panel==='shop')closePanel(); }
      state.snapshot = message;
      floatingText.accept(message); chat.updateSnapshot(message); chat.setAvailable(true);
      if (changed || state.mapId !== message.mapId) {
        if (state.requestedMap !== message.mapId) { state.requestedMap = message.mapId; loadMap(message.mapId, false).finally(() => { if (state.requestedMap === message.mapId) state.requestedMap = null; }); }
      } else renderer.accept(message);
      updateHud();
    } else if (message.type === 'effect') renderer.effect(message);
    else if (message.type === 'dialogue') showDialogue(message);
    else if (message.type === 'chat') chat.receive(message);
    else if (message.type === 'gab') floatingText.showGab(message);
    else if (message.type === 'audio') playAudio(message.kind, message.audio);
    else if (message.type === 'eventEffect') eventEffect(message);
    else if (message.type === 'threeD') {
      if(state.loadingTarget!=null||Number(message.mapId)!==Number(renderer.map?.id)){
        (state.threeDCommands||=[]).push(message);if(state.threeDCommands.length>100)state.threeDCommands.shift();
      }else{renderer.threeDCommand(message);$('three-d-controls').hidden=!renderer.threeD.enabled;}
    }
    else if (message.type === 'openCrafting') openPanel('craft');
    else if (message.type === 'service') receiveService(message);
    else if (message.type === 'shop') { state.shop = message; openPanel('shop'); }
    else if (message.type === 'records') { state.records = message.records; openPanel('records'); }
    else if (message.type === 'instanceResult') { state.instanceResult = message.result; openPanel('result'); }
    else if (message.type === 'notice' || message.type === 'error') notice(message.message || message.error || '服务器通知', message.level || (message.type === 'error' ? 'error' : 'info'));
  };
  ws.onclose = event => {
    if (state.socket !== ws || state.preview || !state.token) return;
    setConnection('连接已中断'); state.keys.clear(); pointer.cancel(); state.ready = false; closeDialogue(); floatingText.clear(); chat.setAvailable(false);
    if ([1008, 4001, 4003, 4401].includes(event.code)) { logout(); $('login-error').textContent = '登录已失效，请重新登录。'; return; }
    scheduleReconnect();
  };
  ws.onerror = () => { if (state.socket === ws) setConnection('连接失败'); };
}

async function authenticate(mode) {
  if (!$('login-form').reportValidity()) return;
  $('login-error').textContent = ''; $('login-button').disabled = $('register-button').disabled = true;
  try {
    const result = await fetchJson('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, username: $('username').value.trim(), password: $('password').value }) });
    state.token = result.token; sessionStorage.setItem('spaceship-token', state.token); $('password').value = ''; connect();
  } catch (error) { $('login-error').textContent = error.message; }
  finally { $('login-button').disabled = $('register-button').disabled = false; }
}

function logout() {
  state.threeDCommands=[];
  clearTimeout(state.reconnectTimer); state.sessionGeneration++; state.ready = false; state.reconnect = 0; state.keys.clear(); state.preview = true; state.token = null; state.snapshot = null;
  sessionStorage.removeItem('spaceship-token'); const socket = state.socket; state.socket = null; socket?.close();
  $('welcome').hidden = false; $('player-hud').hidden = $('death-overlay').hidden = $('dev-section').hidden = true;
  $('logout-button').hidden = true; closePanel(); closeDialogue(); setConnection('未连接');
  state.instanceService = null; state.instanceResult = null; state.records=null; state.shop=null;
  state.maintainedFont = state.messageSound = null;
  renderer.resetPresentation(); floatingText.clear(); chat.setAvailable(false); chat.clear?.(); updateHud();
  if (state.mapId) loadMap(state.mapId, true);
}

function itemData(kind, id) { return state.content?.database?.[{ item: 'Items', weapon: 'Weapons', armor: 'Armors' }[kind] || 'Items']?.[id]; }
function itemName(kind, id) { return itemData(kind, id)?.name || `${kind || '物品'} #${id}`; }
function me() { return state.snapshot?.players?.find(p => p.id === state.snapshot.playerId); }

function updateHud() {
  const player = me(), self = state.snapshot?.self || {};
  updateInstanceHud();
  $('player-hud').hidden = !player; $('death-overlay').hidden = !player?.dead;
  $('dev-section').hidden = !state.snapshot?.devTools || state.preview || Boolean(state.snapshot?.instance);
  $('respawn-button').textContent = state.snapshot?.instance ? '结束行动并返回世界' : '返回重生点';
  $('travel-button').disabled = !state.preview && (!state.snapshot?.devTools || Boolean(state.snapshot?.instance));
  const behavior = self.offlineBehavior || self.profile?.offlineBehavior || 'stay';
  $('offline-behavior').disabled = state.preview || !state.ready;
  if (document.activeElement !== $('offline-behavior')) $('offline-behavior').value = behavior;
  $('offline-policy').textContent = {stay:'原地停留，仍会受到伤害。',evade:'远离附近威胁，优先离开禁区。',search:'搜寻附近物资；遇到危险先躲避。',hunt:'主动追击可见敌对目标，仍消耗弹药、耐久与 MP。'}[behavior] || '';
  const zone = zoneView(state.snapshot?.zone, state.snapshot?.serverTime);
  $('zone-badge').hidden = !zone.visible;
  if (zone.visible) {
    $('zone-badge').textContent = state.snapshot.zone.message || (zone.active ? `本地图已进入禁区${zone.seconds === null ? '' : ` · ${zone.seconds} 秒`}` : `禁区预警 · ${zone.seconds} 秒后生效`);
  }
  if (player) {
    $('player-name').textContent = player.name; $('player-level').textContent = `Lv.${player.level || 1}`;
    for (const stat of ['hp', 'mp']) { const max = player[stat === 'hp' ? 'maxHp' : 'maxMp'] || 0;
      $(`${stat}-bar`).style.width = `${Math.max(0, Math.min(100, (player[stat] || 0) / (max || 1) * 100))}%`;
      $(`${stat}-text`).textContent = `${player[stat] || 0} / ${max}`;
    }
    $('coordinates').textContent = `X ${Math.round(player.x)} · Y ${Math.round(player.y)} · ${state.snapshot.players.length} 人 · TICK ${state.snapshot.tick}`;
  }
  const skillSignature = JSON.stringify(self.skills || []);
  if (state.skillSignature !== skillSignature) {
    state.skillSignature = skillSignature; const selected = $('skill-select').value;
    $('skill-select').replaceChildren(new Option('普通攻击', ''));
    for (const id of self.skills || []) { const skill = state.content.database.Skills?.[id]; if (skill) $('skill-select').add(new Option(`${skill.name} · MP ${skill.mpCost || 0}`, String(id))); }
    if ([...$('skill-select').options].some(o => o.value === selected)) $('skill-select').value = selected;
  }
  const equippedWeapon = self.inventory?.find(i => i.kind === 'weapon' && (self.equips?.weaponInstanceId ? i.instanceId === self.equips.weaponInstanceId : i.itemId === self.equips?.weapon));
  const weaponInfo = weaponDetails(equippedWeapon, state.content.weaponProfiles?.[self.equips?.weapon], self.inventory, id => itemName('item', id));
  $('equipment-summary').textContent = `武器：${self.equips?.weapon ? itemName('weapon', self.equips.weapon) : '未装备'}${weaponInfo ? `\n${weaponInfo}` : ''}\n防具：${self.equips?.armor ? itemName('armor', self.equips.armor) : '未装备'} · 金币 ${self.gold || 0}`;
  const signature = JSON.stringify([self.inventory, self.equips, self.gold, self.profile, state.snapshot?.drops, player?.x, player?.y]);
  if (signature !== state.inventorySignature) {
    state.inventorySignature = signature;
    if (state.panel === 'inventory') renderInventory();
    if (state.panel === 'craft') renderCraft();
    if (state.panel === 'shop') renderShop();
    if (state.panel === 'titles') renderTitles();
  }
}

function openPanel(kind) {
  state.appearanceEditor?.dispose(); state.appearanceEditor = null;
  if (!state.content) { notice('内容仍在载入，请稍候。'); return; }
  cancelNavigation(); state.panel = kind; state.keys.clear(); $('panel-overlay').hidden = false;
  $('panel-title').textContent = { inventory: '随身背包', craft: '合成工作台', report: '内容兼容报告', appearance: '角色外观', instance: '副本大厅', result: '行动结算',shop:'商店',titles:'饰品与头衔',records:'行动档案' }[kind];
  $('panel-eyebrow').textContent = { inventory: 'FIELD KIT', craft: 'CRAFTING', report: 'CONTENT INSPECTOR', appearance: 'CHARACTER CREATOR', instance: 'EXPEDITION', result: 'MISSION REPORT',shop:'SUPPLIES',titles:'COLLECTION',records:'EXPEDITION ARCHIVE' }[kind];
  $('close-panel').focus();
  if (kind === 'inventory') renderInventory(); if (kind === 'craft') renderCraft(); if (kind === 'report') renderReport();
  if (kind === 'appearance') renderAppearance(); if (kind === 'instance') renderInstance(); if (kind === 'result') renderInstanceResult();
  if (kind === 'shop') renderShop(); if (kind === 'titles') renderTitles(); if (kind === 'records') renderRecords();
}
function closePanel() { state.appearanceEditor?.dispose(); state.appearanceEditor = null; state.panel = null; $('panel-overlay').hidden = true; $('world').focus(); }
function iconFor(item) {
  const icon = node('span', 'item-icon'); const index = item?.iconIndex || 0;
  icon.style.backgroundPosition = `-${index % 16 * 32}px -${Math.floor(index / 16) * 32}px`; return icon;
}

function renderInventory() {
  const root = $('panel-content'); root.replaceChildren();
  if (state.preview) { root.append(node('p', 'empty-state', '内容预览不包含角色背包。登录进入世界后可拾取、装备和使用物品。')); return; }
  const self = state.snapshot?.self || {}, inventory = self.inventory || [];
  const toolbar=node('div','inventory-toolbar'),sort=node('button','secondary','整理背包'); sort.onclick=()=>send({type:'inventory',action:'sort'}); toolbar.append(node('p','',`持有金币：${self.gold || 0} G · ${inventory.length} 种物品`),sort); root.append(toolbar);
  if (!inventory.length) root.append(node('p', 'empty-state', '背包是空的。靠近掉落物按 E 拾取，或使用开发测试物品。'));
  for (const entry of inventory) {
    const data = itemData(entry.kind, entry.itemId), row = node('div', 'item-row'), description = node('div', 'item-description');
    description.append(node('strong', '', data?.name || itemName(entry.kind, entry.itemId)), node('span', 'quantity', ` ×${entry.quantity}`), node('p', '', cleanText(data?.description || '')));
    if (entry.kind === 'weapon') {
      const detail = weaponDetails(entry, state.content.weaponProfiles?.[entry.itemId], inventory, id => itemName('item', id));
      if (detail) description.append(node('p', 'weapon-details', detail));
    }
    row.append(iconFor(data), description);
    const equipment = entry.kind === 'weapon' || entry.kind === 'armor';
    const equipped = self.equips?.[entry.kind] === entry.itemId && (entry.kind !== 'weapon' || !self.equips.weaponInstanceId || self.equips.weaponInstanceId === entry.instanceId);
    if (equipment || data?.consumable || data?.effects?.length) {
      const button = node('button', '', equipment ? equipped ? '已装备' : '装备' : '使用'); button.disabled = equipped;
      button.onclick = () => send(equipment ? { type: 'equip', kind: entry.kind, itemId: entry.itemId, ...(entry.instanceId ? {instanceId: entry.instanceId} : {}) } : { type: 'useItem', itemId: entry.itemId, requestId: requestId() }); row.append(button);
    }
    const dropControls=node('div','inventory-drop-controls'),quantity=node('input'),dropButton=node('button','secondary','丢弃');
    quantity.type='number';quantity.min='1';quantity.max=String(entry.quantity);quantity.step='1';quantity.value='1';quantity.setAttribute('aria-label',`丢弃${data?.name||entry.kind}的数量`);
    dropButton.onclick=()=>{const count=Number(quantity.value);if(!Number.isInteger(count)||count<1||count>entry.quantity){notice('请输入背包数量范围内的整数。','error');return;}send({type:'inventory',action:'drop',kind:entry.kind,itemId:entry.itemId,...(entry.instanceId?{instanceId:entry.instanceId}:{}),quantity:count,requestId:requestId()});};
    dropControls.append(quantity,dropButton);row.append(dropControls);root.append(row);
  }
  const player = me();
  if (player) {
    const nearby = (state.snapshot.drops || []).filter(d => Math.hypot(d.x - player.x, d.y - player.y) <= 2);
    if (nearby.length) root.append(node('h3', 'report-section-title', '附近掉落'));
    for (const drop of nearby) {
      const row = node('div', 'item-row'), text = node('div', 'item-description'), button = node('button', '', drop.kind==='bag'?'整包拾取':'拾取');
      text.append(node('strong','',drop.kind==='bag'?`${drop.metadata?.ownerName||'探索者'}的遗落背包`:drop.kind==='gold'?`金币 ×${drop.quantity}`:`${itemName(drop.kind, drop.itemId)} ×${drop.quantity}`));
      if(drop.kind==='bag') text.append(node('p','',(drop.metadata?.items||[]).map(i=>`${itemName(i.kind,i.itemId)} ×${i.quantity}`).join('、')||'空背包'));
      button.onclick = () => send({ type: 'pickup', entityId: drop.id, requestId: requestId() }); row.append(text, button); root.append(row);
    }
  }
}

function renderCraft() {
  const root = $('panel-content'); root.replaceChildren();
  for (const recipe of state.content?.recipes || []) {
    const result = recipe.result || recipe.output || {}, inputs = recipe.ingredients || recipe.inputs || [];
    const row = node('div', 'item-row'), description = node('div', 'item-description');
    const count=i=>(state.snapshot?.self?.inventory||[]).filter(x=>x.kind===i.kind&&x.itemId===i.itemId).reduce((n,x)=>n+x.quantity,0);
    const needed=i=>i.amount??i.quantity??1;
    description.append(node('strong', '', recipe.name || itemName(result.kind, result.itemId)), node('p', '', inputs.map(i => `${itemName(i.kind, i.itemId)} ${count(i)}/${needed(i)}${count(i)<needed(i)?' · 缺料':''}`).join(' ＋ ')), node('p', '', `产出：${itemName(result.kind, result.itemId)} ×${result.amount ?? result.quantity ?? 1}`),node('p','hint',cleanText(itemData(result.kind,result.itemId)?.description||'')));
    const bookMissing=recipe.books?.length&&!recipe.books.some(id=>keyCount(id)>0);
    if(bookMissing)description.append(node('p','hint','需要持有对应配方书。'));
    const button = node('button', '', '合成'); button.disabled = state.preview||bookMissing||inputs.some(i=>count(i)<needed(i));
    button.onclick = () => send({ type: 'craft', recipeId: recipe.id, requestId: requestId() }); row.append(iconFor(itemData(result.kind, result.itemId)), description, button); root.append(row);
  }
  if (!root.children.length) root.append(node('p', 'empty-state', '当前内容包尚未定义合成配方。'));
}

function renderShop() {
  const root=$('panel-content'),shop=state.shop?.shop,self=state.snapshot?.self||{};root.replaceChildren();
  if(!shop){root.append(node('p','empty-state','请靠近商店，与店员交互。'));return;}
  root.append(node('h3','',shop.name),node('p','',`持有金币：${self.gold||0} G${state.snapshot?.instance?' · 本局金币':''}`),node('p','hint','买卖均按所示单价结算。出售只接受本店经营的物品。'));
  const tradeRow=(goods,entry)=>{
    const selling=!!entry,price=selling?Math.floor(goods.price*shop.sellRate):goods.price;
    const row=node('div','item-row'),description=node('div','item-description'),data=itemData(goods.kind,goods.itemId);
    description.append(node('strong','',data?.name||itemName(goods.kind,goods.itemId)),node('p','',`${price} G / 件${selling?` · 持有 ${entry.quantity}`:''}`),node('p','hint',cleanText(data?.description||'')));
    const controls=node('div','inventory-drop-controls'),quantity=node('input'),button=node('button',selling?'secondary':'',selling?'出售':'购买');
    const maximum=selling?(entry.kind==='weapon'?1:entry.quantity):price?Math.min(999,Math.floor((self.gold||0)/price)):999;
    quantity.type='number';quantity.min='1';quantity.max=String(maximum);quantity.step='1';quantity.value='1';quantity.setAttribute('aria-label',`${selling?'出售':'购买'}${data?.name||''}数量`);button.disabled=maximum<1;
    button.onclick=()=>{const count=Number(quantity.value);if(!Number.isInteger(count)||count<1||count>maximum){notice('数量超出可交易范围。','error');return;}send({type:'shop',action:selling?'sell':'buy',shopId:shop.id,eventId:state.shop.eventId,kind:goods.kind,itemId:goods.itemId,quantity:count,...(entry?.instanceId?{instanceId:entry.instanceId}:{}),requestId:requestId()});};
    controls.append(quantity,button);row.append(iconFor(data),description,controls);return row;
  };
  root.append(node('h3','report-section-title','购买'));
  for(const goods of shop.goods)root.append(tradeRow(goods));
  if(!shop.buyOnly){root.append(node('h3','report-section-title','出售'));let count=0;
    for(const entry of self.inventory||[]){const goods=shop.goods.find(g=>g.kind===entry.kind&&g.itemId===entry.itemId);if(goods){root.append(tradeRow(goods,entry));count++;}}
    if(!count)root.append(node('p','empty-state','背包里没有本店收购的物品。'));
  }
}

function renderTitles() {
  const root=$('panel-content'),profile=state.snapshot?.self?.profile||{},inRound=!!state.snapshot?.instance;root.replaceChildren();
  if(state.preview){root.append(node('p','empty-state','登录后可查看收藏与装备头衔。'));return;}
  root.append(node('p','',`饰品／头衔栏：${state.content.gameplay?.titles?.[profile.equippedTitle]?.name||'未装备'}`),node('p','hint',inRound?'本次出发效果已确定，回到主世界后可以更换头衔。':'装备后，在允许该头衔的下一次副本入场时获得对应效果。'));
  for(const [id,title]of Object.entries(state.content.gameplay?.titles||{})){
    const owned=profile.titles?.includes(id),equipped=profile.equippedTitle===id,row=node('div','item-row'),description=node('div','item-description'),button=node('button',equipped?'secondary':'',owned?equipped?'卸下':'装备':'尚未获得');
    description.append(node('strong','',title.name),node('p','',title.description));
    if(!owned&&id==='meteor')description.append(node('p','hint','完成「飞火流星 · 废城回收」，带着档案磁盘从入口撤离。'));
    button.disabled=!owned||inRound;button.onclick=()=>send({type:'title',titleId:equipped?null:id});row.append(iconFor(itemData('weapon',title.weaponId)),description,button);root.append(row);
  }
}

function renderRecords() {
  const root=$('panel-content');root.replaceChildren();
  root.append(node('p','hint','最近 30 次行动。个人撤离与整局结果分别保留，永久奖励以结算记录为准。'));
  if(!state.records){root.append(node('p','empty-state','正在读取行动档案…'));return;}
  const names={completed:'行动完成',escaped:'成功撤离',dead:'行动中倒下',failed:'行动失败',left:'主动退出',aborted:'行动中止'};
  for(const record of state.records){
    const result=record.result||{},personal=record.personalResult||{},participant=result.participants?.find(p=>p.id===state.snapshot?.playerId),outcome=personal.outcome||participant?.outcome||record.status;
    const row=node('div','item-row'),description=node('div','item-description'),date=new Date(record.endedAt||record.createdAt);
    description.append(node('strong','',result.name||record.metadata?.name||state.content.scenarios?.[record.definitionId]?.name||record.definitionId),node('p','',`${names[outcome]||outcome} · ${Number.isNaN(date.getTime())?'':date.toLocaleString('zh-CN')}`));
    if(result.durationSeconds!=null)description.append(node('p','hint',`行动时长 ${countdown(result.durationSeconds)}`));
    const reward=result.rewardsByPlayer?.[state.snapshot?.playerId];if(reward?.titleId)description.append(node('p','',`头衔：${state.content.gameplay?.titles?.[reward.titleId]?.name||reward.titleId}`));
    row.append(description);root.append(row);
  }
  if(!state.records.length)root.append(node('p','empty-state','尚无行动记录。前往榆风广场的远征接引员开始探索。'));
}

function renderReport() {
  const root = $('panel-content'); root.replaceChildren(); const coverage = state.content.coverage || {};
  const stats = node('div', 'report-stats');
  for (const [number, title] of [[state.content.maps.length, '张地图已索引'], [Object.values(state.content.database).filter(Array.isArray).reduce((sum, a) => sum + a.filter(Boolean).length, 0), '条数据库定义'], [renderer.images.missing.size, '项预览资源缺失']]) {
    const stat = node('div', 'report-stat'); stat.append(node('strong', '', String(number)), node('span', '', title)); stats.append(stat);
  }
  root.append(stats, node('p', '', '使用新的地图渲染、客户端与服务端；未加载原 RPG Maker 运行时或旧插件。内容可读取不代表所有插件行为均已实现。'));
  root.append(node('h3', 'report-section-title', '渲染支持'), node('p', '', 'MV/MZ 标准 48 px 图块：A1 水面与瀑布动画、A2 地板与桌沿、A3/A4 墙面、A5 与 B–E 普通图块、四层地图、阴影、星标遮挡、区域 ID、$ / ! 人物切片、MV 帧动画与 MZ Effekseer 特效。插件专用素材布局仍需单独适配。'));
  if (renderer.images.missing.size) root.append(node('h3', 'report-section-title', '本次预览资源缺失'), node('pre', 'report-pre', [...renderer.images.missing].join('\n')));
  if (state.unhandledEffects?.size) root.append(node('h3', 'report-section-title', '未适配的事件表现命令'), node('pre', 'report-pre', [...state.unhandledEffects].join(', ')));
  if (state.textDiagnostics?.size) root.append(node('h3', 'report-section-title', '文字控制符诊断'), node('pre', 'report-pre', [...state.textDiagnostics].join('\n')));
  root.append(node('h3', 'report-section-title', '导入器检查结果'), node('pre', 'report-pre', JSON.stringify(coverage, null, 2)));
  if (renderer.map) root.append(node('h3', 'report-section-title', '当前地图'), node('pre', 'report-pre', JSON.stringify({ mapId: state.mapId, tilesetId: renderer.map.tilesetId, width: renderer.map.width, height: renderer.map.height, events: renderer.map.events.filter(Boolean).length, scrollType: renderer.map.scrollType }, null, 2)));
}

function closeDialogue() {
  state.dialogueController?.destroy(); state.dialogueController = null;
  for (const controller of state.choiceControllers || []) controller.destroy(); state.choiceControllers = [];
  state.pendingDialogue = null; state.dialogueLayout = null; state.dialogueOptions = []; $('dialogue').hidden = true; $('dialogue').querySelector('.dialogue-gold')?.remove();
}
function textTargetPosition(target, context) {
  const ownActor = context.party?.[0]?.id ?? context.party?.[0];
  const local = target.kind === 'player' || target.kind === 'event' && target.id <= 0 || target.kind === 'actor' && (target.id === 0 || target.id === ownActor) || target.kind === 'party' && target.id <= 1;
  const entity = local ? renderer.entities.get(state.snapshot?.playerId) : [...renderer.entities.values()].find(e => target.kind === 'event' && e.eventId === target.id);
  if (!entity) return null;
  return renderer.entityScreenPoint(entity,{y:-48});
}
function showDialogue(message) {
  if (message.close) { closeDialogue(); return; }
  closeDialogue(); cancelNavigation(); state.pendingDialogue = message; state.keys.clear(); $('dialogue').hidden = false;
  const configuredDefaults = textDefaults();
  const context = textContext(message.textContext), defaults = {...configuredDefaults, ...message.messageSettings,resetLetterSound:configuredDefaults.letterSound};
  if (defaults.maintainFont && state.maintainedFont) Object.assign(defaults,state.maintainedFont);
  const resetSounds = String(state.content?.textConfig?.extended1?.['Reset Sounds']).toLowerCase() === 'true';
  const soundSignature = JSON.stringify([defaults.letterSound,message.messageSettings?.letterSoundRevision || 0]);
  if (resetSounds) defaults.letterSound = configuredDefaults.letterSound;
  else if (state.messageSound && state.messageSoundSignature === soundSignature) defaults.letterSound = state.messageSound;
  state.messageSoundSignature = soundSignature;
  const parsed = parseRichText(Array.isArray(message.text) ? message.text.join('\n') : message.text || '', context, defaults);
  state.messageSound = parsed.finalSound;
  if (defaults.maintainFont) state.maintainedFont = {fontFace:parsed.finalStyle.fontFace,fontSize:parsed.finalStyle.fontSize};
  const settings = message.messageSettings || {};
  const meta = {faceName:settings.faceName,faceIndex:settings.faceIndex,background:settings.background,position:settings.positionType,
    width:settings.width,rows:settings.rows,x:settings.x,y:settings.y,anchorX:settings.anchorX,anchorY:settings.anchorY,...parsed.meta};
  $('dialogue').removeAttribute('style'); $('dialogue').dataset.background = String(meta.background ?? 0);
  state.dialogueLayout = {meta,context};
  $('dialogue-speaker').textContent = message.speaker || '事件';
  applyMessageLayout($('dialogue'), meta, {speakerElement:$('dialogue-speaker'),faceElement:$('dialogue-face'),resolveTarget:target => textTargetPosition(target,context)});
  if (!parsed.meta.name) $('dialogue-speaker').textContent = message.speaker || '';
  const choices = $('dialogue-choices'); choices.replaceChildren();
  choices.style.maxHeight = `${Math.max(1,Math.min(12,settings.choiceRowMax || 6))*48}px`;
  const advance = node('button', '', '继续'); choices.append(advance);
  advance.onclick = () => {if (state.dialogueController?.advance()) return; if (!message.choices?.length && send({type:'dialogue',choice:null})) closeDialogue();};
  const optionButtons = [];
  (message.choices || []).forEach((text, i) => {
    const metadata = message.choiceMetadata?.find(c => c.index === i) || {};
    if (metadata.hidden) return;
    const button = node('button'); button.disabled = true;
    state.choiceControllers.push(renderRichText(button, parseRichText(text,context,defaults), {instant:true,onDiagnostic:textDiagnostic}));
    button.onclick = () => {if (state.dialogueController?.done && send({type:'dialogue',choice:i})) closeDialogue();};
    choices.append(button); optionButtons.push({button,disabled:metadata.disabled,index:i});
  });
  state.dialogueOptions = optionButtons;
  state.dialogueController = renderRichText($('dialogue-text'), parsed, {context,defaults,
    onDiagnostic:textDiagnostic, onSound:audio => playAudio('se',typeof audio === 'string' ? {name:audio} : audio),
    onGold:() => {let gold = $('dialogue').querySelector('.dialogue-gold'); if (!gold) {$('dialogue').append(gold=node('div','dialogue-gold'));} gold.textContent = `${context.gold} ${context.currencyUnit}`;},
    onComplete:() => queueMicrotask(() => {
      if (state.pendingDialogue !== message) return;
      for (const {button,disabled} of optionButtons) button.disabled = !!disabled;
      advance.hidden = Boolean(message.choices?.length);
      const selected = optionButtons.find(option => option.index === message.defaultChoice && !option.disabled);
      selected?.button.focus({preventScroll:true});
      if (parsed.meta.autoClose && !message.choices?.length && send({type:'dialogue',choice:null})) closeDialogue();
    })});
}

function attack() { cancelNavigation(); const id = Number($('skill-select').value); send({ type: 'attack', requestId: requestId(), ...(id > 0 ? { skillId: id } : {}) }); }
function interact() {
  cancelNavigation();
  const player = me(); if (!player) { send({type:'interact'}); return; }
  const delta={2:[0,1],4:[-1,0],6:[1,0],8:[0,-1]}[player.direction]||[0,1];
  const facing=state.snapshot.events?.find(e=>!e.erased&&!e.enemyId&&e.x===player.x+delta[0]&&e.y===player.y+delta[1]);
  if(facing){send({type:'interact',targetId:facing.id});return;}
  const distance=d=>Math.abs(d.x-player.x)+Math.abs(d.y-player.y);
  const near=[...(state.snapshot.drops||[])].filter(d=>distance(d)<=1.5).sort((a,b)=>distance(a)-distance(b))[0];
  if(near)send({type:'pickup',entityId:near.id,requestId:requestId()});else send({type:'interact'});
}

function playAudio(kind, data) {
  if (!data?.name || !state.sound) return;
  const audio = new Audio(assetUrl(`audio/${kind}`, data.name, 'ogg'));
  audio.volume = Math.min(1, Math.max(0, (data.volume ?? 70) / 100 * .5)); audio.playbackRate = (data.pitch || 100) / 100;
  if (kind === 'se' && Number.isFinite(data.pan) && data.pan !== 0) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      state.audioContext ||= new AudioContextClass(); state.audioContext.resume().catch(() => {});
      const source = state.audioContext.createMediaElementSource(audio), panner = state.audioContext.createStereoPanner();
      panner.pan.value = Math.max(-1,Math.min(1,data.pan/100)); source.connect(panner); panner.connect(state.audioContext.destination);
      audio.onended = () => {source.disconnect(); panner.disconnect();};
    }
  }
  if (kind === 'bgm' || kind === 'bgs') { const key = kind; state[key]?.pause(); state[key] = audio; audio.loop = true; }
  audio.onerror = () => { if (!audio.src.endsWith('.m4a')) { audio.src = assetUrl(`audio/${kind}`, data.name, 'm4a'); audio.play().catch(() => {}); } };
  audio.play().catch(() => {});
}

function eventEffect(message) {
  const p = message.parameters || [];
  if (message.code === 'popup' || message.code === 'popupClear') { floatingText.popup(message); return; }
  if (message.code === 212 || message.code === 213) {
    const target = p[0] === -1 ? me() : state.snapshot?.events?.find(e => e.eventId === (p[0] || message.eventId));
    if (!target) return;
    if (message.code === 212) renderer.effect({ kind: 'attack', animationId: p[1], x: target.x, y: target.y });
    else renderer.effect({ kind: 'balloon', balloonId: p[1], x: target.x, y: target.y });
    return;
  }
  const audioKinds = { 241: 'bgm', 245: 'bgs', 249: 'me', 250: 'se' };
  if (audioKinds[message.code]) { playAudio(audioKinds[message.code], p[0]); return; }
  if (message.code === 242 || message.code === 246) { state[message.code === 242 ? 'bgm' : 'bgs']?.pause(); return; }
  if ([221, 222, 223, 224, 225, 231, 232, 233, 235].includes(message.code)) {
    if ((message.code === 231 || message.code === 232) && p[3] !== 0) {
      notice(`事件 ${message.eventId} 的图片使用变量坐标，需要导入器转换为具体坐标。`); return;
    }
    renderer.presentation(message.code, p); return;
  }
  state.unhandledEffects ||= new Set();
  if (!state.unhandledEffects.has(message.code)) {
    state.unhandledEffects.add(message.code); notice(`事件表现命令 ${message.code} 尚未适配，已记录到兼容报告。`);
  }
}

$('login-form').onsubmit = event => { event.preventDefault(); authenticate('login'); };
$('register-button').onclick = () => authenticate('register');
$('preview-button').onclick = async () => {
  if (!state.content) return;
  state.sessionGeneration++; state.ready = false; state.keys.clear();
  state.preview = true; showSession(); setConnection('内容预览');
  await loadMap(Number($('map-select').value || state.content.maps[0]?.id));
  notice('正在预览原始地图。方向键平移视角，右侧可切换地图。');
};
$('logout-button').onclick = logout;
$('attack-button').onclick = attack; $('interact-button').onclick = interact;
$('instance-button').onclick = () => openPanel('instance');
$('titles-button').onclick = () => openPanel('titles');
$('records-button').onclick = () => { if(send({type:'records'})){state.records=null;openPanel('records');} };
$('inventory-button').onclick = () => openPanel('inventory'); $('craft-button').onclick = () => openPanel('craft');
$('report-button').onclick = () => openPanel('report'); $('close-panel').onclick = closePanel;
$('panel-overlay').onclick = event => { if (event.target === $('panel-overlay')) closePanel(); };
$('travel-button').onclick = () => {
  const id = Number($('map-select').value); closeDialogue();
  if (state.preview) loadMap(id); else send({ type: 'travel', mapId: id });
};
$('grid-toggle').onchange = event => { renderer.showGrid = event.target.checked; };
$('region-toggle').onchange = event => { renderer.showRegions = event.target.checked; };
for (const button of document.querySelectorAll('[data-dev]')) button.onclick = () => send({ type: 'dev', action: button.dataset.dev });
$('respawn-button').onclick = () => send(state.snapshot?.instance ? { type: 'instance', action: 'leave' } : { type: 'respawn' });
function zoom(value) { renderer.zoom = Math.min(2, Math.max(.5, value)); $('zoom-label').textContent = `${Math.round(renderer.zoom * 100)}%`; }
$('zoom-out').onclick = () => zoom(renderer.zoom - .25); $('zoom-in').onclick = () => zoom(renderer.zoom + .25);
for(const button of document.querySelectorAll('[data-orbit]'))button.onclick=()=>{
  const [yaw,pitch]=button.dataset.orbit.split(',').map(Number);renderer.threeD.orbit(yaw,pitch);
};
$('sound-button').onclick = () => {
  state.sound = !state.sound; $('sound-button').textContent = `声音：${state.sound ? '开' : '关'}`;
  if (!state.sound) { state.bgm?.pause(); state.bgs?.pause(); }
  else if (renderer.map?.autoplayBgm) playAudio('bgm', renderer.map.bgm);
};
$('offline-behavior').onchange = event => send({type: 'offlineBehavior', behavior: event.target.value});
$('world').addEventListener('effectaudio', event => playAudio('se', event.detail));
function cancelNavigation() {
  pointer.cancel(); state.lastPointerCommand = null;
  if (!state.preview && state.ready && state.socket?.readyState === WebSocket.OPEN) send({type: 'navigate', cancel: true});
}
function cancelOrMenu() {
  cancelNavigation(); state.keys.clear();
  if (state.pendingDialogue) {
    // The event interpreter decides whether this choice allows cancellation.
    if (state.pendingDialogue.choices?.length) send({type: 'dialogue', choice: -1});
  } else if (state.panel) closePanel();
  else if ($('welcome').hidden) openPanel('inventory');
}
function navigatePointer(clientX, clientY, {held = false} = {}) {
  if (state.panel || !$('welcome').hidden || !renderer.map) return;
  if (state.pendingDialogue) {
    if (!held && !state.pendingDialogue.choices?.length) $('dialogue-choices').firstElementChild?.click();
    return;
  }
  const point = renderer.screenToMap(clientX, clientY);
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
  if (point.x < 0 || point.y < 0 || point.x >= renderer.map.width || point.y >= renderer.map.height) return;
  if (state.preview) {renderer.viewCenter = {x: point.x - .5, y: point.y - .5}; return;}
  if (!state.ready || me()?.dead) return;
  const message = pointerCommand(point, state.snapshot, {skillId: Number($('skill-select').value), requestId: requestId()});
  const signature = JSON.stringify({...message, requestId: null});
  if (held && signature === state.lastPointerCommand) return;
  state.lastPointerCommand = signature; state.keys.clear();
  if (send(message)) {
    const marker = $('destination-marker');
    marker.dataset.x = String(message.x); marker.dataset.y = String(message.y);
    marker.hidden = false; marker.classList.toggle('attack-target', !!(message.targetPlayerId || state.snapshot.events?.find(e => e.id === message.targetId && e.enemyId)));
    state.markerUntil = performance.now() + 1800;
  }
}
const canvas = $('world');
canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 && event.button !== 2) return;
  event.preventDefault(); canvas.focus();
  const result = pointer.down(event);
  if (result?.kind === 'cancel') {const blocked = pointer.blocked; cancelOrMenu(); if (blocked) pointer.blocked = true; return;}
  canvas.setPointerCapture?.(event.pointerId); state.pointerHeldAt = performance.now();
});
canvas.addEventListener('pointermove', event => pointer.move(event));
canvas.addEventListener('pointerup', event => {
  const result = pointer.up(event);
  if (result?.kind === 'navigate') navigatePointer(result.x, result.y);
  if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
});
canvas.addEventListener('pointercancel', () => cancelNavigation());
canvas.addEventListener('contextmenu', event => event.preventDefault());
$('panel-overlay').addEventListener('contextmenu', event => {event.preventDefault(); cancelOrMenu();});
const panelTouches = new Set();
$('panel-overlay').addEventListener('pointerdown', event => {
  if (event.pointerType !== 'touch') return;
  panelTouches.add(event.pointerId);
  if (panelTouches.size > 1) {event.preventDefault(); panelTouches.clear(); cancelOrMenu();}
});
window.addEventListener('pointerup', event => panelTouches.delete(event.pointerId));
window.addEventListener('pointercancel', event => panelTouches.delete(event.pointerId));
setInterval(() => {
  const held = pointer.held();
  if (held && performance.now() - state.pointerHeldAt > 180) navigatePointer(held.x, held.y, {held: true});
}, 200);
function drawDestinationMarker() {
  const marker = $('destination-marker'), nav = state.snapshot?.self?.navigation;
  if (nav && !state.panel && !state.preview) {marker.dataset.x = String(nav.x); marker.dataset.y = String(nav.y); marker.hidden = false;}
  else if (performance.now() > (state.markerUntil || 0)) marker.hidden = true;
  if (!marker.hidden) {
    const pos=renderer.screenPoint(Number(marker.dataset.x)+.5,Number(marker.dataset.y)+.5);
    marker.style.left = `${pos.x}px`;
    marker.style.top = `${pos.y}px`;
  }
  if (state.dialogueLayout?.meta.target) {
    const {meta,context} = state.dialogueLayout, pos = textTargetPosition(meta.target,context);
    if (pos) { $('dialogue').style.left = `${pos.x}px`; $('dialogue').style.top = `${pos.y}px`; }
  }
  requestAnimationFrame(drawDestinationMarker);
}
requestAnimationFrame(drawDestinationMarker);
const directions = { KeyW: 8, ArrowUp: 8, KeyS: 2, ArrowDown: 2, KeyA: 4, ArrowLeft: 4, KeyD: 6, ArrowRight: 6 };
window.addEventListener('keydown', event => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || !$('welcome').hidden) return;
  if (event.target.tagName === 'BUTTON' && ['Space','Enter'].includes(event.code)) return;
  if (event.code === 'Escape') { event.preventDefault(); if (!event.repeat) cancelOrMenu(); return; }
  if (event.code === 'Tab') { event.preventDefault(); if (state.panel) closePanel(); else openPanel('inventory'); return; }
  if (state.panel) return;
  if (state.pendingDialogue) {
    if (!event.repeat && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.code) && state.dialogueController?.done) {
      const options = state.dialogueOptions.filter(option => !option.disabled), selected = options.findIndex(option => option.button === document.activeElement);
      const next = options[(selected+(['ArrowUp','ArrowLeft'].includes(event.code)?-1:1)+options.length)%options.length];
      event.preventDefault(); next?.button.focus({preventScroll:true});
    } else if ((event.code === 'Enter' || event.code === 'KeyE') && !event.repeat && !state.dialogueController?.done) $('dialogue-choices').firstElementChild?.click();
    else if ((event.code === 'Enter' || event.code === 'KeyE') && !event.repeat && !state.pendingDialogue.choices?.length) $('dialogue-choices').firstElementChild?.click();
    return;
  }
  if (directions[event.code]) { event.preventDefault(); if(!event.repeat)cancelNavigation(); state.keys.delete(event.code); state.keys.add(event.code); if(!event.repeat)moveFromKeyboard(); }
  if ((event.code === 'KeyJ' || event.code === 'Space') && !event.repeat) { event.preventDefault(); attack(); }
  if (event.code === 'KeyE' && !event.repeat) { event.preventDefault(); interact(); }
});
window.addEventListener('keyup', event => state.keys.delete(event.code));
window.addEventListener('blur', () => {state.keys.clear(); cancelNavigation();});
document.addEventListener('visibilitychange', () => {state.keys.clear(); if(document.hidden)cancelNavigation();});
function moveFromKeyboard() {
  if (state.panel || state.pendingDialogue || !$('welcome').hidden) return;
  const key = [...state.keys].at(-1), inputDirection = directions[key]; if (!inputDirection) return;
  const direction=renderer.threeD.inputDirection(inputDirection);
  if (state.preview) {
    renderer.pan(direction === 6 ? .6 : direction === 4 ? -.6 : 0, direction === 2 ? .6 : direction === 8 ? -.6 : 0);
    $('coordinates').textContent = `预览 X ${Math.round(renderer.viewCenter?.x || 0)} · Y ${Math.round(renderer.viewCenter?.y || 0)}`;
  } else if (state.ready && state.socket?.readyState === WebSocket.OPEN && !me()?.dead) send({ type: 'move', direction, seq: ++state.seq });
}
setInterval(moveFromKeyboard, 150);

async function initialize() {
  try {
    state.content = await fetchJson('/api/content');
    loadCustomFonts(state.content.textConfig?.fonts || {}).then(results => {for (const font of results) if (font.error) textDiagnostic(`字体 ${font.filename}：${font.error}`);}).catch(error => textDiagnostic(`字体载入：${error.message}`));
    loadAppearanceCatalog().catch(() => {});
    $('map-select').replaceChildren(...state.content.maps.map(m => new Option(`${String(m.id).padStart(3, '0')} · ${m.name}`, String(m.id))));
    $('map-count').textContent = `${state.content.maps.length} 张`;
    const initial = state.content.database.System?.startMapId || state.content.maps[0]?.id;
    if (initial) await loadMap(initial, true);
    $('preview-button').disabled = $('login-button').disabled = $('register-button').disabled = false;
    if (state.token) connect();
  } catch (error) {
    $('login-error').textContent = `无法读取内容：${error.message}`;
    $('preview-button').disabled = $('login-button').disabled = $('register-button').disabled = true;
    setConnection('内容服务不可用');
  }
}
initialize();

async function loadAppearanceCatalog() {
  if (state.appearanceCatalog) return state.appearanceCatalog;
  if (!state.appearanceLoading) state.appearanceLoading = fetchJson('/api/appearance').then(catalog => {
    state.appearanceCatalog = catalog; renderer.appearances.setCatalog(catalog); return catalog;
  }).finally(() => { state.appearanceLoading = null; });
  return state.appearanceLoading;
}
async function renderAppearance() {
  const root = $('panel-content'); root.replaceChildren(node('p','empty-state','正在读取角色创建素材…'));
  try {
    const catalog = await loadAppearanceCatalog(); if (state.panel !== 'appearance') return;
    const current = me()?.appearance || state.snapshot?.self?.appearance || catalog.creator.defaults;
    state.appearanceEditor = new AppearanceEditor({ root, catalog, composer: renderer.appearances, current,
      onSave: appearance => send({ type: 'appearance', appearance }) });
  } catch (error) { if (state.panel === 'appearance') root.replaceChildren(node('p','empty-state',`外观素材暂不可用：${error.message}`)); }
}
function receiveService(message) {
  if (message.service === 'appearance') openPanel('appearance');
  else if (message.service === 'instance') { state.instanceService = message; openPanel('instance'); }
}
const phaseNames = { waiting:'准备出发',exploration:'探索与寻物',return:'磁盘已取得 · 返回入口',boss:'禁区推进 · Boss阶段',completed:'本局已结束' };
const modeName = mode => mode === 'pvpve' ? 'PvPvE · 竞争生存' : 'PvE · 合作探索';
const countdown = seconds => Number.isFinite(seconds) ? `${String(Math.floor(Math.max(0,seconds)/60)).padStart(2,'0')}:${String(Math.floor(Math.max(0,seconds)%60)).padStart(2,'0')}` : '--:--';
function keyCount(id) { return (state.snapshot?.self?.inventory || []).filter(i => i.kind === 'item' && i.itemId === id).reduce((n,i) => n+i.quantity,0); }
function instanceKeys(instance) { const ids=instance?.keyItems || state.instanceService?.scenario?.itemIds || {}; return {ordinary:keyCount(ids.ordinary),final:keyCount(ids.final),control:keyCount(ids.control)}; }
function updateInstanceHud() {
  const instance = state.snapshot?.instance;
  $('instance-section').hidden = !instance; $('world-services').hidden = !!instance;
  if (!instance) { if(state.instanceSignature && state.panel==='instance')renderInstance(); state.instanceSignature = null; return; }
  $('instance-mode').textContent = instance.mode === 'pvpve' ? 'PvPvE' : 'PvE';
  $('instance-phase').textContent = phaseNames[instance.phase] || instance.phase || instance.status;
  $('instance-countdown').textContent = countdown(instance.remainingSeconds);
  $('instance-objective').textContent = instance.finalExitUnlocked ? '终局出口已开启，请按提示撤离。' : instance.boss?.dead ? 'Boss已击败，寻找终局钥匙并前往终局出口。' : instance.boss?.spawned ? `Boss已出现 · 地图 ${instance.boss.mapId}。留意当前地图禁区。` : instance.ordinaryExitUnlocked ? '普通出口已解锁，可继续探索或个人撤离。' : '探索资源、寻找钥匙，面向箱子与装置按 E。';
  if(instance.type==='adventure'){$('instance-mode').textContent='单人冒险';$('instance-objective').textContent=instance.diskRecovered?'磁盘已回收，返回城郊撤离信标。':'穿过街区，前往市中心档案楼取回磁盘。户外红色预警出现后立即移开。';}
  const timer = document.getElementById('instance-panel-clock'); if(timer) timer.textContent = countdown(instance.remainingSeconds);
  const signature = JSON.stringify([instance.id,instance.mode,instance.status,instance.phase,instance.players,instance.boss,instance.ordinaryExitUnlocked,instance.finalExitUnlocked,instance.ordinaryZonesDisabled,instanceKeys(instance)]);
  if (state.instanceSignature !== signature) {state.instanceSignature=signature;if(state.panel==='instance')renderInstance();}
}
function statusCard(label,value) { const card=node('div','instance-stat'); card.append(node('span','',label),node('strong','',String(value))); return card; }
function renderInstance() {
  const root = $('panel-content'); root.replaceChildren(); const instance = state.snapshot?.instance;
  if (instance) {
    const intro=node('div','instance-intro');intro.append(node('h3','',instance.name||modeName(instance.mode)),node('p','hint',instance.type==='adventure'?'单人独立世界 · 菜单和断线均不暂停':modeName(instance.mode)));root.append(intro);
    const stats=node('div','instance-stats'),time=statusCard('本局剩余时间',countdown(instance.remainingSeconds));time.querySelector('strong').id='instance-panel-clock';stats.append(statusCard('当前阶段',phaseNames[instance.phase]||instance.status),time);root.append(stats);
    const keys=instanceKeys(instance),keyRow=node('div','instance-stats');keyRow.append(statusCard('普通出口钥匙',keys.ordinary),statusCard('控制装置钥匙',keys.control),statusCard('终局出口钥匙',keys.final));if(instance.type!=='adventure')root.append(keyRow);
    const objectives=node('ol','instance-objectives');
    for (const text of (instance.type==='adventure'?(instance.objectives||[]):[
      `普通出口：${instance.ordinaryExitUnlocked?'已解锁，可交互撤离':'寻找钥匙，前往普通出口解锁'}`,
      `普通禁区：${instance.ordinaryZonesDisabled?'已解除':'收集控制钥匙，与解除装置交互'}`,
      `Boss：${instance.boss?.dead?'已击败':instance.boss?.spawned?`已出现，位于地图 ${instance.boss.mapId}`:'在后续阶段出现'}`,
      `终局出口：${instance.finalExitUnlocked?'已开启':'使用终局钥匙开启，完成本局'}`
    ]))objectives.append(node('li','',text));root.append(objectives,node('h3','report-section-title','本局玩家'));
    for(const player of instance.players||[]){const row=node('div','instance-player');row.append(node('span','',`${player.name}${player.id===instance.ownerId?' · 房主':''}`),node('span','hint',player.result?'已结算':player.dead?'已倒下':player.connected===false?'离线 · 角色留场':'在线'));root.append(row);}
    const actions=node('div','panel-actions');
    if(instance.status==='waiting'&&instance.ownerId===state.snapshot?.playerId){const start=node('button','','开始副本');start.onclick=()=>send({type:'instance',action:'start'});actions.append(start);}
    const leave=node('button','secondary',instance.status==='waiting'?'离开准备区':'退出并返回世界');leave.onclick=()=>{if(send({type:'instance',action:'leave'}))closePanel();};actions.append(leave);root.append(actions);
    root.append(node('p','hint',instance.status==='waiting'?'房主启动后，世界将按本局时间推进。':'副本不会因菜单、断线或离线暂停。主动退出的结果由服务器结算。'));
    return;
  }
  if(!state.instanceService){root.append(node('p','empty-state','请在世界出生点附近找到远征接引员，面向 NPC 按 E 打开服务。'));return;}
  root.append(node('p','','每次DTS从校服、面包、矿泉水和LV1开始，局内背包与金币不带出。允许的头衔在入场时生效。单人冒险成功后可获得指定的永久奖励。'));
  const create=node('div','instance-create');
  for(const scenario of state.instanceService.scenarios||[state.instanceService.scenario])for(const mode of scenario.type==='adventure'?['pve']:['pve','pvpve']){
    const card=node('div','instance-mode-card'),button=node('button','',scenario.type==='adventure'?'开始准备单人冒险':`创建 ${mode==='pve'?'PvE':'PvPvE'} 副本`);button.onclick=()=>send({type:'instance',action:'create',mode,definitionId:scenario.id});card.append(node('strong','',scenario.name),node('p','hint',scenario.description||modeName(mode)),node('p','hint',`时限 ${Math.floor(scenario.durationSeconds/60)} 分钟 · 最多 ${scenario.maxPlayers} 人`),button);create.append(card);
  }
  root.append(create,node('h3','report-section-title','可加入的副本'));
  const rooms=state.instanceService.instances||[];
  if(!rooms.length)root.append(node('p','empty-state','暂时没有开放的副本，可以创建新的行动。'));
  for(const room of rooms){const row=node('div','item-row'),details=node('div','item-description'),count=Array.isArray(room.players)?room.players.length:room.players||0;details.append(node('strong','',modeName(room.mode)),node('p','',`${room.id} · ${count} 人 · ${room.status==='waiting'?'等待开始':room.status==='active'?'正在进行':'已结束'}`));const join=node('button','','加入');join.disabled=room.status==='ended';join.onclick=()=>send({type:'instance',action:'join',instanceId:room.id});row.append(details,join);root.append(row);}
  const refresh=node('button','secondary','刷新副本列表');refresh.onclick=()=>send({type:'instance',action:'list'});root.append(refresh);
}
function renderInstanceResult() {
  const result=state.instanceResult||{},root=$('panel-content');root.replaceChildren();
  const outcomes={escaped:'成功撤离',victory:'行动成功',completed:'行动完成',cleared:'完成终局',dead:'行动中倒下',death:'行动中倒下',defeated:'行动失败',abandoned:'主动离开',left:'已离开副本',timeout:'行动时间结束',failed:'行动结束'};
  root.append(node('div',`result-title ${['dead','death','defeated','failed'].includes(result.outcome)?'danger-text':''}`,outcomes[result.outcome]||result.outcome||'本局已结算'));
  if(result.reason){const reasonNames={'disk-extracted':'磁盘已安全送回，废城回收完成。','final-exit':'终局出口已开启，本局结束。','boss-exit':'封锁守卫被击败，终局出口已开启。','timeout':'行动时间耗尽。','server-shutdown':'服务器维护，本局已结算。','server-restarted':'服务器重启，本局已中止。','all-left':'所有玩家已离开本局。',escaped:'你通过普通出口安全撤离。',left:'你已主动退出本局。',dead:'角色死亡，本次行动结束。'};root.append(node('p','',reasonNames[result.reason]||result.reason));}
  root.append(node('p','hint',`副本 ${result.instanceId||''} · 物品与结果以服务器结算为准。`));
  if(result.durationSeconds!=null)root.append(node('p','',`行动时长 ${countdown(result.durationSeconds)}`));
  if(result.rewards?.titleId){const title=state.content.gameplay?.titles?.[result.rewards.titleId];root.append(node('h3','',`${result.rewards.newTitle?'获得永久头衔':'已拥有头衔'}：${title?.name||result.rewards.titleId}`),node('p','',title?.description||''),node('p','hint','回到主世界后，点击「饰品／头衔」装备。'));}
  if(result.rewards?.gold)root.append(node('p','',`获得主世界金币 ${result.rewards.gold}`));
  const back=node('button','','返回世界');back.onclick=()=>{if(state.snapshot?.instance)send({type:'instance',action:'leave'});closePanel();};root.append(back);
}
