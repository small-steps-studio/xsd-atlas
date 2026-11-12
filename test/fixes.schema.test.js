'use strict';
// Behaviour that was wrong once and must stay right: schema locations on other computers, sample
// building (wildcards, QName and ID values, huge lengths), XML reader limits, flattening of QName
// values, the extra problem checks, SOAP notes, report markup, manifest and ignore-file rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const L = require('./helpers/load');
const P = require('../src/xml/parser');
const U = require('../src/util');
const { loadSchemaSet } = require('../src/schema/set');
const { buildSample } = require('../src/sample/sample');
const { flattenSet } = require('../src/pro/flatten');
const SOAP = require('../src/pro/soap');
const DOCS = require('../src/pro/docs');
const REPORT = require('../src/pro/report');
const INV = require('../src/pro/inventory');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');

function sample(set, name, options) {
  return buildSample(set, set.lookup('element', 'urn:t', name), options || { mode: 'minimal' });
}

// ---- schema locations -------------------------------------------------------------------------

test('locations on other computers and on the internet are never read; local files are', async () => {
  const reads = [];
  const text = L.schema(
    '<xs:include schemaLocation="\\\\fileserver\\share\\y.xsd"/>' +
    '<xs:include schemaLocation="//fileserver/share/x.xsd"/>' +
    '<xs:import namespace="urn:g" schemaLocation="file://other-host/s/y.xsd"/>' +
    '<xs:import namespace="urn:h" schemaLocation="file:////fileserver/share/z.xsd"/>' +
    '<xs:import namespace="urn:h2" schemaLocation="file:///%5C%5Cfileserver%5Cshare%5Cw.xsd"/>' +
    '<xs:import namespace="urn:i" schemaLocation="ftp://host/x.xsd"/>' +
    '<xs:import namespace="urn:j" schemaLocation="http://example.com/x.xsd"/>' +
    '<xs:import namespace="urn:k" schemaLocation="local.xsd"/>');
  const set = await loadSchemaSet({ uri: 'file:///mem/main.xsd', text: text }, { read: async (u) => { reads.push(u); return { error: 'missing' }; } });
  assert.deepEqual(reads, ['file:///mem/local.xsd'], 'only the file next to the schema was requested');
  const status = new Map(set.docs[0].directives.map((d) => [d.location, d.status]));
  for (const [loc, st] of status) assert.equal(st, loc === 'local.xsd' ? 'missing' : 'remote', loc);
  const problems = L.checkFile(set, 'file:///mem/main.xsd');
  assert.ok(problems.filter((p) => p.code === 'XSD-UNREACHABLE-IMPORT').length >= 7, 'each foreign location is reported');
});

test('a schema that lives on a network share may name files on the same share', () => {
  assert.equal(U.foreignLocation('file://server/share/b.xsd', 'file://server/share/a.xsd'), '');
  assert.equal(U.foreignLocation('file://other/share/b.xsd', 'file://server/share/a.xsd'), 'host');
  assert.equal(U.foreignLocation('file:///c:/work/b.xsd', 'file:///c:/work/a.xsd'), '');
  assert.equal(U.foreignLocation('file:///c:/work/b.xsd', 'file://server/share/a.xsd'), 'host');
  assert.equal(U.foreignLocation('file:///c:/work/b.xsd', 'untitled:Untitled-1'), '');
  assert.equal(U.foreignLocation('http://example.com/b.xsd', 'file:///c:/work/a.xsd'), 'internet');
  assert.equal(U.foreignLocation('https://example.com/b.xsd', 'https://example.com/a.xsd'), '');
});

// ---- samples ----------------------------------------------------------------------------------

test('samples: a required wildcard never overflows the stack and always gives a valid, noted document', async () => {
  const wrap = (any, extra) => '<xs:element name="root"><xs:complexType><xs:sequence>' + any + '</xs:sequence></xs:complexType></xs:element>' + (extra || '');
  const cases = [
    wrap('<xs:any processContents="strict"/>'),
    wrap('<xs:any/>'),
    wrap('<xs:any namespace="##targetNamespace"/>'),
    wrap('<xs:any namespace="##targetNamespace" processContents="strict"/>', '<xs:element name="other" type="xs:string"/>'),
    wrap('<xs:any namespace="##any" processContents="lax" minOccurs="2" maxOccurs="4"/>', '<xs:element name="other" type="xs:string"/>'),
    wrap('<xs:any namespace="##other" processContents="lax"/>')
  ];
  for (const body of cases) {
    const set = await L.loadTexts({ 'm.xsd': L.schema(body) });
    for (const opts of [{ mode: 'minimal' }, { mode: 'full', repeat: 3, seed: 5 }, { mode: 'full', choice: 'random', seed: 9 }]) {
      const r = buildSample(set, set.lookup('element', 'urn:t', 'root'), opts);
      assert.deepEqual(P.parseXml(r.text).errors, [], body);
    }
  }
  const alone = await L.loadTexts({ 'm.xsd': L.schema(cases[0]) });
  const r = sample(alone, 'root');
  assert.match(r.text, /an element allowed by the wildcard goes here/);
  assert.ok(r.notes.some((n) => /wildcard/.test(n)), 'a note explains the placeholder');
  const other = await L.loadTexts({ 'm.xsd': L.schema(cases[3]) });
  assert.match(sample(other, 'root').text, /<t:other>/, 'a different global element that the wildcard admits is used');
});

test('samples: QName and NOTATION enumerations declare the prefix they use; ID references name an ID of the sample', async () => {
  const q = await L.loadTexts({ 'm.xsd': L.schema('<xs:simpleType name="Q"><xs:restriction base="xs:QName"><xs:enumeration value="o:thing"/></xs:restriction></xs:simpleType><xs:element name="r" type="t:Q"/>', 'xmlns:o="urn:o"') });
  const rq = sample(q, 'r');
  const parsed = P.parseXml(rq.text);
  assert.deepEqual(parsed.errors, []);
  const value = P.textContent(parsed, parsed.root).trim();
  const prefix = value.split(':')[0];
  assert.equal(value.split(':')[1], 'thing');
  assert.equal(P.inScopeNamespaces(parsed.root)[prefix], 'urn:o', 'the prefix of the value is bound to the namespace of the schema');

  const ids = await L.loadTexts({ 'm.xsd': L.schema('<xs:element name="r"><xs:complexType><xs:sequence><xs:element name="a" type="xs:ID"/><xs:element name="b" type="xs:IDREF"/><xs:element name="c" type="xs:IDREFS"/></xs:sequence></xs:complexType></xs:element>' +
    '<xs:element name="alone"><xs:complexType><xs:sequence><xs:element name="b" type="xs:IDREF"/></xs:sequence></xs:complexType></xs:element>') });
  const withId = sample(ids, 'r');
  const doc = P.parseXml(withId.text);
  const texts = P.childElements(doc.root).map((c) => P.textContent(doc, c));
  assert.equal(texts[1], texts[0], 'the IDREF names the ID');
  assert.equal(texts[2], texts[0], 'the IDREFS list names the ID');
  assert.deepEqual(withId.notes, []);
  const lonely = sample(ids, 'alone');
  assert.ok(lonely.notes.some((n) => /IDREF/.test(n) && /no element or attribute with that ID/.test(n)), 'an IDREF without an ID gets a note');
});

test('samples: absurd lengths are cut off quickly with a note instead of building megabytes', async () => {
  const list = await L.loadTexts({ 'm.xsd': L.schema('<xs:simpleType name="Big"><xs:restriction><xs:simpleType><xs:list itemType="xs:string"/></xs:simpleType><xs:minLength value="1000000"/></xs:restriction></xs:simpleType><xs:element name="r" type="t:Big"/>') });
  const str = await L.loadTexts({ 'm.xsd': L.schema('<xs:simpleType name="Big"><xs:restriction base="xs:string"><xs:minLength value="5000000"/></xs:restriction></xs:simpleType><xs:element name="r" type="t:Big"/>') });
  for (const set of [list, str]) {
    for (const opts of [{ mode: 'minimal' }, { mode: 'full', seed: 1 }]) {
      const t0 = Date.now();
      const r = sample(set, 'r', opts);
      assert.ok(Date.now() - t0 < 2000, 'built in ' + (Date.now() - t0) + ' ms');
      assert.ok(r.text.length < 1000, 'no huge value: ' + r.text.length);
      assert.ok(r.notes.length >= 1, 'a note says that no value was built');
    }
  }
  assert.match(sample(list, 'r').notes.join('\n'), /10000/);
});

// ---- the XML reader ---------------------------------------------------------------------------

test('xml reader: an element with 200,000 attributes is read in well under five seconds, duplicates are still found', () => {
  let attrs = '';
  for (let i = 0; i < 200000; i++) attrs += ' a' + i + '="1"';
  const t0 = Date.now();
  const ok = P.parseXml('<r' + attrs + '/>');
  const ms = Date.now() - t0;
  assert.deepEqual(ok.errors, []);
  assert.ok(ms < 3000, 'took ' + ms + ' ms');
  const dup = P.parseXml('<r' + attrs + ' a77="2"/>');
  assert.deepEqual(dup.errors.map((e) => e.code), ['XML-DUPLICATE-ATTRIBUTE']);
  const ns = P.parseXml('<r xmlns:a="urn:x" xmlns:b="urn:x" a:k="1" b:k="2"/>');
  assert.deepEqual(ns.errors.map((e) => e.code), ['XML-DUPLICATE-ATTRIBUTE'], 'also after namespace resolution');
});

test('xml reader: "]]>" and forbidden control characters in text are reported', () => {
  assert.deepEqual(P.parseXml('<r>a ]]> b</r>').errors.map((e) => e.code), ['XML-CDATA-END-IN-TEXT']);
  assert.deepEqual(P.parseXml('<r>a \u0001 b</r>').errors.map((e) => e.code), ['XML-INVALID-CHARACTER']);
  assert.deepEqual(P.parseXml('<r>a \u0000 b</r>').errors.map((e) => e.code), ['XML-INVALID-CHARACTER']);
  assert.deepEqual(P.parseXml('<r><![CDATA[a ]]> b</r>').errors, [], 'the end of a CDATA section is fine');
  assert.deepEqual(P.parseXml('<r>tab\there\nnew line\r\n</r>').errors, []);
});

// ---- problems ---------------------------------------------------------------------------------

test('problems: a misspelt schema attribute and a type next to an inline type are reported', async () => {
  const typo = await L.problemsOf(L.schema('<xs:element name="r" typ="xs:int"/>'));
  assert.deepEqual(typo.map((p) => p.code), ['XSD-UNKNOWN-ATTRIBUTE']);
  assert.match(typo[0].message, /did you mean "type"/);
  const both = await L.problemsOf(L.schema('<xs:element name="r" type="xs:int"><xs:simpleType><xs:restriction base="xs:string"/></xs:simpleType></xs:element>'));
  assert.deepEqual(both.map((p) => p.code), ['XSD-NOT-ALLOWED-HERE']);
  for (const fine of [
    '<xs:element name="r" type="xs:int" a:note="x" xmlns:a="urn:a"/>',
    '<xs:element name="r" type="xs:int" id="e1" nillable="true" default="1"/>',
    '<xs:complexType name="C" mixed="true"><xs:attribute name="k" type="xs:string" use="optional" inheritable="true"/></xs:complexType>'
  ]) assert.deepEqual(await L.problemsOf(L.schema(fine)), [], fine);
});

test('problems: the gaps listed in the documentation are the ones that exist', async () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'problems.md'), 'utf8');
  assert.match(doc, /What the checks do not cover/);
  const gaps = {
    ambiguous: L.schema('<xs:element name="r"><xs:complexType><xs:sequence><xs:element name="a" type="xs:string" minOccurs="0"/><xs:element name="a" type="xs:string"/></xs:sequence></xs:complexType></xs:element>'),
    listOfList: L.schema('<xs:simpleType name="L1"><xs:list itemType="xs:int"/></xs:simpleType><xs:simpleType name="L2"><xs:list itemType="t:L1"/></xs:simpleType><xs:element name="r" type="t:L2"/>'),
    substitution: L.schema('<xs:element name="head" type="xs:int"/><xs:element name="m" type="xs:string" substitutionGroup="t:head"/>')
  };
  for (const [name, text] of Object.entries(gaps)) assert.deepEqual((await L.problemsOf(text)).filter((p) => p.severity === 'error'), [], name);
  const all = await L.problemsOf(L.schema('<xs:element name="r"><xs:complexType><xs:all><xs:element name="a" type="xs:string" maxOccurs="3"/></xs:all></xs:complexType></xs:element>'));
  assert.deepEqual(all.map((p) => p.code + ':' + p.severity), ['XSD-ALL-OCCURS:info']);
});

// ---- flatten, SOAP, reports --------------------------------------------------------------------

test('flatten: QName values (defaults, fixed values, enumerations) follow the renamed prefixes', async () => {
  const one = '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:p="urn:a" targetNamespace="urn:a" elementFormDefault="qualified"><xs:import namespace="urn:b" schemaLocation="two.xsd"/>' +
    '<xs:element name="r"><xs:complexType><xs:attribute name="d" type="xs:QName" default="p:B"/></xs:complexType></xs:element></xs:schema>';
  const two = '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:p="urn:b" targetNamespace="urn:b">' +
    '<xs:complexType name="B"><xs:attribute name="d" type="xs:QName" default="p:B"/></xs:complexType>' +
    '<xs:simpleType name="E"><xs:restriction base="xs:QName"><xs:enumeration value="p:B"/><xs:enumeration value="xs:string"/></xs:restriction></xs:simpleType>' +
    '<xs:element name="e" type="p:E" fixed="p:B"/></xs:schema>';
  const set = await L.loadTexts({ 'one.xsd': one, 'two.xsd': two });
  const r = flattenSet(set, 'out');
  assert.equal(r.ok, true);
  const second = r.files.find((f) => f.ns === 'urn:b');
  const prefix = /xmlns:([A-Za-z0-9]+)="urn:b"/.exec(second.text)[1];
  assert.notEqual(prefix, 'p', 'the prefix of urn:b was renamed in the output');
  assert.ok(second.text.includes('default="' + prefix + ':B"'), second.text);
  assert.ok(second.text.includes('<xs:enumeration value="' + prefix + ':B"/>'));
  assert.ok(second.text.includes('<xs:enumeration value="xs:string"/>'));
  assert.ok(second.text.includes('fixed="' + prefix + ':B"'));
  const first = r.files.find((f) => f.ns === 'urn:a');
  assert.ok(first.text.includes('default="p:B"') || /default="[A-Za-z0-9]+:B"/.test(first.text));
  const again = await L.loadTexts({ 'one.xsd': first.text, 'out-2.xsd': second.text });
  assert.deepEqual(L.checkFile(again, 'file:///mem/one.xsd').filter((p) => p.severity === 'error'), []);
});

test('soap: a binding with use="encoded" gets a note that the envelope is literal XML', async () => {
  const wsdl = fs.readFileSync(path.join(L.FIXTURES, 'corpus', 'wsdl', 'w04-rpc-literal.wsdl'), 'utf8');
  const literal = await L.loadTexts({ 'w.wsdl': wsdl });
  assert.deepEqual(SOAP.buildEnvelopes(literal, SOAP.soapOperations(literal)[0], { mode: 'minimal' }).notes, []);
  const encoded = await L.loadTexts({ 'w.wsdl': wsdl.replace(/use="literal"/g, 'use="encoded"') });
  const e = SOAP.buildEnvelopes(encoded, SOAP.soapOperations(encoded)[0], { mode: 'minimal' });
  assert.equal(e.notes.length, 1);
  assert.match(e.notes[0], /use="encoded".*literal XML/);
});

test('reports: every table header of the HTML outputs has a scope', async () => {
  const set = await L.loadFile(path.join(L.FIXTURES, 'corpus', 'xsd', '28-invoice-message.xsd'));
  const result = { labels: { old: 'a', new: 'b' }, counts: { BREAKING: 1, 'NON-BREAKING': 0, DOCUMENTATION: 0 }, changes: [{ severity: 'BREAKING', code: 'child-removed', component: 'element e', path: 'p', message: 'm', before: '', after: '', oldLoc: null, newLoc: null }] };
  const inv = INV.buildInventory([{ uri: 'file:///mem/a.xsd', text: fs.readFileSync(path.join(L.FIXTURES, 'corpus', 'xsd', '28-invoice-message.xsd'), 'utf8'), rel: 'a.xsd' }]);
  for (const html of [DOCS.toHtml(set, 'T'), REPORT.toHtml(result, 'T'), INV.toHtml(inv)]) {
    const headers = html.match(/<th(?=[\s>])[^>]*>/g) || [];
    assert.ok(headers.length > 0);
    for (const h of headers) assert.match(h, /scope="col"/);
  }
});

// ---- small helpers, manifest and ignore files --------------------------------------------------

test('Compare With Git Revision: "inside the repository" is decided by whole path segments', () => {
  assert.equal(U.isInsideFolder('/repo/a/x.xsd', '/repo', 'linux'), true);
  assert.equal(U.isInsideFolder('/repo2/x.xsd', '/repo', 'linux'), false);
  assert.equal(U.isInsideFolder('/Repo/x.xsd', '/repo', 'linux'), false, 'paths are case sensitive on Linux');
  assert.equal(U.isInsideFolder('/Repo/x.xsd', '/repo', 'darwin'), true);
  assert.equal(U.isInsideFolder('C:\\Work\\Repo\\a\\x.xsd', 'c:\\work\\repo', 'win32'), true);
  assert.equal(U.isInsideFolder('C:\\Work\\Repo2\\x.xsd', 'c:\\work\\repo', 'win32'), false);
  assert.equal(U.isInsideFolder('/repo', '/repo/', 'linux'), true);
  assert.equal(U.isInsideFolder('/repo/x.xsd', '', 'linux'), false);
});

test('CSV: the formula guard can be turned off, quoting always applies', () => {
  assert.equal(U.csvCell('=1+1'), "'=1+1");
  assert.equal(U.csvCell('=1+1', true), "'=1+1");
  assert.equal(U.csvCell('=1+1', false), '=1+1');
  assert.equal(U.csvCell('-5,5', false), '"-5,5"');
  assert.equal(U.csvCell('+x', undefined), "'+x");
  for (const lead of ['=', '+', '-', '@', '\t', '\r']) assert.equal(U.csvCell(lead + 'a')[0], lead === '\r' ? '"' : "'", JSON.stringify(lead));
});

test('walkthrough: every completion event is one the editor defines', () => {
  const allowed = /^(onCommand:[A-Za-z0-9.]+|onView:[A-Za-z0-9.]+|onSettingChanged:[A-Za-z0-9.]+|onContext:.+|onStepSelected|extensionInstalled:.+)$/;
  for (const w of pkg.contributes.walkthroughs) {
    for (const s of w.steps) for (const ev of s.completionEvents || []) assert.match(ev, allowed, s.id + ' ' + ev);
  }
});

test('working notes, audits and the local test harness stay out of the package and the repository', () => {
  const pack = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').split(/\r?\n/);
  const git = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
  for (const pattern of ['QA-*.md', 'SPEC-*.md', 'STATUS*', 'TODO-BEFORE-PUBLISH.md', 'RELEASE-NOTES-*.md', '*-SPEC.md', '*NOTES*.md']) {
    assert.ok(pack.includes(pattern), '.vscodeignore lacks ' + pattern);
    assert.ok(git.includes(pattern), '.gitignore lacks ' + pattern);
  }
  assert.ok(git.includes('test/smoke/'));
  assert.ok(pack.includes('test/**'));
  assert.ok(pack.includes('scripts/**'));
});

// ---- the independent validator with a path that is not ASCII ------------------------------------

function oracleAvailable() {
  const r = cp.spawnSync('python', ['-c', 'import lxml'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0;
}

test('oracle: schema and instance paths with spaces and non-ASCII characters are read correctly', { skip: !oracleAvailable() && 'the lxml package for Python is not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsdatlas-\u017E \u00E9-'));
  try {
    const xsd = path.join(dir, 'sch\u00E9ma \u0436.xsd');
    fs.writeFileSync(xsd, fs.readFileSync(path.join(L.FIXTURES, 'corpus', 'xsd', '02-library-loan-salami.xsd')));
    const set = await L.loadFile(xsd);
    const root = set.all('element').find((e) => e.doc.uri === L.uriOf(xsd));
    const xml = path.join(dir, 'inst\u00E4nce.xml');
    fs.writeFileSync(xml, buildSample(set, root, { mode: 'minimal' }).text);
    const r = cp.spawnSync('python', [path.join(__dirname, 'helpers', 'oracle.py')], { input: JSON.stringify({ schemas: [xsd], instances: [[xsd, xml]] }), encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    const answer = JSON.parse(r.stdout);
    assert.equal(answer.schemas[xsd], '');
    assert.equal(answer.instances[0].error, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('oracle: the schema of the XML namespace comes from a local file and no web address is ever fetched', { skip: !oracleAvailable() && 'the lxml package for Python is not installed' }, async () => {
  // A logging web server stands in for every address: the oracle gets it as its HTTP proxy as well,
  // so a fetch of the real address of the XML namespace schema would be seen here too.
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); res.statusCode = 404; res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsdatlas-xmlns-'));
  try {
    const head = '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xml="http://www.w3.org/XML/1998/namespace" xmlns:t="urn:t" targetNamespace="urn:t" elementFormDefault="qualified">';
    const withXml = path.join(dir, 'with-xml.xsd');
    fs.writeFileSync(withXml, head + '<xs:import namespace="http://www.w3.org/XML/1998/namespace" schemaLocation="http://www.w3.org/2001/xml.xsd"/>' +
      '<xs:element name="p"><xs:complexType><xs:simpleContent><xs:extension base="xs:string"><xs:attribute ref="xml:lang" use="required"/><xs:attribute ref="xml:space"/></xs:extension></xs:simpleContent></xs:complexType></xs:element></xs:schema>');
    const withFar = path.join(dir, 'with-far.xsd');
    fs.writeFileSync(withFar, head + '<xs:import namespace="urn:far" schemaLocation="http://127.0.0.1:' + port + '/far.xsd"/><xs:element name="q" type="xs:string"/></xs:schema>');
    const docs = {
      good: '<p xmlns="urn:t" xml:lang="de-AT" xml:space="preserve">x</p>',
      empty: '<p xmlns="urn:t" xml:lang="">x</p>',
      missing: '<p xmlns="urn:t">x</p>',
      badLang: '<p xmlns="urn:t" xml:lang="not a tag!">x</p>',
      badSpace: '<p xmlns="urn:t" xml:lang="en" xml:space="squeeze">x</p>'
    };
    const instances = [];
    for (const [name, text] of Object.entries(docs)) {
      fs.writeFileSync(path.join(dir, name + '.xml'), text);
      instances.push([withXml, path.join(dir, name + '.xml')]);
    }
    const request = JSON.stringify({ schemas: [withXml, withFar], instances: instances });
    const proxy = 'http://127.0.0.1:' + port;
    const env = Object.assign({}, process.env, { http_proxy: proxy, HTTP_PROXY: proxy, https_proxy: proxy, HTTPS_PROXY: proxy, no_proxy: '', NO_PROXY: '' });
    const answer = await new Promise((resolve, reject) => {
      const child = cp.spawn('python', [path.join(__dirname, 'helpers', 'oracle.py')], { env: env, windowsHide: true });
      const out = [];
      const err = [];
      child.stdout.on('data', (d) => out.push(d));
      child.stderr.on('data', (d) => err.push(d));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(JSON.parse(Buffer.concat(out).toString('utf8'))) : reject(new Error(Buffer.concat(err).toString('utf8')))));
      child.stdin.end(request);
    });
    assert.deepEqual(hits, [], 'nothing was requested from any web address');
    assert.equal(answer.schemas[withXml], '', 'the schema that imports the XML namespace schema is accepted');
    assert.equal(typeof answer.schemas[withFar], 'string', 'the schema with an import from another web address was answered without fetching it');
    const byName = {};
    Object.keys(docs).forEach((name, i) => { byName[name] = answer.instances[i].error === ''; });
    assert.deepEqual(byName, { good: true, empty: true, missing: false, badLang: false, badSpace: false }, 'the imported declarations are really applied');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- publisher identity ---------------------------------------------------------------------------

test('identity: publisher, repository and support links all name Small Steps Studio', () => {
  const config = require('../src/licence/config');
  const repo = 'https://github.com/small-steps-studio/xsd-atlas';
  assert.equal(pkg.publisher, 'SmallStepsStudio');
  assert.equal(pkg.homepage, repo + '#readme');
  assert.equal(pkg.repository.url, repo);
  assert.equal(pkg.bugs.url, repo + '/issues');
  assert.equal(config.issuesUrl, repo + '/issues');
  assert.equal(config.docsUrl, repo + '#readme');
  assert.equal(config.repositoryUrl, repo);
  assert.equal(config.docsBaseUrl, repo + '/blob/HEAD/docs/');
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  assert.match(read('LICENSE.txt'), /^Copyright \(c\) 2026 Small Steps Studio\./m);
  assert.match(read('LICENSE.txt'), /between you and Small Steps Studio/);
  assert.match(read('README.md'), /extension id: `SmallStepsStudio\.xsd-atlas`/);
  assert.match(read('src/commands.js'), /SmallStepsStudio\.xsd-atlas#xsdAtlas\.gettingStarted/);
  for (const f of ['README.md', 'PRIVACY.md', 'TERMS.md', 'LICENSE.txt']) assert.ok(read(f).includes('small-steps-studio/xsd-atlas'), f);
});

// ---- flatten: imports that no reference uses ------------------------------------------------------

const DRIVER = {
  'main.xsd': '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:a="urn:a" targetNamespace="urn:a" elementFormDefault="qualified">' +
    '<xs:import namespace="urn:b" schemaLocation="b.xsd"/><xs:import namespace="urn:c" schemaLocation="c.xsd"/>' +
    '<xs:import namespace="urn:far" schemaLocation="https://example.com/far.xsd"/>' +
    '<xs:element name="order" type="xs:string"/></xs:schema>',
  'b.xsd': '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:b" elementFormDefault="qualified"><xs:element name="invoice" type="xs:int"/></xs:schema>',
  'c.xsd': '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:c" elementFormDefault="qualified"><xs:element name="receipt" type="xs:date"/></xs:schema>'
};

test('flatten: a driver schema keeps its imports even when no reference uses them', async () => {
  const set = await L.loadTexts(DRIVER);
  const r = flattenSet(set, 'out');
  assert.equal(r.ok, true);
  assert.equal(r.files.length, 3);
  const main = r.files[0].text;
  assert.equal(r.files[0].ns, 'urn:a');
  for (const f of r.files.slice(1)) assert.ok(main.includes('<xs:import namespace="' + f.ns + '" schemaLocation="' + f.name + '"/>'), f.ns + ' in ' + main);
  assert.ok(main.includes('<xs:import namespace="urn:far" schemaLocation="https://example.com/far.xsd"/>'), 'an import that could not be loaded stays as it was');
  // The written files load together from the entry file alone, and every global element is there.
  const again = await L.loadTexts({ 'out.xsd': r.files[0].text, 'out-2.xsd': r.files[1].text, 'out-3.xsd': r.files[2].text });
  for (const [ns, name] of [['urn:a', 'order'], ['urn:b', 'invoice'], ['urn:c', 'receipt']]) assert.ok(again.lookup('element', ns, name), ns + ' ' + name);
  assert.ok(r.notes.some((n) => /linked by import/.test(n)));
});

test('flatten: the flattened entry file accepts what the original accepts (libxml2, when installed)', { skip: !oracleAvailable() && 'the lxml package for Python is not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsdatlas-flat-'));
  try {
    const original = path.join(dir, 'orig');
    const flat = path.join(dir, 'flat');
    fs.mkdirSync(original);
    fs.mkdirSync(flat);
    for (const [name, text] of Object.entries(DRIVER)) fs.writeFileSync(path.join(original, name), text.replace(/<xs:import namespace="urn:far"[^>]*\/>/, ''));
    const set = await L.loadTexts(DRIVER);
    const r = flattenSet(set, 'out');
    for (const f of r.files) fs.writeFileSync(path.join(flat, f.name), f.text.replace(/<xs:import namespace="urn:far"[^>]*\/>/, ''));
    const docs = {
      'a.xml': '<order xmlns="urn:a">x</order>', 'b.xml': '<invoice xmlns="urn:b">12</invoice>', 'c.xml': '<receipt xmlns="urn:c">2026-01-31</receipt>',
      'bad-b.xml': '<invoice xmlns="urn:b">twelve</invoice>', 'bad-c.xml': '<receipt xmlns="urn:c">yesterday</receipt>'
    };
    const instances = [];
    for (const [name, text] of Object.entries(docs)) {
      fs.writeFileSync(path.join(dir, name), text);
      instances.push([path.join(original, 'main.xsd'), path.join(dir, name)], [path.join(flat, 'out.xsd'), path.join(dir, name)]);
    }
    const run = cp.spawnSync('python', [path.join(__dirname, 'helpers', 'oracle.py')], { input: JSON.stringify({ schemas: [], instances: instances }), encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    const answer = JSON.parse(run.stdout).instances;
    const names = Object.keys(docs);
    names.forEach((name, i) => {
      const o = answer[2 * i].error === '';
      const f = answer[2 * i + 1].error === '';
      assert.equal(f, o, name + ': original ' + (o ? 'accepts' : 'refuses') + ', flattened ' + (f ? 'accepts' : 'refuses') + ' ' + answer[2 * i + 1].error);
      assert.equal(o, !/^bad/.test(name), name);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
