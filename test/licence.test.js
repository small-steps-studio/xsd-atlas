'use strict';
// Licence service, trial and product allowlist, with an injected fetch, clock and stores.
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/licence/config');
const messages = require('../src/licence/messages');
const L = require('../src/licence/licence');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function stores(options) {
  const o = options || {};
  const secrets = new Map();
  const global = new Map();
  return {
    secretsMap: secrets,
    globalMap: global,
    secrets: {
      get: async (k) => { if (o.failGet) throw new Error('no keyring'); return secrets.get(k); },
      store: async (k, v) => { if (o.failStore) throw new Error('no keyring'); secrets.set(k, v); },
      delete: async (k) => { secrets.delete(k); }
    },
    globalState: {
      get: (k) => global.get(k),
      update: async (k, v) => { if (o.readOnly) throw new Error('read only'); if (v === undefined) global.delete(k); else global.set(k, v); }
    }
  };
}

// A stand-in for the public licence endpoints with the documented answer shapes.
function server(options) {
  const o = Object.assign({ keys: { 'KEY-PERSONAL': config.products.test.personal, 'KEY-BUSINESS': config.products.test.business, 'KEY-LIVE': config.products.live.personal, 'KEY-OTHER': 'pdt_OtherProduct0001' }, limit: 3 }, options || {});
  const calls = [];
  const active = new Map();
  let seq = 0;
  async function fetch(url, init) {
    const body = JSON.parse(init.body);
    calls.push({ url: url, body: body });
    if (o.down) throw new Error('offline');
    const path = url.replace(/^https:\/\/[^/]+/, '');
    const reply = function (status, data) { return { status: status, json: async () => { if (data === undefined) throw new Error('no body'); return data; } }; };
    if (o.status) return reply(o.status, { code: 'X' });
    if (path === '/licenses/activate') {
      const product = o.keys[body.license_key];
      if (!product) return reply(404, { code: 'NOT_FOUND' });
      const used = Array.from(active.values()).filter((k) => k === body.license_key).length;
      if (used >= o.limit) return reply(422, { code: 'LIMIT' });
      const id = 'lki_' + (++seq);
      active.set(id, body.license_key);
      const answer = { id: id, business_id: 'bus_1', name: body.name, license_key_id: 'lic_1', created_at: '2026-11-12T00:00:00Z', customer: { customer_id: 'cus_1', name: 'Test Buyer', email: 'buyer@example.com', phone_number: null, metadata: {} } };
      if (!o.noProduct) answer.product = { product_id: product, name: 'Product' };
      return reply(201, answer);
    }
    if (path === '/licenses/validate') return reply(200, { valid: o.invalid ? false : active.has(body.license_key_instance_id) });
    if (path === '/licenses/deactivate') { active.delete(body.license_key_instance_id); return reply(200, undefined); }
    return reply(404, {});
  }
  return { fetch: fetch, calls: calls, active: active, options: o };
}

function make(opts) {
  const o = opts || {};
  const s = o.stores || stores();
  const srv = o.server || server();
  let t = o.start || Date.UTC(2026, 10, 12, 10, 0, 0);
  const lic = L.createLicence({ secrets: s.secrets, globalState: s.globalState, fetch: srv.fetch, now: () => t, getMode: () => o.mode || 'test', platform: 'win32' });
  return { lic: lic, s: s, srv: srv, advance: (ms) => { t += ms; }, now: () => t };
}

test('config: allowlist lists exactly the Personal and Business products per environment', () => {
  assert.deepEqual(config.allowedProductIds('test'), ['pdt_0NrlxeSBTdTtqoEETYSA9', 'pdt_0Nrlxki6gEaKTaeak6bMN']);
  assert.deepEqual(config.allowedProductIds('live'), ['pdt_0NrlyVvfLevuTEDqI9l53', 'pdt_0NrlydO9yqFrkNiBEKi1G']);
  assert.equal(config.licenceTypeOf('test', 'pdt_0Nrlxki6gEaKTaeak6bMN'), 'business');
  assert.equal(config.licenceTypeOf('live', 'pdt_0NrlxeSBTdTtqoEETYSA9'), '', 'a test product never counts in live mode');
  assert.equal(config.licenceTypeOf('live', undefined), '');
  assert.equal(config.trialDays, 14);
  assert.equal(config.activationLimit, 3);
  assert.equal(config.maxUsers, 100);
});

test('config: real product ids are in place and no placeholder remains', () => {
  assert.equal(config.placeholderIds().length, 0);
  assert.equal(config.assertShippable(require('../package.json')), true);
  assert.equal(config.assertShippable(require('../package.json'), { allowPlaceholders: true }), true);
  for (const id of [].concat(config.allowedProductIds('live'), config.allowedProductIds('test'))) assert.match(id, /^pdt_[A-Za-z0-9]{15,}$/);
});

test('config: buy links carry the product and the quantity', () => {
  assert.equal(config.buyUrlFor('live', 'personal', 1), 'https://checkout.dodopayments.com/buy/pdt_0NrlyVvfLevuTEDqI9l53?quantity=1');
  assert.equal(config.buyUrlFor('live', 'business', 7), 'https://checkout.dodopayments.com/buy/pdt_0NrlydO9yqFrkNiBEKi1G?quantity=7');
  assert.equal(config.buyUrlFor('test', 'business', 100), 'https://test.checkout.dodopayments.com/buy/pdt_0Nrlxki6gEaKTaeak6bMN?quantity=100');
  for (const bad of [0, 101, 2.5, '3', NaN, -1]) assert.equal(config.buyUrlFor('live', 'business', bad), '', String(bad));
  assert.equal(config.buyUrlFor('live', 'personal', 50), 'https://checkout.dodopayments.com/buy/pdt_0NrlyVvfLevuTEDqI9l53?quantity=1', 'Personal is always one licence');
});

test('no network without a key', async () => {
  const m = make();
  assert.equal(await m.lic.isPro(), false);
  const st = await m.lic.status(true);
  assert.equal(st.hasKey, false);
  await m.lic.remove();
  assert.equal(m.srv.calls.length, 0);
});

test('activation stores key, instance and product; never the customer block', async () => {
  const m = make();
  const r = await m.lic.activate('  KEY-PERSONAL  ');
  assert.deepEqual(r, { ok: true, licenceType: 'personal' });
  assert.equal(m.srv.calls[0].body.name, 'VS Code on Windows');
  assert.deepEqual(Object.keys(m.srv.calls[0].body).sort(), ['license_key', 'name']);
  assert.equal(m.s.secretsMap.get('licence.key.test'), 'KEY-PERSONAL');
  assert.equal(m.s.globalMap.get('licence.productId.test'), 'pdt_0NrlxeSBTdTtqoEETYSA9');
  const stored = JSON.stringify(Array.from(m.s.globalMap.entries()));
  assert.ok(!/buyer@example\.com|Test Buyer|cus_1/.test(stored), 'customer details must not be stored');
  assert.equal(await m.lic.isPro(), true);
  const st = await m.lic.status(false);
  assert.equal(st.licenceType, 'personal');
  assert.equal(st.keyHint, '...ONAL');
});

test('a Business key activates as Business', async () => {
  const m = make();
  assert.deepEqual(await m.lic.activate('KEY-BUSINESS'), { ok: true, licenceType: 'business' });
  assert.match(messages.activatedText('business'), /Business licence/);
});

test('a key of another product is refused and its activation released', async () => {
  const m = make();
  const r = await m.lic.activate('KEY-OTHER');
  assert.deepEqual(r, { ok: false, reason: 'product', released: true });
  assert.equal(m.srv.calls[1].url, 'https://test.dodopayments.com/licenses/deactivate');
  assert.equal(m.srv.active.size, 0);
  assert.equal(m.s.secretsMap.size, 0);
  assert.equal(await m.lic.isPro(), false);
  assert.match(messages.activationFailureText(r), /another product/);
});

test('a live key in test mode is refused (environments are separate)', async () => {
  const m = make();
  assert.deepEqual(await m.lic.activate('KEY-LIVE'), { ok: false, reason: 'product', released: true });
});

test('an answer without a product is refused as unverified and released', async () => {
  const m = make({ server: server({ noProduct: true }) });
  assert.deepEqual(await m.lic.activate('KEY-PERSONAL'), { ok: false, reason: 'unverified', released: true });
  assert.equal(m.srv.active.size, 0);
});

test('secret storage failure releases the seat and stores nothing', async () => {
  const s = stores({ failStore: true });
  const m = make({ stores: s });
  assert.deepEqual(await m.lic.activate('KEY-PERSONAL'), { ok: false, reason: 'storage', released: true });
  assert.equal(m.srv.active.size, 0, 'the activation must be given back');
  assert.equal(s.globalMap.has('licence.instanceId.test'), false);
  assert.equal(s.globalMap.has('licence.productId.test'), false);
  assert.match(messages.activationFailureText({ reason: 'storage', released: true }), /released again/);
});

test('activation errors map to reasons', async () => {
  assert.equal((await make({ server: server({ status: 422 }) }).lic.activate('KEY-PERSONAL')).reason, 'limit');
  assert.equal((await make({ server: server({ status: 403 }) }).lic.activate('KEY-PERSONAL')).reason, 'inactive');
  assert.equal((await make({ server: server({ status: 400 }) }).lic.activate('KEY-PERSONAL')).reason, 'invalid');
  assert.equal((await make({ server: server({ status: 500 }) }).lic.activate('KEY-PERSONAL')).reason, 'error');
  assert.equal((await make({ server: server({ down: true }) }).lic.activate('KEY-PERSONAL')).reason, 'network');
  assert.equal((await make().lic.activate('NO-SUCH-KEY')).reason, 'invalid');
  for (const bad of ['', '   ', 'two words', 'x'.repeat(257), null, 42]) assert.equal((await make().lic.activate(bad)).reason, 'invalid');
});

test('activation limit of the key is reported', async () => {
  const srv = server({ limit: 1 });
  await make({ server: srv }).lic.activate('KEY-PERSONAL');
  const r = await make({ server: srv }).lic.activate('KEY-PERSONAL');
  assert.equal(r.reason, 'limit');
  assert.match(messages.activationFailureText(r), /maximum number of computers \(3\)/);
});

test('24 hour cache, revalidation, grace period and expiry', async () => {
  const srv = server();
  const m = make({ server: srv });
  await m.lic.activate('KEY-PERSONAL');
  const after = srv.calls.length;
  assert.equal(await m.lic.isPro(), true);
  assert.equal(srv.calls.length, after, 'trusted from the cache');
  m.advance(25 * HOUR);
  assert.equal(await m.lic.isPro(), true);
  assert.equal(srv.calls[srv.calls.length - 1].url.endsWith('/licenses/validate'), true);
  srv.options.down = true;
  m.advance(25 * HOUR);
  assert.equal(await m.lic.isPro(), true, 'grace while offline');
  const st = await m.lic.status(false);
  assert.equal(st.via, 'grace');
  assert.match(messages.licenceStatusText(st), /offline mode/);
  m.advance(14 * DAY);
  assert.equal(await m.lic.isPro(), false, 'grace ends after 14 days');
  srv.options.down = false;
  m.advance(6 * 60 * 1000);
  assert.equal(await m.lic.isPro(), true, 'Pro returns when the server answers again (after the 5 minute retry pause)');
});

test('concurrent checks share one request', async () => {
  const srv = server();
  const m = make({ server: srv });
  await m.lic.activate('KEY-PERSONAL');
  m.advance(25 * HOUR);
  const before = srv.calls.length;
  const r = await Promise.all([m.lic.isPro(), m.lic.isPro(), m.lic.isPro()]);
  assert.deepEqual(r, [true, true, true]);
  assert.equal(srv.calls.length, before + 1);
});

test('revoked key turns Pro off at once', async () => {
  const srv = server();
  const m = make({ server: srv });
  await m.lic.activate('KEY-PERSONAL');
  srv.options.invalid = true;
  const st = await m.lic.status(true);
  assert.equal(st.pro, false);
  assert.equal(st.via, 'rejected');
  assert.match(messages.licenceStatusText(st), /no longer valid/);
});

test('remove frees the activation and clears everything but the trial', async () => {
  const srv = server();
  const m = make({ server: srv });
  await m.lic.startTrial();
  await m.lic.activate('KEY-PERSONAL');
  const r = await m.lic.remove();
  assert.deepEqual(r, { ok: true, deactivated: true });
  assert.equal(srv.active.size, 0);
  assert.equal(m.s.secretsMap.size, 0);
  assert.deepEqual(Array.from(m.s.globalMap.keys()).filter((k) => k.startsWith('licence.')), []);
  assert.equal(m.lic.trialStatus().state, 'active', 'the trial record stays');
  srv.options.down = true;
  await m.lic.activate('KEY-PERSONAL');
});

test('remove while offline still clears the key and says so', async () => {
  const srv = server();
  const m = make({ server: srv });
  await m.lic.activate('KEY-PERSONAL');
  srv.options.down = true;
  assert.deepEqual(await m.lic.remove(), { ok: true, deactivated: false });
  assert.equal(m.s.secretsMap.size, 0);
});

test('trial: unused, started at the first Pro use, 14 days, reminders once a day', async () => {
  const m = make();
  assert.equal(m.lic.trialStatus().state, 'unused');
  assert.equal(await m.lic.hasAccess(), false);
  const t = await m.lic.startTrial();
  assert.equal(t.state, 'active');
  assert.equal(t.daysLeft, 14);
  assert.equal(await m.lic.hasAccess(), true);
  assert.equal(await m.lic.noteTrialReminder(), true);
  assert.equal(await m.lic.noteTrialReminder(), false);
  m.advance(DAY + 1);
  assert.equal(await m.lic.noteTrialReminder(), true);
  assert.equal(m.lic.trialStatus().daysLeft, 13);
  m.advance(13 * DAY);
  assert.equal(m.lic.trialStatus().state, 'expired');
  assert.equal(await m.lic.hasAccess(), false);
  assert.equal((await m.lic.startTrial()).state, 'expired', 'never restarts');
  assert.equal(m.srv.calls.length, 0, 'the trial uses no network');
});

test('trial: a clock set back does not stretch the trial', async () => {
  const m = make();
  await m.lic.startTrial();
  m.advance(10 * DAY);
  await m.lic.touchTrial();
  m.advance(-9 * DAY);
  assert.equal(m.lic.trialStatus().daysLeft, 4);
});

test('trial: storage that cannot be written gives "unavailable" and the notice explains it', async () => {
  const m = make({ stores: stores({ readOnly: true }) });
  const t = await m.lic.startTrial();
  assert.equal(t.state, 'unavailable');
  assert.match(messages.proNoticeText('Flatten Schema', t), /could not be started/);
});

test('messages: status texts name the trial, the prices and the environment', () => {
  const base = { pro: false, hasKey: false, mode: 'live', trial: { state: 'unused' } };
  assert.match(messages.licenceStatusText(base), /free 14-day trial/);
  assert.match(messages.licenceStatusText(Object.assign({}, base, { mode: 'test' })), /test environment/);
  assert.match(messages.licenceStatusText(Object.assign({}, base, { trial: { state: 'active', daysLeft: 1, endsAt: Date.now() } })), /1 day left/);
  assert.match(messages.licenceStatusText(Object.assign({}, base, { trial: { state: 'expired', endsAt: Date.now() } })), /USD 29.*USD 59 per user/);
  assert.match(messages.licenceStatusText({ pro: false, hasKey: true, via: 'product', keyHint: '...ABCD', mode: 'live' }), /not an XSD Atlas Pro key/);
  assert.match(messages.proNoticeText('Compare', { state: 'expired', endsAt: Date.now() }), /trial ended/);
});

test('messages: buy choices and the users question', () => {
  const c = messages.buyChoices();
  assert.deepEqual(c.map((x) => x.tier), ['personal', 'business']);
  assert.match(c[0].description, /USD 29/);
  assert.match(c[1].description, /USD 59 per user/);
  assert.equal(messages.businessUsersQuestion(), 'How many users? (1-100)');
  for (const ok of ['1', '42', ' 100 ']) assert.equal(messages.businessUsersError(ok), null);
  for (const bad of ['0', '101', '1.5', 'ten', '', '-3', '1e2', undefined]) assert.ok(messages.businessUsersError(bad), String(bad));
});

test('messages: every failure reason has an actionable sentence', () => {
  for (const reason of ['limit', 'invalid', 'inactive', 'network', 'product', 'unverified', 'storage', 'error']) {
    const t = messages.activationFailureText({ reason: reason, status: 500 });
    assert.ok(t.length > 40, reason);
  }
  assert.match(messages.activationFailureText({ reason: 'network' }), /live\.dodopayments\.com/);
  assert.match(messages.lostKeyText(), /Dodo Payments/);
});
