'use strict';
// Flatten: merges a schema and everything it includes into one schema document per target
// namespace. An XML Schema document can hold only one target namespace, so imported namespaces
// become further documents in the same folder, linked by relative schemaLocation. QName
// references are rewritten to one consistent set of prefixes, chameleon includes take their
// namespace explicitly, and local declarations get an explicit form attribute where the merged
// documents disagreed on elementFormDefault or attributeFormDefault. Sets that use xs:redefine or
// xs:override are refused: merging those would change their meaning.

const P = require('../xml/parser');
const B = require('../schema/builtins');
const S = require('../schema/set');
const U = require('../util');
const C = require('../schema/content');
const F = require('../schema/facets');

const XSD = B.XSD_NS;
const QNAME_ATTRS = {
  element: ['type', 'ref', 'substitutionGroup'], attribute: ['type', 'ref'], group: ['ref'], attributeGroup: ['ref'],
  restriction: ['base'], extension: ['base'], list: ['itemType'], union: ['memberTypes'], keyref: ['refer']
};
const LIST_ATTRS = { substitutionGroup: true, memberTypes: true };

function prefixMapFor(set, namespaces) {
  const map = new Map([[XSD, 'xs']]);
  const used = new Set(['xs', 'xml', 'xmlns']);
  for (const ns of namespaces) {
    if (!ns || map.has(ns)) continue;
    let pick = '';
    for (const d of set.docs) {
      const scope = P.inScopeNamespaces(d.root);
      for (const k of Object.keys(scope)) if (k && scope[k] === ns && !used.has(k)) { pick = k; break; }
      if (pick) break;
    }
    if (!pick) { let i = 1; while (used.has('ns' + i)) i++; pick = 'ns' + i; }
    used.add(pick);
    map.set(ns, pick);
  }
  return map;
}

/** The output prefix of a namespace; one is added to the map when the namespace has none yet. */
function prefixFor(prefixes, ns) {
  if (!prefixes.has(ns)) {
    const used = new Set(Array.from(prefixes.values()).concat(['xs', 'xml', 'xmlns']));
    let i = 1;
    while (used.has('ns' + i)) i++;
    prefixes.set(ns, 'ns' + i);
  }
  return prefixes.get(ns);
}

/** True for a default, fixed or enumeration value whose type derives from xs:QName or xs:NOTATION. */
function qnameValued(set, doc, el, attrName) {
  let def = null;
  try {
    if ((el.local === 'element' || el.local === 'attribute') && (attrName === 'default' || attrName === 'fixed')) {
      const type = P.attr(el, 'type');
      const inline = P.childElements(el).find(function (c) { return c.ns === XSD && (c.local === 'simpleType' || c.local === 'complexType'); });
      if (type !== undefined) def = C.defOfTypeRef(set, doc, el, type, 'anySimpleType').def;
      else if (inline) def = C.defOfNode(set, doc, inline, null);
    } else if (el.local === 'enumeration' && attrName === 'value') {
      let t = el.parent;
      while (t && !(t.ns === XSD && (t.local === 'simpleType' || t.local === 'complexType'))) t = t.parent;
      if (t) {
        const comp = set.all('type').find(function (c) { return c.node === t; }) || null;
        // A restriction keeps the primitive type of its base, which is what the value is read as.
        def = C.defOfNode(set, doc, t, comp);
      }
    }
  } catch (e) { return false; }
  const simple = F.simpleOf(def);
  return !!simple && simple.variety === 'atomic' && (simple.primitive === 'QName' || simple.primitive === 'NOTATION');
}

// Writes a top-level component again from its parse tree: schema elements with the xs prefix,
// QName references with the output prefixes, an explicit form where the merged documents
// disagreed, and foreign markup (appinfo, documentation) with its own namespace declarations.
function copyComponent(set, doc, node, prefixes, form, usedNs, valueNs) {
  const parsed = doc.parsed;
  function attrsOf(el) {
    const out = [];
    let ext = 0;
    for (const a of el.attrs) {
      if (a.ns === P.XMLNS_NS) continue;
      let name = a.local;
      if (a.ns === P.XML_NS) name = 'xml:' + a.local;
      else if (a.ns) { ext++; out.push('xmlns:ext' + ext + '="' + U.escapeXml(a.ns) + '"'); name = 'ext' + ext + ':' + a.local; }
      let value = a.value;
      if (el.ns === XSD && !a.ns && qnameValued(set, doc, el, a.local)) {
        // A default, fixed or enumeration value of a QName or NOTATION type names a namespace
        // through its prefix: it is written with the output prefix of that namespace.
        const r = set.resolveQName(doc, el, value.trim());
        if (!r.error) {
          if (r.ns === P.XML_NS) value = 'xml:' + r.local;
          else if (!r.ns) value = r.local;
          else { value = prefixFor(prefixes, r.ns) + ':' + r.local; if (valueNs) valueNs.add(r.ns); }
        }
      } else if (el.ns === XSD && !a.ns && (QNAME_ATTRS[el.local] || []).indexOf(a.local) !== -1) {
        const parts = LIST_ATTRS[a.local] ? value.trim().split(/\s+/) : [value.trim()];
        value = parts.filter(Boolean).map(function (part) {
          const r = set.resolveQName(doc, el, part);
          if (r.error) return part;
          if (r.ns === P.XML_NS) return 'xml:' + r.local;
          usedNs.add(r.ns);
          return r.ns ? prefixes.get(r.ns) + ':' + r.local : r.local;
        }).join(' ');
      }
      out.push(name + '="' + U.escapeXml(value) + '"');
    }
    if (el.ns === XSD && el !== node && (el.local === 'element' || el.local === 'attribute') && P.attr(el, 'ref') === undefined && P.attr(el, 'name') !== undefined && P.attr(el, 'form') === undefined) {
      const own = el.local === 'element' ? doc.elementFormDefault : doc.attributeFormDefault;
      const target = el.local === 'element' ? form.element : form.attribute;
      if (own !== target) out.push('form="' + own + '"');
    }
    return out;
  }
  function write(el, indent, foreignNs) {
    const isXsd = el.ns === XSD;
    const tag = isXsd ? 'xs:' + el.local : el.local;
    const attrs = attrsOf(el);
    if (!isXsd && el.ns !== foreignNs) attrs.unshift('xmlns="' + U.escapeXml(el.ns) + '"');
    const head = '<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '');
    const kids = el.children || [];
    if (!kids.length) return indent + head + '/>';
    const hasText = kids.some(function (k) { return !(k instanceof P.XmlElement); });
    const childNs = isXsd ? null : el.ns;
    if (hasText) {
      const inner = kids.map(function (k) { return k instanceof P.XmlElement ? write(k, '', childNs) : U.escapeXml(parsed.textOf(k)); }).join('');
      return indent + head + '>' + inner + '</' + tag + '>';
    }
    return [indent + head + '>'].concat(kids.map(function (k) { return write(k, indent + '  ', childNs); })).concat([indent + '</' + tag + '>']).join('\n');
  }
  return write(node, '  ', null);
}

/**
 * Flattens the set whose entry document is an XSD. `baseName` names the output files
 * (<baseName>.xsd for the entry namespace, <baseName>-2.xsd ... for the others).
 * Returns { ok: true, files: [{ name, ns, text, components }], notes } or { ok: false, message }.
 */
function flattenSet(set, baseName) {
  if (set.entryKind !== 'xsd') return { ok: false, message: 'Flatten works on an XSD file; open the schema (not a WSDL) and run it again.' };
  for (const d of set.docs) {
    if (d.directives.some(function (x) { return x.kind === 'redefine' || x.kind === 'override'; })) {
      return { ok: false, message: 'This schema set uses xs:' + d.directives.find(function (x) { return x.kind === 'redefine' || x.kind === 'override'; }).kind + ' (in ' + U.baseName(d.uri) + '). Flatten does not merge redefinitions, because the result would mean something else.' };
    }
  }
  const notes = [];
  const entry = set.docs[0];
  const namespaces = [];
  for (const d of set.docs) if (namespaces.indexOf(d.ns) === -1) namespaces.push(d.ns);
  // The entry namespace first.
  namespaces.sort(function (a, b) { return (a === entry.ns ? -1 : 0) - (b === entry.ns ? -1 : 0); });
  const files = new Map();
  namespaces.forEach(function (ns, i) { files.set(ns, (baseName || 'schema-flat') + (i === 0 ? '' : '-' + (i + 1)) + '.xsd'); });
  const unloaded = Array.from(set.unreachableNamespaces);
  const prefixes = prefixMapFor(set, namespaces.concat(unloaded));
  const out = [];
  for (const ns of namespaces) {
    const docs = set.docs.filter(function (d) { return d.ns === ns; });
    const first = docs.find(function (d) { return !d.chameleon; }) || docs[0];
    const form = { element: first.elementFormDefault, attribute: first.attributeFormDefault };
    const usedNs = new Set();
    const valueNs = new Set();
    const bodies = [];
    const seen = new Set();
    let count = 0;
    for (const d of docs) {
      for (const child of P.childElements(d.root)) {
        if (child.ns !== XSD || ['include', 'import', 'redefine', 'override', 'annotation'].indexOf(child.local) !== -1) continue;
        const name = P.attr(child, 'name');
        const k = S.SPACE_OF[child.local] ? S.key(S.SPACE_OF[child.local], ns, name || '') : child.local + '#' + child.start;
        if (seen.has(k)) continue;
        seen.add(k);
        bodies.push('  <!-- from ' + U.escapeXml(U.baseName(d.uri)).replace(/--/g, '- -') + ' -->\n' + copyComponent(set, d, child, prefixes, form, usedNs, valueNs));
        count++;
      }
    }
    usedNs.delete(ns);
    usedNs.delete(XSD);
    usedNs.delete(P.XML_NS);
    usedNs.delete('');
    const decls = ['xmlns:xs="' + XSD + '"'];
    if (ns) decls.push('xmlns:' + prefixes.get(ns) + '="' + U.escapeXml(ns) + '"');
    for (const u of usedNs) decls.push('xmlns:' + prefixes.get(u) + '="' + U.escapeXml(u) + '"');
    // Namespaces named only by QName values need a declaration, not an import.
    for (const u of valueNs) if (u !== ns && u !== XSD && !usedNs.has(u)) decls.push('xmlns:' + prefixes.get(u) + '="' + U.escapeXml(u) + '"');
    const attrs = decls.concat(ns ? ['targetNamespace="' + U.escapeXml(ns) + '"'] : [])
      .concat(['elementFormDefault="' + form.element + '"', 'attributeFormDefault="' + form.attribute + '"'])
      .concat(first.version ? ['version="' + U.escapeXml(first.version) + '"'] : []);
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<xs:schema ' + attrs.join('\n           ') + '>'];
    const ann = P.childElements(first.root).find(function (c) { return c.ns === XSD && c.local === 'annotation'; });
    if (ann) lines.push(copyComponent(set, first, ann, prefixes, form, new Set()));
    const needXml = docs.some(function (d) { return d.directives.some(function (x) { return x.kind === 'import' && x.namespace === P.XML_NS; }); });
    // Imports: the namespaces that a reference uses, the namespaces the original documents of this
    // namespace imported (also when nothing refers to them: they bring their global declarations
    // into the set), and, in the file of the entry namespace, every other file that was written,
    // so that the entry file alone still makes the whole set available.
    const importNs = new Set(usedNs);
    for (const d of docs) {
      for (const x of d.directives) {
        if (x.kind !== 'import') continue;
        const u = x.namespace === null || x.namespace === undefined ? '' : x.namespace;
        if (u !== ns && u !== XSD && u !== P.XML_NS) importNs.add(u);
      }
    }
    if (ns === entry.ns) for (const u of files.keys()) if (u !== ns) importNs.add(u);
    for (const u of importNs) {
      if (files.has(u)) lines.push('  <xs:import' + (u ? ' namespace="' + U.escapeXml(u) + '"' : '') + ' schemaLocation="' + U.escapeXml(files.get(u)) + '"/>');
      else {
        const orig = docs.map(function (d) { return d.directives.find(function (x) { return x.kind === 'import' && x.namespace === u && x.location; }); }).find(Boolean);
        lines.push('  <xs:import namespace="' + U.escapeXml(u) + '"' + (orig ? ' schemaLocation="' + U.escapeXml(orig.location) + '"' : '') + '/>');
        notes.push('The namespace "' + u + '" was not loaded, so it stays an import' + (orig ? ' of "' + orig.location + '"' : '') + '.');
      }
    }
    if (needXml) {
      const orig = docs.map(function (d) { return d.directives.find(function (x) { return x.kind === 'import' && x.namespace === P.XML_NS; }); }).find(Boolean);
      lines.push('  <xs:import namespace="' + P.XML_NS + '"' + (orig && orig.location ? ' schemaLocation="' + U.escapeXml(orig.location) + '"' : '') + '/>');
    }
    lines.push.apply(lines, bodies);
    lines.push('</xs:schema>', '');
    out.push({ name: files.get(ns), ns: ns, text: lines.join('\n'), components: count });
  }
  if (out.length > 1) notes.push('The set has ' + out.length + ' namespaces; one XSD document can hold only one target namespace, so ' + out.length + ' files were written and linked by import.');
  return { ok: true, files: out, notes: notes };
}

module.exports = { flattenSet: flattenSet };
