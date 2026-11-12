'use strict';
// XML reader: namespaces, entities (never external), CDATA, comments, processing instructions,
// byte order marks and encodings, error recovery, positions, and hostile input.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/xml/parser');
const { decodeBytes } = require('../src/xml/decode');

function codes(text) { return P.parseXml(text).errors.map((e) => e.code); }

test('namespaces of elements and attributes', () => {
  const r = P.parseXml('<a xmlns="urn:d" xmlns:p="urn:p" p:x="1" y="2"><p:b/><c xmlns=""/></a>');
  assert.deepEqual(r.errors, []);
  assert.equal(r.root.ns, 'urn:d');
  const [b, c] = P.childElements(r.root);
  assert.equal(b.ns, 'urn:p');
  assert.equal(b.local, 'b');
  assert.equal(c.ns, '');
  const x = r.root.attrs.find((a) => a.local === 'x');
  assert.equal(x.ns, 'urn:p');
  assert.equal(r.root.attrs.find((a) => a.local === 'y').ns, '');
  assert.equal(P.lookupNamespace(c, 'p'), 'urn:p');
  assert.equal(P.lookupNamespace(c, 'xml'), P.XML_NS);
  assert.equal(P.lookupNamespace(c, 'nope'), null);
});

test('namespace errors', () => {
  assert.deepEqual(codes('<p:a/>'), ['XML-UNDECLARED-PREFIX']);
  assert.ok(codes('<a xmlns:p=""/>').includes('XML-BAD-NAMESPACE-DECLARATION'));
  assert.ok(codes('<a xmlns:xml="urn:x"/>').includes('XML-BAD-NAMESPACE-DECLARATION'));
  assert.ok(codes('<a xmlns:p="urn:x" xmlns:q="urn:x" p:b="1" q:b="2"/>').includes('XML-DUPLICATE-ATTRIBUTE'));
});

test('predefined, character and internal entities', () => {
  const r = P.parseXml('<!DOCTYPE a [<!ENTITY co "Example &amp; Sons">]><a t="&lt;&#65;&#x42;&co;">x &gt; y &co; &#x1F600;</a>');
  assert.deepEqual(r.errors, []);
  assert.equal(r.root.attrs[0].value, '<ABExample & Sons');
  assert.equal(P.textContent(r, r.root), 'x > y Example & Sons \u{1F600}');
});

test('external entities are never loaded (XXE)', () => {
  const text = '<!DOCTYPE a [<!ENTITY ext SYSTEM "file:///etc/passwd"><!ENTITY pub PUBLIC "-//X//Y" "http://example.com/x">]><a>&ext;&pub;</a>';
  const r = P.parseXml(text);
  assert.deepEqual(r.errors.map((e) => e.code), ['XML-EXTERNAL-ENTITY', 'XML-EXTERNAL-ENTITY']);
  assert.equal(P.textContent(r, r.root), '');
  // The module has no way to read files or the network at all.
  const src = require('node:fs').readFileSync(require.resolve('../src/xml/parser'), 'utf8');
  assert.ok(!/require\(['"](node:)?(fs|http|https|net|child_process)['"]\)/.test(src));
});

test('entity expansion bombs are refused', () => {
  let decl = '<!ENTITY e0 "xxxxxxxxxx">';
  for (let i = 1; i <= 9; i++) decl += '<!ENTITY e' + i + ' "' + ('&e' + (i - 1) + ';').repeat(10) + '">';
  const r = P.parseXml('<!DOCTYPE a [' + decl + ']><a>&e9;</a>');
  assert.deepEqual(r.errors.map((e) => e.code), ['XML-ENTITY-LIMIT']);
  assert.equal(P.textContent(r, r.root), '');
  const rec = P.parseXml('<!DOCTYPE a [<!ENTITY x "&y;"><!ENTITY y "&x;">]><a>&x;</a>');
  assert.deepEqual(rec.errors.map((e) => e.code), ['XML-ENTITY-LIMIT']);
  // Many references to a moderate entity exhaust the per-document budget instead of memory.
  const many = P.parseXml('<!DOCTYPE a [<!ENTITY m "' + 'y'.repeat(100000) + '">]><a>' + '&m;'.repeat(50) + '</a>');
  assert.ok(many.errors.some((e) => e.code === 'XML-ENTITY-LIMIT'));
});

test('undefined entities, bare ampersands and bad character references', () => {
  assert.deepEqual(codes('<a>&nope;</a>'), ['XML-UNDEFINED-ENTITY']);
  assert.deepEqual(codes('<a>fish & chips</a>'), ['XML-BARE-AMPERSAND']);
  assert.deepEqual(codes('<a>&#0;</a>'), ['XML-INVALID-CHAR-REF']);
  assert.deepEqual(codes('<a>&#xD800;</a>'), ['XML-INVALID-CHAR-REF']);
  assert.deepEqual(codes('<a v="a & b"/>'), ['XML-BARE-AMPERSAND']);
});

test('CDATA, comments and processing instructions', () => {
  const r = P.parseXml('<?xml version="1.0"?><!-- c --><?pi data?><a><![CDATA[<x> & ]]><!-- in --><?p?>t</a>');
  assert.deepEqual(r.errors, []);
  assert.equal(P.textContent(r, r.root), '<x> & t');
  assert.equal(r.declaration.version, '1.0');
  assert.deepEqual(codes('<a><!-- a -- b --></a>'), ['XML-COMMENT-DOUBLE-HYPHEN']);
  assert.deepEqual(codes('<a><![CDATA[x</a>'), ['XML-UNCLOSED-CDATA', 'XML-UNCLOSED-ELEMENT']);
  assert.ok(codes('<a/><?xml version="1.0"?>').includes('XML-DECLARATION-POSITION'));
});

test('byte order mark and line endings', () => {
  const r = P.parseXml('﻿<?xml version="1.0"?>\r\n<a>\r\nx\ry</a>');
  assert.deepEqual(r.errors, []);
  assert.equal(P.textContent(r, r.root), '\nx\ny');
  const attr = P.parseXml('<a v="1\r\n2\t3"/>').root.attrs[0].value;
  assert.equal(attr, '1 2 3');
});

test('decode: BOMs and declared encodings', () => {
  const utf8 = decodeBytes(Buffer.from('﻿<a>é</a>', 'utf8'));
  assert.equal(utf8.text, '<a>é</a>');
  assert.equal(utf8.bom, true);
  const le = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('<a>é中</a>', 'utf16le')]);
  assert.equal(decodeBytes(le).text, '<a>é中</a>');
  const beBody = Buffer.from('<a/>', 'utf16le');
  for (let i = 0; i < beBody.length; i += 2) { const t = beBody[i]; beBody[i] = beBody[i + 1]; beBody[i + 1] = t; }
  assert.equal(decodeBytes(Buffer.concat([Buffer.from([0xFE, 0xFF]), beBody])).text, '<a/>');
  assert.equal(decodeBytes(Buffer.from('<a/>', 'utf16le')).text, '<a/>', 'UTF-16 without BOM');
  const latin = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><a>'), Buffer.from([0xE9, 0xFC]), Buffer.from('</a>')]);
  assert.equal(decodeBytes(latin).text.slice(-6), 'éü</a>');
  const cp = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="windows-1252"?><a>'), Buffer.from([0x80, 0x93]), Buffer.from('</a>')]);
  assert.equal(decodeBytes(cp).text.slice(-6), '€“</a>');
  assert.equal(decodeBytes(Buffer.from([0x3C, 0x61, 0xFF, 0x3E])).text, null, 'invalid UTF-8 is reported, not guessed');
  assert.equal(decodeBytes(Buffer.from('<?xml version="1.0" encoding="us-ascii"?><a>é</a>', 'latin1')).text, null);
  assert.equal(decodeBytes(Buffer.from('<?xml version="1.0" encoding="x-unknown-9"?><a/>')).text, null);
  assert.equal(decodeBytes(new Uint8Array(0)).text, '');
});

test('error recovery keeps a usable tree', () => {
  const r = P.parseXml('<a><b><c></b><d/></a>');
  assert.ok(r.errors.some((e) => e.code === 'XML-UNCLOSED-ELEMENT'));
  assert.deepEqual(P.childElements(r.root).map((e) => e.local), ['b', 'd']);
  assert.ok(codes('<a></b></a>').includes('XML-MISMATCHED-END-TAG'));
  assert.ok(codes('<a/><b/>').includes('XML-MULTIPLE-ROOTS'));
  assert.ok(codes('text<a/>').includes('XML-TEXT-OUTSIDE-ROOT'));
  assert.ok(codes('<a x=1/>').includes('XML-UNQUOTED-ATTRIBUTE'));
  assert.ok(codes('<a x/>').includes('XML-ATTRIBUTE-WITHOUT-VALUE'));
  assert.ok(codes('<a x="1"y="2"/>').includes('XML-MISSING-SPACE'));
  assert.ok(codes('<a x="<"/>').includes('XML-LT-IN-ATTRIBUTE'));
  assert.ok(codes('<a x="1/>').includes('XML-UNCLOSED-ATTRIBUTE'));
  assert.ok(codes('<a>1 < 2</a>').includes('XML-INVALID-NAME'));
  assert.ok(codes('</a>').includes('XML-UNEXPECTED-END-TAG'));
  assert.ok(codes('<a><!x></a>').includes('XML-INVALID-MARKUP'));
  assert.ok(codes('<a><?pi').includes('XML-UNCLOSED-PI'));
  assert.ok(codes('<a><!-- x').includes('XML-UNCLOSED-COMMENT'));
  assert.ok(codes('<a').includes('XML-UNCLOSED-TAG'));
  assert.ok(codes('<?xml encoding="utf-8"?><a/>').includes('XML-BAD-DECLARATION'));
  assert.ok(codes('<a/><!DOCTYPE a>').includes('XML-BAD-DOCTYPE'));
  assert.deepEqual(codes(''), ['XML-NO-ROOT']);
  assert.deepEqual(codes('   \n  '), ['XML-NO-ROOT']);
});

test('positions point at the right characters', () => {
  const text = '<root>\n  <child name="value"/>\n</root>';
  const r = P.parseXml(text);
  const child = P.childElements(r.root)[0];
  assert.equal(text.slice(child.start, child.end), '<child name="value"/>');
  const a = child.attrs[0];
  assert.equal(text.slice(a.valueStart, a.valueEnd), 'value');
  assert.equal(P.elementAt(r.root, text.indexOf('name')), child);
  assert.equal(P.attrAt(child, text.indexOf('value')), a);
  assert.equal(P.elementAt(r.root, 1), r.root);
});

test('name helpers', () => {
  assert.equal(P.isNCName('a-b.c_1'), true);
  assert.equal(P.isNCName('1a'), false);
  assert.equal(P.isNCName('a:b'), false);
  assert.equal(P.isQName('p:a'), true);
  assert.equal(P.isQName('p:'), false);
  assert.equal(P.isQName(':a'), false);
  assert.equal(P.isName('élément'), true);
});

test('deep nesting is cut off with an error instead of a crash', () => {
  const depth = P.MAX_DEPTH + 50;
  const r = P.parseXml('<a>'.repeat(depth) + '</a>'.repeat(depth));
  assert.ok(r.errors.some((e) => e.code === 'XML-TOO-DEEP'));
});

test('too many errors are capped', () => {
  const r = P.parseXml('<a>' + '&bad '.repeat(1000) + '</a>');
  assert.ok(r.errors.length <= 201);
  assert.equal(r.errors[r.errors.length - 1].code, 'XML-TOO-MANY-ERRORS');
});

test('hostile inputs never throw', () => {
  const inputs = ['<', '>', '<<<<', '&&&', '<![CDATA[', '<!DOCTYPE', '<!DOCTYPE a [', '<!DOCTYPE a [<!ENTITY', '<a b="', '<a xmlns:=""/>', '\u0000\u0001<a/>',
    '<a>\uD800</a>', '<é/>', '<a:b:c/>', '<a ' + 'x="1" '.repeat(5000) + '/>', '<a>' + ']]>'.repeat(100) + '</a>', String.fromCharCode(0xFEFF).repeat(3)];
  for (const s of inputs) assert.doesNotThrow(() => P.parseXml(s), JSON.stringify(s.slice(0, 30)));
  assert.doesNotThrow(() => P.parseXml(undefined));
  assert.doesNotThrow(() => P.parseXml(null));
});

test('large input: whitespace and text stay lazy, memory stays bounded', () => {
  const unit = '<item code="A1"><name>Widget</name><qty>4</qty></item>\n';
  const text = '<list>' + unit.repeat(Math.ceil(50 * 1024 * 1024 / unit.length)) + '</list>';
  global.gc && global.gc();
  const before = process.memoryUsage().heapUsed;
  const t0 = Date.now();
  const r = P.parseXml(text);
  const ms = Date.now() - t0;
  const grew = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
  assert.equal(r.errors.length, 0);
  assert.ok(P.childElements(r.root).length > 900000);
  const firstText = P.childElements(P.childElements(r.root)[0])[0].children[0];
  assert.ok(firstText instanceof P.XmlText && !Object.prototype.hasOwnProperty.call(firstText, 'value'), 'text is decoded on demand');
  assert.ok(ms < 30000, 'parse time ' + ms + ' ms');
  assert.ok(grew < 1500, 'heap growth ' + Math.round(grew) + ' MB for a 50 MB input');
});
