// src/utils/scope.js
// Organization scoping helpers for all controllers
const pool = require('../db/pool');

/**
 * Returns an array of district IDs the caller may access, cached on req.
 * - owner: every district where districts.organization_id = req.user.organization_id
 * - admin: if all_districts, every district of the organisation (live, so future districts are included)
 *          else district_ids filtered by SELECT id FROM districts WHERE id = ANY($1) AND organization_id = $2
 * - property_manager/tenant/service_provider: [req.user.district_id] if that district belongs to their org, else []
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

  if (req.user.role === 'admin') {
    if (req.user.all_districts) {
      // Admin with all_districts: every district of the organisation (live)
      const { rows } = await pool.query(
        'SELECT id FROM districts WHERE organization_id = $1',
        [orgId]
      );
      req._districtIds = rows.map(r => r.id);
      return req._districtIds;
    } else {
      // Admin with specific districts from code_districts
      if (req.user.district_ids && req.user.district_ids.length > 0) {
        const { rows } = await pool.query(
          'SELECT id FROM districts WHERE id = ANY($1::int[]) AND organization_id = $2',
          [req.user.district_ids, orgId]
        );
        req._districtIds = rows.map(r => r.id);
        return req._districtIds;
      }
    }
  }

  // For other roles (property_manager, tenant, service_provider), check if their district belongs to their org
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

/**
 * Resolves a target district ID from request body.
 * - If bodyDistrictId is given, it must be in allowedDistrictIds(req) (else throw 404)
 * - If absent and exactly one district is allowed, return it
 * - Otherwise throw 400
 */
async function resolveTargetDistrict(req, bodyDistrictId) {
  const allowed = await allowedDistrictIds(req);

  if (bodyDistrictId !== undefined && bodyDistrictId !== null && bodyDistrictId !== '') {
    const targetId = Number(bodyDistrictId);
    if (!Number.isInteger(targetId) || targetId < 1) {
      const error = new Error('Invalid district ID.');
      error.status = 400;
      throw error;
    }
    if (!allowed.includes(targetId)) {
      const error = new Error('Not found.');
      error.status = 404;
      throw error;
    }
    return targetId;
  }

  if (allowed.length === 1) {
    return allowed[0];
  }

  const error = new Error('district_id is required.');
  error.status = 400;
  throw error;
}

/**
 * Returns true if the user can act organisation-wide.
 * - owner: always true
 * - admin: true if all_districts is true
 * - other roles: false
 */
function canActOrgWide(req) {
  if (req.user.role === 'owner') {
    return true;
  }
  if (req.user.role === 'admin' && req.user.all_districts) {
    return true;
  }
  return false;
}

module.exports = { allowedDistrictIds, assertDistrictAccess, orgId, resolveTargetDistrict, canActOrgWide };
