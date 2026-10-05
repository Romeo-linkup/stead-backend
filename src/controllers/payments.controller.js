// src/controllers/payments.controller.js
const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { uploadReceipt } = require('../services/cloudinary.service');
const { allowedDistrictIds, assertDistrictAccess } = require('../utils/scope');

const MAX_RECEIPTS_PER_PAYMENT = 3;

// Per-payment receipt list + count, attached to every payment row.
// An aggregate without GROUP BY always yields exactly one row, so the
// LATERAL join never drops a payment that has no receipts yet.
const RECEIPTS_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT json_agg(
             json_build_object('id', r.id, 'url', r.url, 'created_at', r.created_at)
             ORDER BY r.created_at DESC
           ) AS receipts,
           COUNT(*)::int AS receipt_count
    FROM payment_receipts r
    WHERE r.payment_id = p.id
  ) rc ON true`;

async function listPayments(req, res, next) {
  try {
    if (req.user.role === 'tenant') {
      const { rows } = await pool.query(
        `SELECT p.*,
                COALESCE(rc.receipts, '[]'::json) AS receipts,
                COALESCE(rc.receipt_count, 0) AS receipt_count
         FROM payments p
         JOIN units u ON u.id = p.unit_id
         ${RECEIPTS_LATERAL}
         WHERE u.tenant_user_id = $1
         ORDER BY p.due_date DESC, p.created_at DESC`,
        [req.user.user_id]
      );
      return res.json(rows);
    }

    const districtIds = await allowedDistrictIds(req);
    const { rows } = await pool.query(
      `SELECT p.*,
              COALESCE(rc.receipts, '[]'::json) AS receipts,
              COALESCE(rc.receipt_count, 0) AS receipt_count
       FROM payments p
       JOIN units u ON u.id = p.unit_id
       JOIN properties prop ON prop.id = u.property_id
       ${RECEIPTS_LATERAL}
       WHERE prop.district_id = ANY($1::int[])
       ORDER BY p.due_date DESC, p.created_at DESC`,
      [districtIds]
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

    await assertDistrictAccess(req, payment.district_id);

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
      organizationId: req.user.organization_id,
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

    await assertDistrictAccess(req, payment.district_id);

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
      organizationId: req.user.organization_id,
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

// Load a payment together with the tenant link and district of its unit.
async function loadPayment(paymentId) {
  const { rows } = await pool.query(
    `SELECT p.*, u.tenant_user_id, u.property_id, pr.district_id
     FROM payments p
     JOIN units u ON u.id = p.unit_id
     JOIN properties pr ON pr.id = u.property_id
     WHERE p.id = $1`,
    [paymentId]
  );
  return rows[0] || null;
}

// POST /payments/:id/receipts — a tenant uploads proof of payment,
// only while the payment has not been marked paid.
async function createReceipt(req, res, next) {
  try {
    const paymentId = Number(req.params.id);
    if (!Number.isInteger(paymentId) || paymentId < 1) {
      return res.status(400).json({ error: 'Invalid payment ID.' });
    }
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'A receipt file is required.' });
    }

    const payment = await loadPayment(paymentId);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found.' });
    }

    // The payment's unit must be the caller's own unit.
    if (payment.tenant_user_id !== req.user.user_id) {
      return res.status(403).json({ error: 'You can only upload receipts for your own payments.' });
    }

    // Only while it has not been marked paid.
    if (payment.status === 'paid') {
      return res.status(409).json({ error: 'This payment has already been marked as paid.' });
    }

    // At most 3 receipts per payment.
    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM payment_receipts WHERE payment_id = $1',
      [paymentId]
    );
    if (countRows[0].count >= MAX_RECEIPTS_PER_PAYMENT) {
      return res.status(409).json({ error: `This payment already has the maximum of ${MAX_RECEIPTS_PER_PAYMENT} receipts.` });
    }

    let uploaded;
    try {
      uploaded = await uploadReceipt(req.file.buffer, 'stead/receipts');
    } catch (err) {
      return res.status(400).json({ error: 'Receipt upload failed.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO payment_receipts (payment_id, url, public_id, uploaded_by, created_at)
       VALUES ($1, $2, $3, $4, now())
       RETURNING id, payment_id, url, created_at`,
      [paymentId, uploaded.url, uploaded.public_id, req.user.user_id]
    );
    const receipt = rows[0];

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: payment.district_id,
      organizationId: req.user.organization_id,
      action: 'payment.receipt_upload',
      entityType: 'payment_receipt',
      entityId: receipt.id,
      metadata: { payment_id: paymentId },
    });

    res.status(201).json(receipt);
  } catch (err) {
    next(err);
  }
}

// DELETE /payments/:id/receipts/:receiptId — a tenant removes their own
// receipt, only while the payment has not been marked paid.
async function deleteReceipt(req, res, next) {
  try {
    const paymentId = Number(req.params.id);
    const receiptId = Number(req.params.receiptId);
    if (!Number.isInteger(paymentId) || paymentId < 1 || !Number.isInteger(receiptId) || receiptId < 1) {
      return res.status(400).json({ error: 'Invalid ID.' });
    }

    const { rows: receiptRows } = await pool.query(
      `SELECT pr.id, pr.payment_id, pr.uploaded_by, pr.url, pr.created_at,
              p.status, p.tenant_user_id, p.property_id, pr2.district_id
       FROM payment_receipts pr
       JOIN payments p ON p.id = pr.payment_id
       JOIN units u ON u.id = p.unit_id
       JOIN properties pr2 ON pr2.id = u.property_id
       WHERE pr.id = $1 AND pr.payment_id = $2`,
      [receiptId, paymentId]
    );
    const receipt = receiptRows[0];

    if (!receipt) {
      return res.status(404).json({ error: 'Receipt not found.' });
    }

    // The payment's unit must be the caller's own unit.
    if (receipt.tenant_user_id !== req.user.user_id) {
      return res.status(403).json({ error: 'You can only manage receipts for your own payments.' });
    }

    // Only the caller's own receipt.
    if (receipt.uploaded_by !== req.user.user_id) {
      return res.status(403).json({ error: 'You can only remove your own receipts.' });
    }

    // Only while it has not been marked paid.
    if (receipt.status === 'paid') {
      return res.status(409).json({ error: 'This payment has already been marked as paid.' });
    }

    const { rows } = await pool.query(
      'DELETE FROM payment_receipts WHERE id = $1 RETURNING id, payment_id, url, created_at',
      [receiptId]
    );

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: receipt.district_id,
      organizationId: req.user.organization_id,
      action: 'payment.receipt_delete',
      entityType: 'payment_receipt',
      entityId: receiptId,
      metadata: { payment_id: paymentId },
    });

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = { listPayments, markPaid, markOutstanding, createReceipt, deleteReceipt };
