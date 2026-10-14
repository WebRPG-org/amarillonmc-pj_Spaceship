import mysql from 'mysql2/promise';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { RoundStore, roundKey, roundRow } from './round-store.mjs';
import { addInventory } from './combat.mjs';

const scrypt = promisify(scryptCallback);
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
const clone = value => JSON.parse(JSON.stringify(value));
const failure = (code, message) => Object.assign(new Error(message), { code });

function stateValue(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw failure('INVALID_STATE', 'Player state must be an object.');
  const result = clone(state);
  result.schemaVersion ??= 1;
  if (!Number.isInteger(result.schemaVersion) || result.schemaVersion < 1) throw failure('INVALID_STATE', 'Invalid state schema version.');
  for(const item of result.inventory||[])weaponValue(item);
  return result;
}

function requestKey(requestId) {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) throw failure('INVALID_REQUEST_ID', 'A unique request ID is required.');
  return requestId;
}

function credentials(username, password) {
  if (typeof username !== 'string' || !/^[\p{L}\p{N}_-]{3,32}$/u.test(username)) throw failure('INVALID_USERNAME', 'Use 3–32 letters, numbers, underscores or hyphens.');
  if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password) > 256) throw failure('INVALID_PASSWORD', 'Use a password of at least 8 characters and at most 256 bytes.');
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT_OPTIONS);
  return `scrypt$16384$8$1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, encoded) {
  const [algorithm, n, r, p, salt, key] = encoded.split('$');
  if (algorithm !== 'scrypt' || n !== '16384' || r !== '8' || p !== '1' || !/^[a-f0-9]{32}$/.test(salt ?? '') || !/^[a-f0-9]{128}$/.test(key ?? '')) return false;
  const expected = Buffer.from(key, 'hex');
  const actual = await scrypt(password, Buffer.from(salt, 'hex'), expected.length, SCRYPT_OPTIONS);
  return timingSafeEqual(actual, expected);
}

function playerRow(row) {
  return row ? { id: Number(row.id), username: row.username, state: stateValue(decode(row.state)) } : null;
}

function dropRow(row) {
  return { id: row.id, mapId: row.map_id, x: row.x, y: row.y, kind: row.kind, itemId: row.item_id, quantity: row.quantity, metadata: decode(row.metadata) };
}

function weaponValue(item) {
  if(item.kind!=='weapon')return;
  if(item.instanceId!==undefined&&(item.quantity!==1||typeof item.instanceId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(item.instanceId)))throw failure('INVALID_WEAPON','Invalid individual weapon identity.');
  if(item.durability!==undefined&&(!Number.isSafeInteger(item.durability)||!Number.isSafeInteger(item.maxDurability)||item.durability<0||item.maxDurability<1||item.durability>item.maxDurability))throw failure('INVALID_WEAPON','Invalid individual weapon durability.');
}

function dropValue(value) {
  const drop = { ...value, id: value.id ?? randomUUID(), kind: value.kind ?? 'item', metadata: value.metadata ?? {} };
  if (!/^[0-9a-f-]{36}$/i.test(drop.id) || !['item', 'weapon', 'armor', 'bag', 'gold'].includes(drop.kind)) throw failure('INVALID_DROP', 'Invalid drop identity or kind.');
  if(drop.kind==='gold'){drop.itemId??=0;if(drop.itemId!==0)throw failure('INVALID_DROP','Gold has no item ID.');}
  if (drop.kind === 'bag') {
    drop.itemId ??= 0;
    drop.quantity ??= 1;
    if (drop.itemId !== 0 || drop.quantity !== 1 || !Array.isArray(drop.metadata.items) || drop.metadata.items.length > 200) throw failure('INVALID_DROP', 'A bag must contain an array of at most 200 item stacks.');
    for (const item of drop.metadata.items) {
      if (!['item', 'weapon', 'armor'].includes(item.kind) || ![item.itemId, item.quantity].every(n => Number.isSafeInteger(n) && n > 0 && n <= 2147483647)) throw failure('INVALID_DROP', 'Invalid bag item stack.');
      weaponValue(item);
    }
  }
  if(drop.kind==='weapon')weaponValue({...drop.metadata,kind:drop.kind,quantity:drop.quantity});
  for (const name of ['mapId', ...(['bag','gold'].includes(drop.kind) ? [] : ['itemId']), 'quantity']) {
    if (!Number.isSafeInteger(drop[name]) || drop[name] <= 0 || drop[name] > 2147483647) throw failure('INVALID_DROP', `Invalid drop ${name}.`);
  }
  if (![drop.x, drop.y].every(v => Number.isSafeInteger(v) && v >= 0 && v <= 2147483647)) throw failure('INVALID_DROP', 'Invalid drop coordinates.');
  return clone(drop);
}

/** One dedicated database; all economy changes lock the owning player first.
 * Mutators receive an isolated state object, mutate it in place, and return a
 * JSON result. They must not perform external side effects: errors roll back SQL.
 */
export class MySqlStore {
  constructor({ host = '127.0.0.1', port = 3317, user, password, database = 'spaceship_engine' } = {}) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(database)) throw failure('INVALID_DATABASE', 'Invalid database name.');
    this.database = database;
    this.options = { host, port: Number(port), user, password, charset: 'utf8mb4', supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 8, connectTimeout: 10000 };
    this.pool = null;
  }

  async init() {
    if (this.pool) return this;
    const connection = await mysql.createConnection(this.options);
    try {
      await connection.query(`CREATE DATABASE IF NOT EXISTS \`${this.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs`);
      await connection.query(`USE \`${this.database}\``);
      const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
      for (const statement of schema.split(';').map(part => part.trim()).filter(Boolean)) await connection.query(statement);
      // Existing installations keep all account/world data. Only extend the
      // existing enum; the new round/profile tables above are additive.
      for(const table of ['world_drops','round_drops']){
        const [columns] = await connection.execute('SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?', [this.database, table, 'kind']);
        if (!columns[0]?.COLUMN_TYPE.includes("'gold'")) await connection.query(`ALTER TABLE ${table} MODIFY COLUMN kind ENUM('item', 'weapon', 'armor', 'bag', 'gold') NOT NULL DEFAULT 'item'`);
      }
    } finally {
      await connection.end();
    }
    this.pool = mysql.createPool({ ...this.options, database: this.database });
    return this;
  }

  async register(username, password) {
    credentials(username, password);
    const passwordHash = await hashPassword(password);
    const state = { schemaVersion: 1 };
    try {
      const [result] = await this.pool.execute('INSERT INTO players (username, password_hash, state) VALUES (?, ?, ?)', [username, passwordHash, JSON.stringify(state)]);
      return { id: Number(result.insertId), username, state };
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') throw failure('USERNAME_TAKEN', 'That username is already registered.');
      throw error;
    }
  }

  async login(username, password) {
    credentials(username, password);
    const [rows] = await this.pool.execute('SELECT id, username, password_hash, state FROM players WHERE username = ?', [username]);
    // A dummy scrypt keeps missing-account and wrong-password work comparable.
    const encoded = rows[0]?.password_hash ?? `scrypt$16384$8$1$${'00'.repeat(16)}$${'00'.repeat(64)}`;
    const valid = await verifyPassword(password, encoded);
    if (!rows[0] || !valid) throw failure('INVALID_CREDENTIALS', 'Incorrect username or password.');
    return playerRow(rows[0]);
  }

  async loadPlayer(id) {
    const [rows] = await this.pool.execute('SELECT id, username, state FROM players WHERE id = ?', [id]);
    return playerRow(rows[0]);
  }

  normalizeState(state) { return stateValue(state); }
  normalizeDrop(drop) { return dropValue(drop); }
  decodeDrop(row) { return dropRow(row); }
  validateRequest(requestId) { return requestKey(requestId); }

  async loadProfile(playerId) {
    const [rows] = await this.pool.execute('SELECT profile FROM player_profiles WHERE player_id = ?', [playerId]);
    return rows[0] ? clone(decode(rows[0].profile)) : {};
  }

  async saveProfile(playerId, profile) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw failure('INVALID_PROFILE', 'Profile must be an object.');
    const next = clone(profile);
    await this.pool.execute('INSERT INTO player_profiles (player_id, profile) VALUES (?, ?) ON DUPLICATE KEY UPDATE profile = VALUES(profile), revision = revision + 1', [playerId, JSON.stringify(next)]);
    return next;
  }

  async updateProfile(playerId, patch) {
    if(!patch||typeof patch!=='object'||Array.isArray(patch))throw failure('INVALID_PROFILE','Profile patch must be an object.');
    return this.withConnectionTransaction(async connection=>{
      const [players]=await connection.execute('SELECT id FROM players WHERE id = ? FOR UPDATE',[playerId]);
      if(!players[0])throw failure('PLAYER_NOT_FOUND','Player does not exist.');
      const [rows]=await connection.execute('SELECT profile FROM player_profiles WHERE player_id = ? FOR UPDATE',[playerId]);
      const profile={...(rows[0]?decode(rows[0].profile):{}),...clone(patch)};
      await connection.execute('INSERT INTO player_profiles (player_id,profile) VALUES (?,?) ON DUPLICATE KEY UPDATE profile=VALUES(profile),revision=revision+1',[playerId,JSON.stringify(profile)]);
      return profile;
    });
  }

  createWorldDrops(options) { return this.createScopedWorldDrops('world',options); }

  async createScopedWorldDrops(scopeId,{requestId,drops},assertOpen) {
    requestKey(requestId);
    if(!Array.isArray(drops)||drops.length>200)throw failure('INVALID_DROP','Expected at most 200 drops.');
    const values=drops.map(dropValue);
    return this.withConnectionTransaction(async connection=>{
      if(assertOpen)await assertOpen(connection);
      const [insert]=await connection.execute('INSERT IGNORE INTO world_drop_requests (scope_id,request_id) VALUES (?,?)',[scopeId,requestId]);
      const [rows]=await connection.execute('SELECT response FROM world_drop_requests WHERE scope_id=? AND request_id=? FOR UPDATE',[scopeId,requestId]);
      if(!insert.affectedRows&&rows[0]?.response){
        const prior=decode(rows[0].response),remaining=[];
        // A retry must not put an already claimed drop back into the live map.
        for(const drop of prior.drops){
          const [found]=scopeId==='world'?await connection.execute('SELECT * FROM world_drops WHERE id=?',[drop.id]):await connection.execute('SELECT * FROM round_drops WHERE round_id=? AND id=?',[scopeId,drop.id]);
          if(found[0])remaining.push(dropRow(found[0]));
        }
        return{...prior,drops:remaining,duplicate:true};
      }
      for(const drop of values){
        if(scopeId==='world')await connection.execute('INSERT INTO world_drops (id,map_id,x,y,kind,item_id,quantity,metadata) VALUES (?,?,?,?,?,?,?,?)',[drop.id,drop.mapId,drop.x,drop.y,drop.kind,drop.itemId,drop.quantity,JSON.stringify(drop.metadata)]);
        else await connection.execute('INSERT INTO round_drops (round_id,id,map_id,x,y,kind,item_id,quantity,metadata) VALUES (?,?,?,?,?,?,?,?,?)',[scopeId,drop.id,drop.mapId,drop.x,drop.y,drop.kind,drop.itemId,drop.quantity,JSON.stringify(drop.metadata)]);
      }
      const response={drops:values,duplicate:false};
      await connection.execute('UPDATE world_drop_requests SET response=? WHERE scope_id=? AND request_id=?',[JSON.stringify(response),scopeId,requestId]);
      return response;
    });
  }

  async listPlayerRecords(playerId,limit=30) {
    const count=Math.max(1,Math.min(50,Math.floor(Number(limit)||30)));
    const [rows]=await this.pool.execute(`SELECT r.id,r.definition_id,r.metadata,r.result,r.status,r.created_at,r.ended_at,p.result AS personal_result FROM round_participants p JOIN rounds r ON r.id=p.round_id WHERE p.player_id=? AND (r.status NOT IN ('waiting','active') OR p.status<>'active') ORDER BY r.created_at DESC LIMIT ${count}`,[playerId]);
    return rows.map(r=>({id:r.id,definitionId:r.definition_id,metadata:decode(r.metadata),result:decode(r.result),personalResult:decode(r.personal_result),status:r.status,createdAt:r.created_at,endedAt:r.ended_at}));
  }

  forRound(roundId) { return new RoundStore(this, roundKey(roundId)); }
  forInstance(roundId) { return this.forRound(roundId); }

  async createRound({ id = randomUUID(), definitionId = 'default', status = 'waiting', metadata = {} } = {}) {
    roundKey(id);
    if (typeof definitionId !== 'string' || !definitionId.length || definitionId.length > 96 || !['waiting', 'active'].includes(status)) throw failure('INVALID_ROUND', 'Invalid round definition or initial status.');
    await this.pool.execute('INSERT INTO rounds (id, definition_id, status, metadata) VALUES (?, ?, ?, ?)', [id, definitionId, status, JSON.stringify(metadata)]);
    return this.loadRound(id);
  }

  async loadRound(roundId) {
    const [rows] = await this.pool.execute('SELECT * FROM rounds WHERE id = ?', [roundKey(roundId)]);
    return rows[0] ? roundRow(rows[0]) : null;
  }

  async withConnectionTransaction(action) {
    const connection = await this.pool.getConnection();
    let committing=false;
    try {
      await connection.beginTransaction();
      const result = await action(connection);
      committing=true;
      await connection.commit();
      return result;
    } catch (error) {
      if(committing)error.economyUncertain=true;
      // Preserve the original connection/COMMIT error for outcome recovery.
      try { await connection.rollback(); } catch {}
      throw error;
    } finally { connection.release(); }
  }

  async updateRound(roundId, { status, metadata } = {}) {
    roundKey(roundId);
    return this.withConnectionTransaction(async connection => {
      const [rows] = await connection.execute('SELECT * FROM rounds WHERE id = ? FOR UPDATE', [roundId]);
      if (!rows[0]) throw failure('ROUND_NOT_FOUND', 'Round does not exist.');
      const current = roundRow(rows[0]);
      if (!['waiting', 'active'].includes(current.status)) throw failure('ROUND_CLOSED', 'Round is already closed.');
      if (status !== undefined && (!['waiting', 'active'].includes(status) || current.status === 'active' && status === 'waiting')) throw failure('INVALID_ROUND_STATE', 'Invalid round transition.');
      const nextMetadata = metadata === undefined ? current.metadata : { ...current.metadata, ...clone(metadata) };
      await connection.execute('UPDATE rounds SET status = ?, metadata = ? WHERE id = ?', [status ?? current.status, JSON.stringify(nextMetadata), roundId]);
      const [updated] = await connection.execute('SELECT * FROM rounds WHERE id = ?', [roundId]);
      return roundRow(updated[0]);
    });
  }

  async joinRound(roundId, playerId, initialState) {
    roundKey(roundId);
    const next = stateValue(initialState);
    return this.withConnectionTransaction(async connection => {
      // Serialize joins for this account, including two different rounds.
      const [players] = await connection.execute('SELECT id, username FROM players WHERE id = ? FOR UPDATE', [playerId]);
      if (!players[0]) throw failure('PLAYER_NOT_FOUND', 'Player does not exist.');
      const [rounds] = await connection.execute('SELECT status FROM rounds WHERE id = ? FOR UPDATE', [roundId]);
      if (!rounds[0]) throw failure('ROUND_NOT_FOUND', 'Round does not exist.');
      if (!['waiting', 'active'].includes(rounds[0].status)) throw failure('ROUND_CLOSED', 'Round is already closed.');
      const [existing] = await connection.execute('SELECT state, status FROM round_participants WHERE round_id = ? AND player_id = ?', [roundId, playerId]);
      if (existing[0]) {
        if (existing[0].status !== 'active') throw failure('PARTICIPANT_CLOSED', 'This character already left this round.');
        return { id: Number(playerId), username: players[0].username, state: stateValue(decode(existing[0].state)), duplicate: true };
      }
      const [active] = await connection.execute("SELECT round_id FROM round_participants WHERE player_id = ? AND status = 'active'", [playerId]);
      if (active.length) throw failure('ALREADY_IN_ROUND', 'Player already belongs to another unfinished round.');
      await connection.execute('INSERT INTO round_participants (round_id, player_id, state) VALUES (?, ?, ?)', [roundId, playerId, JSON.stringify(next)]);
      return { id: Number(playerId), username: players[0].username, state: next, duplicate: false };
    });
  }

  async getActiveParticipation(playerId) {
    const [rows] = await this.pool.execute("SELECT p.round_id, p.state, p.status, r.definition_id, r.metadata FROM round_participants p JOIN rounds r ON r.id = p.round_id WHERE p.player_id = ? AND p.status = 'active' AND r.status IN ('waiting', 'active')", [playerId]);
    if (!rows[0]) return null;
    return { roundId: rows[0].round_id, status: rows[0].status, definitionId: rows[0].definition_id, state: stateValue(decode(rows[0].state)), metadata: decode(rows[0].metadata) };
  }

  async leaveRound(roundId, playerId, result = {}) {
    roundKey(roundId);
    return this.withConnectionTransaction(async connection => {
      await connection.execute('SELECT id FROM rounds WHERE id = ? FOR SHARE', [roundId]);
      const [rows] = await connection.execute('SELECT status, result, state FROM round_participants WHERE round_id = ? AND player_id = ? FOR UPDATE', [roundId, playerId]);
      if (!rows[0]) throw failure('PARTICIPANT_NOT_FOUND', 'Player does not belong to this round.');
      if (rows[0].status !== 'active') return { roundId, playerId: Number(playerId), status: rows[0].status, result: decode(rows[0].result), duplicate: true };
      await connection.execute("UPDATE round_participants SET status = 'left', result = ?, left_at = CURRENT_TIMESTAMP(3) WHERE round_id = ? AND player_id = ?", [JSON.stringify(result), roundId, playerId]);
      return { roundId, playerId: Number(playerId), status: 'left', result: clone(result), duplicate: false };
    });
  }

  async finishRound(roundId, result = {}) {
    roundKey(roundId);
    return this.withConnectionTransaction(async connection => {
      const [rows] = await connection.execute('SELECT * FROM rounds WHERE id = ? FOR UPDATE', [roundId]);
      if (!rows[0]) throw failure('ROUND_NOT_FOUND', 'Round does not exist.');
      if (!['waiting', 'active'].includes(rows[0].status)) return { round: roundRow(rows[0]), result: decode(rows[0].result), duplicate: true };
      result=clone(result);
      // Completion and permanent rewards commit together. A replay returns the
      // recorded result above, including after a lost COMMIT response.
      if(result.success&&result.reward){
        result.rewardsByPlayer={};
        const [members]=await connection.execute("SELECT player_id FROM round_participants WHERE round_id=? AND status='active' ORDER BY player_id",[roundId]);
        for(const member of members){
          const playerId=Number(member.player_id),outcome=result.participants?.find(p=>Number(p.id)===playerId)?.outcome;
          if(!['completed','escaped','victory'].includes(outcome))continue;
          const [players]=await connection.execute('SELECT state FROM players WHERE id=? FOR UPDATE',[playerId]);
          const [profiles]=await connection.execute('SELECT profile FROM player_profiles WHERE player_id=? FOR UPDATE',[playerId]);
          const profile=profiles[0]?decode(profiles[0].profile):{},reward=result.reward,state=stateValue(decode(players[0].state));
          const granted={titleId:reward.titleId||null,newTitle:false,gold:0,items:[]};
          if(reward.titleId){profile.titles=Array.isArray(profile.titles)?profile.titles:[];if(!profile.titles.includes(reward.titleId)){profile.titles.push(reward.titleId);granted.newTitle=true;}}
          if(reward.firstCompletionOnly&&!reward.titleId)throw failure('INVALID_REWARD','First completion rewards require a permanent unlock id.');
          if(!reward.firstCompletionOnly||granted.newTitle){
            if(Number.isSafeInteger(reward.gold)&&reward.gold>0){state.gold=(state.gold||0)+reward.gold;granted.gold=reward.gold;}
            for(const item of reward.items||[]){addInventory(state,item.kind,item.itemId,item.quantity);granted.items.push(item);}
          }
          await connection.execute('UPDATE players SET state=?,revision=revision+1 WHERE id=?',[JSON.stringify(state),playerId]);
          await connection.execute('INSERT INTO player_profiles (player_id,profile) VALUES (?,?) ON DUPLICATE KEY UPDATE profile=VALUES(profile),revision=revision+1',[playerId,JSON.stringify(profile)]);
          result.rewardsByPlayer[playerId]=granted;
        }
      }
      await connection.execute("UPDATE rounds SET status = 'finished', result = ?, ended_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [JSON.stringify(result), roundId]);
      await connection.execute("UPDATE round_participants SET status = 'finished', result = COALESCE(result, ?), left_at = CURRENT_TIMESTAMP(3) WHERE round_id = ? AND status = 'active'", [JSON.stringify({ reason: 'round-finished' }), roundId]);
      const [updated] = await connection.execute('SELECT * FROM rounds WHERE id = ?', [roundId]);
      return { round: roundRow(updated[0]), result: clone(result), duplicate: false };
    });
  }

  async abortUnfinishedRounds() {
    // Explicit host-startup recovery only; opening a second DB connection must
    // never abort an otherwise running host's rounds.
    return this.withConnectionTransaction(async connection => {
      const [rows] = await connection.execute("SELECT id FROM rounds WHERE status IN ('waiting', 'active') FOR UPDATE");
      const result = JSON.stringify({ reason: 'server-restarted', aborted: true });
      for (const { id } of rows) {
        await connection.execute("UPDATE rounds SET status = 'aborted', result = ?, ended_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [result, id]);
        await connection.execute("UPDATE round_participants SET status = 'aborted', result = ?, left_at = CURRENT_TIMESTAMP(3) WHERE round_id = ? AND status = 'active'", [result, id]);
      }
      return rows.map(row => row.id);
    });
  }

  async savePlayer(id, state) {
    const next = stateValue(state);
    const [result] = await this.pool.execute('UPDATE players SET state = ?, revision = revision + 1 WHERE id = ?', [JSON.stringify(next), id]);
    if (!result.affectedRows) throw failure('PLAYER_NOT_FOUND', 'Player does not exist.');
    return next;
  }

  async transaction(playerId, requestId, operation, action) {
    requestKey(requestId);
    const connection = await this.pool.getConnection();
    let committing=false;
    try {
      await connection.beginTransaction();
      const [players] = await connection.execute('SELECT state FROM players WHERE id = ? FOR UPDATE', [playerId]);
      if (!players[0]) throw failure('PLAYER_NOT_FOUND', 'Player does not exist.');
      const [requests] = await connection.execute('SELECT operation, response FROM player_requests WHERE player_id = ? AND request_id = ?', [playerId, requestId]);
      if (requests[0]) {
        if (requests[0].operation !== operation) throw failure('REQUEST_CONFLICT', 'Request ID was already used for another operation.');
        await connection.commit();
        return { ...decode(requests[0].response), duplicate: true };
      }
      const state = stateValue(decode(players[0].state));
      const response = await action(connection, state);
      const payload = { ...response, state: stateValue(state), duplicate: false };
      await connection.execute('UPDATE players SET state = ?, revision = revision + 1 WHERE id = ?', [JSON.stringify(payload.state), playerId]);
      await connection.execute('INSERT INTO player_requests (player_id, request_id, operation, response) VALUES (?, ?, ?, ?)', [playerId, requestId, operation, JSON.stringify(payload)]);
      committing=true;
      await connection.commit();
      return payload;
    } catch (error) {
      if(committing)error.economyUncertain=true;
      try{await connection.rollback();}catch{}
      throw error;
    } finally {
      connection.release();
    }
  }

  async commitPlayer(playerId, requestId, mutator) {
    return this.transaction(playerId, requestId, 'player', async (_connection, state) => ({ result: (await mutator(state)) ?? null }));
  }

  async createDrops({ playerId, requestId, drops, mutator }) {
    if (!Array.isArray(drops) || drops.length > 200) throw failure('INVALID_DROP', 'Expected at most 200 drops.');
    const values = drops.map(dropValue);
    return this.transaction(playerId, requestId, 'create-drops', async (connection, state) => {
      const result = (await mutator(state, values)) ?? null;
      for (const drop of values) {
        await connection.execute('INSERT INTO world_drops (id, map_id, x, y, kind, item_id, quantity, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [drop.id, drop.mapId, drop.x, drop.y, drop.kind, drop.itemId, drop.quantity, JSON.stringify(drop.metadata)]);
      }
      return { result, drops: values };
    });
  }

  async createDrop({ drop, ...options }) {
    const response = await this.createDrops({ ...options, drops: [drop] });
    return { ...response, drop: response.drops[0] };
  }

  async listDrops(mapId) {
    const [rows] = await this.pool.execute('SELECT * FROM world_drops WHERE map_id = ? ORDER BY created_at, id', [mapId]);
    return rows.map(dropRow);
  }

  async claimDrop({ playerId, requestId, dropId, mutator }) {
    return this.transaction(playerId, requestId, 'claim-drop', async (connection, state) => {
      const [rows] = await connection.execute('SELECT * FROM world_drops WHERE id = ? FOR UPDATE', [dropId]);
      if (!rows[0]) throw failure('DROP_NOT_FOUND', 'This item was already picked up or no longer exists.');
      const drop = dropRow(rows[0]);
      const result = (await mutator(state, drop)) ?? null;
      await connection.execute('DELETE FROM world_drops WHERE id = ?', [dropId]);
      return { result, drop };
    });
  }

  async close() {
    if (this.pool) await this.pool.end();
    this.pool = null;
  }
}
