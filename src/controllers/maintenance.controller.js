const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { uploadImage } = require('../services/cloudinary.service');

async function listMaintenance(req, res, next) {
  try {
    if (req.user.role === 'tenant') {
      const { rows } = await pool.query(
        `SELECT mr.*, u.unit_number, p.name AS property_name
         FROM maintenance_requests mr
         JOIN units u ON u.id = mr.unit_id
         JOIN properties p ON p.id = u.property_id
         WHERE u.tenant_user_id = $1
         ORDER BY mr.created_at DESC`,
        [req.user.user_id]
      );
      return res.json(rows);
    }

    if (req.user.role === 'service_provider') {
      const { rows } = await pool.query(
        `SELECT mr.*, u.unit_number, p.name AS property_name
         FROM maintenance_requests mr
         JOIN units u ON u.id = mr.unit_id
         JOIN properties p ON p.id = u.property_id
         WHERE mr.assigned_to = $1
         ORDER BY mr.created_at DESC`,
        [req.user.user_id]
      );
      return res.json(rows);
    }

    if (req.user.role === 'owner') {
      const { rows } = await pool.query(
        `SELECT mr.*, u.unit_number, p.name AS property_name
         FROM maintenance_requests mr
         JOIN units u ON u.id = mr.unit_id
         JOIN properties p ON p.id = u.property_id
         ORDER BY mr.created_at DESC`
      );
      return res.json(rows);
    }

    const { rows } = await pool.query(
      `SELECT mr.*, u.unit_number, p.name AS property_name
       FROM maintenance_requests mr
       JOIN units u ON u.id = mr.unit_id
       JOIN properties p ON p.id = u.property_id
       WHERE p.district_id = $1
       ORDER BY mr.created_at DESC`,
      [req.user.district_id]
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function createMaintenance(req, res, next) {
  try {
    const { unit_id, category, description } = req.body;

    if (!unit_id) {
      return res.status(400).json({ error: 'unit_id is required.' });
    }
    if (!category || typeof category !== 'string' || !category.trim()) {
      return res.status(400).json({ error: 'Category is required.' });
    }
    if (!description || typeof description !== 'string' || !description.trim()) {
      return res.status(400).json({ error: 'Description is required.' });
    }

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
    if (unit.tenant_user_id !== req.user.user_id) {
      return res.status(403).json({ error: 'You can only create maintenance requests for your own unit.' });
    }

    let uploadedUrl = null;
    if (req.file) {
      try {
        uploadedUrl = await uploadImage(req.file.buffer, 'stead/maintenance');
      } catch (err) {
        return res.status(400).json({ error: 'Photo upload failed.' });
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO maintenance_requests (unit_id, reported_by, category, description, before_photo_url, status)
       VALUES ($1, $2, $3, $4, $5, 'outstanding')
       RETURNING *`,
      [unit.id, req.user.user_id, category.trim(), description.trim(), uploadedUrl]
    );
    const request = rows[0];

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: unit.district_id,
      action: 'maintenance.create',
      entityType: 'maintenance_request',
      entityId: request.id,
      metadata: { unit_id: request.unit_id, category: request.category },
    });

    res.status(201).json(request);
  } catch (err) {
    next(err);
  }
}

async function assignMaintenance(req, res, next) {
  try {
    const requestId = Number(req.params.id);
    const providerId = Number(req.body.assigned_to);

    if (!Number.isInteger(requestId) || requestId < 1) {
      return res.status(400).json({ error: 'A valid maintenance request ID is required.' });
    }
    if (!Number.isInteger(providerId) || providerId < 1) {
      return res.status(400).json({ error: 'assigned_to is required.' });
    }

    const requestResult = await pool.query(
      `SELECT mr.id, mr.unit_id, p.district_id
       FROM maintenance_requests mr
       JOIN units u ON u.id = mr.unit_id
       JOIN properties p ON p.id = u.property_id
       WHERE mr.id = $1`,
      [requestId]
    );
    const request = requestResult.rows[0];

    if (!request) {
      return res.status(404).json({ error: 'Maintenance request not found.' });
    }
    if (req.user.role !== 'owner' && request.district_id !== req.user.district_id) {
      return res.status(403).json({ error: 'You can only assign requests in your district.' });
    }

    const providerResult = await pool.query(
      `SELECT id FROM users
       WHERE id = $1 AND role = 'service_provider'
         AND ($2 = 'owner' OR district_id = $3)`,
      [providerId, req.user.role, req.user.district_id]
    );
    if (!providerResult.rows[0]) {
      return res.status(404).json({ error: 'Service provider not found.' });
    }

    const { rows } = await pool.query(
      `UPDATE maintenance_requests
       SET assigned_to = $1, status = CASE WHEN status = 'outstanding' THEN 'pending' ELSE status END, updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [providerId, requestId]
    );
    const updatedRequest = rows[0];

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: request.district_id,
      action: 'maintenance.assign',
      entityType: 'maintenance_request',
      entityId: requestId,
      metadata: { unit_id: request.unit_id, assigned_to: providerId },
    });

    res.json(updatedRequest);
  } catch (err) {
    next(err);
  }
}

async function acceptMaintenance(req, res, next) {
  try {
    const requestId = Number(req.params.id);
    const { rows } = await pool.query(
      `UPDATE maintenance_requests
       SET status = 'pending', updated_at = now()
      WHERE id = $1 AND assigned_to = $2 AND status = 'outstanding'
       RETURNING *`,
      [requestId, req.user.user_id]
    );
    const request = rows[0];

    if (!request) {
      return res.status(404).json({ error: 'Assigned maintenance request not found.' });
    }

    res.json(request);
  } catch (err) {
    next(err);
  }
}

async function completeMaintenance(req, res, next) {
  try {
    const requestId = Number(req.params.id);
    const requestResult = await pool.query(
      `SELECT mr.*, p.district_id
       FROM maintenance_requests mr
       JOIN units u ON u.id = mr.unit_id
       JOIN properties p ON p.id = u.property_id
       WHERE mr.id = $1 AND mr.assigned_to = $2`,
      [requestId, req.user.user_id]
    );
    const request = requestResult.rows[0];

    if (!request) {
      return res.status(404).json({ error: 'Assigned maintenance request not found.' });
    }
    if (request.status === 'finished') {
      return res.status(409).json({ error: 'Maintenance request is already finished.' });
    }

    let afterPhotoUrl = request.after_photo_url;
    if (req.file) {
      try {
        afterPhotoUrl = await uploadImage(req.file.buffer, 'stead/maintenance');
      } catch (err) {
        return res.status(400).json({ error: 'After photo upload failed.' });
      }
    }

    const { rows } = await pool.query(
      `UPDATE maintenance_requests
       SET status = 'finished', after_photo_url = $1, updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [afterPhotoUrl, requestId]
    );
    const updatedRequest = rows[0];

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: request.district_id,
      action: 'maintenance.complete',
      entityType: 'maintenance_request',
      entityId: requestId,
      metadata: { unit_id: request.unit_id, after_photo_url: afterPhotoUrl },
    });

    res.json(updatedRequest);
  } catch (err) {
    next(err);
  }
}

module.exports = { listMaintenance, createMaintenance, assignMaintenance, acceptMaintenance, completeMaintenance };
