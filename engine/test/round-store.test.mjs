import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { MySqlStore } from '../server/persistence.mjs';

const enabled = process.env.MYSQL_TEST === '1';
const parse = text => Object.fromEntries(text.split(/\r?\n/).filter(line => /^[a-zA-Z_]+=/.test(line)).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
const inventoryCount = (state, kind, id) => (state.inventory ?? []).filter(item => item.kind === kind && item.itemId === id).reduce((sum, item) => sum + item.quantity, 0);
const addBag = (state, drop) => {
  for (const stack of drop.metadata.items) {
    const item = state.inventory.find(item => item.kind === stack.kind && item.itemId === stack.itemId);
    if (item) item.quantity += stack.quantity;
    else state.inventory.push({ ...stack });
  }
  return { picked: drop.id, stacks: drop.metadata.items.length };
};

test('MySQL round isolation, atomic whole bags, permanent profiles and restart recovery', { skip: !enabled, timeout: 30000 }, async t => {
  const config = parse(await readFile(new URL('../.local/mysql-admin.cnf', import.meta.url), 'utf8'));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, '3317', 'Do not access the existing MySQL57/default instance.');
  const database = `spaceship_engine_test_round_${randomBytes(6).toString('hex')}`;
  const options = { host: config.host, port: Number(config.port), user: config.user, password: config.password, database };
  const admin = await mysql.createConnection({ ...options, database: undefined });
  const store = new MySqlStore(options);
  let reopened;
  try {
    await admin.query(`CREATE DATABASE \`${database}\``);
    // Simulate the installed v1 table, including an existing item. init() must
    // extend it additively, not recreate/reset any of the original world data.
    await admin.query(`CREATE TABLE \`${database}\`.world_drops (id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, map_id INT UNSIGNED NOT NULL, x INT NOT NULL, y INT NOT NULL, kind ENUM('item','weapon','armor') NOT NULL DEFAULT 'item', item_id INT UNSIGNED NOT NULL, quantity INT UNSIGNED NOT NULL, metadata JSON NOT NULL, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)) ENGINE=InnoDB`);
    const legacyDrop = randomUUID();
    await admin.execute(`INSERT INTO \`${database}\`.world_drops (id,map_id,x,y,kind,item_id,quantity,metadata) VALUES (?,1,2,3,'item',1,7,'{}')`, [legacyDrop]);
    await store.init();
    const accounts = await Promise.all(['a', 'b', 'c', 'd'].map(name => store.register(`round_${name}`, 'round-test-password')));
    const [a, b, c, d] = accounts;
    for (const account of accounts) await store.savePlayer(account.id, { schemaVersion: 1, mapId: 3, x: 11, y: 12, gold: 100, inventory: [{ kind: 'item', itemId: 5, quantity: 4 }] });
    const outsideA = (await store.loadPlayer(a.id)).state;
    const profile = { schemaVersion: 1, appearance: { type: 'characterCreator', body: 2, hair: 4, hairColor: '#bb7733', layers: [{ category: 'body', file: 'Body03' }] } };
    const round1 = await store.createRound({ definitionId: 'prototype', metadata: { seed: 11 } });
    const round2 = await store.createRound({ definitionId: 'prototype', metadata: { seed: 22 } });
    const one = store.forRound(round1.id), two = store.forInstance(round2.id);
    const starter = { schemaVersion: 1, mapId: 30, x: 2, y: 3, hp: 10, gold: 0, inventory: [] };
    for (const account of [a, b, d]) await store.joinRound(round1.id, account.id, starter);
    await store.joinRound(round2.id, c.id, starter);
    await store.updateRound(round1.id, { status: 'active', metadata: { startsAt: 123 } });

    await t.test('additive migration keeps prior world items; round state and request journals are isolated', async () => {
      assert.equal((await store.listDrops(1)).find(drop => drop.id === legacyDrop).quantity, 7);
      assert.equal((await store.loadRound(round1.id)).metadata.seed, 11);
      await one.commitPlayer(a.id, 'same-id', state => { state.gold += 5; });
      await store.commitPlayer(a.id, 'same-id', state => { state.gold += 1; });
      assert.equal((await one.loadPlayer(a.id)).state.gold, 5);
      assert.equal((await store.loadPlayer(a.id)).state.gold, 101);
      assert.equal((await two.loadPlayer(c.id)).state.gold, 0);
      assert.equal(await two.loadPlayer(a.id), null);
      await assert.rejects(store.joinRound(round2.id, a.id, starter), { code: 'ALREADY_IN_ROUND' });
      const duplicate = await store.joinRound(round1.id, a.id, { ...starter, gold: 9999 });
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.state.gold, 5);
      const replay = await one.commitPlayer(a.id, 'same-id', () => { throw new Error('must not repeat'); });
      assert.equal(replay.duplicate, true);
    });

    let bag;
    const stacks = [{ kind: 'item', itemId: 1, quantity: 3 }, { kind: 'weapon', itemId: 2, quantity: 1 }, { kind: 'item', itemId: 33, quantity: 1 }];
    await t.test('death creates one bag and clears all inventory in the same transaction', async () => {
      await one.savePlayer(a.id, { ...starter, inventory: stacks, gold: 5 });
      const created = await one.createDrop({ playerId: a.id, requestId: 'death:1', drop: { mapId: 30, x: 2, y: 3, kind: 'bag', metadata: { items: stacks, ownerId: a.id } }, mutator: state => { state.inventory = []; state.hp = 0; state.dead = true; } });
      bag = created.drop;
      assert.equal(bag.itemId, 0);
      assert.equal(bag.quantity, 1);
      assert.deepEqual(bag.metadata.items, stacks);
      assert.deepEqual((await one.loadPlayer(a.id)).state.inventory, []);
      assert.equal((await one.listDrops(30)).length, 1);
      assert.equal((await two.listDrops(30)).length, 0);
      assert.equal((await store.listDrops(30)).length, 0);
      await assert.rejects(two.claimDrop({ playerId: c.id, requestId: 'foreign-bag', dropId: bag.id, mutator: addBag }), { code: 'DROP_NOT_FOUND' });
      assert.deepEqual((await two.loadPlayer(c.id)).state.inventory, []);
      await assert.rejects(one.createDrop({ playerId: a.id, requestId: 'bad-bag', drop: { mapId: 30, x: 2, y: 3, kind: 'bag', metadata: { items: [{ kind: 'bag', itemId: 0, quantity: 1 }] } }, mutator() {} }), { code: 'INVALID_DROP' });
    });

    await t.test('contested bag transfers every stack to exactly one player; rollback/retry cannot split or duplicate it', async () => {
      await assert.rejects(one.claimDrop({ playerId: b.id, requestId: 'failed-pickup', dropId: bag.id, mutator: (state, drop) => { state.inventory.push(drop.metadata.items[0]); throw new Error('capacity check failed'); } }), /capacity check failed/);
      assert.deepEqual((await one.loadPlayer(b.id)).state.inventory, []);
      assert.equal((await one.listDrops(30)).length, 1);
      const attempts = await Promise.allSettled([b, d].map(account => one.claimDrop({ playerId: account.id, requestId: 'grab-all', dropId: bag.id, mutator: addBag })));
      assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'DROP_NOT_FOUND');
      const winner = attempts[0].status === 'fulfilled' ? b : d, loser = winner === b ? d : b;
      const picked = (await one.loadPlayer(winner.id)).state;
      for (const stack of stacks) assert.equal(inventoryCount(picked, stack.kind, stack.itemId), stack.quantity);
      assert.deepEqual((await one.loadPlayer(loser.id)).state.inventory, []);
      const repeated = await one.claimDrop({ playerId: winner.id, requestId: 'grab-all', dropId: bag.id, mutator: () => { throw new Error('must not repeat'); } });
      assert.equal(repeated.duplicate, true);
      assert.deepEqual((await one.loadPlayer(winner.id)).state.inventory, picked.inventory);
      assert.equal((await one.listDrops(30)).length, 0);
    });

    await t.test('shared containers grant once across accounts and rounds, including a lost COMMIT response', async () => {
      const grant = (itemId, quantity) => state => {
        state.inventory.push({ kind: 'item', itemId, quantity });
        return { itemId, quantity };
      };
      await assert.rejects(one.claimContainer({ playerId: b.id, containerId: 'rollback', mutator: state => { grant(98, 1)(state); throw new Error('grant failed'); } }), /grant failed/);
      const rollbackClaim = await one.claimContainer({ playerId: d.id, containerId: 'rollback', mutator: grant(98, 1) });
      assert.equal(rollbackClaim.claimed, true);
      assert.equal(inventoryCount((await one.loadPlayer(b.id)).state, 'item', 98), 0);
      const attempts = await Promise.all([b, d].map(account => one.claimContainer({ playerId: account.id, containerId: 'supply', mutator: grant(99, 2) })));
      assert.equal(attempts.filter(result => result.claimed).length, 1);
      assert.equal(attempts[0].claimedBy, attempts[1].claimedBy);
      assert.equal((await Promise.all([b, d].map(account => one.loadPlayer(account.id)))).reduce((n, account) => n + inventoryCount(account.state, 'item', 99), 0), 2);
      assert.equal((await two.claimContainer({ playerId: c.id, containerId: 'supply', mutator: grant(99, 2) })).claimed, true, 'The same container name in another round is independent.');

      // Execute a real MySQL transaction, then discard its successful COMMIT
      // response. Recovery and a different account's retry must not grant twice.
      const original = store.withConnectionTransaction;
      let loseResponse = true, recovered;
      store.withConnectionTransaction = async function (action) {
        const result = await original.call(this, action);
        if (loseResponse) { loseResponse = false; throw Object.assign(new Error('simulated COMMIT response lost'), { code: 'PROTOCOL_CONNECTION_LOST' }); }
        return result;
      };
      try {
        recovered = await one.claimContainer({ playerId: b.id, containerId: 'uncertain', mutator: grant(100, 3) });
      } finally { store.withConnectionTransaction = original; }
      assert.equal(recovered.recovered, true);
      assert.equal(recovered.claimedBy, b.id);
      assert.equal(inventoryCount(recovered.state, 'item', 100), 3);
      const retry = await one.claimContainer({ playerId: d.id, containerId: 'uncertain', mutator: () => { throw new Error('another account must not receive this container'); } });
      assert.equal(retry.duplicate, true);
      assert.equal(retry.claimed, false);
      assert.equal(retry.claimedBy, b.id);
      assert.equal(inventoryCount(retry.state, 'item', 100), 0, 'A duplicate never exposes the winner inventory as the caller state.');
      await one.commitPlayer(b.id, 'after-uncertain-claim', state => { state.gold += 17; });
      const current = (await one.loadPlayer(b.id)).state;
      const ownerRetry = await one.claimContainer({ playerId: b.id, containerId: 'uncertain', mutator: () => { throw new Error('same account must not receive it twice'); } });
      assert.deepEqual(ownerRetry.state, current, 'Recovery returns current economy, never an obsolete claim snapshot.');
      assert.equal(inventoryCount(ownerRetry.state, 'item', 100), 3);
      const [claims] = await store.pool.execute("SELECT COUNT(*) AS n FROM round_claims WHERE round_id = ? AND claim_kind = 'container' AND claim_id = 'uncertain'", [round1.id]);
      assert.equal(Number(claims[0].n), 1);
    });

    await t.test('appearance is durable account profile and cannot be overwritten by either world or round economics', async () => {
      await store.saveProfile(a.id, profile);
      await one.commitPlayer(a.id, 'economy-with-old-look', state => { state.appearance = { body: 99 }; state.gold += 5; });
      await store.savePlayer(a.id, outsideA);
      assert.deepEqual(await store.loadProfile(a.id), profile);
      reopened = await new MySqlStore(options).init();
      assert.deepEqual(await reopened.loadProfile(a.id), profile);
      assert.equal((await reopened.getActiveParticipation(a.id)).roundId, round1.id, 'Opening a new connection must not abort a running round.');
      const updated = { ...profile, appearance: { ...profile.appearance, hair: 7 } };
      await reopened.saveProfile(a.id, updated);
      await one.savePlayer(a.id, (await one.loadPlayer(a.id)).state);
      assert.deepEqual(await store.loadProfile(a.id), updated);
    });

    await t.test('round and participant results commit once; late commands cannot modify finished participants', async () => {
      const leaves = await Promise.all([store.leaveRound(round2.id, c.id, { escaped: true }), store.leaveRound(round2.id, c.id, { escaped: false })]);
      assert.equal(leaves.filter(result => !result.duplicate).length, 1);
      assert.deepEqual(leaves[0].result, leaves[1].result);
      assert.equal(await store.getActiveParticipation(c.id), null);
      await assert.rejects(two.commitPlayer(c.id, 'late', state => { state.gold = 999; }), { code: 'PARTICIPANT_CLOSED' });
      const results = await Promise.all([store.finishRound(round1.id, { winner: b.id }), store.finishRound(round1.id, { winner: d.id })]);
      assert.equal(results.filter(result => !result.duplicate).length, 1);
      assert.deepEqual(results[0].result, results[1].result);
      assert.equal(await store.getActiveParticipation(a.id), null);
      await assert.rejects(one.savePlayer(a.id, starter), { code: 'ROUND_CLOSED' });
      await assert.rejects(one.commitPlayer(b.id, 'late', state => { state.gold = 999; }), { code: 'ROUND_CLOSED' });
      assert.deepEqual((await store.loadPlayer(a.id)).state, outsideA);
    });

    await t.test('restart recovery aborts unfinished rounds without losing outside-world state or permanent appearance', async () => {
      const next = await store.createRound({ definitionId: 'prototype', status: 'active' });
      await store.joinRound(next.id, a.id, starter);
      assert.equal((await store.getActiveParticipation(a.id)).roundId, next.id);
      assert.equal((await store.loadProfile(a.id)).appearance.hair, 7);
      const interrupted = await reopened.abortUnfinishedRounds();
      assert.ok(interrupted.includes(next.id) && interrupted.includes(round2.id));
      assert.ok(!interrupted.includes(round1.id));
      assert.equal((await store.loadRound(next.id)).status, 'aborted');
      assert.equal(await store.getActiveParticipation(a.id), null);
      assert.deepEqual((await store.loadPlayer(a.id)).state, outsideA);
      assert.equal((await reopened.loadProfile(a.id)).appearance.hair, 7);
      assert.deepEqual(await store.abortUnfinishedRounds(), []);
      const duplicate = await store.finishRound(next.id, { winner: a.id });
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.result.reason, 'server-restarted');
      await assert.rejects(store.forRound(next.id).commitPlayer(a.id, 'after-abort', () => {}), { code: 'ROUND_CLOSED' });
    });
  } finally {
    await reopened?.close();
    await store.close();
    assert.match(database, /^spaceship_engine_test_round_[0-9a-f]{12}$/);
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
