const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');

async function listPayments(req, res, next) {
  try {
    if (req.user.role === 'tenant') {
      const { rows } = await pool.query(
        `SELECT p.*
         FROM payments p
         JOIN units u ON u.id = p.unit_id
         WHERE u.tenant_user_id = $1
         ORDER BY p.due_date DESC, p.created_at DESC`,
        [req.user.user_id]
      );
      return res.json(rows);
    }

    if (req.user.role === 'owner') {
      const { rows } = await pool.query('SELECT * FROM payments ORDER BY due_date DESC, created_at DESC');
      return res.json(rows);
    }

    const { rows } = await pool.query(
      `SELECT p.*
       FROM payments p
       JOIN units u ON u.id = p.unit_id
       JOIN properties pr ON pr.id = u.property_id
       WHERE pr.district_id = $1
       ORDER BY p.due_date DESC, p.created_at DESC`,
      [req.user.district_id]
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function markPaid(req, res, next) {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT p.*, u.property_id, pr.district_id
       FROM payments p
       JOIN units u ON u.id = p.unit_id
       JOIN properties pr ON pr.id = u.property_id
       WHERE p.id = $1`,
      [id]
    );
    const payment = rows[0];

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found.' });
    }

    if (payment.district_id !== req.user.district_id) {
      return res.status(403).json({ error: 'You do not have access to that payment.' });
    }

    const updated = await pool.query(
      `UPDATE payments
       SET status = 'paid', paid_at = now()
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: payment.district_id,
      action: 'payment.mark_paid',
      entityType: 'payment',
      entityId: payment.id,
      metadata: { amount: payment.amount, unit_id: payment.unit_id },
    });

    res.json(updated.rows[0]);
  } catch (err) {
    next(err);
  }
}

async function markOutstanding(req, res, next) {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT p.*, u.property_id, pr.district_id
       FROM payments p
       JOIN units u ON u.id = p.unit_id
       JOIN properties pr ON pr.id = u.property_id
       WHERE p.id = $1`,
      [id]
    );
    const payment = rows[0];

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found.' });
    }

    if (payment.district_id !== req.user.district_id) {
      return res.status(403).json({ error: 'You do not have access to that payment.' });
    }

    const updated = await pool.query(
      `UPDATE payments
       SET status = 'outstanding', paid_at = NULL
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: payment.district_id,
      action: 'payment.mark_outstanding',
      entityType: 'payment',
      entityId: payment.id,
      metadata: { amount: payment.amount, unit_id: payment.unit_id },
    });

    res.json(updated.rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = { listPayments, markPaid, markOutstanding };
