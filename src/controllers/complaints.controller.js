const crypto = require('crypto');
const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');

function createTrackingCode() {
	return `CMP-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
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
		if (req.user.role !== 'owner') {
			params.push(req.user.district_id);
			districtFilter = 'WHERE c.district_id = $1';
		}

		const { rows } = await pool.query(
			`SELECT c.id, c.district_id, c.unit_id, c.is_anonymous, c.tracking_code,
							c.category, c.description, c.status, c.created_at, c.resolved_at,
							CASE WHEN c.is_anonymous THEN NULL ELSE c.submitted_by END AS submitted_by,
							CASE WHEN c.is_anonymous THEN NULL ELSE u.name END AS submitted_by_name
			 FROM complaints c
			 LEFT JOIN users u ON u.id = c.submitted_by
			 ${districtFilter}
			 ORDER BY c.created_at DESC`,
			params
		);

		res.json(rows);
	} catch (err) {
		next(err);
	}
}

async function getComplaintStatus(req, res, next) {
	try {
		const { rows } = await pool.query(
			`SELECT tracking_code, category, description, status, created_at, resolved_at
			 FROM complaints
			 WHERE tracking_code = $1`,
			[req.params.trackingCode]
		);
		const complaint = rows[0];
		if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });
		res.json(complaint);
	} catch (err) {
		next(err);
	}
}

module.exports = { createComplaint, listComplaints, getComplaintStatus };
