'use strict';
// Structural problems of the schema documents (and WSDL documents) of one file, with stable codes.
// These are common checks of schema structure: references, names, namespaces, derivation,
// facets, occurrence values and the files a schema names. They do not replace a complete
// schema-validity assessment and they never validate instance documents.

const P = require('../xml/parser');
const B = require('./builtins');
const S = require('./set');
const C = require('./content');
const F = require('./facets');
const U = require('../util');
const WC = require('../wsdl/check');

const XSD = B.XSD_NS;

const KNOWN = new Set(['all', 'alternative', 'annotation', 'any', 'anyAttribute', 'appinfo', 'assert', 'assertion', 'attribute', 'attributeGroup', 'choice',
  'complexContent', 'complexType', 'defaultOpenContent', 'documentation', 'element', 'enumeration', 'explicitTimezone', 'extension', 'field',
  'fractionDigits', 'group', 'import', 'include', 'key', 'keyref', 'length', 'list', 'maxExclusive', 'maxInclusive', 'maxLength', 'minExclusive',
  'minInclusive', 'minLength', 'notation', 'openContent', 'override', 'pattern', 'redefine', 'restriction', 'schema', 'selector', 'sequence',
  'simpleContent', 'simpleType', 'totalDigits', 'union', 'unique', 'whiteSpace']);

const NAMED = ['element', 'attribute', 'complexType', 'simpleType', 'group', 'attributeGroup', 'notation', 'key', 'unique', 'keyref'];

// Attributes without a namespace that XML Schema 1.0 and 1.1 allow on each element (attributes
// in another namespace are always allowed). A misspelt attribute is otherwise silently ignored.
const FACET_ATTRS = ['id', 'value', 'fixed'];
const ALLOWED_ATTRS = {
  schema: ['attributeFormDefault', 'blockDefault', 'defaultAttributes', 'xpathDefaultNamespace', 'elementFormDefault', 'finalDefault', 'id', 'targetNamespace', 'version'],
  element: ['abstract', 'block', 'default', 'final', 'fixed', 'form', 'id', 'maxOccurs', 'minOccurs', 'name', 'nillable', 'ref', 'substitutionGroup', 'targetNamespace', 'type'],
  attribute: ['default', 'fixed', 'form', 'id', 'name', 'ref', 'targetNamespace', 'type', 'use', 'inheritable'],
  complexType: ['abstract', 'block', 'final', 'id', 'mixed', 'name', 'defaultAttributesApply'],
  simpleType: ['final', 'id', 'name'],
  group: ['id', 'maxOccurs', 'minOccurs', 'name', 'ref'],
  attributeGroup: ['id', 'name', 'ref'],
  all: ['id', 'maxOccurs', 'minOccurs'], choice: ['id', 'maxOccurs', 'minOccurs'], sequence: ['id', 'maxOccurs', 'minOccurs'],
  any: ['id', 'maxOccurs', 'minOccurs', 'namespace', 'processContents', 'notNamespace', 'notQName'],
  anyAttribute: ['id', 'namespace', 'processContents', 'notNamespace', 'notQName'],
  complexContent: ['id', 'mixed'], simpleContent: ['id'],
  restriction: ['base', 'id'], extension: ['base', 'id'], list: ['id', 'itemType'], union: ['id', 'memberTypes'],
  length: FACET_ATTRS, minLength: FACET_ATTRS, maxLength: FACET_ATTRS, pattern: FACET_ATTRS, enumeration: FACET_ATTRS, whiteSpace: FACET_ATTRS,
  maxInclusive: FACET_ATTRS, maxExclusive: FACET_ATTRS, minInclusive: FACET_ATTRS, minExclusive: FACET_ATTRS, totalDigits: FACET_ATTRS,
  fractionDigits: FACET_ATTRS, explicitTimezone: FACET_ATTRS,
  assertion: ['id', 'test', 'xpathDefaultNamespace'], assert: ['id', 'test', 'xpathDefaultNamespace'],
  include: ['id', 'schemaLocation'], import: ['id', 'namespace', 'schemaLocation'], redefine: ['id', 'schemaLocation'], override: ['id', 'schemaLocation'],
  notation: ['id', 'name', 'public', 'system'],
  key: ['id', 'name', 'ref'], unique: ['id', 'name', 'ref'], keyref: ['id', 'name', 'refer', 'ref'],
  selector: ['id', 'xpath', 'xpathDefaultNamespace'], field: ['id', 'xpath', 'xpathDefaultNamespace'],
  alternative: ['id', 'test', 'type', 'xpathDefaultNamespace'],
  openContent: ['id', 'mode'], defaultOpenContent: ['appliesToEmpty', 'id', 'mode']
};

function checkAttributeNames(el, out) {
  const allowed = ALLOWED_ATTRS[el.local];
  if (!allowed) return;
  for (const a of el.attrs) {
    if (a.ns || a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue;
    if (allowed.indexOf(a.local) !== -1) continue;
    const near = allowed.find(function (x) { return x.toLowerCase() === a.local.toLowerCase(); }) || allowed.find(function (x) { return closeTo(x, a.local); });
    push(out, 'XSD-UNKNOWN-ATTRIBUTE', 'xs:' + el.local + ' has no attribute "' + a.local + '"' + (near ? ' (did you mean "' + near + '"?)' : '') + '; it is ignored by schema processors that accept it and refused by the others.', a.start, a.end);
  }
}

// True when two names differ by one inserted, removed or replaced character.
function closeTo(a, b) {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

// Attributes holding QNames: element local name -> [[attribute, symbol space, list?]].
const REFS = {
  element: [['type', 'type', false], ['ref', 'element', false], ['substitutionGroup', 'element', true]],
  attribute: [['type', 'type', false], ['ref', 'attribute', false]],
  group: [['ref', 'group', false]],
  attributeGroup: [['ref', 'attributeGroup', false]],
  restriction: [['base', 'type', false]],
  extension: [['base', 'type', false]],
  list: [['itemType', 'type', false]],
  union: [['memberTypes', 'type', true]],
  keyref: [['refer', 'identity', false]]
};

const UNRESOLVED_CODE = {
  type: 'XSD-UNRESOLVED-TYPE', element: 'XSD-UNRESOLVED-ELEMENT', attribute: 'XSD-UNRESOLVED-ATTRIBUTE', group: 'XSD-UNRESOLVED-GROUP',
  attributeGroup: 'XSD-UNRESOLVED-ATTRIBUTE-GROUP', identity: 'XSD-UNRESOLVED-IDENTITY'
};
const SPACE_WORD = { type: 'type', element: 'element', attribute: 'attribute', group: 'group', attributeGroup: 'attribute group', identity: 'key or unique constraint' };

/** Every problem code this module and the parser can report, with its default severity. */
const CODES = {
  'XSD-UNRESOLVED-TYPE': 'error', 'XSD-UNRESOLVED-ELEMENT': 'error', 'XSD-UNRESOLVED-ATTRIBUTE': 'error', 'XSD-UNRESOLVED-GROUP': 'error',
  'XSD-UNRESOLVED-ATTRIBUTE-GROUP': 'error', 'XSD-UNRESOLVED-IDENTITY': 'error', 'XSD-UNDECLARED-PREFIX': 'error', 'XSD-NAMESPACE-NOT-IMPORTED': 'error',
  'XSD-DUPLICATE-NAME': 'error', 'XSD-DUPLICATE-ATTRIBUTE': 'error', 'XSD-CIRCULAR-DERIVATION': 'error', 'XSD-CIRCULAR-GROUP': 'error',
  'XSD-CIRCULAR-ATTRIBUTE-GROUP': 'error', 'XSD-CIRCULAR-SUBSTITUTION': 'error', 'XSD-INVALID-DERIVATION': 'error', 'XSD-INVALID-FACET': 'error',
  'XSD-INVALID-DEFAULT': 'error', 'XSD-INVALID-OCCURS': 'error', 'XSD-ALL-OCCURS': 'info', 'XSD-INVALID-NAME': 'error', 'XSD-MISSING-NAME': 'error',
  'XSD-REF-AND-NAME': 'error', 'XSD-NOT-ALLOWED-HERE': 'error', 'XSD-DEFAULT-AND-FIXED': 'error', 'XSD-UNKNOWN-ELEMENT': 'error',
  'XSD-INCONSISTENT-ELEMENT': 'warning', 'XSD-MISSING-FILE': 'error', 'XSD-MISSING-SCHEMA-LOCATION': 'error', 'XSD-UNREACHABLE-IMPORT': 'warning',
  'XSD-NOT-A-SCHEMA': 'error', 'XSD-TARGET-NAMESPACE': 'error', 'XSD-CHAMELEON-INCLUDE': 'info', 'XSD-SET-TOO-LARGE': 'info',
  'XSD-PATTERN-NOT-CHECKED': 'info', 'XSD-UNKNOWN-ATTRIBUTE': 'error'
};

function own(list) { return list; }

/**
 * Returns the problems of the file `uri` in a loaded set: [{ code, severity, message, start, end }],
 * sorted by position. Includes the well-formedness problems of the file.
 */
function checkFile(set, uri) {
  const out = [];
  const parsedEntry = set.parsedByUri.get(uri);
  if (parsedEntry && parsedEntry.parsed) {
    for (const e of parsedEntry.parsed.errors) out.push({ code: e.code, severity: 'error', message: e.message, start: e.start, end: e.end });
  }
  const docs = set.docsOfUri(uri);
  for (const doc of docs) checkDoc(set, doc, out);
  const wsdl = set.wsdlDocs.find(function (w) { return w.uri === uri; });
  if (wsdl) WC.checkWsdl(set, wsdl, out);
  for (const p of set.problems) if (p.uri === uri) out.push({ code: p.code, severity: p.severity, message: p.message, start: p.start, end: p.end });
  if (set.truncated && uri === set.entryUri) out.push({ code: 'XSD-SET-TOO-LARGE', severity: 'info', message: 'The schema set has more documents than the limit; some imported or included documents were not loaded.', start: 0, end: 1 });
  const seen = new Set();
  return own(out.filter(function (p) {
    const k = p.code + '|' + p.start + '|' + p.message;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort(function (a, b) { return a.start - b.start || a.end - b.end; }));
}

function push(out, code, message, start, end, severity) {
  out.push({ code: code, severity: severity || CODES[code] || 'error', message: message, start: start, end: Math.max(start + 1, end) });
}

function nameRange(el) {
  const n = P.attrNode(el, 'name') || P.attrNode(el, 'ref');
  return n ? [n.valueStart, n.valueEnd] : [el.start + 1, el.nameEnd];
}

function checkDoc(set, doc, out) {
  const root = doc.root;
  const tnsAttr = P.attrNode(root, 'targetNamespace');
  if (tnsAttr && tnsAttr.value === '') push(out, 'XSD-TARGET-NAMESPACE', 'targetNamespace must not be empty. Leave the attribute out for a schema without a namespace.', tnsAttr.start, tnsAttr.end);
  checkDirectives(set, doc, out);
  const visible = new Set([doc.ns, XSD]);
  for (const n of doc.importedNamespaces) visible.add(n);
  if (doc.targetNamespace === null) visible.add('');
  const types = [];
  const valueChecks = [];
  S.walkXsd(root, function (el) {
    if (el.local === 'annotation') return false;
    if (!KNOWN.has(el.local)) {
      push(out, 'XSD-UNKNOWN-ELEMENT', 'xs:' + el.local + ' is not an element of XML Schema.', el.start + 1, el.nameEnd);
      return false;
    }
    const parent = el.parent;
    const isGlobal = parent && parent.ns === XSD && (parent.local === 'schema' || parent.local === 'redefine' || parent.local === 'override');
    checkAttributeNames(el, out);
    if (NAMED.indexOf(el.local) !== -1) checkNames(el, isGlobal, out);
    if (el.local === 'element' || el.local === 'attribute') checkDeclaration(el, isGlobal, out, valueChecks);
    if (['element', 'any', 'group', 'sequence', 'choice', 'all'].indexOf(el.local) !== -1 && !isGlobal) checkOccurs(el, out);
    if (el.local === 'complexType' || el.local === 'simpleType') types.push(el);
    const refs = REFS[el.local];
    if (refs) {
      for (const [attrName, space, isList] of refs) {
        const a = P.attrNode(el, attrName);
        if (!a) continue;
        checkRefValue(set, doc, el, a, space, isList, visible, out);
      }
    }
    return true;
  });
  // Type definitions: derivation, facets.
  for (const t of types) {
    const comp = t.parent && t.parent.ns === XSD && (t.parent.local === 'schema' || t.parent.local === 'redefine' || t.parent.local === 'override') ? componentFor(set, doc, t) : null;
    const def = C.defOfNode(set, doc, t, comp);
    const target = def.category === 'simple' ? def : def.contentKind === 'simple' && def.simpleDef && def.simpleDef.synthetic ? def.simpleDef : null;
    if (target && target.ownFacets) {
      for (const f of F.checkRestrictionFacets(target)) push(out, 'XSD-INVALID-FACET', f.message, f.node.start + 1, f.node.nameEnd);
      for (const lvl of target.ownFacets.patterns) for (const p of lvl) {
        const c = require('./xsdregex').compile(p.value);
        if (!c.ok && c.unsupported) push(out, 'XSD-PATTERN-NOT-CHECKED', 'The pattern "' + p.value + '" is not checked by this extension: ' + c.message, p.node.start + 1, p.node.nameEnd);
        else if (c.ok && c.risky) push(out, 'XSD-PATTERN-NOT-CHECKED', 'The pattern "' + p.value + '" repeats a part that itself repeats; to stay fast, default, fixed and enumeration values are not tested against it.', p.node.start + 1, p.node.nameEnd);
      }
    }
    if (def.category === 'complex' && def.particle) checkConsistent(set, def, out);
  }
  // Default and fixed values.
  for (const v of valueChecks) {
    let def;
    if (v.el.local === 'element') def = C.elementType(set, refParticle(set, doc, v.el));
    else {
      const node = v.el;
      const use = C.attributeUses(set, doc, { children: [node] }, null).values().next().value;
      def = C.attributeType(set, use);
    }
    const simple = F.simpleOf(def);
    if (!simple) {
      if (def.category === 'complex' && def.contentKind !== 'mixed') push(out, 'XSD-INVALID-DEFAULT', 'A ' + v.which + ' value needs a simple type or mixed content; this element has element-only or empty content.', v.attr.start, v.attr.end);
      continue;
    }
    const r = F.checkValue(simple, v.attr.value);
    if (r) push(out, 'XSD-INVALID-DEFAULT', 'The ' + v.which + ' value "' + U.shorten(v.attr.value, 60) + '" is not valid for the type: ' + r + '.', v.attr.valueStart - 1, v.attr.valueEnd + 1);
  }
  // Substitution group cycles.
  for (const c of set.all('element')) {
    if (c.doc !== doc) continue;
    const seen = new Set([c.key]);
    let cur = c;
    for (let i = 0; i < 50; i++) {
      const sg = P.attr(cur.node, 'substitutionGroup');
      if (!sg) break;
      const r = set.resolveRef(cur.doc, cur.node, sg.trim().split(/\s+/)[0], 'element');
      if (!r.comp) break;
      if (seen.has(r.comp.key)) {
        const a = P.attrNode(c.node, 'substitutionGroup');
        push(out, 'XSD-CIRCULAR-SUBSTITUTION', 'The element "' + c.name + '" is (indirectly) in its own substitution group.', a.valueStart, a.valueEnd);
        break;
      }
      seen.add(r.comp.key);
      cur = r.comp;
    }
  }
}

function componentFor(set, doc, node) {
  const name = P.attr(node, 'name');
  if (name === undefined) return null;
  const list = set.components.get(S.key('type', doc.ns, name)) || [];
  return list.find(function (c) { return c.node === node; }) || { kind: node.local, space: 'type', name: name, ns: doc.ns, node: node, doc: doc, key: S.key('type', doc.ns, name), loc: S.locationOf(doc, node) };
}

function refParticle(set, doc, el) {
  const isGlobal = el.parent && el.parent.ns === XSD && (el.parent.local === 'schema' || el.parent.local === 'redefine' || el.parent.local === 'override');
  if (isGlobal) {
    const list = set.components.get(S.key('element', doc.ns, P.attr(el, 'name') || '')) || [];
    const comp = list.find(function (c) { return c.node === el; });
    if (comp) return C.elementOfComp(set, comp);
  }
  return C.particleOf(set, doc, el, null, []);
}

function checkNames(el, isGlobal, out) {
  const nameAttr = P.attrNode(el, 'name');
  const refAttr = P.attrNode(el, 'ref');
  if (nameAttr && !P.isNCName(nameAttr.value)) push(out, 'XSD-INVALID-NAME', '"' + nameAttr.value + '" is not a valid name (letters, digits, ".", "-", "_" and no colon; not starting with a digit).', nameAttr.valueStart, nameAttr.valueEnd);
  const kind = el.local;
  if (isGlobal) {
    if (!nameAttr) push(out, 'XSD-MISSING-NAME', 'A top-level xs:' + kind + ' needs a name.', el.start + 1, el.nameEnd);
    if (refAttr) push(out, 'XSD-NOT-ALLOWED-HERE', 'A top-level xs:' + kind + ' cannot use ref.', refAttr.start, refAttr.end);
    for (const bad of ['minOccurs', 'maxOccurs', 'form', 'use']) {
      const a = P.attrNode(el, bad);
      if (a && (kind === 'element' || kind === 'attribute' || kind === 'group')) push(out, 'XSD-NOT-ALLOWED-HERE', 'The attribute "' + bad + '" is not allowed on a top-level xs:' + kind + '.', a.start, a.end);
    }
  } else if (kind === 'complexType' || kind === 'simpleType') {
    if (nameAttr) push(out, 'XSD-NOT-ALLOWED-HERE', 'A nested (anonymous) xs:' + kind + ' must not have a name.', nameAttr.start, nameAttr.end);
  } else if (kind === 'element' || kind === 'attribute') {
    if (nameAttr && refAttr) push(out, 'XSD-REF-AND-NAME', 'An xs:' + kind + ' has either a name or a ref, not both.', refAttr.start, refAttr.end);
    else if (!nameAttr && !refAttr) push(out, 'XSD-MISSING-NAME', 'A local xs:' + kind + ' needs a name or a ref.', el.start + 1, el.nameEnd);
  } else if (kind === 'key' || kind === 'unique' || kind === 'keyref' || kind === 'notation') {
    if (!nameAttr && !refAttr) push(out, 'XSD-MISSING-NAME', 'An xs:' + kind + ' needs a name.', el.start + 1, el.nameEnd);
  }
}

function checkDeclaration(el, isGlobal, out, valueChecks) {
  const d = P.attrNode(el, 'default');
  const f = P.attrNode(el, 'fixed');
  if (d && f) push(out, 'XSD-DEFAULT-AND-FIXED', 'Use either default or fixed, not both.', f.start, f.end);
  const refAttr = P.attrNode(el, 'ref');
  if (refAttr && !isGlobal) {
    const t = P.attrNode(el, 'type');
    if (t) push(out, 'XSD-NOT-ALLOWED-HERE', 'An xs:' + el.local + ' with ref takes its type from the referenced declaration; type is not allowed.', t.start, t.end);
    if (C.xsKids(el).some(function (k) { return k.local === 'complexType' || k.local === 'simpleType'; })) push(out, 'XSD-NOT-ALLOWED-HERE', 'An xs:' + el.local + ' with ref cannot contain its own type.', refAttr.start, refAttr.end);
  } else {
    const t = P.attrNode(el, 'type');
    if (t && C.xsKids(el).some(function (k) { return k.local === 'complexType' || k.local === 'simpleType'; })) {
      push(out, 'XSD-NOT-ALLOWED-HERE', 'An xs:' + el.local + ' has either a type attribute or an inline type, not both.', t.start, t.end);
    }
  }
  if (el.local === 'attribute') {
    const use = P.attrNode(el, 'use');
    if (use && ['optional', 'required', 'prohibited'].indexOf(use.value) === -1) push(out, 'XSD-NOT-ALLOWED-HERE', 'use must be optional, required or prohibited.', use.start, use.end);
    if (use && use.value === 'required' && d) push(out, 'XSD-NOT-ALLOWED-HERE', 'A required attribute cannot have a default value.', d.start, d.end);
  }
  if (d && !(f)) valueChecks.push({ el: el, attr: d, which: 'default' });
  if (f) valueChecks.push({ el: el, attr: f, which: 'fixed' });
}

function checkOccurs(el, out) {
  const o = C.occurs(el);
  const a = P.attrNode(el, 'minOccurs') || P.attrNode(el, 'maxOccurs');
  if (o.bad) push(out, 'XSD-INVALID-OCCURS', 'minOccurs must be a whole number and maxOccurs a whole number or "unbounded".', a.start, a.end);
  else if (o.min > o.max) push(out, 'XSD-INVALID-OCCURS', 'minOccurs (' + o.min + ') is larger than maxOccurs (' + o.max + ').', a.start, a.end);
  if (el.parent && el.parent.ns === XSD && el.parent.local === 'all' && o.max > 1) {
    const m = P.attrNode(el, 'maxOccurs');
    push(out, 'XSD-ALL-OCCURS', 'Inside xs:all, maxOccurs above 1 is only allowed in XML Schema 1.1.', m.start, m.end);
  }
}

function checkRefValue(set, doc, el, a, space, isList, visible, out) {
  const raw = a.value;
  const tokens = [];
  if (isList) {
    const re = /\S+/g;
    let m;
    while ((m = re.exec(raw)) !== null) tokens.push({ value: m[0], offset: m.index });
  } else tokens.push({ value: raw.trim(), offset: raw.length - raw.trimStart().length });
  for (const t of tokens) {
    const start = a.valueStart + t.offset;
    const end = start + t.value.length;
    if (!t.value || !P.isQName(t.value)) {
      push(out, UNRESOLVED_CODE[space], '"' + t.value + '" is not a valid qualified name.', start, end);
      continue;
    }
    const r = set.resolveQName(doc, el, t.value);
    if (r.error) {
      push(out, 'XSD-UNDECLARED-PREFIX', 'The prefix "' + r.prefix + '" is not declared (add xmlns:' + r.prefix + '="..." to the schema element).', start, start + r.prefix.length);
      continue;
    }
    if (space !== 'identity' && !visible.has(r.ns) && r.ns !== S.XML_NS) {
      push(out, 'XSD-NAMESPACE-NOT-IMPORTED', 'The namespace "' + r.ns + '" is used here but this schema document does not import it. Add <xs:import namespace="' + r.ns + '"/>.', start, end, doc.embedded ? 'warning' : 'error');
      if (!set.lookup(space, r.ns, r.local)) continue;
    }
    const comp = set.lookup(space, r.ns, r.local);
    if (comp) continue;
    if (set.unreachableNamespaces.has(r.ns)) continue;
    if (r.ns === XSD && space === 'type') {
      push(out, 'XSD-UNRESOLVED-TYPE', '"' + r.local + '" is not a built-in type of XML Schema.', start, end);
      continue;
    }
    push(out, UNRESOLVED_CODE[space], 'No ' + SPACE_WORD[space] + ' named "' + r.local + '"' + (r.ns ? ' in the namespace "' + r.ns + '"' : ' without namespace') + ' is declared in the loaded schemas.', start, end);
  }
}

function checkConsistent(set, def, out) {
  const seen = new Map();
  for (const e of C.flattenElements(def.particle)) {
    const p = e.particle;
    if (p.p !== 'element' || p.typeNode || p.unresolved) continue;
    const k = '{' + p.ns + '}' + p.name;
    const t = p.typeValue === null || p.typeValue === undefined ? '' : (function () {
      const r = set.resolveQName(p.declDoc, p.decl, p.typeValue);
      return r.error ? p.typeValue : '{' + r.ns + '}' + r.local;
    })();
    if (seen.has(k) && seen.get(k).t !== t && p.doc === def.doc && p.origin === def) {
      const range = nameRange(p.node);
      push(out, 'XSD-INCONSISTENT-ELEMENT', 'The element "' + p.name + '" appears twice in this content with different types; documents cannot tell the two apart.', range[0], range[1]);
    } else if (!seen.has(k)) seen.set(k, { t: t });
  }
}

function checkDirectives(set, doc, out) {
  for (const d of doc.directives) {
    const n = d.node;
    const locAttr = P.attrNode(n, 'schemaLocation');
    const nsAttr = P.attrNode(n, 'namespace');
    const at = locAttr ? [locAttr.valueStart, locAttr.valueEnd] : [n.start + 1, n.nameEnd];
    const where = d.location ? '"' + d.location + '"' : '';
    switch (d.status) {
      case 'missing':
        push(out, 'XSD-MISSING-FILE', 'The file ' + where + ' named in schemaLocation was not found' + (d.resolved ? ' (looked for ' + U.baseName(d.resolved) + ' next to this file)' : '') + '.' + (d.kind === 'import' ? ' References into its namespace are not checked.' : ''), at[0], at[1], d.kind === 'import' ? 'warning' : 'error');
        break;
      case 'remote':
        push(out, 'XSD-UNREACHABLE-IMPORT', 'The location ' + where + (d.remoteKind === 'host'
          ? ' is on another computer (for example a network share) and is not loaded automatically, so that opening a file never makes this computer contact a host named in it.'
          : ' is on the internet and is not loaded (this extension makes no network requests for schemas).') +
          ' References into "' + (d.namespace || '') + '" are not checked. Keep a local copy and point schemaLocation at it to check them.', at[0], at[1], d.kind === 'import' ? 'info' : 'warning');
        break;
      case 'none':
        if (d.kind === 'import' && !set.loadedNamespaces.has(d.namespace === null ? '' : d.namespace)) {
          push(out, 'XSD-UNREACHABLE-IMPORT', 'This import has no schemaLocation and no loaded schema has the namespace "' + (d.namespace || '') + '", so references into it are not checked.', at[0], at[1], 'warning');
        }
        break;
      case 'error':
        if (!d.location) push(out, 'XSD-MISSING-SCHEMA-LOCATION', 'xs:' + d.kind + ' needs a schemaLocation.', n.start + 1, n.nameEnd);
        else push(out, 'XSD-MISSING-FILE', 'The location ' + where + ' cannot be resolved from this file.', at[0], at[1]);
        break;
      case 'not-schema':
        push(out, 'XSD-NOT-A-SCHEMA', 'The file ' + where + ' is not an XML Schema document (its root element is not xs:schema).', at[0], at[1]);
        break;
      case 'limit':
        push(out, 'XSD-SET-TOO-LARGE', 'The file ' + where + ' was not loaded because the schema set reached its size or document limit.', at[0], at[1], 'info');
        break;
      default:
        break;
    }
    if (d.kind === 'import') {
      const ns = d.namespace === null ? '' : d.namespace;
      if (ns === doc.ns && doc.targetNamespace !== null) push(out, 'XSD-TARGET-NAMESPACE', 'An import must name a namespace other than this schema\'s own targetNamespace ("' + ns + '"). Use xs:include for files of the same namespace.', nsAttr ? nsAttr.start : n.start + 1, nsAttr ? nsAttr.end : n.nameEnd);
      else if (d.namespace === null && doc.targetNamespace === null) push(out, 'XSD-TARGET-NAMESPACE', 'A schema without targetNamespace cannot import another schema without namespace. Use xs:include instead.', n.start + 1, n.nameEnd);
      if (d.target && (d.target.targetNamespace === null ? '' : d.target.targetNamespace) !== ns) {
        push(out, 'XSD-TARGET-NAMESPACE', 'The imported file has the targetNamespace "' + (d.target.targetNamespace || '') + '", but the import names "' + ns + '".', at[0], at[1]);
      }
    } else if (d.target) {
      const tns = d.target.targetNamespace;
      if (tns !== null && tns !== doc.ns) {
        push(out, 'XSD-TARGET-NAMESPACE', 'The ' + d.kind + 'd file has the targetNamespace "' + tns + '", which differs from this schema\'s "' + doc.ns + '". Included files must share the namespace or have none.', at[0], at[1]);
      } else if (tns === null && doc.ns) {
        push(out, 'XSD-CHAMELEON-INCLUDE', 'The ' + d.kind + 'd file has no targetNamespace; its declarations take this schema\'s namespace "' + doc.ns + '".', at[0], at[1], 'info');
      }
    }
  }
}

module.exports = { checkFile: checkFile, CODES: CODES };
