// src/services/audit.service.js
// One function, used everywhere a state-changing request happens.
// Built in Phase 1 deliberately (per the blueprint) rather than bolted
// on later.
const pool = require('../db/pool');

/**
 * @param {object} entry
 * @param {number|null} entry.actorId
 * @param {string} entry.actorRole
 * @param {number|null} entry.districtId
 * @param {string} entry.action        e.g. 'district.create', 'code.revoke'
 * @param {string} [entry.entityType]  e.g. 'district', 'code'
 * @param {number} [entry.entityId]
 * @param {object} [entry.metadata]    never put an anonymous complainant's
 *                                     identity in here — see blueprint Section 5/Phase 5
 */
async function writeAudit(entry) {
  const {
    actorId = null,
    actorRole,
    districtId = null,
    action,
    entityType = null,
    entityId = null,
    metadata = {},
  } = entry;

  try {
    await pool.query(
      `INSERT INTO audit_log (actor_id, actor_role, district_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [actorId, actorRole, districtId, action, entityType, entityId, metadata]
    );
  } catch (err) {
    // Audit logging must never take down the request it's logging.
    console.error('[audit] failed to write audit entry:', err.message);
  }
}

module.exports = { writeAudit };
