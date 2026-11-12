'use strict';
// Licence and trial behaviour that must hold whatever the user does: a key entered twice uses one
// seat, a replaced key gives its seat back, a rejected key stays rejected offline, the trial
// cannot be reopened by the clock, and every message says only what is true.
const test = require('node:test');
const assert = require('node:assert/strict');
const messages = require('../src/licence/messages');
const F = require('./helpers/licence-fakes');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// ---- seats ------------------------------------------------------------------------------------

test('a key entered four times uses one seat, not four', async () => {
  const m = F.make();
  const first = await m.lic.activate('KEY-PERSONAL');
  assert.deepEqual(first, { ok: true, licenceType: 'personal' });
  for (let i = 0; i < 3; i++) {
    const again = await m.lic.activate('KEY-PERSONAL');
    assert.deepEqual(again, { ok: true, licenceType: 'personal', already: true });
  }
  assert.equal(m.srv.active.size, 1, 'one seat in use');
  assert.equal(m.srv.count('/licenses/activate'), 1, 'activated once');
  assert.equal(m.srv.count('/licenses/validate'), 3, 'validated each further time');
  assert.equal(await m.lic.isPro(), true);
  assert.match(messages.activatedText('personal', { already: true }), /no further activation was used/);
});

test('entering the key again after the secret was lost validates instead of activating', async () => {
  const m = F.make();
  await m.lic.activate('KEY-PERSONAL');
  m.s.secretsMap.clear();
  assert.deepEqual(await m.lic.activate('KEY-PERSONAL'), { ok: true, licenceType: 'personal', already: true });
  assert.equal(m.srv.active.size, 1);
  assert.equal(m.s.secretsMap.get('licence.key.test'), 'KEY-PERSONAL');
});

test('entering the same key while the service is unreachable changes nothing and uses no seat', async () => {
  const m = F.make();
  await m.lic.activate('KEY-PERSONAL');
  m.srv.options.down = true;
  assert.deepEqual(await m.lic.activate('KEY-PERSONAL'), { ok: false, reason: 'network' });
  m.srv.options.down = false;
  assert.equal(m.srv.count('/licenses/activate'), 1);
  assert.equal(await m.lic.isPro(), true);
});

test('a key the service no longer knows is activated again and the dead activation is dropped', async () => {
  const m = F.make();
  await m.lic.activate('KEY-PERSONAL');
  m.srv.active.clear(); // the service lost the activation (for example it was freed by support)
  const r = await m.lic.activate('KEY-PERSONAL');
  assert.equal(r.ok, true);
  assert.equal(m.srv.active.size, 1);
  assert.equal(await m.lic.isPro(), true);
});

test('replacing a key gives the seat of the old key back; a mistyped key leaves the old one alone', async () => {
  const m = F.make();
  await m.lic.activate('KEY-PERSONAL');
  assert.equal((await m.lic.activate('NO-SUCH-KEY')).reason, 'invalid');
  assert.equal(await m.lic.isPro(), true, 'the stored licence is untouched by a mistyped key');
  assert.equal(m.srv.active.size, 1);
  const r = await m.lic.activate('KEY-BUSINESS');
  assert.deepEqual(r, { ok: true, licenceType: 'business', replaced: true, previousReleased: true });
  assert.equal(m.srv.active.size, 1, 'only the new key holds a seat');
  assert.deepEqual(Array.from(m.srv.active.values()), ['KEY-BUSINESS']);
  assert.equal(m.s.secretsMap.get('licence.key.test'), 'KEY-BUSINESS');
  assert.match(messages.activatedText('business', r), /key that was stored before was released/);
});

test('replacing a key tells the truth when the old seat could not be given back', async () => {
  const m = F.make();
  await m.lic.activate('KEY-PERSONAL');
  m.srv.options.noDeactivate = true;
  const r = await m.lic.activate('KEY-BUSINESS');
  assert.equal(r.ok, true);
  assert.equal(r.previousReleased, false);
  assert.equal(m.srv.active.size, 2, 'the old seat is still in use at the service');
  const text = messages.activatedText('business', r);
  assert.match(text, /could not be released/);
  assert.doesNotMatch(text, /was released\./);
});

test('replacing a key whose new value cannot be stored keeps the licence consistent', async () => {
  const opts = {};
  const m = F.make({ stores: F.stores(opts) });
  await m.lic.activate('KEY-PERSONAL');
  opts.failStore = true;
  const r = await m.lic.activate('KEY-BUSINESS');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'storage');
  assert.equal(r.released, true, 'the new activation was given back');
  assert.equal(m.srv.active.size, 0, 'no seat is left in use');
  assert.equal(await m.lic.isPro(), false, 'nothing usable is stored, and the text says so');
  assert.match(messages.activationFailureText(r), /Pro is off on this computer/);
});

test('a refused key and a failed storage say whether the activation was really given back', async () => {
  const lost = F.make({ server: F.server({ noDeactivate: true }) });
  const r = await lost.lic.activate('KEY-OTHER');
  assert.deepEqual(r, { ok: false, reason: 'product', released: false });
  assert.equal(lost.srv.active.size, 1, 'the seat really is still in use');
  const text = messages.activationFailureText(r);
  assert.match(text, /could not be released/);
  assert.doesNotMatch(text, /released again/);

  const full = F.make({ stores: F.stores({ failStore: true }), server: F.server({ noDeactivate: true }) });
  const s = await full.lic.activate('KEY-PERSONAL');
  assert.deepEqual(s, { ok: false, reason: 'storage', released: false });
  assert.match(messages.activationFailureText(s), /could not be released/);

  const fine = F.make();
  const ok = await fine.lic.activate('KEY-OTHER');
  assert.equal(ok.released, true);
  assert.match(messages.activationFailureText(ok), /released again/);
});

// ---- a rejected key ----------------------------------------------------------------------------

test('a key the service rejected stays rejected when the service cannot be reached later', async () => {
  const m = F.make();
  await m.lic.activate('KEY-PERSONAL');
  m.srv.options.invalid = true;
  m.advance(25 * HOUR);
  assert.equal((await m.lic.status(false)).via, 'rejected');
  m.srv.options.down = true;
  m.advance(2 * DAY);
  assert.equal(await m.lic.isPro(), false, 'blocking the host does not bring Pro back');
  assert.equal((await m.lic.status(false)).via, 'rejected');
  m.advance(20 * DAY);
  assert.equal(await m.lic.isPro(), false);
  // The key is valid again at the service: the next answer restores Pro.
  m.srv.options.down = false;
  m.srv.options.invalid = false;
  m.advance(6 * 60 * 1000);
  assert.equal(await m.lic.isPro(), true);
});

test('the answers 403, 404 and 422 also end the offline grace period', async () => {
  for (const status of [403, 404, 422]) {
    const m = F.make();
    await m.lic.activate('KEY-PERSONAL');
    m.srv.options.validateStatus = status;
    m.advance(25 * HOUR);
    assert.equal(await m.lic.isPro(), false, String(status));
    assert.equal(m.s.globalMap.has('licence.lastGoodAt.test'), false, 'the last good time is cleared for ' + status);
    m.srv.options.down = true;
    m.advance(DAY);
    assert.equal(await m.lic.isPro(), false, 'offline after ' + status);
  }
});

test('a server error is not a rejection: the grace period still covers it', async () => {
  const m = F.make();
  await m.lic.activate('KEY-PERSONAL');
  m.srv.options.validateStatus = 500;
  m.advance(25 * HOUR);
  assert.equal(await m.lic.isPro(), true);
  assert.equal((await m.lic.status(false)).via, 'grace');
});

// ---- the trial clock ---------------------------------------------------------------------------

test('trial: once seen as ended it stays ended, whatever the clock says afterwards', async () => {
  const m = F.make();
  await m.lic.startTrial();
  m.advance(10 * DAY);
  await m.lic.touchTrial();
  m.advance(6 * DAY);
  assert.equal(await m.lic.hasAccess(), false, 'ended on day 16');
  assert.ok(m.s.globalMap.get('trial.expiredAt') > 0, 'the end is recorded');
  m.advance(-12 * DAY); // the clock is set back to day 4
  assert.equal(m.lic.trialStatus().state, 'expired');
  assert.equal(await m.lic.hasAccess(), false);
  assert.equal((await m.lic.startTrial()).state, 'expired');
});

test('trial: a start time far in the future ends the trial instead of lengthening it', async () => {
  const m = F.make();
  m.s.globalMap.set('trial.startedAt', m.now() + 1000 * DAY);
  const t = m.lic.trialStatus();
  assert.equal(t.state, 'expired');
  assert.equal(t.daysLeft, 0);
  assert.ok(t.endsAt <= m.now(), 'the end shown is not in the future');
  assert.equal(await m.lic.hasAccess(), false);
});

test('trial: a trial that is running is not affected by the end record', async () => {
  const m = F.make();
  await m.lic.startTrial();
  m.advance(3 * DAY);
  await m.lic.touchTrial();
  assert.equal(m.s.globalMap.has('trial.expiredAt'), false);
  assert.equal(m.lic.trialStatus().daysLeft, 11);
});

// ---- the status text ---------------------------------------------------------------------------

test('status text: a stored key that does not unlock Pro does not claim that Pro is off while the trial runs', () => {
  const trial = { state: 'active', daysLeft: 5, endsAt: Date.UTC(2026, 10, 20) };
  const none = { state: 'expired', endsAt: Date.UTC(2026, 10, 1) };
  for (const via of ['rejected', 'product']) {
    const st = { pro: false, hasKey: true, via: via, keyHint: '...ABCD', mode: 'live' };
    const on = messages.licenceStatusText(Object.assign({}, st, { trial: trial }));
    assert.doesNotMatch(on, /Pro features are off/, via);
    assert.match(on, /trial keeps every Pro feature on for 5 days more/, via);
    const off = messages.licenceStatusText(Object.assign({}, st, { trial: none }));
    assert.match(off, /Pro features are off/, via);
    assert.doesNotMatch(off, /trial keeps/, via);
  }
  const stale = { pro: false, hasKey: true, via: 'expired', keyHint: '...ABCD', mode: 'live' };
  assert.doesNotMatch(messages.licenceStatusText(Object.assign({}, stale, { trial: trial })), /Pro is off/);
  assert.match(messages.licenceStatusText(Object.assign({}, stale, { trial: none })), /Pro is off/);
});

test('status text agrees with the real state: rejected key and running trial', async () => {
  const m = F.make();
  await m.lic.startTrial();
  await m.lic.activate('KEY-PERSONAL');
  m.srv.options.invalid = true;
  const st = await m.lic.status(true);
  assert.equal(st.via, 'rejected');
  assert.equal(await m.lic.hasAccess(), true, 'the trial keeps Pro on');
  const text = messages.licenceStatusText(st);
  assert.doesNotMatch(text, /Pro features are off/);
  assert.match(text, /no longer valid/);
});

// ---- the packaged form: no test environment ---------------------------------------------------------

test('packaged form: without the test-environment file nothing reaches the test environment and no test id is carried', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsdatlas-packaged-'));
  try {
    for (const f of ['config.js', 'licence.js']) fs.copyFileSync(path.join(__dirname, '..', 'src', 'licence', f), path.join(dir, f));
    assert.equal(fs.existsSync(path.join(dir, 'test-environment.js')), false);
    const text = fs.readFileSync(path.join(dir, 'config.js'), 'utf8') + fs.readFileSync(path.join(dir, 'licence.js'), 'utf8');
    assert.doesNotMatch(text, /test\.(checkout\.)?dodopayments|pdt_0Nrlx/);
    const config = require(path.join(dir, 'config.js'));
    const L = require(path.join(dir, 'licence.js'));
    assert.equal(config.testEnvironmentAvailable, false);
    assert.equal(config.resolve('test').mode, 'live');
    assert.equal(config.resolve('test').api, 'https://live.dodopayments.com');
    assert.deepEqual(config.allowedProductIds('test'), config.allowedProductIds('live'));
    assert.equal(config.buyUrlFor('test', 'business', 2), 'https://checkout.dodopayments.com/buy/pdt_0NrlydO9yqFrkNiBEKi1G?quantity=2');
    assert.deepEqual(config.placeholderIds(), []);
    assert.equal(config.assertShippable(require('../package.json')), true);
    const urls = [];
    const stores = F.stores();
    const lic = L.createLicence({ secrets: stores.secrets, globalState: stores.globalState, getMode: () => 'test', fetch: async (url) => { urls.push(url); return { status: 404, json: async () => ({}) }; } });
    await lic.activate('SOME-KEY');
    assert.deepEqual(urls, ['https://live.dodopayments.com/licenses/activate']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the test-environment file stays out of the package and the package check refuses its host', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ignore = fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignore.includes('src/licence/test-environment.js'));
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'check-vsix.js'), 'utf8'), /test\\.\(checkout/);
  // In a development checkout the file is present and the unit tests use it.
  assert.equal(require('../src/licence/config').testEnvironmentAvailable, true);
});
