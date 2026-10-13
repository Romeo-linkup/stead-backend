// src/middleware/auth.js
// Verifies the JWT on the Authorization header and attaches req.user.
// Also re-checks that the underlying code is still active, so that
// revoking a code (codes.routes.js) signs everyone out on their very
// next request, per the blueprint's Section 5 spec — a JWT alone can't
// reflect that, so this does one lightweight DB lookup per request.
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }

  if (payload.type !== 'full') {
    return res.status(401).json({ error: 'This token cannot be used to authenticate requests.' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.role, u.district_id, u.organization_id, u.code_id, u.password_changed_at, c.active AS code_active, c.all_districts,
              (SELECT array_agg(cd.district_id ORDER BY cd.district_id) FROM code_districts cd WHERE cd.code_id = c.id) AS code_district_ids,
              o.status AS organization_status
       FROM users u
       LEFT JOIN codes c ON c.id = u.code_id
       LEFT JOIN organizations o ON o.id = u.organization_id
       WHERE u.id = $1`,
      [payload.user_id]
    );

    const row = rows[0];
    if (!row) {
      return res.status(401).json({ error: 'User not found.' });
    }

    // If the password changed after this token was issued, sign out.
    if (row.password_changed_at && payload.iat < Math.floor(row.password_changed_at / 1000)) {
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }

    // If user has a code_id, check that the code is still active
    if (row.code_id !== null && !row.code_active) {
      return res.status(401).json({ error: 'Your access code has been revoked.' });
    }

    // If user has no organization_id, reject
    if (row.organization_id === null) {
      return res.status(403).json({ error: 'Your account is not linked to an organisation.' });
    }

    // If organisation is suspended, reject
    if (row.organization_status === 'suspended') {
      return res.status(403).json({ error: 'This account is suspended. Please contact support.', code: 'ORG_SUSPENDED' });
    }

    // Determine district_ids based on role and code configuration
    let allDistricts = false;
    let districtIds = [];

    if (row.role === 'admin' && row.code_id !== null) {
      allDistricts = row.all_districts === true;
      if (allDistricts) {
        // Admin with all_districts: will be resolved live in scope.js
        districtIds = [];
      } else if (row.code_district_ids && row.code_district_ids.length > 0) {
        // Admin with specific districts from code_districts
        districtIds = row.code_district_ids;
      } else {
        // Legacy admin: no code_districts rows, use codes.district_id
        districtIds = [row.district_id];
      }
    } else {
      // All other roles: single district
      districtIds = [row.district_id];
    }

    // If req.user.district_id is not in district_ids, adjust for this request
    if (!districtIds.includes(row.district_id) && districtIds.length > 0) {
      row.district_id = districtIds[0];
    }

    req.user = {
      user_id: row.id,
      role: row.role,
      district_id: row.district_id,
      organization_id: row.organization_id,
      all_districts: allDistricts,
      district_ids: districtIds,
    };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = auth;
