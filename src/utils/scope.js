// src/utils/scope.js
// Organization scoping helpers for all controllers
const pool = require('../db/pool');

/**
 * Returns an array of district IDs the caller may access, cached on req.
 * - owner: every district where districts.organization_id = req.user.organization_id
 * - admin/property_manager: [req.user.district_id] if that district belongs to their org, else []
 * - tenant/service_provider: [req.user.district_id] if that district belongs to their org, else []
 */
async function allowedDistrictIds(req) {
  if (req._districtIds !== undefined) {
    return req._districtIds;
  }

  const orgId = req.user.organization_id;
  if (!orgId) {
    req._districtIds = [];
    return [];
  }

  if (req.user.role === 'owner') {
    const { rows } = await pool.query(
      'SELECT id FROM districts WHERE organization_id = $1',
      [orgId]
    );
    req._districtIds = rows.map(r => r.id);
    return req._districtIds;
  }

  // For other roles, check if their district belongs to their org
  const { rows } = await pool.query(
    'SELECT id FROM districts WHERE id = $1 AND organization_id = $2',
    [req.user.district_id, orgId]
  );

  if (rows.length === 0) {
    req._districtIds = [];
    return [];
  }

  req._districtIds = [req.user.district_id];
  return req._districtIds;
}

/**
 * Throws an error with .status = 404 and message 'Not found.' unless
 * Number(districtId) is in allowedDistrictIds(req).
 * Use this to prevent existence leakage when accessing records by ID.
 */
async function assertDistrictAccess(req, districtId) {
  const targetId = Number(districtId);
  if (!Number.isInteger(targetId) || targetId < 1) {
    const error = new Error('Invalid district ID.');
    error.status = 400;
    throw error;
  }

  const allowed = await allowedDistrictIds(req);
  if (!allowed.includes(targetId)) {
    const error = new Error('Not found.');
    error.status = 404;
    throw error;
  }
}

/**
 * Returns req.user.organization_id.
 * Throws an error with .status = 403 if missing.
 */
function orgId(req) {
  if (!req.user.organization_id) {
    const error = new Error('Your account is not linked to an organisation.');
    error.status = 403;
    throw error;
  }
  return req.user.organization_id;
}

module.exports = { allowedDistrictIds, assertDistrictAccess, orgId };
