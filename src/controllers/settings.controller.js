// src/controllers/settings.controller.js
const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');

async function getSettings(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT business_name, COALESCE(notice_period_months, 3)::integer AS notice_period_months
       FROM app_settings WHERE organization_id = $1`,
      [req.user.organization_id]
    );
    if (rows[0]) {
      res.json(rows[0]);
    } else {
      // Fallback for organizations without settings yet
      res.json({ business_name: 'Your Property Business', notice_period_months: 3 });
    }
  } catch (err) {
    next(err);
  }
}

async function updateSettings(req, res, next) {
  try {
    const input = req.body || {};
    if (Object.prototype.hasOwnProperty.call(input, 'notice_period_months')) {
      return res.status(400).json({ error: 'Use the dedicated notice-period setting route.' });
    }

    if (req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Only the owner can change the business name.' });
    }

    const { business_name } = input;
    if (typeof business_name !== 'string' || !business_name.trim()) {
      return res.status(400).json({ error: 'Business name cannot be empty.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO app_settings (business_name, notice_period_months, organization_id)
       VALUES ($1, 3, $2)
       ON CONFLICT (organization_id)
       DO UPDATE SET business_name = EXCLUDED.business_name, updated_at = now()
       RETURNING business_name`,
      [business_name.trim(), req.user.organization_id]
    );

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: req.user.district_id,
      organizationId: req.user.organization_id,
      action: 'settings.update_business_name',
      entityType: 'app_settings',
      entityId: req.user.organization_id,
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
      `INSERT INTO app_settings (notice_period_months, organization_id)
       VALUES ($1, $2)
       ON CONFLICT (organization_id)
       DO UPDATE SET notice_period_months = EXCLUDED.notice_period_months, updated_at = now()
       RETURNING notice_period_months`,
      [noticePeriodMonths, req.user.organization_id]
    );

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: req.user.district_id,
      organizationId: req.user.organization_id,
      action: 'settings.notice_period',
      entityType: 'app_settings',
      entityId: req.user.organization_id,
      metadata: { notice_period_months: rows[0].notice_period_months },
    });

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = { getSettings, updateSettings, updateNoticePeriod };