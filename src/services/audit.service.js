// src/services/audit.service.js
// One function, used everywhere a state-changing request happens.
// Built in Phase 1 deliberately (per the blueprint) rather than bolted
// on later.
const pool = require('../db/pool');
const { getContext } = require('../middleware/requestContext');

/**
 * @param {object} entry
 * @param {number|null} entry.actorId
 * @param {string} entry.actorRole
 * @param {number|null} entry.districtId
 * @param {number|null} entry.organizationId
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
    organizationId = null,
    action,
    entityType = null,
    entityId = null,
    metadata = {},
  } = entry;

  const ctx = getContext();
  const ip = actorId !== null ? (ctx?.ip || null) : null;
  const userAgent = actorId !== null ? (ctx?.userAgent || null) : null;

  try {
    await pool.query(
      `INSERT INTO audit_log (actor_id, actor_role, district_id, organization_id, action, entity_type, entity_id, metadata, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [actorId, actorRole, districtId, organizationId, action, entityType, entityId, metadata, ip, userAgent]
    );
  } catch (err) {
    // Audit logging must never take down the request it's logging.
    console.error('[audit] failed to write audit entry:', err.message);
  }
}

module.exports = { writeAudit };
