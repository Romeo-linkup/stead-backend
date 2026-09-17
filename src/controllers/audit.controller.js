const pool = require('../db/pool');

async function listAudit(req, res, next) {
	try {
		const { district_id, actor_id, date_from, date_to } = req.query;
		const params = [];
		const conditions = [];

		if (req.user.role === 'owner') {
			if (district_id !== undefined) {
				const districtId = Number(district_id);
				if (!Number.isInteger(districtId) || districtId < 1) {
					return res.status(400).json({ error: 'district_id must be a positive integer.' });
				}
				params.push(districtId);
				conditions.push(`a.district_id = $${params.length}`);
			}
		} else {
			if (district_id !== undefined && Number(district_id) !== req.user.district_id) {
				return res.status(403).json({ error: 'You can only view audit entries in your district.' });
			}
			params.push(req.user.district_id);
			conditions.push(`a.district_id = $${params.length}`);
		}

		if (actor_id !== undefined) {
			const actorId = Number(actor_id);
			if (!Number.isInteger(actorId) || actorId < 1) {
				return res.status(400).json({ error: 'actor_id must be a positive integer.' });
			}
			params.push(actorId);
			conditions.push(`a.actor_id = $${params.length}`);
		}
		if (date_from) {
			params.push(date_from);
			conditions.push(`a.created_at >= $${params.length}::date`);
		}
		if (date_to) {
			params.push(date_to);
			conditions.push(`a.created_at < ($${params.length}::date + INTERVAL '1 day')`);
		}

		const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
		const { rows } = await pool.query(
			`SELECT a.*, u.name AS actor_name,
							COALESCE(u.role, a.actor_role) AS actor_role
			 FROM audit_log a
			 LEFT JOIN users u ON u.id = a.actor_id
			 ${where}
			 ORDER BY a.created_at DESC`,
			params
		);

		res.json(rows);
	} catch (err) {
		next(err);
	}
}

module.exports = { listAudit };
