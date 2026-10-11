import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import mysql from 'mysql2/promise';
import { WebSocket } from 'ws';
import { createApplication } from '../server/index.mjs';
import { MySqlStore } from '../server/persistence.mjs';
import { PUBLIC_CITY_MAPS, PUBLIC_CITY_SERVICES } from '../server/public-city.mjs';

const enabled = process.env.MYSQL_TEST === '1';
const self = message => message.players.find(player => player.id === message.playerId);
const quantity = (snapshot, kind, id) => snapshot.self.inventory.filter(item => item.kind === kind && item.itemId === id).reduce((sum, item) => sum + item.quantity, 0);

async function eventually(predicate, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  assert.fail(`Timed out: ${label}`);
}

async function connectSocket(base, token) {
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?token=${token}`);
  const messages = [];
  ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
  // Assertion helpers report protocol messages, never bearer tokens or credentials.
  ws.on('error', () => {});
  await once(ws, 'open');
  const client = {
    ws, messages,
    send(message) { ws.send(JSON.stringify(message)); },
    async wait(predicate, after = 0, timeout = 5000) {
      let match;
      try {
        await eventually(() => { match = messages.slice(after).find(predicate); return !!match; }, 'expected WebSocket message', timeout);
      } catch (error) {
        const latest = messages.findLast(message => message.type === 'snapshot');
        throw new Error(`${error.message}; observed=${JSON.stringify({ notices: messages.filter(message => message.type === 'notice').slice(-5), mapId: latest?.mapId, players: latest?.players, inventory: latest?.self?.inventory, drops: latest?.drops })}`, { cause: error });
      }
      return match;
    },
    async snapshot(predicate = () => true, after = 0, timeout) { return this.wait(message => message.type === 'snapshot' && predicate(message), after, timeout); },
    async close() {
      if (ws.readyState === WebSocket.CLOSED) return;
      const closed = once(ws, 'close');
      ws.close();
      await closed;
    }
  };
  await client.snapshot();
  return client;
}

function configuration(text) {
  return Object.fromEntries(text.split(/\r?\n/).filter(line => /^[A-Za-z_]+=/.test(line)).map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

test('HTTP + two WebSockets + real MySQL authoritative-world integration', { skip: !enabled, timeout: 90000 }, async t => {
  const env = configuration(await readFile(new URL('../.env', import.meta.url), 'utf8'));
  assert.equal(env.MYSQL_HOST, '127.0.0.1', 'Only the dedicated loopback MySQL may be tested.');
  assert.equal(env.MYSQL_PORT, '3317', 'Never connect this test to the existing MySQL57/default port.');
  const admin = configuration(await readFile(new URL('../.local/mysql-admin.cnf', import.meta.url), 'utf8'));
  assert.equal(admin.host, '127.0.0.1');
  assert.equal(admin.port, '3317');
  const schema = `spaceship_engine_test_${randomBytes(6).toString('hex')}`;
  const store = new MySqlStore({ host: admin.host, port: Number(admin.port), user: admin.user, password: admin.password, database: schema });
  const clients = [];
  let app, cleanup;
  try {
    // Random schema is created only for this run and is the only schema deleted.
    app = await createApplication({ store, devTools: true });
    assert.equal(app.databaseReady, true);
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const base = `http://127.0.0.1:${app.server.address().port}`;
    assert.notEqual(app.server.address().port, 8098);
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.database, 'ready');
    assert.equal(health.maps, 39 + PUBLIC_CITY_MAPS.length);
    const password = 'integration-fixture-password';
    const prefix = `e2e_${randomBytes(5).toString('hex')}`;
    async function session(mode, username) {
      const response = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, username, password }) });
      assert.equal(response.status, 200, `HTTP ${mode} should succeed.`);
      return response.json();
    }
    const attackerName = `${prefix}_a`, victimName = `${prefix}_b`;
    const attackerAccount = await session('register', attackerName);
    const victimAccount = await session('register', victimName);

    // Fixtures establish adjacent players in an existing authored PVP map.
    // A low-HP victim makes the real attack/death/drop path deterministic and fast.
    // Map 9 intentionally teleports players away after a one-second authored
    // parallel event, so the sustained combat fixture uses Rural (map 11).
    const mapId = 11, map = app.content.getMap(mapId);
    let origin;
    for (let y = 1; y < map.height - 1 && !origin; y++) {
      for (let x = 1; x < map.width - 3 && !origin; x++) {
        if ([x, x + 1, x + 2].every(cx => app.content.isPassable(mapId, cx, y, 6)) && !map.events.filter(Boolean).some(event => Math.abs(event.x - x) + Math.abs(event.y - y) < 5)) origin = { x, y };
      }
    }
    assert.ok(origin, 'PVP map must contain an unobstructed test corridor.');
    const defaults = app.world.defaultState();
    await store.savePlayer(attackerAccount.playerId, { ...defaults, mapId, ...origin, direction: 6, inventory: [{ kind: 'weapon', itemId: 1, quantity: 1 }], equips: { weapon: 1, armor: 0 }, skills: [1], gold: 23 });
    await store.savePlayer(victimAccount.playerId, { ...defaults, mapId, x: origin.x + 1, y: origin.y, direction: 4, hp: 1, inventory: [{ kind: 'item', itemId: 1, quantity: 3 }], equips: { weapon: 0, armor: 0 }, skills: [1], gold: 17 });
    let attacker = await connectSocket(base, attackerAccount.token); clients.push(attacker);
    let victim = await connectSocket(base, victimAccount.token); clients.push(victim);
    const first = await attacker.snapshot(snapshot => snapshot.players.some(player => player.id === victimAccount.playerId));

    await t.test('idle client continues receiving snapshots and peer movement (no UI-menu assertion)', async () => {
      const after = attacker.messages.length;
      victim.send({ type: 'move', direction: 6, seq: 1 });
      const moved = await attacker.snapshot(snapshot => snapshot.players.some(player => player.id === victimAccount.playerId && player.x === origin.x + 2), after);
      assert.equal(self(moved).x, origin.x);
      const continued = await attacker.snapshot(snapshot => snapshot.tick >= first.tick + 10, after);
      assert.ok(continued.serverTime > first.serverTime);
      assert.ok(attacker.messages.slice(after).filter(message => message.type === 'snapshot').length >= 3);
    });

    await t.test('client cannot assign coordinates, health, inventory or gold; replayed movement is ignored', async () => {
      const after = victim.messages.length;
      victim.send({ type: 'move', direction: 4, seq: 2, x: 99999, y: -100, mapId: 999, hp: 99999, gold: 99999, inventory: [{ kind: 'item', itemId: 1, quantity: 99999 }] });
      const accepted = await victim.snapshot(snapshot => self(snapshot).x === origin.x + 1, after);
      assert.equal(accepted.mapId, mapId);
      assert.equal(self(accepted).y, origin.y);
      assert.equal(self(accepted).hp, 1);
      assert.equal(accepted.self.gold, 17);
      assert.equal(quantity(accepted, 'item', 1), 3);
      victim.send({ type: 'state', x: 99999, hp: 99999, gold: 99999 });
      await victim.wait(message => message.type === 'notice' && /未知操作/.test(message.message), after);
      victim.send({ type: 'move', direction: 6, seq: 2 });
      victim.send({ type: 'attack', skillId: 999999, damage: 999999, targetId: attackerAccount.playerId });
      const later = await victim.snapshot(snapshot => snapshot.tick >= accepted.tick + 6, after);
      assert.equal(self(later).x, origin.x + 1);
      assert.equal(self(later).hp, 1);
      assert.equal(later.self.gold, 17);
      assert.equal(later.players.find(player => player.id === attackerAccount.playerId).hp, self(first).hp);
    });

    let deathDrop;
    await t.test('authorized attack causes shared death and atomic persistent inventory drops', async () => {
      const afterA = attacker.messages.length, afterB = victim.messages.length;
      attacker.send({ type: 'attack', skillId: 1 });
      const dead = await victim.snapshot(snapshot => self(snapshot).dead && snapshot.self.inventory.length === 0 && snapshot.drops.some(drop => drop.kind === 'bag' && drop.metadata.items.some(item => item.kind === 'item' && item.itemId === 1 && item.quantity === 3)), afterB);
      deathDrop = dead.drops.find(drop => drop.kind === 'bag');
      const observer = await attacker.snapshot(snapshot => snapshot.players.some(player => player.id === victimAccount.playerId && player.dead) && snapshot.drops.some(drop => drop.id === deathDrop.id), afterA);
      assert.equal(self(dead).hp, 0);
      assert.deepEqual(observer.drops.find(drop => drop.id === deathDrop.id).metadata.items, [{kind:'item',itemId:1,quantity:3}]);
      const durable = await store.loadPlayer(victimAccount.playerId);
      assert.equal(durable.state.dead, true);
      assert.equal(durable.state.hp, 0);
      assert.deepEqual(durable.state.inventory, []);
      assert.ok((await store.listDrops(mapId)).some(drop => drop.id === deathDrop.id));
    });

    await t.test('pickup is shared, persistent and idempotent over WebSocket retries', async () => {
      assert.ok(deathDrop, 'Death test must produce a real drop.');
      const afterA = attacker.messages.length, afterB = victim.messages.length;
      const command = { type: 'pickup', entityId: deathDrop.id, requestId: randomUUID() };
      attacker.send(command); attacker.send(command);
      const picked = await attacker.snapshot(snapshot => quantity(snapshot, 'item', 1) === 3 && !snapshot.drops.some(drop => drop.id === deathDrop.id), afterA);
      await victim.snapshot(snapshot => !snapshot.drops.some(drop => drop.id === deathDrop.id), afterB);
      attacker.send(command);
      const repeated = await attacker.snapshot(snapshot => snapshot.tick >= picked.tick + 6, afterA);
      assert.equal(quantity(repeated, 'item', 1), 3);
      assert.ok(!(await store.listDrops(mapId)).some(drop => drop.id === deathDrop.id));
      const durable = await store.loadPlayer(attackerAccount.playerId);
      assert.equal(durable.state.inventory.find(item => item.kind === 'item' && item.itemId === 1).quantity, 3);
    });

    await t.test('logout and HTTP login reconnect recover position, inventory and death state', async () => {
      const before = await attacker.snapshot(snapshot => quantity(snapshot, 'item', 1) === 3);
      await attacker.close(); await victim.close();
      await eventually(() => [...app.world.players.values()].every(p => !p._connected && !p._disconnecting), 'both disconnect saves finish while characters stay in world');
      const authenticatedA = await session('login', attackerName), authenticatedB = await session('login', victimName);
      assert.equal(authenticatedA.playerId, attackerAccount.playerId);
      attacker = await connectSocket(base, authenticatedA.token); clients.push(attacker);
      victim = await connectSocket(base, authenticatedB.token); clients.push(victim);
      const restoredA = await attacker.snapshot(snapshot => snapshot.players.length === 2);
      const restoredB = await victim.snapshot();
      assert.equal(restoredA.mapId, before.mapId);
      assert.equal(self(restoredA).x, self(before).x);
      assert.equal(self(restoredA).y, self(before).y);
      assert.equal(quantity(restoredA, 'item', 1), 3);
      assert.equal(restoredA.self.gold, 23);
      assert.equal(self(restoredB).dead, true);
      assert.equal(self(restoredB).hp, 0);
      assert.deepEqual(restoredB.self.inventory, []);
    });

    await t.test('all source maps load over HTTP; playable maps transfer and empty maps report no spawn', async () => {
      const publicContent = await (await fetch(`${base}/api/content`)).json();
      assert.equal(publicContent.maps.length, 39 + PUBLIC_CITY_MAPS.length);
      await Promise.all(publicContent.maps.map(async info => {
        const response = await fetch(`${base}/api/maps/${info.id}`);
        assert.equal(response.status, 200, `Map ${info.id} must load.`);
        const loaded = await response.json();
        assert.equal(loaded.width, info.width);
        assert.equal(loaded.height, info.height);
        assert.equal(loaded.data.length, loaded.width * loaded.height * 6);
        assert.ok(Array.isArray(loaded.events));
      }));
      assert.equal((await fetch(`${base}/api/maps/999999`)).status, 404);
      let transferred = 0, noSpawn = 0;
      for (const info of publicContent.maps) {
        const after = attacker.messages.length;
        attacker.send({ type: 'travel', mapId: info.id });
        if (app.content.findSpawn(info.id, 0, 0)) {
          const snapshot = await attacker.snapshot(message => message.mapId === info.id, after);
          assert.ok(Number.isInteger(self(snapshot).x) && Number.isInteger(self(snapshot).y));
          transferred++;
        } else {
          await attacker.wait(message => message.type === 'notice' && /没有可用出生点/.test(message.message), after);
          noSpawn++;
        }
      }
      assert.equal(transferred + noSpawn, 39 + PUBLIC_CITY_MAPS.length);
      t.diagnostic(`All ${publicContent.maps.length} map JSON files loaded; ${transferred} maps accepted server transfer; ${noSpawn} maps correctly reported no walkable spawn.`);
      assert.ok(!app.world.runtimeDiagnostics.has('tick'), 'World loop must not throw while visiting maps.');
    });

    await t.test('Effekseer runtime and effect assets are served with bounded paths and usable MIME types', async () => {
      const content = await (await fetch(`${base}/api/content`)).json();
      assert.equal(content.weaponProfiles[61].mode, 'throw');
      const wasm = await fetch(`${base}/client/vendor/effekseer/effekseer.wasm`, {headers:{Range:'bytes=0-3'}});
      assert.equal(wasm.status, 206);
      assert.equal(wasm.headers.get('content-type'), 'application/wasm');
      assert.deepEqual([...new Uint8Array(await wasm.arrayBuffer())], [0,97,115,109]);
      const effect = await fetch(`${base}/assets/effects/ArrowSpecial.efkefc`, {headers:{Range:'bytes=0-3'}});
      assert.equal(effect.status, 206);
      assert.equal(await effect.text(), 'EFKE');
      assert.equal((await fetch(`${base}/assets/effects/%2e%2e%2fdata%2fSystem.json`)).status, 403);
      assert.equal((await fetch(`${base}/assets/effects/Texture/Arrow.png`)).status, 200);
    });

    await t.test('creator, actor and offline profiles persist together; mouse NPC entry survives instance transitions', async () => {
      const catalog = await (await fetch(`${base}/api/appearance`)).json();
      const look = structuredClone(catalog.creator.defaults);
      look.pieces['Front Hair'].color = 2;
      let after = attacker.messages.length;
      attacker.send({type:'appearance',appearance:look});
      attacker.send({type:'offlineBehavior',behavior:'evade'});
      await attacker.snapshot(s => s.self.profile?.appearance?.pieces?.['Front Hair']?.color === 2 && s.self.offlineBehavior === 'evade', after);
      assert.deepEqual((await store.loadProfile(attackerAccount.playerId)).appearance.pieces, look.pieces);
      assert.equal((await store.loadProfile(attackerAccount.playerId)).offlineBehavior, 'evade');
      attacker.send({type:'offlineBehavior',behavior:'teleport'});
      await attacker.wait(m => m.type === 'notice' && /无效的离线/.test(m.message), after);
      assert.equal((await store.loadProfile(attackerAccount.playerId)).offlineBehavior, 'evade');
      attacker.send({type:'appearance',appearance:{kind:'creator',pieces:{Body:{id:'../../private',color:0}}}});
      await attacker.wait(m => m.type === 'notice' && /部件|身体|外观|选项/.test(m.message), after);
      assert.deepEqual((await store.loadProfile(attackerAccount.playerId)).appearance.pieces, look.pieces);

      // Place the fixture at the actual outside-world NPC, then use only the public protocol.
      const original = app.host.getPlayer(attackerAccount.playerId);
      const entrance = PUBLIC_CITY_SERVICES.instance;
      await app.world.transfer(original, entrance.mapId, entrance.x, entrance.y + 1);
      const outside = await store.loadPlayer(original.id);
      after = attacker.messages.length;
      attacker.send({type:'navigate',x:entrance.x,y:entrance.y,targetId:'service:instance-guide',contextInstanceId:null,requestId:randomUUID()});
      await attacker.wait(m => m.type === 'service' && m.service === 'instance', after);
      attacker.send({type:'instance',action:'create',mode:'pve',contextInstanceId:null});
      const joined = await attacker.snapshot(s => s.instance?.status === 'waiting' && !!s.self.profile?.appearance, after);
      const instanceId = joined.instance.id;
      assert.deepEqual(joined.self.profile.appearance.pieces, look.pieces);
      assert.equal(joined.self.offlineBehavior, 'evade');
      assert.equal(quantity(joined,'item',1),0,'Outside items must not enter the round');
      attacker.send({type:'instance',action:'start',contextInstanceId:instanceId});
      await attacker.snapshot(s => s.instance?.status === 'active', after);
      after = attacker.messages.length;
      attacker.send({type:'travel',mapId:1,contextInstanceId:instanceId});
      await attacker.wait(m => m.type === 'notice' && /正式副本/.test(m.message), after);

      await attacker.close();
      await eventually(() => !app.host.getPlayer(original.id)._connected, 'round character stays offline');
      attacker = await connectSocket(base, attackerAccount.token); clients.push(attacker);
      const rejoined = await attacker.snapshot(s => s.instance?.id === instanceId);
      assert.deepEqual(rejoined.self.profile.appearance.pieces, look.pieces);
      assert.equal(rejoined.self.offlineBehavior, 'evade');
      assert.equal(rejoined.self.offlineActivity, null, 'Reconnection cancels AI immediately');
      const actor = catalog.actors.at(-1);
      after = attacker.messages.length;
      attacker.send({type:'appearance',appearance:{kind:'actor',actorId:actor.id,characterName:'../../private'}});
      await attacker.snapshot(s => s.self.profile?.appearance?.actorId === actor.id, after);
      assert.equal((await store.loadProfile(original.id)).appearance.characterName, actor.characterName);
      assert.equal((await store.loadProfile(original.id)).offlineBehavior, 'evade');
      attacker.send({type:'instance',action:'leave',contextInstanceId:instanceId});
      const returned = await attacker.snapshot(s => !s.instance && s.mapId === entrance.mapId && s.self.profile?.appearance?.actorId === actor.id, after);
      assert.equal(returned.self.profile.appearance.actorId,actor.id);
      assert.equal(quantity(returned,'item',1),3);
      assert.equal(returned.self.gold,outside.state.gold);
      await eventually(() => !app.host.transitions.has(original.id), 'completed departure and prior-round settlement');
      after = attacker.messages.length;
      attacker.send({type:'instance',action:'create',mode:'pve',contextInstanceId:null});
      const second = await attacker.snapshot(s => s.instance?.status === 'waiting' && s.instance.id !== instanceId,after);
      attacker.send({type:'instance',action:'leave',contextInstanceId:instanceId});
      await attacker.wait(m => m.type === 'notice' && /世界|副本|过期|失效/.test(m.message),after);
      assert.equal(app.host.playerWorld(original.id),app.host.rounds.get(second.instance.id).world,'Late prior-round leave must not remove the new player');
      attacker.send({type:'instance',action:'leave',contextInstanceId:second.instance.id});
      await attacker.snapshot(s => !s.instance,after);
    });
  } finally {
    for (const client of clients) if (client.ws.readyState !== WebSocket.CLOSED) await client.close();
    if (app) { await eventually(() => [...app.host.players.values()].every(p => !p._connected && !p._disconnecting), 'final player saves finish'); await app.close(); }
    else await store.close();
    // The generated name is never read from a request, user setting, or test output.
    assert.match(schema, /^spaceship_engine_test_[0-9a-f]{12}$/);
    cleanup = await mysql.createConnection({ host: admin.host, port: Number(admin.port), user: admin.user, password: admin.password });
    try { await cleanup.query(`DROP DATABASE IF EXISTS \`${schema}\``); } finally { await cleanup.end(); }
  }
});
