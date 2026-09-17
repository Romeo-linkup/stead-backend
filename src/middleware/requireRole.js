// src/middleware/requireRole.js
// requireRole(...roles) checks req.user.role is one of the allowed roles.
// requireDistrictAccess additionally checks district scoping: an owner
// bypasses it (sees every district), everyone else must match
// req.user.district_id against the district_id being acted on
// (from req.params.districtId, req.body.district_id, or req.query.district_id).

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do that.' });
    }
    next();
  };
}

function requireDistrictAccess(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
  if (req.user.role === 'owner') return next(); // owner sees all districts

  const targetDistrictId = Number(
    req.params.districtId ?? req.body.district_id ?? req.query.district_id
  );

  if (!targetDistrictId) {
    return res.status(400).json({ error: 'district_id is required.' });
  }
  if (req.user.district_id !== targetDistrictId) {
    return res.status(403).json({ error: 'You do not have access to that district.' });
  }
  next();
}

module.exports = { requireRole, requireDistrictAccess };
