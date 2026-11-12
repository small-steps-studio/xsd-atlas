'use strict';
// Stored state written by other versions, by hand or broken on disk must never unlock Pro by
// mistake, never throw and never block the free features.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/licence/licence');

function make(initial, secret) {
  const global = new Map(Object.entries(initial || {}));
  const secrets = new Map(Object.entries(secret || {}));
  const calls = [];
  const lic = L.createLicence({
    secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); } },
    globalState: { get: (k) => global.get(k), update: async (k, v) => { if (v === undefined) global.delete(k); else global.set(k, v); } },
    fetch: async (url, init) => { calls.push(url); return { status: 200, json: async () => ({ valid: true }) }; },
    now: () => Date.UTC(2026, 10, 12),
    getMode: () => 'live'
  });
  return { lic: lic, calls: calls, global: global };
}

test('a stored activation without a product id does not unlock Pro (no earlier version existed)', async () => {
  const m = make({ 'licence.instanceId.live': 'lki_1' }, { 'licence.key.live': 'SOME-KEY' });
  assert.equal(await m.lic.isPro(), false);
  const st = await m.lic.status(true);
  assert.equal(st.via, 'product');
  assert.equal(m.calls.length, 0, 'no request for a key that cannot count');
});

test('a stored product id of another product does not unlock Pro', async () => {
  const m = make({ 'licence.instanceId.live': 'lki_1', 'licence.productId.live': 'pdt_SomethingElse001' }, { 'licence.key.live': 'K' });
  assert.equal(await m.lic.isPro(), false);
});

test('a test-mode licence never counts in live mode', async () => {
  const m = make({ 'licence.instanceId.test': 'lki_1', 'licence.productId.test': 'pdt_0NrlxeSBTdTtqoEETYSA9' }, { 'licence.key.test': 'K' });
  assert.equal(await m.lic.isPro(), false);
});

test('wrong types in stored values are ignored', async () => {
  for (const bad of [null, 42, {}, [], 'text', NaN, Infinity, -1]) {
    const m = make({ 'trial.startedAt': bad, 'trial.lastSeenAt': bad, 'licence.instanceId.live': bad, 'licence.checkedAt.live': bad }, {});
    const t = m.lic.trialStatus();
    assert.ok(['unused', 'active', 'expired'].indexOf(t.state) !== -1, String(bad));
    assert.equal(await m.lic.isPro(), false);
  }
});

test('a trial record that starts in the future (an edited record) counts as an ended trial', async () => {
  const future = Date.UTC(2030, 0, 1);
  const m = make({ 'trial.startedAt': future, 'trial.lastSeenAt': future });
  const t = m.lic.trialStatus();
  assert.equal(t.state, 'expired');
  assert.equal(t.daysLeft, 0);
  assert.ok(t.endsAt <= Date.UTC(2026, 10, 12), 'the end date shown is not in the future');
  assert.equal(await m.lic.hasAccess(), false);
});

test('a valid stored Personal licence is trusted from its cache without a request', async () => {
  const now = Date.UTC(2026, 10, 12);
  const m = make({ 'licence.instanceId.live': 'lki_1', 'licence.productId.live': 'pdt_0NrlyVvfLevuTEDqI9l53', 'licence.checkedAt.live': now - 1000, 'licence.checkedValid.live': true, 'licence.lastGoodAt.live': now - 1000 }, { 'licence.key.live': 'K' });
  assert.equal(await m.lic.isPro(), true);
  assert.equal(m.calls.length, 0);
});

test('a cached check from the future (clock moved back) is asked again', async () => {
  const now = Date.UTC(2026, 10, 12);
  const m = make({ 'licence.instanceId.live': 'lki_1', 'licence.productId.live': 'pdt_0NrlydO9yqFrkNiBEKi1G', 'licence.checkedAt.live': now + 10 * 86400000, 'licence.checkedValid.live': true }, { 'licence.key.live': 'K' });
  assert.equal(await m.lic.isPro(), true);
  assert.equal(m.calls.length, 1);
});
