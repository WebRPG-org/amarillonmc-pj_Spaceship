const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
const failure = (code, message) => Object.assign(new Error(message), { code });

export function roundKey(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(id)) throw failure('INVALID_ROUND_ID', 'Invalid round identifier.');
  return id;
}

export function roundRow(row) {
  return { id: row.id, definitionId: row.definition_id, status: row.status, metadata: decode(row.metadata), result: decode(row.result), createdAt: row.created_at, updatedAt: row.updated_at, endedAt: row.ended_at };
}

/** A World-compatible store with a fixed round identity selected by the host.
 * It never writes players.state (the outside world) or player_profiles.
 * Lock order: round shared lock -> participant -> drop. Closing a round takes
 * its exclusive lock, so no command can commit after the final result.
 */
export class RoundStore {
  constructor(base, roundId) {
    this.base = base;
    this.roundId = roundKey(roundId);
  }

  get pool() { return this.base.pool; }
  async init() { await this.base.init(); return this; }
  async close() { /* The host owns the shared pool. */ }
  loadProfile(playerId) { return this.base.loadProfile(playerId); }
  saveProfile(playerId, profile) { return this.base.saveProfile(playerId, profile); }
  updateProfile(playerId, patch) { return this.base.updateProfile(playerId, patch); }
  createWorldDrops(options) { return this.base.createScopedWorldDrops(this.roundId,options,connection=>this.assertOpen(connection)); }

  async assertOpen(connection) {
    const [rows] = await connection.execute('SELECT status FROM rounds WHERE id = ? FOR SHARE', [this.roundId]);
    if (!rows[0]) throw failure('ROUND_NOT_FOUND', 'Round does not exist.');
    if (!['waiting', 'active'].includes(rows[0].status)) throw failure('ROUND_CLOSED', 'Round is already closed.');
  }

  async lockPlayer(connection, playerId) {
    await this.assertOpen(connection);
    const [rows] = await connection.execute('SELECT state, status FROM round_participants WHERE round_id = ? AND player_id = ? FOR UPDATE', [this.roundId, playerId]);
    if (!rows[0]) throw failure('PARTICIPANT_NOT_FOUND', 'Player does not belong to this round.');
    if (rows[0].status !== 'active') throw failure('PARTICIPANT_CLOSED', 'Player already left this round.');
    return this.base.normalizeState(decode(rows[0].state));
  }

  async loadPlayer(playerId) {
    const [rows] = await this.pool.execute('SELECT p.player_id, p.state, a.username FROM round_participants p JOIN players a ON a.id = p.player_id WHERE p.round_id = ? AND p.player_id = ?', [this.roundId, playerId]);
    return rows[0] ? { id: Number(rows[0].player_id), username: rows[0].username, state: this.base.normalizeState(decode(rows[0].state)) } : null;
  }

  async savePlayer(playerId, state) {
    const next = this.base.normalizeState(state);
    return this.base.withConnectionTransaction(async connection => {
      await this.lockPlayer(connection, playerId);
      await connection.execute('UPDATE round_participants SET state = ?, revision = revision + 1 WHERE round_id = ? AND player_id = ?', [JSON.stringify(next), this.roundId, playerId]);
      return next;
    });
  }

  async transaction(playerId, requestId, operation, action) {
    this.base.validateRequest(requestId);
    return this.base.withConnectionTransaction(async connection => {
      const state = await this.lockPlayer(connection, playerId);
      const [requests] = await connection.execute('SELECT operation, response FROM round_requests WHERE round_id = ? AND player_id = ? AND request_id = ?', [this.roundId, playerId, requestId]);
      if (requests[0]) {
        if (requests[0].operation !== operation) throw failure('REQUEST_CONFLICT', 'Request ID was already used for another operation.');
        return { ...decode(requests[0].response), duplicate: true };
      }
      const response = await action(connection, state);
      const payload = { ...response, state: this.base.normalizeState(state), duplicate: false };
      await connection.execute('UPDATE round_participants SET state = ?, revision = revision + 1 WHERE round_id = ? AND player_id = ?', [JSON.stringify(payload.state), this.roundId, playerId]);
      await connection.execute('INSERT INTO round_requests (round_id, player_id, request_id, operation, response) VALUES (?, ?, ?, ?, ?)', [this.roundId, playerId, requestId, operation, JSON.stringify(payload)]);
      return payload;
    });
  }

  commitPlayer(playerId, requestId, mutator) {
    return this.transaction(playerId, requestId, 'player', async (_connection, state) => ({ result: (await mutator(state)) ?? null }));
  }

  /** The claim identity belongs to the whole round, never to an individual
   * account. Inserting it and granting its contents are one transaction.
   * Do not precede retries with savePlayer: an earlier commit may have succeeded
   * even when its response was lost. Replays return the caller's current state.
   */
  async claimContainer({ playerId, containerId, mutator }) {
    if (typeof containerId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(containerId)) throw failure('INVALID_CONTAINER', 'Invalid container identifier.');
    if (typeof mutator !== 'function') throw failure('INVALID_CONTAINER', 'A container grant is required.');
    try {
      return await this.base.withConnectionTransaction(async connection => {
        const state = await this.lockPlayer(connection, playerId);
        const [insert] = await connection.execute("INSERT IGNORE INTO round_claims (round_id, claim_kind, claim_id, player_id) VALUES (?, 'container', ?, ?)", [this.roundId, containerId, playerId]);
        if (!insert.affectedRows) {
          const [rows] = await connection.execute("SELECT player_id, result FROM round_claims WHERE round_id = ? AND claim_kind = 'container' AND claim_id = ? FOR SHARE", [this.roundId, containerId]);
          if (!rows[0]) throw failure('CLAIM_UNAVAILABLE', 'The shared container claim could not be read.');
          return { state, result: decode(rows[0].result), claimed: false, duplicate: true, claimedBy: Number(rows[0].player_id) };
        }
        const result = (await mutator(state)) ?? null;
        const next = this.base.normalizeState(state);
        await connection.execute('UPDATE round_participants SET state = ?, revision = revision + 1 WHERE round_id = ? AND player_id = ?', [JSON.stringify(next), this.roundId, playerId]);
        await connection.execute("UPDATE round_claims SET result = ? WHERE round_id = ? AND claim_kind = 'container' AND claim_id = ?", [JSON.stringify(result), this.roundId, containerId]);
        return { state: next, result, claimed: true, duplicate: false, claimedBy: Number(playerId) };
      });
    } catch (error) {
      // A broken connection after COMMIT cannot tell the caller whether the
      // grant happened. Read its durable identity via a fresh pooled connection
      // before allowing a retry to overwrite the caller's old in-memory state.
      if (!['PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(error.code)) throw error;
      try {
        const [rows] = await this.pool.execute("SELECT c.player_id, c.result, p.state FROM round_claims c JOIN round_participants p ON p.round_id = c.round_id AND p.player_id = ? WHERE c.round_id = ? AND c.claim_kind = 'container' AND c.claim_id = ?", [playerId, this.roundId, containerId]);
        if (rows[0]) return { state: this.base.normalizeState(decode(rows[0].state)), result: decode(rows[0].result), claimed: false, duplicate: true, claimedBy: Number(rows[0].player_id), recovered: true };
      } catch { error.economyUncertain = true; }
      throw error;
    }
  }

  async createDrops({ playerId, requestId, drops, mutator }) {
    if (!Array.isArray(drops) || drops.length > 200) throw failure('INVALID_DROP', 'Expected at most 200 drops.');
    const values = drops.map(drop => ({ ...this.base.normalizeDrop(drop), roundId: this.roundId }));
    return this.transaction(playerId, requestId, 'create-drops', async (connection, state) => {
      const result = (await mutator(state, values)) ?? null;
      for (const drop of values) {
        await connection.execute('INSERT INTO round_drops (round_id, id, map_id, x, y, kind, item_id, quantity, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [this.roundId, drop.id, drop.mapId, drop.x, drop.y, drop.kind, drop.itemId, drop.quantity, JSON.stringify(drop.metadata)]);
      }
      return { result, drops: values };
    });
  }

  async createDrop({ drop, ...options }) {
    const response = await this.createDrops({ ...options, drops: [drop] });
    return { ...response, drop: response.drops[0] };
  }

  async listDrops(mapId) {
    const [rows] = await this.pool.execute('SELECT * FROM round_drops WHERE round_id = ? AND map_id = ? ORDER BY created_at, id', [this.roundId, mapId]);
    return rows.map(row => ({ ...this.base.decodeDrop(row), roundId: this.roundId }));
  }

  claimDrop({ playerId, requestId, dropId, mutator }) {
    return this.transaction(playerId, requestId, 'claim-drop', async (connection, state) => {
      const [rows] = await connection.execute('SELECT * FROM round_drops WHERE round_id = ? AND id = ? FOR UPDATE', [this.roundId, dropId]);
      if (!rows[0]) throw failure('DROP_NOT_FOUND', 'This item was already picked up or does not belong to this round.');
      const drop = { ...this.base.decodeDrop(rows[0]), roundId: this.roundId };
      // A bag is one row. The World mutator transfers ALL metadata.items and
      // this row is deleted in the same transaction, or both changes roll back.
      const result = (await mutator(state, drop)) ?? null;
      await connection.execute('DELETE FROM round_drops WHERE round_id = ? AND id = ?', [this.roundId, dropId]);
      return { result, drop };
    });
  }
}
