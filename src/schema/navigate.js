'use strict';
// Navigation over schema and WSDL documents: what is under the cursor (a reference, a declaration
// name or a schemaLocation), where it is defined, where it is used (in a loaded set and in any
// parsed file of the workspace) and the instance path of the declaration at the cursor.

const P = require('../xml/parser');
const B = require('./builtins');
const S = require('./set');
const W = require('../wsdl/read');
const WC = require('../wsdl/check');

const XSD = B.XSD_NS;

// QName attributes of XSD elements: local name -> [[attribute, space, list?]].
const XSD_REFS = {
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
// QName attributes of WSDL elements: [namespace, local] -> [[attribute, space, list?]]. The spaces
// "message", "interface" and "binding" are WSDL symbol spaces; "element" and "type" are schema ones.
const WSDL_REFS = [
  [W.WSDL11, 'part', [['element', 'element', false], ['type', 'type', false]]],
  [W.WSDL11, 'input', [['message', 'message', false]]],
  [W.WSDL11, 'output', [['message', 'message', false]]],
  [W.WSDL11, 'fault', [['message', 'message', false]]],
  [W.WSDL11, 'binding', [['type', 'interface', false]]],
  [W.WSDL11, 'port', [['binding', 'binding', false]]],
  [W.SOAP11_BINDING, 'header', [['message', 'message', false]]],
  [W.SOAP12_BINDING, 'header', [['message', 'message', false]]],
  [W.WSDL20, 'input', [['element', 'element', false]]],
  [W.WSDL20, 'output', [['element', 'element', false]]],
  [W.WSDL20, 'fault', [['element', 'element', false]]],
  [W.WSDL20, 'binding', [['interface', 'interface', false]]],
  [W.WSDL20, 'endpoint', [['binding', 'binding', false]]],
  [W.WSDL20, 'service', [['interface', 'interface', false]]],
  [W.WSDL20, 'interface', [['extends', 'interface', true]]]
];
const WSDL_DECLS = { message: 'message', portType: 'interface', interface: 'interface', binding: 'binding', service: 'service' };
const SCHEMA_SPACES = ['type', 'element', 'attribute', 'group', 'attributeGroup', 'identity', 'notation'];

function refSpecFor(el) {
  if (el.ns === XSD) return XSD_REFS[el.local] || null;
  for (const r of WSDL_REFS) if (r[0] === el.ns && r[1] === el.local) return r[2];
  return null;
}

function tokensOf(attr, isList) {
  const raw = attr.value;
  const out = [];
  if (isList) {
    const re = /\S+/g;
    let m;
    while ((m = re.exec(raw)) !== null) out.push({ value: m[0], start: attr.valueStart + m.index, end: attr.valueStart + m.index + m[0].length });
  } else {
    const lead = raw.length - raw.trimStart().length;
    const v = raw.trim();
    out.push({ value: v, start: attr.valueStart + lead, end: attr.valueStart + lead + v.length });
  }
  return out;
}

// Chameleon-aware QName resolution for one document (doc may be null for WSDL attributes).
function resolveIn(doc, node, value) {
  const qn = P.splitQName(value);
  let ns = P.lookupNamespace(node, qn.prefix);
  if (ns === null) return null;
  if (!qn.prefix && ns === '' && doc && doc.chameleon) ns = doc.ns;
  return { ns: ns, local: qn.local };
}

/** The schema document (XSD or embedded) of a loaded set that contains `offset` in file `uri`. */
function docAt(set, uri, offset) {
  const docs = set.docsOfUri(uri);
  for (const d of docs) if (offset >= d.root.start && offset <= d.root.end) return d;
  return docs.length === 1 && !docs[0].embedded ? docs[0] : null;
}

function parsedOf(set, uri) {
  const e = set.parsedByUri.get(uri);
  return e && e.parsed ? e.parsed : null;
}

/**
 * What is at `offset` in file `uri`: { what: 'ref', space, ns, local, start, end, node } for a
 * reference, { what: 'decl', space, ns, local, start, end, node } on the name of a declaration,
 * { what: 'location', target, start, end } on a schemaLocation / location, or null.
 */
function targetAt(set, uri, offset) {
  const parsed = parsedOf(set, uri);
  if (!parsed || !parsed.root) return null;
  const el = P.elementAt(parsed.root, offset);
  if (!el) return null;
  const a = P.attrAt(el, offset);
  if (!a || offset < a.valueStart || offset > a.valueEnd) return null;
  const doc = docAt(set, uri, offset);
  if ((a.local === 'schemaLocation' && el.ns === XSD) || (a.local === 'location' && (el.ns === W.WSDL11 || el.ns === W.WSDL20) && (el.local === 'import' || el.local === 'include'))) {
    const U = require('../util');
    return { what: 'location', target: U.resolveUri(a.value, uri), start: a.valueStart, end: a.valueEnd, node: el };
  }
  if (a.local === 'name' && a.prefix === '') {
    if (el.ns === XSD && S.SPACE_OF[el.local] && doc) {
      const parent = el.parent;
      const isGlobal = parent && parent.ns === XSD && (parent.local === 'schema' || parent.local === 'redefine' || parent.local === 'override');
      const space = S.SPACE_OF[el.local];
      if (isGlobal || space === 'identity') return { what: 'decl', space: space, ns: doc.ns, local: a.value, start: a.valueStart, end: a.valueEnd, node: el, doc: doc };
      return { what: 'local', space: space, local: a.value, start: a.valueStart, end: a.valueEnd, node: el, doc: doc };
    }
    if ((el.ns === W.WSDL11 || el.ns === W.WSDL20) && WSDL_DECLS[el.local] && el.parent && el.parent === parsed.root) {
      const tns = P.attr(parsed.root, 'targetNamespace') || '';
      return { what: 'decl', space: WSDL_DECLS[el.local], ns: tns, local: a.value, start: a.valueStart, end: a.valueEnd, node: el };
    }
    return null;
  }
  const spec = refSpecFor(el);
  if (!spec) return null;
  for (const [attrName, space, isList] of spec) {
    if (a.local !== attrName || a.prefix !== '') continue;
    for (const t of tokensOf(a, isList)) {
      if (offset < t.start || offset > t.end) continue;
      const r = resolveIn(el.ns === XSD ? doc : null, el, t.value);
      if (!r) return { what: 'ref', space: space, ns: null, local: P.splitQName(t.value).local, start: t.start, end: t.end, node: el, unresolvedPrefix: true };
      return { what: 'ref', space: space, ns: r.ns, local: r.local, start: t.start, end: t.end, node: el, doc: doc };
    }
  }
  return null;
}

/** The component (schema or WSDL) a target names, or null. Built-in types give a stand-in. */
function componentOf(set, target) {
  if (!target || target.ns === null || target.ns === undefined) return null;
  if (SCHEMA_SPACES.indexOf(target.space) !== -1) return set.lookup(target.space, target.ns, target.local);
  const hit = WC.wsdlIndex(set).map.get(WC.wkey(target.space, target.ns, target.local));
  if (!hit) return null;
  const n = P.attrNode(hit.item.node, 'name');
  return {
    wsdl: true, kind: target.space, space: target.space, name: hit.item.name, ns: target.ns, node: hit.item.node, item: hit.item,
    key: WC.wkey(target.space, target.ns, target.local),
    loc: { uri: hit.wsdl.uri, start: hit.item.node.start, end: hit.item.node.end, nameStart: n ? n.valueStart : hit.item.node.start, nameEnd: n ? n.valueEnd : hit.item.node.nameEnd }
  };
}

/** Definition locations for the cursor: [{ uri, start, end }] (offsets in that file). */
function definitionAt(set, uri, offset) {
  const t = targetAt(set, uri, offset);
  if (!t) return [];
  if (t.what === 'location') return t.target && !require('../util').foreignLocation(t.target, uri) ? [{ uri: t.target, start: 0, end: 0, file: true }] : [];
  if (t.what === 'local') return [];
  const comp = componentOf(set, t);
  if (!comp || comp.builtin || !comp.loc) return [];
  const out = [{ uri: comp.loc.uri, start: comp.loc.nameStart, end: comp.loc.nameEnd }];
  if (comp.redefined && comp.original) out.push({ uri: comp.original.loc.uri, start: comp.original.loc.nameStart, end: comp.original.loc.nameEnd });
  return out;
}

/**
 * Every reference in one parsed file to the component { space, ns, local }. `parsed` is a parse
 * result, `uri` its file. Works without loading imports: QNames resolve through the namespace
 * declarations in scope. A file without targetNamespace may be a chameleon include; its
 * unprefixed references count when the local name matches (marked `possible`).
 */
function referencesInFile(parsed, uri, target) {
  const out = [];
  if (!parsed || !parsed.root) return out;
  const stack = [parsed.root];
  // Find the chameleon state of each embedded or top-level schema element.
  while (stack.length) {
    const el = stack.pop();
    const spec = refSpecFor(el);
    if (spec) {
      for (const [attrName, space, isList] of spec) {
        if (space !== target.space) continue;
        const a = P.attrNode(el, attrName);
        if (!a) continue;
        for (const t of tokensOf(a, isList)) {
          const qn = P.splitQName(t.value);
          if (qn.local !== target.local) continue;
          const ns = P.lookupNamespace(el, qn.prefix);
          if (ns === null) continue;
          if (ns === target.ns) out.push({ uri: uri, start: t.start, end: t.end });
          else if (!qn.prefix && ns === '' && el.ns === XSD && schemaWithoutNamespace(el)) out.push({ uri: uri, start: t.start, end: t.end, possible: true });
        }
      }
    }
    const kids = el.children;
    if (kids) for (let i = kids.length - 1; i >= 0; i--) if (kids[i] instanceof P.XmlElement) stack.push(kids[i]);
  }
  return out;
}

function schemaWithoutNamespace(el) {
  for (let e = el; e; e = e.parent) if (e.ns === XSD && e.local === 'schema') return P.attr(e, 'targetNamespace') === undefined;
  return false;
}

/** References to a target inside a loaded set (all its files), declaration excluded. */
function referencesInSet(set, target) {
  const out = [];
  for (const [uri, entry] of set.parsedByUri) {
    if (!entry.parsed) continue;
    for (const r of referencesInFile(entry.parsed, uri, target)) {
      if (r.possible) {
        const docs = set.docsOfUri(uri);
        const chameleonNs = docs.some(function (d) { return d.chameleon && d.ns === target.ns; });
        if (!chameleonNs) continue;
        delete r.possible;
      }
      out.push(r);
    }
  }
  return out;
}

const NAMED_SCHEMA = ['element', 'attribute', 'group', 'attributeGroup', 'complexType', 'simpleType'];

function nameOf(el) {
  const n = P.attr(el, 'name');
  if (n !== undefined) return n;
  const r = P.attr(el, 'ref');
  return r !== undefined ? P.splitQName(r.trim()).local : '';
}

/**
 * The instance path of the schema declaration at `offset`: { text, segments, top } where `text`
 * is like "/order/lines/line/@number" for a global element, "OrderType: lines/line" for a named
 * type, "group Items: item" for a group; null outside any declaration. For WSDL files the path
 * names the WSDL parts ("binding OrderBinding / operation submit / input").
 */
function pathAt(parsed, offset) {
  if (!parsed || !parsed.root) return null;
  const el = P.elementAt(parsed.root, offset);
  if (!el) return null;
  const chain = [];
  for (let e = el; e; e = e.parent) chain.unshift(e);
  // WSDL path (outside embedded schemas).
  const schemaIdx = chain.findIndex(function (e) { return e.ns === XSD && e.local === 'schema'; });
  if (schemaIdx === -1) {
    const parts = chain.filter(function (e) { return e.ns === W.WSDL11 || e.ns === W.WSDL20; }).slice(1)
      .map(function (e) { const n = P.attr(e, 'name') || P.attr(e, 'ref'); return e.local + (n ? ' ' + n : ''); });
    return parts.length ? { text: parts.join(' / '), segments: parts, top: 'wsdl' } : null;
  }
  const inner = chain.slice(schemaIdx + 1).filter(function (e) { return e.ns === XSD; });
  if (!inner.length) return null;
  let start = 0;
  if (inner[0].local === 'redefine' || inner[0].local === 'override') start = 1;
  const top = inner[start];
  if (!top) return null;
  const segs = [];
  for (let i = start + 1; i < inner.length; i++) {
    const e = inner[i];
    if (e.local === 'annotation') break;
    if (e.local === 'element') segs.push(nameOf(e));
    else if (e.local === 'attribute') segs.push('@' + nameOf(e));
    else if (e.local === 'any') segs.push('*');
    else if (e.local === 'anyAttribute') segs.push('@*');
    else if (e.local === 'group' && P.attr(e, 'ref')) segs.push('(' + nameOf(e) + ')');
    else if (e.local === 'attributeGroup' && P.attr(e, 'ref')) segs.push('(@' + nameOf(e) + ')');
  }
  const topName = nameOf(top);
  let text;
  if (top.local === 'element') text = '/' + [topName].concat(segs).join('/');
  else if (top.local === 'attribute') text = '@' + topName;
  else if (NAMED_SCHEMA.indexOf(top.local) !== -1) text = (top.local === 'complexType' || top.local === 'simpleType' ? '' : top.local === 'attributeGroup' ? 'attribute group ' : 'group ') + topName + (segs.length ? ': ' + segs.join('/') : '');
  else text = top.local + (topName ? ' ' + topName : '');
  return { text: text, segments: [topName].concat(segs), top: top.local };
}

module.exports = {
  targetAt: targetAt, componentOf: componentOf, definitionAt: definitionAt, referencesInFile: referencesInFile, referencesInSet: referencesInSet,
  pathAt: pathAt, docAt: docAt, XSD_REFS: XSD_REFS, WSDL_REFS: WSDL_REFS, SCHEMA_SPACES: SCHEMA_SPACES
};
