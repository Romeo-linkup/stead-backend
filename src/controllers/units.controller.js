const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { allowedDistrictIds, assertDistrictAccess } = require('../utils/scope');

const UNIT_NUMBER_REGEX = /^[A-Za-z0-9][A-Za-z0-9 ._\/-]*$/;
const MAX_BULK_UNITS = 500;

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function validUnitNumber(value) {
  return typeof value === 'string'
    && value.trim().length >= 1
    && value.trim().length <= 20
    && UNIT_NUMBER_REGEX.test(value.trim());
}

function toRentAmount(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return null;
  return Number(num.toFixed(2));
}

function toDueDay(value) {
  if (value === undefined || value === null || value === '') return 1;
  const day = Number(value);
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : null;
}

async function listUnits(req, res, next) {
  try {
    const districtIds = await allowedDistrictIds(req);
    const { rows } = await pool.query(
      `SELECT u.id, u.property_id, p.name AS property_name, d.id AS district_id,
              d.name AS district_name, u.unit_number, u.rent_amount, u.rent_due_day,
              u.tenant_user_id, t.name AS tenant_name,
              EXISTS (
                SELECT 1 FROM codes c
                WHERE c.unit_id = u.id AND c.active = true AND c.role = 'tenant'
              ) AS has_active_tenant_code
       FROM units u
       JOIN properties p ON p.id = u.property_id
       JOIN districts d ON d.id = p.district_id
       LEFT JOIN users t ON t.id = u.tenant_user_id
       WHERE p.district_id = ANY($1::int[])
       ORDER BY p.name, u.unit_number`,
      [districtIds]
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function resolveProperty(propertyId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.district_id
     FROM properties p
     JOIN districts d ON d.id = p.district_id
     WHERE p.id = $1`,
    [propertyId]
  );
  return rows[0] || null;
}

async function createUnit(req, res, next) {
  try {
    const { property_id, unit_number, rent_amount, rent_due_day } = req.body;
    const propertyId = parseId(property_id);
    if (!propertyId) {
      return res.status(400).json({ error: 'property_id is required.' });
    }
    if (!validUnitNumber(unit_number)) {
      return res.status(400).json({ error: 'unit_number must be 1-20 characters matching /^[A-Za-z0-9][A-Za-z0-9 ._\\/-]*$/.' });
    }
    const rentValue = toRentAmount(rent_amount);
    if (rent_amount !== undefined && rent_amount !== null && rent_amount !== '' && rentValue === null) {
      return res.status(400).json({ error: 'rent_amount must be a non-negative number.' });
    }
    const dueDay = toDueDay(rent_due_day);
    if (dueDay === null) {
      return res.status(400).json({ error: 'rent_due_day must be an integer between 1 and 31.' });
    }

    const property = await resolveProperty(propertyId);
    if (!property) {
      return res.status(404).json({ error: 'Property not found.' });
    }
    await assertDistrictAccess(req, property.district_id);

    const trimmedNumber = unit_number.trim();
    let unit;
    try {
      const { rows } = await pool.query(
        `INSERT INTO units (property_id, unit_number, rent_amount, rent_due_day, updated_at)
         VALUES ($1, $2, $3, $4, now())
         RETURNING *`,
        [propertyId, trimmedNumber, rentValue, dueDay]
      );
      unit = rows[0];
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'A unit with this number already exists in that property.' });
      }
      throw err;
    }

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: property.district_id,
      organizationId: req.user.organization_id,
      action: 'unit.create',
      entityType: 'unit',
      entityId: unit.id,
      metadata: { property_id: unit.property_id, unit_number: unit.unit_number },
    });

    res.status(201).json(unit);
  } catch (err) {
    next(err);
  }
}

async function createUnitsBulk(req, res, next) {
  try {
    const { property_id, units, rent_amount, rent_due_day } = req.body;
    const propertyId = parseId(property_id);
    if (!propertyId) {
      return res.status(400).json({ error: 'property_id is required.' });
    }
    if (!Array.isArray(units) || units.length === 0) {
      return res.status(400).json({ error: 'units must be a non-empty array.' });
    }
    if (units.length > MAX_BULK_UNITS) {
      return res.status(400).json({ error: 'At most 500 units can be created at once.' });
    }
    const rentValue = toRentAmount(rent_amount);
    if (rent_amount !== undefined && rent_amount !== null && rent_amount !== '' && rentValue === null) {
      return res.status(400).json({ error: 'rent_amount must be a non-negative number.' });
    }
    const dueDay = toDueDay(rent_due_day);
    if (dueDay === null) {
      return res.status(400).json({ error: 'rent_due_day must be an integer between 1 and 31.' });
    }

    const property = await resolveProperty(propertyId);
    if (!property) {
      return res.status(404).json({ error: 'Property not found.' });
    }
    await assertDistrictAccess(req, property.district_id);

    const client = await pool.connect();
    let transactionStarted = false;
    let created = 0;
    const skipped = [];
    try {
      await client.query('BEGIN');
      transactionStarted = true;

      const existing = await client.query(
        'SELECT lower(unit_number) AS lower_number FROM units WHERE property_id = $1',
        [propertyId]
      );
      const existingNumbers = new Set(existing.rows.map((r) => r.lower_number));

      const seen = new Set();
      for (const raw of units) {
        if (!validUnitNumber(raw)) {
          await client.query('ROLLBACK');
          transactionStarted = false;
          return res.status(400).json({ error: 'unit_number must be 1-20 characters matching /^[A-Za-z0-9][A-Za-z0-9 ._\\/-]*$/.' });
        }
        const trimmed = raw.trim();
        const lower = trimmed.toLowerCase();
        if (seen.has(lower) || existingNumbers.has(lower)) {
          if (!skipped.includes(trimmed)) {
            skipped.push(trimmed);
          }
          continue;
        }
        seen.add(lower);
        await client.query(
          `INSERT INTO units (property_id, unit_number, rent_amount, rent_due_day, updated_at)
           VALUES ($1, $2, $3, $4, now())`,
          [propertyId, trimmed, rentValue, dueDay]
        );
        created++;
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
      districtId: property.district_id,
      organizationId: req.user.organization_id,
      action: 'unit.bulk_create',
      entityType: 'unit',
      entityId: null,
      metadata: { property_id: propertyId, created, skipped_count: skipped.length },
    });

    res.status(201).json({ created, skipped });
  } catch (err) {
    next(err);
  }
}

async function updateUnit(req, res, next) {
  try {
    const unitId = parseId(req.params.id);
    if (!unitId) {
      return res.status(400).json({ error: 'Invalid id.' });
    }

    const { unit_number, rent_amount, rent_due_day } = req.body;
    const trimmedNumber = typeof unit_number === 'string' ? unit_number.trim() : undefined;
    if (trimmedNumber !== undefined && !validUnitNumber(trimmedNumber)) {
      return res.status(400).json({ error: 'unit_number must be 1-20 characters matching /^[A-Za-z0-9][A-Za-z0-9 ._\\/-]*$/.' });
    }
    const rentValue = toRentAmount(rent_amount);
    if (rent_amount !== undefined && rent_amount !== null && rent_amount !== '' && rentValue === null) {
      return res.status(400).json({ error: 'rent_amount must be a non-negative number.' });
    }
    const dueDay = toDueDay(rent_due_day);
    if (dueDay === null) {
      return res.status(400).json({ error: 'rent_due_day must be an integer between 1 and 31.' });
    }

    const lookup = await pool.query(
      `SELECT u.*, p.district_id FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = $1`,
      [unitId]
    );
    const unit = lookup.rows[0];
    if (!unit) {
      return res.status(404).json({ error: 'Unit not found.' });
    }
    await assertDistrictAccess(req, unit.district_id);

    const updates = [];
    const values = [];
    let i = 1;
    if (trimmedNumber !== undefined) {
      updates.push(`unit_number = $${i++}`);
      values.push(trimmedNumber);
    }
    if (rent_amount !== undefined && rent_amount !== null && rent_amount !== '') {
      updates.push(`rent_amount = $${i++}`);
      values.push(rentValue);
    }
    if (rent_due_day !== undefined && rent_due_day !== null && rent_due_day !== '') {
      updates.push(`rent_due_day = $${i++}`);
      values.push(dueDay);
    }
    if (updates.length === 0) {
      return res.json(unit);
    }
    updates.push(`updated_at = $${i++}`);
    values.push(new Date());
    values.push(unitId);

    let updated;
    try {
      const { rows } = await pool.query(
        `UPDATE units SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
        values
      );
      updated = rows[0];
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'A unit with this number already exists in that property.' });
      }
      throw err;
    }

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: unit.district_id,
      organizationId: req.user.organization_id,
      action: 'unit.update',
      entityType: 'unit',
      entityId: unit.id,
      metadata: { unit_number: updated.unit_number },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
}

async function deleteUnit(req, res, next) {
  try {
    const unitId = parseId(req.params.id);
    if (!unitId) {
      return res.status(400).json({ error: 'Invalid id.' });
    }

    const lookup = await pool.query(
      `SELECT u.*, p.district_id FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = $1`,
      [unitId]
    );
    const unit = lookup.rows[0];
    if (!unit) {
      return res.status(404).json({ error: 'Unit not found.' });
    }
    await assertDistrictAccess(req, unit.district_id);

    if (unit.tenant_user_id !== null) {
      return res.status(409).json({ error: 'This unit has a tenant, leases or payment history.' });
    }

    const [leaseRows, paymentRows, maintenanceRows] = await Promise.all([
      pool.query('SELECT 1 FROM leases WHERE unit_id = $1 LIMIT 1', [unitId]),
      pool.query(
        `SELECT 1 FROM payments p WHERE p.unit_id = $1 LIMIT 1`,
        [unitId]
      ),
      pool.query('SELECT 1 FROM maintenance_requests WHERE unit_id = $1 LIMIT 1', [unitId]),
    ]);
    if (leaseRows.rows.length || paymentRows.rows.length || maintenanceRows.rows.length) {
      return res.status(409).json({ error: 'This unit has a tenant, leases or payment history.' });
    }

    const { rows } = await pool.query(
      'DELETE FROM units WHERE id = $1 RETURNING *',
      [unitId]
    );

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: unit.district_id,
      organizationId: req.user.organization_id,
      action: 'unit.delete',
      entityType: 'unit',
      entityId: unit.id,
      metadata: { unit_number: unit.unit_number },
    });

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function getUnit(req, res, next) {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      'SELECT u.*, p.district_id FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = $1',
      [id]
    );
    const unit = rows[0];

    if (!unit) {
      return res.status(404).json({ error: 'Unit not found.' });
    }

    if (req.user.role === 'service_provider') {
      return res.status(403).json({ error: 'You do not have access to that unit.' });
    }

    if (req.user.role === 'tenant') {
      if (unit.tenant_user_id !== req.user.user_id) {
        return res.status(403).json({ error: 'You do not have access to that unit.' });
      }
      return res.json(unit);
    }

    await assertDistrictAccess(req, unit.district_id);
    return res.json(unit);
  } catch (err) {
    next(err);
  }
}

async function getMyUnit(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.property_id, p.name AS property_name, u.unit_number,
              u.tenant_user_id, u.rent_amount, u.rent_due_day
       FROM units u
       JOIN properties p ON p.id = u.property_id
       WHERE u.tenant_user_id = $1`,
      [req.user.user_id]
    );
    const unit = rows[0];

    if (!unit) {
      return res.status(404).json({ error: 'No unit assigned to you.' });
    }

    res.json(unit);
  } catch (err) {
    next(err);
  }
}

module.exports = { listUnits, createUnit, createUnitsBulk, updateUnit, deleteUnit, getUnit, getMyUnit };
