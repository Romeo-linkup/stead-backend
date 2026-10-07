// src/services/mailer.service.js
// Minimal email sender with two providers and retry logic.
// Never throws; returns { ok: boolean }.

const RESEND_URL = 'https://api.resend.com/emails';
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

function parseFromEmail(from) {
  const match = from?.match(/^(.+?)\s*<(.+?)>$/);
  if (match) {
    return { name: match[1].trim(), email: match[2].trim() };
  }
  return { name: 'Stead', email: from || 'no-reply@example.com' };
}

async function fetchWithTimeout(url, options, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendMail({ to, subject, text, html, attachments }) {
  if (process.env.EMAIL_ENABLED !== 'true') {
    console.log('[mailer] email skipped');
    return { ok: false };
  }

  const MAX_ATTACHMENT_CHARS = 5000000;
  let sendAttachments = null;
  let attachmentsDropped = false;
  if (Array.isArray(attachments) && attachments.length > 0) {
    const totalChars = attachments.reduce((sum, a) => sum + String(a.contentBase64 || '').length, 0);
    if (totalChars > MAX_ATTACHMENT_CHARS) {
      console.log('[mailer] attachment too large, sent without');
      attachmentsDropped = true;
    } else {
      sendAttachments = attachments;
    }
  }

  const finish = (ok) => (attachmentsDropped ? { ok, attachmentsDropped: true } : { ok });

  const provider = process.env.EMAIL_PROVIDER || 'resend';

  if (provider === 'resend') {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM || 'Stead <no-reply@example.com>';

    if (!apiKey) {
      console.log('[mailer] resend: missing RESEND_API_KEY');
      return finish(false);
    }

    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchWithTimeout(RESEND_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from,
            to: [to],
            subject,
            html,
            text,
            ...(sendAttachments
              ? { attachments: sendAttachments.map((a) => ({ filename: a.filename, content: a.contentBase64 })) }
              : {}),
          }),
        });
        const status = res.status;
        if (status >= 500) {
          lastErr = new Error(`resend HTTP ${status}`);
          console.log(`[mailer] resend: ${status}`);
          continue;
        }
        if (status >= 400) {
          console.log(`[mailer] resend: ${status}`);
          return finish(false);
        }
        console.log('[mailer] resend: ok');
        return finish(true);
      } catch (err) {
        lastErr = err;
        console.log(`[mailer] resend: network error`);
      }
    }
    return finish(false);
  }

  if (provider === 'brevo') {
    const apiKey = process.env.BREVO_API_KEY;
    const from = process.env.EMAIL_FROM || 'Stead <no-reply@example.com>';
    const { name, email: fromEmail } = parseFromEmail(from);

    if (!apiKey) {
      console.log('[mailer] brevo: missing BREVO_API_KEY');
      return finish(false);
    }

    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchWithTimeout(BREVO_URL, {
          method: 'POST',
          headers: {
            'api-key': apiKey,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({
            sender: { name, email: fromEmail },
            to: [{ email: to }],
            subject,
            htmlContent: html,
            textContent: text,
            ...(sendAttachments
              ? { attachment: sendAttachments.map((a) => ({ name: a.filename, content: a.contentBase64 })) }
              : {}),
          }),
        });
        const status = res.status;
        if (status >= 500) {
          lastErr = new Error(`brevo HTTP ${status}`);
          console.log(`[mailer] brevo: ${status}`);
          continue;
        }
        if (status >= 400) {
          console.log(`[mailer] brevo: ${status}`);
          return finish(false);
        }
        console.log('[mailer] brevo: ok');
        return finish(true);
      } catch (err) {
        lastErr = err;
        console.log(`[mailer] brevo: network error`);
      }
    }
    return finish(false);
  }

  console.log(`[mailer] unknown provider: ${provider}`);
  return finish(false);
}

module.exports = { sendMail };