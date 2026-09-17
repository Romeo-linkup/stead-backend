const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');

async function createMessage(req, res, next) {
	try {
		const { recipient_scope, body, attachment_url } = req.body;
		if (!recipient_scope || typeof recipient_scope !== 'string' || !recipient_scope.trim()) {
			return res.status(400).json({ error: 'recipient_scope is required.' });
		}
		if (!body || typeof body !== 'string' || !body.trim()) {
			return res.status(400).json({ error: 'Message body is required.' });
		}

		const senderResult = await pool.query('SELECT id, district_id FROM users WHERE id = $1', [req.user.user_id]);
		const sender = senderResult.rows[0];
		if (!sender) return res.status(404).json({ error: 'Sender not found.' });

		const scope = recipient_scope.trim();
		if (scope !== 'district_admin' && !/^\d+$/.test(scope)) {
			return res.status(400).json({ error: 'recipient_scope must be district_admin or a user ID.' });
		}
		if (/^\d+$/.test(scope)) {
			const recipientResult = await pool.query(
				`SELECT id FROM users WHERE id = $1 AND district_id = $2`,
				[Number(scope), sender.district_id]
			);
			if (!recipientResult.rows[0]) return res.status(404).json({ error: 'Recipient not found in your district.' });
		}

		const { rows } = await pool.query(
			`INSERT INTO messages (sender_id, recipient_scope, body, attachment_url)
			 VALUES ($1, $2, $3, $4)
			 RETURNING *`,
			[sender.id, scope, body.trim(), attachment_url || null]
		);
		const message = rows[0];

		await writeAudit({
			actorId: req.user.user_id,
			actorRole: req.user.role,
			districtId: sender.district_id,
			action: 'message.create',
			entityType: 'message',
			entityId: message.id,
			metadata: { recipient_scope: message.recipient_scope },
		});

		res.status(201).json(message);
	} catch (err) {
		next(err);
	}
}

async function listMessages(req, res, next) {
	try {
		const isAdmin = ['owner', 'admin', 'property_manager'].includes(req.user.role);
		const { rows } = await pool.query(
			`SELECT m.*, s.name AS sender_name, s.role AS sender_role
			 FROM messages m
			 JOIN users s ON s.id = m.sender_id
			 WHERE s.district_id = $1
				 AND (
					 $3 = true
					 OR m.sender_id = $2
					 OR m.recipient_scope = $2::text
					 OR m.recipient_scope = 'district_admin'
				 )
			 ORDER BY m.created_at ASC`,
			[req.user.district_id, req.user.user_id, isAdmin]
		);

		res.json(rows);
	} catch (err) {
		next(err);
	}
}

module.exports = { listMessages, createMessage };
