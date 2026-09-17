// src/controllers/leases.controller.js
const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { renderLeaseHtml } = require('../services/pdf.service');
const { uploadImage } = require('../services/cloudinary.service');

async function createLease(req, res, next) {
  try {
    const {
      unit_id,
      lessor_name,
      lessor_id_number,
      lessee_name,
      lessee_id_number,
      start_date,
      duration_months,
      end_date,
      rent_amount,
      rent_increase_pct,
      deposit_amount,
      cancellation_notice_days,
      cancellation_penalty,
      terms_json
    } = req.body;

    if (!unit_id) {
      return res.status(400).json({ error: 'unit_id is required.' });
    }
    if (!lessor_name || typeof lessor_name !== 'string' || !lessor_name.trim()) {
      return res.status(400).json({ error: 'lessor_name is required.' });
    }
    if (!lessor_id_number || typeof lessor_id_number !== 'string' || !lessor_id_number.trim()) {
      return res.status(400).json({ error: 'lessor_id_number is required.' });
    }
    if (!lessee_name || typeof lessee_name !== 'string' || !lessee_name.trim()) {
      return res.status(400).json({ error: 'lessee_name is required.' });
    }
    if (!lessee_id_number || typeof lessee_id_number !== 'string' || !lessee_id_number.trim()) {
      return res.status(400).json({ error: 'lessee_id_number is required.' });
    }
    if (!start_date) {
      return res.status(400).json({ error: 'start_date is required.' });
    }
    if (!duration_months || isNaN(duration_months)) {
      return res.status(400).json({ error: 'duration_months is required.' });
    }
    if (!end_date) {
      return res.status(400).json({ error: 'end_date is required.' });
    }
    if (!rent_amount || isNaN(rent_amount)) {
      return res.status(400).json({ error: 'rent_amount is required.' });
    }
    if (!deposit_amount || isNaN(deposit_amount)) {
      return res.status(400).json({ error: 'deposit_amount is required.' });
    }

    // Verify unit exists and get district_id
    const unitLookup = await pool.query(
      `SELECT u.*, p.district_id
       FROM units u
       JOIN properties p ON p.id = u.property_id
       WHERE u.id = $1`,
      [unit_id]
    );
    const unit = unitLookup.rows[0];

    if (!unit) {
      return res.status(404).json({ error: 'Unit not found.' });
    }

    // Parse terms_json if it's a string
    let parsedTerms = terms_json;
    if (typeof terms_json === 'string') {
      try {
        parsedTerms = JSON.parse(terms_json);
      } catch (err) {
        return res.status(400).json({ error: 'Invalid terms_json format.' });
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO leases (
         unit_id, lessor_name, lessor_id_number, lessee_name, lessee_id_number,
         start_date, duration_months, end_date, rent_amount, rent_increase_pct,
         deposit_amount, cancellation_notice_days, cancellation_penalty,
         terms_json, status, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'draft', $15)
       RETURNING *`,
      [
        unit_id,
        lessor_name.trim(),
        lessor_id_number.trim(),
        lessee_name.trim(),
        lessee_id_number.trim(),
        start_date,
        duration_months,
        end_date,
        rent_amount,
        rent_increase_pct || null,
        deposit_amount,
        cancellation_notice_days || null,
        cancellation_penalty || null,
        JSON.stringify(parsedTerms || {}),
        req.user.user_id
      ]
    );
    const lease = rows[0];

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: unit.district_id,
      action: 'lease.create',
      entityType: 'lease',
      entityId: lease.id,
      metadata: { unit_id: lease.unit_id, lessee_name: lease.lessee_name },
    });

    res.status(201).json(lease);
  } catch (err) {
    next(err);
  }
}

async function getLease(req, res, next) {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(
      `SELECT l.*, u.tenant_user_id, p.district_id
       FROM leases l
       JOIN units u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       WHERE l.id = $1`,
      [id]
    );
    const lease = rows[0];

    if (!lease) {
      return res.status(404).json({ error: 'Lease not found.' });
    }

    // Check authorization: admin can see all, tenant can only see their own unit's lease
    if (req.user.role !== 'owner' && req.user.role !== 'admin' && req.user.role !== 'property_manager') {
      if (req.user.role === 'tenant' && lease.tenant_user_id !== req.user.user_id) {
        return res.status(403).json({ error: 'You can only view your own lease.' });
      }
    }

    // Admin can only see leases in their district (unless owner)
    if (req.user.role === 'admin' || req.user.role === 'property_manager') {
      if (lease.district_id !== req.user.district_id) {
        return res.status(403).json({ error: 'You can only view leases in your district.' });
      }
    }

    // Render the lease HTML
    const html = renderLeaseHtml(lease);

    res.json({
      ...lease,
      rendered_html: html
    });
  } catch (err) {
    next(err);
  }
}

async function getMyLease(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT l.*, u.tenant_user_id, p.district_id
       FROM leases l
       JOIN units u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       WHERE u.tenant_user_id = $1
       ORDER BY l.created_at DESC
       LIMIT 1`,
      [req.user.user_id]
    );
    const lease = rows[0];

    if (!lease) {
      return res.status(404).json({ error: 'No lease found for your unit.' });
    }

    res.json({
      ...lease,
      rendered_html: renderLeaseHtml(lease)
    });
  } catch (err) {
    next(err);
  }
}

async function sendLease(req, res, next) {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(
      `SELECT l.*, u.tenant_user_id, p.district_id
       FROM leases l
       JOIN units u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       WHERE l.id = $1`,
      [id]
    );
    const lease = rows[0];

    if (!lease) {
      return res.status(404).json({ error: 'Lease not found.' });
    }

    // Only allow sending from draft status
    if (lease.status !== 'draft') {
      return res.status(409).json({ error: 'Lease can only be sent from draft status.' });
    }

    // Admin can only send leases in their district (unless owner)
    if (req.user.role === 'admin' || req.user.role === 'property_manager') {
      if (lease.district_id !== req.user.district_id) {
        return res.status(403).json({ error: 'You can only send leases in your district.' });
      }
    }

    const { rows: updatedRows } = await pool.query(
      `UPDATE leases SET status = 'sent' WHERE id = $1 RETURNING *`,
      [id]
    );
    const updatedLease = updatedRows[0];

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: lease.district_id,
      action: 'lease.send',
      entityType: 'lease',
      entityId: lease.id,
      metadata: { unit_id: lease.unit_id, lessee_name: lease.lessee_name },
    });

    res.json(updatedLease);
  } catch (err) {
    next(err);
  }
}

async function signLease(req, res, next) {
  try {
    const { id } = req.params;
    const { signature_data_url } = req.body;

    if (!signature_data_url || typeof signature_data_url !== 'string') {
      return res.status(400).json({ error: 'signature_data_url is required.' });
    }

    const { rows } = await pool.query(
      `SELECT l.*, u.tenant_user_id, p.district_id
       FROM leases l
       JOIN units u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
       WHERE l.id = $1`,
      [id]
    );
    const lease = rows[0];

    if (!lease) {
      return res.status(404).json({ error: 'Lease not found.' });
    }

    // Only allow signing from sent status
    if (lease.status !== 'sent') {
      return res.status(409).json({ error: 'Lease can only be signed when status is sent.' });
    }

    // Only the tenant on this unit can sign
    if (req.user.role !== 'tenant' || lease.tenant_user_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Only the tenant on this unit can sign the lease.' });
    }

    // Decode base64 data URL and convert to buffer
    const base64Data = signature_data_url.split(',')[1];
    const buffer = Buffer.from(base64Data, 'base64');

    // Upload signature to Cloudinary
    const signatureUrl = await uploadImage(buffer, 'stead/signatures');

    // Update lease with signature
    const { rows: updatedRows } = await pool.query(
      `UPDATE leases 
       SET status = 'signed', 
           signature_image_url = $1, 
           signed_at = now()
       WHERE id = $2 
       RETURNING *`,
      [signatureUrl, id]
    );
    const updatedLease = updatedRows[0];

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: lease.district_id,
      action: 'lease.sign',
      entityType: 'lease',
      entityId: lease.id,
      metadata: { unit_id: lease.unit_id, lessee_name: lease.lessee_name },
    });

    res.json(updatedLease);
  } catch (err) {
    next(err);
  }
}

async function listLeases(req, res, next) {
  try {
    const { unit_id } = req.query;

    let query = `
      SELECT l.*, u.tenant_user_id, p.district_id
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
    `;
    const params = [];

    if (unit_id) {
      query += ' WHERE l.unit_id = $1';
      params.push(unit_id);
    }

    query += ' ORDER BY l.created_at DESC';

    const { rows } = await pool.query(query, params);

    // Filter based on user role
    let filteredRows = rows;
    if (req.user.role === 'tenant') {
      filteredRows = rows.filter(lease => lease.tenant_user_id === req.user.user_id);
    } else if (req.user.role === 'admin' || req.user.role === 'property_manager') {
      filteredRows = rows.filter(lease => lease.district_id === req.user.district_id);
    }

    res.json(filteredRows);
  } catch (err) {
    next(err);
  }
}

module.exports = { createLease, getLease, getMyLease, sendLease, signLease, listLeases };
