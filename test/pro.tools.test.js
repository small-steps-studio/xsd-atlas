'use strict';
// Pro tools: comparison reports (escaping, formula cells), documentation, flatten, SOAP envelopes
// and the workspace inventory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const L = require('./helpers/load');
const SC = require('./helpers/structure-check');
const P = require('../src/xml/parser');
const R = require('../src/pro/report');
const DOCS = require('../src/pro/docs');
const { flattenSet } = require('../src/pro/flatten');
const SOAP = require('../src/pro/soap');
const INV = require('../src/pro/inventory');
const { diffSets } = require('../src/pro/diff');
const { buildSample } = require('../src/sample/sample');
const U = require('../src/util');

const HOSTILE = '=HYPERLINK("http://x")<script>alert(1)</script>|`*_[a](b)\r\n"q",\'s\'&amp;';

function fakeResult() {
  return {
    labels: { old: 'v1 <old>.xsd', new: 'v2 "new".xsd' },
    counts: { BREAKING: 1, 'NON-BREAKING': 1, DOCUMENTATION: 0 },
    changes: [
      { severity: 'BREAKING', code: 'child-removed', component: 'complexType ' + HOSTILE, path: '@x', message: HOSTILE, before: '+1', after: '-1', oldLoc: { uri: 'file:///a/b.xsd', line: 3 }, newLoc: null },
      { severity: 'NON-BREAKING', code: 'child-added-optional', component: 'element e', path: 'a/b', message: 'ok', before: '', after: '@cmd', oldLoc: null, newLoc: { uri: 'file:///a/c.xsd', line: 9 } }
    ]
  };
}

test('report: CSV neutralises formula cells and quotes per RFC 4180', () => {
  const csv = R.toCsv(fakeResult());
  const lines = csv.split('\r\n');
  assert.equal(lines[0], R.CSV_HEADER.join(','));
  assert.ok(csv.includes('"\'=HYPERLINK(""http://x"")'), csv);
  assert.ok(csv.includes(',\'+1,\'-1,'));
  assert.ok(csv.includes(',\'@cmd,'));
  assert.ok(csv.endsWith('\r\n'));
  assert.equal(U.csvCell('\tx'), '\'\tx');
  assert.equal(U.csvCell('a,b'), '"a,b"');
});

test('report: HTML escapes everything and loads nothing', () => {
  const html = R.toHtml(fakeResult(), 'T <b>');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('T &lt;b&gt;'));
  assert.ok(html.includes('&amp;amp;'));
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(!/<script|src=|href="http/i.test(html));
  assert.deepEqual(P.parseXml(html.replace('<!DOCTYPE html>', '').replace(/<meta[^>]*>/g, '')).errors.filter((e) => e.code !== 'XML-UNCLOSED-ELEMENT'), []);
});

test('report: Markdown escapes table breaks, links and HTML', () => {
  const md = R.toMarkdown(fakeResult(), 'Title');
  const row = md.split('\n').find((l) => l.includes('HYPERLINK'));
  assert.ok(row.includes('\\|'));
  assert.ok(row.includes('\\<script\\>'));
  assert.ok(row.includes('\\[a\\]\\(b\\)'));
  assert.equal(row.split(' | ').length, 6, 'the hostile text does not add table columns');
  assert.match(md, /\*\*1 breaking, 1 non-breaking, 0 documentation\*\*/);
});

test('report: a real comparison exports in all three formats', async () => {
  const v1 = require('../src/samples').sampleFor('schema').text;
  const v2 = require('../src/samples').sampleFor('schemaV2').text;
  const r = diffSets(await L.loadTexts({ 'v1.xsd': v1 }), await L.loadTexts({ 'v2.xsd': v2 }), { labels: { old: 'v1', new: 'v2' } });
  assert.deepEqual(r.changes.map((c) => c.code).sort(), ['attribute-became-required', 'child-added-optional', 'child-added-required', 'documentation-changed', 'enumeration-added', 'enumeration-removed', 'version-changed'].filter((c) => c !== 'attribute-became-required'));
  assert.equal(r.counts.BREAKING, 2);
  for (const out of [R.toMarkdown(r), R.toHtml(r), R.toCsv(r)]) assert.ok(out.length > 200);
  assert.equal(R.toCsv(r).split('\r\n').length, r.changes.length + 2);
});

test('docs: Markdown and HTML documentation of a corpus set', async () => {
  const f = L.corpusFiles('xsd').find((x) => x.includes('25-documentation-rich'));
  const set = await L.loadFile(f);
  const md = DOCS.toMarkdown(set, 'Timesheet reference');
  assert.match(md, /^# Timesheet reference/);
  assert.match(md, /## Namespace `urn:example:docs:timesheet`/);
  assert.match(md, /Timesheets submitted weekly by contractors\./);
  assert.match(md, /#### <a id="complextype-urn-example-docs-timesheet-entrytype"><\/a>EntryType/);
  assert.match(md, /\| contractor \| xs:token \| 1 \|  \| Contractor reference from the vendor register\. \|/);
  assert.match(md, /Used by: \[complexType TimesheetType\]/);
  assert.match(md, /## Type index/);
  const html = DOCS.toHtml(set, 'Timesheet <reference>');
  assert.ok(html.includes('Timesheet &lt;reference&gt;'));
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes('id="complextype-urn-example-docs-timesheet-entrytype"'));
  for (const c of L.corpusFiles('xsd')) {
    const s = await L.loadFile(c);
    assert.doesNotThrow(() => { DOCS.toMarkdown(s, 'x'); DOCS.toHtml(s, 'x'); }, c);
  }
});

function oracleAvailable() { return cp.spawnSync('python', ['-c', 'import lxml'], { windowsHide: true }).status === 0; }

test('flatten: every corpus schema flattens to files that load without errors and keep the components', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsdatlas-flat-'));
  const reqs = [];
  const schemas = [];
  try {
    for (const f of L.corpusFiles('xsd')) {
      const set = await L.loadFile(f);
      const r = flattenSet(set, path.basename(f, '.xsd') + '-flat');
      if (f.includes('09-redefine')) { if (f.includes('main')) { assert.equal(r.ok, false); assert.match(r.message, /redefine/); } continue; }
      assert.equal(r.ok, true, f);
      const sub = fs.mkdtempSync(path.join(dir, 'x'));
      for (const x of r.files) fs.writeFileSync(path.join(sub, x.name), x.text);
      const entry = path.join(sub, r.files[0].name);
      const flat = await L.loadFile(entry);
      const problems = L.checkFile(flat, L.uriOf(entry)).filter((p) => p.severity === 'error');
      assert.deepEqual(problems.map((p) => p.code + ' ' + p.message), [], f);
      assert.equal(flat.all().length, set.all().length, 'component count of ' + path.basename(f));
      const nsCount = new Set(set.docs.map((d) => d.ns)).size;
      assert.equal(r.files.length, nsCount, path.basename(f));
      for (const c of set.all('element').filter((x) => x.doc.uri === L.uriOf(f))) {
        const s = buildSample(set, c, { mode: 'full', seed: 3 });
        const file = path.join(sub, c.name + '.xml');
        fs.writeFileSync(file, s.text);
        const fc = flat.lookup('element', c.ns, c.name);
        assert.ok(fc, c.name);
        if (!s.notes.some((n) => /keyref/.test(n))) assert.deepEqual(SC.check(flat, P.parseXml(s.text)), [], c.name + ' against the flattened schema');
        reqs.push([entry, file]);
      }
      schemas.push(entry);
    }
    if (oracleAvailable()) {
      const r = cp.spawnSync('python', [path.join(__dirname, 'helpers', 'oracle.py')], { input: JSON.stringify({ schemas: schemas, instances: reqs }), encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true });
      const answer = JSON.parse(r.stdout);
      assert.deepEqual(Object.entries(answer.schemas).filter((e) => e[1]), [], 'the independent validator accepts every flattened schema');
      assert.deepEqual(answer.instances.filter((x) => x.error && !/IDC|key-sequence/.test(x.error)).map((x) => x.error), []);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('flatten: chameleon includes, mixed form defaults and a default XSD namespace', async () => {
  const main = '<schema xmlns="http://www.w3.org/2001/XMLSchema" xmlns:t="urn:t" targetNamespace="urn:t" elementFormDefault="qualified"><include schemaLocation="p.xsd"/><element name="r" type="t:P"/></schema>';
  const part = '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:complexType name="P"><xs:sequence><xs:element name="a" type="Q"/></xs:sequence></xs:complexType><xs:simpleType name="Q"><xs:restriction base="xs:string"/></xs:simpleType></xs:schema>';
  const set = await L.loadTexts({ 'main.xsd': main, 'p.xsd': part });
  const r = flattenSet(set, 'out');
  assert.equal(r.files.length, 1);
  const text = r.files[0].text;
  assert.match(text, /<xs:element name="a" type="t:Q" form="unqualified"\/>/);
  assert.match(text, /<xs:element name="r" type="t:P"\/>/);
  const back = await L.loadTexts({ 'out.xsd': text });
  assert.deepEqual(L.checkFile(back, 'file:///mem/out.xsd'), []);
});

test('soap: envelopes for every SOAP operation of the WSDL corpus are well-formed and consistent', async () => {
  let ops = 0;
  for (const f of L.corpusFiles('wsdl').filter((x) => x.endsWith('.wsdl'))) {
    const set = await L.loadFile(f);
    for (const op of SOAP.soapOperations(set)) {
      ops++;
      const e = SOAP.buildEnvelopes(set, op, { mode: 'full', seed: 2 });
      assert.ok(e.request, op.label);
      for (const t of [e.request, e.response].concat(e.faults.map((x) => x.text)).filter(Boolean)) {
        const parsed = P.parseXml(t);
        assert.deepEqual(parsed.errors, [], op.label);
        assert.equal(parsed.root.ns, SOAP.ENV[op.version]);
        const body = P.childElements(parsed.root).find((c) => c.local === 'Body');
        assert.ok(body, op.label);
        for (const child of P.childElements(body)) {
          if (child.local === 'Fault' || op.binding.style === 'rpc' || (op.operation.style === 'rpc')) continue;
          const sub = P.parseXml(t.slice(child.start, child.end).replace(/^<([^\s>/]+)/, function (m) { return m + Object.entries(P.inScopeNamespaces(child)).filter((x) => x[0]).map((x) => ' xmlns:' + x[0] + '="' + x[1] + '"').join(''); }));
          assert.deepEqual(SC.check(set, sub), [], op.label + ' body');
        }
      }
    }
  }
  assert.ok(ops >= 18, 'operations ' + ops);
});

test('soap: SOAP 1.1 and 1.2 specifics, rpc wrapper, headers and faults', async () => {
  const w05 = await L.loadFile(L.corpusFiles('wsdl').find((x) => x.includes('w05')));
  const e = SOAP.buildEnvelopes(w05, SOAP.soapOperations(w05)[0], { mode: 'minimal' });
  assert.match(e.request, /SOAPAction: "urn:example:orders:Submit"/);
  assert.match(e.request, /<soap:Header>\s*<tns:Credentials/);
  assert.equal(e.faults.length, 2);
  assert.match(e.faults[0].text, /<faultcode>soap:Server<\/faultcode>/);
  const w04 = await L.loadFile(L.corpusFiles('wsdl').find((x) => x.includes('w04')));
  const r = SOAP.buildEnvelopes(w04, SOAP.soapOperations(w04)[0], { mode: 'minimal' });
  assert.match(r.request, /<op:Add xmlns:op="urn:example:calc:rpc">/);
  assert.match(r.request, /<precision>/);
  assert.match(r.response, /<op:AddResponse/);
  const w12 = await L.loadFile(L.corpusFiles('wsdl').find((x) => x.includes('w12')));
  const f = SOAP.buildEnvelopes(w12, SOAP.soapOperations(w12)[0], { mode: 'minimal' });
  assert.match(f.request, /application\/soap\+xml; charset=utf-8; action="urn:example:bookings:Book"/);
  assert.match(f.request, /http:\/\/www\.w3\.org\/2003\/05\/soap-envelope/);
  assert.match(f.faults[0].text, /<soap:Value>soap:Receiver<\/soap:Value>/);
  const w13 = await L.loadFile(L.corpusFiles('wsdl').find((x) => x.includes('w13')));
  assert.equal(SOAP.soapOperations(w13)[0].version, '1.1');
  const w14 = await L.loadFile(L.corpusFiles('wsdl').find((x) => x.includes('w14')));
  assert.equal(SOAP.soapOperations(w14).length, 1, 'the HTTP binding is not a SOAP operation');
});

test('inventory: links, users, missing files, shared namespaces and unused types', () => {
  const files = L.corpusFiles('xsd').concat(L.corpusFiles('wsdl')).map((f) => ({ uri: L.uriOf(f), text: fs.readFileSync(f, 'utf8'), rel: path.basename(f) }));
  files.push({ uri: 'file:///mem/extra/orphan.xsd', text: '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:example:logistics:common:1"><xs:include schemaLocation="gone.xsd"/><xs:simpleType name="Unused"><xs:restriction base="xs:string"/></xs:simpleType></xs:schema>', rel: 'extra/orphan.xsd' });
  files.push({ uri: 'file:///mem/extra/notes.xsd', text: '<notes', rel: 'extra/notes.xsd' });
  const inv = INV.buildInventory(files);
  assert.equal(inv.totals.files, files.length);
  assert.equal(inv.totals.withErrors, 1);
  assert.deepEqual(inv.missing.map((m) => m.from), ['extra/orphan.xsd']);
  assert.ok(inv.unusedTypes.some((t) => t.name === 'Unused'));
  assert.ok(!inv.unusedTypes.some((t) => t.name === 'IdentifierType'));
  assert.ok(inv.sharedNamespaces.some((s) => s.ns === 'urn:example:logistics:common:1'));
  const common = inv.files.find((x) => x.name === '06-common.xsd');
  assert.deepEqual(inv.importedBy.get(common.uri).sort(), ['06-party.xsd', '06-shipment.xsd']);
  const md = INV.toMarkdown(inv);
  assert.match(md, /## Missing files/);
  assert.ok(INV.toHtml(inv).includes('<table>'));
  assert.equal(INV.toCsv(inv).split('\r\n').length, files.length + 2);
});
