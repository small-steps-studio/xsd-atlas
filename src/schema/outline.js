'use strict';
// The outline of one schema or WSDL file, as a plain tree: folders by kind of component, then the
// declared structure of each component (compositors, local elements, attributes, facets). Every
// node carries its range in the file so the editor can reveal it. Used by the tree view and by the
// document symbols (Outline view and breadcrumbs).

const P = require('../xml/parser');
const B = require('./builtins');
const S = require('./set');
const C = require('./content');
const W = require('../wsdl/read');
const U = require('../util');

const XSD = B.XSD_NS;
const MAX_DEPTH = 14;
const MAX_CHILDREN = 2000;

function node(kind, label, detail, el, children, extra) {
  return Object.assign({
    kind: kind, label: label, detail: detail || '', start: el ? el.start : 0, end: el ? el.end : 0,
    selStart: el ? selStartOf(el) : 0, selEnd: el ? selEndOf(el) : 0, children: children || [], tooltip: ''
  }, extra || {});
}

function selStartOf(el) { const a = P.attrNode(el, 'name') || P.attrNode(el, 'ref'); return a ? a.valueStart : el.start + 1; }
function selEndOf(el) { const a = P.attrNode(el, 'name') || P.attrNode(el, 'ref'); return a ? a.valueEnd : el.nameEnd; }

function folder(label, kind, children) {
  if (!children.length) return null;
  const start = Math.min.apply(null, children.map(function (c) { return c.start; }));
  const end = Math.max.apply(null, children.map(function (c) { return c.end; }));
  return { kind: 'folder', folderOf: kind, label: label, detail: String(children.length), start: start, end: end, selStart: start, selEnd: start, children: children, tooltip: '' };
}

function occ(el) {
  const o = C.occurs(el);
  return o.min === 1 && o.max === 1 ? '' : ' [' + U.occursText(o.min, o.max) + ']';
}

function typeText(el) {
  const t = P.attr(el, 'type');
  if (t !== undefined) return t;
  const r = P.attr(el, 'ref');
  if (r !== undefined) return 'ref';
  const inline = C.xsKids(el).find(function (k) { return k.local === 'complexType' || k.local === 'simpleType'; });
  return inline ? '(' + (inline.local === 'complexType' ? 'complex' : 'simple') + ')' : '';
}

function docTip(doc, el) { return C.documentation(doc, el); }

// Declared structure below a schema node.
function structure(doc, el, depth) {
  if (depth > MAX_DEPTH) return [];
  const out = [];
  for (const k of C.xsKids(el)) {
    if (out.length >= MAX_CHILDREN) break;
    switch (k.local) {
      case 'element': {
        const isRef = P.attr(k, 'ref') !== undefined;
        const name = isRef ? P.attr(k, 'ref') : P.attr(k, 'name') || '?';
        const inline = C.xsKids(k).find(function (x) { return x.local === 'complexType' || x.local === 'simpleType'; });
        const kids = inline ? structure(doc, inline, depth + 1) : [];
        out.push(node('element', name, (isRef ? 'ref' : typeText(k)) + occ(k), k, kids, { tooltip: docTip(doc, k) }));
        break;
      }
      case 'attribute': {
        const isRef = P.attr(k, 'ref') !== undefined;
        const name = '@' + (isRef ? P.attr(k, 'ref') : P.attr(k, 'name') || '?');
        const use = P.attr(k, 'use');
        const inline = C.xsKids(k).find(function (x) { return x.local === 'simpleType'; });
        out.push(node('attribute', name, (isRef ? 'ref' : typeText(k)) + (use && use !== 'optional' ? ' ' + use : ''), k, inline ? structure(doc, inline, depth + 1) : [], { tooltip: docTip(doc, k) }));
        break;
      }
      case 'sequence': case 'choice': case 'all':
        out.push(node('compositor', k.local, occ(k).trim(), k, structure(doc, k, depth + 1)));
        break;
      case 'group':
        if (P.attr(k, 'ref') !== undefined) out.push(node('groupRef', 'group ' + P.attr(k, 'ref'), occ(k).trim(), k, []));
        else out.push.apply(out, structure(doc, k, depth + 1));
        break;
      case 'attributeGroup':
        if (P.attr(k, 'ref') !== undefined) out.push(node('attributeGroupRef', 'attribute group ' + P.attr(k, 'ref'), '', k, []));
        break;
      case 'any':
        out.push(node('any', 'any element', (P.attr(k, 'namespace') || '##any') + occ(k), k, []));
        break;
      case 'anyAttribute':
        out.push(node('any', 'any attribute', P.attr(k, 'namespace') || '##any', k, []));
        break;
      case 'complexContent': case 'simpleContent': {
        const d = C.xsKids(k).find(function (x) { return x.local === 'extension' || x.local === 'restriction'; });
        if (d) out.push(node('derivation', d.local + ' of ' + (P.attr(d, 'base') || '?'), k.local === 'simpleContent' ? 'simple content' : '', d, structure(doc, d, depth + 1)));
        break;
      }
      case 'restriction': case 'extension': {
        const facets = C.xsKids(k).filter(function (x) { return C.FACET_NAMES.indexOf(x.local) !== -1; });
        const enums = facets.filter(function (x) { return x.local === 'enumeration'; });
        const rest = [];
        if (enums.length) rest.push(node('facet', 'enumeration', enums.map(function (e) { return P.attr(e, 'value'); }).join(', '), enums[0], enums.map(function (e) { return node('facetValue', P.attr(e, 'value') || '', '', e, [], { tooltip: docTip(doc, e) }); })));
        for (const f of facets) if (f.local !== 'enumeration') rest.push(node('facet', f.local, P.attr(f, 'value') || P.attr(f, 'test') || '', f, []));
        out.push(node('derivation', k.local + ' of ' + (P.attr(k, 'base') || '(inline type)'), '', k, rest.concat(structure(doc, k, depth + 1).filter(function (x) { return x.kind !== 'facet'; }))));
        break;
      }
      case 'list':
        out.push(node('derivation', 'list of ' + (P.attr(k, 'itemType') || '(inline type)'), '', k, structure(doc, k, depth + 1)));
        break;
      case 'union':
        out.push(node('derivation', 'union of ' + (P.attr(k, 'memberTypes') || '(inline types)'), '', k, structure(doc, k, depth + 1)));
        break;
      case 'simpleType': case 'complexType':
        out.push(node(k.local, '(' + (k.local === 'simpleType' ? 'simple' : 'complex') + ' type)', '', k, structure(doc, k, depth + 1)));
        break;
      case 'key': case 'unique': case 'keyref':
        out.push(node('identity', k.local + ' ' + (P.attr(k, 'name') || ''), P.attr(k, 'refer') || '', k, []));
        break;
      default:
        break;
    }
  }
  return out;
}

function componentNode(set, doc, el) {
  const name = P.attr(el, 'name') || '?';
  let detail = '';
  if (el.local === 'element') detail = typeText(el);
  else if (el.local === 'attribute') detail = typeText(el);
  else if (el.local === 'complexType') {
    const cc = C.xsKids(el).find(function (k) { return k.local === 'complexContent' || k.local === 'simpleContent'; });
    const d = cc ? C.xsKids(cc).find(function (k) { return k.local === 'extension' || k.local === 'restriction'; }) : null;
    detail = d ? (d.local === 'extension' ? 'extends ' : 'restricts ') + (P.attr(d, 'base') || '') : '';
    if (C.flag(el, 'abstract')) detail = (detail ? detail + ', ' : '') + 'abstract';
  } else if (el.local === 'simpleType') {
    const d = C.xsKids(el)[0];
    detail = d ? (d.local === 'restriction' ? P.attr(d, 'base') || '' : d.local) : '';
  }
  if (el.local === 'element' && P.attr(el, 'substitutionGroup')) detail += ' → ' + P.attr(el, 'substitutionGroup');
  return node(el.local, name, detail, el, structure(doc, el, 1), { tooltip: docTip(doc, el) });
}

const FOLDERS = [
  ['element', 'Elements'], ['complexType', 'Complex types'], ['simpleType', 'Simple types'], ['attribute', 'Attributes'],
  ['group', 'Groups'], ['attributeGroup', 'Attribute groups'], ['notation', 'Notations']
];

const STATUS_TEXT = {
  loaded: 'loaded', missing: 'file not found', remote: 'remote location, not loaded', none: 'by namespace', satisfied: 'by namespace (loaded)',
  builtin: 'built in', error: 'location missing or invalid', 'not-schema': 'not a schema', limit: 'not loaded (limit)'
};

/** The outline of one schema document (top-level or embedded). */
function schemaOutline(set, doc) {
  const directives = doc.directives.map(function (d) {
    const label = d.kind + ' ' + (d.kind === 'import' ? (d.namespace || '(no namespace)') : (d.location || ''));
    const detail = (d.kind === 'import' && d.location ? U.baseName(d.location) + ', ' : '') + (STATUS_TEXT[d.status] || d.status);
    const kids = d.kind === 'redefine' || d.kind === 'override' ? C.xsKids(d.node).filter(function (k) { return S.GLOBAL_KINDS.indexOf(k.local) !== -1; }).map(function (k) { return componentNode(set, doc, k); }) : [];
    return node('directive', label, detail, d.node, kids, { target: d.resolved || '', status: d.status });
  });
  const groups = [];
  const d = folder('Imports and includes', 'directive', directives);
  if (d) groups.push(d);
  const tops = C.xsKids(doc.root);
  for (const [kind, label] of FOLDERS) {
    const f = folder(label, kind, tops.filter(function (k) { return k.local === kind; }).map(function (k) { return componentNode(set, doc, k); }));
    if (f) groups.push(f);
  }
  // Substitution groups whose head is declared in this document.
  const subs = [];
  for (const c of set.all('element')) {
    if (c.doc !== doc) continue;
    const members = set.membersOf(c.key);
    if (members.length) subs.push(node('substitution', c.name, members.length + ' member' + (members.length === 1 ? '' : 's'), c.node, members.map(function (m) { return node('element', m.name, U.baseName(m.doc.uri) === U.baseName(doc.uri) ? '' : U.baseName(m.doc.uri), m.doc === doc ? m.node : null, [], { foreign: m.doc !== doc, targetUri: m.loc.uri, targetStart: m.loc.nameStart }); })));
  }
  const sf = folder('Substitution groups', 'substitution', subs);
  if (sf) groups.push(sf);
  const ids = [];
  S.walkXsd(doc.root, function (el) {
    if (el.local === 'key' || el.local === 'unique' || el.local === 'keyref') ids.push(node('identity', P.attr(el, 'name') || '?', el.local + (P.attr(el, 'refer') ? ' → ' + P.attr(el, 'refer') : ''), el, []));
  });
  const idf = folder('Identity constraints', 'identity', ids);
  if (idf) groups.push(idf);
  const tip = C.documentation(doc, doc.root);
  return node('schema', 'schema', doc.targetNamespace === null ? (doc.chameleon ? '(no namespace, included as ' + doc.ns + ')' : '(no namespace)') : doc.targetNamespace, doc.root, groups, { tooltip: tip + (doc.version ? (tip ? '\n' : '') + 'version ' + doc.version : '') });
}

function wsdlOutline(set, w) {
  const info = w.info;
  const groups = [];
  const imports = info.imports.map(function (i) { return node('directive', i.kind + ' ' + (i.namespace || i.location), U.baseName(i.location) + ', ' + (STATUS_TEXT[i.status] || i.status), i.node, [], { target: i.resolved || '' }); });
  const fi = folder('Imports', 'directive', imports);
  if (fi) groups.push(fi);
  const schemas = set.docs.filter(function (d) { return d.uri === w.uri && d.embedded; }).map(function (d) { return schemaOutline(set, d); });
  const ft = folder('Types', 'schema', schemas);
  if (ft) groups.push(ft);
  const msgs = info.messages.map(function (m) {
    return node('message', m.name, m.parts.length + ' part' + (m.parts.length === 1 ? '' : 's'), m.node, m.parts.map(function (p) {
      return node('part', p.name, p.element ? 'element ' + p.element.value : p.type ? 'type ' + p.type.value : '', p.node, []);
    }));
  });
  const fm = folder('Messages', 'message', msgs);
  if (fm) groups.push(fm);
  const itfs = info.interfaces.map(function (i) {
    return node('interface', i.name, i.operations.length + ' operation' + (i.operations.length === 1 ? '' : 's'), i.node, i.operations.map(function (o) {
      const parts = [];
      for (const [which, io] of [['input', o.input], ['output', o.output]]) {
        if (io) parts.push(node('io', which, io.message ? io.message.value : io.element ? io.element.value : '', io.node, []));
      }
      for (const f of o.faults) parts.push(node('io', 'fault ' + (f.name || ''), f.message ? f.message.value : f.ref ? f.ref.value : '', f.node, []));
      return node('operation', o.name, o.pattern || '', o.node, parts);
    }));
  });
  const fp = folder(info.version === '2.0' ? 'Interfaces' : 'Port types', 'interface', itfs);
  if (fp) groups.push(fp);
  const binds = info.bindings.map(function (b) {
    return node('binding', b.name, (b.soap ? 'SOAP ' + b.soap : b.protocol || '') + (b.type ? ', ' + b.type.value : ''), b.node, b.operations.map(function (o) {
      return node('operation', o.name, o.soapAction ? 'action ' + o.soapAction : '', o.node, []);
    }));
  });
  const fb = folder('Bindings', 'binding', binds);
  if (fb) groups.push(fb);
  const svcs = info.services.map(function (s) {
    return node('service', s.name, s.ports.length + (info.version === '2.0' ? ' endpoint' : ' port') + (s.ports.length === 1 ? '' : 's'), s.node, s.ports.map(function (p) {
      return node('port', p.name, (p.binding ? p.binding.value : '') + (p.address ? ' at ' + p.address : ''), p.node, []);
    }));
  });
  const fs = folder('Services', 'service', svcs);
  if (fs) groups.push(fs);
  return node('wsdl', info.version === '2.0' ? 'description' : 'definitions', info.targetNamespace + ' (WSDL ' + info.version + ')', info.root, groups);
}

/** The outline of the file `uri` in a loaded set: an array of root nodes (empty for other files). */
function outlineOf(set, uri) {
  const w = set.wsdlDocs.find(function (x) { return x.uri === uri; });
  if (w) return [wsdlOutline(set, w)];
  return set.docsOfUri(uri).filter(function (d) { return !d.embedded; }).slice(0, 1).map(function (d) { return schemaOutline(set, d); });
}

module.exports = { outlineOf: outlineOf, schemaOutline: schemaOutline, wsdlOutline: wsdlOutline, W: W };
