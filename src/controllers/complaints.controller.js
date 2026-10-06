const crypto = require('crypto');
const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { allowedDistrictIds, assertDistrictAccess } = require('../utils/scope');

function createTrackingCode() {
	return `CMP-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

function parseId(raw) {
	const id = Number(raw);
	return Number.isInteger(id) && id > 0 ? id : null;
}

function redact(row) {
	if (row.is_anonymous) {
		row.submitted_by = null;
		row.submitted_by_name = null;
		row.unit_id = null;
		row.unit_number = null;
		row.property_name = null;
	}
	return row;
}

async function createComplaint(req, res, next) {
	try {
		const { category, description, is_anonymous } = req.body;
		const anonymous = is_anonymous === true || is_anonymous === 'true';

		if (!category || typeof category !== 'string' || !category.trim()) {
			return res.status(400).json({ error: 'Category is required.' });
		}
		if (!description || typeof description !== 'string' || !description.trim()) {
			return res.status(400).json({ error: 'Description is required.' });
		}

		const unitResult = await pool.query(
			`SELECT u.id, p.district_id
			 FROM units u
			 JOIN properties p ON p.id = u.property_id
			 WHERE u.tenant_user_id = $1
			 ORDER BY u.id
			 LIMIT 1`,
			[req.user.user_id]
		);
		const unit = unitResult.rows[0];
		if (!unit) return res.status(400).json({ error: 'No unit assigned.' });

		let trackingCode;
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const candidate = createTrackingCode();
			const existing = await pool.query('SELECT 1 FROM complaints WHERE tracking_code = $1', [candidate]);
			if (!existing.rows[0]) {
				trackingCode = candidate;
				break;
			}
		}
		if (!trackingCode) return res.status(500).json({ error: 'Could not generate a tracking code.' });

		const { rows } = await pool.query(
			`INSERT INTO complaints (district_id, unit_id, submitted_by, is_anonymous, tracking_code, category, description)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)
			 RETURNING *`,
			[unit.district_id, unit.id, anonymous ? null : req.user.user_id, anonymous, trackingCode, category.trim(), description.trim()]
		);
		const complaint = rows[0];

		await writeAudit({
			actorId: anonymous ? null : req.user.user_id,
			actorRole: anonymous ? 'tenant' : req.user.role,
			districtId: anonymous ? null : unit.district_id,
			action: 'complaint.create',
			entityType: 'complaint',
			entityId: anonymous ? null : complaint.id,
			metadata: anonymous ? {} : { unit_id: complaint.unit_id, category: complaint.category },
		});

		res.status(201).json({
			...complaint,
			submitted_by: anonymous ? null : complaint.submitted_by,
			tracking_code: complaint.tracking_code,
		});
	} catch (err) {
		next(err);
	}
}

async function listComplaints(req, res, next) {
	try {
		const params = [];
		let districtFilter = '';
		let statusFilter = '';

		const districtIds = await allowedDistrictIds(req);
		params.push(districtIds);
		districtFilter = 'WHERE c.district_id = ANY($1::int[])';

		const { status } = req.query;
		if (status !== undefined && status !== null && status !== '') {
			if (status !== 'open' && status !== 'resolved') {
				return res.status(400).json({ error: 'Status must be "open" or "resolved".' });
			}
			const statusIndex = params.length + 1;
			statusFilter = districtFilter ? ` AND c.status = $${statusIndex}` : `WHERE c.status = $${statusIndex}`;
			params.push(status);
		}

		const { rows } = await pool.query(
			`SELECT c.id, c.district_id, c.unit_id, c.is_anonymous, c.tracking_code,
							c.category, c.description, c.status, c.created_at, c.resolved_at,
							CASE WHEN c.is_anonymous THEN NULL ELSE c.submitted_by END AS submitted_by,
							CASE WHEN c.is_anonymous THEN NULL ELSE u.name END AS submitted_by_name,
							CASE WHEN c.is_anonymous THEN NULL ELSE un.unit_number END AS unit_number,
							CASE WHEN c.is_anonymous THEN NULL ELSE pr.name END AS property_name
			 FROM complaints c
			 LEFT JOIN users u ON u.id = c.submitted_by
			 LEFT JOIN units un ON un.id = c.unit_id AND c.is_anonymous = false
			 LEFT JOIN properties pr ON pr.id = un.property_id
			 ${districtFilter}${statusFilter}
			 ORDER BY (c.status = 'open') DESC, c.created_at DESC`,
			params
		);

		res.json(rows.map(redact));
	} catch (err) {
		next(err);
	}
}

async function getComplaintStatus(req, res, next) {
	try {
		const { rows } = await pool.query(
			`SELECT c.tracking_code, c.category, c.description, c.status, c.created_at, c.resolved_at, c.district_id
			 FROM complaints c
			 WHERE c.tracking_code = $1`,
			[req.params.trackingCode]
		);
		const complaint = rows[0];
		if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });

		const allowed = await allowedDistrictIds(req);
		if (!allowed.includes(complaint.district_id)) {
			return res.status(404).json({ error: 'Complaint not found.' });
		}

		res.json({
			tracking_code: complaint.tracking_code,
			category: complaint.category,
			description: complaint.description,
			status: complaint.status,
			created_at: complaint.created_at,
			resolved_at: complaint.resolved_at,
		});
	} catch (err) {
		next(err);
	}
}

async function getComplaint(req, res, next) {
	try {
		const id = parseId(req.params.id);
		if (!id) return res.status(400).json({ error: 'Invalid id.' });

		const { rows } = await pool.query(
			`SELECT c.id, c.district_id, c.unit_id, c.is_anonymous, c.tracking_code,
							c.category, c.description, c.status, c.created_at, c.resolved_at,
							CASE WHEN c.is_anonymous THEN NULL ELSE c.submitted_by END AS submitted_by,
							CASE WHEN c.is_anonymous THEN NULL ELSE u.name END AS submitted_by_name,
							CASE WHEN c.is_anonymous THEN NULL ELSE un.unit_number END AS unit_number,
							CASE WHEN c.is_anonymous THEN NULL ELSE pr.name END AS property_name
			 FROM complaints c
			 LEFT JOIN users u ON u.id = c.submitted_by
			 LEFT JOIN units un ON un.id = c.unit_id AND c.is_anonymous = false
			 LEFT JOIN properties pr ON pr.id = un.property_id
			 WHERE c.id = $1`,
			[id]
		);
		const complaint = rows[0];
		if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });

		await assertDistrictAccess(req, complaint.district_id);

		res.json(redact(complaint));
	} catch (err) {
		next(err);
	}
}

async function resolveComplaint(req, res, next) {
	try {
		const id = parseId(req.params.id);
		if (!id) return res.status(400).json({ error: 'Invalid id.' });

		const { rows } = await pool.query(
			`SELECT id, district_id, is_anonymous FROM complaints WHERE id = $1`,
			[id]
		);
		const complaint = rows[0];
		if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });

		await assertDistrictAccess(req, complaint.district_id);

		const { rows: updated } = await pool.query(
			`UPDATE complaints SET status = 'resolved', resolved_at = now()
			 WHERE id = $1 AND status = 'open'
			 RETURNING *`,
			[id]
		);
		if (!updated[0]) return res.status(409).json({ error: 'This complaint is already resolved.' });

		await writeAudit({
			actorId: req.user.user_id,
			actorRole: req.user.role,
			districtId: complaint.district_id,
			organizationId: req.user.organization_id,
			action: 'complaint.resolve',
			entityType: 'complaint',
			entityId: complaint.is_anonymous ? null : complaint.id,
			metadata: {},
		});

		res.json(redact(updated[0]));
	} catch (err) {
		next(err);
	}
}

async function reopenComplaint(req, res, next) {
	try {
		const id = parseId(req.params.id);
		if (!id) return res.status(400).json({ error: 'Invalid id.' });

		const { rows } = await pool.query(
			`SELECT id, district_id, is_anonymous FROM complaints WHERE id = $1`,
			[id]
		);
		const complaint = rows[0];
		if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });

		await assertDistrictAccess(req, complaint.district_id);

		const { rows: updated } = await pool.query(
			`UPDATE complaints SET status = 'open', resolved_at = NULL
			 WHERE id = $1 AND status = 'resolved'
			 RETURNING *`,
			[id]
		);
		if (!updated[0]) return res.status(409).json({ error: 'This complaint is already open.' });

		await writeAudit({
			actorId: req.user.user_id,
			actorRole: req.user.role,
			districtId: complaint.district_id,
			organizationId: req.user.organization_id,
			action: 'complaint.reopen',
			entityType: 'complaint',
			entityId: complaint.is_anonymous ? null : complaint.id,
			metadata: {},
		});

		res.json(redact(updated[0]));
	} catch (err) {
		next(err);
	}
}

module.exports = { createComplaint, listComplaints, getComplaintStatus, getComplaint, resolveComplaint, reopenComplaint };
