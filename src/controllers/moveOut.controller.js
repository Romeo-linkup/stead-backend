const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');

const ACTIVE_STATUSES = ['submitted', 'acknowledged'];
const MOVE_OUT_STATUSES = ['submitted', 'acknowledged', 'withdrawn'];

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function makeUtcDate(year, month, day) {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month, day);
  return date;
}

function parseDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = makeUtcDate(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function formatDateOnly(date) {
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function earliestMoveOut(from, months) {
  const monthIndex = from.getUTCMonth() + months;
  const year = from.getUTCFullYear() + Math.floor(monthIndex / 12);
  const month = monthIndex % 12;
  const lastDay = makeUtcDate(year, month + 1, 0).getUTCDate();
  return formatDateOnly(makeUtcDate(year, month, Math.min(from.getUTCDate(), lastDay)));
}

function todayUtc() {
  const today = new Date();
  return makeUtcDate(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
}

async function getNoticePeriodMonths() {
  const { rows } = await pool.query('SELECT notice_period_months FROM app_settings WHERE id = 1');
  return rows[0]?.notice_period_months || 3;
}

async function submitMoveOutNotice(req, res, next) {
  try {
    const { rows: unitRows } = await pool.query(
      `SELECT u.id AS unit_id, p.district_id
       FROM units u
       JOIN properties p ON p.id = u.property_id
       WHERE u.tenant_user_id = $1
       ORDER BY u.id
       LIMIT 1`,
      [req.user.user_id]
    );
    const unit = unitRows[0];
    if (!unit) return res.status(404).json({ error: 'No unit is linked to your account' });
    if (!unit.district_id) return res.status(400).json({ error: 'Your unit is not linked to a district.' });

    const input = req.body || {};
    const intendedDate = parseDateOnly(input.intended_move_out_date);
    if (!intendedDate) {
      return res.status(400).json({ error: 'intended_move_out_date must be a real date in YYYY-MM-DD format.' });
    }
    if (input.reason != null && typeof input.reason !== 'string') {
      return res.status(400).json({ error: 'Reason must be a string.' });
    }
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length > 500) return res.status(400).json({ error: 'Reason must be 500 characters or fewer.' });

    const noticePeriodMonths = await getNoticePeriodMonths();
    const earliestDate = earliestMoveOut(todayUtc(), noticePeriodMonths);
    const intendedDateText = formatDateOnly(intendedDate);
    if (intendedDateText < earliestDate) {
      return res.status(400).json({
        error: `Your move-out date must be at least ${noticePeriodMonths} months from today (earliest: ${earliestDate}).`,
      });
    }

    let notice;
    try {
      const result = await pool.query(
        `INSERT INTO move_out_notices
           (unit_id, tenant_user_id, district_id, intended_move_out_date, reason)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, unit_id, tenant_user_id, district_id, intended_move_out_date,
                   reason, status, acknowledged_at, created_at`,
        [unit.unit_id, req.user.user_id, unit.district_id, intendedDateText, reason || null]
      );
      notice = result.rows[0];
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'You already have an active move-out notice.' });
      }
      throw err;
    }

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: unit.district_id,
      action: 'move_out.submit',
      entityType: 'move_out_notice',
      entityId: notice.id,
      metadata: { intended_move_out_date: intendedDateText },
    });

    res.status(201).json(notice);
  } catch (err) {
    next(err);
  }
}

async function getMyMoveOutNotice(req, res, next) {
  try {
    const [{ rows }, noticePeriodMonths] = await Promise.all([
      pool.query(
        `SELECT id, unit_id, tenant_user_id, district_id, intended_move_out_date,
                reason, status, acknowledged_by, acknowledged_at, created_at
         FROM move_out_notices
         WHERE tenant_user_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [req.user.user_id]
      ),
      getNoticePeriodMonths(),
    ]);
    res.json({ notice: rows[0] || null, notice_period_months: noticePeriodMonths });
  } catch (err) {
    next(err);
  }
}

async function withdrawMoveOutNotice(req, res, next) {
  try {
    const noticeId = parseId(req.params.id);
    if (!noticeId) return res.status(400).json({ error: 'Invalid move-out notice ID.' });

    const { rows: foundRows } = await pool.query(
      'SELECT id, status, intended_move_out_date, district_id FROM move_out_notices WHERE id = $1 AND tenant_user_id = $2',
      [noticeId, req.user.user_id]
    );
    const existing = foundRows[0];
    if (!existing) return res.status(404).json({ error: 'Move-out notice not found.' });
    if (!ACTIVE_STATUSES.includes(existing.status)) {
      return res.status(409).json({ error: 'This move-out notice can no longer be withdrawn.' });
    }

    const { rows } = await pool.query(
      `UPDATE move_out_notices SET status = 'withdrawn'
       WHERE id = $1 AND tenant_user_id = $2 AND status = ANY($3::text[])
       RETURNING id, status, intended_move_out_date, district_id, created_at`,
      [noticeId, req.user.user_id, ACTIVE_STATUSES]
    );
    if (!rows[0]) return res.status(409).json({ error: 'This move-out notice can no longer be withdrawn.' });

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: existing.district_id,
      action: 'move_out.withdraw',
      entityType: 'move_out_notice',
      entityId: noticeId,
      metadata: { intended_move_out_date: existing.intended_move_out_date },
    });

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function listMoveOutNotices(req, res, next) {
  try {
    const status = req.query.status || null;
    if (status && !MOVE_OUT_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid move-out notice status.' });
    }
    const districtId = req.user.role === 'owner' ? null : parseId(req.user.district_id);
    if (req.user.role !== 'owner' && !districtId) {
      return res.status(400).json({ error: 'Your account is not linked to a district.' });
    }

    const { rows } = await pool.query(
      `SELECT m.id, m.status, m.intended_move_out_date, m.reason, m.created_at,
              m.acknowledged_at, u.name AS tenant_name, un.unit_number,
              p.name AS property_name
       FROM move_out_notices m
       JOIN users u ON u.id = m.tenant_user_id
       JOIN units un ON un.id = m.unit_id
       JOIN properties p ON p.id = un.property_id
       WHERE ($1::integer IS NULL OR m.district_id = $1)
         AND ($2::text IS NULL OR m.status = $2)
       ORDER BY m.created_at DESC, m.id DESC`,
      [districtId, status]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function acknowledgeMoveOutNotice(req, res, next) {
  try {
    const noticeId = parseId(req.params.id);
    if (!noticeId) return res.status(400).json({ error: 'Invalid move-out notice ID.' });
    const districtId = req.user.role === 'owner' ? null : parseId(req.user.district_id);
    if (req.user.role !== 'owner' && !districtId) {
      return res.status(400).json({ error: 'Your account is not linked to a district.' });
    }

    const { rows: foundRows } = await pool.query(
      `SELECT id, status, district_id, intended_move_out_date
       FROM move_out_notices
       WHERE id = $1 AND ($2::integer IS NULL OR district_id = $2)`,
      [noticeId, districtId]
    );
    const existing = foundRows[0];
    if (!existing) return res.status(404).json({ error: 'Move-out notice not found.' });
    if (existing.status !== 'submitted') {
      return res.status(409).json({ error: 'Only submitted move-out notices can be acknowledged.' });
    }

    const { rows } = await pool.query(
      `UPDATE move_out_notices
       SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now()
       WHERE id = $1 AND status = 'submitted'
         AND ($3::integer IS NULL OR district_id = $3)
       RETURNING id, status, intended_move_out_date, acknowledged_at`,
      [noticeId, req.user.user_id, districtId]
    );
    if (!rows[0]) return res.status(409).json({ error: 'Only submitted move-out notices can be acknowledged.' });

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: existing.district_id,
      action: 'move_out.acknowledge',
      entityType: 'move_out_notice',
      entityId: noticeId,
      metadata: { intended_move_out_date: existing.intended_move_out_date },
    });

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  submitMoveOutNotice,
  getMyMoveOutNotice,
  withdrawMoveOutNotice,
  listMoveOutNotices,
  acknowledgeMoveOutNotice,
  earliestMoveOut,
};