'use strict';
// The built-in datatypes of XML Schema (1.0 plus the 1.1 additions): derivation tree, primitive
// type, whitespace rule, implicit bounds, which facets apply, lexical checks and value comparison.

const XSD_NS = 'http://www.w3.org/2001/XMLSchema';
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';

// name: [base, extra]; extra: { list: itemType, ws, min, max }
const TABLE = {
  anyType: [null],
  anySimpleType: ['anyType'],
  anyAtomicType: ['anySimpleType'],
  string: ['anyAtomicType', { ws: 'preserve' }],
  boolean: ['anyAtomicType'],
  decimal: ['anyAtomicType'],
  float: ['anyAtomicType'],
  double: ['anyAtomicType'],
  duration: ['anyAtomicType'],
  dateTime: ['anyAtomicType'],
  time: ['anyAtomicType'],
  date: ['anyAtomicType'],
  gYearMonth: ['anyAtomicType'],
  gYear: ['anyAtomicType'],
  gMonthDay: ['anyAtomicType'],
  gDay: ['anyAtomicType'],
  gMonth: ['anyAtomicType'],
  hexBinary: ['anyAtomicType'],
  base64Binary: ['anyAtomicType'],
  anyURI: ['anyAtomicType'],
  QName: ['anyAtomicType'],
  NOTATION: ['anyAtomicType'],
  normalizedString: ['string', { ws: 'replace' }],
  token: ['normalizedString', { ws: 'collapse' }],
  language: ['token'],
  NMTOKEN: ['token'],
  Name: ['token'],
  NCName: ['Name'],
  ID: ['NCName'],
  IDREF: ['NCName'],
  ENTITY: ['NCName'],
  NMTOKENS: ['anySimpleType', { list: 'NMTOKEN' }],
  IDREFS: ['anySimpleType', { list: 'IDREF' }],
  ENTITIES: ['anySimpleType', { list: 'ENTITY' }],
  integer: ['decimal'],
  nonPositiveInteger: ['integer', { max: '0' }],
  negativeInteger: ['nonPositiveInteger', { max: '-1' }],
  long: ['integer', { min: '-9223372036854775808', max: '9223372036854775807' }],
  int: ['long', { min: '-2147483648', max: '2147483647' }],
  short: ['int', { min: '-32768', max: '32767' }],
  byte: ['short', { min: '-128', max: '127' }],
  nonNegativeInteger: ['integer', { min: '0' }],
  unsignedLong: ['nonNegativeInteger', { max: '18446744073709551615' }],
  unsignedInt: ['unsignedLong', { max: '4294967295' }],
  unsignedShort: ['unsignedInt', { max: '65535' }],
  unsignedByte: ['unsignedShort', { max: '255' }],
  positiveInteger: ['nonNegativeInteger', { min: '1' }],
  dateTimeStamp: ['dateTime'],
  dayTimeDuration: ['duration'],
  yearMonthDuration: ['duration']
};

const PRIMITIVES = ['string', 'boolean', 'decimal', 'float', 'double', 'duration', 'dateTime', 'time', 'date', 'gYearMonth', 'gYear',
  'gMonthDay', 'gDay', 'gMonth', 'hexBinary', 'base64Binary', 'anyURI', 'QName', 'NOTATION'];

const FACETS = ['length', 'minLength', 'maxLength', 'pattern', 'enumeration', 'whiteSpace', 'maxInclusive', 'maxExclusive',
  'minInclusive', 'minExclusive', 'totalDigits', 'fractionDigits', 'assertion', 'explicitTimezone'];

const ORDERED = ['decimal', 'float', 'double', 'duration', 'dateTime', 'time', 'date', 'gYearMonth', 'gYear', 'gMonthDay', 'gDay', 'gMonth'];

/** True when `name` is a built-in type name (local name in the XSD namespace). */
function isBuiltin(name) { return Object.prototype.hasOwnProperty.call(TABLE, name); }

/** The base type name of a built-in, or null for anyType. */
function baseOf(name) { return isBuiltin(name) ? TABLE[name][0] : null; }

/** The chain from `name` up to anyType, `name` first. */
function chainOf(name) {
  const out = [];
  let n = name;
  while (n && isBuiltin(n) && out.length < 20) { out.push(n); n = TABLE[n][0]; }
  return out;
}

/** True when built-in `a` is `b` or derives from it. */
function derivesFrom(a, b) { return chainOf(a).indexOf(b) !== -1; }

/** The primitive type of a built-in ('string', 'decimal', ...), 'list' for the list types, or ''. */
function primitiveOf(name) {
  if (!isBuiltin(name)) return '';
  if (TABLE[name][1] && TABLE[name][1].list) return 'list';
  for (const n of chainOf(name)) if (PRIMITIVES.indexOf(n) !== -1) return n;
  return '';
}

/** Item type of a built-in list type, or ''. */
function listItemOf(name) { return isBuiltin(name) && TABLE[name][1] && TABLE[name][1].list ? TABLE[name][1].list : ''; }

/** The whitespace rule of a built-in. */
function whiteSpaceOf(name) {
  for (const n of chainOf(name)) {
    const extra = TABLE[n][1];
    if (extra && extra.ws) return extra.ws;
    if (n === 'anySimpleType' || n === 'anyAtomicType') break;
  }
  return 'collapse';
}

/** The implicit bounds of an integer built-in: { min, max } as decimal strings (missing = none). */
function boundsOf(name) {
  const out = {};
  for (const n of chainOf(name)) {
    const extra = TABLE[n][1];
    if (!extra) continue;
    if (out.min === undefined && extra.min !== undefined) out.min = extra.min;
    if (out.max === undefined && extra.max !== undefined) out.max = extra.max;
  }
  return out;
}

/** The facets allowed for a variety ('atomic', 'list', 'union') and primitive. */
function applicableFacets(variety, primitive) {
  if (variety === 'list') return ['length', 'minLength', 'maxLength', 'pattern', 'enumeration', 'whiteSpace', 'assertion'];
  if (variety === 'union') return ['pattern', 'enumeration', 'assertion'];
  switch (primitive) {
    case 'string': case 'anyURI': case 'QName': case 'NOTATION': case 'hexBinary': case 'base64Binary':
      return ['length', 'minLength', 'maxLength', 'pattern', 'enumeration', 'whiteSpace', 'assertion'];
    case 'boolean':
      return ['pattern', 'whiteSpace', 'assertion'];
    case 'decimal':
      return ['totalDigits', 'fractionDigits', 'pattern', 'whiteSpace', 'enumeration', 'maxInclusive', 'maxExclusive', 'minInclusive', 'minExclusive', 'assertion'];
    case 'dateTime': case 'time': case 'date': case 'gYearMonth': case 'gYear': case 'gMonthDay': case 'gDay': case 'gMonth':
      return ['pattern', 'enumeration', 'whiteSpace', 'maxInclusive', 'maxExclusive', 'minInclusive', 'minExclusive', 'assertion', 'explicitTimezone'];
    case 'float': case 'double': case 'duration':
      return ['pattern', 'enumeration', 'whiteSpace', 'maxInclusive', 'maxExclusive', 'minInclusive', 'minExclusive', 'assertion'];
    default:
      return FACETS.slice();
  }
}

/** True when values of the primitive are ordered (bounds facets compare them). */
function isOrdered(primitive) { return ORDERED.indexOf(primitive) !== -1; }

/** Applies a whitespace rule to a value. */
function normaliseWhiteSpace(value, rule) {
  const v = String(value);
  if (rule === 'preserve') return v;
  const replaced = v.replace(/[\t\n\r]/g, ' ');
  if (rule === 'replace') return replaced;
  return replaced.replace(/ +/g, ' ').replace(/^ | $/g, '');
}

// ---- lexical checks -----------------------------------------------------------------------------

const TZ = '(Z|[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00))?';
const LEX = {
  boolean: /^(true|false|1|0)$/,
  decimal: /^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$/,
  integer: /^[+-]?[0-9]+$/,
  float: /^([+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([Ee][+-]?[0-9]+)?|[+-]?INF|NaN)$/,
  duration: /^-?P(?=[0-9T])(?:[0-9]+Y)?(?:[0-9]+M)?(?:[0-9]+D)?(?:T(?=[0-9])(?:[0-9]+H)?(?:[0-9]+M)?(?:[0-9]+(?:\.[0-9]+)?S)?)?$/,
  dateTime: new RegExp('^-?([0-9]{4,})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\\.[0-9]+)?' + TZ + '$'),
  time: new RegExp('^([0-9]{2}):([0-9]{2}):([0-9]{2})(\\.[0-9]+)?' + TZ + '$'),
  date: new RegExp('^-?([0-9]{4,})-([0-9]{2})-([0-9]{2})' + TZ + '$'),
  gYearMonth: new RegExp('^-?([0-9]{4,})-([0-9]{2})' + TZ + '$'),
  gYear: new RegExp('^-?([0-9]{4,})' + TZ + '$'),
  gMonthDay: new RegExp('^--([0-9]{2})-([0-9]{2})' + TZ + '$'),
  gDay: new RegExp('^---([0-9]{2})' + TZ + '$'),
  gMonth: new RegExp('^--([0-9]{2})' + TZ + '$'),
  hexBinary: /^([0-9A-Fa-f]{2})*$/,
  base64Binary: /^(([A-Za-z0-9+/] ?){4})*(([A-Za-z0-9+/] ?){3}[A-Za-z0-9+/]|([A-Za-z0-9+/] ?){2}[AEIMQUYcgkosw048] ?=|[A-Za-z0-9+/] ?[AQgw] ?= ?=)?$/,
  language: /^[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*$/
};

function daysIn(year, month) {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].indexOf(month) !== -1 ? 30 : 31;
}

function validDateParts(y, mo, d) {
  if (mo < 1 || mo > 12) return false;
  if (d !== undefined && (d < 1 || d > daysIn(y === undefined ? 2000 : y, mo))) return false;
  return true;
}

function validTime(h, mi, sec) {
  if (h === 24) return mi === 0 && sec === 0;
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && sec >= 0 && sec < 60;
}

/**
 * Checks the lexical form of a value (after whitespace normalisation) against a built-in type.
 * Returns '' when it is acceptable, otherwise a short reason. `isName` and `isNCName` come from
 * the parser so that both use one definition of an XML name.
 */
function checkLexical(builtin, value, names) {
  const prim = primitiveOf(builtin);
  const v = value;
  const isName = names && names.isName ? names.isName : function () { return true; };
  const isNCName = names && names.isNCName ? names.isNCName : function () { return true; };
  const isQName = names && names.isQName ? names.isQName : function () { return true; };
  if (prim === 'list') {
    const item = listItemOf(builtin);
    const items = v === '' ? [] : v.split(' ');
    if (!items.length) return 'a list of at least one item is expected';
    for (const it of items) { const r = checkLexical(item, it, names); if (r) return r; }
    return '';
  }
  switch (builtin) {
    case 'language': return LEX.language.test(v) ? '' : 'not a language code such as en or en-GB';
    case 'Name': return isName(v) ? '' : 'not an XML name';
    case 'NCName': case 'ID': case 'IDREF': case 'ENTITY': return isNCName(v) ? '' : 'not an XML name without a colon';
    case 'NMTOKEN': return /^[^\s]+$/.test(v) && isName('a' + v.replace(/[:]/g, '')) ? '' : 'not a name token';
    case 'normalizedString': return /[\t\r\n]/.test(v) ? 'contains a tab or line break' : '';
    case 'token': return /[\t\r\n]|^ | $| {2}/.test(v) ? 'contains leading, trailing or double spaces' : '';
    default: break;
  }
  switch (prim) {
    case 'string': case 'anyURI': return '';
    case 'boolean': return LEX.boolean.test(v) ? '' : 'expected true, false, 1 or 0';
    case 'decimal': {
      const integerType = derivesFrom(builtin, 'integer');
      if (!(integerType ? LEX.integer : LEX.decimal).test(v)) return integerType ? 'not an integer' : 'not a decimal number';
      const b = boundsOf(builtin);
      if (b.min !== undefined && compareDecimal(v, b.min) < 0) return 'below ' + b.min;
      if (b.max !== undefined && compareDecimal(v, b.max) > 0) return 'above ' + b.max;
      return '';
    }
    case 'float': case 'double': return LEX.float.test(v) ? '' : 'not a floating point number';
    case 'duration': {
      if (!LEX.duration.test(v)) return 'not a duration such as P1Y2M3DT4H';
      if (builtin === 'dayTimeDuration' && /[YM](?=.*T|[^T]*$)/.test(v.split('T')[0].slice(1))) return 'a day-time duration has no years or months';
      if (builtin === 'yearMonthDuration' && /[DTHS]/.test(v)) return 'a year-month duration has only years and months';
      return '';
    }
    case 'dateTime': {
      const m = LEX.dateTime.exec(v);
      if (!m) return 'not a date and time such as 2026-01-15T09:30:00Z';
      if (!validDateParts(Number(m[1]), Number(m[2]), Number(m[3])) || !validTime(Number(m[4]), Number(m[5]), Number(m[6]))) return 'not a real date and time';
      if (builtin === 'dateTimeStamp' && !m[8]) return 'a time zone is required';
      return '';
    }
    case 'time': {
      const m = LEX.time.exec(v);
      if (!m || !validTime(Number(m[1]), Number(m[2]), Number(m[3]))) return 'not a time such as 09:30:00';
      return '';
    }
    case 'date': {
      const m = LEX.date.exec(v);
      if (!m || !validDateParts(Number(m[1]), Number(m[2]), Number(m[3]))) return 'not a date such as 2026-01-15';
      return '';
    }
    case 'gYearMonth': { const m = LEX.gYearMonth.exec(v); return m && validDateParts(Number(m[1]), Number(m[2])) ? '' : 'not a year and month such as 2026-01'; }
    case 'gYear': return LEX.gYear.test(v) ? '' : 'not a year such as 2026';
    case 'gMonthDay': { const m = LEX.gMonthDay.exec(v); return m && validDateParts(undefined, Number(m[1]), Number(m[2])) ? '' : 'not a month and day such as --01-15'; }
    case 'gDay': { const m = LEX.gDay.exec(v); return m && Number(m[1]) >= 1 && Number(m[1]) <= 31 ? '' : 'not a day such as ---15'; }
    case 'gMonth': { const m = LEX.gMonth.exec(v); return m && Number(m[1]) >= 1 && Number(m[1]) <= 12 ? '' : 'not a month such as --01'; }
    case 'hexBinary': return LEX.hexBinary.test(v) ? '' : 'not hexadecimal octets';
    case 'base64Binary': return LEX.base64Binary.test(v) ? '' : 'not base64 data';
    case 'QName': case 'NOTATION': return isQName(v) ? '' : 'not a qualified name';
    default: return '';
  }
}

// ---- comparison ---------------------------------------------------------------------------------

function splitDecimal(s) {
  let t = String(s).trim();
  let neg = false;
  if (t.charAt(0) === '+' || t.charAt(0) === '-') { neg = t.charAt(0) === '-'; t = t.slice(1); }
  const dot = t.indexOf('.');
  let ip = dot === -1 ? t : t.slice(0, dot);
  let fp = dot === -1 ? '' : t.slice(dot + 1);
  ip = ip.replace(/^0+/, '');
  fp = fp.replace(/0+$/, '');
  if (!ip && !fp) neg = false;
  return { neg: neg, ip: ip, fp: fp };
}

/** Compares two decimal strings exactly. Returns -1, 0 or 1 (NaN for non-numbers). */
function compareDecimal(a, b) {
  if (!LEX.decimal.test(String(a).trim()) || !LEX.decimal.test(String(b).trim())) return NaN;
  const x = splitDecimal(a);
  const y = splitDecimal(b);
  if (x.neg !== y.neg) return x.neg ? -1 : 1;
  const sign = x.neg ? -1 : 1;
  if (x.ip.length !== y.ip.length) return (x.ip.length > y.ip.length ? 1 : -1) * sign;
  if (x.ip !== y.ip) return (x.ip > y.ip ? 1 : -1) * sign;
  const n = Math.max(x.fp.length, y.fp.length);
  const fx = x.fp.padEnd(n, '0');
  const fy = y.fp.padEnd(n, '0');
  if (fx === fy) return 0;
  return (fx > fy ? 1 : -1) * sign;
}

function dateKey(prim, v) {
  // Turns a date/time value into milliseconds for comparison (time zone applied when present).
  let m;
  let y = 2000; let mo = 1; let d = 1; let h = 0; let mi = 0; let sec = 0; let tz = null;
  if (prim === 'dateTime') { m = LEX.dateTime.exec(v); if (!m) return NaN; y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]); h = Number(m[4]); mi = Number(m[5]); sec = Number(m[6] + (m[7] || '')); tz = m[8]; if (v.charAt(0) === '-') y = -y; }
  else if (prim === 'date') { m = LEX.date.exec(v); if (!m) return NaN; y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]); tz = m[4]; if (v.charAt(0) === '-') y = -y; }
  else if (prim === 'time') { m = LEX.time.exec(v); if (!m) return NaN; h = Number(m[1]); mi = Number(m[2]); sec = Number(m[3] + (m[4] || '')); tz = m[5]; }
  else if (prim === 'gYearMonth') { m = LEX.gYearMonth.exec(v); if (!m) return NaN; y = Number(m[1]); mo = Number(m[2]); tz = m[3]; }
  else if (prim === 'gYear') { m = LEX.gYear.exec(v); if (!m) return NaN; y = Number(m[1]); tz = m[2]; if (v.charAt(0) === '-') y = -y; }
  else if (prim === 'gMonthDay') { m = LEX.gMonthDay.exec(v); if (!m) return NaN; mo = Number(m[1]); d = Number(m[2]); tz = m[3]; }
  else if (prim === 'gDay') { m = LEX.gDay.exec(v); if (!m) return NaN; d = Number(m[1]); tz = m[2]; }
  else if (prim === 'gMonth') { m = LEX.gMonth.exec(v); if (!m) return NaN; mo = Number(m[1]); tz = m[2]; }
  else return NaN;
  let t = Date.UTC(2000, mo - 1, d, h, mi, 0) + sec * 1000;
  t += (y - 2000) * 365.2425 * 86400000;
  if (tz && tz !== 'Z') {
    const sign = tz.charAt(0) === '-' ? -1 : 1;
    t -= sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(4, 6))) * 60000;
  }
  return t;
}

function durationKey(v) {
  const m = /^(-)?P(?:([0-9]+)Y)?(?:([0-9]+)M)?(?:([0-9]+)D)?(?:T(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9.]+)S)?)?$/.exec(v);
  if (!m) return NaN;
  const sign = m[1] ? -1 : 1;
  const months = Number(m[2] || 0) * 12 + Number(m[3] || 0);
  const secs = Number(m[4] || 0) * 86400 + Number(m[5] || 0) * 3600 + Number(m[6] || 0) * 60 + Number(m[7] || 0);
  return sign * (months * 30.436875 * 86400 + secs);
}

/**
 * Compares two values of an ordered primitive. Returns -1, 0, 1, or NaN when they cannot be
 * compared (bad lexical form or an order that is only partial).
 */
function compareValues(prim, a, b) {
  if (prim === 'decimal') return compareDecimal(a, b);
  if (prim === 'float' || prim === 'double') {
    const x = parseFloatValue(a);
    const y = parseFloatValue(b);
    if (isNaN(x) || isNaN(y)) return NaN;
    return x === y ? 0 : x < y ? -1 : 1;
  }
  if (prim === 'duration') {
    const x = durationKey(a);
    const y = durationKey(b);
    if (isNaN(x) || isNaN(y)) return NaN;
    return x === y ? 0 : x < y ? -1 : 1;
  }
  const x = dateKey(prim, a);
  const y = dateKey(prim, b);
  if (isNaN(x) || isNaN(y)) return NaN;
  return x === y ? 0 : x < y ? -1 : 1;
}

function parseFloatValue(v) {
  const t = String(v).trim();
  if (t === 'INF' || t === '+INF') return Infinity;
  if (t === '-INF') return -Infinity;
  if (t === 'NaN') return NaN;
  return LEX.float.test(t) ? Number(t) : NaN;
}

/** Number of digits and fraction digits of a decimal string: { total, fraction }. */
function digitsOf(v) {
  const x = splitDecimal(v);
  const total = (x.ip + x.fp).replace(/^0+/, '').length || 1;
  return { total: Math.max(total, x.ip.length + x.fp.length) || 1, fraction: x.fp.length };
}

const BUILTIN_NAMES = Object.keys(TABLE);

module.exports = {
  XSD_NS: XSD_NS,
  XSI_NS: XSI_NS,
  BUILTIN_NAMES: BUILTIN_NAMES,
  PRIMITIVES: PRIMITIVES,
  FACETS: FACETS,
  isBuiltin: isBuiltin,
  baseOf: baseOf,
  chainOf: chainOf,
  derivesFrom: derivesFrom,
  primitiveOf: primitiveOf,
  listItemOf: listItemOf,
  whiteSpaceOf: whiteSpaceOf,
  boundsOf: boundsOf,
  applicableFacets: applicableFacets,
  isOrdered: isOrdered,
  normaliseWhiteSpace: normaliseWhiteSpace,
  checkLexical: checkLexical,
  compareDecimal: compareDecimal,
  compareValues: compareValues,
  digitsOf: digitsOf
};
