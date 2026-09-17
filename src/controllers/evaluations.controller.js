const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');

async function createEvaluation(req, res, next) {
	try {
		const propertyId = Number(req.body.property_id);
		const score = Number(req.body.score_percent);
		const notes = req.body.notes;

		if (!Number.isInteger(propertyId) || propertyId < 1) {
			return res.status(400).json({ error: 'A valid property_id is required.' });
		}
		if (!Number.isFinite(score) || score < 0 || score > 100) {
			return res.status(400).json({ error: 'score_percent must be between 0 and 100.' });
		}
		if (notes !== undefined && notes !== null && typeof notes !== 'string') {
			return res.status(400).json({ error: 'notes must be text.' });
		}

		const propertyResult = await pool.query(
			'SELECT id, district_id FROM properties WHERE id = $1',
			[propertyId]
		);
		const property = propertyResult.rows[0];
		if (!property) return res.status(404).json({ error: 'Property not found.' });

		if (req.user.role !== 'owner' && property.district_id !== req.user.district_id) {
			return res.status(403).json({ error: 'You can only evaluate properties in your district.' });
		}

		const { rows } = await pool.query(
			`INSERT INTO property_evaluations (property_id, evaluated_by, score_percent, notes)
			 VALUES ($1, $2, $3, $4)
			 RETURNING *`,
			[propertyId, req.user.user_id, score, notes ? notes.trim() : null]
		);
		const evaluation = rows[0];

		await writeAudit({
			actorId: req.user.user_id,
			actorRole: req.user.role,
			districtId: property.district_id,
			action: 'evaluation.create',
			entityType: 'property_evaluation',
			entityId: evaluation.id,
			metadata: { property_id: propertyId, score_percent: evaluation.score_percent },
		});

		res.status(201).json(evaluation);
	} catch (err) {
		next(err);
	}
}

async function getAverageScore(req, res, next) {
	try {
		const params = [];
		let districtFilter = '';

		if (req.user.role !== 'owner') {
			params.push(req.user.district_id);
			districtFilter = 'WHERE p.district_id = $1';
		}

		const { rows } = await pool.query(
			`SELECT AVG(pe.score_percent) as average_score
			 FROM property_evaluations pe
			 JOIN properties p ON p.id = pe.property_id
			 ${districtFilter}`,
			params
		);

		const averageScore = rows[0]?.average_score || 0;
		res.json({ average_score: parseFloat(averageScore) });
	} catch (err) {
		next(err);
	}
}

module.exports = { createEvaluation, getAverageScore };
