const CAMPAIGN = 'https://22.bjbeyond.it';
const PREFIX = '/api/first22';
const LIMIT = 22;
const HOUR = 60 * 60 * 1000;
const RESEND_AFTER = HOUR / 4;
const LINK_LIFETIME = 24 * HOUR;
const DELIVERY_RETENTION = 30 * 24 * HOUR;
const ACTION = 'first22_signup';

const responseHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex',
};

const requestSignup = `
  INSERT INTO first22 (email_key, email, language, token_hash, requested_at, expires_at)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6
  WHERE (SELECT COALESCE(MAX(slot), 0) FROM first22) < ?7
  ON CONFLICT (email_key) DO UPDATE SET
    email = excluded.email,
    language = excluded.language,
    token_hash = excluded.token_hash,
    requested_at = excluded.requested_at,
    expires_at = excluded.expires_at
  WHERE first22.slot IS NULL AND first22.requested_at <= ?8
  RETURNING email
`;

const assignSlot = `
  UPDATE first22
  SET slot = (SELECT COALESCE(MAX(slot), 0) + 1 FROM first22),
      confirmed_at = ?1
  WHERE token_hash = ?2 AND expires_at > ?1 AND slot IS NULL
    AND (SELECT COALESCE(MAX(slot), 0) FROM first22) < ?3
  RETURNING slot
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const frontend = env.SITE_ORIGIN || CAMPAIGN;
    const isTrustedOrigin = origin === frontend || origin === url.origin;
    const cors = isTrustedOrigin
      ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
      : { Vary: 'Origin' };
    const respond = (code, status = 200, extra = {}) =>
      Response.json({ code, ...extra }, { status, headers: { ...responseHeaders, ...cors } });

    try {
      if (!url.pathname.startsWith(PREFIX + '/')) return respond('missing', 404);
      const action = url.pathname.slice(PREFIX.length + 1);

      if (request.method === 'OPTIONS' && isTrustedOrigin && ['signup', 'confirm'].includes(action)) {
        return new Response(null, {
          status: 204,
          headers: {
            ...responseHeaders, ...cors,
            'Access-Control-Allow-Methods': 'POST',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        });
      }
      if (request.method === 'GET' && action === 'verify') {
        return confirmationPage(url.searchParams.get('lang') === 'en', frontend);
      }
      if (request.method === 'GET' && action === 'config') {
        if (env.ACCEPTING !== 'true' || !env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET ||
            !env.SIGNUPS || !env.MAILER || !env.MAIL_FROM || !env.API_ORIGIN) return respond('unavailable', 503);
        return await full(env) ? respond('closed') : respond('open', 200, { siteKey: env.TURNSTILE_SITE_KEY });
      }
      if (request.method !== 'POST' || !['signup', 'confirm'].includes(action)) return respond('missing', 404);
      if (!isTrustedOrigin) return respond('invalid', 403);
      const body = await readBody(request);
      if (!body) return respond('invalid', 400);
      if (action === 'confirm') return await confirmEmail(body, env, respond);
      if (env.ACCEPTING !== 'true') return respond('unavailable', 503);
      return await signup(body, env, respond, new URL(frontend).hostname);
    } catch {
      return respond('unavailable', 503);
    }
  },

  async scheduled(event, env) {
    const now = event.scheduledTime;
    await env.SIGNUPS.batch([
      env.SIGNUPS.prepare('DELETE FROM first22 WHERE slot IS NULL AND expires_at <= ?').bind(now),
      env.SIGNUPS.prepare('UPDATE first22 SET token_hash = NULL WHERE slot IS NOT NULL AND token_hash IS NOT NULL AND expires_at <= ?').bind(now),
      env.SIGNUPS.prepare('UPDATE first22 SET email = NULL, email_key = NULL WHERE slot IS NOT NULL AND email IS NOT NULL AND delivered_at <= ?').bind(now - DELIVERY_RETENTION),
    ]);
  },
};

async function readBody(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json' || !request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 4096) {
      await reader.cancel();
      return null;
    }
    raw += decoder.decode(value, { stream: true });
  }
  try { return JSON.parse(raw + decoder.decode()); } catch { return null; }
}

function emailKey(email) {
  const [local, domain] = email.toLowerCase().split('@');
  if (domain !== 'gmail.com' && domain !== 'googlemail.com') return email.toLowerCase();
  return local.split('+')[0].replaceAll('.', '') + '@gmail.com';
}

async function full(env) {
  return Boolean(await env.SIGNUPS.prepare('SELECT 1 FROM first22 WHERE slot = ?').bind(LIMIT).first());
}

async function digest(token) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function signup(body, env, respond, hostname) {
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const language = body.language === 'en' ? 'en' : 'it';
  if (email.length > 254 || !/^[^@\s<>",:;\\()[\]]{1,64}@[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+$/i.test(email) ||
      email.split('@')[0].startsWith('.') || email.split('@')[0].endsWith('.') || email.includes('..') ||
      body.privacy !== true || typeof body.challenge !== 'string' || body.challenge.length > 2048) {
    return respond('invalid', 400);
  }
  if (await full(env)) return respond('closed', 409);
  const challenge = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: body.challenge }),
  });
  if (!challenge.ok) return respond('unavailable', 503);
  const result = await challenge.json();
  if (!result.success || result.hostname !== hostname || result.action !== ACTION) return respond('challenge', 400);

  const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const tokenHash = await digest(token);
  const now = Date.now();
  const pending = await env.SIGNUPS.prepare(requestSignup)
    .bind(emailKey(email), email, language, tokenHash, now, now + LINK_LIFETIME, LIMIT, now - RESEND_AFTER).first();
  if (!pending) return await full(env) ? respond('closed', 409) : respond('check_email', 202);

  const link = new URL(PREFIX + '/verify', env.API_ORIGIN);
  link.searchParams.set('lang', language);
  link.hash = token;
  const english = language === 'en';
  try {
    await env.MAILER.send({
      from: { email: env.MAIL_FROM, name: 'BJ Beyond' },
      to: email,
      subject: english ? 'Confirm your email for The first 22 get 22' : 'Conferma la tua email per The first 22 get 22',
      text: english
        ? `Open this link and confirm your email within 24 hours. The first 22 confirmed readers get the free eBook at publication.\n\n${link}\n\nIf you did not request this, you can ignore this message.`
        : `Apri questo link e conferma l’email entro 24 ore. Le prime 22 persone che confermano ricevono l’eBook gratuito alla pubblicazione.\n\n${link}\n\nSe non hai fatto tu la richiesta, puoi ignorare questo messaggio.`,
    });
  } catch {
    await env.SIGNUPS.prepare('DELETE FROM first22 WHERE token_hash = ? AND slot IS NULL').bind(tokenHash).run();
    return respond('unavailable', 503);
  }
  return respond('check_email', 202);
}

async function confirmEmail(body, env, respond) {
  if (typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)) return respond('expired', 400);
  const tokenHash = await digest(body.token);
  const now = Date.now();
  const assigned = await env.SIGNUPS.prepare(assignSlot).bind(now, tokenHash, LIMIT).first();
  if (assigned) return respond('confirmed');
  const existing = await env.SIGNUPS.prepare('SELECT slot FROM first22 WHERE token_hash = ? AND expires_at > ?')
    .bind(tokenHash, now).first();
  if (existing?.slot) return respond('confirmed');
  if (!existing) return respond('expired', 400);
  return respond('closed', 409);
}

function confirmationPage(english, frontend) {
  const words = english ? {
    title: 'Confirm your email', button: 'Confirm my email', back: 'Back to the book',
    confirmed: 'Your place is confirmed. You’ll receive the free eBook by email at publication.',
    expired: 'This link is invalid or has expired. Request a new one on the book site.',
    closed: 'All 22 copies have been claimed.',
    unavailable: 'Confirmation is temporarily unavailable. Please try again.',
  } : {
    title: 'Conferma la tua email', button: 'Conferma la mia email', back: 'Torna al libro',
    confirmed: 'Il tuo posto è confermato. Riceverai l’eBook gratuito via email alla pubblicazione.',
    expired: 'Il link non è valido o è scaduto. Richiedine uno nuovo sul sito del libro.',
    closed: 'Tutte le 22 copie sono state assegnate.',
    unavailable: 'La conferma è temporaneamente indisponibile. Riprova.',
  };
  const nonce = crypto.randomUUID();
  const home = new URL(frontend).origin;
  return new Response(`<!doctype html>
<html lang="${english ? 'en' : 'it'}"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${words.title} | 22</title>
<style nonce="${nonce}">body{background:#111;color:#f5f1ea;font:1rem/1.6 system-ui;max-width:36rem;margin:12vh auto;padding:0 1.25rem}a{color:inherit}button{font:inherit;padding:.7rem 1rem;cursor:pointer}</style>
<main><p lang="en">The first 22 get 22</p><h1>${words.title}</h1>
<button type="button" disabled>${words.button}</button><p role="status"></p>
<p><a href="${home}/#first22">${words.back}</a></p></main>
<script nonce="${nonce}">
const button = document.querySelector('button');
const status = document.querySelector('[role=status]');
const words = ${JSON.stringify(words)};
const token = location.hash.slice(1);
history.replaceState(null, '', location.pathname + location.search);
if (/^[a-f0-9]{64}$/.test(token)) button.disabled = false;
else status.textContent = words.expired;
button.addEventListener('click', async () => {
  button.disabled = true;
  let code = 'unavailable';
  try {
    const result = await fetch('${PREFIX}/confirm', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({token}) });
    code = (await result.json()).code;
  } catch {}
  status.textContent = words[code] || words.unavailable;
  if (!['confirmed', 'expired', 'closed'].includes(code)) button.disabled = false;
});
</script></html>`, {
    headers: {
      ...responseHeaders,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    },
  });
}
