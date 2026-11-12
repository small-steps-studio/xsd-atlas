'use strict';
// A comparison that could not be verified never reports less. The exact check of the child
// elements may answer "unknown" (the content is too large, or the time for the check ran out); in
// that case the result must be at least as cautious as with a working check: every pair that
// breaks old documents is still BREAKING, and a content that changed and could not be verified is
// reported as breaking.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./helpers/load');
const INC = require('../src/pro/inclusion');
const { diffSets } = require('../src/pro/diff');
const { sch, T, el, seq, cho, BREAKS, SAFE } = require('./helpers/diff-cases');

async function diff(oldText, newText) {
  return diffSets(await L.loadTexts({ 'main.xsd': oldText }), await L.loadTexts({ 'main.xsd': newText }));
}

/** Runs `fn` with the exact check answering "unknown" for every content. */
async function withUnknown(fn) {
  const original = INC.compareContent;
  INC.compareContent = function () { return { status: 'unknown', witness: [], steps: 0 }; };
  try { return await fn(); } finally { INC.compareContent = original; }
}

test('unverified: every pair that breaks old documents stays BREAKING when the exact check answers "unknown"', async () => {
  await withUnknown(async () => {
    for (const [name, oldText, newText] of BREAKS) {
      const r = await diff(oldText, newText);
      assert.ok(r.counts.BREAKING >= 1, name + ': ' + JSON.stringify(r.changes.map((c) => c.code + ' ' + c.severity)));
    }
  });
});

test('unverified: a changed content that nothing else calls breaking is reported as content-not-verified', async () => {
  await withUnknown(async () => {
    const r = await diff(T(seq('', el('a'), el('b'))), T(seq('', el('a'), el('b'), el('c', 'minOccurs="0"'))));
    assert.deepEqual(r.changes.map((c) => c.code + ':' + c.severity).sort(), ['child-added-optional:NON-BREAKING', 'content-not-verified:BREAKING']);
    const change = r.changes.find((c) => c.code === 'content-not-verified');
    assert.match(change.message, /could not be checked completely/);
    assert.match(change.message, /treated as breaking/);
  });
});

test('unverified: nothing is added for a content that did not change, and nothing twice when a change is already breaking', async () => {
  await withUnknown(async () => {
    const same = await diff(T(seq('', el('a'), el('b'))), T(seq('', el('a'), el('b'))));
    assert.deepEqual(same.changes, []);
    const prefixOnly = await diff(T(seq('', el('a'), el('b'))), T(seq('', el('a'), el('b'))).replace('xmlns:t="urn:t"', 'xmlns:t="urn:t" xmlns:unused="urn:unused"'));
    assert.deepEqual(prefixOnly.changes, []);
    const removed = await diff(T(seq('', el('a'), el('b'))), T(seq('', el('a'))));
    assert.deepEqual(removed.changes.map((c) => c.code).sort(), ['child-removed']);
  });
});

test('unverified: the safe pairs may become more cautious, never less, when the exact check answers "unknown"', async () => {
  const normal = [];
  for (const [, oldText, newText] of SAFE) normal.push((await diff(oldText, newText)).counts.BREAKING);
  await withUnknown(async () => {
    let i = 0;
    for (const [name, oldText, newText] of SAFE) {
      const r = await diff(oldText, newText);
      assert.ok(r.counts.BREAKING >= normal[i++], name);
    }
  });
});

test('unverified: a raised minimum of a repeating choice or sequence is reported without the exact check', async () => {
  await withUnknown(async () => {
    const choice = await diff(T(cho('maxOccurs="3"', el('p'), el('q'))), T(cho('minOccurs="2" maxOccurs="3"', el('p'), el('q'))));
    assert.ok(choice.changes.some((c) => c.code === 'group-min-increased' && c.severity === 'BREAKING'), JSON.stringify(choice.changes.map((c) => c.code)));
    const sequence = await diff(T(seq('maxOccurs="3"', el('a'), el('b'))), T(seq('minOccurs="2" maxOccurs="3"', el('a'), el('b'))));
    assert.ok(sequence.counts.BREAKING >= 1);
  });
});

test('unverified: many slow contents use up the time budget, and a later breaking change is still reported', async () => {
  // Twenty-five types with a counted repetition of two counted elements: each exact check runs into its time limit.
  const slow = (extra) => '<xs:sequence maxOccurs="60"><xs:element name="a" type="xs:string" minOccurs="0" maxOccurs="60"/><xs:element name="b" type="xs:string" minOccurs="0" maxOccurs="60"/>' + (extra || '') + '</xs:sequence>';
  const build = (changed) => {
    let types = '';
    for (let k = 0; k < 25; k++) types += '<xs:complexType name="Slow' + k + '">' + slow(changed ? '<xs:element name="c" type="xs:string" minOccurs="0"/>' : '') + '</xs:complexType>';
    types += '<xs:complexType name="Zeta"><xs:choice' + (changed ? ' minOccurs="2"' : '') + ' maxOccurs="3"><xs:element name="p" type="xs:string"/><xs:element name="q" type="xs:string"/></xs:choice></xs:complexType>';
    return sch('<xs:element name="root" type="t:Zeta"/>' + types);
  };
  const t0 = Date.now();
  const r = await diff(build(false), build(true));
  const ms = Date.now() - t0;
  const zeta = r.changes.filter((c) => /Zeta/.test(c.component));
  assert.ok(zeta.some((c) => c.severity === 'BREAKING'), 'Zeta: ' + JSON.stringify(r.changes.slice(-4).map((c) => c.component + ' ' + c.code + ' ' + c.severity)));
  assert.ok(ms < 5000, 'took ' + ms + ' ms');
  // The slow contents themselves were changed too: whatever the time allowed, none of them is lost.
  for (let k = 0; k < 25; k++) assert.ok(r.changes.some((c) => c.component === 'complexType Slow' + k), 'the change of Slow' + k + ' is listed: ' + r.changes.slice(0, 3).map((c) => c.component).join(', '));
});
