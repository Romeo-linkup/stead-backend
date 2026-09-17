const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');

async function createEmergency(req, res, next) {
	try {
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

		const { rows } = await pool.query(
			`INSERT INTO emergency_alerts (unit_id, triggered_by, status)
			 VALUES ($1, $2, 'unacknowledged')
			 RETURNING *`,
			[unit.id, req.user.user_id]
		);
		const alert = rows[0];

		await writeAudit({
			actorId: req.user.user_id,
			actorRole: req.user.role,
			districtId: unit.district_id,
			action: 'emergency.trigger',
			entityType: 'emergency_alert',
			entityId: alert.id,
			metadata: { unit_id: unit.id },
		});

		res.status(201).json(alert);
	} catch (err) {
		next(err);
	}
}

async function listEmergency(req, res, next) {
	try {
		const params = [];
		let districtFilter = '';
		if (req.user.role !== 'owner') {
			params.push(req.user.district_id);
			districtFilter = `WHERE p.district_id = $${params.length}`;
		}

		const { rows } = await pool.query(
			`SELECT ea.*, u.unit_number, p.name AS property_name,
							trigger_user.name AS triggered_by_name,
							ack_user.name AS acknowledged_by_name
			 FROM emergency_alerts ea
			 JOIN units u ON u.id = ea.unit_id
			 JOIN properties p ON p.id = u.property_id
			 LEFT JOIN users trigger_user ON trigger_user.id = ea.triggered_by
			 LEFT JOIN users ack_user ON ack_user.id = ea.acknowledged_by
			 ${districtFilter}
			 ORDER BY CASE WHEN ea.status = 'unacknowledged' THEN 0 ELSE 1 END,
								ea.created_at DESC`,
			params
		);

		res.json(rows);
	} catch (err) {
		next(err);
	}
}

async function findAlertForAdmin(id, user) {
	const { rows } = await pool.query(
		`SELECT ea.*, p.district_id
		 FROM emergency_alerts ea
		 JOIN units u ON u.id = ea.unit_id
		 JOIN properties p ON p.id = u.property_id
		 WHERE ea.id = $1`,
		[id]
	);
	const alert = rows[0];

	if (!alert) return { error: { status: 404, message: 'Emergency alert not found.' } };
	if (user.role !== 'owner' && alert.district_id !== user.district_id) {
		return { error: { status: 403, message: 'You do not have access to that emergency alert.' } };
	}
	return { alert };
}

async function updateEmergencyStatus(req, res, next, status, action) {
	try {
		const alertId = Number(req.params.id);
		if (!Number.isInteger(alertId) || alertId < 1) {
			return res.status(400).json({ error: 'A valid emergency alert ID is required.' });
		}

		const result = await findAlertForAdmin(alertId, req.user);
		if (result.error) return res.status(result.error.status).json({ error: result.error.message });

		const update = await pool.query(
			`UPDATE emergency_alerts
			 SET status = $1,
					 acknowledged_by = $2,
					 acknowledged_at = now()
			 WHERE id = $3
			 RETURNING *`,
			[status, req.user.user_id, alertId]
		);
		const updatedAlert = update.rows[0];

		await writeAudit({
			actorId: req.user.user_id,
			actorRole: req.user.role,
			districtId: result.alert.district_id,
			action,
			entityType: 'emergency_alert',
			entityId: alertId,
			metadata: { previous_status: result.alert.status, status },
		});

		res.json(updatedAlert);
	} catch (err) {
		next(err);
	}
}

function acknowledgeEmergency(req, res, next) {
	return updateEmergencyStatus(req, res, next, 'acknowledged', 'emergency.acknowledge');
}

function resolveEmergency(req, res, next) {
	return updateEmergencyStatus(req, res, next, 'resolved', 'emergency.resolve');
}

module.exports = {
	createEmergency,
	listEmergency,
	acknowledgeEmergency,
	resolveEmergency,
};
