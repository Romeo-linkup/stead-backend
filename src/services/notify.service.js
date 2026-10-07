// src/services/notify.service.js
// Generic notification helpers: recipient lookup, email rendering, per-user rate limiting.
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { sendMail } = require('./mailer.service');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 20;

const rateLimitMap = new Map();

function cleanRateLimitMap() {
  const now = Date.now();
  for (const [key, entries] of rateLimitMap.entries()) {
    const filtered = entries.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
    if (filtered.length === 0) {
      rateLimitMap.delete(key);
    } else {
      rateLimitMap.set(key, filtered);
    }
  }
}

setInterval(cleanRateLimitMap, 5 * 60 * 1000);

function checkRateLimit(userId) {
  const now = Date.now();
  const entries = rateLimitMap.get(userId) || [];
  const recent = entries.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    return false;
  }
  recent.push(now);
  rateLimitMap.set(userId, recent);
  return true;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, "'");
}

async function recipientsFor({ organizationId, districtId, roles, userIds }) {
  if (!organizationId) return [];

  const conditions = ['u.organization_id = $1', 'u.email IS NOT NULL', 'u.email_verified_at IS NOT NULL', 'u.email_notifications = true'];
  const values = [organizationId];
  let i = 2;

  if (userIds && userIds.length > 0) {
    conditions.push(`u.id = ANY($${i++}::int[])`);
    values.push(userIds);
  }

  const codeJoin = `
    LEFT JOIN codes c ON c.id = u.code_id
    WHERE ${conditions.join(' AND ')} AND (c.active = true OR c.id IS NULL)
  `;

  let roleFilter = '';
  if (roles && roles.length > 0) {
    const hasOwner = roles.includes('owner');
    const otherRoles = roles.filter(r => r !== 'owner');
    if (hasOwner && otherRoles.length === 0) {
      roleFilter = ' AND u.role = $${i++}';
      values.push('owner');
    } else if (!hasOwner && otherRoles.length > 0) {
      roleFilter = ` AND u.role = ANY($${i++}::text[]) AND u.district_id = $${i++}`;
      values.push(otherRoles, districtId);
    } else if (hasOwner && otherRoles.length > 0) {
      roleFilter = ` AND ((u.role = $${i++}) OR (u.role = ANY($${i++}::text[]) AND u.district_id = $${i++}))`;
      values.push('owner', otherRoles, districtId);
    }
  }

  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u.role
     FROM users u
     ${codeJoin}${roleFilter}`,
    values
  );
  return rows;
}

function renderEmail({ businessName, heading, lines, ctaLabel, ctaPath, ctaUrl: ctaUrlArg, unsubscribeUrl }) {
  const escapedBusiness = escapeHtml(businessName);
  const escapedHeading = escapeHtml(heading);
  const escapedLines = lines.map(escapeHtml);
  const escapedCtaLabel = escapeHtml(ctaLabel);
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const ctaUrl = ctaUrlArg || `${frontendUrl}/#${ctaPath}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedHeading}</title>
</head>
<body style="margin:0;padding:0;background:#F6F4EE;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1C2321;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F6F4EE;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#FFFFFF;border:1px solid #E5E2D8;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="padding:24px 24px 8px;background:#1C2321;color:#F6F4EE;">
              <div style="font-family:Georgia,serif;font-size:20px;font-weight:600;">${escapedBusiness}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:24px;">
              <h1 style="margin:0 0 16px;font-size:18px;font-weight:600;color:#1C2321;">${escapedHeading}</h1>
              ${escapedLines.map(line => `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#1C2321;">${line}</p>`).join('')}
              ${ctaLabel && (ctaPath || ctaUrlArg) ? `
                <table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0;">
                  <tr>
                    <td style="background:#A8823A;border-radius:4px;">
                      <a href="${ctaUrl}" target="_blank" style="display:inline-block;padding:12px 24px;color:#1C2321;text-decoration:none;font-weight:600;font-size:14px;font-family:inherit;">${escapedCtaLabel}</a>
                    </td>
                  </tr>
                </table>
              ` : ''}
            </td>
          </tr>
          <tr>
            <td style="padding:0 24px 24px;border-top:1px solid #E5E2D8;">
              <p style="margin:0 0 8px;font-size:12px;color:#8A8D86;">You get these emails because you have an account on Stead.</p>
              ${unsubscribeUrl ? `<p style="margin:0;font-size:12px;color:#8A8D86;"><a href="${unsubscribeUrl}" style="color:#A8823A;text-decoration:underline;">Unsubscribe</a></p>` : ''}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const text = [
    escapedHeading,
    '',
    ...escapedLines,
    '',
    ctaLabel ? `${escapedCtaLabel}: ${ctaUrl}` : '',
    '',
    'You get these emails because you have an account on Stead.',
    ...(unsubscribeUrl ? [`Unsubscribe: ${unsubscribeUrl}`] : []),
  ].filter(Boolean).join('\n');

  return { html, text };
}

function unsubscribeToken(userId) {
  return jwt.sign({ user_id: userId, purpose: 'unsub' }, process.env.JWT_SECRET, { expiresIn: '365d' });
}

function buildUnsubscribeUrl(userId, reqOrigin) {
  const base = process.env.BACKEND_PUBLIC_URL || reqOrigin || 'http://localhost:4000';
  const token = unsubscribeToken(userId);
  return `${base}/notifications/unsubscribe?token=${token}`;
}

async function notifyUsers(recipients, { subject, heading, lines, ctaLabel, ctaPath, businessName }) {
  for (const recipient of recipients) {
    try {
      if (!checkRateLimit(recipient.id)) {
        continue;
      }
      const unsubscribeUrl = buildUnsubscribeUrl(recipient.id);
      const { html, text } = renderEmail({
        businessName,
        heading,
        lines,
        ctaLabel,
        ctaPath,
        unsubscribeUrl,
      });
      await sendMail({
        to: recipient.email,
        subject,
        text,
        html,
      });
    } catch (err) {
      // Swallow errors, never log addresses
    }
  }
}

async function sendDirect({ to, subject, heading, lines, ctaLabel, ctaUrl, businessName, attachments }) {
  try {
    const { html, text } = renderEmail({ businessName, heading, lines, ctaLabel, ctaUrl });
    return await sendMail({ to, subject, text, html, attachments });
  } catch (err) {
    // Swallow errors, never log addresses
  }
}

async function sendVerificationEmail(userId) {
  try {
    const { rows } = await pool.query(
      `SELECT u.email, u.name, o.name AS organization
       FROM users u
       LEFT JOIN organizations o ON o.id = u.organization_id
       WHERE u.id = $1`,
      [userId]
    );
    const user = rows[0];
    if (!user || !user.email) return;

    const token = jwt.sign(
      { user_id: userId, email: user.email, purpose: 'verify-email' },
      process.env.JWT_SECRET,
      { expiresIn: '48h' }
    );
    const base = process.env.BACKEND_PUBLIC_URL || 'http://localhost:4000';
    const link = `${base}/notifications/verify?token=${token}`;

    await sendDirect({
      to: user.email,
      subject: 'Confirm your email for Stead',
      heading: 'Confirm your email',
      lines: ['This email confirms that you want to receive updates from Stead.'],
      ctaLabel: 'Confirm email',
      ctaUrl: link,
      businessName: user.organization || 'Stead',
    });
  } catch (err) {
    // Swallow errors, never log addresses
  }
}

module.exports = { recipientsFor, renderEmail, notifyUsers, unsubscribeToken, buildUnsubscribeUrl, sendDirect, sendVerificationEmail };