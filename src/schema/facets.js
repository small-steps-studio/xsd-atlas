'use strict';
// Checks a value against a simple type definition (built-in lexical rules plus every effective
// facet), and checks the facets of a restriction for consistency. Used for default and fixed
// values, enumeration values, sample values and the facet problems.

const P = require('../xml/parser');
const B = require('./builtins');
const R = require('./xsdregex');

const NAMES = { isName: P.isName, isNCName: P.isNCName, isQName: P.isQName };

/** The simple type that governs the text of a definition (the definition itself, or the simple content of a complex type). */
function simpleOf(def) {
  if (!def) return null;
  if (def.category === 'simple') return def;
  if (def.contentKind === 'simple') return def.simpleDef || null;
  return null;
}

function lengthOf(def, v) {
  if (def.variety === 'list') return v === '' ? 0 : v.split(' ').length;
  if (def.primitive === 'hexBinary') return v.length / 2;
  if (def.primitive === 'base64Binary') {
    const clean = v.replace(/ /g, '');
    const pad = (clean.match(/=+$/) || [''])[0].length;
    return Math.floor(clean.length * 3 / 4) - pad;
  }
  return Array.from(v).length;
}

function sameValue(def, a, b) {
  if (def.variety !== 'atomic') return a === b;
  const prim = def.primitive;
  if (prim === 'decimal') return B.compareDecimal(a, b) === 0;
  if (prim === 'float' || prim === 'double') {
    if (a === 'NaN' && b === 'NaN') return true;
    const c = B.compareValues(prim, a, b);
    return c === 0;
  }
  if (prim === 'boolean') return (a === 'true' || a === '1') === (b === 'true' || b === '1');
  if (B.isOrdered(prim)) return B.compareValues(prim, a, b) === 0 || a === b;
  return a === b;
}

/**
 * Checks `value` against the simple type `def` (or a complex type with simple content). Returns ''
 * when the value is acceptable, otherwise a short reason. `depth` guards union and list nesting.
 */
function checkValue(def0, value, depth) {
  const def = simpleOf(def0);
  if (!def) return '';
  if ((depth || 0) > 12) return '';
  const raw = String(value === undefined || value === null ? '' : value);
  const ws = def.whiteSpace || 'collapse';
  const v = B.normaliseWhiteSpace(raw, def.variety === 'atomic' ? ws : 'collapse');
  const f = def.facets || {};
  if (def.variety === 'union') {
    const members = def.memberDefs || [];
    if (members.length && !members.some(function (m) { return checkValue(m, raw, (depth || 0) + 1) === ''; })) return 'not valid for any member type of the union';
  } else if (def.variety === 'list') {
    const items = v === '' ? [] : v.split(' ');
    for (const it of items) {
      const r = def.itemDef ? checkValue(def.itemDef, it, (depth || 0) + 1) : '';
      if (r) return 'list item "' + it + '": ' + r;
    }
  } else if (def.builtinBase && def.builtinBase !== 'anySimpleType' && def.builtinBase !== 'anyAtomicType') {
    const r = B.checkLexical(def.builtinBase, v, NAMES);
    if (r) return r;
  }
  for (const level of f.patterns || []) {
    // Patterns that cannot be tested safely (nested repetition) or values above the length limit
    // are not checked here.
    const compiled = level.map(function (p) { return R.compile(p.value); });
    if (compiled.some(function (c) { return !c.ok || c.risky; }) || v.length > R.MAX_TEST_LENGTH) continue;
    if (compiled.length && !compiled.some(function (c) { return R.safeTest(c, v) === true; })) {
      return 'does not match the pattern ' + level.map(function (p) { return '"' + p.value + '"'; }).join(' or ');
    }
  }
  if (f.enumeration && f.enumeration.length) {
    if (!f.enumeration.some(function (e) { return sameValue(def, B.normaliseWhiteSpace(e.value, def.variety === 'atomic' ? ws : 'collapse'), v); })) {
      return 'not one of the allowed values (' + f.enumeration.slice(0, 8).map(function (e) { return e.value; }).join(', ') + (f.enumeration.length > 8 ? ', ...' : '') + ')';
    }
  }
  if (def.variety !== 'union' && def.primitive !== 'QName' && def.primitive !== 'NOTATION') {
    const n = lengthOf(def, v);
    if (f.length && /^[0-9]+$/.test(f.length.value) && n !== Number(f.length.value)) return 'length ' + n + ' is not ' + f.length.value;
    if (f.minLength && /^[0-9]+$/.test(f.minLength.value) && n < Number(f.minLength.value)) return 'shorter than ' + f.minLength.value;
    if (f.maxLength && /^[0-9]+$/.test(f.maxLength.value) && n > Number(f.maxLength.value)) return 'longer than ' + f.maxLength.value;
  }
  if (def.variety === 'atomic' && B.isOrdered(def.primitive)) {
    const prim = def.primitive;
    if (f.minInclusive && B.compareValues(prim, v, f.minInclusive.value) < 0) return 'below the minimum ' + f.minInclusive.value;
    if (f.minExclusive && !(B.compareValues(prim, v, f.minExclusive.value) > 0)) return 'not above ' + f.minExclusive.value;
    if (f.maxInclusive && B.compareValues(prim, v, f.maxInclusive.value) > 0) return 'above the maximum ' + f.maxInclusive.value;
    if (f.maxExclusive && !(B.compareValues(prim, v, f.maxExclusive.value) < 0)) return 'not below ' + f.maxExclusive.value;
    if (prim === 'decimal') {
      const d = B.digitsOf(v);
      if (f.totalDigits && /^[0-9]+$/.test(f.totalDigits.value) && d.total > Number(f.totalDigits.value)) return 'more than ' + f.totalDigits.value + ' digits';
      if (f.fractionDigits && /^[0-9]+$/.test(f.fractionDigits.value) && d.fraction > Number(f.fractionDigits.value)) return 'more than ' + f.fractionDigits.value + ' fraction digits';
    }
  }
  return '';
}

/**
 * Checks the own facets of a restriction against its base: applicability, the form of facet
 * values, contradictions and loosening of base facets. Returns [{ node, message }].
 */
function checkRestrictionFacets(def) {
  const out = [];
  const own = def.ownFacets;
  if (!own) return out;
  const base = def.baseDef || {};
  const bf = base.facets || {};
  const allowed = B.applicableFacets(def.variety, def.primitive);
  const all = [];
  for (const k of Object.keys(own.scalars)) all.push([k, own.scalars[k]]);
  (own.enumeration || []).forEach(function (e) { all.push(['enumeration', e]); });
  own.patterns.forEach(function (lvl) { lvl.forEach(function (p) { all.push(['pattern', p]); }); });
  for (const [name, rec] of all) {
    if (allowed.indexOf(name) === -1 && def.primitive) {
      out.push({ node: rec.node, message: 'The facet "' + name + '" does not apply to ' + describeBase(def) + '.' });
    }
  }
  const s = own.scalars;
  const nonNeg = ['length', 'minLength', 'maxLength', 'fractionDigits'];
  for (const k of nonNeg) if (s[k] && !/^\s*[0-9]+\s*$/.test(s[k].value)) out.push({ node: s[k].node, message: 'The value of "' + k + '" must be a non-negative whole number.' });
  if (s.totalDigits && !/^\s*[1-9][0-9]*\s*$/.test(s.totalDigits.value)) out.push({ node: s.totalDigits.node, message: 'The value of "totalDigits" must be a positive whole number.' });
  if (s.whiteSpace && ['preserve', 'replace', 'collapse'].indexOf(s.whiteSpace.value) === -1) out.push({ node: s.whiteSpace.node, message: 'whiteSpace must be preserve, replace or collapse.' });
  const num = function (r) { return r && /^\s*[0-9]+\s*$/.test(r.value) ? Number(r.value) : null; };
  const eff = def.facets;
  if (num(eff.minLength) !== null && num(eff.maxLength) !== null && num(eff.minLength) > num(eff.maxLength)) {
    out.push({ node: (s.minLength || s.maxLength).node, message: 'minLength (' + eff.minLength.value + ') is larger than maxLength (' + eff.maxLength.value + ').' });
  }
  if (s.length && (s.minLength || s.maxLength) && num(s.length) !== null) {
    if ((s.minLength && num(s.minLength) > num(s.length)) || (s.maxLength && num(s.maxLength) < num(s.length))) {
      out.push({ node: s.length.node, message: 'length contradicts minLength or maxLength in the same restriction.' });
    }
  }
  if (num(eff.fractionDigits) !== null && num(eff.totalDigits) !== null && num(eff.fractionDigits) > num(eff.totalDigits)) {
    out.push({ node: (s.fractionDigits || s.totalDigits).node, message: 'fractionDigits (' + eff.fractionDigits.value + ') is larger than totalDigits (' + eff.totalDigits.value + ').' });
  }
  // Loosening a facet of the base type is not allowed in a restriction.
  if (s.maxLength && num(bf.maxLength) !== null && num(s.maxLength) !== null && num(s.maxLength) > num(bf.maxLength)) out.push({ node: s.maxLength.node, message: 'maxLength ' + s.maxLength.value + ' is larger than the base type\'s maxLength ' + bf.maxLength.value + '; a restriction cannot loosen it.' });
  if (s.minLength && num(bf.minLength) !== null && num(s.minLength) !== null && num(s.minLength) < num(bf.minLength)) out.push({ node: s.minLength.node, message: 'minLength ' + s.minLength.value + ' is smaller than the base type\'s minLength ' + bf.minLength.value + '; a restriction cannot loosen it.' });
  if (s.length && num(bf.length) !== null && num(s.length) !== num(bf.length)) out.push({ node: s.length.node, message: 'length ' + s.length.value + ' differs from the base type\'s length ' + bf.length.value + '.' });
  if (s.totalDigits && num(bf.totalDigits) !== null && num(s.totalDigits) !== null && num(s.totalDigits) > num(bf.totalDigits)) out.push({ node: s.totalDigits.node, message: 'totalDigits ' + s.totalDigits.value + ' is larger than the base type\'s ' + bf.totalDigits.value + '.' });
  if (s.fractionDigits && num(bf.fractionDigits) !== null && num(s.fractionDigits) !== null && num(s.fractionDigits) > num(bf.fractionDigits)) out.push({ node: s.fractionDigits.node, message: 'fractionDigits ' + s.fractionDigits.value + ' is larger than the base type\'s ' + bf.fractionDigits.value + '.' });
  if (s.whiteSpace && base.whiteSpace) {
    const order = ['preserve', 'replace', 'collapse'];
    const mine = order.indexOf(s.whiteSpace.value);
    if (mine !== -1 && mine < order.indexOf(base.whiteSpace)) out.push({ node: s.whiteSpace.node, message: 'whiteSpace "' + s.whiteSpace.value + '" is weaker than the base type\'s "' + base.whiteSpace + '".' });
  }
  // Ordered bounds: lexical form and order.
  if (def.variety === 'atomic' && B.isOrdered(def.primitive)) {
    for (const k of ['minInclusive', 'minExclusive', 'maxInclusive', 'maxExclusive']) {
      if (!s[k]) continue;
      const r = checkValue(base, s[k].value);
      if (r && !/below|above|not above|not below/.test(r)) out.push({ node: s[k].node, message: 'The ' + k + ' value "' + s[k].value + '" is not valid for the base type: ' + r + '.' });
    }
    const lo = eff.minInclusive || eff.minExclusive;
    const hi = eff.maxInclusive || eff.maxExclusive;
    if (lo && hi) {
      const c = B.compareValues(def.primitive, lo.value, hi.value);
      const strict = !!(eff.minExclusive || eff.maxExclusive);
      if (c > 0 || (c === 0 && strict)) out.push({ node: (s.minInclusive || s.minExclusive || s.maxInclusive || s.maxExclusive || lo).node, message: 'The lower bound ' + lo.value + ' is not below the upper bound ' + hi.value + '.' });
    }
  }
  // Patterns compile.
  for (const lvl of own.patterns) {
    for (const p of lvl) {
      const c = R.compile(p.value);
      if (!c.ok && !c.unsupported) out.push({ node: p.node, message: 'The pattern "' + p.value + '" is not a valid XML Schema regular expression: ' + c.message });
    }
  }
  // Enumeration values must be valid for the base type.
  if (own.enumeration) {
    for (const e of own.enumeration) {
      const r = checkValue(base, e.value);
      if (r) out.push({ node: e.node, message: 'The enumeration value "' + e.value + '" is not valid for the base type: ' + r + '.' });
    }
  }
  return out;
}

function describeBase(def) {
  if (def.variety === 'list') return 'a list type';
  if (def.variety === 'union') return 'a union type';
  return 'a type derived from xs:' + (def.primitive || 'anySimpleType');
}

module.exports = { checkValue: checkValue, checkRestrictionFacets: checkRestrictionFacets, simpleOf: simpleOf, lengthOf: lengthOf };
