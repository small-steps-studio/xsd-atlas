'use strict';
// Loads a schema set: the entry document (an XSD or a WSDL) and every document reachable through
// include, import, redefine and override (and wsdl:import / wsdl:include), then indexes the global
// components by symbol space and namespace. File access is injected (`read`), so the same code
// runs on the editor's documents, on files on disk and on git revisions. Remote locations
// (http/https) are never fetched.

const P = require('../xml/parser');
const B = require('./builtins');
const U = require('../util');
const W = require('../wsdl/read');

const XSD = B.XSD_NS;
const XML_NS = P.XML_NS;
const XML_ATTRS = ['lang', 'space', 'base', 'id'];

const SPACE_OF = Object.freeze({
  element: 'element', complexType: 'type', simpleType: 'type', attribute: 'attribute',
  group: 'group', attributeGroup: 'attributeGroup', notation: 'notation', key: 'identity', unique: 'identity', keyref: 'identity'
});
const GLOBAL_KINDS = ['element', 'complexType', 'simpleType', 'attribute', 'group', 'attributeGroup', 'notation'];
const DIRECTIVES = ['include', 'import', 'redefine', 'override'];

// maxTotalChars: a dense schema set of 32 MB stays under 1 GB of memory (see service.js).
const DEFAULT_LIMITS = Object.freeze({ maxDocs: 1000, maxTotalChars: 32 * 1024 * 1024 });

function key(space, ns, local) { return space + ' {' + (ns || '') + '}' + local; }

function isXsd(el, local) { return !!el && el.ns === XSD && (local === undefined || el.local === local); }

/** 'xsd', 'wsdl11', 'wsdl20' or 'other', from the root element of a parse result. */
function documentKind(parsed) {
  const r = parsed && parsed.root;
  if (!r) return 'other';
  if (r.ns === XSD && r.local === 'schema') return 'xsd';
  if (r.ns === W.WSDL11 && r.local === 'definitions') return 'wsdl11';
  if (r.ns === W.WSDL20 && r.local === 'description') return 'wsdl20';
  return 'other';
}

/** Cheap check on the first part of a text: does it look like an XSD or WSDL document? */
function looksLikeSchema(text) {
  const head = String(text || '').slice(0, 8192);
  return /<([A-Za-z_][\w.-]*:)?(schema|definitions|description)[\s>/]/.test(head) &&
    /http:\/\/www\.w3\.org\/2001\/XMLSchema|http:\/\/schemas\.xmlsoap\.org\/wsdl\/|http:\/\/www\.w3\.org\/ns\/wsdl/.test(head);
}

class SchemaDoc {
  constructor(uri, parsed, root, options) {
    this.uri = uri;
    this.parsed = parsed;
    this.root = root;
    this.text = parsed.source;
    this.embedded = !!options.embedded;
    this.index = options.index || 0;
    const tns = P.attr(root, 'targetNamespace');
    this.targetNamespace = tns === undefined ? null : tns;
    this.chameleon = this.targetNamespace === null && !!options.chameleonNs;
    this.ns = this.targetNamespace !== null ? this.targetNamespace : (options.chameleonNs || '');
    this.elementFormDefault = P.attr(root, 'elementFormDefault') === 'qualified' ? 'qualified' : 'unqualified';
    this.attributeFormDefault = P.attr(root, 'attributeFormDefault') === 'qualified' ? 'qualified' : 'unqualified';
    this.blockDefault = P.attr(root, 'blockDefault') || '';
    this.finalDefault = P.attr(root, 'finalDefault') || '';
    this.version = P.attr(root, 'version') || '';
    this.directives = [];
    this.importedNamespaces = new Set();
    this.key = uri + (this.embedded ? '#schema' + this.index : '') + (this.chameleon ? '#in{' + this.ns + '}' : '');
  }
  get lines() { return U.linesOf(this.parsed, this.text); }
}

class SchemaSet {
  constructor() {
    this.docs = [];
    this.docByKey = new Map();
    this.wsdlDocs = [];
    this.parsedByUri = new Map();
    this.components = new Map();
    this.problems = [];
    this.loadedNamespaces = new Set();
    this.unreachableNamespaces = new Set();
    this.substitutionMembers = new Map();
    this.entryUri = '';
    this.entryKind = 'other';
    this.cache = new Map();
    this.truncated = false;
  }

  problem(code, severity, message, uri, start, end) {
    this.problems.push({ code: code, severity: severity, message: message, uri: uri, start: start, end: end === undefined ? start + 1 : end });
  }

  /** The schema documents whose text is the file `uri` (several for a WSDL with embedded schemas). */
  docsOfUri(uri) { return this.docs.filter(function (d) { return d.uri === uri; }); }

  /** The schema document that contains `node`. */
  docOfNode(node) {
    let top = node;
    while (top && top.parent) top = top.parent;
    for (const d of this.docs) {
      let r = d.root;
      while (r && r.parent) r = r.parent;
      if (r === top && node.start >= d.root.start && node.end <= d.root.end) return d;
    }
    return null;
  }

  /** Every global component of a symbol space (or of all spaces when omitted). */
  all(space) {
    const out = [];
    for (const list of this.components.values()) for (const c of list) if (!space || c.space === space) out.push(c);
    return out;
  }

  /**
   * Finds a component by symbol space and expanded name. Returns the component, a built-in
   * stand-in ({ builtin: true, ... }) for XSD types and the xml: attributes, or null.
   */
  lookup(space, ns, local) {
    if (space === 'type' && ns === XSD && B.isBuiltin(local)) return builtinType(local);
    if (space === 'attribute' && ns === XML_NS && XML_ATTRS.indexOf(local) !== -1) {
      const own = this.components.get(key(space, ns, local));
      if (own && own.length) return own[0];
      return { builtin: true, kind: 'attribute', space: 'attribute', name: local, ns: XML_NS, key: key('attribute', XML_NS, local) };
    }
    const list = this.components.get(key(space, ns, local));
    return list && list.length ? list[0] : null;
  }

  /**
   * Resolves a QName written in an attribute value of `node` (in schema document `doc`) to
   * { ns, local, prefix } or { error: 'prefix', prefix } when the prefix is not declared.
   */
  resolveQName(doc, node, value) {
    const v = String(value || '').trim();
    const qn = P.splitQName(v);
    let ns = P.lookupNamespace(node, qn.prefix);
    if (ns === null) return { error: 'prefix', prefix: qn.prefix, local: qn.local };
    if (!qn.prefix && ns === '' && doc && doc.chameleon) ns = doc.ns;
    return { ns: ns, local: qn.local, prefix: qn.prefix };
  }

  /** Resolves and looks up a reference: { ref: { ns, local }, comp } (comp null when unresolved). */
  resolveRef(doc, node, value, space) {
    const r = this.resolveQName(doc, node, value);
    if (r.error) return { ref: r, comp: null, error: 'prefix' };
    return { ref: r, comp: this.lookup(space, r.ns, r.local) };
  }

  /** Members of the substitution group headed by a global element component. */
  membersOf(headKey) { return this.substitutionMembers.get(headKey) || []; }
}

const builtinCache = new Map();
function builtinType(local) {
  let b = builtinCache.get(local);
  if (!b) {
    b = Object.freeze({ builtin: true, kind: 'simpleType', space: 'type', name: local, ns: XSD, key: key('type', XSD, local) });
    if (local === 'anyType') b = Object.freeze({ builtin: true, kind: 'complexType', space: 'type', name: local, ns: XSD, key: key('type', XSD, local) });
    builtinCache.set(local, b);
  }
  return b;
}

/** Location record of a node in a document: { uri, start, end, nameStart, nameEnd }. */
function locationOf(doc, node) {
  const nameAttr = P.attrNode(node, 'name');
  return {
    uri: doc.uri,
    start: node.start,
    end: node.end,
    nameStart: nameAttr ? nameAttr.valueStart : node.start + 1,
    nameEnd: nameAttr ? nameAttr.valueEnd : node.nameEnd
  };
}

/**
 * Loads a schema set. `entry` is { uri, text }; `options.read(uri)` resolves to { text } or
 * { error, message } (missing, unreadable, too large). Never rejects.
 */
async function loadSchemaSet(entry, options) {
  const opts = options || {};
  const limits = Object.assign({}, DEFAULT_LIMITS, opts.limits || {});
  const read = typeof opts.read === 'function' ? opts.read : async function () { return { error: 'missing' }; };
  const set = new SchemaSet();
  let totalChars = 0;

  async function getParsed(uri, knownText) {
    if (set.parsedByUri.has(uri)) return set.parsedByUri.get(uri);
    let text = knownText;
    let failure = null;
    if (text === undefined) {
      let r;
      try { r = await read(uri); } catch (e) { r = { error: 'unreadable', message: e && e.message ? e.message : String(e) }; }
      if (!r || typeof r.text !== 'string') failure = r || { error: 'missing' };
      else text = r.text;
    }
    let result;
    if (failure) result = { failure: failure };
    else {
      totalChars += text.length;
      if (totalChars > limits.maxTotalChars) result = { failure: { error: 'too-large', message: 'The schema set is larger than the size limit.' } };
      else result = { parsed: P.parseXml(text) };
    }
    set.parsedByUri.set(uri, result);
    return result;
  }

  const queue = [];

  function enqueueSchema(uri, parsed, root, embeddedIndex, chameleonNs) {
    const doc = new SchemaDoc(uri, parsed, root, { embedded: embeddedIndex !== undefined, index: embeddedIndex, chameleonNs: chameleonNs });
    const existing = set.docByKey.get(doc.key);
    if (existing) return existing;
    if (set.docs.length >= limits.maxDocs) {
      set.truncated = true;
      return null;
    }
    set.docByKey.set(doc.key, doc);
    set.docs.push(doc);
    set.loadedNamespaces.add(doc.ns);
    queue.push(doc);
    return doc;
  }

  async function addWsdl(uri, parsed) {
    if (set.wsdlDocs.some(function (w) { return w.uri === uri; })) return;
    const info = W.readWsdl(parsed, uri);
    set.wsdlDocs.push({ uri: uri, parsed: parsed, info: info });
    info.schemas.forEach(function (node, i) { enqueueSchema(uri, parsed, node, i, ''); });
    for (const imp of info.imports) {
      const resolved = imp.location ? U.resolveUri(imp.location, uri) : '';
      imp.resolved = resolved;
      if (!imp.location) { imp.status = 'none'; continue; }
      if (!resolved) { imp.status = 'error'; continue; }
      const foreign = U.foreignLocation(resolved, uri);
      if (foreign) { imp.status = 'remote'; imp.remoteKind = foreign; continue; }
      const got = await getParsed(resolved);
      if (got.failure) { imp.status = got.failure.error === 'too-large' ? 'limit' : 'missing'; continue; }
      const kind = documentKind(got.parsed);
      imp.status = 'loaded';
      if (kind === 'wsdl11' || kind === 'wsdl20') await addWsdl(resolved, got.parsed);
      else if (kind === 'xsd') enqueueSchema(resolved, got.parsed, got.parsed.root, undefined, '');
      else imp.status = 'not-schema';
    }
  }

  // Entry document (or several entries, for a folder).
  const entries = Array.isArray(entry) ? entry : [entry];
  set.entryUri = entries.length ? entries[0].uri : '';
  set.entryUris = entries.map(function (e) { return e.uri; });
  for (const e of entries) {
    const entryParsed = await getParsed(e.uri, e.text);
    if (entryParsed.failure) continue;
    const kind = documentKind(entryParsed.parsed);
    if (e === entries[0]) set.entryKind = kind;
    if (kind === 'xsd') enqueueSchema(e.uri, entryParsed.parsed, entryParsed.parsed.root, undefined, '');
    else if (kind === 'wsdl11' || kind === 'wsdl20') await addWsdl(e.uri, entryParsed.parsed);
  }
  if (!set.docs.length && !set.wsdlDocs.length) return set;

  // Directives, breadth first.
  while (queue.length) {
    const doc = queue.shift();
    for (const child of P.childElements(doc.root)) {
      if (!isXsd(child) || DIRECTIVES.indexOf(child.local) === -1) continue;
      const nsAttr = P.attr(child, 'namespace');
      const location = P.attr(child, 'schemaLocation');
      const d = {
        kind: child.local, namespace: nsAttr === undefined ? null : nsAttr, location: location === undefined ? null : location,
        node: child, doc: doc, resolved: '', status: 'none', target: null, message: ''
      };
      doc.directives.push(d);
      if (d.kind === 'import') doc.importedNamespaces.add(d.namespace === null ? '' : d.namespace);
      if (d.location === null) {
        d.status = d.kind === 'import' ? 'none' : 'error';
        continue;
      }
      d.resolved = U.resolveUri(d.location, doc.uri);
      if (!d.resolved) { d.status = 'error'; d.message = 'The location cannot be resolved from this document.'; continue; }
      // Locations on the internet or on another computer (a network share) are never read
      // automatically: that would make this computer contact a host named by the file.
      const foreign = U.foreignLocation(d.resolved, doc.uri);
      if (foreign) { d.status = 'remote'; d.remoteKind = foreign; continue; }
      const got = await getParsed(d.resolved);
      if (got.failure) {
        d.status = got.failure.error === 'too-large' ? 'limit' : 'missing';
        d.message = got.failure.message || '';
        continue;
      }
      if (documentKind(got.parsed) !== 'xsd') { d.status = 'not-schema'; continue; }
      const root = got.parsed.root;
      const tns = P.attr(root, 'targetNamespace');
      let chameleonNs = '';
      if (d.kind !== 'import' && tns === undefined && doc.ns) chameleonNs = doc.ns;
      const target = enqueueSchema(d.resolved, got.parsed, root, undefined, chameleonNs);
      if (!target) { d.status = 'limit'; continue; }
      d.target = target;
      d.status = 'loaded';
    }
  }

  // Imports satisfied by namespace.
  for (const doc of set.docs) {
    for (const d of doc.directives) {
      if (d.kind !== 'import' || d.status === 'loaded') continue;
      const ns = d.namespace === null ? '' : d.namespace;
      if (ns === XSD || ns === XML_NS) { d.status = d.status === 'none' || d.status === 'remote' ? 'builtin' : d.status; continue; }
      if (set.loadedNamespaces.has(ns)) { if (d.status === 'none' || d.status === 'remote') d.status = 'satisfied'; continue; }
      set.unreachableNamespaces.add(ns);
    }
  }

  indexComponents(set);
  return set;
}

function addComponent(set, comp) {
  let list = set.components.get(comp.key);
  if (!list) { list = []; set.components.set(comp.key, list); }
  list.push(comp);
}

function makeComponent(doc, node, kind, extra) {
  const name = P.attr(node, 'name');
  const space = SPACE_OF[kind];
  const comp = {
    kind: kind, space: space, name: name || '', ns: doc.ns, node: node, doc: doc,
    key: key(space, doc.ns, name || ''), loc: locationOf(doc, node), redefined: false, original: null
  };
  return Object.assign(comp, extra || {});
}

function indexComponents(set) {
  // Global components; redefine/override children replace what they name.
  const replacements = [];
  for (const doc of set.docs) {
    for (const child of P.childElements(doc.root)) {
      if (!isXsd(child)) continue;
      if (GLOBAL_KINDS.indexOf(child.local) !== -1) {
        if (P.attr(child, 'name') === undefined) continue;
        addComponent(set, makeComponent(doc, child, child.local));
      } else if (child.local === 'redefine' || child.local === 'override') {
        for (const inner of P.childElements(child)) {
          if (!isXsd(inner) || GLOBAL_KINDS.indexOf(inner.local) === -1 || P.attr(inner, 'name') === undefined) continue;
          replacements.push(makeComponent(doc, inner, inner.local, { redefined: true, via: child.local }));
        }
      }
    }
  }
  for (const r of replacements) {
    const list = set.components.get(r.key);
    if (list && list.length) {
      const target = list.findIndex(function (c) { return !c.redefined; });
      if (target !== -1) {
        r.original = list[target];
        list.splice(target, 1, r);
        continue;
      }
    }
    addComponent(set, r);
  }
  // Identity constraints (named, set-wide).
  for (const doc of set.docs) {
    walkXsd(doc.root, function (el) {
      if (el.local === 'key' || el.local === 'unique' || el.local === 'keyref') {
        if (P.attr(el, 'name') !== undefined) addComponent(set, makeComponent(doc, el, el.local));
      }
    });
  }
  // Duplicates.
  for (const list of set.components.values()) {
    if (list.length < 2) continue;
    const first = list[0];
    for (let i = 1; i < list.length; i++) {
      const c = list[i];
      if (c.doc === first.doc && c.node === first.node) continue;
      set.problem('XSD-DUPLICATE-NAME', 'error', 'The ' + label(c.kind) + ' "' + c.name + '" is declared more than once in the namespace "' + c.ns + '" (first in ' + U.baseName(first.doc.uri) + ' line ' + (first.doc.lines.positionAt(first.node.start).line + 1) + ').', c.doc.uri, c.loc.nameStart, c.loc.nameEnd);
    }
  }
  // Substitution groups.
  for (const c of set.all('element')) {
    const sg = P.attr(c.node, 'substitutionGroup');
    if (!sg) continue;
    for (const part of sg.trim().split(/\s+/)) {
      const r = set.resolveRef(c.doc, c.node, part, 'element');
      if (!r.comp) continue;
      let list = set.substitutionMembers.get(r.comp.key);
      if (!list) { list = []; set.substitutionMembers.set(r.comp.key, list); }
      list.push(c);
    }
  }
}

/** Visits every element in the XSD namespace below `root` (iteratively, document order). */
function walkXsd(root, visit) {
  const stack = [root];
  while (stack.length) {
    const el = stack.pop();
    if (el.ns === XSD) { if (visit(el) === false) continue; }
    const kids = el.children;
    if (kids) for (let i = kids.length - 1; i >= 0; i--) if (kids[i] instanceof P.XmlElement) stack.push(kids[i]);
  }
}

function label(kind) {
  switch (kind) {
    case 'complexType': return 'complex type';
    case 'simpleType': return 'simple type';
    case 'attributeGroup': return 'attribute group';
    case 'keyref': return 'key reference';
    default: return kind;
  }
}

module.exports = {
  loadSchemaSet: loadSchemaSet, documentKind: documentKind, looksLikeSchema: looksLikeSchema, key: key, label: label,
  locationOf: locationOf, walkXsd: walkXsd, isXsd: isXsd, SchemaSet: SchemaSet, SchemaDoc: SchemaDoc,
  SPACE_OF: SPACE_OF, GLOBAL_KINDS: GLOBAL_KINDS, XSD: XSD, XML_NS: XML_NS
};
