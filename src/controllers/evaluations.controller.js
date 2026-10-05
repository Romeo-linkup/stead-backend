const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { allowedDistrictIds, assertDistrictAccess } = require('../utils/scope');

async function createEvaluation(req, res, next) {
	try {
		const propertyId = Number(req.body.property_id);
		const scoreInput = req.body.score_percent;
		const score = Number(scoreInput);
		const scoreText = typeof scoreInput === 'number' || typeof scoreInput === 'string'
			? String(scoreInput).trim()
			: '';
		let notes = req.body.notes;

		if (!Number.isInteger(propertyId) || propertyId < 1) {
			return res.status(400).json({ error: 'A valid property_id is required.' });
		}
		if (!Number.isFinite(score) || score < 0 || score > 100
			|| !/^-?(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(scoreText)) {
			return res.status(400).json({ error: 'score_percent must be between 0 and 100.' });
		}
		if (notes !== undefined && notes !== null && typeof notes !== 'string') {
			return res.status(400).json({ error: 'notes must be text.' });
		}
		if (typeof notes === 'string') {
			notes = notes.trim();
			if (notes.length > 500) return res.status(400).json({ error: 'notes must be 500 characters or fewer.' });
			if (!notes) notes = null;
		}

		const propertyResult = await pool.query(
			'SELECT id, district_id FROM properties WHERE id = $1',
			[propertyId]
		);
		const property = propertyResult.rows[0];
		if (!property) return res.status(404).json({ error: 'Property not found.' });

		await assertDistrictAccess(req, property.district_id);

		const { rows } = await pool.query(
			`INSERT INTO property_evaluations (property_id, evaluated_by, score_percent, notes)
			 VALUES ($1, $2, $3, $4)
			 RETURNING *`,
			[propertyId, req.user.user_id, score, notes]
		);
		const evaluation = rows[0];

		await writeAudit({
			actorId: req.user.user_id,
			actorRole: req.user.role,
			districtId: property.district_id,
			organizationId: req.user.organization_id,
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
		const districtIds = await allowedDistrictIds(req);
		const { rows } = await pool.query(
			`SELECT AVG(pe.score_percent) as average_score
			 FROM property_evaluations pe
			 JOIN properties p ON p.id = pe.property_id
			 WHERE p.district_id = ANY($1::int[])`,
			[districtIds]
		);

		const averageScore = rows[0]?.average_score || 0;
		res.json({ average_score: parseFloat(averageScore) });
	} catch (err) {
		next(err);
	}
}

async function getEvaluationSummary(req, res, next) {
	try {
		const districtIds = await allowedDistrictIds(req);
		const { rows } = await pool.query(
			`SELECT d.id AS district_id, d.name AS district_name,
			        COUNT(p.id)::int AS property_count,
			        COUNT(s.property_id)::int AS evaluated_count,
			        COALESCE(SUM(s.score_percent), 0) AS score_sum
			 FROM districts d
			 JOIN properties p ON p.district_id = d.id
			 LEFT JOIN property_current_score s ON s.property_id = p.id
			 WHERE d.id = ANY($1::int[])
			 GROUP BY d.id, d.name
			 ORDER BY d.name`,
			[districtIds]
		);

		const districts = rows.map((row) => {
			const propertyCount = Number(row.property_count);
			const evaluatedCount = Number(row.evaluated_count);
			const complete = propertyCount > 0 && evaluatedCount === propertyCount;
			return {
				district_id: row.district_id,
				district_name: row.district_name,
				property_count: propertyCount,
				evaluated_count: evaluatedCount,
				complete,
				average_score: complete
					? Number((Number(row.score_sum) / propertyCount).toFixed(1))
					: null,
			};
		});

		const propertyCount = districts.reduce((sum, district) => sum + district.property_count, 0);
		const evaluatedCount = districts.reduce((sum, district) => sum + district.evaluated_count, 0);
		const scoreSum = rows.reduce((sum, row) => sum + Number(row.score_sum), 0);
		const complete = propertyCount > 0 && evaluatedCount === propertyCount;

		res.json({
			districts,
			portfolio: {
				property_count: propertyCount,
				evaluated_count: evaluatedCount,
				complete,
				average_score: complete ? Number((scoreSum / propertyCount).toFixed(1)) : null,
			},
		});
	} catch (err) {
		next(err);
	}
}

module.exports = { createEvaluation, getAverageScore, getEvaluationSummary };
