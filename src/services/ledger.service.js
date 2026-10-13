// src/services/ledger.service.js
// Append-only hash-chained ledger for platform-level audit trail
const crypto = require('crypto');
const pool = require('../db/pool');

function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalJson);
  }
  const sorted = {};
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    sorted[key] = canonicalJson(obj[key]);
  }
  return sorted;
}

async function writeLedger({ actorType, actorId, organizationId, organizationName, eventType, detail }, client) {
  const suppliedClient = client;
  const targetClient = suppliedClient || await pool.connect();
  let transactionStarted = false;

  try {
    if (!suppliedClient) {
      await targetClient.query('BEGIN');
      transactionStarted = true;
    }

    // Serialize writers with advisory lock
    await targetClient.query('SELECT pg_advisory_xact_lock(7770001)');

    // Read latest entry_hash
    const { rows } = await targetClient.query(
      'SELECT entry_hash FROM platform_ledger ORDER BY id DESC LIMIT 1'
    );
    const prevHash = rows[0]?.entry_hash || null;

    const occurredAt = new Date();

    // Validate detail size
    const detailStr = JSON.stringify(detail);
    if (detailStr.length > 4000) {
      throw new Error('Ledger detail exceeds 4000 characters');
    }

    // Compute entry_hash
    const hashInput = [
      prevHash || '',
      occurredAt.toISOString(),
      actorType,
      actorId ?? '',
      organizationId ?? '',
      eventType,
      JSON.stringify(canonicalJson(detail))
    ].join('|');
    const entryHash = crypto.createHash('sha256').update(hashInput).digest('hex');

    await targetClient.query(
      `INSERT INTO platform_ledger (occurred_at, actor_type, actor_id, organization_id, organization_name, event_type, detail, entry_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [occurredAt, actorType, actorId, organizationId, organizationName, eventType, detail, entryHash]
    );

    if (!suppliedClient) {
      await targetClient.query('COMMIT');
      transactionStarted = false;
    }
  } catch (err) {
    if (!suppliedClient && transactionStarted) {
      try {
        await targetClient.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('[ledger] Rollback failed:', rollbackErr.message);
      }
    }
    throw err;
  } finally {
    if (!suppliedClient) {
      targetClient.release();
    }
  }
}

async function verifyLedger() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      'SELECT id, occurred_at, actor_type, actor_id, organization_id, organization_name, event_type, detail, entry_hash FROM platform_ledger ORDER BY id'
    );

    let prevHash = null;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const expectedInput = [
        prevHash || '',
        row.occurred_at.toISOString(),
        row.actor_type,
        row.actor_id ?? '',
        row.organization_id ?? '',
        row.event_type,
        JSON.stringify(canonicalJson(row.detail))
      ].join('|');
      const expectedHash = crypto.createHash('sha256').update(expectedInput).digest('hex');

      if (expectedHash !== row.entry_hash) {
        return { ok: false, checked: i, firstBadId: row.id };
      }
      prevHash = row.entry_hash;
    }

    return { ok: true, checked: rows.length, firstBadId: null };
  } finally {
    client.release();
  }
}

module.exports = { writeLedger, verifyLedger };
