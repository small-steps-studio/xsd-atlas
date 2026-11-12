'use strict';
// Problem checks: each broken schema reports exactly the expected codes; valid constructs report none.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./helpers/load');

const XS = 'xmlns:xs="http://www.w3.org/2001/XMLSchema"';
function sch(body, attrs) { return '<xs:schema ' + XS + ' xmlns:t="urn:t" targetNamespace="urn:t" elementFormDefault="qualified"' + (attrs ? ' ' + attrs : '') + '>' + body + '</xs:schema>'; }

async function codesOf(files, entry) {
  const set = await L.loadTexts(files, entry);
  return L.checkFile(set, 'file:///mem/' + (entry || Object.keys(files)[0])).filter((p) => p.severity !== 'info' || /PATTERN|CHAMELEON|ALL-OCCURS|UNREACHABLE/.test(p.code)).map((p) => p.code).sort();
}
async function only(body, attrs) { return codesOf({ 'main.xsd': sch(body, attrs) }); }

const CASES = [
  ['unresolved type', '<xs:element name="a" type="t:Missing"/>', ['XSD-UNRESOLVED-TYPE']],
  ['not a built-in type', '<xs:element name="a" type="xs:strin"/>', ['XSD-UNRESOLVED-TYPE']],
  ['unresolved element ref', '<xs:element name="a"><xs:complexType><xs:sequence><xs:element ref="t:b"/></xs:sequence></xs:complexType></xs:element>', ['XSD-UNRESOLVED-ELEMENT']],
  ['unresolved attribute ref', '<xs:complexType name="T"><xs:attribute ref="t:x"/></xs:complexType>', ['XSD-UNRESOLVED-ATTRIBUTE']],
  ['unresolved group', '<xs:complexType name="T"><xs:group ref="t:G"/></xs:complexType>', ['XSD-UNRESOLVED-GROUP']],
  ['unresolved attribute group', '<xs:complexType name="T"><xs:attributeGroup ref="t:G"/></xs:complexType>', ['XSD-UNRESOLVED-ATTRIBUTE-GROUP']],
  ['unresolved keyref', '<xs:element name="a"><xs:complexType/><xs:keyref name="R" refer="t:K"><xs:selector xpath="."/><xs:field xpath="@x"/></xs:keyref></xs:element>', ['XSD-UNRESOLVED-IDENTITY']],
  ['unresolved union member', '<xs:simpleType name="U"><xs:union memberTypes="xs:int t:Nope"/></xs:simpleType>', ['XSD-UNRESOLVED-TYPE']],
  ['undeclared prefix', '<xs:element name="a" type="q:T"/>', ['XSD-UNDECLARED-PREFIX']],
  ['namespace not imported', '<xs:element name="a" type="o:T" xmlns:o="urn:other"/>', ['XSD-NAMESPACE-NOT-IMPORTED']],
  ['duplicate global names', '<xs:element name="a" type="xs:string"/><xs:element name="a" type="xs:int"/>', ['XSD-DUPLICATE-NAME']],
  ['type and element may share a name', '<xs:element name="a" type="t:a"/><xs:simpleType name="a"><xs:restriction base="xs:string"/></xs:simpleType>', []],
  ['duplicate attribute', '<xs:complexType name="T"><xs:attribute name="x" type="xs:string"/><xs:attribute name="x" type="xs:int"/></xs:complexType>', ['XSD-DUPLICATE-ATTRIBUTE']],
  ['duplicate attribute through a group', '<xs:attributeGroup name="G"><xs:attribute name="x"/></xs:attributeGroup><xs:complexType name="T"><xs:attribute name="x"/><xs:attributeGroup ref="t:G"/></xs:complexType>', ['XSD-DUPLICATE-ATTRIBUTE']],
  ['circular derivation', '<xs:complexType name="A"><xs:complexContent><xs:extension base="t:B"/></xs:complexContent></xs:complexType><xs:complexType name="B"><xs:complexContent><xs:extension base="t:A"/></xs:complexContent></xs:complexType>', ['XSD-CIRCULAR-DERIVATION']],
  ['simple type deriving from itself', '<xs:simpleType name="S"><xs:restriction base="t:S"/></xs:simpleType>', ['XSD-CIRCULAR-DERIVATION']],
  ['circular group', '<xs:group name="G"><xs:sequence><xs:group ref="t:H"/></xs:sequence></xs:group><xs:group name="H"><xs:sequence><xs:group ref="t:G"/></xs:sequence></xs:group><xs:complexType name="T"><xs:group ref="t:G"/></xs:complexType>', ['XSD-CIRCULAR-GROUP']],
  ['circular attribute group', '<xs:attributeGroup name="G"><xs:attributeGroup ref="t:G"/></xs:attributeGroup><xs:complexType name="T"><xs:attributeGroup ref="t:G"/></xs:complexType>', ['XSD-CIRCULAR-ATTRIBUTE-GROUP']],
  ['circular substitution group', '<xs:element name="a" substitutionGroup="t:b"/><xs:element name="b" substitutionGroup="t:a"/>', ['XSD-CIRCULAR-SUBSTITUTION', 'XSD-CIRCULAR-SUBSTITUTION']],
  ['complex content from a simple type', '<xs:complexType name="T"><xs:complexContent><xs:extension base="xs:string"/></xs:complexContent></xs:complexType>', ['XSD-INVALID-DERIVATION']],
  ['facet not applicable', '<xs:simpleType name="S"><xs:restriction base="xs:int"><xs:maxLength value="3"/></xs:restriction></xs:simpleType>', ['XSD-INVALID-FACET']],
  ['minLength above maxLength', '<xs:simpleType name="S"><xs:restriction base="xs:string"><xs:minLength value="5"/><xs:maxLength value="3"/></xs:restriction></xs:simpleType>', ['XSD-INVALID-FACET']],
  ['bad facet value', '<xs:simpleType name="S"><xs:restriction base="xs:string"><xs:maxLength value="ten"/></xs:restriction></xs:simpleType>', ['XSD-INVALID-FACET']],
  ['totalDigits zero', '<xs:simpleType name="S"><xs:restriction base="xs:decimal"><xs:totalDigits value="0"/></xs:restriction></xs:simpleType>', ['XSD-INVALID-FACET']],
  ['fractionDigits above totalDigits', '<xs:simpleType name="S"><xs:restriction base="xs:decimal"><xs:totalDigits value="2"/><xs:fractionDigits value="3"/></xs:restriction></xs:simpleType>', ['XSD-INVALID-FACET']],
  ['lower bound above upper bound', '<xs:simpleType name="S"><xs:restriction base="xs:int"><xs:minInclusive value="10"/><xs:maxInclusive value="5"/></xs:restriction></xs:simpleType>', ['XSD-INVALID-FACET']],
  ['equal exclusive bounds', '<xs:simpleType name="S"><xs:restriction base="xs:int"><xs:minExclusive value="5"/><xs:maxExclusive value="5"/></xs:restriction></xs:simpleType>', ['XSD-INVALID-FACET']],
  ['bound of the wrong form', '<xs:simpleType name="S"><xs:restriction base="xs:date"><xs:minInclusive value="yesterday"/></xs:restriction></xs:simpleType>', ['XSD-INVALID-FACET']],
  ['loosened maxLength', '<xs:simpleType name="A"><xs:restriction base="xs:string"><xs:maxLength value="5"/></xs:restriction></xs:simpleType><xs:simpleType name="B"><xs:restriction base="t:A"><xs:maxLength value="9"/></xs:restriction></xs:simpleType>', ['XSD-INVALID-FACET']],
  ['weakened whiteSpace', '<xs:simpleType name="S"><xs:restriction base="xs:token"><xs:whiteSpace value="preserve"/></xs:restriction></xs:simpleType>', ['XSD-INVALID-FACET']],
  ['invalid pattern', '<xs:simpleType name="S"><xs:restriction base="xs:string"><xs:pattern value="[a-"/></xs:restriction></xs:simpleType>', ['XSD-INVALID-FACET']],
  ['pattern with an unknown block', '<xs:simpleType name="S"><xs:restriction base="xs:string"><xs:pattern value="\\p{IsRunicLetters}+"/></xs:restriction></xs:simpleType>', ['XSD-PATTERN-NOT-CHECKED']],
  ['enumeration value the base rejects', '<xs:simpleType name="S"><xs:restriction base="xs:int"><xs:enumeration value="1"/><xs:enumeration value="two"/></xs:restriction></xs:simpleType>', ['XSD-INVALID-FACET']],
  ['enumeration outside a base bound', '<xs:simpleType name="A"><xs:restriction base="xs:int"><xs:maxInclusive value="5"/></xs:restriction></xs:simpleType><xs:simpleType name="B"><xs:restriction base="t:A"><xs:enumeration value="9"/></xs:restriction></xs:simpleType>', ['XSD-INVALID-FACET']],
  ['invalid default', '<xs:element name="a" type="xs:int" default="many"/>', ['XSD-INVALID-DEFAULT']],
  ['invalid fixed by facet', '<xs:element name="a" fixed="toolong"><xs:simpleType><xs:restriction base="xs:string"><xs:maxLength value="3"/></xs:restriction></xs:simpleType></xs:element>', ['XSD-INVALID-DEFAULT']],
  ['default on element-only content', '<xs:element name="a" default="x"><xs:complexType><xs:sequence><xs:element name="b"/></xs:sequence></xs:complexType></xs:element>', ['XSD-INVALID-DEFAULT']],
  ['invalid attribute default', '<xs:complexType name="T"><xs:attribute name="x" type="xs:boolean" default="maybe"/></xs:complexType>', ['XSD-INVALID-DEFAULT']],
  ['default and fixed together', '<xs:element name="a" type="xs:string" default="x" fixed="x"/>', ['XSD-DEFAULT-AND-FIXED']],
  ['required attribute with a default', '<xs:complexType name="T"><xs:attribute name="x" type="xs:string" use="required" default="a"/></xs:complexType>', ['XSD-NOT-ALLOWED-HERE']],
  ['minOccurs above maxOccurs', '<xs:complexType name="T"><xs:sequence><xs:element name="a" minOccurs="3" maxOccurs="2"/></xs:sequence></xs:complexType>', ['XSD-INVALID-OCCURS']],
  ['occurs not a number', '<xs:complexType name="T"><xs:sequence><xs:element name="a" maxOccurs="many"/></xs:sequence></xs:complexType>', ['XSD-INVALID-OCCURS']],
  ['all with maxOccurs above 1', '<xs:complexType name="T"><xs:all><xs:element name="a" maxOccurs="2"/></xs:all></xs:complexType>', ['XSD-ALL-OCCURS']],
  ['invalid name', '<xs:element name="1a" type="xs:string"/>', ['XSD-INVALID-NAME']],
  ['top-level element without name', '<xs:element type="xs:string"/>', ['XSD-MISSING-NAME']],
  ['local element without name or ref', '<xs:complexType name="T"><xs:sequence><xs:element type="xs:string"/></xs:sequence></xs:complexType>', ['XSD-MISSING-NAME']],
  ['name and ref together', '<xs:element name="b"/><xs:complexType name="T"><xs:sequence><xs:element name="a" ref="t:b"/></xs:sequence></xs:complexType>', ['XSD-REF-AND-NAME']],
  ['minOccurs on a top-level element', '<xs:element name="a" minOccurs="0"/>', ['XSD-NOT-ALLOWED-HERE']],
  ['named nested type', '<xs:element name="a"><xs:complexType name="X"/></xs:element>', ['XSD-NOT-ALLOWED-HERE']],
  ['type next to ref', '<xs:element name="b"/><xs:complexType name="T"><xs:sequence><xs:element ref="t:b" type="xs:int"/></xs:sequence></xs:complexType>', ['XSD-NOT-ALLOWED-HERE']],
  ['misspelt schema element', '<xs:elemnt name="a"/>', ['XSD-UNKNOWN-ELEMENT']],
  ['inconsistent element types', '<xs:complexType name="T"><xs:sequence><xs:element name="a" type="xs:int"/><xs:element name="a" type="xs:string"/></xs:sequence></xs:complexType>', ['XSD-INCONSISTENT-ELEMENT']],
  ['import of the own namespace', '<xs:import namespace="urn:t"/>', ['XSD-TARGET-NAMESPACE']],
  ['include without schemaLocation', '<xs:include/>', ['XSD-MISSING-SCHEMA-LOCATION']],
  ['missing included file', '<xs:include schemaLocation="nope.xsd"/>', ['XSD-MISSING-FILE']],
  ['remote import', '<xs:import namespace="urn:remote" schemaLocation="https://example.com/r.xsd"/><xs:element name="a" type="r:T" xmlns:r="urn:remote"/>', ['XSD-UNREACHABLE-IMPORT']],
  ['import without location of an unknown namespace', '<xs:import namespace="urn:x"/>', ['XSD-UNREACHABLE-IMPORT']],
  ['xml:lang works without loading the XML namespace schema', '<xs:import namespace="http://www.w3.org/XML/1998/namespace"/><xs:complexType name="T"><xs:attribute ref="xml:lang"/></xs:complexType>', []],
  ['valid built-ins and lists of member types', '<xs:simpleType name="U"><xs:union memberTypes="xs:int   xs:date"/></xs:simpleType><xs:simpleType name="L"><xs:list itemType="xs:NMTOKEN"/></xs:simpleType>', []]
];

for (const [name, body, expected, attrs] of CASES) {
  test('check: ' + name, async () => {
    const got = await only(body, attrs);
    assert.deepEqual(got, expected.slice().sort());
  });
}

test('check: a WSDL-embedded schema gets a warning, not an error, for a missing import', async () => {
  const wsdl = '<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" ' + XS + ' xmlns:a="urn:a" xmlns:b="urn:b" targetNamespace="urn:w"><wsdl:types>' +
    '<xs:schema targetNamespace="urn:a"><xs:simpleType name="S"><xs:restriction base="xs:string"/></xs:simpleType></xs:schema>' +
    '<xs:schema targetNamespace="urn:b"><xs:element name="e" type="a:S"/></xs:schema></wsdl:types></wsdl:definitions>';
  const set = await L.loadTexts({ 'w.wsdl': wsdl });
  const p = L.checkFile(set, 'file:///mem/w.wsdl');
  assert.deepEqual(p.map((x) => x.code + ':' + x.severity), ['XSD-NAMESPACE-NOT-IMPORTED:warning']);
});

test('check: empty targetNamespace', async () => {
  const text = '<xs:schema ' + XS + ' targetNamespace=""><xs:element name="a"/></xs:schema>';
  assert.deepEqual(await codesOf({ 'main.xsd': text }), ['XSD-TARGET-NAMESPACE']);
});

test('check: include and import namespace mismatches across files', async () => {
  const other = '<xs:schema ' + XS + ' targetNamespace="urn:other"><xs:element name="x"/></xs:schema>';
  assert.deepEqual(await codesOf({ 'main.xsd': sch('<xs:include schemaLocation="o.xsd"/>'), 'o.xsd': other }), ['XSD-TARGET-NAMESPACE']);
  assert.deepEqual(await codesOf({ 'main.xsd': sch('<xs:import namespace="urn:third" schemaLocation="o.xsd"/>'), 'o.xsd': other }), ['XSD-TARGET-NAMESPACE']);
  assert.deepEqual(await codesOf({ 'main.xsd': sch('<xs:include schemaLocation="o.txt"/>'), 'o.txt': '<notes/>' }), ['XSD-NOT-A-SCHEMA']);
  const cham = '<xs:schema ' + XS + '><xs:simpleType name="C"><xs:restriction base="xs:string"/></xs:simpleType></xs:schema>';
  assert.deepEqual(await codesOf({ 'main.xsd': sch('<xs:include schemaLocation="c.xsd"/><xs:element name="e" type="t:C"/>'), 'c.xsd': cham }), ['XSD-CHAMELEON-INCLUDE']);
});

test('check: duplicates across included files point at the second declaration', async () => {
  const part = '<xs:schema ' + XS + ' targetNamespace="urn:t"><xs:element name="a"/></xs:schema>';
  const set = await L.loadTexts({ 'main.xsd': sch('<xs:include schemaLocation="p.xsd"/><xs:element name="a"/>'), 'p.xsd': part });
  const all = L.checkFile(set, 'file:///mem/main.xsd').concat(L.checkFile(set, 'file:///mem/p.xsd'));
  assert.equal(all.filter((p) => p.code === 'XSD-DUPLICATE-NAME').length, 1);
});

test('check: well-formedness problems come first and the schema checks still run', async () => {
  const set = await L.loadTexts({ 'main.xsd': sch('<xs:element name="a" type="t:Nope"/><xs:element name="b">') });
  const codes = L.checkFile(set, 'file:///mem/main.xsd').map((p) => p.code);
  assert.ok(codes.includes('XML-UNCLOSED-ELEMENT') || codes.includes('XML-MISMATCHED-END-TAG'));
  assert.ok(codes.includes('XSD-UNRESOLVED-TYPE'));
});

test('check: problem ranges lie inside the file', async () => {
  for (const [, body, , attrs] of CASES) {
    const text = sch(body, attrs);
    const set = await L.loadTexts({ 'main.xsd': text });
    for (const p of L.checkFile(set, 'file:///mem/main.xsd')) {
      assert.ok(p.start >= 0 && p.end <= text.length && p.end > p.start, p.code + ' ' + p.start + '-' + p.end);
      assert.ok(p.message.length > 10);
    }
  }
});

test('check: WSDL problems', async () => {
  const head = '<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" ' + XS + ' xmlns:tns="urn:w" targetNamespace="urn:w">' +
    '<wsdl:types><xs:schema targetNamespace="urn:w"><xs:element name="E" type="xs:string"/></xs:schema></wsdl:types>';
  const tail = '</wsdl:definitions>';
  const cases = [
    ['<wsdl:portType name="P"><wsdl:operation name="o"><wsdl:input message="tns:Missing"/></wsdl:operation></wsdl:portType>', ['WSDL-UNRESOLVED-MESSAGE']],
    ['<wsdl:message name="M"><wsdl:part name="p" element="tns:Nope"/></wsdl:message>', ['WSDL-UNRESOLVED-ELEMENT']],
    ['<wsdl:message name="M"><wsdl:part name="p" type="tns:Nope"/></wsdl:message>', ['WSDL-UNRESOLVED-TYPE']],
    ['<wsdl:message name="M"><wsdl:part name="p" element="tns:E" type="xs:string"/></wsdl:message>', ['WSDL-PART-ELEMENT-AND-TYPE']],
    ['<wsdl:message name="M"/><wsdl:message name="M"/>', ['WSDL-DUPLICATE-NAME']],
    ['<wsdl:binding name="B" type="tns:Nope"/>', ['WSDL-UNRESOLVED-PORT-TYPE']],
    ['<wsdl:service name="S"><wsdl:port name="p" binding="tns:Nope"><soap:address location="https://example.com/x"/></wsdl:port></wsdl:service>', ['WSDL-UNRESOLVED-BINDING']],
    ['<wsdl:portType name="P"/><wsdl:binding name="B" type="tns:P"/><wsdl:service name="S"><wsdl:port name="p" binding="tns:B"/></wsdl:service>', ['WSDL-NO-ADDRESS']],
    ['<wsdl:portType name="P"><wsdl:operation name="a"/></wsdl:portType><wsdl:binding name="B" type="tns:P"><soap:binding style="document"/><wsdl:operation name="b"/></wsdl:binding>', ['WSDL-BINDING-OPERATION-MISSING', 'WSDL-OPERATION-NOT-BOUND']],
    ['<wsdl:message name="M"><wsdl:part name="p" type="xs:string"/></wsdl:message><wsdl:portType name="P"><wsdl:operation name="a"><wsdl:input message="tns:M"/></wsdl:operation></wsdl:portType><wsdl:binding name="B" type="tns:P"><soap:binding style="document"/><wsdl:operation name="a"><wsdl:input><soap:body use="literal" parts="q"/></wsdl:input></wsdl:operation></wsdl:binding>', ['WSDL-UNKNOWN-PART']],
    ['<wsdl:message name="M"><wsdl:part name="p" type="xs:string"/></wsdl:message><wsdl:portType name="P"><wsdl:operation name="a"><wsdl:input message="tns:M"/></wsdl:operation></wsdl:portType><wsdl:binding name="B" type="tns:P"><soap:binding style="document"/><wsdl:operation name="a"><wsdl:input><soap:body use="literal"/></wsdl:input></wsdl:operation></wsdl:binding>', ['WSDL-STYLE-MISMATCH']],
    ['<wsdl:import namespace="urn:x" location="nope.wsdl"/>', ['WSDL-MISSING-FILE']],
    ['<wsdl:portType name="P"><wsdl:operation name="o"><wsdl:input message="zz:M"/></wsdl:operation></wsdl:portType>', ['WSDL-UNDECLARED-PREFIX']]
  ];
  for (const [body, expected] of cases) {
    const set = await L.loadTexts({ 'w.wsdl': head + body + tail });
    const got = L.checkFile(set, 'file:///mem/w.wsdl').filter((p) => p.code.startsWith('WSDL')).map((p) => p.code).sort();
    assert.deepEqual(got, expected.slice().sort(), body);
  }
  const w2 = '<description xmlns="http://www.w3.org/ns/wsdl" xmlns:tns="urn:w" targetNamespace="urn:w"><interface name="I"><operation name="o"><outfault ref="tns:F"/></operation></interface>' +
    '<binding name="B" interface="tns:Nope" type="http://www.w3.org/ns/wsdl/soap"/></description>';
  const set2 = await L.loadTexts({ 'w.wsdl': w2 });
  assert.deepEqual(L.checkFile(set2, 'file:///mem/w.wsdl').map((p) => p.code).sort(), ['WSDL-UNRESOLVED-FAULT', 'WSDL-UNRESOLVED-INTERFACE']);
});

test('check: a pattern with nested repetition is not run against values (no catastrophic backtracking)', async () => {
  const body = '<xs:element name="e" default="' + 'a'.repeat(40) + 'c"><xs:simpleType><xs:restriction base="xs:string"><xs:pattern value="(a+)+b"/></xs:restriction></xs:simpleType></xs:element>';
  const t0 = Date.now();
  const set = await L.loadTexts({ 'main.xsd': sch(body) });
  const codes = L.checkFile(set, 'file:///mem/main.xsd').map((p) => p.code);
  assert.deepEqual(codes, ['XSD-PATTERN-NOT-CHECKED']);
  const s = require('../src/sample/sample').buildSample(set, set.lookup('element', 'urn:t', 'e'), { mode: 'full' });
  assert.ok(Date.now() - t0 < 3000);
  assert.ok(s.text.length > 0);
  const R = require('../src/schema/xsdregex');
  assert.equal(R.compile('(a+)+b').risky, true);
  assert.equal(R.compile('(\\d{1,3}\\.){3}\\d{1,3}').risky, true);
  assert.equal(R.compile('[A-Z]{2}[0-9]+(\\.[0-9]{2})?').risky, false);
  assert.equal(R.safeTest(R.compile('a+'), 'a'.repeat(R.MAX_TEST_LENGTH + 1)), null);
});