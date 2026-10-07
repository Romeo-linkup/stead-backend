// src/controllers/leases.controller.js
const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { renderLeaseHtml } = require('../services/pdf.service');
const { buildLeasePdf } = require('../services/leasePdf.service');
const { sendDirect, recipientsFor } = require('../services/notify.service');
const { uploadImage } = require('../services/cloudinary.service');
const { allowedDistrictIds, assertDistrictAccess } = require('../utils/scope');

const EDITABLE_FIELDS = [
  'lessor_name', 'lessor_id_number', 'lessee_name', 'lessee_id_number',
  'start_date', 'duration_months', 'end_date', 'rent_amount', 'rent_increase_pct',
  'deposit_amount', 'cancellation_notice_days', 'cancellation_penalty', 'terms_json',
];
const REQUIRED_FIELDS = [
  'lessor_name', 'lessor_id_number', 'lessee_name', 'lessee_id_number',
  'start_date', 'duration_months', 'end_date', 'rent_amount', 'deposit_amount',
];
const TERM_TEXT_KEYS = [
  'additional_charges', 'payments', 'pets', 'assignment_subletting',
  'sundry_duties', 'maintenance', 'special_remedy', 'option_of_renewal',
];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function parseId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function readSignaturePng(dataUrl) {
  const invalid = () => {
    const error = new Error('Invalid signature image.');
    error.status = 400;
    return error;
  };
  if (typeof dataUrl !== 'string'
    || dataUrl.length > 1500000
    || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) {
    throw invalid();
  }

  const buffer = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
  if (buffer.length < 24
    || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)
    || buffer.readUInt32BE(8) !== 13
    || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw invalid();
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 20 || width > 3000 || height < 20 || height > 3000) throw invalid();
  return buffer;
}

function isIsoDate(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(new Date(value).getTime());
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function loadLease(id) {
  const { rows } = await pool.query(
    `SELECT l.*, l.start_date::text AS start_date_text, l.end_date::text AS end_date_text,
            u.unit_number, u.tenant_user_id, p.name AS property_name, p.district_id
     FROM leases l
     JOIN units u ON u.id = l.unit_id
     JOIN properties p ON p.id = u.property_id
     WHERE l.id = $1`,
    [id]
  );
  return rows[0] || null;
}

function assertScope(user, districtId) {
  if (user.role === 'owner') return true;
  return ['admin', 'property_manager'].includes(user.role)
    && districtId === user.district_id;
}

async function assertLeaseScope(req, districtId) {
  await assertDistrictAccess(req, districtId);
}

function isRealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function dateText(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === 'string' ? value.slice(0, 10) : '';
}

function validateLeaseFields(body, { partial, current = {} }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Lease fields must be provided as an object.' };
  }

  const values = {};
  for (const field of REQUIRED_FIELDS) {
    if (!partial && !Object.prototype.hasOwnProperty.call(body, field)) {
      return { error: `${field} is required.` };
    }
  }

  for (const field of ['lessor_name', 'lessor_id_number', 'lessee_name', 'lessee_id_number']) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    const value = body[field];
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) {
      return { error: `${field} must be a non-empty string of at most 120 characters.` };
    }
    values[field] = value.trim();
  }

  for (const field of ['start_date', 'end_date']) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    if (!isRealDate(body[field])) return { error: `${field} must be a real date in YYYY-MM-DD format.` };
    values[field] = body[field];
  }

  const numericRules = {
    duration_months: { integer: true, min: 1, max: 120 },
    rent_amount: { min: 0, exclusiveMin: true },
    deposit_amount: { min: 0 },
    rent_increase_pct: { min: 0, max: 100 },
    cancellation_notice_days: { integer: true, min: 0, max: 365 },
    cancellation_penalty: { min: 0 },
  };
  const nullableNumericFields = ['rent_increase_pct', 'cancellation_notice_days', 'cancellation_penalty'];
  for (const [field, rule] of Object.entries(numericRules)) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    const raw = body[field];
    if (raw === null && nullableNumericFields.includes(field)) {
      values[field] = null;
      continue;
    }
    if (raw === null) return { error: `${field} is invalid.` };
    if (typeof raw === 'string' && !raw.trim()) return { error: `${field} is invalid.` };
    const value = Number(raw);
    if (!Number.isFinite(value)
      || (rule.integer && !Number.isInteger(value))
      || (rule.exclusiveMin ? value <= rule.min : value < rule.min)
      || (rule.max !== undefined && value > rule.max)) {
      return { error: `${field} is invalid.` };
    }
    values[field] = value;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'terms_json')) {
    let terms = body.terms_json;
    if (typeof terms === 'string') {
      try {
        terms = JSON.parse(terms);
      } catch {
        return { error: 'Invalid terms_json format.' };
      }
    }
    if (!terms || typeof terms !== 'object' || Array.isArray(terms)) {
      return { error: 'Invalid terms_json format.' };
    }
    const cleanTerms = {};
    for (const key of TERM_TEXT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(terms, key)) continue;
      if (typeof terms[key] !== 'string' || terms[key].length > 3000) {
        return { error: `terms_json.${key} must be a string of at most 3000 characters.` };
      }
      cleanTerms[key] = terms[key];
    }
    if (Object.prototype.hasOwnProperty.call(terms, 'notice_period_months')) {
      const months = terms.notice_period_months;
      if (!Number.isInteger(months) || months < 1 || months > 12) {
        return { error: 'terms_json.notice_period_months must be an integer from 1 to 12.' };
      }
      cleanTerms.notice_period_months = months;
    }
    values.terms_json = cleanTerms;
  }

  const startDate = Object.prototype.hasOwnProperty.call(values, 'start_date')
    ? values.start_date
    : dateText(current.start_date);
  const endDate = Object.prototype.hasOwnProperty.call(values, 'end_date')
    ? values.end_date
    : dateText(current.end_date);
  if (startDate && endDate && endDate < startDate) {
    return { error: 'end_date must be on or after start_date.' };
  }

  return { values };
}

async function responseForScope(res, req, districtId, message = 'You can only manage leases in your district.') {
  try {
    await assertLeaseScope(req, districtId);
    return false;
  } catch (err) {
    if (err.status === 404) {
      res.status(404).json({ error: 'Not found.' });
      return true;
    }
    res.status(err.status || 403).json({ error: message });
    return true;
  }
}

async function createLease(req, res, next) {
  try {
    const unitId = parseId(req.body?.unit_id);
    if (!unitId) {
      return res.status(400).json({ error: req.body?.unit_id ? 'Invalid id.' : 'unit_id is required.' });
    }
    const unitLookup = await pool.query(
      `SELECT u.*, p.district_id
       FROM units u
       JOIN properties p ON p.id = u.property_id
       WHERE u.id = $1`,
      [unitId]
    );
    const unit = unitLookup.rows[0];
    if (!unit) return res.status(404).json({ error: 'Unit not found.' });
    if (await responseForScope(res, req, unit.district_id)) return;

    const existing = await pool.query(
      `SELECT id FROM leases WHERE unit_id = $1 AND status IN ('draft', 'sent', 'signed') LIMIT 1`,
      [unitId]
    );
    if (existing.rows[0]) {
      return res.status(409).json({ error: 'This unit already has a lease. Use Renew / amend on the signed lease, or finish the open draft.' });
    }

    const validation = validateLeaseFields(req.body, { partial: false });
    if (validation.error) return res.status(400).json({ error: validation.error });
    const values = validation.values;
    const terms = { ...(values.terms_json || {}) };
    if (!Object.prototype.hasOwnProperty.call(terms, 'pdf_template_version')) {
      terms.pdf_template_version = 1;
    }

    let rows;
    try {
      ({ rows } = await pool.query(
      `INSERT INTO leases (
         unit_id, lessor_name, lessor_id_number, lessee_name, lessee_id_number,
         start_date, duration_months, end_date, rent_amount, rent_increase_pct,
         deposit_amount, cancellation_notice_days, cancellation_penalty,
         terms_json, status, created_by, updated_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'draft', $15, $15)
       RETURNING *`,
      [
        unitId,
        values.lessor_name,
        values.lessor_id_number,
        values.lessee_name,
        values.lessee_id_number,
        values.start_date,
        values.duration_months,
        values.end_date,
        values.rent_amount,
        values.rent_increase_pct ?? null,
        values.deposit_amount,
        values.cancellation_notice_days ?? null,
        values.cancellation_penalty ?? null,
        JSON.stringify(terms),
        req.user.user_id
      ]
      ));
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'This unit already has a lease. Use Renew / amend on the signed lease, or finish the open draft.' });
      }
      throw err;
    }
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
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const lease = await loadLease(id);
    if (!lease) return res.status(404).json({ error: 'Lease not found.' });

    if (req.user.role === 'tenant' && lease.status === 'draft') {
      return res.status(404).json({ error: 'Lease not found.' });
    }
    if (req.user.role === 'tenant' && lease.tenant_user_id !== req.user.user_id) {
      return res.status(403).json({ error: 'You can only view your own lease.' });
    }
    if (req.user.role !== 'tenant') {
      await assertDistrictAccess(req, lease.district_id);
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
      WHERE u.tenant_user_id = $1 AND l.status <> 'draft'
      ORDER BY CASE l.status WHEN 'sent' THEN 0 WHEN 'signed' THEN 1 ELSE 2 END,
          l.created_at DESC
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

function sanitiseFilenamePart(value) {
  return String(value == null ? '' : value)
    .replace(/[^A-Za-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function leasePdfFilename(lease) {
  const property = sanitiseFilenamePart(lease.property_name) || 'property';
  const unit = sanitiseFilenamePart(lease.unit_number) || 'unit';
  return `Lease-${property}-${unit}.pdf`;
}

async function loadBusinessName(organizationId) {
  const { rows } = await pool.query(
    'SELECT business_name FROM app_settings WHERE organization_id = $1',
    [organizationId]
  );
  return rows[0]?.business_name || 'Stead';
}

function scopeLeaseForPdf(req, lease) {
  if (req.user.role === 'tenant') {
    // Tenants only reach a lease on their own unit.
    if (lease.tenant_user_id !== req.user.user_id) {
      const error = new Error('Lease not found.');
      error.status = 404;
      throw error;
    }
    return;
  }
  // Management: the lease's district must be in the caller's org.
  return assertDistrictAccess(req, lease.district_id);
}

async function getLeasePdf(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const lease = await loadLease(id);
    if (!lease) return res.status(404).json({ error: 'Lease not found.' });

    await scopeLeaseForPdf(req, lease);

    const buffer = await buildLeasePdf(id, req.user.organization_id);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${leasePdfFilename(lease)}"`);
    res.send(buffer);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
}

async function emailLeaseCopy(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const lease = await loadLease(id);
    if (!lease) return res.status(404).json({ error: 'Lease not found.' });

    await scopeLeaseForPdf(req, lease);

    const { rows: tenantRows } = await pool.query(
      'SELECT email, email_verified_at FROM users WHERE id = $1',
      [lease.tenant_user_id]
    );
    const tenantUser = tenantRows[0];
    if (!tenantUser?.email || !tenantUser.email_verified_at) {
      return res.status(400).json({
        error: req.user.role === 'tenant'
          ? 'Add and confirm your email in My profile first.'
          : 'The tenant has no confirmed email address.',
      });
    }

    const buffer = await buildLeasePdf(id, req.user.organization_id);
    const businessName = await loadBusinessName(req.user.organization_id);

    await sendDirect({
      to: tenantUser.email,
      subject: 'Your lease PDF',
      heading: 'Your lease',
      lines: [`Your lease for ${lease.property_name}, unit ${lease.unit_number} is attached.`],
      ctaLabel: 'Open Stead',
      ctaUrl: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/tenant/lease`,
      businessName,
      attachments: [{ filename: leasePdfFilename(lease), contentBase64: buffer.toString('base64') }],
    });

    res.json({ sent: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
}

// Counts only — never addresses, ids or lease details.
let signedLeaseEmailFailures = 0;
let leaseReadyEmailFailures = 0;

async function sendSignedLeaseEmail(lease, organizationId) {
  const { rows: tenantRows } = await pool.query(
    'SELECT email, email_verified_at FROM users WHERE id = $1',
    [lease.tenant_user_id]
  );
  const tenantUser = tenantRows[0];
  if (!tenantUser?.email || !tenantUser.email_verified_at) return;

  const buffer = await buildLeasePdf(lease.id, organizationId);
  const businessName = await loadBusinessName(organizationId);

  await sendDirect({
    to: tenantUser.email,
    subject: 'Your signed lease',
    heading: 'Your signed lease',
    lines: [
      `Your signed lease for ${lease.property_name}, unit ${lease.unit_number} is attached.`,
      'Keep this email for your records.',
    ],
    ctaLabel: 'Open Stead',
    ctaUrl: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/tenant/lease`,
    businessName,
    attachments: [{ filename: leasePdfFilename(lease), contentBase64: buffer.toString('base64') }],
  });
}

async function sendLeaseReadyEmail(lease, organizationId) {
  if (!lease.tenant_user_id) return;
  const businessName = await loadBusinessName(organizationId);
  const recipients = await recipientsFor({ organizationId, userIds: [lease.tenant_user_id] });
  for (const recipient of recipients) {
    await sendDirect({
      to: recipient.email,
      subject: 'A lease is ready for your signature',
      heading: 'A lease is ready for your signature',
      lines: [`Your lease for ${lease.property_name}, unit ${lease.unit_number} is ready for your signature.`],
      ctaLabel: 'Review and sign',
      ctaUrl: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/tenant/lease`,
      businessName,
    });
  }
}

async function sendLease(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const lease = await loadLease(id);
    if (!lease) return res.status(404).json({ error: 'Lease not found.' });
    if (await responseForScope(res, req, lease.district_id, 'You can only send leases in your district.')) return;

    // Only allow sending from draft status
    if (lease.status !== 'draft') {
      return res.status(409).json({ error: 'Lease can only be sent from draft status.' });
    }
    if (!lease.lessor_signature_url) {
      return res.status(409).json({ error: 'Sign the lease as lessor before sending it.' });
    }

    const { rows: updatedRows } = await pool.query(
      `UPDATE leases SET status = 'sent', updated_at = now()
       WHERE id = $1 AND status = 'draft' RETURNING *`,
      [id]
    );
    const updatedLease = updatedRows[0];
    if (!updatedLease) return res.status(409).json({ error: 'Lease can only be sent from draft status.' });

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

    setImmediate(() => sendLeaseReadyEmail(lease, req.user.organization_id).catch(() => {
      leaseReadyEmailFailures += 1;
      console.log(`[lease] lease-ready email failures: ${leaseReadyEmailFailures}`);
    }));
  } catch (err) {
    next(err);
  }
}

async function signLease(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const lease = await loadLease(id);
    if (!lease) return res.status(404).json({ error: 'Lease not found.' });

    // Only allow signing from sent status
    if (lease.status !== 'sent') {
      return res.status(409).json({ error: 'Lease can only be signed when status is sent.' });
    }

    // Only the tenant on this unit can sign
    if (req.user.role !== 'tenant' || lease.tenant_user_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Only the tenant on this unit can sign the lease.' });
    }
    if (!lease.lessor_signature_url) {
      return res.status(409).json({ error: 'The lessor has not signed this lease yet.' });
    }

    const signatureDataUrl = req.body?.signature_data_url;
    let buffer;
    try {
      buffer = readSignaturePng(signatureDataUrl);
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message });
    }
    const leaseUpdatedAt = req.body?.lease_updated_at;
    if (!isIsoDate(leaseUpdatedAt)) {
      return res.status(400).json({ error: 'lease_updated_at must be an ISO date string.' });
    }
    if (new Date(leaseUpdatedAt).getTime() !== new Date(lease.updated_at).getTime()) {
      return res.status(409).json({ error: 'This lease was changed after you opened it. Please reload the page and review it before signing.' });
    }

    const signatureUrl = await uploadImage(buffer, 'stead/signatures');
    const client = await pool.connect();
    let transactionStarted = false;
    let updatedLease;
    let supersededLeaseId = null;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      if (lease.supersedes_id) {
        const { rows: supersededRows } = await client.query(
          `UPDATE leases SET status = 'superseded', superseded_by = $1, updated_at = now(), updated_by = $2
           WHERE id = $3 AND status IN ('signed', 'expired')
           RETURNING id`,
          [id, req.user.user_id, lease.supersedes_id]
        );
        if (!supersededRows[0]) {
          await client.query('ROLLBACK');
          transactionStarted = false;
          return res.status(409).json({ error: 'The source lease changed before this renewal could be signed.' });
        }
        supersededLeaseId = supersededRows[0].id;
      }
      const { rows: updatedRows } = await client.query(
        `UPDATE leases
         SET status = 'signed', signature_image_url = $1, signed_at = now(), updated_at = now(), updated_by = $3
         WHERE id = $2 AND status = 'sent'
         RETURNING *`,
        [signatureUrl, id, req.user.user_id]
      );
      updatedLease = updatedRows[0];
      if (!updatedLease) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        return res.status(409).json({ error: 'Lease can only be signed when status is sent.' });
      }
      await client.query('COMMIT');
      transactionStarted = false;
    } catch (err) {
      if (transactionStarted) await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: lease.district_id,
      action: 'lease.sign',
      entityType: 'lease',
      entityId: lease.id,
      metadata: { unit_id: lease.unit_id, lessee_name: lease.lessee_name },
    });
    if (supersededLeaseId) {
      await writeAudit({
        actorId: req.user.user_id,
        actorRole: req.user.role,
        districtId: lease.district_id,
        action: 'lease.superseded',
        entityType: 'lease',
        entityId: supersededLeaseId,
        metadata: { superseded_by: updatedLease.id },
      });
    }

    res.json(updatedLease);

    setImmediate(() => sendSignedLeaseEmail(lease, req.user.organization_id).catch(() => {
      signedLeaseEmailFailures += 1;
      console.log(`[lease] signed-lease email failures: ${signedLeaseEmailFailures}`);
    }));
  } catch (err) {
    next(err);
  }
}

async function listLeases(req, res, next) {
  try {
    const { unit_id } = req.query;
    const conditions = [];
    const params = [];
    if (unit_id !== undefined) {
      const unitId = parseId(unit_id);
      if (!unitId) return res.status(400).json({ error: 'unit_id must be an integer.' });
      params.push(unitId);
      conditions.push(`l.unit_id = $${params.length}`);
    }
    if (req.user.role === 'tenant') {
      params.push(req.user.user_id);
      conditions.push(`u.tenant_user_id = $${params.length} AND l.status <> 'draft'`);
    } else {
      const districtIds = await allowedDistrictIds(req);
      params.push(districtIds);
      conditions.push(`p.district_id = ANY($${params.length}::int[])`);
    }
    let query = `
      SELECT l.*, u.tenant_user_id, p.district_id, u.unit_number, p.name AS property_name
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
    `;
    if (conditions.length) query += ` WHERE ${conditions.join(' AND ')}`;
    query += ' ORDER BY l.created_at DESC';

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function updateLease(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const lease = await loadLease(id);
    if (!lease) return res.status(404).json({ error: 'Lease not found.' });
    if (await responseForScope(res, req, lease.district_id)) return;
    if (lease.status !== 'draft' && lease.status !== 'sent') {
      return res.status(409).json({
        error: lease.status === 'signed'
          ? 'Signed leases are locked. Use Renew / amend to create a new version.'
          : 'This lease can no longer be edited.',
      });
    }

    const validation = validateLeaseFields(req.body, { partial: true, current: lease });
    if (validation.error) return res.status(400).json({ error: validation.error });
    const values = validation.values;
    if (Object.prototype.hasOwnProperty.call(values, 'terms_json')) {
      let existingTerms = lease.terms_json;
      if (typeof existingTerms === 'string') {
        try {
          existingTerms = JSON.parse(existingTerms);
        } catch {
          existingTerms = {};
        }
      }
      if (!existingTerms || typeof existingTerms !== 'object' || Array.isArray(existingTerms)) existingTerms = {};
      values.terms_json = { ...existingTerms, ...values.terms_json };
    }

    const suppliedFields = EDITABLE_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(values, field));
    const changedFields = suppliedFields.filter((field) => {
      if (['lessor_name', 'lessor_id_number', 'lessee_name', 'lessee_id_number'].includes(field)) {
        return String(values[field]).trim() !== String(lease[field] == null ? '' : lease[field]).trim();
      }
      if (field === 'start_date' || field === 'end_date') {
        const currentDate = field === 'start_date' ? lease.start_date_text : lease.end_date_text;
        return values[field] !== (currentDate || dateText(lease[field]));
      }
      if (field === 'terms_json') {
        let currentTerms = lease.terms_json;
        if (typeof currentTerms === 'string') {
          try {
            currentTerms = JSON.parse(currentTerms);
          } catch {
            currentTerms = {};
          }
        }
        if (!currentTerms || typeof currentTerms !== 'object' || Array.isArray(currentTerms)) currentTerms = {};
        return stableJson(values.terms_json) !== stableJson(currentTerms);
      }
      const currentValue = lease[field];
      if (values[field] == null || currentValue == null) return values[field] !== currentValue;
      return Number(values[field]) !== Number(currentValue);
    });
    if (!changedFields.length) return res.json(lease);

    const params = [];
    const assignments = changedFields.map((field) => {
      let value = values[field];
      if (field === 'terms_json') value = JSON.stringify(value);
      params.push(value);
      return `${field} = $${params.length}`;
    });
    const withdrawn = lease.status === 'sent';
    if (withdrawn) assignments.push("status = 'draft'");
    const lessorSignatureCleared = Boolean(
      lease.lessor_signature_url || lease.lessor_signed_at || lease.lessor_signed_by
    );
    assignments.push(
      'lessor_signature_url = NULL',
      'lessor_signed_at = NULL',
      'lessor_signed_by = NULL'
    );
    params.push(req.user.user_id);
    assignments.push(`updated_by = $${params.length}`, 'updated_at = now()');
    params.push(id);
    const { rows } = await pool.query(
      `UPDATE leases SET ${assignments.join(', ')}
       WHERE id = $${params.length} AND status IN ('draft', 'sent')
       RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(409).json({ error: 'The lease was signed before the update could be saved.' });

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: lease.district_id,
      action: 'lease.update',
      entityType: 'lease',
      entityId: id,
      metadata: {
        changed_fields: changedFields,
        withdrawn,
        lessor_signature_cleared: lessorSignatureCleared,
      },
    });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function deleteLease(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const lease = await loadLease(id);
    if (!lease) return res.status(404).json({ error: 'Lease not found.' });
    if (await responseForScope(res, req, lease.district_id)) return;
    if (lease.status !== 'draft') return res.status(409).json({ error: 'Only draft leases can be deleted.' });

    const { rows } = await pool.query(
      "DELETE FROM leases WHERE id = $1 AND status = 'draft' RETURNING id",
      [id]
    );
    if (!rows[0]) return res.status(409).json({ error: 'Only draft leases can be deleted.' });
    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: lease.district_id,
      action: 'lease.delete',
      entityType: 'lease',
      entityId: id,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function supersedeLease(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const lease = await loadLease(id);
    if (!lease) return res.status(404).json({ error: 'Lease not found.' });
    if (await responseForScope(res, req, lease.district_id)) return;
    if (!['signed', 'expired'].includes(lease.status)) {
      return res.status(409).json({ error: 'Only a signed or expired lease can be renewed or amended.' });
    }
    const openLease = await pool.query(
      "SELECT id FROM leases WHERE unit_id = $1 AND status IN ('draft', 'sent') LIMIT 1",
      [lease.unit_id]
    );
    if (openLease.rows[0]) {
      return res.status(409).json({ error: 'Finish or delete the open draft for this unit first.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO leases (
         unit_id, lessor_name, lessor_id_number, lessee_name, lessee_id_number,
         start_date, duration_months, end_date, rent_amount, rent_increase_pct,
         deposit_amount, cancellation_notice_days, cancellation_penalty,
         terms_json, status, created_by, updated_by, supersedes_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'draft', $15, $15, $16)
       RETURNING *`,
      [
        lease.unit_id, lease.lessor_name, lease.lessor_id_number, lease.lessee_name,
        lease.lessee_id_number, lease.start_date, lease.duration_months, lease.end_date,
        lease.rent_amount, lease.rent_increase_pct, lease.deposit_amount,
        lease.cancellation_notice_days, lease.cancellation_penalty,
        JSON.stringify(lease.terms_json || {}), req.user.user_id, lease.id,
      ]
    );
    const newLease = rows[0];
    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: lease.district_id,
      action: 'lease.supersede',
      entityType: 'lease',
      entityId: newLease.id,
      metadata: { supersedes_id: lease.id },
    });
    res.status(201).json(newLease);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Finish or delete the open draft for this unit first.' });
    }
    next(err);
  }
}

async function getSavedSignature(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT image_url FROM lessor_saved_signatures WHERE user_id = $1',
      [req.user.user_id]
    );
    res.json({ image_url: rows[0]?.image_url || null });
  } catch (err) {
    next(err);
  }
}

async function saveSignature(req, res, next) {
  try {
    let buffer;
    try {
      buffer = readSignaturePng(req.body?.signature_data_url);
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message });
    }
    const imageUrl = await uploadImage(buffer, 'stead/lessor-signatures');
    await pool.query(
      `INSERT INTO lessor_saved_signatures (user_id, image_url, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id)
       DO UPDATE SET image_url = EXCLUDED.image_url, updated_at = now()`,
      [req.user.user_id, imageUrl]
    );
    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: req.user.district_id,
      action: 'lease.saved_signature.set',
      entityType: 'lessor_saved_signature',
    });
    res.json({ image_url: imageUrl });
  } catch (err) {
    next(err);
  }
}

async function removeSavedSignature(req, res, next) {
  try {
    await pool.query('DELETE FROM lessor_saved_signatures WHERE user_id = $1', [req.user.user_id]);
    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: req.user.district_id,
      action: 'lease.saved_signature.remove',
      entityType: 'lessor_saved_signature',
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function lessorSignLease(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const lease = await loadLease(id);
    if (!lease) return res.status(404).json({ error: 'Lease not found.' });
    if (await responseForScope(res, req, lease.district_id)) return;

    const body = req.body || {};
    const hasSignatureData = Object.prototype.hasOwnProperty.call(body, 'signature_data_url');
    const useSaved = body.use_saved === true;
    if ((body.use_saved !== undefined && typeof body.use_saved !== 'boolean')
      || hasSignatureData === useSaved
      || (body.save_for_later !== undefined && typeof body.save_for_later !== 'boolean')) {
      return res.status(400).json({ error: 'Provide exactly one of signature_data_url or use_saved: true.' });
    }
    if (!isIsoDate(body.lease_updated_at)) {
      return res.status(400).json({ error: 'lease_updated_at must be an ISO date string.' });
    }
    if (!['draft', 'sent', 'signed'].includes(lease.status)) {
      return res.status(409).json({ error: 'This lease can no longer be signed by the lessor.' });
    }
    if (lease.lessor_signed_at != null) {
      return res.status(409).json({ error: 'The lessor has already signed this lease.' });
    }
    if (new Date(body.lease_updated_at).getTime() !== new Date(lease.updated_at).getTime()) {
      return res.status(409).json({ error: 'This lease was changed after you opened it. Please reload the page and review it before signing.' });
    }

    let imageUrl;
    let usedSaved = false;
    if (useSaved) {
      const saved = await pool.query(
        'SELECT image_url FROM lessor_saved_signatures WHERE user_id = $1',
        [req.user.user_id]
      );
      imageUrl = saved.rows[0]?.image_url;
      if (!imageUrl) return res.status(400).json({ error: 'No saved signature found.' });
      usedSaved = true;
    } else {
      let buffer;
      try {
        buffer = readSignaturePng(body.signature_data_url);
      } catch (error) {
        return res.status(error.status || 400).json({ error: error.message });
      }
      imageUrl = await uploadImage(buffer, 'stead/lessor-signatures');
      if (body.save_for_later === true) {
        await pool.query(
          `INSERT INTO lessor_saved_signatures (user_id, image_url, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (user_id)
           DO UPDATE SET image_url = EXCLUDED.image_url, updated_at = now()`,
          [req.user.user_id, imageUrl]
        );
      }
    }

    const { rows } = await pool.query(
      `UPDATE leases
       SET lessor_signature_url = $1, lessor_signed_at = now(), lessor_signed_by = $2,
           updated_at = now(), updated_by = $2
       WHERE id = $3 AND status IN ('draft', 'sent', 'signed') AND lessor_signed_at IS NULL
       RETURNING *`,
      [imageUrl, req.user.user_id, id]
    );
    const updatedLease = rows[0];
    if (!updatedLease) return res.status(409).json({ error: 'The lessor has already signed this lease.' });

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: lease.district_id,
      action: 'lease.lessor_sign',
      entityType: 'lease',
      entityId: lease.id,
      metadata: { unit_id: lease.unit_id, used_saved: usedSaved },
    });
    res.json(updatedLease);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createLease,
  getLease,
  getMyLease,
  getLeasePdf,
  emailLeaseCopy,
  sendLease,
  signLease,
  listLeases,
  updateLease,
  deleteLease,
  supersedeLease,
  getSavedSignature,
  saveSignature,
  removeSavedSignature,
  lessorSignLease,
};
