'use strict';
// Type definitions and content of a loaded schema set, with every derivation applied: the base
// type chain, the effective facets of simple types, and for complex types the effective content
// (particles with group references expanded and extension content appended to the base content)
// and the effective attribute uses (attribute groups expanded, restrictions applied).
//
// Everything is computed on demand and cached per declaration node in the set's cache. Cycles in
// type derivation, group references and attribute group references are detected and recorded as
// problems; the offending link is then treated as absent so that every caller terminates.

const P = require('../xml/parser');
const B = require('./builtins');
const S = require('./set');
const U = require('../util');

const XSD = B.XSD_NS;
const COMPOSITORS = ['sequence', 'choice', 'all'];
const FACET_NAMES = ['length', 'minLength', 'maxLength', 'pattern', 'enumeration', 'whiteSpace', 'maxInclusive', 'maxExclusive',
  'minInclusive', 'minExclusive', 'totalDigits', 'fractionDigits', 'assertion', 'explicitTimezone'];
const SCALAR_FACETS = ['length', 'minLength', 'maxLength', 'whiteSpace', 'maxInclusive', 'maxExclusive', 'minInclusive', 'minExclusive', 'totalDigits', 'fractionDigits', 'explicitTimezone'];

function xs(el, local) { return !!el && el.ns === XSD && (local === undefined || el.local === local); }
function xsKids(el) { return P.childElements(el).filter(function (c) { return c.ns === XSD && c.local !== 'annotation'; }); }

function cacheOf(set) {
  if (!set.cache.has('content')) set.cache.set('content', { defs: new Map(), builtins: new Map(), groups: new Map(), problems: new Set() });
  return set.cache.get('content');
}

function problemOnce(set, code, message, doc, start, end, severity) {
  const c = cacheOf(set);
  const id = code + '@' + doc.uri + ':' + start;
  if (c.problems.has(id)) return;
  c.problems.add(id);
  set.problem(code, severity || 'error', message, doc.uri, start, end);
}

/** minOccurs/maxOccurs of a particle node: { min, max, bad } (bad: the text was not valid). */
function occurs(node) {
  const a = P.attr(node, 'minOccurs');
  const b = P.attr(node, 'maxOccurs');
  let min = 1;
  let max = 1;
  let bad = false;
  if (a !== undefined) { const t = a.trim(); if (/^[0-9]+$/.test(t)) min = Number(t); else bad = true; }
  if (b !== undefined) {
    const t = b.trim();
    if (t === 'unbounded') max = Infinity;
    else if (/^[0-9]+$/.test(t)) max = Number(t);
    else bad = true;
  }
  return { min: min, max: max, bad: bad };
}

/** The text of the xs:documentation elements of the first xs:annotation child (paragraphs joined). */
function documentation(doc, node) {
  if (!node || !doc) return '';
  const ann = P.childElements(node).find(function (c) { return xs(c, 'annotation'); });
  if (!ann) return '';
  const parts = [];
  for (const d of P.childElements(ann)) {
    if (!xs(d, 'documentation')) continue;
    const text = P.textContent(doc.parsed, d).split(/\n\s*\n/).map(U.collapse).filter(Boolean).join('\n\n');
    if (text) parts.push(text);
  }
  return parts.join('\n\n');
}

/** The text of the xs:appinfo elements of the first xs:annotation child (raw, collapsed). */
function appinfo(doc, node) {
  if (!node || !doc) return '';
  const ann = P.childElements(node).find(function (c) { return xs(c, 'annotation'); });
  if (!ann) return '';
  return P.childElements(ann).filter(function (c) { return xs(c, 'appinfo'); })
    .map(function (a) { return U.collapse(doc.text.slice(a.tagEnd, Math.max(a.tagEnd, a.end - 10))); }).join(' ');
}

function flag(node, name) {
  const v = P.attr(node, name);
  return v === 'true' || v === '1';
}

// ---- simple types -------------------------------------------------------------------------------

function emptyFacets() {
  return { enumeration: null, patterns: [], assertions: [] };
}

function ownFacets(doc, restriction) {
  const f = { enumeration: null, patterns: [], assertions: [], scalars: {} };
  const pats = [];
  for (const c of xsKids(restriction)) {
    if (FACET_NAMES.indexOf(c.local) === -1) continue;
    const value = P.attr(c, 'value');
    const rec = { value: value === undefined ? '' : value, node: c, doc: doc, fixed: flag(c, 'fixed') };
    if (c.local === 'enumeration') { if (!f.enumeration) f.enumeration = []; f.enumeration.push(rec); }
    else if (c.local === 'pattern') pats.push(rec);
    else if (c.local === 'assertion') f.assertions.push({ value: P.attr(c, 'test') || '', node: c, doc: doc });
    else f.scalars[c.local] = rec;
  }
  if (pats.length) f.patterns.push(pats);
  return f;
}

function mergeFacets(base, own) {
  const out = Object.assign({}, base);
  out.patterns = (base.patterns || []).concat(own.patterns);
  out.assertions = (base.assertions || []).concat(own.assertions);
  out.enumeration = own.enumeration || base.enumeration || null;
  for (const k of Object.keys(own.scalars)) {
    out[k] = own.scalars[k];
    if (k === 'minInclusive') delete out.minExclusive;
    if (k === 'minExclusive') delete out.minInclusive;
    if (k === 'maxInclusive') delete out.maxExclusive;
    if (k === 'maxExclusive') delete out.maxInclusive;
  }
  return out;
}

function builtinDef(set, name) {
  const c = cacheOf(set);
  if (c.builtins.has(name)) return c.builtins.get(name);
  const item = B.listItemOf(name);
  const def = {
    builtin: name, name: name, ns: XSD, anonymous: false, comp: null, node: null, doc: null,
    category: name === 'anyType' ? 'complex' : 'simple',
    variety: item ? 'list' : name === 'anySimpleType' || name === 'anyAtomicType' ? 'atomic' : 'atomic',
    primitive: B.primitiveOf(name), builtinBase: name, facets: emptyFacets(), derivation: null, baseDef: null, baseRef: null,
    itemDef: null, memberDefs: [], whiteSpace: B.whiteSpaceOf(name)
  };
  c.builtins.set(name, def);
  if (item) def.itemDef = builtinDef(set, item);
  const baseName = B.baseOf(name);
  if (baseName) def.baseDef = builtinDef(set, baseName);
  def.derivation = baseName ? (item ? 'list' : 'restriction') : null;
  if (name === 'anyType') {
    def.contentKind = 'mixed';
    def.mixed = true;
    def.particle = { p: 'sequence', min: 1, max: 1, items: [{ p: 'any', namespace: '##any', processContents: 'lax', min: 0, max: Infinity, node: null, doc: null, origin: null }], node: null, origin: null };
    def.attributes = new Map();
    def.anyAttribute = { namespace: '##any', processContents: 'lax', node: null };
  }
  return def;
}

/** The type definition of a component (global or built-in). */
function defOfComp(set, comp) {
  if (!comp) return builtinDef(set, 'anyType');
  if (comp.builtin) return builtinDef(set, comp.name);
  return defOfNode(set, comp.doc, comp.node, comp);
}

/** Resolves a type QName written on `node` to a definition; reports unresolved names elsewhere. */
function defOfTypeRef(set, doc, node, value, fallback) {
  const r = set.resolveRef(doc, node, value, 'type');
  if (r.comp) return { def: defOfComp(set, r.comp), ref: r.ref };
  return { def: builtinDef(set, fallback || 'anyType'), ref: r.ref, unresolved: true };
}

/** The type definition of a complexType or simpleType node (named or anonymous). */
function defOfNode(set, doc, node, comp) {
  const c = cacheOf(set);
  const existing = c.defs.get(node);
  if (existing) return existing;
  const def = {
    builtin: '', name: comp ? comp.name : '', ns: comp ? comp.ns : doc.ns, anonymous: !comp, comp: comp || null, node: node, doc: doc,
    category: node.local === 'simpleType' ? 'simple' : 'complex', building: true, documentation: documentation(doc, node)
  };
  c.defs.set(node, def);
  try {
    if (def.category === 'simple') buildSimple(set, def);
    else buildComplex(set, def);
  } finally {
    def.building = false;
  }
  return def;
}

// Returns the base definition, or the fallback when following it would close a cycle.
function safeBase(set, def, attrNode, value, fallback) {
  // Inside xs:redefine a type derives from the original definition of the same name.
  if (def.comp && def.comp.redefined && def.comp.original) {
    const q = set.resolveQName(def.doc, def.node, value);
    if (!q.error && S.key('type', q.ns, q.local) === def.comp.key) return { def: defOfComp(set, def.comp.original), ref: q };
  }
  const r = defOfTypeRef(set, def.doc, def.node, value, fallback);
  if (r.def.building || r.def === def) {
    problemOnce(set, 'XSD-CIRCULAR-DERIVATION', 'The type "' + (def.name || 'anonymous') + '" derives from itself through "' + value + '".', def.doc, attrNode ? attrNode.valueStart : def.node.start, attrNode ? attrNode.valueEnd : def.node.nameEnd);
    return { def: builtinDef(set, fallback), ref: r.ref, cycle: true };
  }
  return r;
}

function buildSimple(set, def) {
  const child = xsKids(def.node).find(function (k) { return k.local === 'restriction' || k.local === 'list' || k.local === 'union'; });
  def.facets = emptyFacets();
  def.memberDefs = [];
  def.itemDef = null;
  if (!child) {
    Object.assign(def, { variety: 'atomic', primitive: '', builtinBase: 'anySimpleType', derivation: null, baseDef: builtinDef(set, 'anySimpleType'), whiteSpace: 'collapse' });
    return;
  }
  def.derivation = child.local;
  def.derivationNode = child;
  if (child.local === 'restriction') {
    const baseAttr = P.attrNode(child, 'base');
    let base;
    if (baseAttr) {
      const r = safeBase(set, def, baseAttr, baseAttr.value, 'anySimpleType');
      base = r.def;
      def.baseRef = r.ref;
      def.baseUnresolved = !!r.unresolved;
    } else {
      const inline = xsKids(child).find(function (k) { return k.local === 'simpleType'; });
      base = inline ? defOfNode(set, def.doc, inline, null) : builtinDef(set, 'anySimpleType');
    }
    if (base.category === 'complex') {
      if (base.contentKind === 'simple' && base.simpleDef) base = base.simpleDef;
      else base = builtinDef(set, 'anySimpleType');
    }
    def.baseDef = base;
    def.variety = base.variety;
    def.primitive = base.primitive;
    def.builtinBase = base.builtinBase;
    def.itemDef = base.itemDef;
    def.memberDefs = base.memberDefs || [];
    def.ownFacets = ownFacets(def.doc, child);
    def.facets = mergeFacets(base.facets || emptyFacets(), def.ownFacets);
    def.whiteSpace = def.facets.whiteSpace ? def.facets.whiteSpace.value : base.whiteSpace;
    return;
  }
  if (child.local === 'list') {
    const itemAttr = P.attrNode(child, 'itemType');
    let item;
    if (itemAttr) {
      const r = safeBase(set, def, itemAttr, itemAttr.value, 'anySimpleType');
      item = r.def;
      def.itemRef = r.ref;
    } else {
      const inline = xsKids(child).find(function (k) { return k.local === 'simpleType'; });
      item = inline ? defOfNode(set, def.doc, inline, null) : builtinDef(set, 'anySimpleType');
    }
    Object.assign(def, { variety: 'list', primitive: 'list', builtinBase: '', itemDef: item, baseDef: builtinDef(set, 'anySimpleType'), whiteSpace: 'collapse' });
    return;
  }
  const members = [];
  const mt = P.attrNode(child, 'memberTypes');
  if (mt) {
    for (const part of mt.value.trim().split(/\s+/).filter(Boolean)) {
      const r = safeBase(set, def, mt, part, 'anySimpleType');
      members.push(r.def);
    }
  }
  for (const inline of xsKids(child)) if (inline.local === 'simpleType') members.push(defOfNode(set, def.doc, inline, null));
  Object.assign(def, { variety: 'union', primitive: 'union', builtinBase: '', memberDefs: members, baseDef: builtinDef(set, 'anySimpleType'), whiteSpace: 'collapse' });
}

// ---- complex types ------------------------------------------------------------------------------

function buildComplex(set, def) {
  const node = def.node;
  def.abstract = flag(node, 'abstract');
  def.block = P.attr(node, 'block') !== undefined ? P.attr(node, 'block') : def.doc.blockDefault;
  def.final = P.attr(node, 'final') !== undefined ? P.attr(node, 'final') : def.doc.finalDefault;
  const kids = xsKids(node);
  const sc = kids.find(function (k) { return k.local === 'simpleContent'; });
  const cc = kids.find(function (k) { return k.local === 'complexContent'; });
  def.attributes = new Map();
  def.anyAttribute = null;
  def.particle = null;
  def.simpleDef = null;
  if (sc) {
    const d = xsKids(sc).find(function (k) { return k.local === 'extension' || k.local === 'restriction'; });
    def.derivation = d ? d.local : 'restriction';
    def.derivationNode = d || sc;
    def.contentKind = 'simple';
    def.mixed = false;
    let base = builtinDef(set, 'anySimpleType');
    const baseAttr = d ? P.attrNode(d, 'base') : null;
    if (baseAttr) {
      const r = safeBase(set, def, baseAttr, baseAttr.value, 'anyType');
      base = r.def;
      def.baseRef = r.ref;
      def.baseUnresolved = !!r.unresolved;
    }
    def.baseDef = base;
    const baseSimple = base.category === 'simple' ? base : base.simpleDef || builtinDef(set, 'anySimpleType');
    if (d && d.local === 'restriction') {
      const inline = xsKids(d).find(function (k) { return k.local === 'simpleType'; });
      const startDef = inline ? defOfNode(set, def.doc, inline, null) : baseSimple;
      const own = ownFacets(def.doc, d);
      def.simpleDef = {
        builtin: '', name: '', ns: def.ns, anonymous: true, comp: null, node: d, doc: def.doc, category: 'simple', synthetic: true,
        variety: startDef.variety, primitive: startDef.primitive, builtinBase: startDef.builtinBase, itemDef: startDef.itemDef,
        memberDefs: startDef.memberDefs || [], baseDef: startDef, derivation: 'restriction', ownFacets: own,
        facets: mergeFacets(startDef.facets || emptyFacets(), own)
      };
      def.simpleDef.whiteSpace = def.simpleDef.facets.whiteSpace ? def.simpleDef.facets.whiteSpace.value : startDef.whiteSpace;
      const baseAttrs = base.category === 'complex' ? base.attributes : new Map();
      def.attributes = restrictAttributes(baseAttrs, attributeUses(set, def.doc, d, def));
      def.anyAttribute = ownAnyAttribute(set, def.doc, d, def) || (base.category === 'complex' ? base.anyAttribute : null);
    } else {
      def.simpleDef = baseSimple;
      const baseAttrs = base.category === 'complex' ? base.attributes : new Map();
      def.attributes = extendAttributes(set, def, baseAttrs, d ? attributeUses(set, def.doc, d, def) : new Map());
      def.anyAttribute = (d && ownAnyAttribute(set, def.doc, d, def)) || (base.category === 'complex' ? base.anyAttribute : null);
    }
    return;
  }
  if (cc) {
    const d = xsKids(cc).find(function (k) { return k.local === 'extension' || k.local === 'restriction'; });
    def.derivation = d ? d.local : 'restriction';
    def.derivationNode = d || cc;
    def.mixed = P.attr(cc, 'mixed') !== undefined ? flag(cc, 'mixed') : flag(node, 'mixed');
    let base = builtinDef(set, 'anyType');
    const baseAttr = d ? P.attrNode(d, 'base') : null;
    if (baseAttr) {
      const r = safeBase(set, def, baseAttr, baseAttr.value, 'anyType');
      base = r.def;
      def.baseRef = r.ref;
      def.baseUnresolved = !!r.unresolved;
    }
    if (base.category === 'simple') {
      problemOnce(set, 'XSD-INVALID-DERIVATION', 'Complex content cannot be derived from the simple type "' + (base.name || 'anonymous') + '". Use simpleContent instead.', def.doc, baseAttr ? baseAttr.valueStart : cc.start, baseAttr ? baseAttr.valueEnd : cc.nameEnd);
      base = builtinDef(set, 'anyType');
    }
    def.baseDef = base;
    const own = d ? particleOfContainer(set, def.doc, d, def) : null;
    if (def.derivation === 'extension') {
      const bp = base.builtin === 'anyType' ? null : base.particle;
      if (bp && own) def.particle = { p: 'sequence', min: 1, max: 1, items: [bp, own], node: null, origin: def, synthetic: true };
      else def.particle = own || bp || null;
      def.attributes = extendAttributes(set, def, base.attributes || new Map(), attributeUses(set, def.doc, d, def));
      def.anyAttribute = ownAnyAttribute(set, def.doc, d, def) || base.anyAttribute || null;
      if (base.mixed && base.builtin !== 'anyType') def.mixed = true;
    } else {
      def.particle = own;
      def.attributes = restrictAttributes(base.attributes || new Map(), d ? attributeUses(set, def.doc, d, def) : new Map());
      def.anyAttribute = d ? ownAnyAttribute(set, def.doc, d, def) : null;
    }
  } else {
    def.derivation = null;
    def.baseDef = builtinDef(set, 'anyType');
    def.mixed = flag(node, 'mixed');
    def.particle = particleOfContainer(set, def.doc, node, def);
    def.attributes = attributeUses(set, def.doc, node, def);
    def.anyAttribute = ownAnyAttribute(set, def.doc, node, def);
  }
  const empty = !def.particle || isEmptyParticle(def.particle);
  def.contentKind = empty ? (def.mixed ? 'mixed' : 'empty') : def.mixed ? 'mixed' : 'elementOnly';
}

function isEmptyParticle(p) {
  if (!p) return true;
  if (p.p === 'element' || p.p === 'any') return p.max === 0;
  return p.max === 0 || p.items.every(isEmptyParticle);
}

// The compositor or group reference that is a direct child of a container (complexType,
// extension, restriction, group).
function particleOfContainer(set, doc, container, origin) {
  const k = xsKids(container).find(function (c) { return COMPOSITORS.indexOf(c.local) !== -1 || c.local === 'group'; });
  return k ? particleOf(set, doc, k, origin, []) : null;
}

/** Builds the particle of an xs:sequence, xs:choice, xs:all, xs:group (reference), xs:element or xs:any node. */
function particleOf(set, doc, node, origin, groupStack) {
  const o = occurs(node);
  if (COMPOSITORS.indexOf(node.local) !== -1) {
    const items = [];
    for (const c of xsKids(node)) {
      if (c.local === 'element' || c.local === 'any' || c.local === 'group' || COMPOSITORS.indexOf(c.local) !== -1) {
        const p = particleOf(set, doc, c, origin, groupStack);
        if (p) items.push(p);
      }
    }
    return { p: node.local, min: o.min, max: o.max, items: items, node: node, doc: doc, origin: origin };
  }
  if (node.local === 'group') {
    const refAttr = P.attrNode(node, 'ref');
    if (!refAttr) return null;
    const r = set.resolveRef(doc, node, refAttr.value, 'group');
    if (!r.comp) return null;
    // Inside a redefined group, a reference to the same name means the original group.
    if (origin && origin.redefined && origin.original && r.comp === origin) r.comp = origin.original;
    if (groupStack.indexOf(r.comp) !== -1) {
      problemOnce(set, 'XSD-CIRCULAR-GROUP', 'The group "' + r.comp.name + '" refers to itself (directly or through other groups).', doc, refAttr.valueStart, refAttr.valueEnd);
      return null;
    }
    const inner = groupParticle(set, r.comp, groupStack.concat([r.comp]));
    if (!inner) return null;
    return Object.assign({}, inner, { min: o.min, max: o.max, groupRef: r.comp, refNode: node, refDoc: doc });
  }
  if (node.local === 'any') {
    return {
      p: 'any', namespace: P.attr(node, 'namespace') || '##any', processContents: P.attr(node, 'processContents') || 'strict',
      notNamespace: P.attr(node, 'notNamespace') || '', min: o.min, max: o.max, node: node, doc: doc, origin: origin
    };
  }
  return elementParticle(set, doc, node, origin, o);
}

/** The particle of a global group component (its compositor), cached. */
function groupParticle(set, comp, stack) {
  const c = cacheOf(set);
  if (c.groups.has(comp.node)) return c.groups.get(comp.node);
  const k = xsKids(comp.node).find(function (x) { return COMPOSITORS.indexOf(x.local) !== -1; });
  const p = k ? particleOf(set, comp.doc, k, comp, stack || [comp]) : null;
  if (p) { p.min = 1; p.max = 1; }
  c.groups.set(comp.node, p);
  return p;
}

function elementParticle(set, doc, node, origin, o) {
  const refAttr = P.attrNode(node, 'ref');
  const p = { p: 'element', min: o.min, max: o.max, node: node, doc: doc, origin: origin, ref: !!refAttr, global: null };
  let decl = node;
  let declDoc = doc;
  if (refAttr) {
    const r = set.resolveRef(doc, node, refAttr.value, 'element');
    p.name = r.ref.local || '';
    p.ns = r.ref.ns || '';
    if (!r.comp) { p.unresolved = true; p.decl = node; p.declDoc = doc; return p; }
    p.global = r.comp;
    decl = r.comp.node;
    declDoc = r.comp.doc;
    p.name = r.comp.name;
    p.ns = r.comp.ns;
  } else {
    p.name = P.attr(node, 'name') || '';
    const form = P.attr(node, 'form');
    const isGlobal = node.parent && xs(node.parent, 'schema');
    p.ns = isGlobal || form === 'qualified' || (form === undefined && doc.elementFormDefault === 'qualified') ? doc.ns : '';
  }
  p.decl = decl;
  p.declDoc = declDoc;
  Object.assign(p, declarationFacts(declDoc, decl));
  return p;
}

function declarationFacts(doc, decl) {
  const typeAttr = P.attr(decl, 'type');
  const inline = xsKids(decl).find(function (k) { return k.local === 'complexType' || k.local === 'simpleType'; }) || null;
  return {
    typeValue: typeAttr === undefined ? null : typeAttr,
    typeNode: inline,
    nillable: flag(decl, 'nillable'),
    abstract: flag(decl, 'abstract'),
    default: P.attr(decl, 'default'),
    fixed: P.attr(decl, 'fixed'),
    substitutionGroup: P.attr(decl, 'substitutionGroup') || '',
    block: P.attr(decl, 'block') !== undefined ? P.attr(decl, 'block') : doc.blockDefault,
    final: P.attr(decl, 'final') !== undefined ? P.attr(decl, 'final') : doc.finalDefault
  };
}

/** The particle of a global element component (occurs once). */
function elementOfComp(set, comp) {
  const p = { p: 'element', min: 1, max: 1, node: comp.node, doc: comp.doc, origin: comp, ref: false, global: comp, name: comp.name, ns: comp.ns, decl: comp.node, declDoc: comp.doc };
  return Object.assign(p, declarationFacts(comp.doc, comp.node));
}

/** The type definition of an element particle (inline type, named type, substitution head's type, or anyType). */
function elementType(set, particle, depth) {
  if (!particle || particle.unresolved) return builtinDef(set, 'anyType');
  if (particle.typeNode) return defOfNode(set, particle.declDoc, particle.typeNode, null);
  if (particle.typeValue !== null && particle.typeValue !== undefined) {
    const r = defOfTypeRef(set, particle.declDoc, particle.decl, particle.typeValue, 'anyType');
    return r.def;
  }
  if (particle.substitutionGroup && (depth || 0) < 20) {
    const head = set.resolveRef(particle.declDoc, particle.decl, particle.substitutionGroup.trim().split(/\s+/)[0], 'element');
    if (head.comp && head.comp.node !== particle.decl) return elementType(set, elementOfComp(set, head.comp), (depth || 0) + 1);
  }
  return builtinDef(set, 'anyType');
}

// ---- attributes ---------------------------------------------------------------------------------

function attrKey(ns, name) { return '{' + (ns || '') + '}' + name; }

/** Attribute uses declared directly in a container, attribute groups expanded. */
function attributeUses(set, doc, container, origin, stack) {
  const out = new Map();
  if (!container) return out;
  const groupStack = stack || [];
  for (const c of xsKids(container)) {
    if (c.local === 'attribute') {
      const use = attributeUse(set, doc, c, origin);
      if (!use.name) continue;
      const k = attrKey(use.ns, use.name);
      if (out.has(k)) {
        const n = P.attrNode(c, 'name') || P.attrNode(c, 'ref');
        problemOnce(set, 'XSD-DUPLICATE-ATTRIBUTE', 'The attribute "' + use.name + '" is declared twice in the same type.', doc, n ? n.valueStart : c.start, n ? n.valueEnd : c.nameEnd);
      }
      out.set(k, use);
    } else if (c.local === 'attributeGroup') {
      const refAttr = P.attrNode(c, 'ref');
      if (!refAttr) continue;
      const r = set.resolveRef(doc, c, refAttr.value, 'attributeGroup');
      if (!r.comp) continue;
      if (origin && origin.redefined && origin.original && r.comp === origin) r.comp = origin.original;
      if (groupStack.indexOf(r.comp) !== -1) {
        problemOnce(set, 'XSD-CIRCULAR-ATTRIBUTE-GROUP', 'The attribute group "' + r.comp.name + '" refers to itself (directly or through other attribute groups).', doc, refAttr.valueStart, refAttr.valueEnd);
        continue;
      }
      const inner = attributeUses(set, r.comp.doc, r.comp.node, r.comp, groupStack.concat([r.comp]));
      for (const [k, v] of inner) {
        if (out.has(k)) problemOnce(set, 'XSD-DUPLICATE-ATTRIBUTE', 'The attribute "' + v.name + '" is declared twice in the same type (through the attribute group "' + r.comp.name + '").', doc, refAttr.valueStart, refAttr.valueEnd);
        out.set(k, v);
      }
    }
  }
  return out;
}

function attributeUse(set, doc, node, origin) {
  const refAttr = P.attrNode(node, 'ref');
  const use = { node: node, doc: doc, origin: origin, ref: !!refAttr, use: P.attr(node, 'use') || 'optional', global: null };
  let decl = node;
  let declDoc = doc;
  if (refAttr) {
    const r = set.resolveRef(doc, node, refAttr.value, 'attribute');
    use.name = r.ref.local || '';
    use.ns = r.ref.ns || '';
    if (r.comp && !r.comp.builtin) { decl = r.comp.node; declDoc = r.comp.doc; use.global = r.comp; }
    else if (r.comp && r.comp.builtin) use.builtinAttribute = true;
    else use.unresolved = true;
  } else {
    use.name = P.attr(node, 'name') || '';
    const form = P.attr(node, 'form');
    const isGlobal = node.parent && xs(node.parent, 'schema');
    use.ns = isGlobal || form === 'qualified' || (form === undefined && doc.attributeFormDefault === 'qualified') ? doc.ns : '';
  }
  use.decl = decl;
  use.declDoc = declDoc;
  const typeAttr = P.attr(decl, 'type');
  use.typeValue = typeAttr === undefined ? null : typeAttr;
  use.typeNode = xsKids(decl).find(function (k) { return k.local === 'simpleType'; }) || null;
  // A default or fixed value on the reference wins over the one on the global declaration.
  use.default = P.attr(node, 'default') !== undefined ? P.attr(node, 'default') : decl !== node ? P.attr(decl, 'default') : undefined;
  use.fixed = P.attr(node, 'fixed') !== undefined ? P.attr(node, 'fixed') : decl !== node ? P.attr(decl, 'fixed') : undefined;
  return use;
}

function ownAnyAttribute(set, doc, container, origin) {
  const a = xsKids(container).find(function (k) { return k.local === 'anyAttribute'; });
  if (a) return { namespace: P.attr(a, 'namespace') || '##any', processContents: P.attr(a, 'processContents') || 'strict', node: a, doc: doc, origin: origin };
  for (const g of xsKids(container)) {
    if (g.local !== 'attributeGroup') continue;
    const refAttr = P.attr(g, 'ref');
    if (!refAttr) continue;
    const r = set.resolveRef(doc, g, refAttr, 'attributeGroup');
    if (r.comp) {
      const inner = xsKids(r.comp.node).find(function (k) { return k.local === 'anyAttribute'; });
      if (inner) return { namespace: P.attr(inner, 'namespace') || '##any', processContents: P.attr(inner, 'processContents') || 'strict', node: inner, doc: r.comp.doc, origin: r.comp };
    }
  }
  return null;
}

function extendAttributes(set, def, base, own) {
  const out = new Map(base);
  for (const [k, v] of own) {
    if (out.has(k) && v.use !== 'prohibited') {
      problemOnce(set, 'XSD-DUPLICATE-ATTRIBUTE', 'The attribute "' + v.name + '" is already declared in the base type, so an extension cannot add it again.', v.doc, v.node.start + 1, v.node.nameEnd);
    }
    out.set(k, v);
  }
  return out;
}

function restrictAttributes(base, own) {
  const out = new Map(base);
  for (const [k, v] of own) {
    if (v.use === 'prohibited') out.delete(k);
    else out.set(k, v);
  }
  return out;
}

/** The type definition of an attribute use (inline, named, or anySimpleType). */
function attributeType(set, use) {
  if (!use || use.unresolved) return builtinDef(set, 'anySimpleType');
  if (use.builtinAttribute) {
    return builtinDef(set, use.name === 'lang' ? 'language' : use.name === 'id' ? 'ID' : use.name === 'base' ? 'anyURI' : 'NCName');
  }
  if (use.typeNode) return defOfNode(set, use.declDoc, use.typeNode, null);
  if (use.typeValue !== null && use.typeValue !== undefined) return defOfTypeRef(set, use.declDoc, use.decl, use.typeValue, 'anySimpleType').def;
  return builtinDef(set, 'anySimpleType');
}

/** Attribute uses of a global attribute group component. */
function attributeGroupUses(set, comp) { return attributeUses(set, comp.doc, comp.node, comp, [comp]); }

// ---- summaries ----------------------------------------------------------------------------------

/** "xs:string", "tns:OrderType" or "(anonymous)" for a definition, using the prefixes in scope at `node`. */
function typeLabel(def, contextNode) {
  if (!def) return '';
  if (def.builtin) return prefixFor(contextNode, XSD) + def.builtin;
  if (def.anonymous) return '(anonymous ' + (def.category === 'simple' ? 'simple' : 'complex') + ' type)';
  return prefixFor(contextNode, def.ns) + def.name;
}

/** The prefix (with colon) that the scope of `node` uses for `ns`, or "{ns}" when there is none. */
function prefixFor(node, ns) {
  if (!ns) return '';
  const scope = node ? P.inScopeNamespaces(node) : {};
  let fallback = null;
  for (const k of Object.keys(scope)) {
    if (scope[k] !== ns) continue;
    if (k) return k + ':';
    fallback = '';
  }
  if (fallback === '') return '';
  if (ns === XSD) return 'xs:';
  return '{' + ns + '}';
}

/** The chain of named base types from `def` upwards (definitions, `def` excluded). */
function baseChain(def) {
  const out = [];
  let d = def && def.baseDef;
  const seen = new Set();
  while (d && !seen.has(d) && out.length < 40) {
    seen.add(d);
    out.push(d);
    d = d.baseDef;
  }
  return out;
}

/** All element particles in a particle tree with their path of compositors: [{ particle, path }]. */
function flattenElements(particle) {
  const out = [];
  (function walk(p, path) {
    if (!p) return;
    if (p.p === 'element' || p.p === 'any') { out.push({ particle: p, path: path }); return; }
    const here = path.concat([p]);
    for (const it of p.items) walk(it, here);
  })(particle, []);
  return out;
}

module.exports = {
  occurs: occurs, documentation: documentation, appinfo: appinfo, defOfComp: defOfComp, defOfNode: defOfNode, defOfTypeRef: defOfTypeRef,
  builtinDef: builtinDef, elementOfComp: elementOfComp, elementType: elementType, particleOf: particleOf, groupParticle: groupParticle,
  attributeUses: attributeUses, attributeType: attributeType, attributeGroupUses: attributeGroupUses, attrKey: attrKey,
  typeLabel: typeLabel, prefixFor: prefixFor, baseChain: baseChain, flattenElements: flattenElements, isEmptyParticle: isEmptyParticle,
  xsKids: xsKids, flag: flag, FACET_NAMES: FACET_NAMES, SCALAR_FACETS: SCALAR_FACETS, COMPOSITORS: COMPOSITORS, S: S
};
