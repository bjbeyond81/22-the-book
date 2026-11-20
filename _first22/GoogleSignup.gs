const CAMPAIGN_SITE = 'https://22.bjbeyond.it/';
const TAB = 'Iscrizioni';
const HOUR = 3600000;
const CAPACITY = 22;
const COLUMN = { email: 0, key: 1, lang: 2, token: 3, requested: 4, expiry: 5, verified: 6, slot: 7, delivered: 8 };
const HEADER = ['Email', 'Chiave email', 'Lingua', 'Hash conferma', 'Richiesta (UTC ms)', 'Scadenza (UTC ms)', 'Conferma (UTC ms)', 'Posto', 'Consegna (UTC ms)'];

const TEXT = {
  it: {
    back: 'Torna al sito del libro',
    check: 'Controlla la posta. Il posto si assegna quando confermi il tuo indirizzo email.',
    closed: 'Tutte le 22 copie sono state assegnate.',
    invalid: 'Controlla l’indirizzo email e la presa visione dell’informativa.',
    expired: 'Il link non è valido o è scaduto. Puoi richiederne uno nuovo sul sito del libro.',
    confirm: 'Conferma la tua email',
    confirmed: 'Il tuo posto è confermato. Riceverai l’eBook gratuito via email alla pubblicazione.',
    retry: 'Le iscrizioni sono momentaneamente indisponibili. Riprova più tardi.',
    subject: 'Conferma la tua email per The first 22 get 22',
    mail: 'Apri il link e conferma entro 24 ore. Le prime 22 persone che confermano riceveranno l’eBook gratuito alla pubblicazione.',
    ignore: 'Se non hai fatto tu la richiesta, puoi ignorare questo messaggio.'
  },
  en: {
    back: 'Back to the book website',
    check: 'Check your inbox. Your place is awarded when you confirm your email address.',
    closed: 'All 22 copies have been claimed.',
    invalid: 'Check your email address and acknowledge the privacy notice.',
    expired: 'This link is invalid or has expired. Request a new one on the book website.',
    confirm: 'Confirm your email',
    confirmed: 'Your place is confirmed. You’ll receive the free eBook by email at publication.',
    retry: 'Sign-ups are temporarily unavailable. Please try again later.',
    subject: 'Confirm your email for The first 22 get 22',
    mail: 'Open the link and confirm within 24 hours. The first 22 people to confirm will receive the free eBook at publication.',
    ignore: 'If you did not request this, you can ignore this message.'
  }
};

function doGet(event) {
  const input = (event && event.parameter) || {};
  const language = input.lang === 'en' ? 'en' : 'it';
  if (isToken_(input.k)) return page_(language, 'confirm', input.k);
  return page_(language, input.k ? 'expired' : 'retry');
}

function doPost(event) {
  const input = (event && event.parameter) || {};
  const language = input.lang === 'en' ? 'en' : 'it';
  try {
    const config = config_();
    if (!config) return page_(language, 'retry');
    if (input.intent === 'confirm') return page_(language, confirm_(config, input.k));
    if (input.intent !== 'signup' || input.privacy !== 'yes') return page_(language, 'invalid');
    if (input.website) return page_(language, 'check');
    return page_(language, signup_(config, input.email, language));
  } catch {
    return page_(language, 'retry');
  }
}

function setupPrivateSheet_() {
  return createPrivateSheet_('F22_SHEET', 'The first 22 get 22 — Registro privato');
}

function setupTestingSheet_() {
  return createPrivateSheet_('F22_TEST_SHEET', 'The first 22 get 22 — Test privato');
}

function createPrivateSheet_(property, title) {
  return locked_(() => {
    const options = PropertiesService.getScriptProperties();
    const existing = options.getProperty(property);
    if (existing) return Sheets.Spreadsheets.get(existing).spreadsheetUrl;
    const spreadsheet = Sheets.Spreadsheets.create({
      properties: { title },
      sheets: [{ properties: { title: TAB, gridProperties: { frozenRowCount: 1, rowCount: 200, columnCount: 9 } } }]
    });
    write_(spreadsheet.spreadsheetId, 1, HEADER);
    options.setProperty(property, spreadsheet.spreadsheetId);
    return spreadsheet.spreadsheetUrl;
  });
}

function cleanupDaily_() {
  const sheet = PropertiesService.getScriptProperties().getProperty('F22_SHEET');
  if (!sheet) return;
  locked_(() => cleanup_(sheet, rows_(sheet), Date.now()));
}

function config_() {
  const p = PropertiesService.getScriptProperties().getProperties();
  const url = p.F22_WEB_APP_URL || ScriptApp.getService().getUrl();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url || '')) return null;
  if (p.F22_MODE === 'test' && p.F22_TEST_EMAIL && p.F22_TEST_SHEET) {
    return { sheet: p.F22_TEST_SHEET, url, testEmail: p.F22_TEST_EMAIL.trim().toLowerCase() };
  }
  if (p.F22_MODE === 'live' && p.F22_SHEET) return { sheet: p.F22_SHEET, url };
  return null;
}

function signup_(config, value, language) {
  const email = typeof value === 'string' ? value.trim() : '';
  if (!/^[a-z\d!#$%&'*+\-/=?^_`{|}~]+(?:\.[a-z\d!#$%&'*+\-/=?^_`{|}~]+)*@[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+$/i.test(email)
      || email.length > 254 || email.split('@')[0].length > 64) return 'invalid';
  if (config.testEmail && email.toLowerCase() !== config.testEmail) return 'retry';
  const key = emailKey_(email);
  const now = Date.now();
  const proof = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const hash = digest_(proof);
  const decision = locked_(() => {
    const list = rows_(config.sheet);
    if (lastSlot_(list) >= CAPACITY) return 'closed';
    const record = list.findIndex(row => row[COLUMN.key] === key);
    if (record >= 0 && (list[record][COLUMN.slot] || list[record][COLUMN.requested] > now - HOUR / 4)) return 'check';
    if (MailApp.getRemainingDailyQuota() <= 20 || !takeSendAllowance_(now)) return 'retry';
    const blank = list.findIndex(row => !row.some(value => value !== ''));
    let target = record >= 0 ? record : blank;
    if (target < 0) target = list.length;
    if (target >= 195) return 'retry';
    write_(config.sheet, target + 2, [email, key, language, hash, now, now + 24 * HOUR, '', '', '']);
    return 'send';
  });
  if (decision !== 'send') return decision;
  try {
    const text = TEXT[language];
    const link = config.url + '?lang=' + language + '&k=' + proof;
    MailApp.sendEmail({ to: email, subject: text.subject, name: 'BJ Beyond',
      body: text.mail + '\n\n' + link + '\n\n' + text.ignore });
    return 'check';
  } catch {
    locked_(() => {
      const index = rows_(config.sheet).findIndex(row => row[COLUMN.token] === hash && !row[COLUMN.slot]);
      if (index >= 0) clear_(config.sheet, ['A' + (index + 2) + ':I' + (index + 2)]);
    });
    return 'retry';
  }
}

function confirm_(config, proof) {
  if (!isToken_(proof)) return 'expired';
  const hash = digest_(proof);
  return locked_(() => {
    const list = rows_(config.sheet);
    const index = list.findIndex(row => row[COLUMN.token] === hash);
    if (index < 0) return 'expired';
    const row = list[index];
    const now = Date.now();
    if (Number(row[COLUMN.expiry]) <= now) return 'expired';
    if (row[COLUMN.slot]) return 'confirmed';
    if (config.testEmail && row[COLUMN.email].toLowerCase() !== config.testEmail) return 'expired';
    const last = lastSlot_(list);
    if (last >= CAPACITY) return 'closed';
    row[COLUMN.verified] = now;
    row[COLUMN.slot] = last + 1;
    write_(config.sheet, index + 2, row);
    return 'confirmed';
  });
}

function cleanup_(sheet, rows, now) {
  const ranges = [];
  rows.forEach((row, offset) => {
    const number = offset + 2;
    if (!row[COLUMN.email]) return;
    if (!row[COLUMN.slot] && row[COLUMN.expiry] <= now) {
      ranges.push('A' + number + ':I' + number);
    } else if (row[COLUMN.slot] && row[COLUMN.delivered] > 0 && row[COLUMN.delivered] <= now - 30 * 24 * HOUR) {
      ranges.push('A' + number + ':D' + number);
    } else if (row[COLUMN.slot] && row[COLUMN.token] && row[COLUMN.expiry] <= now) {
      ranges.push('D' + number);
    }
  });
  if (ranges.length) clear_(sheet, ranges);
}

function takeSendAllowance_(now) {
  const options = PropertiesService.getScriptProperties();
  const day = Math.floor(now / (24 * HOUR));
  const minute = Math.floor(now / 60000);
  const [priorDay, priorDayCount, priorMinute, priorMinuteCount] =
    (options.getProperty('F22_RATE') || '').split(',').map(Number);
  const daily = priorDay === day ? priorDayCount : 0;
  const recent = priorMinute === minute ? priorMinuteCount : 0;
  if (daily >= 70 || recent >= 10) return false;
  options.setProperty('F22_RATE', [day, daily + 1, minute, recent + 1].join(','));
  return true;
}

function rows_(sheet) {
  return Sheets.Spreadsheets.Values.get(sheet, TAB + '!A2:I', { valueRenderOption: 'UNFORMATTED_VALUE' }).values || [];
}

function write_(sheet, rowNumber, values) {
  Sheets.Spreadsheets.Values.update({ values: [values] }, sheet, TAB + '!A' + rowNumber + ':I' + rowNumber, { valueInputOption: 'RAW' });
}

function clear_(sheet, ranges) {
  Sheets.Spreadsheets.Values.batchClear({ ranges: ranges.map(range => TAB + '!' + range) }, sheet);
}

function lastSlot_(list) {
  return list.reduce((last, row) => Math.max(last, Number(row[COLUMN.slot]) || 0), 0);
}

function emailKey_(email) {
  const [local, domain] = email.toLowerCase().split('@');
  if (domain !== 'gmail.com' && domain !== 'googlemail.com') return email.toLowerCase();
  return local.split('+')[0].replace(/\./g, '') + '@gmail.com';
}

function isToken_(value) {
  return typeof value === 'string' && /^[a-f\d]{64}$/.test(value);
}

function digest_(token) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token).map(byte =>
    ((byte + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function locked_(callback) {
  const lock = LockService.getScriptLock();
  lock.waitLock(12000);
  try { return callback(); } finally { lock.releaseLock(); }
}

function page_(lang, code, proof) {
  const words = TEXT[lang];
  const url = proof ? (PropertiesService.getScriptProperties().getProperty('F22_WEB_APP_URL') || ScriptApp.getService().getUrl()) : '';
  const validUrl = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url || '');
  const form = proof && validUrl ? '<form method="post" target="_top" action="' + url + '">' +
    '<input name="intent" type="hidden" value="confirm"><input name="lang" type="hidden" value="' + lang + '">' +
    '<input name="k" type="hidden" value="' + proof + '"><button type="submit">' + words.confirm + '</button></form>' : '';
  return HtmlService.createHtmlOutput('<!doctype html><html lang="' + lang + '"><head><meta charset="utf-8">' +
    '<title>The first 22 get 22</title></head><body><main><h1 lang="en">The first 22 get 22</h1>' +
    '<p role="status">' + (words[code] || words.retry) + '</p>' + form +
    '<p><a href="' + CAMPAIGN_SITE + '#first22" target="_top">' + words.back + '</a></p></main>' +
    '<style>body{margin:12vh auto;padding:0 1.25rem;max-width:36rem;background:#171717;color:#f4f0e9;font:1rem/1.6 system-ui}a{color:inherit}button{font:inherit;padding:.7rem 1rem}</style></body></html>')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setTitle('The first 22 get 22');
}
