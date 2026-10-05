const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { allowedDistrictIds, assertDistrictAccess } = require('../utils/scope');

async function listUnits(req, res, next) {
  try {
    const districtIds = await allowedDistrictIds(req);
    const { rows } = await pool.query(
      `SELECT u.id, u.property_id, p.name AS property_name, u.unit_number,
              u.tenant_user_id, u.rent_amount
       FROM units u
       JOIN properties p ON p.id = u.property_id
       WHERE p.district_id = ANY($1::int[])
       ORDER BY p.name, u.unit_number`,
      [districtIds]
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function createUnit(req, res, next) {
  try {
    const { property_id, unit_number, tenant_user_id, rent_amount, rent_due_day } = req.body;
    const propertyId = Number(property_id);
    const dueDay = rent_due_day === undefined || rent_due_day === null || rent_due_day === ''
      ? 1
      : Number(rent_due_day);

    if (!Number.isInteger(propertyId) || propertyId < 1) {
      return res.status(400).json({ error: 'property_id is required.' });
    }
    if (!unit_number || typeof unit_number !== 'string' || !unit_number.trim()) {
      return res.status(400).json({ error: 'unit_number is required.' });
    }
    if (rent_amount === undefined || rent_amount === null || rent_amount === '' || isNaN(rent_amount) || Number(rent_amount) < 0) {
      return res.status(400).json({ error: 'rent_amount must be a non-negative number.' });
    }
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
      return res.status(400).json({ error: 'rent_due_day must be an integer between 1 and 31.' });
    }

    const propertyResult = await pool.query(
      'SELECT id, district_id FROM properties WHERE id = $1',
      [propertyId]
    );
    const property = propertyResult.rows[0];

    if (!property) {
      return res.status(404).json({ error: 'Property not found.' });
    }

    await assertDistrictAccess(req, property.district_id);

    const tenantId = tenant_user_id === undefined || tenant_user_id === null || tenant_user_id === ''
      ? null
      : Number(tenant_user_id);

    if (tenantId !== null) {
      if (!Number.isInteger(tenantId) || tenantId < 1) {
        return res.status(400).json({ error: 'tenant_user_id must be a valid user ID.' });
      }

      const tenantResult = await pool.query(
        `SELECT id FROM users WHERE id = $1 AND role = 'tenant'`,
        [tenantId]
      );
      if (!tenantResult.rows[0]) {
        return res.status(404).json({ error: 'Tenant user not found.' });
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO units (property_id, unit_number, tenant_user_id, rent_amount, rent_due_day)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [propertyId, unit_number.trim(), tenantId, Number(rent_amount), dueDay]
    );
    const unit = rows[0];

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: property.district_id,
      organizationId: req.user.organization_id,
      action: 'unit.create',
      entityType: 'unit',
      entityId: unit.id,
      metadata: {
        property_id: unit.property_id,
        unit_number: unit.unit_number,
        tenant_user_id: unit.tenant_user_id,
      },
    });

    res.status(201).json(unit);
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

    if (req.user.role === 'owner') {
      await assertDistrictAccess(req, unit.district_id);
      return res.json(unit);
    }

    if (req.user.role === 'admin' || req.user.role === 'property_manager') {
      await assertDistrictAccess(req, unit.district_id);
      return res.json(unit);
    }

    return res.status(403).json({ error: 'You do not have access to that unit.' });
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

module.exports = { listUnits, createUnit, getUnit, getMyUnit };
