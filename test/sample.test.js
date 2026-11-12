'use strict';
// Sample XML round trips: every sample is well-formed and consistent with the schema structure;
// where the libxml2 binding for Python is installed, every sample is also checked by that
// independent schema validator.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const L = require('./helpers/load');
const SC = require('./helpers/structure-check');
const P = require('../src/xml/parser');
const { buildSample, listChoices } = require('../src/sample/sample');

const MODES = [
  ['minimal', { mode: 'minimal' }],
  ['full-first', { mode: 'full' }],
  ['full-rotate', { mode: 'full', choice: 'rotate', repeat: 3, realistic: true, seed: 7 }],
  ['full-random', { mode: 'full', choice: 'random', repeat: 2, realistic: true, seed: 12345 }]
];

function oracleAvailable() {
  const r = cp.spawnSync('python', ['-c', 'import lxml'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0;
}

async function allSamples() {
  const out = [];
  for (const f of L.corpusFiles('xsd').concat(L.corpusFiles('wsdl').filter((x) => x.endsWith('.xsd')))) {
    const set = await L.loadFile(f);
    for (const c of set.all('element').filter((x) => x.doc.uri === L.uriOf(f))) {
      for (const [label, opts] of MODES) out.push({ file: f, set: set, comp: c, label: label, result: buildSample(set, c, opts) });
    }
  }
  return out;
}

let cache = null;
async function samples() { if (!cache) cache = await allSamples(); return cache; }

test('samples: every corpus element gets a well-formed sample in every mode', async () => {
  const list = await samples();
  assert.ok(list.length >= 200, 'samples built: ' + list.length);
  for (const s of list) {
    assert.ok(s.result.text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n'), s.comp.name);
    const parsed = P.parseXml(s.result.text);
    assert.deepEqual(parsed.errors, [], path.basename(s.file) + ' ' + s.comp.name + ' ' + s.label);
    if (!/abstract="true"/.test(s.set.docs[0].text.slice(s.comp.node.start, s.comp.node.tagEnd))) {
      assert.equal(parsed.root.local, s.comp.name);
      assert.equal(parsed.root.ns, s.comp.ns);
    }
  }
});

test('samples: every sample is consistent with the schema structure', async () => {
  for (const s of await samples()) {
    const problems = SC.check(s.set, P.parseXml(s.result.text));
    const keyrefOnly = s.result.notes.some((n) => /keyref/.test(n));
    assert.deepEqual(keyrefOnly ? [] : problems, [], path.basename(s.file) + ' ' + s.comp.name + ' ' + s.label + '\n' + s.result.text);
  }
});

test('samples: the same seed gives the same document, another seed may differ', async () => {
  const f = L.corpusFiles('xsd').find((x) => /28-invoice/.test(x));
  const set = await L.loadFile(f);
  const comp = set.lookup('element', 'http://example.com/schemas/invoice/2', 'Invoice');
  const a = buildSample(set, comp, { mode: 'full', realistic: true, seed: 5 }).text;
  const b = buildSample(set, comp, { mode: 'full', realistic: true, seed: 5 }).text;
  assert.equal(a, b);
  assert.equal(buildSample(set, comp, { mode: 'minimal' }).text, buildSample(set, comp, { mode: 'minimal' }).text);
});

test('samples: minimal leaves optional parts out, full puts them in and repeats', async () => {
  const set = await L.loadTexts({ 'm.xsd': L.schema('<xs:element name="r"><xs:complexType><xs:sequence><xs:element name="a" type="xs:string"/><xs:element name="b" type="xs:int" minOccurs="0"/><xs:element name="c" type="xs:string" maxOccurs="5"/></xs:sequence><xs:attribute name="x" type="xs:string"/><xs:attribute name="y" type="xs:string" use="required"/></xs:complexType></xs:element>') });
  const comp = set.lookup('element', 'urn:t', 'r');
  const min = buildSample(set, comp, { mode: 'minimal' }).text;
  assert.ok(!/<t:b>/.test(min) && !/ x="/.test(min) && / y="/.test(min));
  assert.equal((min.match(/<t:c>/g) || []).length, 1);
  const full = buildSample(set, comp, { mode: 'full', repeat: 3 }).text;
  assert.ok(/<t:b>/.test(full) && / x="/.test(full));
  assert.equal((full.match(/<t:c>/g) || []).length, 3);
});

test('samples: defaults, fixed values, enumerations, patterns and bounds are honoured', async () => {
  const set = await L.loadTexts({ 'm.xsd': L.schema('<xs:element name="r"><xs:complexType><xs:sequence>' +
    '<xs:element name="d" type="xs:string" default="dflt"/><xs:element name="f" type="xs:string" fixed="fx"/>' +
    '<xs:element name="e"><xs:simpleType><xs:restriction base="xs:token"><xs:enumeration value="red"/><xs:enumeration value="blue"/></xs:restriction></xs:simpleType></xs:element>' +
    '<xs:element name="p"><xs:simpleType><xs:restriction base="xs:string"><xs:pattern value="[A-Z]{2}-[0-9]{4}"/></xs:restriction></xs:simpleType></xs:element>' +
    '<xs:element name="n"><xs:simpleType><xs:restriction base="xs:decimal"><xs:minExclusive value="100"/><xs:maxInclusive value="100.5"/><xs:fractionDigits value="1"/></xs:restriction></xs:simpleType></xs:element>' +
    '<xs:element name="l"><xs:simpleType><xs:restriction base="xs:string"><xs:length value="7"/></xs:restriction></xs:simpleType></xs:element>' +
    '<xs:element name="dt"><xs:simpleType><xs:restriction base="xs:date"><xs:minExclusive value="2030-12-31"/></xs:restriction></xs:simpleType></xs:element>' +
    '</xs:sequence></xs:complexType></xs:element>') });
  const text = buildSample(set, set.lookup('element', 'urn:t', 'r'), { mode: 'minimal' }).text;
  assert.match(text, /<t:d>dflt<\/t:d>/);
  assert.match(text, /<t:f>fx<\/t:f>/);
  assert.match(text, /<t:e>red<\/t:e>/);
  assert.match(text, /<t:p>[A-Z]{2}-[0-9]{4}<\/t:p>/);
  const n = Number(/<t:n>([^<]+)</.exec(text)[1]);
  assert.ok(n > 100 && n <= 100.5, String(n));
  assert.match(text, /<t:l>.{7}<\/t:l>/);
  assert.match(text, /<t:dt>2031-01-01<\/t:dt>/);
});

test('samples: abstract heads, abstract types, recursion and wildcards', async () => {
  const set = await L.loadTexts({ 'm.xsd': L.schema(
    '<xs:element name="head" abstract="true" type="xs:string"/><xs:element name="member" substitutionGroup="t:head" type="xs:string"/>' +
    '<xs:complexType name="Base" abstract="true"><xs:sequence><xs:element name="v" type="xs:string"/></xs:sequence></xs:complexType>' +
    '<xs:complexType name="Concrete"><xs:complexContent><xs:extension base="t:Base"/></xs:complexContent></xs:complexType>' +
    '<xs:complexType name="Node"><xs:sequence><xs:element name="child" type="t:Node" minOccurs="0" maxOccurs="unbounded"/></xs:sequence></xs:complexType>' +
    '<xs:element name="r"><xs:complexType><xs:sequence><xs:element ref="t:head"/><xs:element name="b" type="t:Base"/><xs:element name="tree" type="t:Node"/>' +
    '<xs:any namespace="##other" processContents="lax"/></xs:sequence></xs:complexType></xs:element>') });
  const r = buildSample(set, set.lookup('element', 'urn:t', 'r'), { mode: 'full' });
  assert.match(r.text, /<t:member>/);
  assert.match(r.text, /xsi:type="t:Concrete"/);
  assert.match(r.text, /xmlns:xsi="http:\/\/www\.w3\.org\/2001\/XMLSchema-instance"/);
  assert.match(r.text, /<ns\d:extra\/>/);
  assert.deepEqual(SC.check(set, P.parseXml(r.text)), []);
});

test('samples: choices can be listed and picked', async () => {
  const f = L.corpusFiles('xsd').find((x) => /27-choice/.test(x));
  const set = await L.loadFile(f);
  const comp = set.all('element').find((c) => c.name === 'deliveryInstruction');
  const choices = listChoices(set, comp);
  assert.ok(choices.length >= 2);
  const first = choices[0];
  assert.deepEqual(first.options, ['homeAddress', 'sequence (lockerId, pin)', 'pickUpPoint']);
  const picked = buildSample(set, comp, { mode: 'full', picks: { [first.key]: 2 } }).text;
  assert.match(picked, /<ch:pickUpPoint>/);
  assert.ok(!/<ch:homeAddress>/.test(picked));
});

test('samples: impossible facets give a note, not a crash', async () => {
  const set = await L.loadTexts({ 'm.xsd': L.schema('<xs:element name="r"><xs:simpleType><xs:restriction base="xs:string"><xs:pattern value="[0-9]+"/><xs:pattern value="[0-9]+"/><xs:maxLength value="0"/><xs:minLength value="0"/></xs:restriction></xs:simpleType></xs:element>') });
  const r = buildSample(set, set.lookup('element', 'urn:t', 'r'), { mode: 'minimal' });
  assert.ok(r.notes.length >= 1);
  assert.deepEqual(P.parseXml(r.text).errors, []);
});

test('samples: values with XML special characters are escaped', async () => {
  const set = await L.loadTexts({ 'm.xsd': L.schema('<xs:element name="r" type="xs:string" fixed="a &amp; b &lt;c&gt; &quot;d&quot;"/>') });
  const r = buildSample(set, set.lookup('element', 'urn:t', 'r'), { mode: 'minimal' });
  const parsed = P.parseXml(r.text);
  assert.deepEqual(parsed.errors, []);
  assert.equal(P.textContent(parsed, parsed.root), 'a & b <c> "d"');
});

test('samples: an independent schema validator accepts every sample (libxml2, when installed)', { skip: !oracleAvailable() && 'the lxml package for Python is not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsdatlas-samples-'));
  try {
    const reqs = [];
    const keyref = new Set();
    (await samples()).forEach(function (s, i) {
      const file = path.join(dir, i + '.xml');
      fs.writeFileSync(file, s.result.text);
      reqs.push([s.file, file]);
      if (s.result.notes.some((n) => /keyref/.test(n))) keyref.add(file);
    });
    const r = cp.spawnSync('python', [path.join(__dirname, 'helpers', 'oracle.py')], { input: JSON.stringify({ schemas: [], instances: reqs }), encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    const answer = JSON.parse(r.stdout);
    const bad = answer.instances.filter((x) => x.error && !(keyref.has(x.instance) && /IDC|keyref|key-sequence/i.test(x.error)));
    assert.deepEqual(bad.map((x) => path.basename(x.schema) + ': ' + x.error.slice(0, 200)), []);
    assert.equal(answer.instances.length, reqs.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
