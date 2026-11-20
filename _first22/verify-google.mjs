import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const options = new Map();
const data = new Map();
const deliveries = [];
const url = 'https://script.google.com/macros/s/example/exec';
let time = 1_800_000_000_000;
let locked = false;
let quota = 100;
const table = id => data.get(id);
const rowIndex = range => Number(range.match(/A(\d+):I\d+$/)?.[1]) - 1;
const context = vm.createContext({
  Date: { now: () => time },
  HtmlService: { createHtmlOutput(html) { return { html, addMetaTag() { return this; }, setTitle() { return this; } }; } },
  LockService: { getScriptLock: () => ({ waitLock() { assert.equal(locked, false); locked = true; }, releaseLock() { assert.equal(locked, true); locked = false; } }) },
  MailApp: {
    getRemainingDailyQuota: () => quota,
    sendEmail(mail) { assert.equal(locked, false); if (mail.to === 'fail@example.test') throw new Error('mock delivery error'); quota--; deliveries.push(mail); },
  },
  PropertiesService: { getScriptProperties() { return { getProperties: () => Object.fromEntries(options), getProperty: k => options.get(k), setProperty: (k, v) => options.set(k, v) }; } },
  ScriptApp: { getService: () => ({ getUrl: () => url }) },
  Sheets: { Spreadsheets: {
    create() { const id = 'private-' + data.size; data.set(id, []); return { spreadsheetId: id, spreadsheetUrl: 'sheet/' + id }; },
    get(id) { return { spreadsheetUrl: 'sheet/' + id }; },
    Values: {
      get(id) { assert.equal(locked, true); const entries = table(id).slice(1); return { values: Array.from({ length: entries.length }, (_, i) => [...(entries[i] || [])]) }; },
      update(body, id, range, opts) { assert.equal(locked, true); assert.equal(opts.valueInputOption, 'RAW'); table(id)[rowIndex(range)] = [...body.values[0]]; },
      batchClear(body, id) { assert.equal(locked, true); for (const range of body.ranges) {
        const n = Number(range.match(/\d+/)[0]) - 1;
        if (range.endsWith(':I' + (n + 1))) table(id)[n] = [];
        else if (range.endsWith(':D' + (n + 1))) table(id)[n].fill('', 0, 4);
        else table(id)[n][3] = '';
      } },
    },
  } },
  Utilities: {
    getUuid: randomUUID, DigestAlgorithm: { SHA_256: 'sha256' },
    computeDigest: (name, value) => [...createHash(name).update(value).digest()],
  },
});
vm.runInContext(readFileSync(new URL('GoogleSignup.gs', import.meta.url), 'utf8'), context);
const run = expression => vm.runInContext(expression, context);
const post = (intent, params) => run('doPost(' + JSON.stringify({ parameter: { intent, lang: 'en', ...params } }) + ').html');
const show = (params) => run('doGet(' + JSON.stringify({ parameter: { ...params, lang: 'en' } }) + ').html');
const key = email => new URL(deliveries.find(message => message.to === email).body.match(/https:\/\/\S+/)[0]).searchParams.get('k');
const apply = email => post('signup', { email, privacy: 'yes' });
const confirm = k => post('confirm', { k });
assert.equal(run('setupTestingSheet_()'), 'sheet/private-0');
assert.equal(run('setupPrivateSheet_()'), 'sheet/private-1');
assert.equal(run('setupPrivateSheet_()'), 'sheet/private-1');
assert.match(apply('participant@example.test'), /temporarily unavailable/);

options.set('F22_MODE', 'test');
options.set('F22_TEST_EMAIL', 'test@example.test');
assert.match(apply('blocked@example.test'), /temporarily unavailable/);
assert.match(apply('test@example.test'), /Check your inbox/);
const testProof = key('test@example.test');
assert.match(show({ k: testProof }), /<form method="post"/);
assert.equal(data.get('private-0')[1][7], '');
assert.match(confirm(testProof), /Your place is confirmed/);
assert.equal(data.get('private-0')[1][7], 1);
assert.equal(data.get('private-1').length, 1);

options.set('F22_MODE', 'live');
assert.match(post('signup', { email: 'wrong@example.test', privacy: 'no' }), /Check your email address/);
assert.match(post('signup', { email: 'bot@example.test', privacy: 'yes', website: 'bot' }), /Check your inbox/);
assert.equal(deliveries.length, 1);
assert.match(apply('fail@example.test'), /temporarily unavailable/);
assert.equal(data.get('private-1').slice(1).filter(row => row.length).length, 0);
const original = 'R.eader+alias@gmail.com';
assert.match(apply(original), /Check your inbox/);
assert.match(apply('reader@googlemail.com'), /Check your inbox/);
assert.equal(deliveries.length, 2);
assert.match(confirm('invalid'), /has expired/);

const addresses = Array.from({ length: 27 }, (_, i) => 'reader' + i + '@example.test');
for (const address of addresses) {
  time += 60_000;
  assert.match(apply(address), /Check your inbox/);
}
const last = addresses.at(-1);
assert.match(confirm(key(last)), /Your place is confirmed/);
assert.match(confirm(key(last)), /Your place is confirmed/);
assert.equal(data.get('private-1').slice(1).find(row => row[7] === 1)[0], last);
assert.match(confirm(key(original)), /Your place is confirmed/);
for (const [index, address] of addresses.slice(0, -1).entries()) {
  assert.match(confirm(key(address)), index < 20 ? /Your place is confirmed/ : /All 22 copies/);
}
assert.match(apply('late@example.test'), /All 22 copies/);
assert.deepEqual(data.get('private-1').slice(1).map(row => row[7]).filter(Boolean).sort((a,b) => a-b), Array.from({length: 22}, (_,i) => i+1));
data.get('private-1').slice(1).find(row => row[7] === 1)[8] = time;
time += 32 * 24 * 3600_000;
run('cleanupDaily_()');
assert.equal(data.get('private-1').slice(1).find(row => row[7] === 1)[0], '');
assert.equal(data.get('private-1').slice(1).filter(row => row[3]).length, 0);
console.log('PASS: separate test and production registers, consent gate, honeypot, send failure, aliases, confirmation ordering, 22-slot cap, idempotent confirmation, cleanup.');
