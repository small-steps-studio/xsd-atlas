'use strict';
// Schema diff: compares two loaded schema sets component by component and classifies every change.
//
// The rule behind the classes (documented in docs/diff-rules.md):
//   BREAKING      a document that is valid under the old version can be invalid under the new
//                 version, or the same document is read differently (a changed default value), or
//                 another schema that builds on this one can stop working (a removed global
//                 component, a type that no longer derives from its old base).
//   NON-BREAKING  every document valid under the old version stays valid and means the same;
//                 the new version accepts more (an added optional element, a widened facet).
//   DOCUMENTATION only annotations, the version attribute or other text without effect on documents.
// Content is compared in its effective form (groups expanded, extension content appended), so
// moving declarations between a type and a group is not reported as a change.

const P = require('../xml/parser');
const B = require('../schema/builtins');
const S = require('../schema/set');
const C = require('../schema/content');
const U = require('../util');
const INC = require('./inclusion');

const BREAKING = 'BREAKING';
const NON = 'NON-BREAKING';
const DOC = 'DOCUMENTATION';
const MAX_DEPTH = 24;

/** Codes and their class; the documentation lists every code with an example. */
const RULES = {
  'namespace-changed': BREAKING, 'element-form-changed': BREAKING, 'attribute-form-changed': BREAKING, 'version-changed': DOC,
  'import-added': NON, 'import-removed': NON,
  'component-removed': BREAKING, 'component-added': NON, 'constraint-added': BREAKING, 'constraint-removed': NON,
  'type-changed': BREAKING, 'type-widened': NON, 'type-kind-changed': BREAKING, 'type-inlined': NON, 'type-named': NON,
  'base-type-changed': BREAKING, 'base-widened': NON, 'variety-changed': BREAKING, 'content-type-changed': BREAKING,
  'child-removed': BREAKING, 'child-added-required': BREAKING, 'child-added-optional': NON, 'child-added-conditional': BREAKING,
  'child-covered-by-wildcard': NON, 'attribute-covered-by-wildcard': NON, 'content-narrowed': BREAKING, 'content-reorganised': NON,
  'became-required': BREAKING, 'became-optional': NON, 'became-required-in-group': BREAKING, 'became-optional-in-group': NON,
  'group-became-required': BREAKING, 'group-became-optional': NON, 'group-min-increased': BREAKING, 'content-not-verified': BREAKING, 'occurrence-min-increased': BREAKING, 'occurrence-min-decreased': NON,
  'occurrence-max-decreased': BREAKING, 'occurrence-max-increased': NON, 'moved-into-choice': BREAKING, 'moved-out-of-choice': NON,
  'order-changed': BREAKING, 'compositor-changed': BREAKING, 'compositor-relaxed': NON,
  'attribute-removed': BREAKING, 'attribute-added-required': BREAKING, 'attribute-added-optional': NON,
  'attribute-became-required': BREAKING, 'attribute-became-optional': NON,
  'facet-added': BREAKING, 'facet-removed': NON, 'facet-narrowed': BREAKING, 'facet-widened': NON, 'facet-changed': BREAKING,
  'pattern-changed': BREAKING, 'enumeration-removed': BREAKING, 'enumeration-added': NON, 'enumeration-dropped': NON,
  'list-item-changed': BREAKING, 'union-member-removed': BREAKING, 'union-member-added': NON, 'union-order-changed': NON,
  'default-changed': BREAKING, 'default-removed': BREAKING, 'default-added': NON,
  'fixed-added': BREAKING, 'fixed-removed': NON, 'fixed-changed': BREAKING,
  'nillable-removed': BREAKING, 'nillable-added': NON, 'abstract-added': BREAKING, 'abstract-removed': NON,
  'mixed-removed': BREAKING, 'mixed-added': NON, 'wildcard-added': NON, 'wildcard-added-required': BREAKING, 'wildcard-removed': BREAKING,
  'wildcard-narrowed': BREAKING, 'wildcard-widened': NON, 'any-attribute-added': NON, 'any-attribute-removed': BREAKING,
  'substitution-group-added': NON, 'substitution-group-removed': BREAKING, 'substitution-group-changed': BREAKING,
  'block-added': BREAKING, 'block-removed': NON, 'final-added': BREAKING, 'final-removed': NON,
  'documentation-changed': DOC, 'documentation-added': DOC, 'documentation-removed': DOC
};

const SPACE_LABEL = { type: 'type', element: 'element', attribute: 'attribute', group: 'group', attributeGroup: 'attribute group', notation: 'notation', identity: 'constraint' };

// Codes about the names, order and number of child elements. Whether such a change can break a
// document is decided by the exact comparison of the two child-element patterns (./inclusion.js).
const STRUCTURAL = new Set(['child-removed', 'child-added-required', 'child-added-conditional', 'became-required', 'became-required-in-group',
  'group-became-required', 'group-min-increased', 'occurrence-min-increased', 'occurrence-max-decreased', 'moved-into-choice', 'order-changed', 'compositor-changed',
  'wildcard-removed', 'wildcard-added-required']);

class Ctx {
  constructor(oldSet, newSet, nsMap) {
    this.o = oldSet;
    this.n = newSet;
    this.nsMap = nsMap || new Map();
    this.changes = [];
    this.byKey = new Map();
    this.keyOf = new Map();
    this.frames = new Map();
    this.cleared = new Map();
    this.pairs = new Set();
    // The child-pattern comparison in progress: collects its structural changes.
    this.frame = null;
  }
  mapNs(ns) { return this.nsMap.has(ns) ? this.nsMap.get(ns) : ns; }
  /** The namespace of the old version that was mapped to `ns` of the new version. */
  unmapNs(ns) {
    for (const [a, b] of this.nsMap) if (b === ns) return a;
    return this.nsMap.has(ns) ? '\u0000unmapped' : ns;
  }
  add(code, component, path, message, before, after, oldNode, newNode, flags) {
    const severity = RULES[code];
    const k = component + '|' + path + '|' + code + '|' + (before === undefined ? '' : before) + '|' + (after === undefined ? '' : after);
    let change = this.byKey.get(k);
    if (!change) {
      change = {
        severity: severity, code: code, component: component, path: path || '', message: message,
        before: before === undefined ? '' : String(before), after: after === undefined ? '' : String(after),
        oldLoc: loc(oldNode), newLoc: loc(newNode)
      };
      this.changes.push(change);
      this.byKey.set(k, change);
      this.keyOf.set(change, k);
    }
    // The change also belongs to the child pattern being compared when it was reported before
    // (a change inside a group that several types use is listed once). A change that rests on
    // more than the order and number of child elements (a declaration replaced by a wildcard that
    // checks against another declaration) is never taken back by the child-pattern comparison.
    if (this.frame && CONTENT_CODES.has(code) && this.frame.all.indexOf(change) === -1) {
      this.frame.all.push(change);
      this.frames.set(change, (this.frames.get(change) || 0) + 1);
      if (STRUCTURAL.has(code) || (flags && flags.structural)) this.frame.list.push({ change: change, fixed: !!(flags && flags.fixed) });
    }
    return change;
  }
  /** Number of child-pattern comparisons that reported the change. */
  sharedBy(change) { return this.frames.get(change) || 0; }
  remove(change) {
    const i = this.changes.indexOf(change);
    if (i !== -1) this.changes.splice(i, 1);
    this.byKey.delete(this.keyOf.get(change));
    this.keyOf.delete(change);
    this.frames.delete(change);
    this.cleared.delete(change);
  }
}

function loc(x) {
  if (!x || !x.node || !x.doc) return null;
  return { uri: x.doc.uri, line: x.doc.lines.positionAt(x.node.start).line + 1, offset: x.node.start };
}

function compLabel(comp) {
  const kind = comp.kind === 'complexType' ? 'complexType' : comp.kind === 'simpleType' ? 'simpleType' : comp.kind;
  return kind + ' ' + comp.name;
}

function docText(doc, node) { return U.collapse(C.documentation(doc, node)); }

function compareDocs(ctx, label, path, o, n) {
  const a = o && o.node ? docText(o.doc, o.node) : '';
  const b = n && n.node ? docText(n.doc, n.node) : '';
  if (a === b) return;
  if (!a) ctx.add('documentation-added', label, path, 'Documentation was added.', '', U.shorten(b, 120), o, n);
  else if (!b) ctx.add('documentation-removed', label, path, 'Documentation was removed.', U.shorten(a, 120), '', o, n);
  else ctx.add('documentation-changed', label, path, 'Documentation text changed.', U.shorten(a, 120), U.shorten(b, 120), o, n);
}

function tokens(v) { return String(v || '').trim().split(/\s+/).filter(Boolean); }

function compareTokens(ctx, label, path, what, a, b, o, n) {
  const x = new Set(tokens(a).map(function (t) { return t === '#all' ? 'extension restriction substitution list union' : t; }).join(' ').split(' ').filter(Boolean));
  const y = new Set(tokens(b).map(function (t) { return t === '#all' ? 'extension restriction substitution list union' : t; }).join(' ').split(' ').filter(Boolean));
  const added = Array.from(y).filter(function (t) { return !x.has(t); });
  const removed = Array.from(x).filter(function (t) { return !y.has(t); });
  if (added.length) ctx.add(what + '-added', label, path, what + ' now blocks ' + added.join(', ') + '.', tokens(a).join(' '), tokens(b).join(' '), o, n);
  else if (removed.length) ctx.add(what + '-removed', label, path, what + ' no longer blocks ' + removed.join(', ') + '.', tokens(a).join(' '), tokens(b).join(' '), o, n);
}

// ---- type references ----------------------------------------------------------------------------

function typeNameOf(set, holder) {
  // { ns, local } of the named type of an element particle or attribute use; null when inline.
  if (!holder || holder.typeNode) return null;
  if (holder.typeValue === null || holder.typeValue === undefined) {
    if (holder.unresolved) return null;
    return { ns: B.XSD_NS, local: holder.p === 'element' ? 'anyType' : 'anySimpleType', implicit: true };
  }
  const r = set.resolveQName(holder.declDoc, holder.decl, holder.typeValue);
  return r.error ? null : { ns: r.ns, local: r.local };
}

function qText(q) { return q ? (q.ns === B.XSD_NS ? 'xs:' : q.ns ? '{' + q.ns + '}' : '') + q.local : '(inline type)'; }

/** Compares the type of two declarations (element particles or attribute uses). */
function compareDeclaredType(ctx, label, path, o, n, oDef, nDef, depth) {
  const qo = typeNameOf(ctx.o, o);
  const qn = typeNameOf(ctx.n, n);
  if (qo && qn) {
    const same = ctx.mapNs(qo.ns) === qn.ns && qo.local === qn.local;
    if (same) return;
    if (qo.ns === B.XSD_NS && qn.ns === B.XSD_NS && B.isBuiltin(qo.local) && B.isBuiltin(qn.local) && B.derivesFrom(qo.local, qn.local)) {
      ctx.add('type-widened', label, path, 'The type was widened from ' + qText(qo) + ' to ' + qText(qn) + '; every old value is still valid.', qText(qo), qText(qn), o, n);
      return;
    }
    // A new named type that derives from the old one by restriction narrows; anything else is a change.
    ctx.add('type-changed', label, path, 'The type changed from ' + qText(qo) + ' to ' + qText(qn) + '.', qText(qo), qText(qn), o, n);
    return;
  }
  if (!qo && !qn) {
    compareTypes(ctx, label, path, oDef, nDef, depth + 1);
    return;
  }
  ctx.add(qo ? 'type-inlined' : 'type-named', label, path, qo ? 'The named type ' + qText(qo) + ' was replaced by an inline type; the content is compared below.' : 'The inline type was replaced by the named type ' + qText(qn) + '; the content is compared below.', qText(qo), qText(qn), o, n);
  compareTypes(ctx, label, path, oDef, nDef, depth + 1);
}

// ---- simple types -------------------------------------------------------------------------------

function num(rec) { return rec && /^\s*[0-9]+\s*$/.test(rec.value) ? Number(rec.value) : null; }

function compareSimple(ctx, label, path, o, n, depth) {
  if (!o || !n || depth > MAX_DEPTH) return;
  if (o.variety !== n.variety) {
    ctx.add('variety-changed', label, path, 'The simple type changed from ' + o.variety + ' to ' + n.variety + '.', o.variety, n.variety, o, n);
    return;
  }
  if (o.variety === 'atomic' && (o.builtinBase || '') !== (n.builtinBase || '')) {
    const a = o.builtinBase || 'anySimpleType';
    const b = n.builtinBase || 'anySimpleType';
    if (B.derivesFrom(a, b)) ctx.add('base-widened', label, path, 'The built-in base type was widened from xs:' + a + ' to xs:' + b + '.', 'xs:' + a, 'xs:' + b, o, n);
    else ctx.add('base-type-changed', label, path, 'The built-in base type changed from xs:' + a + ' to xs:' + b + '.', 'xs:' + a, 'xs:' + b, o, n);
  }
  if (o.variety === 'list') {
    const qo = o.itemDef && !o.itemDef.anonymous ? qText({ ns: o.itemDef.ns, local: o.itemDef.builtin || o.itemDef.name }) : null;
    const qn = n.itemDef && !n.itemDef.anonymous ? qText({ ns: n.itemDef.ns, local: n.itemDef.builtin || n.itemDef.name }) : null;
    if (qo && qn && qo !== qn && !(o.itemDef.ns && ctx.mapNs(o.itemDef.ns) === n.itemDef.ns && o.itemDef.name === n.itemDef.name)) {
      ctx.add('list-item-changed', label, path, 'The list item type changed from ' + qo + ' to ' + qn + '.', qo, qn, o, n);
    } else if (!qo && !qn) compareSimple(ctx, label, path + (path ? '/' : '') + '(list item)', o.itemDef, n.itemDef, depth + 1);
  }
  if (o.variety === 'union') {
    const names = function (d, map) {
      return (d.memberDefs || []).map(function (m) { return m.anonymous ? '(inline)' : (map ? map(m.ns) : m.ns) + '|' + (m.builtin || m.name); });
    };
    const a = names(o, ctx.mapNs.bind(ctx));
    const b = names(n, null);
    for (const x of a) if (x !== '(inline)' && b.indexOf(x) === -1) ctx.add('union-member-removed', label, path, 'The union no longer has the member type ' + x.split('|')[1] + '.', x.split('|')[1], '', o, n);
    for (const x of b) if (x !== '(inline)' && a.indexOf(x) === -1) ctx.add('union-member-added', label, path, 'The union has the new member type ' + x.split('|')[1] + '.', '', x.split('|')[1], o, n);
    const ca = a.filter(function (x) { return x !== '(inline)' && b.indexOf(x) !== -1; });
    const cb = b.filter(function (x) { return x !== '(inline)' && a.indexOf(x) !== -1; });
    if (ca.join(',') !== cb.join(',')) ctx.add('union-order-changed', label, path, 'The order of the union members changed (the first matching member decides the value\'s type).', ca.join(' '), cb.join(' '), o, n);
    // Inline member types have no name: they are paired by position and compared one by one.
    const io = (o.memberDefs || []).filter(function (m) { return m.anonymous; });
    const inn = (n.memberDefs || []).filter(function (m) { return m.anonymous; });
    for (let i = 0; i < Math.min(io.length, inn.length); i++) compareSimple(ctx, label, path + (path ? '/' : '') + '(inline member ' + (i + 1) + ')', io[i], inn[i], depth + 1);
    if (io.length > inn.length) ctx.add('union-member-removed', label, path, 'The union has ' + (io.length - inn.length) + ' inline member type' + (io.length - inn.length === 1 ? '' : 's') + ' fewer; values that only they accepted become invalid.', io.length + ' inline', inn.length + ' inline', o, n);
    else if (inn.length > io.length) ctx.add('union-member-added', label, path, 'The union has ' + (inn.length - io.length) + ' more inline member type' + (inn.length - io.length === 1 ? '' : 's') + '.', io.length + ' inline', inn.length + ' inline', o, n);
  }
  compareFacets(ctx, label, path, o, n);
}

// Primitive types whose enumeration values are compared as text (their value is the text, up to
// white space); every other primitive is compared by value.
const TEXT_PRIMITIVES = ['string', 'anyURI', 'QName', 'NOTATION'];

function sameEnumValue(prim, x, y) {
  if (x === y) return true;
  if (!prim || TEXT_PRIMITIVES.indexOf(prim) !== -1) return false;
  const a = String(x).trim();
  const b = String(y).trim();
  if (a === b) return true;
  if (prim === 'boolean') return (a === 'true' || a === '1') === (b === 'true' || b === '1') && /^(true|false|1|0)$/.test(a) && /^(true|false|1|0)$/.test(b);
  if (prim === 'hexBinary') return a.toUpperCase() === b.toUpperCase();
  const c = B.compareValues(prim, a, b);
  return c === 0;
}

function compareFacets(ctx, label, path, o, n) {
  const fo = o.facets || {};
  const fn = n.facets || {};
  // Enumerations.
  const eo = fo.enumeration ? fo.enumeration.map(function (e) { return e.value; }) : null;
  const en = fn.enumeration ? fn.enumeration.map(function (e) { return e.value; }) : null;
  if (eo && !en) ctx.add('enumeration-dropped', label, path, 'The list of allowed values was removed; any value of the base type is accepted now.', eo.join(', '), '', o, n);
  else if (!eo && en) ctx.add('facet-added', label, path, 'A list of allowed values was added: ' + U.shorten(en.join(', '), 120) + '.', '', en.join(', '), o, n);
  else if (eo && en) {
    // Values of numeric, date, time and similar types are compared as values (1.0 = 1.00).
    const prim0 = n.primitive || o.primitive;
    const same = function (x, y) { return sameEnumValue(prim0, x, y); };
    const has = function (list, v) { return list.some(function (x) { return same(x, v); }); };
    for (const v of eo) if (!has(en, v)) ctx.add('enumeration-removed', label, path, 'The allowed value "' + v + '" was removed.', v, '', o, n);
    for (const v of en) if (!has(eo, v)) ctx.add('enumeration-added', label, path, 'The allowed value "' + v + '" was added.', '', v, o, n);
    // Documentation of individual values.
    for (const e of fn.enumeration) {
      const old = fo.enumeration.find(function (x) { return same(x.value, e.value); });
      if (old) compareDocs(ctx, label, path + (path ? '/' : '') + '"' + e.value + '"', { doc: old.doc, node: old.node }, { doc: e.doc, node: e.node });
    }
  }
  // Patterns.
  const po = [].concat.apply([], (fo.patterns || []).map(function (l) { return l.map(function (p) { return p.value; }); }));
  const pn = [].concat.apply([], (fn.patterns || []).map(function (l) { return l.map(function (p) { return p.value; }); }));
  const newP = pn.filter(function (p) { return po.indexOf(p) === -1; });
  const goneP = po.filter(function (p) { return pn.indexOf(p) === -1; });
  if (newP.length && !po.length) ctx.add('facet-added', label, path, 'A pattern was added: ' + newP.join(' | ') + '.', '', newP.join(' | '), o, n);
  else if (newP.length) ctx.add('pattern-changed', label, path, 'The pattern changed; values that matched the old pattern may not match the new one.', po.join(' | '), pn.join(' | '), o, n);
  else if (goneP.length) ctx.add('facet-removed', label, path, 'A pattern was removed: ' + goneP.join(' | ') + '.', goneP.join(' | '), pn.join(' | '), o, n);
  // Lengths and digits: "max" facets narrow when they get smaller, "min" facets when they get larger.
  const pairs = [['length', 'exact'], ['minLength', 'min'], ['maxLength', 'max'], ['totalDigits', 'max'], ['fractionDigits', 'max']];
  // length N on one side and minLength/maxLength on the other: length N is minLength N plus
  // maxLength N, so the two are compared in that form (equal ranges report nothing).
  const lf = function (f, other) {
    if (!f.length || other.length || !(other.minLength || other.maxLength)) return f;
    return Object.assign({}, f, { length: undefined, minLength: f.length, maxLength: f.length });
  };
  const lo = lf(fo, fn);
  const ln = lf(fn, fo);
  for (const [k, sense] of pairs) {
    const a = lo[k];
    const b = ln[k];
    if (!a && !b) continue;
    if (a && !b) { ctx.add('facet-removed', label, path, k + ' (' + a.value + ') was removed.', a.value, '', o, n); continue; }
    if (!a && b) {
      if (k === 'minLength' && num(b) === 0) continue;
      ctx.add('facet-added', label, path, k + ' ' + b.value + ' was added.', '', b.value, o, n);
      continue;
    }
    const x = num(a);
    const y = num(b);
    if (x === y) continue;
    if (sense === 'exact' || x === null || y === null) ctx.add('facet-changed', label, path, k + ' changed from ' + a.value + ' to ' + b.value + '.', a.value, b.value, o, n);
    else if ((sense === 'max' && y < x) || (sense === 'min' && y > x)) ctx.add('facet-narrowed', label, path, k + ' narrowed from ' + a.value + ' to ' + b.value + '.', a.value, b.value, o, n);
    else ctx.add('facet-widened', label, path, k + ' widened from ' + a.value + ' to ' + b.value + '.', a.value, b.value, o, n);
  }
  // Bounds.
  const prim = n.primitive || o.primitive;
  for (const side of ['lower', 'upper']) {
    const inc = side === 'lower' ? 'minInclusive' : 'maxInclusive';
    const exc = side === 'lower' ? 'minExclusive' : 'maxExclusive';
    const a = fo[inc] ? { v: fo[inc].value, ex: false, name: inc } : fo[exc] ? { v: fo[exc].value, ex: true, name: exc } : null;
    const b = fn[inc] ? { v: fn[inc].value, ex: false, name: inc } : fn[exc] ? { v: fn[exc].value, ex: true, name: exc } : null;
    if (!a && !b) continue;
    const text = function (x) { return x ? x.name + ' ' + x.v : ''; };
    if (a && !b) { ctx.add('facet-removed', label, path, 'The ' + side + ' bound (' + text(a) + ') was removed.', text(a), '', o, n); continue; }
    if (!a && b) { ctx.add('facet-added', label, path, 'A ' + side + ' bound (' + text(b) + ') was added.', '', text(b), o, n); continue; }
    const c = B.compareValues(prim, b.v, a.v);
    if (isNaN(c)) { if (text(a) !== text(b)) ctx.add('facet-changed', label, path, 'The ' + side + ' bound changed.', text(a), text(b), o, n); continue; }
    let narrower;
    if (c === 0) { if (a.ex === b.ex) continue; narrower = b.ex && !a.ex; }
    else narrower = side === 'lower' ? c > 0 : c < 0;
    ctx.add(narrower ? 'facet-narrowed' : 'facet-widened', label, path, 'The ' + side + ' bound changed from ' + text(a) + ' to ' + text(b) + '.', text(a), text(b), o, n);
  }
  const wa = o.whiteSpace || '';
  const wb = n.whiteSpace || '';
  if (wa && wb && wa !== wb && o.variety === 'atomic' && o.builtinBase === n.builtinBase) ctx.add('facet-changed', label, path, 'whiteSpace changed from ' + wa + ' to ' + wb + '.', wa, wb, o, n);
  const aa = (fo.assertions || []).map(function (x) { return x.value; }).join(' && ');
  const ab = (fn.assertions || []).map(function (x) { return x.value; }).join(' && ');
  if (aa !== ab) ctx.add(ab && !aa ? 'facet-added' : !ab ? 'facet-removed' : 'facet-changed', label, path, 'The assertions changed.', aa, ab, o, n);
}

// ---- complex types ------------------------------------------------------------------------------

function compareTypes(ctx, label, path, o, n, depth) {
  if (!o || !n || depth > MAX_DEPTH) return;
  const pairKey = label + '|' + path;
  if (ctx.pairs.has(pairKey)) return;
  ctx.pairs.add(pairKey);
  if (o.category !== n.category) {
    ctx.add('type-kind-changed', label, path, 'The type changed from ' + o.category + ' to ' + n.category + '.', o.category, n.category, o, n);
    return;
  }
  if (o.category === 'simple') { compareSimple(ctx, label, path, o, n, depth); return; }
  if (!o.abstract && n.abstract) ctx.add('abstract-added', label, path, 'The type became abstract; documents must use a derived type with xsi:type.', 'false', 'true', o, n);
  if (o.abstract && !n.abstract) ctx.add('abstract-removed', label, path, 'The type is no longer abstract.', 'true', 'false', o, n);
  if (!o.anonymous || !n.anonymous) {
    compareTokens(ctx, label, path, 'block', o.block, n.block, o, n);
    compareTokens(ctx, label, path, 'final', o.final, n.final, o, n);
  }
  if (o.mixed && !n.mixed) ctx.add('mixed-removed', label, path, 'Text between the child elements is no longer allowed (mixed was turned off).', 'mixed', 'element-only', o, n);
  if (!o.mixed && n.mixed && o.contentKind !== 'simple') ctx.add('mixed-added', label, path, 'Text between the child elements is now allowed (mixed content).', 'element-only', 'mixed', o, n);
  // Base type: does the new type still derive from the old base?
  if (o.baseDef && n.baseDef && o.baseDef.name && !o.baseDef.builtin) {
    const oldBase = ctx.mapNs(o.baseDef.ns) + '|' + o.baseDef.name;
    const chain = C.baseChain(n).map(function (d) { return d.ns + '|' + (d.builtin || d.name); });
    if (chain.indexOf(oldBase) === -1) ctx.add('base-type-changed', label, path, 'The type no longer derives from ' + o.baseDef.name + ' (xsi:type and substitution that rely on it stop working).', o.baseDef.name, n.baseDef.builtin ? 'xs:' + n.baseDef.builtin : n.baseDef.name || '(inline)', o, n);
  }
  const ko = o.contentKind;
  const kn = n.contentKind;
  if (ko === 'simple' || kn === 'simple') {
    if (ko !== kn) ctx.add('content-type-changed', label, path, 'The content changed from ' + ko + ' to ' + kn + '.', ko, kn, o, n);
    else compareSimpleContent(ctx, label, path, o, n, depth);
  } else if ((ko === 'empty') !== (kn === 'empty') && !(ko === 'empty' && kn !== 'empty' && allOptional(n.particle))) {
    ctx.add('content-type-changed', label, path, 'The content changed from ' + ko + ' to ' + kn + '.', ko, kn, o, n);
  } else {
    compareParticles(ctx, label, path, o.particle, n.particle, depth, o, n);
  }
  compareAttributes(ctx, label, path, o.attributes || new Map(), n.attributes || new Map(), depth, o, n);
  compareAnyAttribute(ctx, label, path, o.anyAttribute, n.anyAttribute, o, n);
}

function allOptional(p) {
  return C.flattenElements(p).every(function (e) { return effective(e).min === 0; });
}

function compareSimpleContent(ctx, label, path, o, n, depth) {
  const so = o.simpleDef;
  const sn = n.simpleDef;
  if (!so || !sn) return;
  if (!so.anonymous && !sn.anonymous && !so.synthetic && !sn.synthetic) {
    const a = { ns: so.ns, local: so.builtin || so.name };
    const b = { ns: sn.ns, local: sn.builtin || sn.name };
    if (!(ctx.mapNs(a.ns) === b.ns && a.local === b.local)) {
      if (so.builtin && sn.builtin && B.derivesFrom(so.builtin, sn.builtin)) ctx.add('type-widened', label, path, 'The text type was widened from xs:' + so.builtin + ' to xs:' + sn.builtin + '.', qText(a), qText(b), o, n);
      else ctx.add('type-changed', label, path, 'The text type changed from ' + qText(a) + ' to ' + qText(b) + '.', qText(a), qText(b), o, n);
    }
    return;
  }
  compareSimple(ctx, label, path, so, sn, depth + 1);
}

function compareAnyAttribute(ctx, label, path, a, b, o, n) {
  if (!a && !b) return;
  const holder = { doc: o.doc, node: o.node };
  const holderN = { doc: n.doc, node: n.node };
  if (!a && b) { ctx.add('any-attribute-added', label, path, 'Any attribute (' + b.namespace + ') is now allowed.', '', b.namespace, holder, holderN); return; }
  if (a && !b) { ctx.add('any-attribute-removed', label, path, 'Attributes from the wildcard (' + a.namespace + ') are no longer allowed.', a.namespace, '', holder, holderN); return; }
  compareWildcard(ctx, label, path + (path ? '/' : '') + '@*', a, b, holder, holderN);
}

const PC_ORDER = { skip: 0, lax: 1, strict: 2 };

function compareWildcard(ctx, label, path, a, b, o, n) {
  if (a.namespace !== b.namespace) {
    const wider = b.namespace === '##any' || (a.namespace !== '##any' && tokens(a.namespace).every(function (t) { return tokens(b.namespace).indexOf(t) !== -1; }));
    // Which elements a wildcard admits is part of the exact content comparison, so a namespace
    // change inside a child pattern is settled there (a processContents change is not).
    ctx.add(wider ? 'wildcard-widened' : 'wildcard-narrowed', label, path, 'The namespaces allowed by the wildcard changed.', a.namespace, b.namespace, o, n, { structural: true });
  }
  if (a.processContents !== b.processContents) {
    const stricter = PC_ORDER[b.processContents] > PC_ORDER[a.processContents];
    ctx.add(stricter ? 'wildcard-narrowed' : 'wildcard-widened', label, path, 'processContents changed from ' + a.processContents + ' to ' + b.processContents + '.', a.processContents, b.processContents, o, n);
  }
}

// ---- particles ----------------------------------------------------------------------------------

function effective(entry) {
  const p = entry.particle;
  let min = p.min;
  let max = p.max;
  for (const c of entry.path) {
    if (c.p === 'choice' && c.items.length > 1) min = 0;
    min *= c.min;
    // 0 times unbounded is 0 (a multiplication would give NaN).
    max = max === 0 || c.max === 0 ? 0 : max * c.max;
  }
  return { min: min, max: max, exclusive: entry.path.some(function (c) { return c.p === 'choice' && c.items.length > 1; }), inAll: entry.path.some(function (c) { return c.p === 'all'; }) };
}

/**
 * The requirement of a leaf inside the nearest group that may be left out: `min` is the leaf's own
 * minimum multiplied by the minimums of the enclosing compositors up to, but not including, the
 * nearest one that is a choice with more than one option or has minOccurs 0 (the guard). `unit`
 * is the part that is used or left out as a whole: the choice branch that holds the leaf, or the
 * optional compositor. A leaf with `min` > 0 must be present whenever its unit is used.
 */
function localRequirement(entry) {
  const p = entry.particle;
  const path = entry.path;
  let lm = p.min;
  for (let i = path.length - 1; i >= 0; i--) {
    const c = path[i];
    if (c.p === 'choice' && c.items.length > 1) return { min: lm, guard: c, unit: i + 1 < path.length ? path[i + 1] : p };
    if (c.min === 0) return { min: lm, guard: c, unit: c };
    lm *= c.min;
  }
  return { min: lm, guard: null, unit: null };
}

/** True when a particle can be satisfied by no content at all. */
function emptiable(p) {
  if (!p) return true;
  if (p.min === 0) return true;
  if (p.p === 'element' || p.p === 'any') return false;
  if (p.p === 'choice') return !p.items.length || p.items.some(emptiable);
  return p.items.every(emptiable);
}

function leafKey(ctx, side, p) {
  if (p.p === 'any') return 'any';
  return '{' + (side === 'old' ? ctx.mapNs(p.ns || '') : p.ns || '') + '}' + p.name;
}

function flatten(ctx, side, particle) {
  const counts = new Map();
  return C.flattenElements(particle).map(function (e, index) {
    const base = leafKey(ctx, side, e.particle);
    const k = (counts.get(base) || 0) + 1;
    counts.set(base, k);
    const eff = effective(e);
    const group = e.path.slice().reverse().find(function (c) { return c.groupRef; });
    return { key: base + '#' + k, base: base, index: index, name: e.particle.p === 'any' ? '*' : e.particle.name, leaf: e.particle, eff: eff, local: localRequirement(e), group: group ? group.groupRef : null, path: e.path };
  });
}

/** Every compositor of a flattened particle with the keys of the leaves below it. */
function compositorsOf(list) {
  const out = new Map();
  for (const x of list) {
    for (const c of x.path) {
      if (!out.has(c)) out.set(c, { node: c, keys: new Set(), leaves: [] });
      out.get(c).keys.add(x.key);
      out.get(c).leaves.push(x);
    }
  }
  return out;
}

/** Pairs old and new compositors of the same kind by the leaves they hold (best overlap first). */
function matchCompositors(O, N) {
  const co = Array.from(compositorsOf(O).values());
  const cn = Array.from(compositorsOf(N).values());
  const candidates = [];
  for (const a of co) {
    for (const b of cn) {
      if (a.node.p !== b.node.p) continue;
      let common = 0;
      for (const k of a.keys) if (b.keys.has(k)) common++;
      if (!common) continue;
      candidates.push({ a: a, b: b, score: common / (a.keys.size + b.keys.size - common) });
    }
  }
  candidates.sort(function (x, y) { return y.score - x.score; });
  const pairs = new Map();
  const usedNew = new Set();
  for (const c of candidates) {
    if (pairs.has(c.a.node) || usedNew.has(c.b.node)) continue;
    pairs.set(c.a.node, c.b.node);
    usedNew.add(c.b.node);
  }
  return { pairs: pairs, old: new Map(co.map(function (x) { return [x.node, x]; })), new: new Map(cn.map(function (x) { return [x.node, x]; })) };
}

/** The leaves (other than `self`) that lie in `unit` (a compositor or the leaf itself). */
function leavesInUnit(list, unit, self) {
  if (!unit || unit === self.leaf) return [];
  return list.filter(function (x) { return x !== self && x.path.indexOf(unit) !== -1; });
}

/** The target namespace of the schema document that declares a wildcard. */
function wildcardNs(w, holder) {
  if (w && w.doc && typeof w.doc.ns === 'string') return w.doc.ns;
  if (holder && holder.doc && typeof holder.doc.ns === 'string') return holder.doc.ns;
  return holder && typeof holder.ns === 'string' ? holder.ns : '';
}

/** True when the wildcard particle `w` admits an element or attribute in namespace `ns`. */
function wildcardAdmits(w, ns, ownNs) {
  const t = tokens(w.namespace || '##any');
  if (t.indexOf('##any') !== -1) return true;
  if (t.indexOf('##other') !== -1) return ns !== '' && ns !== ownNs;
  if (ns === '' && t.indexOf('##local') !== -1) return true;
  if (ns === ownNs && t.indexOf('##targetNamespace') !== -1) return true;
  return t.indexOf(ns) !== -1;
}

// The component that declares a leaf (a named group or a named base type), for attributing a change once.
function ownerOf(leaf, entry, fallbackLabel, fallbackPath, childName) {
  if (entry.group) return { label: 'group ' + entry.group.name, path: childName };
  const origin = leaf.origin;
  if (origin && origin.name && origin.category === 'complex' && !origin.anonymous && fallbackLabel.indexOf('complexType ' + origin.name) !== 0) {
    return { label: 'complexType ' + origin.name, path: childName };
  }
  return { label: fallbackLabel, path: (fallbackPath ? fallbackPath + '/' : '') + childName };
}

function holderOf(leaf) { return { doc: leaf.doc, node: leaf.node }; }

/**
 * Compares two child-element patterns. The element-by-element comparison below describes each change;
 * the exact comparison of the two child-element patterns (./inclusion.js) then decides whether the
 * content can break a document: when it finds child content that the old version accepts and the
 * new one refuses while no change above says so, a `content-narrowed` change with that content as
 * an example is added; when it proves that the new version accepts every child sequence of the
 * old one, changes above that claim otherwise are taken back.
 */
function compareParticles(ctx, label, path, op, np, depth, oDef, nDef) {
  if (!op && !np) return;
  const outer = ctx.frame;
  const frame = { list: [], all: [] };
  ctx.frame = frame;
  try {
    compareParticleDetails(ctx, label, path, op, np, depth, oDef, nDef);
  } finally {
    ctx.frame = outer;
  }
  settleStructure(ctx, label, path, op, np, frame, oDef, nDef);
}

// Content codes of the particle comparison (structural ones and their NON-BREAKING mirrors).
const CONTENT_CODES = new Set(Array.from(STRUCTURAL).concat(['child-added-optional', 'child-covered-by-wildcard', 'became-optional', 'became-optional-in-group',
  'group-became-optional', 'occurrence-min-decreased', 'occurrence-max-increased', 'moved-out-of-choice', 'compositor-relaxed', 'wildcard-added',
  'wildcard-narrowed', 'wildcard-widened']));

// Work allowed for the exact content comparisons of one diff run (each one is also limited).
const INCLUSION_BUDGET = 6000000;
// Time allowed for the exact checks of one diff run, and for each one of them. When it is used up,
// the content is reported as not verified (content-not-verified, BREAKING) when it changed; the
// editor is never held for long by one comparison, and a timeout never removes a report.
const INCLUSION_MS = 3000;
const INCLUSION_MS_EACH = 150;

function settleStructure(ctx, label, path, op, np, frame, oDef, nDef) {
  const verdict = contentVerdict(ctx, op, np, nDef);
  const holder = function (p, def) { return p && p.node ? { doc: p.doc, node: p.node } : def && def.node ? { doc: def.doc, node: def.node } : null; };
  if (verdict.status === 'narrowed') {
    // The changes listed for this content already say that it breaks documents.
    if (frame.all.some(function (c) { return c.severity === BREAKING; })) return;
    const w = verdict.witness;
    const show = function (s) { return s.plain ? s.label : '"' + s.label + '"'; };
    const example = !w.length ? 'an element without any child elements'
      : w.length === 1 ? 'content that consists of the child element ' + show(w[0]) + ' alone'
        : 'content that consists of the child elements ' + w.map(show).join(', ') + ' in this order';
    ctx.add('content-narrowed', label, path, 'The new version refuses child content that the old version accepts, for example ' + example + '; documents with such content become invalid.',
      w.length ? w.map(function (s) { return s.label; }).join(', ') : '(no child elements)', '', holder(op, oDef), holder(np, nDef));
    return;
  }
  if (verdict.status === 'unknown') {
    // The exact check could not decide (too large, or out of time). It must never reduce what is
    // reported: a content that changed in any way, and for which no change above already says
    // BREAKING, is reported as breaking because it could not be verified.
    if (frame.all.some(function (c) { return c.severity === BREAKING; })) return;
    if (patternSignature(ctx, 'old', op) === patternSignature(ctx, 'new', np)) return;
    ctx.add('content-not-verified', label, path, 'The child elements of this content changed, and the change could not be checked completely (the content is too large or the time for the check ran out). It is treated as breaking; test your documents against the new version.',
      '', '', holder(op, oDef), holder(np, nDef));
    return;
  }
  if (verdict.status !== 'included' && verdict.status !== 'equal') return;
  // Proven: every child sequence of the old version is still accepted. A structural BREAKING
  // change is taken back once every content comparison that reported it has proven this (a
  // change inside a group is reported by the group and by each type that uses it).
  const takenBack = [];
  for (const x of frame.list) {
    if (x.change.severity !== BREAKING || x.fixed) continue;
    const cleared = (ctx.cleared.get(x.change) || 0) + 1;
    ctx.cleared.set(x.change, cleared);
    if (cleared >= ctx.sharedBy(x.change)) takenBack.push(x);
  }
  if (!takenBack.length) return;
  for (const x of takenBack) ctx.remove(x.change);
  if (frame.all.some(function (c) { return ctx.keyOf.has(c); })) return;
  ctx.add('content-reorganised', label, path, 'The content was rearranged; every sequence of child elements that the old version accepts is still accepted.', '', '', holder(op, oDef), holder(np, nDef));
}

/**
 * A text that is the same for two child-element patterns exactly when they are written the same
 * way: compositors, names, wildcards and occurrence ranges (old names mapped to the new namespace).
 */
function patternSignature(ctx, side, p) {
  if (!p) return '';
  const min = p.min === undefined ? 1 : p.min;
  const max = p.max === undefined ? 1 : p.max;
  if (max === 0) return '';
  let body;
  if (p.p === 'element') body = 'E{' + (side === 'old' ? ctx.mapNs(p.ns || '') : p.ns || '') + '}' + p.name;
  else if (p.p === 'any') {
    const list = function (v) { return tokens(v || '').map(function (x) { return side === 'old' && x.indexOf('##') !== 0 ? ctx.mapNs(x) : x; }).sort().join(' '); };
    body = 'W[' + list(p.namespace || '##any') + '|' + list(p.notNamespace) + '|' + (p.processContents || 'strict') + ']';
  } else body = p.p + '(' + (p.items || []).map(function (x) { return patternSignature(ctx, side, x); }).filter(Boolean).join(',') + ')';
  return body + '{' + min + ',' + max + '}';
}

/** The exact comparison of two child-element patterns; { status, witness } of ./inclusion.js. */
function contentVerdict(ctx, op, np, nDef) {
  const left = INCLUSION_BUDGET - (ctx.inclusionSteps || 0);
  if (left <= 0) return { status: 'unknown', witness: [] };
  const timeLeft = INCLUSION_MS - (ctx.inclusionMs || 0);
  if (timeLeft <= 0) return { status: 'unknown', witness: [] };
  const started = Date.now();
  const ownNs = nDef && typeof nDef.ns === 'string' ? nDef.ns : '';
  const nameLabel = function (ns, local) { return ns === ownNs || ns === '' ? local : local + ' (namespace ' + ns + ')'; };
  const mapToken = function (side, t) { return side === 'old' && t.indexOf('##') !== 0 ? ctx.mapNs(t) : t; };
  const wildcards = [];
  const leafOf = function (side, p) {
    if (p.p === 'element') {
      const ns = side === 'old' ? ctx.mapNs(p.ns || '') : (p.ns || '');
      const local = p.name || '';
      return { key: 'E{' + ns + '}' + local, symbol: { ns: ns, local: local, label: nameLabel(ns, local) }, test: function (s) { return s.ns === ns && s.local === local; } };
    }
    wildcards.push({ side: side, p: p });
    const set = side === 'old' ? ctx.o : ctx.n;
    const own = side === 'old' ? ctx.mapNs(wildcardNs(p, null)) : wildcardNs(p, null);
    const list = tokens(p.namespace || '##any').map(function (t) { return mapToken(side, t); });
    const not = tokens(p.notNamespace || '').map(function (t) { return mapToken(side, t); });
    const pc = p.processContents || 'strict';
    return {
      key: 'W' + side + '|' + list.join(' ') + '|' + not.join(' ') + '|' + own + '|' + pc,
      test: function (s) {
        if (!wildcardAdmits({ namespace: list.join(' ') }, s.ns, own)) return false;
        if (not.indexOf(s.ns) !== -1 || (s.ns === own && not.indexOf('##targetNamespace') !== -1) || (s.ns === '' && not.indexOf('##local') !== -1)) return false;
        // A strict wildcard admits only elements that have a global declaration.
        if (pc === 'strict') return !!set.lookup('element', side === 'old' ? ctx.unmapNs(s.ns) : s.ns, s.local);
        return true;
      }
    };
  };
  const symbols = function () {
    const out = [];
    if (!wildcards.length) return out;
    const spaces = new Set(['', '\u0000other', ownNs]);
    for (const x of wildcards) {
      spaces.add(x.side === 'old' ? ctx.mapNs(wildcardNs(x.p, null)) : wildcardNs(x.p, null));
      for (const t of tokens(x.p.namespace || '').concat(tokens(x.p.notNamespace || ''))) if (t.indexOf('##') !== 0) spaces.add(mapToken(x.side, t));
    }
    for (const ns of spaces) {
      out.push({ ns: ns, local: '\u0000any', plain: true, label: ns === '\u0000other' ? 'an undeclared element of another namespace' : ns === '' ? 'an undeclared element without a namespace' : 'an undeclared element of the namespace ' + ns });
    }
    for (const x of wildcards) {
      if ((x.p.processContents || 'strict') !== 'strict') continue;
      const set = x.side === 'old' ? ctx.o : ctx.n;
      for (const c of set.all('element').slice(0, 3000)) {
        const ns = x.side === 'old' ? ctx.mapNs(c.ns || '') : c.ns || '';
        out.push({ ns: ns, local: c.name, label: nameLabel(ns, c.name) });
      }
    }
    return out;
  };
  const r = INC.compareContent(op, np, { leafOf: leafOf, symbols: symbols, maxSteps: Math.min(300000, left), maxMillis: Math.min(INCLUSION_MS_EACH, timeLeft) });
  ctx.inclusionSteps = (ctx.inclusionSteps || 0) + (r.steps || 0);
  ctx.inclusionMs = (ctx.inclusionMs || 0) + (Date.now() - started);
  return r;
}

function compareParticleDetails(ctx, label, path, op, np, depth, oDef, nDef) {
  const O = op ? flatten(ctx, 'old', op) : [];
  const N = np ? flatten(ctx, 'new', np) : [];
  const nByKey = new Map(N.map(function (x) { return [x.key, x]; }));
  const oByKey = new Map(O.map(function (x) { return [x.key, x]; }));
  if (op && np && !op.synthetic && !np.synthetic && op.p !== np.p && (O.length > 1 || N.length > 1)) {
    const relaxed = op.p === 'sequence' && np.p === 'all';
    ctx.add(relaxed ? 'compositor-relaxed' : 'compositor-changed', label, path, 'The content changed from xs:' + op.p + ' to xs:' + np.p + (relaxed ? '; the old order is still accepted.' : '.'), op.p, np.p, { doc: op.doc, node: op.node }, { doc: np.doc, node: np.node });
  }
  // Declarations of the same name that follow each other (a maxOccurs="2" written as two
  // declarations, for example) are compared by their total occurrence range first: when that
  // range is unchanged, so are the documents they accept.
  const sameRange = sameRanges(O, N);
  const minUp = new Set();
  const minDown = new Set();
  const ownNs = nDef && nDef.ns !== undefined ? nDef.ns : (np && np.doc ? np.doc.ns : '');
  for (const x of O) {
    if (nByKey.has(x.key) || sameRange.has(x.base)) continue;
    const own = ownerOf(x.leaf, x, label, path, x.name);
    if (x.leaf.p === 'any') { ctx.add('wildcard-removed', own.label, own.path, 'The wildcard (any element) was removed.', x.leaf.namespace, '', holderOf(x.leaf), null); continue; }
    const cover = coveringWildcard(ctx, O, N, oByKey, nByKey, x, ownNs);
    if (cover && cover.exact) {
      ctx.add('child-covered-by-wildcard', own.label, own.path, 'The declaration of "' + x.name + '" was replaced by a wildcard at the same place that still admits it (processContents ' + cover.leaf.processContents + '); ' +
        (cover.leaf.processContents === 'skip' ? 'its content is no longer checked.' : 'its content is checked against the same global declaration as before.'), U.occursText(x.eff.min, x.eff.max), cover.leaf.namespace, holderOf(x.leaf), holderOf(cover.leaf));
      continue;
    }
    minDown.add(x.key);
    if (cover) {
      // The wildcard admits the name, but the element is now checked against its global
      // declaration instead of the old one, which can refuse content the old one accepted.
      ctx.add('child-removed', own.label, own.path, 'The declaration of "' + x.name + '" was replaced by a wildcard (processContents ' + cover.leaf.processContents + ') that checks the element against its global declaration; content that only the old declaration accepted becomes invalid.',
        U.occursText(x.eff.min, x.eff.max), cover.leaf.namespace, holderOf(x.leaf), holderOf(cover.leaf), { fixed: true });
      continue;
    }
    ctx.add('child-removed', own.label, own.path, 'The element "' + x.name + '" was removed; documents that contain it become invalid.', U.occursText(x.eff.min, x.eff.max), '', holderOf(x.leaf), null);
  }
  for (const y of N) {
    if (oByKey.has(y.key) || sameRange.has(y.base)) continue;
    const own = ownerOf(y.leaf, y, label, path, y.name);
    if (y.leaf.p === 'any') { ctx.add(y.eff.min > 0 ? 'wildcard-added-required' : 'wildcard-added', own.label, own.path, 'A wildcard (any element, ' + y.leaf.namespace + ') was added' + (y.eff.min > 0 ? ' and is required.' : '.'), '', y.leaf.namespace, null, holderOf(y.leaf)); continue; }
    if (y.eff.min > 0) {
      minUp.add(y.key);
      ctx.add('child-added-required', own.label, own.path, 'The required element "' + y.name + '" was added; documents without it become invalid.', '', U.occursText(y.eff.min, y.eff.max), null, holderOf(y.leaf));
    } else if (y.local.min > 0 && leavesInUnit(N, y.local.unit, y).some(function (z) { return oByKey.has(z.key); })) {
      // Required whenever its optional group or its choice branch is used, and that group or
      // branch existed before: old documents that use it without the new element become invalid.
      minUp.add(y.key);
      ctx.add('child-added-conditional', own.label, own.path, 'The element "' + y.name + '" was added as required whenever its ' + unitWord(y.local) + ' is used; documents that use the ' + unitWord(y.local) + ' without it become invalid.', '', U.occursText(y.local.min, y.eff.max) + ' in its ' + unitWord(y.local), null, holderOf(y.leaf));
    } else ctx.add('child-added-optional', own.label, own.path, 'The optional element "' + y.name + '" was added.', '', U.occursText(y.eff.min, y.eff.max), null, holderOf(y.leaf));
  }
  for (const x of O) {
    const y = nByKey.get(x.key);
    if (!y) continue;
    const own = ownerOf(y.leaf, y, label, path, y.name);
    const ho = holderOf(x.leaf);
    const hn = holderOf(y.leaf);
    const a = x.eff;
    const b = y.eff;
    const occA = U.occursText(a.min, a.max);
    const occB = U.occursText(b.min, b.max);
    if (!sameRange.has(x.base)) {
      if (a.min === 0 && b.min > 0) { minUp.add(y.key); ctx.add('became-required', own.label, own.path, '"' + y.name + '" became required.', occA, occB, ho, hn); }
      else if (a.min > 0 && b.min === 0) { minDown.add(x.key); ctx.add('became-optional', own.label, own.path, '"' + y.name + '" became optional.', occA, occB, ho, hn); }
      else if (b.min > a.min) { minUp.add(y.key); ctx.add('occurrence-min-increased', own.label, own.path, 'minOccurs of "' + y.name + '" increased.', occA, occB, ho, hn); }
      else if (b.min < a.min) { minDown.add(x.key); ctx.add('occurrence-min-decreased', own.label, own.path, 'minOccurs of "' + y.name + '" decreased.', occA, occB, ho, hn); }
      else if (a.min === 0 && b.min === 0) compareLocalRequirement(ctx, own, O, N, oByKey, nByKey, x, y, minUp, minDown, ho, hn);
      if (b.max < a.max) ctx.add('occurrence-max-decreased', own.label, own.path, 'maxOccurs of "' + y.name + '" decreased; documents with more occurrences become invalid.', occA, occB, ho, hn);
      else if (b.max > a.max) ctx.add('occurrence-max-increased', own.label, own.path, 'maxOccurs of "' + y.name + '" increased.', occA, occB, ho, hn);
    }
    if (!a.exclusive && b.exclusive) ctx.add('moved-into-choice', own.label, own.path, '"' + y.name + '" is now one alternative of a choice; documents that also contain the other alternatives become invalid.', 'sequence', 'choice', ho, hn);
    else if (a.exclusive && !b.exclusive) ctx.add('moved-out-of-choice', own.label, own.path, '"' + y.name + '" is no longer an alternative of a choice.', 'choice', 'sequence', ho, hn);
    if (x.leaf.p === 'any' && y.leaf.p === 'any') compareWildcard(ctx, own.label, own.path, x.leaf, y.leaf, ho, hn);
    else if (x.leaf.p === 'element' && y.leaf.p === 'element') {
      // The declaration and type of the child are not part of this child pattern: its own
      // content (if any) is compared in a frame of its own.
      const saved = ctx.frame;
      ctx.frame = null;
      try { compareElementParticle(ctx, own.label, own.path, x.leaf, y.leaf, depth + 1); } finally { ctx.frame = saved; }
    }
  }
  const groups = matchCompositors(O, N);
  compareGroupRequirement(ctx, label, path, groups, minUp, minDown);
  // Order of elements that are in a sequence on both sides.
  const reportOrder = function (common) {
    if (common.length < 2) return;
    const newIndex = new Map(N.map(function (y, i) { return [y.key, i]; }));
    const seq = common.map(function (x) { return newIndex.get(x.key); });
    const keep = lisIndices(seq);
    common.forEach(function (x, i) {
      if (keep.has(i)) return;
      const y = nByKey.get(x.key);
      const own = ownerOf(y.leaf, y, label, path, y.name);
      ctx.add('order-changed', own.label, own.path, 'The position of "' + y.name + '" in the sequence changed; documents in the old order become invalid.', 'position ' + (O.indexOf(x) + 1), 'position ' + (N.indexOf(y) + 1), holderOf(x.leaf), holderOf(y.leaf));
    });
  };
  reportOrder(O.filter(function (x) { return nByKey.has(x.key) && !x.eff.inAll && !nByKey.get(x.key).eff.inAll && !x.eff.exclusive && !nByKey.get(x.key).eff.exclusive; }));
  // Inside a choice branch: elements that share the same sequence on both sides keep their order too.
  const bySequence = new Map();
  for (const x of O) {
    const y = nByKey.get(x.key);
    if (!y || !(x.eff.exclusive || y.eff.exclusive) || x.eff.inAll || y.eff.inAll) continue;
    const so = x.path[x.path.length - 1];
    const sn = y.path[y.path.length - 1];
    if (!so || !sn || so.p !== 'sequence' || sn.p !== 'sequence' || groups.pairs.get(so) !== sn) continue;
    if (!bySequence.has(so)) bySequence.set(so, []);
    bySequence.get(so).push(x);
  }
  for (const list of bySequence.values()) reportOrder(list);
}

function unitWord(local) {
  if (!local.guard) return 'parent';
  return local.guard.p === 'choice' && local.guard.items.length > 1 ? 'choice branch' : 'optional group';
}

/**
 * For a common element that is optional overall on both sides: its requirement inside its
 * optional group or choice branch. A rise means documents that use the group or branch with fewer
 * occurrences become invalid. A requirement that only moves from "optional" to "required" in a
 * unit that holds nothing else is left to the group comparison (the content is the same or only
 * the group's own requirement changed).
 */
function compareLocalRequirement(ctx, own, O, N, oByKey, nByKey, x, y, minUp, minDown, ho, hn) {
  const la = x.local.min;
  const lb = y.local.min;
  if (la === lb) return;
  const sharesUnit = function (list, entry, otherByKey) { return leavesInUnit(list, entry.local.unit, entry).some(function (z) { return otherByKey.has(z.key); }); };
  if (lb > la && (la > 0 || sharesUnit(N, y, oByKey))) {
    minUp.add(y.key);
    ctx.add('became-required-in-group', own.label, own.path, '"' + y.name + '" is now required ' + (lb > 1 ? lb + ' times ' : '') + 'whenever its ' + unitWord(y.local) + ' is used; documents that use the ' + unitWord(y.local) + ' with fewer occurrences become invalid.', String(la), String(lb), ho, hn);
  } else if (lb < la && (lb > 0 || sharesUnit(O, x, nByKey))) {
    minDown.add(x.key);
    ctx.add('became-optional-in-group', own.label, own.path, '"' + y.name + '" is needed fewer times when its ' + unitWord(y.local) + ' is used.', String(la), String(lb), ho, hn);
  }
}

/**
 * Optional and required groups: a choice or sequence that could be left out (or satisfied by no
 * content) and no longer can is BREAKING, the reverse NON-BREAKING. Not reported again when an
 * element below it already carries a change of its own minimum.
 */
function compareGroupRequirement(ctx, label, path, groups, minUp, minDown) {
  for (const [oc, nc] of groups.pairs) {
    const a = emptiable(oc);
    const b = emptiable(nc);
    if (a === b) {
      // The minimum number of repetitions of a sequence or choice rose (a choice that has to occur
      // twice, for example): documents with fewer repetitions become invalid.
      if (nc.min > oc.min && oc.min >= 1) {
        const infoOld2 = groups.old.get(oc);
        const infoNew2 = groups.new.get(nc);
        if (infoNew2.leaves.some(function (x) { return minUp.has(x.key); })) continue;
        const names2 = Array.from(new Set(infoNew2.leaves.map(function (x) { return x.name; }))).slice(0, 4).join(', ');
        const hold2 = function (c, info) { return c.node ? { doc: c.doc, node: c.node } : holderOf(info.leaves[0].leaf); };
        ctx.add('group-min-increased', label, (path ? path + '/' : '') + '(' + nc.p + ': ' + names2 + ')', 'The ' + nc.p + ' now has to occur at least ' + nc.min + ' times instead of ' + oc.min + '; documents with fewer repetitions become invalid.', String(oc.min), String(nc.min), hold2(oc, infoOld2), hold2(nc, infoNew2));
      }
      continue;
    }
    const infoNew = groups.new.get(nc);
    const infoOld = groups.old.get(oc);
    const names = Array.from(new Set(infoNew.leaves.map(function (x) { return x.name; }))).slice(0, 4).join(', ');
    const where = (path ? path + '/' : '') + '(' + nc.p + ': ' + names + ')';
    const hold = function (c, info) { return c.node ? { doc: c.doc, node: c.node } : holderOf(info.leaves[0].leaf); };
    if (a && !b) {
      if (infoNew.leaves.some(function (x) { return minUp.has(x.key); })) continue;
      ctx.add('group-became-required', label, where, 'The ' + nc.p + ' can no longer be left out or left empty; documents without its content become invalid.', 'may be empty', 'required', hold(oc, infoOld), hold(nc, infoNew));
    } else {
      if (infoOld.leaves.some(function (x) { return minDown.has(x.key); })) continue;
      ctx.add('group-became-optional', label, where, 'The ' + nc.p + ' may now be left out or left empty.', 'required', 'may be empty', hold(oc, infoOld), hold(nc, infoNew));
    }
  }
}

/** Names whose consecutive declarations have the same total occurrence range on both sides. */
function sameRanges(O, N) {
  const ranges = function (list) {
    const m = new Map();
    list.forEach(function (x, i) {
      if (x.leaf.p === 'any') return;
      let r = m.get(x.base);
      if (!r) { r = { min: 0, max: 0, count: 0, last: -2, ok: true }; m.set(x.base, r); }
      if (r.count && r.last !== i - 1) r.ok = false;
      if (x.eff.exclusive || x.eff.inAll) r.ok = false;
      r.min += x.eff.min;
      r.max += x.eff.max;
      r.count++;
      r.last = i;
    });
    return m;
  };
  const ro = ranges(O);
  const rn = ranges(N);
  const out = new Set();
  for (const [base, a] of ro) {
    const b = rn.get(base);
    if (!b || !a.ok || !b.ok || a.count === b.count) continue;
    if (a.min === b.min && a.max === b.max) out.add(base);
  }
  return out;
}

/**
 * A wildcard of the new version that takes the place of a removed element: it is new, it sits
 * between the same neighbours, admits the element's namespace and allows at least as many
 * occurrences. Returns { leaf, exact } or null. `exact` is true when the element's content is
 * checked as before: the wildcard skips it, or it is checked against a global declaration that
 * the old particle referred to as well (a lax wildcard also when no global declaration exists).
 */
function coveringWildcard(ctx, O, N, oByKey, nByKey, x, ownNs) {
  const i = O.indexOf(x);
  let prev = -1;
  let next = N.length;
  for (let k = i - 1; k >= 0; k--) if (nByKey.has(O[k].key)) { prev = nByKey.get(O[k].key).index; break; }
  for (let k = i + 1; k < O.length; k++) if (nByKey.has(O[k].key)) { next = nByKey.get(O[k].key).index; break; }
  const ns = ctx.mapNs(x.leaf.ns || '');
  const w = N.find(function (y) {
    if (y.leaf.p !== 'any' || oByKey.has(y.key) || y.index <= prev || y.index >= next) return false;
    if (y.eff.max < x.eff.max || y.eff.min > x.eff.min) return false;
    if (!wildcardAdmits(y.leaf, ns, y.leaf.doc && typeof y.leaf.doc.ns === 'string' ? y.leaf.doc.ns : ownNs)) return false;
    if (y.leaf.processContents === 'strict' && !ctx.n.lookup('element', ns, x.name)) return false;
    return true;
  });
  if (!w) return null;
  const pc = w.leaf.processContents || 'strict';
  const global = ctx.n.lookup('element', ns, x.name);
  const sameDeclaration = !!(x.leaf.ref && x.leaf.global && global);
  const exact = pc === 'skip' || sameDeclaration || (pc === 'lax' && !global);
  return { leaf: w.leaf, exact: exact };
}

/** Indices (into seq) of one longest increasing subsequence. */
function lisIndices(seq) {
  const n = seq.length;
  const tails = [];
  const prev = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (seq[tails[mid]] < seq[i]) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = new Set();
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k !== -1) { out.add(k); k = prev[k]; }
  return out;
}

function compareValueConstraints(ctx, label, path, a, b, ho, hn) {
  if (a.fixed !== b.fixed) {
    if (a.fixed === undefined) ctx.add('fixed-added', label, path, 'A fixed value "' + b.fixed + '" was added.', '', b.fixed, ho, hn);
    else if (b.fixed === undefined) ctx.add('fixed-removed', label, path, 'The fixed value "' + a.fixed + '" was removed.', a.fixed, '', ho, hn);
    else ctx.add('fixed-changed', label, path, 'The fixed value changed.', a.fixed, b.fixed, ho, hn);
  }
  if (a.default !== b.default) {
    if (a.default === undefined) ctx.add('default-added', label, path, 'A default value "' + b.default + '" was added.', '', b.default, ho, hn);
    else if (b.default === undefined) ctx.add('default-removed', label, path, 'The default value "' + a.default + '" was removed; documents that relied on it now mean something else.', a.default, '', ho, hn);
    else ctx.add('default-changed', label, path, 'The default value changed; documents that leave the value out now mean something else.', a.default, b.default, ho, hn);
  }
}

function compareElementParticle(ctx, label, path, a, b, depth) {
  const ho = holderOf(a);
  const hn = holderOf(b);
  // A reference to a global element: the global element's own diff covers its declaration.
  if (a.global && b.global && a.ref && b.ref) return;
  if (!a.nillable && b.nillable) ctx.add('nillable-added', label, path, 'The element may now be nil (xsi:nil).', 'false', 'true', ho, hn);
  if (a.nillable && !b.nillable) ctx.add('nillable-removed', label, path, 'The element may no longer be nil; documents with xsi:nil="true" become invalid.', 'true', 'false', ho, hn);
  compareValueConstraints(ctx, label, path, a, b, ho, hn);
  compareDocs(ctx, label, path, { doc: a.declDoc, node: a.decl }, { doc: b.declDoc, node: b.decl });
  const da = C.elementType(ctx.o, a);
  const db = C.elementType(ctx.n, b);
  compareDeclaredType(ctx, label, path, a, b, da, db, depth);
}

function compareAttributes(ctx, label, path, ma0, mb0, depth, oDef, nDef) {
  const mapKey = function (k, use) { return '{' + ctx.mapNs(use.ns || '') + '}' + use.name; };
  // use="prohibited" means the attribute is not allowed: it counts as absent on either side.
  const ma = new Map(Array.from(ma0).filter(function (e) { return e[1].use !== 'prohibited'; }));
  const mb = new Map(Array.from(mb0).filter(function (e) { return e[1].use !== 'prohibited'; }));
  const A = new Map();
  for (const [k, v] of ma) A.set(mapKey(k, v), v);
  const owner = function (use) {
    const origin = use.origin;
    if (origin && origin.kind === 'attributeGroup') return { label: 'attribute group ' + origin.name, path: '@' + use.name };
    if (origin && origin.category === 'complex' && origin.name && !origin.anonymous && label.indexOf('complexType ' + origin.name) !== 0) return { label: 'complexType ' + origin.name, path: '@' + use.name };
    return { label: label, path: (path ? path + '/' : '') + '@' + use.name };
  };
  const anyNew = nDef && nDef.anyAttribute;
  for (const [k, a] of A) {
    if (mb.has(k)) continue;
    const own = owner(a);
    const ns = ctx.mapNs(a.ns || '');
    // An attribute wildcard of the new version that admits it still accepts documents that use
    // it, as long as the value is checked as before: not at all (skip, or lax without a global
    // declaration) or against the same global declaration.
    const pc = anyNew ? anyNew.processContents || 'strict' : '';
    const global = anyNew ? ctx.n.lookup('attribute', ns, a.name) : null;
    const admitted = anyNew && wildcardAdmits(anyNew, ns, wildcardNs(anyNew, nDef)) && (pc !== 'strict' || !!global);
    if (admitted && (pc === 'skip' || (pc === 'lax' && !global) || (a.ref && a.global && global))) {
      ctx.add('attribute-covered-by-wildcard', own.label, own.path, 'The declaration of the attribute "' + a.name + '" was replaced by an attribute wildcard that still admits it (processContents ' + pc + '); ' +
        (global ? 'its value is checked against the same global declaration as before.' : 'its value is no longer checked.'), a.use, anyNew.namespace, { doc: a.doc, node: a.node }, null);
      continue;
    }
    if (admitted) {
      ctx.add('attribute-removed', own.label, own.path, 'The declaration of the attribute "' + a.name + '" was replaced by an attribute wildcard (processContents ' + pc + ') that checks it against its global declaration; values that only the old declaration accepted become invalid.', a.use, anyNew.namespace, { doc: a.doc, node: a.node }, null);
      continue;
    }
    ctx.add('attribute-removed', own.label, own.path, 'The attribute "' + a.name + '" was removed; documents that use it become invalid.', a.use, '', { doc: a.doc, node: a.node }, null);
  }
  for (const [k, b] of mb) {
    if (A.has(k)) continue;
    const own = owner(b);
    if (b.use === 'required') ctx.add('attribute-added-required', own.label, own.path, 'The required attribute "' + b.name + '" was added.', '', 'required', null, { doc: b.doc, node: b.node });
    else ctx.add('attribute-added-optional', own.label, own.path, 'The optional attribute "' + b.name + '" was added.', '', 'optional', null, { doc: b.doc, node: b.node });
  }
  for (const [k, a] of A) {
    const b = mb.get(k);
    if (!b) continue;
    const own = owner(b);
    const ho = { doc: a.doc, node: a.node };
    const hn = { doc: b.doc, node: b.node };
    if (a.use !== 'required' && b.use === 'required') ctx.add('attribute-became-required', own.label, own.path, 'The attribute "' + b.name + '" became required.', a.use, b.use, ho, hn);
    if (a.use === 'required' && b.use !== 'required') ctx.add('attribute-became-optional', own.label, own.path, 'The attribute "' + b.name + '" became optional.', a.use, b.use, ho, hn);
    compareValueConstraints(ctx, own.label, own.path, a, b, ho, hn);
    if (!(a.global && b.global && a.ref && b.ref)) {
      compareDocs(ctx, own.label, own.path, { doc: a.declDoc, node: a.decl }, { doc: b.declDoc, node: b.decl });
      compareDeclaredType(ctx, own.label, own.path, a, b, C.attributeType(ctx.o, a), C.attributeType(ctx.n, b), depth);
    }
  }
}

// ---- components ---------------------------------------------------------------------------------

function mappedKey(ctx, comp) { return comp.space + ' {' + ctx.mapNs(comp.ns) + '}' + comp.name; }

function componentsOf(set) {
  const out = new Map();
  for (const list of set.components.values()) if (list.length) out.set(list[0].key, list[0]);
  return out;
}

function compareComponent(ctx, o, n) {
  const label = compLabel(n);
  switch (n.space) {
    case 'type': {
      compareDocs(ctx, label, '', o, n);
      compareTypes(ctx, label, '', C.defOfComp(ctx.o, o), C.defOfComp(ctx.n, n), 0);
      break;
    }
    case 'element': {
      const a = C.elementOfComp(ctx.o, o);
      const b = C.elementOfComp(ctx.n, n);
      if (!a.abstract && b.abstract) ctx.add('abstract-added', label, '', 'The element became abstract; documents must use a member of its substitution group.', 'false', 'true', o, n);
      if (a.abstract && !b.abstract) ctx.add('abstract-removed', label, '', 'The element is no longer abstract.', 'true', 'false', o, n);
      const sa = a.substitutionGroup ? qText(ctx.o.resolveQName(o.doc, o.node, a.substitutionGroup.split(/\s+/)[0])) : '';
      const sb = b.substitutionGroup ? qText(ctx.n.resolveQName(n.doc, n.node, b.substitutionGroup.split(/\s+/)[0])) : '';
      const sam = a.substitutionGroup ? (function () { const q = ctx.o.resolveQName(o.doc, o.node, a.substitutionGroup.split(/\s+/)[0]); return qText({ ns: ctx.mapNs(q.ns), local: q.local }); })() : '';
      if (sam !== sb) {
        if (!sa) ctx.add('substitution-group-added', label, '', 'The element can now substitute for ' + sb + '.', '', sb, o, n);
        else if (!sb) ctx.add('substitution-group-removed', label, '', 'The element no longer substitutes for ' + sa + '; documents that use it in place of the head become invalid.', sa, '', o, n);
        else ctx.add('substitution-group-changed', label, '', 'The substitution group changed.', sa, sb, o, n);
      }
      compareTokens(ctx, label, '', 'block', a.block, b.block, o, n);
      compareTokens(ctx, label, '', 'final', a.final, b.final, o, n);
      compareElementParticle(ctx, label, '', Object.assign({}, a, { ref: false }), Object.assign({}, b, { ref: false }), 0);
      break;
    }
    case 'attribute': {
      const ua = C.attributeUses(ctx.o, o.doc, { children: [o.node] }, null).values().next().value;
      const ub = C.attributeUses(ctx.n, n.doc, { children: [n.node] }, null).values().next().value;
      if (ua && ub) {
        compareValueConstraints(ctx, label, '', ua, ub, o, n);
        compareDocs(ctx, label, '', o, n);
        compareDeclaredType(ctx, label, '', ua, ub, C.attributeType(ctx.o, ua), C.attributeType(ctx.n, ub), 0);
      }
      break;
    }
    case 'group': {
      compareDocs(ctx, label, '', o, n);
      compareParticles(ctx, label, '', C.groupParticle(ctx.o, o), C.groupParticle(ctx.n, n), 0, null, null);
      break;
    }
    case 'attributeGroup': {
      compareDocs(ctx, label, '', o, n);
      compareAttributes(ctx, label, '', C.attributeGroupUses(ctx.o, o), C.attributeGroupUses(ctx.n, n), 0, null, null);
      break;
    }
    default:
      compareDocs(ctx, label, '', o, n);
  }
}

function entryDocs(set) {
  const uris = set.entryUris || [set.entryUri];
  return set.docs.filter(function (d) { return uris.indexOf(d.uri) !== -1; });
}

/**
 * Compares two loaded sets. Options: `labels` { old, new } for the report. Returns
 * { changes, counts: { BREAKING, NON-BREAKING, DOCUMENTATION }, namespaceMap, labels }.
 */
function diffSets(oldSet, newSet, options) {
  const opts = options || {};
  const nsMap = new Map();
  const eo = entryDocs(oldSet);
  const en = entryDocs(newSet);
  const ctx = new Ctx(oldSet, newSet, nsMap);
  // Schema level: the namespace of the entry documents.
  const nso = Array.from(new Set(eo.map(function (d) { return d.ns; })));
  const nsn = Array.from(new Set(en.map(function (d) { return d.ns; })));
  if (nso.length === 1 && nsn.length === 1 && nso[0] !== nsn[0]) {
    nsMap.set(nso[0], nsn[0]);
    ctx.add('namespace-changed', 'schema', '', 'The target namespace changed; every document must use the new namespace.', nso[0] || '(none)', nsn[0] || '(none)', eo[0] ? { doc: eo[0], node: eo[0].root } : null, en[0] ? { doc: en[0], node: en[0].root } : null);
  }
  if (eo.length === 1 && en.length === 1) {
    const a = eo[0];
    const b = en[0];
    const ho = { doc: a, node: a.root };
    const hn = { doc: b, node: b.root };
    if (a.elementFormDefault !== b.elementFormDefault) ctx.add('element-form-changed', 'schema', '', 'elementFormDefault changed: local elements are written ' + (b.elementFormDefault === 'qualified' ? 'with' : 'without') + ' the namespace now.', a.elementFormDefault, b.elementFormDefault, ho, hn);
    if (a.attributeFormDefault !== b.attributeFormDefault) ctx.add('attribute-form-changed', 'schema', '', 'attributeFormDefault changed: local attributes are written ' + (b.attributeFormDefault === 'qualified' ? 'with' : 'without') + ' a namespace prefix now.', a.attributeFormDefault, b.attributeFormDefault, ho, hn);
    if (a.version !== b.version) ctx.add('version-changed', 'schema', '', 'The version attribute changed.', a.version, b.version, ho, hn);
    compareDocs(ctx, 'schema', '', ho, hn);
    const imps = function (d, map) { return d.directives.filter(function (x) { return x.kind === 'import'; }).map(function (x) { return map ? map(x.namespace || '') : x.namespace || ''; }); };
    const ia = imps(a, ctx.mapNs.bind(ctx));
    const ib = imps(b, null);
    for (const x of ia) if (ib.indexOf(x) === -1) ctx.add('import-removed', 'schema', '', 'The import of "' + x + '" was removed (its components are compared separately).', x, '', ho, hn);
    for (const x of ib) if (ia.indexOf(x) === -1) ctx.add('import-added', 'schema', '', 'The namespace "' + x + '" is imported now.', '', x, ho, hn);
  }
  // Components.
  const A = componentsOf(oldSet);
  const Bm = componentsOf(newSet);
  const oldByMapped = new Map();
  for (const c of A.values()) oldByMapped.set(mappedKey(ctx, c), c);
  for (const [k, c] of oldByMapped) {
    if (Bm.has(k)) continue;
    if (c.space === 'identity') ctx.add('constraint-removed', c.kind + ' ' + c.name, '', 'The ' + c.kind + ' constraint "' + c.name + '" was removed.', c.name, '', c, null);
    else ctx.add('component-removed', compLabel(c), '', 'The global ' + SPACE_LABEL[c.space] + ' "' + c.name + '" was removed; documents and schemas that use it break.', c.name, '', c, null);
  }
  for (const [k, c] of Bm) {
    if (oldByMapped.has(k)) continue;
    if (c.space === 'identity') ctx.add('constraint-added', c.kind + ' ' + c.name, '', 'The ' + c.kind + ' constraint "' + c.name + '" was added; documents that break it become invalid.', '', c.name, null, c);
    else ctx.add('component-added', compLabel(c), '', 'The global ' + SPACE_LABEL[c.space] + ' "' + c.name + '" was added.', '', c.name, null, c);
  }
  for (const [k, c] of oldByMapped) {
    const n = Bm.get(k);
    if (n) compareComponent(ctx, c, n);
  }
  const order = { BREAKING: 0, 'NON-BREAKING': 1, DOCUMENTATION: 2 };
  ctx.changes.sort(function (x, y) { return order[x.severity] - order[y.severity] || x.component.localeCompare(y.component) || x.path.localeCompare(y.path) || x.code.localeCompare(y.code); });
  const counts = { BREAKING: 0, 'NON-BREAKING': 0, DOCUMENTATION: 0 };
  for (const c of ctx.changes) counts[c.severity]++;
  return { changes: ctx.changes, counts: counts, namespaceMap: Array.from(nsMap.entries()), labels: opts.labels || { old: 'old', new: 'new' } };
}

module.exports = { diffSets: diffSets, RULES: RULES, BREAKING: BREAKING, NON: NON, DOC: DOC, lisIndices: lisIndices, S: S, P: P };
