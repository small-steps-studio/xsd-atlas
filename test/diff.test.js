'use strict';
// Schema diff: hand-classified change cases. Each case gives an old and a new schema and the
// exact list of change codes expected (with their class taken from the rule table, which is
// checked against the documentation separately).
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./helpers/load');
const { diffSets, RULES } = require('../src/pro/diff');

const XS = 'xmlns:xs="http://www.w3.org/2001/XMLSchema"';
function sch(body, attrs, tns) {
  const ns = tns || 'urn:t';
  return '<xs:schema ' + XS + ' xmlns:t="' + ns + '" targetNamespace="' + ns + '" elementFormDefault="qualified"' + (attrs ? ' ' + attrs : '') + '>' + body + '</xs:schema>';
}
// A complex type T used by the global element root.
function T(content, attrs) { return '<xs:element name="root" type="t:T"/><xs:complexType name="T"' + (attrs || '') + '>' + content + '</xs:complexType>'; }
function seq(...els) { return '<xs:sequence>' + els.join('') + '</xs:sequence>'; }
function el(name, extra) { return '<xs:element name="' + name + '" type="xs:string"' + (extra ? ' ' + extra : '') + '/>'; }
function st(name, restriction, base) { return '<xs:simpleType name="' + name + '"><xs:restriction base="' + (base || 'xs:string') + '">' + restriction + '</xs:restriction></xs:simpleType>'; }
function facet(n, v) { return '<xs:' + n + ' value="' + v + '"/>'; }
function enums(...v) { return v.map(function (x) { return facet('enumeration', x); }).join(''); }
function E(name, inner) { return '<xs:element name="' + name + '">' + inner + '</xs:element>'; }

async function diff(oldText, newText, extraOld, extraNew) {
  const a = await L.loadTexts(Object.assign({ 'main.xsd': oldText }, extraOld || {}), 'main.xsd');
  const b = await L.loadTexts(Object.assign({ 'main.xsd': newText }, extraNew || {}), 'main.xsd');
  return diffSets(a, b);
}

const CASES = [
  ['identical schemas', T(seq(el('a'), el('b'))), T(seq(el('a'), el('b'))), []],
  ['element removed', T(seq(el('a'), el('b'))), T(seq(el('a'))), ['child-removed']],
  ['optional element removed', T(seq(el('a'), el('b', 'minOccurs="0"'))), T(seq(el('a'))), ['child-removed']],
  ['required element added', T(seq(el('a'))), T(seq(el('a'), el('b'))), ['child-added-required']],
  ['optional element added', T(seq(el('a'))), T(seq(el('a'), el('b', 'minOccurs="0"'))), ['child-added-optional']],
  ['optional to required', T(seq(el('a', 'minOccurs="0"'))), T(seq(el('a'))), ['became-required']],
  ['required to optional', T(seq(el('a'))), T(seq(el('a', 'minOccurs="0"'))), ['became-optional']],
  ['minOccurs increased', T(seq(el('a', 'maxOccurs="5"'))), T(seq(el('a', 'minOccurs="2" maxOccurs="5"'))), ['occurrence-min-increased']],
  ['minOccurs decreased', T(seq(el('a', 'minOccurs="2" maxOccurs="5"'))), T(seq(el('a', 'maxOccurs="5"'))), ['occurrence-min-decreased']],
  ['maxOccurs decreased', T(seq(el('a', 'maxOccurs="5"'))), T(seq(el('a', 'maxOccurs="3"'))), ['occurrence-max-decreased']],
  ['maxOccurs to unbounded', T(seq(el('a', 'maxOccurs="3"'))), T(seq(el('a', 'maxOccurs="unbounded"'))), ['occurrence-max-increased']],
  ['repeated sequence bound', T('<xs:sequence maxOccurs="4">' + el('a') + '</xs:sequence>'), T('<xs:sequence maxOccurs="2">' + el('a') + '</xs:sequence>'), ['occurrence-max-decreased']],
  ['order swapped', T(seq(el('a'), el('b'))), T(seq(el('b'), el('a'))), ['order-changed']],
  ['one element moved to the end', T(seq(el('a'), el('b'), el('c'), el('d'))), T(seq(el('b'), el('c'), el('d'), el('a'))), ['order-changed']],
  ['sequence to choice', T(seq(el('a'), el('b'))), T('<xs:choice>' + el('a') + el('b') + '</xs:choice>'), ['compositor-changed', 'moved-into-choice', 'moved-into-choice', 'became-optional', 'became-optional']],
  ['sequence to all', T(seq(el('a'), el('b'))), T('<xs:all>' + el('a') + el('b') + '</xs:all>'), ['compositor-relaxed']],
  ['all to sequence', T('<xs:all>' + el('a') + el('b') + '</xs:all>'), T(seq(el('a'), el('b'))), ['compositor-changed']],
  // Every document of the old version stays valid in the next two (libxml2 agrees, see
  // diff.exact.test.js), so neither the compositor change nor the move into a choice is BREAKING.
  ['choice to sequence', T('<xs:choice>' + el('a') + el('b') + '</xs:choice>'), T(seq(el('a', 'minOccurs="0"'), el('b', 'minOccurs="0"'))), ['moved-out-of-choice', 'moved-out-of-choice']],
  ['element moved into a nested choice', T(seq(el('a'), el('b'))), T(seq(el('a'), '<xs:choice>' + el('b') + el('c') + '</xs:choice>')), ['became-optional', 'child-added-optional']],
  ['single child compositor change', T(seq(el('a'))), T('<xs:choice>' + el('a') + '</xs:choice>'), []],
  ['type string to int', T(seq(el('a'))), T(seq('<xs:element name="a" type="xs:int"/>')), ['type-changed']],
  ['type int to long', T(seq('<xs:element name="a" type="xs:int"/>')), T(seq('<xs:element name="a" type="xs:long"/>')), ['type-widened']],
  ['type token to string', T(seq('<xs:element name="a" type="xs:token"/>')), T(seq('<xs:element name="a" type="xs:string"/>')), ['type-widened']],
  ['type long to int', T(seq('<xs:element name="a" type="xs:long"/>')), T(seq('<xs:element name="a" type="xs:int"/>')), ['type-changed']],
  ['named type replaced', T(seq('<xs:element name="a" type="t:A"/>')) + st('A', '') + st('B', ''), T(seq('<xs:element name="a" type="t:B"/>')) + st('A', '') + st('B', ''), ['type-changed']],
  ['named type inlined, same content', T(seq('<xs:element name="a" type="t:A"/>')) + st('A', facet('maxLength', '5')), T(seq(E('a', '<xs:simpleType><xs:restriction base="xs:string">' + facet('maxLength', '5') + '</xs:restriction></xs:simpleType>'))) + st('A', facet('maxLength', '5')), ['type-inlined']],
  ['inline type named', T(seq(E('a', '<xs:simpleType><xs:restriction base="xs:string"/></xs:simpleType>'))) + st('A', ''), T(seq('<xs:element name="a" type="t:A"/>')) + st('A', ''), ['type-named']],
  ['nillable added', T(seq(el('a'))), T(seq(el('a', 'nillable="true"'))), ['nillable-added']],
  ['nillable removed', T(seq(el('a', 'nillable="true"'))), T(seq(el('a'))), ['nillable-removed']],
  ['element default added', T(seq(el('a'))), T(seq(el('a', 'default="x"'))), ['default-added']],
  ['element default changed', T(seq(el('a', 'default="x"'))), T(seq(el('a', 'default="y"'))), ['default-changed']],
  ['element default removed', T(seq(el('a', 'default="x"'))), T(seq(el('a'))), ['default-removed']],
  ['element fixed added', T(seq(el('a'))), T(seq(el('a', 'fixed="x"'))), ['fixed-added']],
  ['element fixed removed', T(seq(el('a', 'fixed="x"'))), T(seq(el('a'))), ['fixed-removed']],
  ['element fixed changed', T(seq(el('a', 'fixed="x"'))), T(seq(el('a', 'fixed="y"'))), ['fixed-changed']],
  ['attribute removed', T(seq(el('a')) + '<xs:attribute name="k" type="xs:string"/>'), T(seq(el('a'))), ['attribute-removed']],
  ['required attribute added', T(seq(el('a'))), T(seq(el('a')) + '<xs:attribute name="k" type="xs:string" use="required"/>'), ['attribute-added-required']],
  ['optional attribute added', T(seq(el('a'))), T(seq(el('a')) + '<xs:attribute name="k" type="xs:string"/>'), ['attribute-added-optional']],
  ['attribute became required', T('<xs:attribute name="k" type="xs:string"/>'), T('<xs:attribute name="k" type="xs:string" use="required"/>'), ['attribute-became-required']],
  ['attribute became optional', T('<xs:attribute name="k" type="xs:string" use="required"/>'), T('<xs:attribute name="k" type="xs:string"/>'), ['attribute-became-optional']],
  ['attribute type changed', T('<xs:attribute name="k" type="xs:string"/>'), T('<xs:attribute name="k" type="xs:int"/>'), ['type-changed']],
  ['attribute type widened', T('<xs:attribute name="k" type="xs:short"/>'), T('<xs:attribute name="k" type="xs:int"/>'), ['type-widened']],
  ['attribute default changed', T('<xs:attribute name="k" type="xs:string" default="a"/>'), T('<xs:attribute name="k" type="xs:string" default="b"/>'), ['default-changed']],
  ['attribute fixed added', T('<xs:attribute name="k" type="xs:string"/>'), T('<xs:attribute name="k" type="xs:string" fixed="1"/>'), ['fixed-added']],
  ['enumeration value removed', st('S', enums('a', 'b', 'c')), st('S', enums('a', 'b')), ['enumeration-removed']],
  ['enumeration value added', st('S', enums('a', 'b')), st('S', enums('a', 'b', 'c')), ['enumeration-added']],
  ['enumeration values swapped', st('S', enums('a', 'b')), st('S', enums('a', 'c')), ['enumeration-removed', 'enumeration-added']],
  ['enumeration dropped', st('S', enums('a', 'b')), st('S', ''), ['enumeration-dropped']],
  ['enumeration introduced', st('S', ''), st('S', enums('a')), ['facet-added']],
  ['maxLength narrowed', st('S', facet('maxLength', '10')), st('S', facet('maxLength', '5')), ['facet-narrowed']],
  ['maxLength widened', st('S', facet('maxLength', '5')), st('S', facet('maxLength', '10')), ['facet-widened']],
  ['maxLength added', st('S', ''), st('S', facet('maxLength', '10')), ['facet-added']],
  ['maxLength removed', st('S', facet('maxLength', '10')), st('S', ''), ['facet-removed']],
  ['minLength narrowed', st('S', facet('minLength', '1')), st('S', facet('minLength', '3')), ['facet-narrowed']],
  ['minLength widened', st('S', facet('minLength', '3')), st('S', facet('minLength', '1')), ['facet-widened']],
  ['minLength 0 added', st('S', ''), st('S', facet('minLength', '0')), []],
  ['length changed', st('S', facet('length', '5')), st('S', facet('length', '6')), ['facet-changed']],
  ['pattern added', st('S', ''), st('S', facet('pattern', '[A-Z]+')), ['facet-added']],
  ['pattern changed', st('S', facet('pattern', '[A-Z]+')), st('S', facet('pattern', '[A-Z]{2}')), ['pattern-changed']],
  ['pattern removed', st('S', facet('pattern', '[A-Z]+')), st('S', ''), ['facet-removed']],
  ['one of two patterns removed', st('S', facet('pattern', '[A-Z]+') + facet('pattern', '[0-9]+')), st('S', facet('pattern', '[A-Z]+')), ['facet-removed']],
  ['minInclusive narrowed', st('N', facet('minInclusive', '0'), 'xs:int'), st('N', facet('minInclusive', '1'), 'xs:int'), ['facet-narrowed']],
  ['maxInclusive narrowed', st('N', facet('maxInclusive', '100'), 'xs:int'), st('N', facet('maxInclusive', '50'), 'xs:int'), ['facet-narrowed']],
  ['maxInclusive widened', st('N', facet('maxInclusive', '50'), 'xs:int'), st('N', facet('maxInclusive', '100'), 'xs:int'), ['facet-widened']],
  ['inclusive to exclusive bound', st('N', facet('minInclusive', '0'), 'xs:decimal'), st('N', facet('minExclusive', '0'), 'xs:decimal'), ['facet-narrowed']],
  ['exclusive to inclusive bound', st('N', facet('maxExclusive', '10'), 'xs:decimal'), st('N', facet('maxInclusive', '10'), 'xs:decimal'), ['facet-widened']],
  ['lower bound added', st('N', '', 'xs:int'), st('N', facet('minInclusive', '0'), 'xs:int'), ['facet-added']],
  ['upper bound removed', st('N', facet('maxInclusive', '9'), 'xs:int'), st('N', '', 'xs:int'), ['facet-removed']],
  ['decimal bound compared exactly', st('N', facet('maxInclusive', '10.50'), 'xs:decimal'), st('N', facet('maxInclusive', '10.5'), 'xs:decimal'), []],
  ['date bound narrowed', st('D', facet('maxInclusive', '2030-01-01'), 'xs:date'), st('D', facet('maxInclusive', '2029-01-01'), 'xs:date'), ['facet-narrowed']],
  ['totalDigits narrowed', st('N', facet('totalDigits', '10'), 'xs:decimal'), st('N', facet('totalDigits', '8'), 'xs:decimal'), ['facet-narrowed']],
  ['fractionDigits widened', st('N', facet('fractionDigits', '2'), 'xs:decimal'), st('N', facet('fractionDigits', '4'), 'xs:decimal'), ['facet-widened']],
  ['whiteSpace changed', st('S', facet('whiteSpace', 'preserve')), st('S', facet('whiteSpace', 'collapse')), ['facet-changed']],
  ['simple base string to int', st('S', ''), st('S', '', 'xs:int'), ['base-type-changed']],
  ['simple base int to long', st('S', '', 'xs:int'), st('S', '', 'xs:long'), ['base-widened']],
  ['atomic to list', st('S', ''), '<xs:simpleType name="S"><xs:list itemType="xs:string"/></xs:simpleType>', ['variety-changed']],
  ['union member removed', '<xs:simpleType name="U"><xs:union memberTypes="xs:int xs:boolean"/></xs:simpleType>', '<xs:simpleType name="U"><xs:union memberTypes="xs:int"/></xs:simpleType>', ['union-member-removed']],
  ['union member added', '<xs:simpleType name="U"><xs:union memberTypes="xs:int"/></xs:simpleType>', '<xs:simpleType name="U"><xs:union memberTypes="xs:int xs:boolean"/></xs:simpleType>', ['union-member-added']],
  ['union members reordered', '<xs:simpleType name="U"><xs:union memberTypes="xs:int xs:boolean"/></xs:simpleType>', '<xs:simpleType name="U"><xs:union memberTypes="xs:boolean xs:int"/></xs:simpleType>', ['union-order-changed']],
  ['list item type changed', '<xs:simpleType name="L"><xs:list itemType="xs:int"/></xs:simpleType>', '<xs:simpleType name="L"><xs:list itemType="xs:date"/></xs:simpleType>', ['list-item-changed']],
  ['global element removed', el('a') + el('b'), el('a'), ['component-removed']],
  ['global element added', el('a'), el('a') + el('b'), ['component-added']],
  ['global type removed', st('A', '') + st('B', ''), st('A', ''), ['component-removed']],
  ['global type added', st('A', ''), st('A', '') + st('B', ''), ['component-added']],
  ['global attribute group removed', '<xs:attributeGroup name="G"><xs:attribute name="x" type="xs:string"/></xs:attributeGroup>', '', ['component-removed']],
  ['global element became abstract', el('a'), el('a', 'abstract="true"'), ['abstract-added']],
  ['type became abstract', T(seq(el('a'))), T(seq(el('a')), ' abstract="true"'), ['abstract-added']],
  ['mixed added', T(seq(el('a'))), T(seq(el('a')), ' mixed="true"'), ['mixed-added']],
  ['mixed removed', T(seq(el('a')), ' mixed="true"'), T(seq(el('a'))), ['mixed-removed']],
  ['simple content became element content', T('<xs:simpleContent><xs:extension base="xs:string"/></xs:simpleContent>'), T(seq(el('a'))), ['content-type-changed']],
  ['empty to required content', T('<xs:attribute name="k" type="xs:string"/>'), T(seq(el('a')) + '<xs:attribute name="k" type="xs:string"/>'), ['content-type-changed']],
  ['empty to optional content', T('<xs:attribute name="k" type="xs:string"/>'), T(seq(el('a', 'minOccurs="0"')) + '<xs:attribute name="k" type="xs:string"/>'), ['child-added-optional']],
  ['substitution group added', el('head') + el('m'), el('head') + el('m', 'substitutionGroup="t:head"'), ['substitution-group-added']],
  ['substitution group removed', el('head') + el('m', 'substitutionGroup="t:head"'), el('head') + el('m'), ['substitution-group-removed']],
  ['block added', el('a'), el('a', 'block="substitution"'), ['block-added']],
  ['block removed', el('a', 'block="#all"'), el('a'), ['block-removed']],
  ['final added on type', T(seq(el('a'))), T(seq(el('a')), ' final="extension"'), ['final-added']],
  ['optional wildcard added', T(seq(el('a'))), T(seq(el('a'), '<xs:any namespace="##other" processContents="lax" minOccurs="0"/>')), ['wildcard-added']],
  ['wildcard removed', T(seq(el('a'), '<xs:any namespace="##other" processContents="lax" minOccurs="0"/>')), T(seq(el('a'))), ['wildcard-removed']],
  ['wildcard became strict', T(seq('<xs:any namespace="##other" processContents="lax" minOccurs="0"/>')), T(seq('<xs:any namespace="##other" processContents="strict" minOccurs="0"/>')), ['wildcard-narrowed']],
  ['wildcard namespace widened', T(seq('<xs:any namespace="##other" processContents="lax" minOccurs="0"/>')), T(seq('<xs:any namespace="##any" processContents="lax" minOccurs="0"/>')), ['wildcard-widened']],
  ['any attribute added', T(seq(el('a'))), T(seq(el('a')) + '<xs:anyAttribute processContents="lax"/>'), ['any-attribute-added']],
  ['any attribute removed', T(seq(el('a')) + '<xs:anyAttribute processContents="lax"/>'), T(seq(el('a'))), ['any-attribute-removed']],
  ['documentation changed', '<xs:element name="a" type="xs:string"><xs:annotation><xs:documentation>Old text.</xs:documentation></xs:annotation></xs:element>', '<xs:element name="a" type="xs:string"><xs:annotation><xs:documentation>New text.</xs:documentation></xs:annotation></xs:element>', ['documentation-changed']],
  ['documentation added', el('a'), '<xs:element name="a" type="xs:string"><xs:annotation><xs:documentation>Text.</xs:documentation></xs:annotation></xs:element>', ['documentation-added']],
  ['documentation removed', '<xs:element name="a" type="xs:string"><xs:annotation><xs:documentation>Text.</xs:documentation></xs:annotation></xs:element>', el('a'), ['documentation-removed']],
  ['documentation whitespace only', '<xs:element name="a" type="xs:string"><xs:annotation><xs:documentation>Same   text.</xs:documentation></xs:annotation></xs:element>', '<xs:element name="a" type="xs:string"><xs:annotation><xs:documentation>Same text.</xs:documentation></xs:annotation></xs:element>', []],
  ['enumeration value documented', st('S', '<xs:enumeration value="a"/>'), st('S', '<xs:enumeration value="a"><xs:annotation><xs:documentation>The a value.</xs:documentation></xs:annotation></xs:enumeration>'), ['documentation-added']],
  ['key constraint added', E('r', '<xs:complexType>' + seq(el('k')) + '</xs:complexType>'), E('r', '<xs:complexType>' + seq(el('k')) + '</xs:complexType><xs:key name="K"><xs:selector xpath="."/><xs:field xpath="t:k"/></xs:key>'), ['constraint-added']],
  ['key constraint removed', E('r', '<xs:complexType>' + seq(el('k')) + '</xs:complexType><xs:key name="K"><xs:selector xpath="."/><xs:field xpath="t:k"/></xs:key>'), E('r', '<xs:complexType>' + seq(el('k')) + '</xs:complexType>'), ['constraint-removed']],
  ['content moved into a new group', T(seq(el('a'), el('b'))), T(seq('<xs:group ref="t:G"/>')) + '<xs:group name="G">' + seq(el('a'), el('b')) + '</xs:group>', ['component-added']],
  ['change inside a group used twice is reported once', '<xs:group name="G">' + seq(el('a')) + '</xs:group>' + T(seq('<xs:group ref="t:G"/>')) + '<xs:complexType name="U">' + seq('<xs:group ref="t:G"/>') + '</xs:complexType>',
    '<xs:group name="G">' + seq(el('a'), el('b')) + '</xs:group>' + T(seq('<xs:group ref="t:G"/>')) + '<xs:complexType name="U">' + seq('<xs:group ref="t:G"/>') + '</xs:complexType>', ['child-added-required']],
  ['change in a base type is reported once', '<xs:complexType name="Base">' + seq(el('a')) + '</xs:complexType>' + T('<xs:complexContent><xs:extension base="t:Base">' + seq(el('b')) + '</xs:extension></xs:complexContent>'),
    '<xs:complexType name="Base">' + seq(el('a', 'minOccurs="0"')) + '</xs:complexType>' + T('<xs:complexContent><xs:extension base="t:Base">' + seq(el('b')) + '</xs:extension></xs:complexContent>'), ['became-optional']],
  ['attribute group change reported once', '<xs:attributeGroup name="G"><xs:attribute name="x" type="xs:string"/></xs:attributeGroup>' + T('<xs:attributeGroup ref="t:G"/>'),
    '<xs:attributeGroup name="G"><xs:attribute name="x" type="xs:string" use="required"/></xs:attributeGroup>' + T('<xs:attributeGroup ref="t:G"/>'), ['attribute-became-required']],
  ['type no longer derives from its base', '<xs:complexType name="Base">' + seq(el('a')) + '</xs:complexType>' + T('<xs:complexContent><xs:extension base="t:Base">' + seq(el('b')) + '</xs:extension></xs:complexContent>'),
    '<xs:complexType name="Base">' + seq(el('a')) + '</xs:complexType>' + T(seq(el('a'), el('b'))), ['base-type-changed']],
  ['nested anonymous change has a path', E('order', '<xs:complexType>' + seq(E('lines', '<xs:complexType>' + seq(E('line', '<xs:complexType>' + seq(el('qty')) + '</xs:complexType>')) + '</xs:complexType>')) + '</xs:complexType>'),
    E('order', '<xs:complexType>' + seq(E('lines', '<xs:complexType>' + seq(E('line', '<xs:complexType>' + seq(el('qty'), el('sku')) + '</xs:complexType>')) + '</xs:complexType>')) + '</xs:complexType>'), ['child-added-required']],
  ['element reference occurrence changed', el('a') + T(seq('<xs:element ref="t:a"/>')), el('a') + T(seq('<xs:element ref="t:a" maxOccurs="2"/>')), ['occurrence-max-increased']],
  ['recursive type changed', '<xs:complexType name="Node">' + seq(el('label'), '<xs:element name="child" type="t:Node" minOccurs="0" maxOccurs="unbounded"/>') + '</xs:complexType>',
    '<xs:complexType name="Node">' + seq(el('label'), '<xs:element name="child" type="t:Node" minOccurs="0" maxOccurs="10"/>') + '</xs:complexType>', ['occurrence-max-decreased']]
];

for (const [name, oldBody, newBody, expected] of CASES) {
  test('diff: ' + name, async () => {
    const r = await diff(sch(oldBody), sch(newBody));
    const got = r.changes.map(function (c) { return c.code; }).sort();
    assert.deepEqual(got, expected.slice().sort(), JSON.stringify(r.changes.map(function (c) { return [c.code, c.component, c.path]; })));
    for (const c of r.changes) assert.equal(c.severity, RULES[c.code], c.code);
  });
}

test('diff: case count is at least 80', () => { assert.ok(CASES.length >= 80, String(CASES.length)); });

test('diff: namespace change is reported once and components are matched across it', async () => {
  const r = await diff(sch(T(seq(el('a'))), '', 'urn:v1'), sch(T(seq(el('a'))), '', 'urn:v2'));
  assert.deepEqual(r.changes.map(function (c) { return c.code; }), ['namespace-changed']);
  assert.equal(r.counts.BREAKING, 1);
});

test('diff: elementFormDefault and version changes', async () => {
  const r = await diff(sch(el('a'), 'version="1"'), sch(el('a'), 'version="2"').replace('elementFormDefault="qualified"', 'elementFormDefault="unqualified"'));
  assert.deepEqual(r.changes.map(function (c) { return c.code; }).sort(), ['element-form-changed', 'version-changed']);
});

test('diff: an import added with its file', async () => {
  const other = '<xs:schema ' + XS + ' targetNamespace="urn:o"><xs:simpleType name="X"><xs:restriction base="xs:string"/></xs:simpleType></xs:schema>';
  const r = await diff(sch(el('a')), sch('<xs:import namespace="urn:o" schemaLocation="o.xsd"/>' + el('a')), {}, { 'o.xsd': other });
  assert.deepEqual(r.changes.map(function (c) { return c.code; }).sort(), ['component-added', 'import-added']);
});

test('diff: paths and components of a nested change', async () => {
  const mk = function (extra) { return E('order', '<xs:complexType>' + seq(E('lines', '<xs:complexType>' + seq(E('line', '<xs:complexType>' + seq(el('qty'), extra) + '</xs:complexType>')) + '</xs:complexType>')) + '</xs:complexType>'); };
  const r = await diff(sch(mk('')), sch(mk(el('sku'))));
  assert.equal(r.changes[0].component, 'element order');
  assert.equal(r.changes[0].path, 'lines/line/sku');
  assert.ok(r.changes[0].newLoc && r.changes[0].newLoc.line >= 1);
});

test('diff: counts add up and changes are sorted by class', async () => {
  const r = await diff(sch(T(seq(el('a'), el('b'))) + st('S', enums('x', 'y'))), sch(T(seq(el('a', 'minOccurs="0"'), el('c', 'minOccurs="0"'))) + st('S', enums('x'))));
  const order = r.changes.map(function (c) { return c.severity; });
  assert.deepEqual(order, order.slice().sort(function (a, b) { return ['BREAKING', 'NON-BREAKING', 'DOCUMENTATION'].indexOf(a) - ['BREAKING', 'NON-BREAKING', 'DOCUMENTATION'].indexOf(b); }));
  assert.equal(r.counts.BREAKING + r.counts['NON-BREAKING'] + r.counts.DOCUMENTATION, r.changes.length);
});

test('diff: every corpus schema compared with itself has no changes', async () => {
  for (const f of L.corpusFiles('xsd')) {
    const a = await L.loadFile(f);
    const b = await L.loadFile(f);
    const r = diffSets(a, b);
    assert.deepEqual(r.changes, [], f);
  }
});
