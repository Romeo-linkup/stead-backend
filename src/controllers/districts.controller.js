// src/controllers/districts.controller.js
const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { validateDistrictName } = require('../utils/validators');

async function listDistricts(req, res, next) {
  try {
    // Owner sees all districts; admin/property_manager are scoped to
    // their own via requireDistrictAccess on the route, but listing is
    // still useful to them scoped to themselves — so filter here too.
    if (req.user.role === 'owner') {
      const { rows } = await pool.query('SELECT * FROM districts ORDER BY name');
      return res.json(rows);
    }
    const { rows } = await pool.query('SELECT * FROM districts WHERE id = $1', [req.user.district_id]);
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function createDistrict(req, res, next) {
  try {
    const { name } = req.body;
    const nameErr = validateDistrictName(name);
    if (nameErr) return res.status(400).json({ error: nameErr });

    const { rows } = await pool.query(
      'INSERT INTO districts (name) VALUES ($1) RETURNING *',
      [name.trim()]
    );
    const district = rows[0];

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: district.id,
      action: 'district.create',
      entityType: 'district',
      entityId: district.id,
      metadata: { name: district.name },
    });

    res.status(201).json(district);
  } catch (err) {
    next(err);
  }
}

module.exports = { listDistricts, createDistrict };
