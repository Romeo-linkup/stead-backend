// src/controllers/settings.controller.js
const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');

async function getSettings(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT business_name, notice_period_months FROM app_settings WHERE id = 1');
    res.json(rows[0] || { business_name: 'Your Property Business', notice_period_months: 3 });
  } catch (err) {
    next(err);
  }
}

async function updateSettings(req, res, next) {
  try {
    const input = req.body || {};
    if (Object.prototype.hasOwnProperty.call(input, 'notice_period_months')) {
      if (Object.keys(input).length !== 1) {
        return res.status(400).json({ error: 'Update one setting at a time.' });
      }
      return updateNoticePeriod(req, res, next);
    }

    if (req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Only the owner can change the business name.' });
    }

    const { business_name } = input;
    if (typeof business_name !== 'string' || !business_name.trim()) {
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

async function updateNoticePeriod(req, res, next) {
  try {
    const { notice_period_months: noticePeriodMonths } = req.body || {};
    if (!Number.isInteger(noticePeriodMonths) || noticePeriodMonths < 1 || noticePeriodMonths > 12) {
      return res.status(400).json({ error: 'Notice period must be an integer from 1 to 12.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO app_settings (id, notice_period_months)
       VALUES (1, $1)
       ON CONFLICT (id)
       DO UPDATE SET notice_period_months = EXCLUDED.notice_period_months, updated_at = now()
       RETURNING notice_period_months`,
      [noticePeriodMonths]
    );

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: req.user.district_id,
      action: 'settings.notice_period',
      entityType: 'app_settings',
      entityId: 1,
      metadata: { notice_period_months: rows[0].notice_period_months },
    });

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = { getSettings, updateSettings, updateNoticePeriod };