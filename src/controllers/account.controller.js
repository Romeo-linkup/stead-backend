// src/controllers/account.controller.js
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { orgId } = require('../utils/scope');
const { uploadReceipt: cloudinaryUploadReceipt, uploadImage: cloudinaryUploadImage } = require('../services/cloudinary.service');
const cloudinary = require('cloudinary').v2;

const DELETE_RATE_LIMIT = require('express-rate-limit')({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many deletion attempts. Try again later.' },
});

async function collectCloudinaryPublicIds(client, organizationId) {
  const publicIds = [];

  const receiptResult = await client.query(
    `SELECT pr.public_id FROM payment_receipts pr
     JOIN payments p ON p.id = pr.payment_id
     JOIN units u ON u.id = p.unit_id
     JOIN properties prop ON prop.id = u.property_id
     JOIN districts d ON d.id = prop.district_id
     WHERE d.organization_id = $1 AND pr.public_id IS NOT NULL`,
    [organizationId]
  );
  for (const row of receiptResult.rows) publicIds.push(row.public_id);

  const invoiceReceiptResult = await client.query(
    `SELECT ir.image_url FROM invoice_receipts ir
     JOIN invoices i ON i.id = ir.invoice_id
     WHERE i.district_id IN (SELECT id FROM districts WHERE organization_id = $1)`,
    [organizationId]
  );
  for (const row of invoiceReceiptResult.rows) {
    const url = row.image_url;
    const match = url?.match(/\/upload\/v\d+\/(.+)\.\w+$/);
    if (match) publicIds.push(match[1]);
  }

  const maintenanceResult = await client.query(
    `SELECT mr.before_photo_url, mr.after_photo_url FROM maintenance_requests mr
     JOIN units u ON u.id = mr.unit_id
     JOIN properties p ON p.id = u.property_id
     JOIN districts d ON d.id = p.district_id
     WHERE d.organization_id = $1`,
    [organizationId]
  );
  for (const row of maintenanceResult.rows) {
    for (const url of [row.before_photo_url, row.after_photo_url]) {
      const match = url?.match(/\/upload\/v\d+\/(.+)\.\w+$/);
      if (match) publicIds.push(match[1]);
    }
  }

  const leaseResult = await client.query(
    `SELECT l.signature_image_url, l.lessor_signature_url FROM leases l
     JOIN units u ON u.id = l.unit_id
     JOIN properties p ON p.id = u.property_id
     JOIN districts d ON d.id = p.district_id
     WHERE d.organization_id = $1`,
    [organizationId]
  );
  for (const row of leaseResult.rows) {
    for (const url of [row.signature_image_url, row.lessor_signature_url]) {
      const match = url?.match(/\/upload\/v\d+\/(.+)\.\w+$/);
      if (match) publicIds.push(match[1]);
    }
  }

  const savedSigResult = await client.query(
    `SELECT image_url FROM lessor_saved_signatures
     WHERE user_id IN (
       SELECT id FROM users WHERE organization_id = $1
     )`,
    [organizationId]
  );
  for (const row of savedSigResult.rows) {
    const url = row.image_url;
    const match = url?.match(/\/upload\/v\d+\/(.+)\.\w+$/);
    if (match) publicIds.push(match[1]);
  }

  return [...new Set(publicIds)];
}

async function deletionCheck(req, res, next) {
  try {
    const organizationId = orgId(req);

    const userResult = await pool.query(
      `SELECT u.id, u.role, u.code_id, c.active
       FROM users u
       LEFT JOIN codes c ON c.id = u.code_id
       WHERE u.organization_id = $1`,
      [organizationId]
    );

    let tenants = 0, serviceProviders = 0, propertyManagers = 0;
    for (const user of userResult.rows) {
      if (user.role === 'tenant' && user.code_id && user.active) tenants++;
      else if (user.role === 'service_provider' && user.code_id && user.active) serviceProviders++;
      else if (user.role === 'property_manager' && user.code_id && user.active) propertyManagers++;
    }

    const blockers = { tenants, service_providers: serviceProviders, property_managers: propertyManagers };
    const hasBlockers = tenants > 0 || serviceProviders > 0 || propertyManagers > 0;

    const stats = await pool.query(
      `SELECT 
         (SELECT count(*) FROM districts WHERE organization_id = $1) AS districts,
         (SELECT count(*) FROM properties p JOIN districts d ON d.id = p.district_id WHERE d.organization_id = $1) AS properties,
         (SELECT count(*) FROM units u JOIN properties p ON p.id = u.property_id JOIN districts d ON d.id = p.district_id WHERE d.organization_id = $1) AS units,
         (SELECT count(*) FROM users WHERE organization_id = $1 AND role = 'admin') AS admins,
         (SELECT count(*) FROM leases l JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id JOIN districts d ON d.id = p.district_id WHERE d.organization_id = $1) AS leases,
         (SELECT count(*) FROM payments pymt JOIN units u ON u.id = pymt.unit_id JOIN properties p ON p.id = u.property_id JOIN districts d ON d.id = p.district_id WHERE d.organization_id = $1) AS payments`,
      [organizationId]
    );

    res.json({
      can_delete: !hasBlockers,
      blockers: hasBlockers ? blockers : undefined,
      will_remove: stats.rows[0],
    });
  } catch (err) {
    next(err);
  }
}

async function deleteAccount(req, res, next) {
  const client = await pool.connect();
  let transactionStarted = false;
  let organizationId;

  try {
    const { password, confirm_name } = req.body || {};

    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Password is required.' });
    }
    if (!confirm_name || typeof confirm_name !== 'string') {
      return res.status(400).json({ error: 'Business name confirmation is required.' });
    }

    organizationId = orgId(req);

    const ownerResult = await pool.query(
      'SELECT id, password_hash FROM users WHERE organization_id = $1 AND role = $2',
      [organizationId, 'owner']
    );
    const owner = ownerResult.rows[0];
    if (!owner) return res.status(404).json({ error: 'Owner not found.' });

    const isValid = await bcrypt.compare(password, owner.password_hash);
    if (!isValid) return res.status(401).json({ error: 'Incorrect password.' });

    const settingsResult = await pool.query(
      'SELECT business_name FROM app_settings WHERE organization_id = $1',
      [organizationId]
    );
    const businessName = settingsResult.rows[0]?.business_name || '';
    if (confirm_name.trim().toLowerCase() !== businessName.trim().toLowerCase()) {
      return res.status(400).json({ error: 'Business name does not match.' });
    }

    const userResult = await pool.query(
      `SELECT u.id, u.role, u.code_id, c.active
       FROM users u
       LEFT JOIN codes c ON c.id = u.code_id
       WHERE u.organization_id = $1`,
      [organizationId]
    );

    let tenants = 0, serviceProviders = 0, propertyManagers = 0;
    for (const user of userResult.rows) {
      if (user.role === 'tenant' && user.code_id && user.active) tenants++;
      else if (user.role === 'service_provider' && user.code_id && user.active) serviceProviders++;
      else if (user.role === 'property_manager' && user.code_id && user.active) propertyManagers++;
    }

    if (tenants > 0 || serviceProviders > 0 || propertyManagers > 0) {
      return res.status(409).json({
        error: 'Remove all tenants, service providers and property managers first.',
        blockers: { tenants, service_providers: serviceProviders, property_managers: propertyManagers },
      });
    }

    const publicIds = await collectCloudinaryPublicIds(client, organizationId);

    await client.query('BEGIN');
    transactionStarted = true;

    await client.query(
      `DELETE FROM unit_assets
       WHERE unit_id IN (
         SELECT u.id FROM units u
         JOIN properties p ON p.id = u.property_id
         JOIN districts d ON d.id = p.district_id
         WHERE d.organization_id = $1
       )`,
      [organizationId]
    );

    await client.query(
      `DELETE FROM payment_receipts
       WHERE payment_id IN (
         SELECT p.id FROM payments p
         JOIN units u ON u.id = p.unit_id
         JOIN properties prop ON prop.id = u.property_id
         JOIN districts d ON d.id = prop.district_id
         WHERE d.organization_id = $1
       )`,
      [organizationId]
    );

    await client.query(
      `DELETE FROM payments
       WHERE unit_id IN (
         SELECT u.id FROM units u
         JOIN properties p ON p.id = u.property_id
         JOIN districts d ON d.id = p.district_id
         WHERE d.organization_id = $1
       )`,
      [organizationId]
    );

    await client.query(
      `DELETE FROM invoice_receipts
       WHERE invoice_id IN (
         SELECT id FROM invoices WHERE district_id IN (
           SELECT id FROM districts WHERE organization_id = $1
         )
       )`,
      [organizationId]
    );

    await client.query(
      `DELETE FROM invoice_items
       WHERE invoice_id IN (
         SELECT id FROM invoices WHERE district_id IN (
           SELECT id FROM districts WHERE organization_id = $1
         )
       )`,
      [organizationId]
    );

    await client.query(
      `DELETE FROM invoices
       WHERE district_id IN (SELECT id FROM districts WHERE organization_id = $1)`,
      [organizationId]
    );

    await client.query(
      `DELETE FROM maintenance_requests
       WHERE unit_id IN (
         SELECT u.id FROM units u
         JOIN properties p ON p.id = u.property_id
         JOIN districts d ON d.id = p.district_id
         WHERE d.organization_id = $1
       )`,
      [organizationId]
    );

    await client.query(
      `UPDATE leases SET supersedes_id = NULL, superseded_by = NULL
       WHERE unit_id IN (
         SELECT u.id FROM units u
         JOIN properties p ON p.id = u.property_id
         JOIN districts d ON d.id = p.district_id
         WHERE d.organization_id = $1
       )`,
      [organizationId]
    );

    await client.query(
      `DELETE FROM leases
       WHERE unit_id IN (
         SELECT u.id FROM units u
         JOIN properties p ON p.id = u.property_id
         JOIN districts d ON d.id = p.district_id
         WHERE d.organization_id = $1
       )`,
      [organizationId]
    );

    await client.query(
      `DELETE FROM complaints
       WHERE district_id IN (SELECT id FROM districts WHERE organization_id = $1)`,
      [organizationId]
    );

    await client.query(
      `DELETE FROM move_out_notices
       WHERE district_id IN (SELECT id FROM districts WHERE organization_id = $1)`,
      [organizationId]
    );

    await client.query(
      `DELETE FROM emergency_alerts
       WHERE unit_id IN (
         SELECT u.id FROM units u
         JOIN properties p ON p.id = u.property_id
         JOIN districts d ON d.id = p.district_id
         WHERE d.organization_id = $1
       )`,
      [organizationId]
    );

    await client.query(
      `DELETE FROM property_evaluations
       WHERE property_id IN (
         SELECT p.id FROM properties p
         JOIN districts d ON d.id = p.district_id
         WHERE d.organization_id = $1
       )`,
      [organizationId]
    );

    await client.query(
      `DELETE FROM district_info
       WHERE district_id IN (SELECT id FROM districts WHERE organization_id = $1)`,
      [organizationId]
    );

    await client.query(
      `DELETE FROM notices
       WHERE organization_id = $1`,
      [organizationId]
    );

    await client.query(
      `DELETE FROM audit_log
       WHERE organization_id = $1`,
      [organizationId]
    );

    await client.query(
      `DELETE FROM units
       WHERE property_id IN (
         SELECT p.id FROM properties p
         JOIN districts d ON d.id = p.district_id
         WHERE d.organization_id = $1
       )`,
      [organizationId]
    );

    await client.query(
      `DELETE FROM properties
       WHERE district_id IN (SELECT id FROM districts WHERE organization_id = $1)`,
      [organizationId]
    );

    await client.query(
      `DELETE FROM codes
       WHERE organization_id = $1`,
      [organizationId]
    );

    await client.query(
      `DELETE FROM users
       WHERE organization_id = $1`,
      [organizationId]
    );

    await client.query(
      `DELETE FROM lessor_saved_signatures
       WHERE user_id IN (SELECT id FROM users WHERE organization_id = $1)`,
      [organizationId]
    );

    await client.query(
      `DELETE FROM app_settings
       WHERE organization_id = $1`,
      [organizationId]
    );

    await client.query(
      `DELETE FROM districts
       WHERE organization_id = $1`,
      [organizationId]
    );

    await client.query(
      `DELETE FROM organizations
       WHERE id = $1`,
      [organizationId]
    );

    await client.query('COMMIT');
    transactionStarted = false;

    if (publicIds.length > 0) {
      try {
        await cloudinary.api.delete_resources(publicIds);
        console.log(`[account deletion] Deleted ${publicIds.length} Cloudinary assets for org ${organizationId}`);
      } catch (err) {
        console.log(`[account deletion] Cloudinary cleanup failed for org ${organizationId}: ${err.message}`);
      }
    } else {
      console.log(`[account deletion] No Cloudinary assets for org ${organizationId}`);
    }

    console.log(`[account deletion] Organization ${organizationId} deleted by owner ${owner.id}`);

    res.json({ deleted: true });
  } catch (err) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('[account deletion] Rollback failed:', rollbackErr.message);
      }
    }
    next(err);
  } finally {
    client.release();
  }
}

module.exports = { deletionCheck, deleteAccount, deleteRateLimit: DELETE_RATE_LIMIT };