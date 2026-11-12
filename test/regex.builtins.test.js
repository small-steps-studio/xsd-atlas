'use strict';
// XML Schema regular expressions, built-in datatypes and facet checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/schema/xsdregex');
const B = require('../src/schema/builtins');

const MATCH = [
  ['[A-Z]{2}[0-9]{3}', ['AB123'], ['ab123', 'AB12', 'AB1234']],
  ['\\d{3}-\\d{4}', ['555-0100'], ['5550100']],
  ['[a-z-[aeiou]]+', ['xyz', 'bcd'], ['abc', '']],
  ['[^abc]x', ['dx', 'zx'], ['ax']],
  ['\\i\\c*', ['abc', '_x-1', 'a:b'], ['1abc', '-x']],
  ['(ab|cd)+e?', ['ab', 'cdabe'], ['abc', 'e']],
  ['[\\p{Lu}-[A-M]]{2}', ['NZ', 'XY'], ['AB', 'nz']],
  ['\\p{IsBasicLatin}+', ['hello'], ['héllo']],
  ['.{2,4}', ['ab', 'abcd'], ['a', 'abcde', 'a\nb']],
  ['[+\\-]?[0-9]+(\\.[0-9]{2})?', ['-12.50', '+3', '7'], ['1.5', '--1']],
  ['\\w+@\\w+\\.com', ['ab@cd.com'], ['ab@cd.org', '@cd.com']],
  ['\\s\\S', [' a', '\ta'], ['a ', '  ']],
  ['[^a-c-[b]]', ['x', 'z'], ['a', 'b', 'c']],
  ['$^', ['$^'], ['']],
  ['[-a]+', ['-a-'], ['b']],
  ['\\P{L}+', ['123'], ['a']],
  ['a{0}b', ['b'], ['ab']],
  ['(a|)b', ['ab', 'b'], ['aab']],
  ['[\\-\\[\\]]', ['-', '[', ']'], ['a']]
];

test('patterns match the XML Schema meaning (anchored, subtraction, escapes)', () => {
  for (const [p, yes, no] of MATCH) {
    const c = R.compile(p);
    assert.ok(c.ok, p + ': ' + c.message);
    for (const s of yes) assert.ok(c.regex.test(s), p + ' should match ' + JSON.stringify(s));
    for (const s of no) assert.ok(!c.regex.test(s), p + ' should not match ' + JSON.stringify(s));
  }
});

test('samples built from patterns match them, also with seeds and growth', () => {
  for (const [p] of MATCH) {
    const c = R.compile(p);
    for (const seed of [null, 1, 2, 99]) {
      for (const grow of [0, 2, 5]) {
        const s = R.sampleFor(p, seed === null ? null : R.seeded(seed), grow);
        assert.ok(s !== null && c.regex.test(s), p + ' seed ' + seed + ' grow ' + grow + ' gave ' + JSON.stringify(s));
      }
    }
  }
});

test('invalid and unsupported patterns', () => {
  for (const bad of ['(a', 'a)', '[a', 'a{2,1}', 'a{x}', '*a', '[z-a]', '\\q', '[]', 'a{', '[a-[b]x]', '\\p{Foo}']) {
    const c = R.compile(bad);
    assert.equal(c.ok, false, bad);
    assert.equal(c.unsupported, false, bad);
  }
  const u = R.compile('\\p{IsUnknownBlockName}');
  assert.equal(u.ok, false);
  assert.equal(u.unsupported, true);
});

test('regex compile is safe on long and nested input', () => {
  const long = '(a|b)'.repeat(2000);
  assert.doesNotThrow(() => R.compile(long));
  const nested = '('.repeat(500) + 'a' + ')'.repeat(500);
  assert.doesNotThrow(() => R.compile(nested));
  const t0 = Date.now();
  const c = R.compile('[a-z]+[0-9]*x');
  c.regex.test('a'.repeat(200000));
  assert.ok(Date.now() - t0 < 2000);
});

test('the seeded random source is repeatable', () => {
  const a = R.seeded(42);
  const b = R.seeded(42);
  for (let i = 0; i < 10; i++) assert.equal(a(), b());
});

test('built-in derivation tree', () => {
  assert.ok(B.derivesFrom('int', 'long'));
  assert.ok(B.derivesFrom('byte', 'decimal'));
  assert.ok(B.derivesFrom('ID', 'string'));
  assert.ok(!B.derivesFrom('long', 'int'));
  assert.equal(B.primitiveOf('unsignedShort'), 'decimal');
  assert.equal(B.primitiveOf('NMTOKENS'), 'list');
  assert.equal(B.listItemOf('IDREFS'), 'IDREF');
  assert.equal(B.whiteSpaceOf('string'), 'preserve');
  assert.equal(B.whiteSpaceOf('normalizedString'), 'replace');
  assert.equal(B.whiteSpaceOf('token'), 'collapse');
  assert.equal(B.whiteSpaceOf('int'), 'collapse');
  assert.deepEqual(B.boundsOf('byte'), { min: '-128', max: '127' });
  assert.deepEqual(B.boundsOf('positiveInteger'), { min: '1' });
  assert.equal(B.BUILTIN_NAMES.length, 50);
});

test('lexical checks of built-in types', () => {
  const ok = [['int', '-42'], ['byte', '127'], ['unsignedByte', '0'], ['decimal', '.5'], ['decimal', '-1.'], ['boolean', '1'], ['date', '2024-02-29'],
    ['dateTime', '2026-01-15T24:00:00Z'], ['time', '23:59:59.5+01:00'], ['duration', 'P1Y2M3DT4H5M6.7S'], ['gYearMonth', '2026-12'], ['gMonthDay', '--02-29'],
    ['hexBinary', '0aFF'], ['base64Binary', 'U2FtcGxl'], ['base64Binary', 'YQ=='], ['language', 'en-GB'], ['NCName', 'a.b-c'], ['QName', 'p:a'], ['float', '-INF'],
    ['double', '1.5E-3'], ['dayTimeDuration', 'P2DT3H'], ['yearMonthDuration', 'P1Y2M'], ['dateTimeStamp', '2026-01-01T00:00:00Z'], ['NMTOKENS', 'a b c'], ['anyURI', 'x y']];
  const bad = [['int', '2147483648'], ['byte', '128'], ['unsignedByte', '-1'], ['positiveInteger', '0'], ['decimal', '1e3'], ['boolean', 'yes'], ['date', '2023-02-29'],
    ['date', '2026-13-01'], ['dateTime', '2026-01-15T24:01:00Z'], ['time', '25:00:00'], ['duration', 'P'], ['duration', 'PT'], ['hexBinary', 'ABC'], ['base64Binary', 'U2F'],
    ['language', 'toolonglanguage'], ['NCName', 'a:b'], ['QName', ':a'], ['dateTimeStamp', '2026-01-01T00:00:00'], ['dayTimeDuration', 'P1Y'], ['yearMonthDuration', 'P1D'],
    ['gDay', '---32'], ['gMonth', '--13']];
  const names = require('../src/xml/parser');
  for (const [t, v] of ok) assert.equal(B.checkLexical(t, v, names), '', t + ' ' + v);
  for (const [t, v] of bad) assert.notEqual(B.checkLexical(t, v, names), '', t + ' ' + v);
});

test('value comparison: exact decimals, floats, dates with time zones, durations', () => {
  assert.equal(B.compareDecimal('10.50', '10.5'), 0);
  assert.equal(B.compareDecimal('-0', '0'), 0);
  assert.equal(B.compareDecimal('123456789012345678901234567890.1', '123456789012345678901234567890.09'), 1);
  assert.equal(B.compareDecimal('-2', '-10'), 1);
  assert.ok(isNaN(B.compareDecimal('x', '1')));
  assert.equal(B.compareValues('date', '2026-01-02', '2026-01-01'), 1);
  assert.equal(B.compareValues('dateTime', '2026-01-01T12:00:00+02:00', '2026-01-01T10:00:00Z'), 0);
  assert.equal(B.compareValues('duration', 'PT1H', 'PT60M'), 0);
  assert.equal(B.compareValues('double', 'INF', '1E308'), 1);
  assert.equal(B.normaliseWhiteSpace('  a \t b\n', 'collapse'), 'a b');
  assert.equal(B.normaliseWhiteSpace('a\tb', 'replace'), 'a b');
  assert.deepEqual(B.digitsOf('0.050'), { total: 2, fraction: 2 });
  assert.deepEqual(B.digitsOf('123.40'), { total: 4, fraction: 1 });
});

test('applicable facets by variety and primitive', () => {
  assert.ok(B.applicableFacets('atomic', 'decimal').includes('totalDigits'));
  assert.ok(!B.applicableFacets('atomic', 'decimal').includes('maxLength'));
  assert.ok(!B.applicableFacets('atomic', 'string').includes('maxInclusive'));
  assert.ok(B.applicableFacets('list', 'list').includes('maxLength'));
  assert.deepEqual(B.applicableFacets('union', 'union').sort(), ['assertion', 'enumeration', 'pattern']);
});
