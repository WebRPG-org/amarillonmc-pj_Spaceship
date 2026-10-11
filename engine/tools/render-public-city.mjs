import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {loadContent} from '../server/content.mjs';
import {World} from '../server/world.mjs';

// Actual client Renderer, authored flags, and server page selection. No map edits,
// database connection, persistent account, cosmetic filter, or image resampling.
const projectRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith('--')) throw new Error(`Unexpected argument: ${args[i]}`);
  const key = args[i].slice(2);
  options[key] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
}
if (options.help) {
  console.log('node engine/tools/render-public-city.mjs [--maps 40,43] [--points path.json] [--out directory]\n' +
    'Sample: --sample-root "absolute/sample project_en" --tileset-root "absolute/tileset" --maps 6,13\n' +
    'Optional: --viewport 816x624 --actor 1 --browser absolute/msedge.exe --playwright absolute/index.mjs\n' +
    'Points JSON: {"40":[{"label":"entry","x":20,"y":23,"direction":2},{"label":"landmark","x":20,"y":15}]}');
  process.exit(0);
}
const sourceRoot = options['sample-root'] ? path.resolve(options['sample-root']) : projectRoot;
const sample = sourceRoot !== projectRoot;
const tilesetRoot = options['tileset-root'] ? path.resolve(options['tileset-root']) : null;
const output = path.resolve(options.out || path.join(projectRoot, 'engine/.artifacts/public-city', sample ? 'samples' : ''));
const mapIds = String(options.maps || '40,41,42,43,44,45,46,47,48').split(',').map(Number);
if (mapIds.some(id => !Number.isInteger(id) || id < 1)) throw new Error('--maps must be a comma-separated list of positive IDs');
const [viewportWidth, viewportHeight] = String(options.viewport || '816x624').split('x').map(Number);
if (![viewportWidth, viewportHeight].every(n => Number.isInteger(n) && n > 0)) throw new Error('Invalid --viewport');
const pointOverrides = options.points ? JSON.parse(await fs.readFile(path.resolve(options.points), 'utf8')) : {};
await fs.mkdir(output, {recursive: true});
const content = await loadContent(sourceRoot);
const projectActors = JSON.parse(await fs.readFile(path.join(projectRoot, 'data/Actors.json'), 'utf8'));
const actorId = Number(options.actor || content.database.System.partyMembers?.[0] || 1);
const actor = content.database.Actors?.[actorId] || projectActors[actorId] || projectActors[1];
let bindServices = () => {};
if (!sample) {
  try { bindServices = (await import('../server/public-city.mjs')).bindPublicCityServices; }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
}
const world = new World({content, store: {listDrops: async () => []}, clock: () => 100000, random: () => .5,
  hooks: {onMapReady: map => bindServices(map)}});
const initialState = sample ? {switches: {}, variables: {}, selfSwitches: {}, inventory: [], skills: [], equips: {}, states: []} : world.defaultState();
const player = {...initialState, id: 'qa-actor', name: actor.name, characterName: actor.characterName, characterIndex: actor.characterIndex,
  direction: 2, _connected: true};
world.players.set(player.id, player);
const incoming = new Map();
for (const [sourceId, map] of content.maps) for (const event of map.events.filter(Boolean)) for (const page of event.pages || []) {
  for (const command of page.list || []) if (command.code === 201 && command.parameters?.[0] === 0) {
    const [, id, x, y, direction] = command.parameters;
    if (!incoming.has(id)) incoming.set(id, []);
    incoming.get(id).push({label: `entry-from-${sourceId}`, x, y, direction: direction || 2});
  }
}
function nearestFree(mapId, x, y) {
  const map = world.maps.get(mapId), raw = map.raw;
  const blocked = new Set([...map.events.values()].filter(e => {
    const page = world.events.pageFor(player, e, mapId);
    return page && !page.through && page.priorityType === 1 && (page.image?.characterName || page.image?.tileId);
  }).map(e => `${e.x},${e.y}`));
  const positions = [];
  for (let cy = 0; cy < raw.height; cy++) for (let cx = 0; cx < raw.width; cx++) {
    if (!blocked.has(`${cx},${cy}`) && [2, 4, 6, 8].some(d => content.isPassable(mapId, cx, cy, d))) positions.push({x: cx, y: cy});
  }
  positions.sort((a, b) => Math.abs(a.x - x) + Math.abs(a.y - y) - Math.abs(b.x - x) - Math.abs(b.y - y));
  return positions[0] || {x, y};
}
function pointsFor(id, map) {
  if (pointOverrides[id]?.length) return pointOverrides[id].map(p => ({direction: 2, ...p}));
  const system = content.database.System;
  const entry = system.startMapId === id ? {label: 'entry-spawn', x: system.startX, y: system.startY, direction: 2}
    : incoming.get(id)?.[0] || {label: 'entry', x: Math.floor(map.width / 2), y: map.height - 2, direction: 8};
  const runtime = world.maps.get(id);
  const services = [...runtime.events.values()].filter(e => e.service).map(e => ({label: e.service.kind, x: e.x, y: e.y + 1, direction: 8}));
  const named = map.events.filter(Boolean).filter(e => /导览|咨询|商店|前台|柜台|接待|公告|纪念|接引|调整|向导/.test(e.name)).slice(0, 2)
    .map(e => ({label: `event-${e.id}`, x: e.x, y: e.y + 1, direction: 8}));
  const key = services.length ? services : named.length ? named : [{label: 'landmark', x: Math.floor(map.width / 2), y: Math.floor(map.height / 2), direction: 8}];
  const views = [entry, ...key];
  return views.map(p => ({...p, ...nearestFree(id, p.x, p.y)}));
}
const payloads = [];
for (const id of mapIds) {
  const map = content.getMap(id);
  if (!map) throw new Error(`Map${String(id).padStart(3, '0')} is missing from ${sourceRoot}`);
  player.mapId = id;
  await world.ensureMap(id);
  const points = pointsFor(id, map);
  Object.assign(player, points[0]);
  const sourceHash = createHash('sha256').update(await fs.readFile(path.join(sourceRoot, `data/Map${String(id).padStart(3, '0')}.json`))).digest('hex');
  payloads.push({id, map, sourceHash, tileset: content.getTileset(id), snapshot: world.snapshot(player), points,
    name: content.mapInfos.find(info => info?.id === id)?.name || map.displayName});
}

const report = {sourceRoot, renderer: 'engine/client/renderer.mjs', snapshotSource: 'World.snapshot with initial personal switches',
  tilePixels: 48, fullMapPixelsPerTile: 24, overviewPixelsPerTile: 12, viewport: {width: viewportWidth, height: viewportHeight},
  actor: {id: actorId, characterName: actor.characterName, characterIndex: actor.characterIndex},
  limitations: ['Static renderer captures do not execute movement, transfers, dialogue, or time-dependent event commands.'],
  maps: [], missing: [], errors: []};
const failures = [];
const mime = {'.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm'};
function resolveInside(root, relative) {
  const file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(root + path.sep)) throw new Error('Invalid path');
  return file;
}
async function readFirst(files) {
  for (const file of files) { try { return await fs.readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  throw new Error('Missing resource');
}
const server = http.createServer(async (req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  try {
    if (url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><style>body{margin:0;background:#172120}canvas{display:block;image-rendering:pixelated}</style><canvas></canvas>'); return; }
    let files;
    if (url.startsWith('/output/')) files = [resolveInside(output, url.slice(8))];
    else if (url.startsWith('/client/')) files = [resolveInside(path.join(projectRoot, 'engine/client'), url.slice(8))];
    else if (url.startsWith('/assets/')) {
      const relative = url.slice(8);
      files = tilesetRoot && relative.startsWith('img/tilesets/') ? [resolveInside(tilesetRoot, relative.slice(13))]
        : [resolveInside(sourceRoot, relative), resolveInside(projectRoot, relative)];
    } else files = [resolveInside(projectRoot, url.slice(1))];
    res.setHeader('Content-Type', mime[path.extname(url)] || 'application/octet-stream');
    res.end(await readFirst(files));
  } catch (error) { failures.push({url, error: error.message}); res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  const playwright = options.playwright || process.env.PLAYWRIGHT_MODULE || 'C:/Users/mapodoufu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
  const {chromium} = await import(pathToFileURL(path.resolve(playwright)).href);
  browser = await chromium.launch({headless: true, executablePath: options.browser || process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  const page = await browser.newPage({viewport: {width: viewportWidth, height: viewportHeight}, deviceScaleFactor: 1});
  page.on('pageerror', error => { if (!report.errors.includes(error.message)) report.errors.push(error.message); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    const {Renderer} = await import('/engine/client/renderer.mjs');
    window.renderer = new Renderer(document.querySelector('canvas'));
  });
  async function capture(payload, point, full, filename) {
    const width = full ? payload.map.width * 24 : viewportWidth, height = full ? payload.map.height * 24 : viewportHeight;
    await page.setViewportSize({width, height});
    await page.evaluate(({payload, point, full, width, height}) => {
      const canvas = document.querySelector('canvas'); canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
      renderer.zoom = full ? .5 : 1;
      renderer.setMap(payload.map, payload.tileset, {});
      const snapshot = structuredClone(payload.snapshot);
      Object.assign(snapshot.players[0], {x: point.x, y: point.y, direction: point.direction || 2});
      renderer.accept(snapshot);
      for (const entity of [...snapshot.players, ...snapshot.events]) renderer.images.get('img/characters', (entity.image || entity).characterName);
    }, {payload, point, full, width, height});
    await page.waitForFunction(() => [...renderer.images.cache.values()].every(image => image.complete), null, {timeout: 15000});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.locator('canvas').screenshot({path: path.join(output, filename)});
    return page.evaluate(() => ({camera: {...renderer.camera}, missing: [...renderer.images.missing],
      visibleEntities: [...renderer.entities.values()].filter(e => !e.erased && e.x >= renderer.camera.x - 1 && e.y >= renderer.camera.y - 2 &&
        e.x < renderer.camera.x + renderer.canvas.width / renderer.zoom / 48 + 1 && e.y < renderer.camera.y + renderer.canvas.height / renderer.zoom / 48 + 1)
        .map(e => ({id: e.id, x: e.x, y: e.y, name: e.name})),
      resources: [...renderer.images.cache].map(([url, image]) => ({url, loaded: image.ready === true, width: image.naturalWidth, height: image.naturalHeight}))}));
  }
  for (const payload of payloads) {
    const base = `Map${String(payload.id).padStart(3, '0')}`;
    const summary = {id: payload.id, name: payload.name, sourceHash: payload.sourceHash, tilesetId: payload.map.tilesetId, width: payload.map.width, height: payload.map.height,
      totalEvents: payload.snapshot.events.length, activeEvents: payload.snapshot.events.filter(e => !e.erased).length, views: []};
    const fullFile = `${base}-full.png`;
    const full = await capture(payload, payload.points[0], true, fullFile);
    Object.assign(summary, {full: fullFile, missing: full.missing, resources: full.resources});
    for (const [index, point] of payload.points.entries()) {
      const filename = `${base}-${String(index + 1).padStart(2, '0')}-${point.label.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`;
      const view = await capture(payload, point, false, filename);
      summary.views.push({file: filename, point, camera: view.camera, visibleEntities: view.visibleEntities});
      summary.missing.push(...view.missing);
    }
    summary.missing = [...new Set(summary.missing)];
    report.maps.push(summary);
    console.log(`${base} ${payload.name}: ${payload.map.width}x${payload.map.height}, ${summary.views.length} views, ${summary.missing.length} missing`);
  }
  const columns = Math.min(3, payloads.length), padding = 20;
  const cellWidth = Math.max(350, ...payloads.map(p => p.map.width * 12)) + padding;
  const cellHeight = Math.max(...payloads.map(p => p.map.height * 12)) + 50;
  const sheetWidth = columns * cellWidth + padding, sheetHeight = Math.ceil(payloads.length / columns) * cellHeight + 76;
  await page.setViewportSize({width: sheetWidth, height: sheetHeight});
  await page.evaluate(async ({maps, columns, cellWidth, cellHeight, sheetWidth, sheetHeight, sample}) => {
    document.body.innerHTML = `<canvas width="${sheetWidth}" height="${sheetHeight}"></canvas>`;
    const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#172120'; ctx.fillRect(0, 0, sheetWidth, sheetHeight); ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#eee'; ctx.font = 'bold 22px "Microsoft YaHei",sans-serif';
    ctx.fillText(sample ? '素材 Sample / 实际客户端 Renderer' : '现代公共城区 / 实际客户端 Renderer', 20, 31);
    ctx.font = '14px "Microsoft YaHei",sans-serif'; ctx.fillStyle = '#bbc8c2';
    ctx.fillText('统一比例：12 px / 格；完整单图：24 px / 格；玩家视口：48 px / 格', 20, 54);
    for (const [i, map] of maps.entries()) {
      const x = 20 + i % columns * cellWidth, y = 80 + Math.floor(i / columns) * cellHeight;
      ctx.fillStyle = '#eee'; ctx.font = '15px "Microsoft YaHei",sans-serif';
      ctx.fillText(`${map.id} ${map.name} · ${map.width}×${map.height}`, x, y);
      const image = new Image(); image.src = `/output/${map.full}`; await image.decode();
      ctx.drawImage(image, x, y + 14, map.width * 12, map.height * 12);
    }
  }, {maps: report.maps, columns, cellWidth, cellHeight, sheetWidth, sheetHeight, sample});
  await page.locator('canvas').screenshot({path: path.join(output, 'overview.png')});
} catch (error) {
  report.errors.push(error.stack || error.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  report.missing = [...new Set(report.maps.flatMap(map => map.missing))];
  report.failedRequests = failures;
  await fs.writeFile(path.join(output, 'render-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({output, maps: report.maps.length, missing: report.missing, errors: report.errors, failedRequests: failures}));
  if (report.errors.length || report.missing.length || failures.length) process.exitCode = 1;
}
