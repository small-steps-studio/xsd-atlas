'use strict';
// Workspace schema inventory: every XSD and WSDL file with its kind, namespace, version, component
// counts and links (include, import, redefine, wsdl:import), who imports whom, missing files,
// namespaces declared by several files, and global types that no scanned file refers to.

const P = require('../xml/parser');
const B = require('../schema/builtins');
const S = require('../schema/set');
const W = require('../wsdl/read');
const N = require('../schema/navigate');
const U = require('../util');

const XSD = B.XSD_NS;

function readOne(file) {
  const parsed = P.parseXml(file.text);
  const kind = S.documentKind(parsed);
  const entry = { uri: file.uri, name: file.rel || U.baseName(file.uri), kind: kind, ns: '', version: '', counts: {}, links: [], errors: parsed.errors.length, parsed: parsed, schemas: [] };
  if (kind === 'xsd') entry.schemas.push(parsed.root);
  if (kind === 'wsdl11' || kind === 'wsdl20') {
    const info = W.readWsdl(parsed, file.uri);
    entry.ns = info.targetNamespace;
    entry.schemas = info.schemas;
    entry.counts = { messages: info.messages.length, interfaces: info.interfaces.length, operations: info.interfaces.reduce(function (n, i) { return n + i.operations.length; }, 0), bindings: info.bindings.length, services: info.services.length };
    for (const imp of info.imports) entry.links.push({ kind: 'wsdl:' + imp.kind, namespace: imp.namespace, location: imp.location, target: imp.location ? U.resolveUri(imp.location, file.uri) : '' });
  }
  for (const s of entry.schemas) {
    const tns = P.attr(s, 'targetNamespace');
    if (kind === 'xsd') { entry.ns = tns === undefined ? '' : tns; entry.version = P.attr(s, 'version') || ''; }
    for (const c of P.childElements(s)) {
      if (c.ns !== XSD) continue;
      if (['include', 'import', 'redefine', 'override'].indexOf(c.local) !== -1) {
        const loc = P.attr(c, 'schemaLocation');
        entry.links.push({ kind: c.local, namespace: P.attr(c, 'namespace') || '', location: loc || '', target: loc ? U.resolveUri(loc, file.uri) : '' });
      } else if (S.GLOBAL_KINDS.indexOf(c.local) !== -1) {
        entry.counts[c.local] = (entry.counts[c.local] || 0) + 1;
      }
    }
  }
  return entry;
}

/**
 * Builds the inventory of `files` ([{ uri, text, rel }]). Returns
 * { files, importedBy, missing, sharedNamespaces, unusedTypes, totals }.
 */
function buildInventory(files) {
  const entries = files.map(readOne);
  const byUri = new Map(entries.map(function (e) { return [e.uri, e]; }));
  const importedBy = new Map();
  const missing = [];
  for (const e of entries) {
    for (const l of e.links) {
      if (!l.location) { l.status = 'by namespace'; continue; }
      if (!l.target) { l.status = 'unresolvable'; missing.push({ from: e.name, link: l }); continue; }
      if (U.isRemote(l.target)) { l.status = 'remote'; continue; }
      const t = byUri.get(l.target) || Array.from(byUri.values()).find(function (x) { return x.uri.toLowerCase() === l.target.toLowerCase(); });
      if (t) {
        l.status = 'found';
        if (!importedBy.has(t.uri)) importedBy.set(t.uri, []);
        importedBy.get(t.uri).push(e.name);
      } else { l.status = 'not found in the scanned files'; missing.push({ from: e.name, link: l }); }
    }
  }
  const byNs = new Map();
  for (const e of entries) {
    if (e.kind === 'other') continue;
    if (!byNs.has(e.ns)) byNs.set(e.ns, []);
    byNs.get(e.ns).push(e.name);
  }
  const shared = Array.from(byNs.entries()).filter(function (x) { return x[1].length > 1; }).map(function (x) { return { ns: x[0], files: x[1] }; });
  // Unused global types: no QName in any scanned file refers to them.
  const referenced = new Set();
  const looseLocal = new Set();
  for (const e of entries) {
    const stack = e.parsed.root ? [e.parsed.root] : [];
    while (stack.length) {
      const el = stack.pop();
      let names = el.ns === XSD ? (N.XSD_REFS[el.local] || []) : [];
      for (const r of N.WSDL_REFS) if (r[0] === el.ns && r[1] === el.local) names = r[2];
      for (const [an, space] of names) {
        if (space !== 'type') continue;
        const a = P.attrNode(el, an);
        if (!a) continue;
        for (const part of a.value.trim().split(/\s+/)) {
          const qn = P.splitQName(part);
          const ns = P.lookupNamespace(el, qn.prefix);
          if (ns === null) continue;
          referenced.add('{' + ns + '}' + qn.local);
          if (!qn.prefix && ns === '') looseLocal.add(qn.local);
        }
      }
      if (el.children) for (const k of el.children) if (k instanceof P.XmlElement) stack.push(k);
    }
  }
  const unusedTypes = [];
  for (const e of entries) {
    for (const s of e.schemas) {
      const tns = P.attr(s, 'targetNamespace') || '';
      for (const c of P.childElements(s)) {
        if (c.ns !== XSD || (c.local !== 'complexType' && c.local !== 'simpleType')) continue;
        const name = P.attr(c, 'name');
        if (!name) continue;
        if (referenced.has('{' + tns + '}' + name)) continue;
        if (!tns && looseLocal.has(name)) continue;
        if (tns === '' && Array.from(referenced).some(function (k) { return k.endsWith('}' + name); })) continue;
        unusedTypes.push({ file: e.name, ns: tns, name: name, kind: c.local });
      }
    }
  }
  const totals = { files: entries.length, xsd: entries.filter(function (e) { return e.kind === 'xsd'; }).length, wsdl: entries.filter(function (e) { return e.kind === 'wsdl11' || e.kind === 'wsdl20'; }).length, withErrors: entries.filter(function (e) { return e.errors > 0; }).length };
  for (const e of entries) { delete e.parsed; delete e.schemas; }
  return { files: entries, importedBy: importedBy, missing: missing, sharedNamespaces: shared, unusedTypes: unusedTypes, totals: totals };
}

function kindText(k) { return k === 'xsd' ? 'XSD' : k === 'wsdl11' ? 'WSDL 1.1' : k === 'wsdl20' ? 'WSDL 2.0' : 'not a schema'; }
function countText(c) { return Object.keys(c).map(function (k) { return c[k] + ' ' + k; }).join(', '); }

function toMarkdown(inv, title) {
  const m = U.escapeMarkdown;
  const out = ['# ' + m(title || 'Schema inventory'), '', inv.totals.files + ' files: ' + inv.totals.xsd + ' XSD, ' + inv.totals.wsdl + ' WSDL' + (inv.totals.withErrors ? ', ' + inv.totals.withErrors + ' not well-formed' : '') + '.', ''];
  out.push('## Files', '', '| File | Kind | Namespace | Version | Components | Links | Used by |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const f of inv.files) {
    out.push('| ' + [f.name, kindText(f.kind) + (f.errors ? ' (' + f.errors + ' XML errors)' : ''), f.ns || '(none)', f.version, countText(f.counts),
      f.links.map(function (l) { return l.kind + ' ' + (l.location || l.namespace) + ' (' + l.status + ')'; }).join('; '), (inv.importedBy.get(f.uri) || []).join(', ')].map(m).join(' | ') + ' |');
  }
  out.push('', '## Missing files', '');
  if (!inv.missing.length) out.push('None.');
  for (const x of inv.missing) out.push('- ' + m(x.from) + ': ' + m(x.link.kind) + ' ' + m(x.link.location) + ' (' + m(x.link.status) + ')');
  out.push('', '## Namespaces declared by more than one file', '');
  if (!inv.sharedNamespaces.length) out.push('None.');
  for (const s of inv.sharedNamespaces) out.push('- ' + m(s.ns || '(none)') + ': ' + m(s.files.join(', ')));
  out.push('', '## Global types no scanned file refers to', '');
  if (!inv.unusedTypes.length) out.push('None.');
  for (const t of inv.unusedTypes) out.push('- ' + m(t.name) + ' (' + m(t.kind) + ', ' + m(t.ns || 'no namespace') + ') in ' + m(t.file));
  out.push('', 'A type listed as unused may still be used by documents through xsi:type or by schemas outside the scanned folders.', '');
  return out.join('\n');
}

function toHtml(inv, title) {
  const h = U.escapeHtml;
  const rows = inv.files.map(function (f) {
    return '<tr><td>' + [f.name, kindText(f.kind) + (f.errors ? ' (' + f.errors + ' XML errors)' : ''), f.ns || '(none)', f.version, countText(f.counts),
      f.links.map(function (l) { return l.kind + ' ' + (l.location || l.namespace) + ' (' + l.status + ')'; }).join('; '), (inv.importedBy.get(f.uri) || []).join(', ')].map(h).join('</td><td>') + '</td></tr>';
  }).join('\n');
  const list = function (items) { return items.length ? '<ul>' + items.map(function (x) { return '<li>' + h(x) + '</li>'; }).join('') + '</ul>' : '<p>None.</p>'; };
  return ['<!DOCTYPE html>', '<html lang="en"><head><meta charset="utf-8">', '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">',
    '<title>' + h(title || 'Schema inventory') + '</title>',
    '<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:2rem;color:#1b1f23}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d0d7de;padding:4px 8px;text-align:left;vertical-align:top;font-size:13px}th{background:#f3f5f7}</style>',
    '</head><body>', '<h1>' + h(title || 'Schema inventory') + '</h1>',
    '<p>' + inv.totals.files + ' files: ' + inv.totals.xsd + ' XSD, ' + inv.totals.wsdl + ' WSDL.</p>',
    '<h2>Files</h2><table><thead><tr><th scope="col">File</th><th scope="col">Kind</th><th scope="col">Namespace</th><th scope="col">Version</th><th scope="col">Components</th><th scope="col">Links</th><th scope="col">Used by</th></tr></thead><tbody>', rows, '</tbody></table>',
    '<h2>Missing files</h2>', list(inv.missing.map(function (x) { return x.from + ': ' + x.link.kind + ' ' + x.link.location + ' (' + x.link.status + ')'; })),
    '<h2>Namespaces declared by more than one file</h2>', list(inv.sharedNamespaces.map(function (s) { return (s.ns || '(none)') + ': ' + s.files.join(', '); })),
    '<h2>Global types no scanned file refers to</h2>', list(inv.unusedTypes.map(function (t) { return t.name + ' (' + t.kind + ', ' + (t.ns || 'no namespace') + ') in ' + t.file; })),
    '<p>A type listed as unused may still be used by documents through xsi:type or by schemas outside the scanned folders.</p>', '</body></html>', ''].join('\n');
}

function toCsv(inv, options) {
  const neutralise = !(options && options.neutralise === false);
  let s = U.csvRow(['file', 'kind', 'namespace', 'version', 'components', 'links', 'used by', 'xml errors'], neutralise);
  for (const f of inv.files) {
    s += U.csvRow([f.name, kindText(f.kind), f.ns, f.version, countText(f.counts), f.links.map(function (l) { return l.kind + ' ' + (l.location || l.namespace) + ' (' + l.status + ')'; }).join('; '), (inv.importedBy.get(f.uri) || []).join('; '), f.errors], neutralise);
  }
  return s;
}

module.exports = { buildInventory: buildInventory, toMarkdown: toMarkdown, toHtml: toHtml, toCsv: toCsv };
