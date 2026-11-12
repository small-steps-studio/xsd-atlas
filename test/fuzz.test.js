'use strict';
// Seeded fuzzing: corpus files are mutated (cut, duplicated, swapped, characters replaced, tags
// broken, attributes changed) and every layer must stay robust: the parser, the loader, the
// checks, the outline, navigation, hovers, samples, comparison and the reports. Same seed, same run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const L = require('./helpers/load');
const P = require('../src/xml/parser');
const N = require('../src/schema/navigate');
const D = require('../src/schema/describe');
const O = require('../src/schema/outline');
const { buildSample } = require('../src/sample/sample');
const { diffSets } = require('../src/pro/diff');
const R = require('../src/pro/report');
const DOCS = require('../src/pro/docs');
const SOAP = require('../src/pro/soap');
const { seeded } = require('../src/schema/xsdregex');

const SEED = Number(process.env.XSD_ATLAS_FUZZ_SEED) || 20261112;
const ROUNDS = Number(process.env.XSD_ATLAS_FUZZ_ROUNDS) || 2000;
const SNIPPETS = ['<', '>', '&', '&amp;', '"', '\'', '/>', '</xs:sequence>', '<xs:element name="z" type="t:Q"/>', 'xmlns:t="urn:t"', ' minOccurs="7"', ' maxOccurs="0"',
  'type="xs:int"', 'base="xs:string"', '<xs:group ref="t:G"/>', '<![CDATA[', ']]>', '<!--', '-->', '\u0000', '\uD800', '﻿', 'ref="', 'name=""', '<xs:any/>', '<xs:choice>'];

function mutate(text, rng) {
  let s = text;
  const ops = 1 + Math.floor(rng() * 4);
  for (let k = 0; k < ops; k++) {
    const at = Math.floor(rng() * (s.length + 1));
    const kind = Math.floor(rng() * 6);
    if (kind === 0) s = s.slice(0, at);
    else if (kind === 1) { const len = Math.floor(rng() * 200); s = s.slice(0, at) + s.slice(at + len); }
    else if (kind === 2) s = s.slice(0, at) + SNIPPETS[Math.floor(rng() * SNIPPETS.length)] + s.slice(at);
    else if (kind === 3) { const b = Math.floor(rng() * s.length); const len = Math.floor(rng() * 300); s = s.slice(0, at) + s.slice(b, b + len) + s.slice(at); }
    else if (kind === 4) s = s.slice(0, at) + String.fromCharCode(Math.floor(rng() * 0x3000)) + s.slice(at + 1);
    else s = s.replace(/name="([A-Za-z]+)"/, function (m, n) { return rng() < 0.5 ? 'name="' + n + n + '"' : m; });
  }
  return s;
}

// Seeds that once drove the sample builder into endless recursion through a required wildcard.
const EXTRA_SEEDS = [7741, 31337042, 5550123];

for (const seed of [SEED].concat(process.env.XSD_ATLAS_FUZZ_SEED ? [] : EXTRA_SEEDS)) {
  test('fuzz: mutated schemas never break any layer (seed ' + seed + ', ' + ROUNDS + ' rounds)', async () => { await fuzzRun(seed); });
}

async function fuzzRun(seed) {
  const rng = seeded(seed);
  const files = L.corpusFiles('xsd').concat(L.corpusFiles('wsdl'));
  const texts = files.map((f) => fs.readFileSync(f, 'utf8'));
  for (let round = 0; round < ROUNDS; round++) {
    const i = Math.floor(rng() * texts.length);
    const text = mutate(texts[i], rng);
    const uri = 'file:///mem/main.' + (files[i].endsWith('.wsdl') ? 'wsdl' : 'xsd');
    const label = 'round ' + round + ' (' + files[i].replace(/^.*[\\/]/, '') + ')';
    let set;
    await assert.doesNotReject(async () => { set = await L.loadTexts({ ['main.' + uri.split('.').pop()]: text }); }, label);
    const problems = L.checkFile(set, uri);
    for (const p of problems) assert.ok(p.start >= 0 && p.end <= text.length + 1 && p.end >= p.start, label + ' ' + p.code + ' ' + p.start + '-' + p.end + ' of ' + text.length);
    assert.doesNotThrow(() => O.outlineOf(set, uri), label);
    for (let k = 0; k < 5; k++) {
      const off = Math.floor(rng() * (text.length + 1));
      assert.doesNotThrow(() => {
        const t = N.targetAt(set, uri, off);
        if (t) D.describeTarget(set, t, t.what === 'local' ? null : N.componentOf(set, t), t.node);
        N.definitionAt(set, uri, off);
        const parsed = set.parsedByUri.get(uri);
        if (parsed && parsed.parsed) N.pathAt(parsed.parsed, off);
      }, label + ' at ' + off);
    }
    for (const c of set.all('element').slice(0, 3)) {
      let r;
      assert.doesNotThrow(() => { r = buildSample(set, c, { mode: rng() < 0.5 ? 'minimal' : 'full', seed: round, maxElements: 2000 }); }, label + ' sample ' + c.name);
      // The builder's last-resort guard must never be what kept it from overflowing.
      assert.ok(!r.notes.some((n) => /refers to itself in a way the sample builder cannot resolve/.test(n)), label + ' sample ' + c.name + ' hit the recursion guard');
      if (r.text) assert.deepEqual(P.parseXml(r.text).errors, [], label + ' sample ' + c.name + '\n' + r.text.slice(0, 400));
    }
    if (round % 5 === 0) {
      const original = await L.loadTexts({ 'main.xsd': texts[i] });
      assert.doesNotThrow(() => { const d = diffSets(original, set); R.toCsv(d); R.toHtml(d); R.toMarkdown(d); }, label + ' diff');
      assert.doesNotThrow(() => DOCS.toMarkdown(set, 'x'), label + ' docs');
      assert.doesNotThrow(() => { for (const op of SOAP.soapOperations(set)) SOAP.buildEnvelopes(set, op, { mode: 'minimal' }); }, label + ' soap');
    }
  }
}

test('fuzz: random bytes through the parser', () => {
  const rng = seeded(SEED + 1);
  for (let round = 0; round < 500; round++) {
    const len = Math.floor(rng() * 400);
    let s = '';
    for (let k = 0; k < len; k++) s += rng() < 0.3 ? '<>/&;="\'!?[]-:'.charAt(Math.floor(rng() * 15)) : String.fromCharCode(Math.floor(rng() * 128));
    let r;
    assert.doesNotThrow(() => { r = P.parseXml(s); }, JSON.stringify(s));
    for (const e of r.errors) assert.ok(e.start >= 0 && e.end <= s.length + 1, JSON.stringify(s) + ' ' + e.code);
  }
});
