'use strict';
// Sample XML instances for a global element of a loaded schema set.
//
// Minimal mode (free): every required element once (or as often as minOccurs asks), required
// attributes, the first branch of each choice, default and fixed values, and values that satisfy
// the facets of their type. Full mode (Pro): also every optional element and attribute, repeated
// elements, a choice strategy, realistic values chosen by the names of elements and attributes
// (always checked against the facets), and a seed so that the same options give the same output.

const P = require('../xml/parser');
const B = require('../schema/builtins');
const C = require('../schema/content');
const F = require('../schema/facets');
const R = require('../schema/xsdregex');
const U = require('../util');

const XSI = B.XSI_NS;
const XSD = B.XSD_NS;
// Longest string value and largest list a sample writes; longer ones get a placeholder and a note.
const MAX_VALUE_LENGTH = 100000;
const MAX_LIST_ITEMS = 10000;

const REALISTIC = [
  [/e-?mail/i, ['anna.berg@example.com', 'tomas.novak@example.org', 'lea.moreau@example.net']],
  [/phone|mobile|fax|tel/i, ['+1 555 0100', '+1 555 0142', '+1 555 0199']],
  [/^(country|countrycode|ctry)$/i, ['PT', 'NO', 'CA', 'JP', 'Portugal', 'Norway']],
  [/currency|ccy/i, ['EUR', 'USD', 'GBP', 'JPY']],
  [/city|town/i, ['Lisbon', 'Oslo', 'Toronto', 'Kyoto']],
  [/street|address/i, ['12 Harbour Road', '4 Linden Lane', '77 Mill Street']],
  [/post(al)?code|zip/i, ['1100-148', '0150', 'M5V 2T6', '10115']],
  [/^(given|first)(name)?$/i, ['Anna', 'Tomas', 'Lea', 'Kenji']],
  [/^(family|last|sur)(name)?$/i, ['Berg', 'Novak', 'Moreau', 'Sato']],
  [/(full|display|person|contact)?name$/i, ['Anna Berg', 'Tomas Novak', 'Lea Moreau', 'Kenji Sato']],
  [/url|uri|href|homepage|website|link/i, ['https://example.com/item/1', 'https://example.org/page']],
  [/description|comment|note|remark|text|info|reason/i, ['Sample text for review', 'Delivered to the side entrance', 'Checked by the night shift']],
  [/title|headline|label|subject/i, ['Quarterly summary', 'Spring catalogue', 'Sample title']],
  [/(^|[a-z])(amount|price|total|sum|cost|fare|budget)$/i, ['125.50', '19.99', '980.00', '4.25']],
  [/(qty|quantity|count|seats|nights|minutes)$/i, ['2', '5', '12', '1']],
  [/(^id$|[a-z]Id$|Code$|^code$|Ref$|^ref$|Reference$|^reference$|Number$|^number$|^sku$|Sku$)/, ['A1024', 'B2048', 'C4096', 'ORD-1001']]
];

function prefixCandidate(set, ns) {
  for (const d of set.docs) {
    if (d.ns !== ns) continue;
    const scope = P.inScopeNamespaces(d.root);
    for (const k of Object.keys(scope)) if (k && scope[k] === ns && k !== 'xml' && k !== 'xs' && k !== 'xsd') return k;
  }
  return '';
}

class Builder {
  constructor(set, options) {
    const o = options || {};
    this.set = set;
    this.full = o.mode === 'full';
    this.repeat = Math.max(1, Math.min(10, Number(o.repeat) || 1));
    this.choice = o.choice || 'first';
    this.picks = o.picks || {};
    this.realistic = !!o.realistic;
    this.rng = o.seed !== undefined && o.seed !== null && o.seed !== '' ? R.seeded(Number(o.seed) || 1) : null;
    this.maxDepth = Math.max(2, Math.min(30, Number(o.maxDepth) || (this.full ? 10 : 14)));
    this.prefixes = new Map();
    this.notes = [];
    this.ids = 0;
    this.used = new Map();
    this.avoid = null;
    this.rotation = new Map();
    this.typeStack = [];
    this.needXsi = false;
    this.elementCount = 0;
    this.maxElements = Math.max(100, Math.min(200000, Number(o.maxElements) || 20000));
    this.idValues = new Set();
    this.idrefs = [];
  }

  /** Adds a note for every ID reference that names no ID value of the sample. */
  checkIdrefs() {
    for (const r of this.idrefs) {
      if (this.idValues.has(r.value)) continue;
      this.note('The value of "' + r.name + '" refers to an ID (xs:IDREF), but the sample holds no element or attribute with that ID; replace it with an ID of your document.');
    }
  }

  note(text) { if (this.notes.indexOf(text) === -1 && this.notes.length < 50) this.notes.push(text); }

  prefix(ns) {
    if (!ns) return '';
    if (ns === XSI) { this.needXsi = true; return 'xsi:'; }
    if (ns === P.XML_NS) return 'xml:';
    if (!this.prefixes.has(ns)) {
      let p = prefixCandidate(this.set, ns);
      const used = new Set(Array.from(this.prefixes.values()).concat(['xsi', 'xml', 'xmlns']));
      if (!p || used.has(p)) { let i = 1; while (used.has('ns' + i)) i++; p = 'ns' + i; }
      this.prefixes.set(ns, p);
    }
    return this.prefixes.get(ns) + ':';
  }

  pick(list) {
    if (!list.length) return undefined;
    return this.rng ? list[Math.floor(this.rng() * list.length) % list.length] : list[0];
  }

  // ---- values -----------------------------------------------------------------------------------

  value(def0, name, facts) {
    const f = facts || {};
    if (f.fixed !== undefined) return f.fixed;
    if (f.default !== undefined) return f.default;
    const def = F.simpleOf(def0);
    if (!def) return '';
    // Repeated elements and attributes get different values where the type allows it, so that
    // key and unique constraints over them hold.
    const k = name || '?';
    const idref = isIdref(def);
    if (!this.used.has(k)) this.used.set(k, new Set());
    // References to IDs may repeat; every other repeated value is kept different where possible.
    this.avoid = idref ? null : this.used.get(k);
    let v = this.valueFor(def, name || '', 0);
    this.avoid = null;
    if (v === null) v = this.valueFor(def, name || '', 0);
    if (v !== null) this.used.get(k).add(v);
    if (v === null) {
      this.note('No value could be built for "' + (name || '?') + '" that satisfies all facets of its type; the sample holds a placeholder there.');
      return 'value';
    }
    if (isId(def)) this.idValues.add(v);
    if (idref) for (const item of v.split(/\s+/)) if (item) this.idrefs.push({ value: item, name: name || '?' });
    return v;
  }

  // A QName or NOTATION value of an enumeration, written with a prefix this document declares.
  qnameValue(e) {
    const text = String(e.value || '').trim();
    const m = /^(?:([^:\s]+):)?([^:\s]+)$/.exec(text);
    if (!m) return null;
    const scope = e.node ? P.inScopeNamespaces(e.node) : {};
    const ns = m[1] ? scope[m[1]] : (scope[''] || '');
    if (m[1] && ns === undefined) return m[1] === 'xml' ? 'xml:' + m[2] : null;
    return (ns ? this.prefix(ns) : '') + m[2];
  }

  valueFor(def, name, depth) {
    if (depth > 8) return null;
    const avoid = depth === 0 ? this.avoid : null;
    const ok = function (v) { return v !== null && v !== undefined && !(avoid && avoid.has(v)) && F.checkValue(def, v) === ''; };
    const f = def.facets || {};
    if (f.enumeration && f.enumeration.length && (def.primitive === 'QName' || def.primitive === 'NOTATION') && def.variety !== 'list' && def.variety !== 'union') {
      // The prefixes of these values belong to the schema; the sample declares its own.
      const self = this;
      const mapped = f.enumeration.map(function (e) { return self.qnameValue(e); }).filter(function (v) { return v !== null; });
      const fresh = mapped.filter(function (v) { return !(avoid && avoid.has(v)); });
      return fresh.length ? (this.rng ? this.pick(fresh) : fresh[0]) : null;
    }
    if (f.enumeration && f.enumeration.length) {
      const vals = f.enumeration.map(function (e) { return e.value; });
      const order = this.rng ? [this.pick(vals)].concat(vals) : vals;
      for (const v of order) if (ok(v)) return v;
      return null;
    }
    if (def.variety === 'list') {
      const n = f.length ? Number(f.length.value) : Math.max(1, f.minLength ? Number(f.minLength.value) : 1, this.full && this.rng ? 2 : 1);
      const max = f.maxLength ? Number(f.maxLength.value) : Infinity;
      const count = Math.min(n, max);
      if (count > MAX_LIST_ITEMS) {
        this.note('The type of "' + (name || '?') + '" asks for ' + count + ' list items; the sample stops at ' + MAX_LIST_ITEMS + ' and holds a placeholder there instead.');
        return null;
      }
      const items = [];
      for (let i = 0; i < count; i++) {
        const it = def.itemDef ? this.valueFor(def.itemDef, name, depth + 1) : 'item';
        if (it === null) return null;
        items.push(it);
      }
      const v = items.join(' ');
      return ok(v) ? v : null;
    }
    if (def.variety === 'union') {
      for (const m of def.memberDefs || []) {
        const v = this.valueFor(m, name, depth + 1);
        if (ok(v)) return v;
      }
      return null;
    }
    // Realistic values by name, when they satisfy every facet (not for IDs and references to
    // them, which must match each other).
    const idLike = isId(def) || isIdref(def);
    if (this.realistic && name && !idLike) {
      for (const [re, vals] of REALISTIC) {
        if (!re.test(name)) continue;
        for (const v of this.rng ? [this.pick(vals)].concat(vals) : vals) if (ok(v)) return v;
      }
    }
    // Then patterns: they are the strictest constraint.
    if (f.patterns && f.patterns.length) {
      const levels = f.patterns;
      for (let grow = 0; grow < 8; grow++) {
        for (const p of levels[levels.length - 1]) {
          for (let s = 0; s < 3; s++) {
            const rng = this.rng ? R.seeded(Math.floor(this.rng() * 1e9) + s) : (s === 0 ? null : R.seeded(s * 7919 + grow));
            const v = R.sampleFor(p.value, rng, grow);
            if (ok(v)) return v;
          }
        }
      }
    }
    // A pattern that is not tested (see facets.js) must still be met: only values built from the
    // pattern itself are used then.
    const untested = (f.patterns || []).some(function (lvl) { return lvl.some(function (p) { const c = R.compile(p.value); return !c.ok || c.risky; }); });
    if (untested) return null;
    for (const v of this.candidates(def, name)) if (ok(v)) return v;
    return null;
  }

  candidates(def, name) {
    const out = [];
    const prim = def.primitive;
    const bi = def.builtinBase || 'string';
    const f = def.facets || {};
    if (this.realistic && name && !isId(def) && !isIdref(def)) {
      for (const [re, vals] of REALISTIC) if (re.test(name)) out.push.apply(out, this.rng ? [this.pick(vals)].concat(vals) : vals);
    }
    const lengths = lengthTargets(f);
    switch (prim) {
      case 'string': {
        if (bi === 'language') out.push('en', 'en-GB', 'de');
        else if (B.derivesFrom(bi, 'ID')) { this.ids += 1; out.push('id' + this.ids); }
        else if (B.derivesFrom(bi, 'IDREF')) { out.push.apply(out, Array.from(this.idValues)); out.push('id' + (this.ids + 1)); }
        else if (B.derivesFrom(bi, 'NCName') || B.derivesFrom(bi, 'Name')) out.push(nameish(name) || 'sample', 'sample');
        else if (bi === 'NMTOKEN') out.push('sample');
        else out.push(this.realistic && name ? 'Sample ' + name : 'text', 'text', 'sample');
        for (const n of lengths) out.push(sized('x', n), sized('A', n), sized('1', n));
        break;
      }
      case 'boolean': out.push('true', 'false', '1', '0'); break;
      case 'decimal': numericCandidates(def, out, B.derivesFrom(bi, 'integer')); break;
      case 'float': case 'double': numericCandidates(def, out, false); out.push('1.5E2', 'INF', '-INF'); break;
      case 'duration':
        if (bi === 'yearMonthDuration') out.push('P1M', 'P1Y', 'P3M', 'P2Y');
        else if (bi === 'dayTimeDuration') out.push('P1D', 'PT1H', 'PT30M', 'P7D');
        else out.push('P1D', 'PT1H', 'PT30M', 'P1M', 'P7D', 'P1Y', 'PT1S');
        boundCandidates(f, out);
        break;
      case 'dateTime': out.push('2026-01-15T09:30:00Z', '2026-06-01T12:00:00Z'); boundCandidates(f, out, 'dateTime'); break;
      case 'date': out.push('2026-01-15', '2026-06-01'); boundCandidates(f, out, 'date'); break;
      case 'time': out.push('09:30:00', '12:00:00', '00:00:00'); boundCandidates(f, out); break;
      case 'gYearMonth': out.push('2026-01'); boundCandidates(f, out); break;
      case 'gYear': out.push('2026'); boundCandidates(f, out); break;
      case 'gMonthDay': out.push('--01-15'); boundCandidates(f, out); break;
      case 'gDay': out.push('---15'); boundCandidates(f, out); break;
      case 'gMonth': out.push('--01'); boundCandidates(f, out); break;
      case 'hexBinary': out.push('0A1B2C3D'); for (const n of lengths) out.push('0A'.repeat(n)); break;
      case 'base64Binary': out.push('U2FtcGxl'); for (const n of lengths) out.push(Buffer.from('x'.repeat(n)).toString('base64')); break;
      case 'anyURI': out.push('https://example.com/resource', 'urn:example:item'); for (const n of lengths) out.push(sized('a', n)); break;
      case 'QName': {
        const first = Array.from(this.prefixes.values())[0];
        out.push(first ? first + ':sample' : 'sample');
        break;
      }
      case 'NOTATION': {
        const n = this.set.all('notation')[0];
        if (n) out.push(this.prefix(n.ns) + n.name);
        break;
      }
      default: out.push('text', 'sample');
    }
    return out;
  }

  // ---- structure --------------------------------------------------------------------------------

  concreteElement(particle) {
    if (!particle.abstract || !particle.global) return particle;
    const seen = new Set();
    const queue = this.set.membersOf(particle.global.key).slice();
    while (queue.length) {
      const m = queue.shift();
      if (seen.has(m.key)) continue;
      seen.add(m.key);
      const mp = C.elementOfComp(this.set, m);
      if (!mp.abstract) return Object.assign({}, mp, { min: particle.min, max: particle.max });
      queue.push.apply(queue, this.set.membersOf(m.key));
    }
    this.note('The element "' + particle.name + '" is abstract and has no concrete substitute in the loaded schemas.');
    return null;
  }

  concreteType(def) {
    if (!def.abstract || def.category !== 'complex') return { def: def, xsiType: null };
    for (const c of this.set.all('type')) {
      if (c.kind !== 'complexType') continue;
      const d = C.defOfComp(this.set, c);
      if (d.abstract) continue;
      if (C.baseChain(d).indexOf(def) !== -1) return { def: d, xsiType: c };
    }
    this.note('The type "' + (def.name || '?') + '" is abstract and no concrete type derived from it is loaded.');
    return { def: def, xsiType: null };
  }

  element(particle0, depth, out, indent) {
    if (!particle0.name || !P.isNCName(particle0.name) || particle0.unresolved) {
      this.note('An element reference could not be resolved (' + (particle0.name || 'no name') + '); a comment marks its place.');
      out.push(indent + '<!-- unresolved element ' + U.escapeXml(particle0.name || '').replace(/--/g, '- -') + ' -->');
      return;
    }
    const particle = this.concreteElement(particle0);
    if (!particle) { out.push(indent + '<!-- abstract element ' + U.escapeXml(particle0.name) + ' -->'); return; }
    if (++this.elementCount > this.maxElements) {
      if (this.elementCount === this.maxElements + 1) this.note('The sample was cut off after ' + this.maxElements + ' elements.');
      return;
    }
    const qname = this.prefix(particle.ns) + particle.name;
    if (particle.decl && C.xsKids(particle.decl).some(function (k) { return k.local === 'keyref'; })) {
      this.note('The element "' + particle.name + '" has key references (xs:keyref); the sample does not try to make referring values match their keys, so check those values.');
    }
    const ct = this.concreteType(C.elementType(this.set, particle));
    const def = ct.def;
    const attrs = [];
    if (ct.xsiType) attrs.push(' xsi:type="' + this.prefix(ct.xsiType.ns) + ct.xsiType.name + '"'), this.needXsi = true;
    if (def.category === 'complex' && def.attributes) {
      for (const a of def.attributes.values()) {
        if (a.use === 'prohibited' || !P.isNCName(a.name || '')) continue;
        const required = a.use === 'required';
        if (!required && !this.full && a.fixed === undefined) continue;
        if (!required && !this.full) continue;
        const adef = C.attributeType(this.set, a);
        const v = this.value(adef, a.name, { fixed: a.fixed, default: this.full ? a.default : undefined });
        attrs.push(' ' + (a.ns ? this.prefix(a.ns) : '') + a.name + '="' + U.escapeXml(v) + '"');
      }
    }
    const head = indent + '<' + qname + attrs.join('');
    const isSimple = def.category === 'simple' || def.contentKind === 'simple';
    if (isSimple) {
      const v = this.value(def, particle.name, { fixed: particle.fixed, default: particle.default });
      out.push(head + (v === '' ? '/>' : '>' + U.escapeXml(v) + '</' + qname + '>'));
      return;
    }
    if (def.builtin === 'anyType' || def.contentKind === 'empty' || !def.particle) {
      out.push(head + '/>');
      return;
    }
    if (depth >= this.maxDepth) {
      out.push(head + '/>');
      this.note('Nesting stopped at depth ' + this.maxDepth + ' (at "' + particle.name + '"); deeper content is left out.');
      return;
    }
    this.typeStack.push(def);
    const inner = [];
    this.particle(def.particle, depth + 1, inner, indent + '  ', particle.name);
    this.typeStack.pop();
    if (!inner.length) out.push(head + '/>');
    else {
      out.push(head + '>');
      out.push.apply(out, inner);
      out.push(indent + '</' + qname + '>');
    }
  }

  recursive(particle) {
    const def = C.elementType(this.set, particle);
    return this.typeStack.filter(function (d) { return d === def; }).length >= (this.full ? 1 : 2);
  }

  count(p) {
    if (this.full) {
      const want = p.max > 1 ? this.repeat : 1;
      return Math.max(p.min, Math.min(p.max, want));
    }
    return p.min;
  }

  particle(p, depth, out, indent, path) {
    if (!p) return;
    if (p.p === 'element') {
      let n = this.count(p);
      if (n > p.min && this.recursive(p)) n = p.min;
      for (let i = 0; i < n; i++) this.element(p, depth, out, indent);
      return;
    }
    if (p.p === 'any') {
      const n = this.full ? Math.min(p.max, Math.max(p.min, 0)) : p.min;
      for (let i = 0; i < n; i++) this.wildcard(p, depth, out, indent);
      return;
    }
    const reps = this.full ? Math.max(1, p.min) : p.min;
    for (let r = 0; r < Math.min(reps, p.max); r++) {
      if (p.p === 'choice') {
        if (!p.items.length) continue;
        const idx = this.branch(p, path);
        this.particle(p.items[idx], depth, out, indent, path);
      } else {
        for (const it of p.items) this.particle(it, depth, out, indent, path);
      }
    }
  }

  branch(p, path) {
    const key = choiceKey(p, path);
    if (Object.prototype.hasOwnProperty.call(this.picks, key)) {
      const k = Number(this.picks[key]);
      if (k >= 0 && k < p.items.length) return k;
    }
    let idx = 0;
    if (this.full && this.choice === 'rotate') {
      const seen = this.rotation.get(p) || 0;
      this.rotation.set(p, seen + 1);
      idx = seen % p.items.length;
    } else if (this.full && this.choice === 'random' && this.rng) {
      idx = Math.floor(this.rng() * p.items.length) % p.items.length;
    }
    // Avoid a branch that would recurse into a type already being written.
    for (let k = 0; k < p.items.length; k++) {
      const cand = p.items[(idx + k) % p.items.length];
      if (cand.p !== 'element' || !this.recursive(cand)) return (idx + k) % p.items.length;
    }
    return idx;
  }

  wildcard(p, depth, out, indent) {
    const ns = p.namespace || '##any';
    const tokens = ns.split(/\s+/);
    const own = p.doc ? p.doc.ns : '';
    const allowsOther = tokens.indexOf('##any') !== -1 || tokens.indexOf('##other') !== -1;
    if (allowsOther && p.processContents !== 'strict') {
      const extNs = 'urn:example:extension';
      out.push(indent + '<' + this.prefix(extNs) + 'extra/>');
      return;
    }
    const set = this.set;
    const candidates = set.all('element').filter(function (c) {
      if (tokens.indexOf('##any') !== -1) return true;
      if (tokens.indexOf('##other') !== -1) return c.ns !== own && c.ns !== '';
      if (tokens.indexOf('##targetNamespace') !== -1 && c.ns === own) return true;
      if (tokens.indexOf('##local') !== -1 && c.ns === '') return true;
      return tokens.indexOf(c.ns) !== -1;
    }).map(function (c) { return C.elementOfComp(set, c); }).filter(function (e) { return e && !e.abstract; });
    // An element whose type is being written already would repeat itself without end: prefer one
    // that is not, and go no deeper than an element particle would.
    const self = this;
    const chosen = candidates.find(function (e) { return self.typeStack.indexOf(C.elementType(set, e)) === -1; });
    if (chosen && depth < this.maxDepth) { this.element(chosen, depth, out, indent); return; }
    if (candidates.length) this.note('A wildcard (xs:any) asks for an element here, and every element it allows would repeat the element that contains it; a comment marks the place.');
    else this.note('A wildcard (xs:any) requires an element that the loaded schemas do not provide; a comment marks the place.');
    out.push(indent + '<!-- an element allowed by the wildcard goes here -->');
  }
}

function choiceKey(p, path) {
  const n = p.node;
  return (path || '') + '#' + (n ? n.start : 0);
}

function nameish(name) {
  const s = String(name || '').replace(/[^A-Za-z0-9_.-]/g, '');
  return /^[A-Za-z_]/.test(s) ? s : '';
}

function sized(ch, n) { return n > 0 && n < MAX_VALUE_LENGTH ? ch.repeat(n) : ''; }

function isId(def) { return !!def && def.variety !== 'list' && B.derivesFrom(def.builtinBase || '', 'ID'); }
function isIdref(def) {
  if (!def) return false;
  if (def.variety === 'list') return !!def.itemDef && isIdref(def.itemDef);
  return B.derivesFrom(def.builtinBase || '', 'IDREF') || B.derivesFrom(def.builtinBase || '', 'IDREFS');
}

function lengthTargets(f) {
  const out = [];
  if (f.length) out.push(Number(f.length.value));
  if (f.minLength) out.push(Math.max(Number(f.minLength.value), 1));
  if (f.maxLength) out.push(Math.max(1, Math.min(Number(f.maxLength.value), 8)), Number(f.maxLength.value));
  return out.filter(function (n) { return isFinite(n) && n >= 0; });
}

function numericCandidates(def, out, integer) {
  const f = def.facets || {};
  const implicit = B.boundsOf(def.builtinBase || 'decimal');
  let lo = -Infinity;
  let hi = Infinity;
  let loEx = false;
  let hiEx = false;
  if (f.minInclusive) lo = Number(f.minInclusive.value);
  if (f.minExclusive) { lo = Number(f.minExclusive.value); loEx = true; }
  if (f.maxInclusive) hi = Number(f.maxInclusive.value);
  if (f.maxExclusive) { hi = Number(f.maxExclusive.value); hiEx = true; }
  if (implicit.min !== undefined && Number(implicit.min) > lo) { lo = Number(implicit.min); loEx = false; }
  if (implicit.max !== undefined && Number(implicit.max) < hi) { hi = Number(implicit.max); hiEx = false; }
  const fd = f.fractionDigits ? Number(f.fractionDigits.value) : integer ? 0 : 2;
  const fmt = function (x) {
    if (!isFinite(x)) return null;
    if (integer || fd === 0) return String(Math.round(x));
    const s = x.toFixed(Math.min(fd, 2));
    return s;
  };
  const step = integer || fd === 0 ? 1 : Math.pow(10, -Math.min(fd, 2));
  const pref = integer ? [1, 10, 5, 0, 42, 100, 2] : [10.5, 1, 1.25, 0, 99.99, 0.5];
  for (const x of pref) out.push(fmt(x));
  if (isFinite(lo)) { out.push(fmt(loEx ? lo + step : lo), fmt(lo + 1), fmt(Math.ceil(lo + step))); }
  if (isFinite(hi)) { out.push(fmt(hiEx ? hi - step : hi), fmt(hi - 1), fmt(Math.floor(hi - step))); }
  if (isFinite(lo) && isFinite(hi)) out.push(fmt((lo + hi) / 2), fmt(Math.floor((lo + hi) / 2)));
  if (f.minInclusive) out.push(f.minInclusive.value);
  if (f.maxInclusive) out.push(f.maxInclusive.value);
  if (implicit.min !== undefined) out.push(implicit.min);
  if (implicit.max !== undefined) out.push(implicit.max);
  for (let i = out.length - 1; i >= 0; i--) if (out[i] === null) out.splice(i, 1);
}

function boundCandidates(f, out, prim) {
  for (const k of ['minInclusive', 'maxInclusive']) if (f[k]) out.push(f[k].value);
  for (const k of ['minExclusive', 'maxExclusive']) {
    if (!f[k]) continue;
    const v = f[k].value;
    const sign = k === 'minExclusive' ? 1 : -1;
    if (prim === 'date') {
      const d = new Date(v.slice(0, 10) + 'T00:00:00Z');
      if (!isNaN(d)) { d.setUTCDate(d.getUTCDate() + sign); out.push(d.toISOString().slice(0, 10) + v.slice(10)); }
    } else if (prim === 'dateTime') {
      const d = new Date(v.replace(/Z$/, '') + 'Z');
      if (!isNaN(d)) { d.setUTCSeconds(d.getUTCSeconds() + sign); out.push(d.toISOString().replace(/\.000Z$/, 'Z')); }
    }
  }
}

/**
 * Builds a sample instance for the global element component `comp`. Options: mode ('minimal' or
 * 'full'), repeat (1-10), choice ('first', 'rotate', 'random'), picks ({ choiceKey: index }),
 * realistic (boolean), seed (number), maxDepth, maxElements. Returns { text, notes, root }.
 */
function buildSample(set, comp, options) {
  const r = sampleForParticle(set, C.elementOfComp(set, comp), options, '');
  if (!r.text) return { text: '', notes: r.notes, root: comp.name };
  return { text: '<?xml version="1.0" encoding="UTF-8"?>\n' + r.text + '\n', notes: r.notes, root: comp.name, elements: r.elements };
}

/**
 * Builds the sample of one element particle (a global element, or a stand-in such as a WSDL part
 * with a type), as an XML fragment whose first element declares the namespaces it uses. `indent`
 * is prepended to every line. Returns { text, notes, elements }.
 */
function sampleForParticle(set, particle, options, indent) {
  const b = new Builder(set, options);
  const lines = [];
  if (!particle || !particle.name || !P.isNCName(particle.name)) {
    return { text: '', notes: ['The element has no valid name, so no sample can be built for it. Check the problems of the schema.'], elements: 0 };
  }
  if (particle.ns) b.prefix(particle.ns);
  try {
    b.element(particle, 0, lines, indent || '');
  } catch (err) {
    // A schema shape the builder does not handle must never surface as an internal error text.
    if (!(err instanceof RangeError)) throw err;
    return { text: '', notes: ['No sample could be built for "' + particle.name + '": its content refers to itself in a way the sample builder cannot resolve. Please report it with "XSD Atlas: Report A Problem".'], elements: 0 };
  }
  b.checkIdrefs();
  if (!lines.length || /^\s*<!--/.test(lines[0])) return { text: '', notes: b.notes, elements: 0 };
  // Namespace declarations go on the root element.
  const decls = [];
  for (const [ns, pre] of b.prefixes) decls.push(' xmlns:' + pre + '="' + U.escapeXml(ns) + '"');
  if (b.needXsi) decls.push(' xmlns:xsi="' + XSI + '"');
  const first = lines[0];
  const m = /^\s*<(?![!?])[^\s/>]+/.exec(first);
  if (m) lines[0] = m[0] + decls.join('') + first.slice(m[0].length);
  return { text: lines.join('\n'), notes: b.notes, elements: b.elementCount };
}

/** The choices of the content below a global element, for "pick each choice": [{ key, label, options }]. */
function listChoices(set, comp, maxDepth) {
  const out = [];
  const seenTypes = new Set();
  function walk(p, path, depth) {
    if (!p || depth > (maxDepth || 6) || out.length > 40) return;
    if (p.p === 'element') {
      const def = C.elementType(set, p);
      if (def.category === 'complex' && def.particle && !seenTypes.has(def)) {
        seenTypes.add(def);
        walk(def.particle, p.name, depth + 1);
        seenTypes.delete(def);
      }
      return;
    }
    if (p.p === 'any') return;
    if (p.p === 'choice' && p.items.length > 1) {
      out.push({
        key: choiceKey(p, path), label: 'choice in ' + path,
        options: p.items.map(function (it) { return it.p === 'element' ? it.name : it.p === 'any' ? 'any element' : it.p + ' (' + C.flattenElements(it).map(function (e) { return e.particle.name || '*'; }).slice(0, 4).join(', ') + ')'; })
      });
    }
    for (const it of p.items) walk(it, path, depth);
  }
  const root = C.elementOfComp(set, comp);
  const def = C.elementType(set, root);
  if (def.category === 'complex' && def.particle) walk(def.particle, comp.name, 0);
  return out;
}

module.exports = { buildSample: buildSample, sampleForParticle: sampleForParticle, listChoices: listChoices, XSD: XSD };
