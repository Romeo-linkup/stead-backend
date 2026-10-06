// src/routes/notifications.routes.js
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { sendMail } = require('../services/mailer.service');
const { recipientsFor, notifyUsers, unsubscribeToken } = require('../services/notify.service');

const unsubscribeRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' },
});

const testRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many test emails. Try again later.' },
});

// GET /unsubscribe?token= - public, no auth
router.get('/unsubscribe', unsubscribeRateLimit, async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token || typeof token !== 'string') {
      return res.status(400).send(unsubscribePage('Invalid or missing token.'));
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(400).send(unsubscribePage('Invalid or expired token.'));
    }

    if (payload.purpose !== 'unsub' || !payload.user_id) {
      return res.status(400).send(unsubscribePage('Invalid token purpose.'));
    }

    await pool.query(
      'UPDATE users SET email_notifications = false WHERE id = $1',
      [payload.user_id]
    );

    res.send(unsubscribePage('You\'ve been unsubscribed from Stead emails. You can turn them back on in your profile.'));
  } catch (err) {
    next(err);
  }
});

// POST /test - owner only, auth required
router.post('/test', auth, requireRole('owner'), testRateLimit, async (req, res, next) => {
  try {
    const ownerId = req.user.user_id;

    const userResult = await pool.query(
      'SELECT email FROM users WHERE id = $1',
      [ownerId]
    );
    const user = userResult.rows[0];
    if (!user?.email) {
      return res.status(400).json({ error: 'Add an email address first.' });
    }

    const businessResult = await pool.query(
      'SELECT business_name FROM app_settings WHERE organization_id = $1',
      [req.user.organization_id]
    );
    const businessName = businessResult.rows[0]?.business_name || 'Your Property Business';

    const unsubscribeUrl = `${process.env.BACKEND_PUBLIC_URL || req.headers.origin || 'http://localhost:4000'}/notifications/unsubscribe?token=${unsubscribeToken(ownerId)}`;

    const { html, text } = require('../services/notify.service').renderEmail({
      businessName,
      heading: 'Test email from Stead',
      lines: ['This is a test email to verify your email configuration works correctly.'],
      ctaLabel: 'Open Dashboard',
      ctaPath: '/admin/overview',
      unsubscribeUrl,
    });

    const result = await sendMail({
      to: user.email,
      subject: 'Test email from Stead',
      text,
      html,
    });

    res.json({ sent: result.ok });
  } catch (err) {
    next(err);
  }
});

function unsubscribePage(message) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Stead - Unsubscribe</title>
</head>
<body style="margin:0;padding:40px 16px;background:#F6F4EE;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1C2321;display:flex;align-items:center;justify-content:center;min-height:100vh;">
  <div style="max-width:400px;background:#FFFFFF;border:1px solid #E5E2D8;border-radius:8px;padding:32px;text-align:center;">
    <div style="font-family:Georgia,serif;font-size:24px;font-weight:600;color:#1C2321;margin-bottom:16px;">Stead</div>
    <p style="font-size:16px;line-height:1.6;margin-bottom:24px;color:#1C2321;">${message}</p>
  </div>
</body>
</html>
  `.trim();
}

module.exports = router;