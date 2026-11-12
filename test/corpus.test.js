'use strict';
// The corpus of original schemas and WSDL files: size of the corpus, no false problems, outline,
// navigation for every reference, hovers, and a large synthetic schema.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const L = require('./helpers/load');
const P = require('../src/xml/parser');
const N = require('../src/schema/navigate');
const D = require('../src/schema/describe');
const O = require('../src/schema/outline');
const S = require('../src/schema/set');

const ALL = L.corpusFiles('xsd').concat(L.corpusFiles('wsdl'));

test('corpus: at least 40 original schemas and 15 WSDL files', () => {
  const xsd = ALL.filter((f) => f.endsWith('.xsd'));
  const wsdl = ALL.filter((f) => f.endsWith('.wsdl'));
  assert.ok(xsd.length >= 40, 'xsd ' + xsd.length);
  assert.ok(wsdl.length >= 15, 'wsdl ' + wsdl.length);
  const styles = ['russian-doll', 'salami', 'venetian', 'eden', 'chain', 'cycle', 'chameleon', 'redefine', 'many-namespaces', 'wsdl20', 'rpc', 'soap12'];
  for (const s of styles) assert.ok(ALL.some((f) => f.includes(s)), 'style ' + s);
});

test('corpus: every file loads and has no error or warning (no false problems)', async () => {
  for (const f of ALL) {
    const set = await L.loadFile(f);
    const problems = L.checkFile(set, L.uriOf(f)).filter((p) => p.severity !== 'info');
    assert.deepEqual(problems.map((p) => p.code + ' ' + p.message), [], path.basename(f));
    assert.ok(set.docs.length >= 1 || set.wsdlDocs.length >= 1, path.basename(f));
  }
});

test('corpus: imports, includes and namespaces are followed', async () => {
  const many = await L.loadFile(ALL.find((f) => f.includes('20-many-namespaces-root')));
  assert.equal(many.docs.length, 9);
  assert.equal(many.loadedNamespaces.size, 9);
  const chain = await L.loadFile(ALL.find((f) => f.includes('05-chain-main')));
  assert.equal(chain.docs.length, 3);
  const cycle = await L.loadFile(ALL.find((f) => f.includes('07-cycle-a')));
  assert.equal(cycle.docs.length, 2);
  const cham = await L.loadFile(ALL.find((f) => f.includes('08-chameleon-host')));
  assert.ok(cham.lookup('type', 'urn:example:clinic:appointment', 'SlotType'), 'chameleon types take the host namespace');
  const red = await L.loadFile(ALL.find((f) => f.includes('09-redefine-main')));
  const ing = red.lookup('type', 'urn:example:recipe:card', 'IngredientType');
  assert.equal(ing.redefined, true);
  const def = require('../src/schema/content').defOfComp(red, ing);
  assert.deepEqual(require('../src/schema/content').flattenElements(def.particle).map((e) => e.particle.name), ['name', 'amount', 'unit']);
  const w = await L.loadFile(ALL.find((f) => f.includes('w08-import-main')));
  assert.equal(w.wsdlDocs.length, 2);
  const remote = await L.loadFile(ALL.find((f) => f.includes('24-xml-lang-remote')));
  assert.equal(remote.docs[0].directives[0].status, 'builtin');
});

test('corpus: every QName reference resolves to a definition with a location', async () => {
  let count = 0;
  for (const f of ALL) {
    const set = await L.loadFile(f);
    const uri = L.uriOf(f);
    const parsed = set.parsedByUri.get(uri).parsed;
    const stack = [parsed.root];
    while (stack.length) {
      const el = stack.pop();
      for (const a of el.attrs) {
        if (!['type', 'ref', 'base', 'itemType', 'memberTypes', 'substitutionGroup', 'element', 'message', 'binding', 'interface', 'refer'].includes(a.local) || a.prefix) continue;
        const t = N.targetAt(set, uri, a.valueStart);
        if (!t || t.what !== 'ref') continue;
        const comp = N.componentOf(set, t);
        assert.ok(comp, path.basename(f) + ' ' + a.local + '="' + a.value + '"');
        if (comp.builtin) continue;
        const defs = N.definitionAt(set, uri, a.valueStart);
        assert.ok(defs.length >= 1, path.basename(f) + ' ' + a.value);
        count++;
      }
      if (el.children) for (const k of el.children) if (k instanceof P.XmlElement) stack.push(k);
    }
  }
  assert.ok(count > 250, 'references checked: ' + count);
});

test('corpus: find references of a type across files', async () => {
  const f = ALL.find((x) => x.includes('06-shipment'));
  const set = await L.loadFile(f);
  const refs = N.referencesInSet(set, { space: 'type', ns: 'urn:example:logistics:common:1', local: 'IdentifierType' });
  const files = new Set(refs.map((r) => path.basename(new URL(r.uri).pathname)));
  assert.deepEqual(Array.from(files).sort(), ['06-party.xsd', '06-shipment.xsd']);
  assert.equal(refs.length, 3);
});

test('corpus: schemaLocation and declaration names are navigation targets', async () => {
  const f = ALL.find((x) => x.includes('06-shipment'));
  const set = await L.loadFile(f);
  const text = fs.readFileSync(f, 'utf8');
  const loc = N.targetAt(set, L.uriOf(f), text.indexOf('06-party.xsd') + 2);
  assert.equal(loc.what, 'location');
  assert.ok(loc.target.endsWith('06-party.xsd'));
  const decl = N.targetAt(set, L.uriOf(f), text.indexOf('name="PackageType"') + 7);
  assert.equal(decl.what, 'decl');
  assert.equal(decl.local, 'PackageType');
});

test('corpus: hovers describe types, elements, attributes, groups and WSDL parts', async () => {
  const cases = [
    ['03-ferry-ticket-venetian.xsd', 'type="ft:PassengerType"', /complex type.*PassengerType[\s\S]*givenName[\s\S]*category/],
    ['03-ferry-ticket-venetian.xsd', 'type="ft:CategoryType"', /Allowed values: `adult`, `child`, `senior`, `infant`/],
    ['12-facets-numbers-dates.xsd', 'type="nd:PriceType"', /minExclusive: `0\.00`[\s\S]*totalDigits: `9`/],
    ['17-groups-attribute-groups.xsd', 'ref="gr:EmployeeCoreGroup"', /group[\s\S]*given/],
    ['10-substitution-groups.xsd', 'ref="pm:paymentMethod"', /Substitution group members: `card`, `voucher`/],
    ['25-documentation-rich.xsd', 'type="dr:TimesheetType"', /The hours worked per day &amp; per project/],
    ['14-simple-content.xsd', 'type="sc:PriceType"', /Text content[\s\S]*@currency/]
  ];
  for (const [file, needle, re] of cases) {
    const f = ALL.find((x) => x.endsWith(file));
    const set = await L.loadFile(f);
    const text = fs.readFileSync(f, 'utf8');
    const at = text.indexOf(needle) + needle.indexOf('"') + 2;
    const t = N.targetAt(set, L.uriOf(f), at);
    const md = D.describeTarget(set, t, N.componentOf(set, t), t.node);
    assert.match(md, re, file + ' ' + needle + '\n' + md);
  }
  const w = ALL.find((x) => x.includes('w05-headers'));
  const set = await L.loadFile(w);
  const text = fs.readFileSync(w, 'utf8');
  const t = N.targetAt(set, L.uriOf(w), text.indexOf('message="tns:SubmitOrderIn"') + 12);
  assert.match(D.describeTarget(set, t, N.componentOf(set, t), t.node), /message[\s\S]*part `body`/);
});

test('corpus: hover text escapes Markdown in schema values', async () => {
  const set = await L.loadTexts({ 'm.xsd': L.schema('<xs:simpleType name="S"><xs:annotation><xs:documentation>[click](https://example.com) &lt;img src=x&gt; **bold**</xs:documentation></xs:annotation><xs:restriction base="xs:string"><xs:enumeration value="a`b"/></xs:restriction></xs:simpleType><xs:element name="e" type="t:S"/>') });
  const text = set.docs[0].text;
  const t = N.targetAt(set, 'file:///mem/m.xsd', text.indexOf('type="t:S"') + 7);
  const md = D.describeTarget(set, t, N.componentOf(set, t), t.node);
  assert.ok(!/\]\(https/.test(md), md);
  assert.ok(md.includes('\\<img'));
  assert.ok(md.includes('`` a`b ``'));
});

test('corpus: outline of every file has entries with ranges inside the file', async () => {
  for (const f of ALL) {
    const set = await L.loadFile(f);
    const roots = O.outlineOf(set, L.uriOf(f));
    assert.equal(roots.length, 1, path.basename(f));
    const text = fs.readFileSync(f, 'utf8');
    let n = 0;
    (function walk(list) {
      for (const x of list) {
        n++;
        if (!x.foreign) {
          assert.ok(x.start >= 0 && x.end <= text.length && x.start <= x.end, path.basename(f) + ' ' + x.label);
          assert.ok(x.selStart >= x.start && x.selEnd <= x.end, path.basename(f) + ' sel ' + x.label);
        }
        walk(x.children);
      }
    })(roots);
    assert.ok(n >= 3, path.basename(f));
  }
  const w = ALL.find((x) => x.includes('w05-headers'));
  const labels = O.outlineOf(await L.loadFile(w), L.uriOf(w))[0].children.map((c) => c.label);
  assert.deepEqual(labels, ['Types', 'Messages', 'Port types', 'Bindings', 'Services']);
});

test('corpus: paths at the cursor', async () => {
  const f = ALL.find((x) => x.includes('01-bakery'));
  const text = fs.readFileSync(f, 'utf8');
  const parsed = P.parseXml(text);
  assert.equal(N.pathAt(parsed, text.indexOf('name="unitPrice"')).text, '/bakeryOrder/lines/line/unitPrice');
  assert.equal(N.pathAt(parsed, text.indexOf('name="number"')).text, '/bakeryOrder/lines/line/@number');
  const v = ALL.find((x) => x.includes('03-ferry'));
  const vt = fs.readFileSync(v, 'utf8');
  assert.equal(N.pathAt(P.parseXml(vt), vt.indexOf('name="departure"')).text, 'RouteType: departure');
  const w = ALL.find((x) => x.includes('w01-weather'));
  const wt = fs.readFileSync(w, 'utf8');
  assert.equal(N.pathAt(P.parseXml(wt), wt.indexOf('soapAction')).text, 'binding WeatherSoapBinding / operation GetForecast');
  assert.equal(N.pathAt(P.parseXml(wt), wt.indexOf('name="highCelsius"')).text, '/GetForecastResponse/day/highCelsius');
});

test('corpus: a 20 MB synthetic schema loads, checks and outlines in reasonable time', async () => {
  const parts = ['<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:t="urn:big" targetNamespace="urn:big" elementFormDefault="qualified">'];
  let size = parts[0].length;
  let i = 0;
  while (size < 20 * 1024 * 1024) {
    const chunk = '<xs:complexType name="T' + i + '"><xs:annotation><xs:documentation>Record type number ' + i + ' of the synthetic test schema.</xs:documentation></xs:annotation><xs:sequence>' +
      '<xs:element name="code" type="t:Code"/><xs:element name="amount" type="xs:decimal" minOccurs="0"/><xs:element name="next" type="t:T' + (i + 1) + '" minOccurs="0"/>' +
      '</xs:sequence><xs:attribute name="id" type="xs:ID"/></xs:complexType>\n';
    parts.push(chunk);
    size += chunk.length;
    i++;
  }
  parts.push('<xs:complexType name="T' + i + '"/><xs:simpleType name="Code"><xs:restriction base="xs:token"><xs:maxLength value="12"/></xs:restriction></xs:simpleType><xs:element name="root" type="t:T0"/></xs:schema>');
  const text = parts.join('');
  const t0 = Date.now();
  const set = await S.loadSchemaSet({ uri: 'file:///mem/big.xsd', text: text }, {});
  const t1 = Date.now();
  const problems = L.checkFile(set, 'file:///mem/big.xsd');
  const t2 = Date.now();
  const outline = O.outlineOf(set, 'file:///mem/big.xsd');
  const t3 = Date.now();
  assert.deepEqual(problems, []);
  assert.ok(set.all('type').length > 50000);
  assert.ok(outline[0].children.length >= 2);
  assert.ok(t1 - t0 < 20000, 'load ' + (t1 - t0) + ' ms');
  assert.ok(t2 - t1 < 60000, 'check ' + (t2 - t1) + ' ms');
  assert.ok(t3 - t2 < 30000, 'outline ' + (t3 - t2) + ' ms');
  const sample = require('../src/sample/sample').buildSample(set, set.lookup('element', 'urn:big', 'root'), { mode: 'full', maxElements: 500 });
  assert.deepEqual(P.parseXml(sample.text).errors, []);
});
