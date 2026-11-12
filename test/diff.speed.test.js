'use strict';
// Speed and decisions for xs:all contents. A record-style message schema with dozens of fields in
// an xs:all must compare in a fraction of a second: the extension host runs the comparison
// synchronously, so a slow comparison would freeze the editor.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./helpers/load');
const { diffSets } = require('../src/pro/diff');
const INC = require('../src/pro/inclusion');

const XS = 'xmlns:xs="http://www.w3.org/2001/XMLSchema"';
function sch(body) { return '<xs:schema ' + XS + ' xmlns:t="urn:t" targetNamespace="urn:t" elementFormDefault="qualified">' + body + '</xs:schema>'; }
function el(name, min) { return '<xs:element name="' + name + '" type="xs:string"' + (min === 0 ? ' minOccurs="0"' : '') + '/>'; }
function names(n, prefix) { const out = []; for (let i = 0; i < n; i++) out.push((prefix || 'f') + i); return out; }
// A complex type `T<k>` per index; every type holds an xs:all of the given fields.
function types(count, fieldsOf, wrap) {
  let s = '';
  for (let k = 0; k < count; k++) {
    const all = '<xs:all>' + fieldsOf(k).join('') + '</xs:all>';
    s += '<xs:complexType name="T' + k + '">' + (wrap ? '<xs:sequence><xs:element name="head" type="xs:string"/>' + all + '</xs:sequence>' : all) + '</xs:complexType>';
  }
  return sch(s);
}
async function timed(oldText, newText) {
  const a = await L.loadTexts({ 'main.xsd': oldText });
  const b = await L.loadTexts({ 'main.xsd': newText });
  const t0 = process.hrtime.bigint();
  const r = diffSets(a, b);
  return { result: r, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}
const codes = (r) => r.result.changes.map((c) => c.code + ':' + c.severity);

test('xs:all with 80 optional fields: one field added compares in well under a second', async () => {
  const base = names(80).map((n) => el(n, 0));
  const r = await timed(types(1, () => base), types(1, () => base.concat([el('added', 0)])));
  assert.deepEqual(codes(r), ['child-added-optional:NON-BREAKING']);
  assert.ok(r.ms < 200, 'took ' + r.ms.toFixed(0) + ' ms');
});

test('six xs:all types with 60 fields each, all changed, compare in under a second', async () => {
  const base = names(60).map((n) => el(n, 0));
  const r = await timed(types(6, () => base), types(6, () => base.concat([el('added', 0)])));
  assert.equal(r.result.changes.length, 6);
  assert.ok(r.result.changes.every((c) => c.severity === 'NON-BREAKING'));
  assert.ok(r.ms < 1000, 'took ' + r.ms.toFixed(0) + ' ms');
});

test('xs:all decisions: a removed field, a raised minimum and a new required field are BREAKING; the mirror images are not', async () => {
  const opt = names(30).map((n) => el(n, 0));
  const cases = [
    ['field removed', opt, opt.slice(1), 'BREAKING'],
    ['field made required', opt, [el('f0')].concat(opt.slice(1)), 'BREAKING'],
    ['required field added', opt, opt.concat([el('added')]), 'BREAKING'],
    ['field made optional', [el('f0')].concat(opt.slice(1)), opt, 'NON-BREAKING'],
    ['optional field added', opt, opt.concat([el('added', 0)]), 'NON-BREAKING'],
    ['fields in another order', opt, opt.slice().reverse(), null]
  ];
  for (const [name, o, n, severity] of cases) {
    const r = await timed(types(1, () => o), types(1, () => n));
    const breaking = r.result.changes.some((c) => c.severity === 'BREAKING');
    if (severity === 'BREAKING') assert.ok(breaking, name + ': ' + codes(r));
    else assert.ok(!breaking, name + ': ' + codes(r));
    assert.ok(r.ms < 300, name + ' took ' + r.ms.toFixed(0) + ' ms');
  }
});

test('xs:all inside a sequence is cut off by the time budget instead of freezing, and the unchecked change is reported as breaking', async () => {
  const base = names(40).map((n) => el(n, 0));
  const oldText = types(1, () => base, true);
  const newText = types(1, () => base.concat([el('added', 0)]), true);
  const t0 = Date.now();
  const r = await timed(oldText, newText);
  assert.ok(Date.now() - t0 < 2500, 'whole run took ' + (Date.now() - t0) + ' ms');
  // The exact check runs out of time for this content: the added optional field stays listed, and the content is reported as not verified.
  assert.deepEqual(codes(r).sort(), ['child-added-optional:NON-BREAKING', 'content-not-verified:BREAKING']);
});

test('the exact check gives up with "unknown" when its time is used up', () => {
  // Interleavings of 30 optional names behind a required head cost seconds; a limit of 20 ms must end the search.
  const leaf = (n) => ({ p: 'element', name: n, ns: 'urn:t', min: 0, max: 1 });
  const all = (extra) => ({ p: 'sequence', min: 1, max: 1, items: [{ p: 'element', name: 'head', ns: 'urn:t', min: 1, max: 1 }, { p: 'all', min: 1, max: 1, items: names(30).concat(extra).map(leaf) }, { p: 'any', min: 0, max: 1, namespace: '##other' }] });
  const options = {
    leafOf: (side, p) => (p.p === 'element'
      ? { key: 'E' + p.name, symbol: { ns: 'urn:t', local: p.name, label: p.name }, test: (s) => s.local === p.name && s.ns === 'urn:t' }
      : { key: 'W' + side, test: () => false }),
    maxMillis: 20
  };
  const t0 = Date.now();
  const r = INC.compareContent(all([]), all(['added']), options);
  assert.equal(r.status, 'unknown');
  assert.ok(Date.now() - t0 < 500, 'gave up after ' + (Date.now() - t0) + ' ms');
});
