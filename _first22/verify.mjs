import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.mjs';

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

function prepare(sql) {
  const statement = db.prepare(sql);
  const execute = (method, values) => sql.includes('?1')
    ? statement[method](Object.fromEntries(values.map((value, i) => ['?' + (i + 1), value])))
    : statement[method](...values);
  return {
    bind(...values) {
      return { first: async () => execute('get', values), run: async () => execute('run', values) };
    },
  };
}

const emails = [];
const env = {
  SIGNUPS: {
    prepare,
    batch: async commands => {
      db.exec('BEGIN');
      try {
        await Promise.all(commands.map(command => command.run()));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  },
  MAILER: { async send(message) {
    if (message.to.startsWith('failed@')) throw Error('Delivery rejected');
    emails.push(message);
  } },
  ACCEPTING: 'true',
  TURNSTILE_SITE_KEY: 'local-mock-site-key',
  TURNSTILE_SECRET: 'local-mock-secret',
  MAIL_FROM: 'campaign@example.test',
  API_ORIGIN: 'https://first22.bjbeyond.it',
};
const site = 'https://22.bjbeyond.it';
const api = env.API_ORIGIN + '/api/first22/';
globalThis.fetch = async (url, options) => {
  assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  const challenge = options.body.get('response');
  return Response.json({
    success: challenge !== 'rejected',
    hostname: challenge === 'incorrect-host' ? 'other.example' : '22.bjbeyond.it',
    action: challenge === 'incorrect-action' ? 'other' : 'first22_signup',
  });
};
const get = (name, origin = site) => worker.fetch(new Request(api + name, { headers: { Origin: origin } }), env);
const post = async (name, body, origin = site) => {
  const response = await worker.fetch(new Request(api + name, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { Origin: origin, 'Content-Type': 'application/json' },
  }), env);
  return { status: response.status, ...(await response.json()) };
};
const signup = async (email, language = 'it', challenge = 'ok', privacy = true) => post('signup', { email, language, challenge, privacy });
const linkFromMail = to => new URL(emails.find(mail => mail.to === to).text.match(/https:\/\/\S+/)[0]);
const confirm = link => post('confirm', { token: link.hash.slice(1) }, env.API_ORIGIN);

assert.equal((await get('config')).headers.get('Access-Control-Allow-Origin'), site);
assert.equal((await get('config', 'https://other.example')).headers.get('Access-Control-Allow-Origin'), null);
assert.equal((await get('config')).status, 200);
env.ACCEPTING = 'false';
assert.equal((await get('config')).status, 503);
env.ACCEPTING = 'true';
assert.equal((await signup('missing@dot')).status, 400);
assert.equal((await signup('unacknowledged@example.test', 'it', 'ok', false)).status, 400);
assert.equal((await signup('unverified@example.test', 'it', 'rejected')).code, 'challenge');
assert.equal((await signup('unverified@example.test', 'it', 'incorrect-host')).code, 'challenge');
assert.equal((await signup('unverified@example.test', 'it', 'incorrect-action')).code, 'challenge');
assert.equal((await post('signup', { email: 'valid@example.test' }, 'https://other.example')).status, 403);
assert.equal((await signup('failed@example.test')).status, 503);
assert.equal(db.prepare('SELECT count(*) AS n FROM first22').get().n, 0);

assert.equal((await signup('F.irst+alias@gmail.com', 'en')).code, 'check_email');
assert.equal((await signup('first@googlemail.com')).code, 'check_email');
assert.equal(emails.length, 1);
assert.match(emails[0].subject, /^Confirm your email/);

assert.equal((await signup('expires@example.test')).status, 202);
db.prepare("UPDATE first22 SET expires_at = 0 WHERE email = 'expires@example.test'").run();
assert.equal((await confirm(linkFromMail('expires@example.test'))).code, 'expired');

const addresses = Array.from({ length: 27 }, (_, i) => 'reader' + i + '@example.test');
assert.ok((await Promise.all(addresses.map(email => signup(email)))).every(result => result.code === 'check_email'));
const first = linkFromMail(addresses[26]);
const confirmationPage = await get('verify?lang=en', env.API_ORIGIN);
assert.match(await confirmationPage.text(), /Confirm my email/);
assert.equal(db.prepare('SELECT count(slot) AS n FROM first22').get().n, 0);
assert.equal((await confirm(first)).code, 'confirmed');
assert.equal((await confirm(first)).code, 'confirmed');
assert.equal(db.prepare('SELECT email FROM first22 WHERE slot = 1').get().email, addresses[26]);
const racing = await Promise.all([linkFromMail('F.irst+alias@gmail.com'), ...addresses.slice(0, -1).map(linkFromMail)].map(confirm));
assert.equal(racing.filter(r => r.code === 'confirmed').length, 21);
assert.equal(racing.filter(r => r.code === 'closed').length, 6);
const slots = db.prepare('SELECT slot FROM first22 WHERE slot IS NOT NULL ORDER BY slot').all().map(row => row.slot);
assert.deepEqual(slots, Array.from({ length: 22 }, (_, i) => i + 1));
assert.equal((await get('config').then(response => response.json())).code, 'closed');
assert.equal((await signup('after-close@example.test')).code, 'closed');

db.prepare('UPDATE first22 SET delivered_at = ? WHERE slot = 1').run(Date.now());
await worker.scheduled({ scheduledTime: Date.now() + 32 * 24 * 60 * 60 * 1000 }, env);
assert.equal(db.prepare('SELECT count(*) AS n FROM first22 WHERE slot IS NULL OR token_hash IS NOT NULL').get().n, 0);
assert.equal(db.prepare('SELECT email FROM first22 WHERE slot = 1').get().email, null);
assert.equal(db.prepare('SELECT count(*) AS n FROM first22 WHERE slot IS NOT NULL').get().n, 22);
console.log('PASS: CORS, staging lock, email failure, antispam, alias deduplication, link expiry, replay, 22 concurrent slots, closure, retention.');
