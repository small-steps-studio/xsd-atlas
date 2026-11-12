'use strict';
// Old/new schema pairs for the comparison tests: pairs with a witness document that is valid under
// the old version and invalid under the new one (BREAKS), and pairs that accept at least as much
// as before (SAFE).

const XS = 'xmlns:xs="http://www.w3.org/2001/XMLSchema"';
function sch(body) { return '<xs:schema ' + XS + ' xmlns:t="urn:t" targetNamespace="urn:t" elementFormDefault="qualified">' + body + '</xs:schema>'; }
function T(content) { return sch('<xs:element name="root" type="t:T"/><xs:complexType name="T">' + content + '</xs:complexType>'); }
function el(name, extra) { return '<xs:element name="' + name + '" type="xs:string"' + (extra ? ' ' + extra : '') + '/>'; }
function seq(attrs, ...items) { return '<xs:sequence' + (attrs ? ' ' + attrs : '') + '>' + items.join('') + '</xs:sequence>'; }
function cho(attrs, ...items) { return '<xs:choice' + (attrs ? ' ' + attrs : '') + '>' + items.join('') + '</xs:choice>'; }
function doc(children, attrs) { return '<root xmlns="urn:t"' + (attrs || '') + '>' + children.map(function (c) { return '<' + c + '>x</' + c + '>'; }).join('') + '</root>'; }
function V(union) { return sch('<xs:element name="v"><xs:simpleType>' + union + '</xs:simpleType></xs:element>'); }
const inlineStr = function (facets) { return '<xs:simpleType><xs:restriction base="xs:string">' + facets + '</xs:restriction></xs:simpleType>'; };

// [id, old schema, new schema, witness valid before and invalid after, code expected among the BREAKING ones]
const BREAKS = [
  ['w01 optional choice made required', T(cho('minOccurs="0"', el('a'), el('b'))), T(cho('', el('a'), el('b'))), doc([]), 'group-became-required'],
  ['w02 optional option of a choice made required', T(cho('', el('a', 'minOccurs="0"'), el('b'))), T(cho('', el('a'), el('b'))), doc([]), 'group-became-required'],
  ['w03 required element added to a choice branch', T(cho('', seq('', el('a'), el('b')), el('c'))), T(cho('', seq('', el('a'), el('b'), el('d')), el('c'))), doc(['a', 'b']), 'child-added-conditional'],
  ['w04 element of a choice branch made required', T(cho('', seq('', el('a'), el('b', 'minOccurs="0"')), el('c'))), T(cho('', seq('', el('a'), el('b')), el('c'))), doc(['a']), 'became-required-in-group'],
  ['w05 required element added to an optional group', T(seq('', el('h'), seq('minOccurs="0"', el('a')))), T(seq('', el('h'), seq('minOccurs="0"', el('a'), el('c')))), doc(['h', 'a']), 'child-added-conditional'],
  ['w06 required element added to an optional repeated group', T(seq('minOccurs="0" maxOccurs="unbounded"', el('a'))), T(seq('minOccurs="0" maxOccurs="unbounded"', el('a'), el('c'))), doc(['a']), 'child-added-conditional'],
  ['w07 element of an optional group made required', T(seq('', el('h'), seq('minOccurs="0"', el('a'), el('b', 'minOccurs="0"')))), T(seq('', el('h'), seq('minOccurs="0"', el('a'), el('b')))), doc(['h', 'a']), 'became-required-in-group'],
  ['w09 optional attribute prohibited', T(seq('', el('a')) + '<xs:attribute name="x" type="xs:string"/>'), T(seq('', el('a')) + '<xs:attribute name="x" type="xs:string" use="prohibited"/>'), doc(['a'], ' x="1"'), 'attribute-removed'],
  ['w11 order changed inside a choice branch', T(cho('', seq('', el('a'), el('b')), el('c'))), T(cho('', seq('', el('b'), el('a')), el('c'))), doc(['a', 'b']), 'order-changed'],
  ['w12 minimum raised for a choice option', T(cho('', el('a', 'maxOccurs="3"'), el('b'))), T(cho('', el('a', 'minOccurs="2" maxOccurs="3"'), el('b'))), doc(['a']), 'became-required-in-group'],
  ['w21 required element added to a branch of an optional choice', T(seq('', el('h'), cho('minOccurs="0"', seq('', el('a')), el('b')))), T(seq('', el('h'), cho('minOccurs="0"', seq('', el('a'), el('a2')), el('b')))), doc(['h', 'a']), 'child-added-conditional'],
  ['w26 inline union member narrowed', V('<xs:union>' + inlineStr('<xs:maxLength value="5"/>') + '<xs:simpleType><xs:restriction base="xs:int"/></xs:simpleType></xs:union>'), V('<xs:union>' + inlineStr('<xs:maxLength value="2"/>') + '<xs:simpleType><xs:restriction base="xs:int"/></xs:simpleType></xs:union>'), '<v xmlns="urn:t">abcd</v>', 'facet-narrowed'],
  ['n47 inline union member removed', V('<xs:union memberTypes="xs:int">' + inlineStr('<xs:enumeration value="none"/>') + '</xs:union>'), V('<xs:union memberTypes="xs:int"/>'), '<v xmlns="urn:t">none</v>', 'union-member-removed'],
  ['n52 required element added to a branch of a required choice', T(seq('', el('h'), cho('', el('a'), el('b')))), T(seq('', el('h'), cho('', seq('', el('a'), el('a2')), el('b')))), doc(['h', 'a']), 'child-added-conditional'],
  ['n53 minimum raised inside an optional choice', T(seq('', el('h'), cho('minOccurs="0"', el('a'), el('b')))), T(seq('', el('h'), cho('minOccurs="0"', el('a', 'minOccurs="2" maxOccurs="2"'), el('b')))), doc(['h', 'a']), 'became-required-in-group'],
  ['n54 repeating choice that has to occur twice', T(cho('maxOccurs="3"', el('p'), el('q'))), T(cho('minOccurs="2" maxOccurs="3"', el('p'), el('q'))), doc(['p']), 'group-min-increased'],
  ['n55 repeating sequence that has to occur twice', T(seq('maxOccurs="3"', el('a'), el('b'))), T(seq('minOccurs="2" maxOccurs="3"', el('a'), el('b'))), doc(['a', 'b']), 'occurrence-min-increased']
];

// Changes that accept at least as much as before: nothing BREAKING may be reported.
const SAFE = [
  ['mirror of w01: required choice made optional', T(cho('', el('a'), el('b'))), T(cho('minOccurs="0"', el('a'), el('b'))), ['group-became-optional']],
  ['n39: element of an optional group made optional', T(seq('', el('h'), seq('minOccurs="0"', el('a'), el('b')))), T(seq('', el('h'), seq('minOccurs="0"', el('a'), el('b', 'minOccurs="0"')))), ['became-optional-in-group']],
  ['a new optional group with required elements', T(seq('', el('h'))), T(seq('', el('h'), seq('minOccurs="0"', el('a'), el('b')))), ['child-added-optional', 'child-added-optional']],
  ['a new choice option made of a sequence', T(cho('', el('a'), el('b'))), T(cho('', el('a'), el('b'), seq('', el('c'), el('d')))), ['child-added-optional', 'child-added-optional']],
  ['a single optional element wrapped in an optional sequence', T(seq('', el('h'), el('a', 'minOccurs="0"'))), T(seq('', el('h'), seq('minOccurs="0"', el('a')))), []],
  ['n12: maxOccurs="2" written as two declarations', T(seq('', el('a', 'maxOccurs="2"'))), T(seq('', el('a'), el('a', 'minOccurs="0"'))), []],
  ['n13: optional element replaced by a lax wildcard at the same place', T(seq('', el('h'), el('a', 'minOccurs="0"'))), T(seq('', el('h'), '<xs:any namespace="##any" processContents="lax" minOccurs="0"/>')), ['child-covered-by-wildcard', 'wildcard-added']],
  ['n51: optional attribute replaced by a lax attribute wildcard', T(seq('', el('a')) + '<xs:attribute name="k" type="xs:string"/>'), T(seq('', el('a')) + '<xs:anyAttribute namespace="##any" processContents="lax"/>'), ['attribute-covered-by-wildcard', 'any-attribute-added']],
  ['n14: decimal enumeration 1.0 written as 1.00', sch('<xs:simpleType name="S"><xs:restriction base="xs:decimal"><xs:enumeration value="1.0"/></xs:restriction></xs:simpleType>'), sch('<xs:simpleType name="S"><xs:restriction base="xs:decimal"><xs:enumeration value="1.00"/></xs:restriction></xs:simpleType>'), []],
  ['n16: length 5 written as minLength 5 and maxLength 5', sch('<xs:simpleType name="S"><xs:restriction base="xs:string"><xs:length value="5"/></xs:restriction></xs:simpleType>'), sch('<xs:simpleType name="S"><xs:restriction base="xs:string"><xs:minLength value="5"/><xs:maxLength value="5"/></xs:restriction></xs:simpleType>'), []],
  ['n56 repeating sequence of optional elements that has to occur twice', T(seq('maxOccurs="3"', el('a', 'minOccurs="0"'), el('b', 'minOccurs="0"'))), T(seq('minOccurs="2" maxOccurs="3"', el('a', 'minOccurs="0"'), el('b', 'minOccurs="0"'))), ['content-reorganised']]
];

module.exports = { XS: XS, sch: sch, T: T, el: el, seq: seq, cho: cho, doc: doc, V: V, inlineStr: inlineStr, BREAKS: BREAKS, SAFE: SAFE };
