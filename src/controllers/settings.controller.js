// src/controllers/settings.controller.js
const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');

async function getSettings(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT business_name FROM app_settings WHERE id = 1');
    res.json(rows[0] || { business_name: 'Your Property Business' });
  } catch (err) {
    next(err);
  }
}

async function updateSettings(req, res, next) {
  try {
    const { business_name } = req.body;
    if (!business_name || !business_name.trim()) {
      return res.status(400).json({ error: 'Business name cannot be empty.' });
    }

    const { rows } = await pool.query(
      'UPDATE app_settings SET business_name = $1, updated_at = now() WHERE id = 1 RETURNING business_name',
      [business_name.trim()]
    );

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: req.user.district_id,
      action: 'settings.update_business_name',
      entityType: 'app_settings',
      entityId: 1,
      metadata: { business_name: rows[0].business_name },
    });

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = { getSettings, updateSettings };