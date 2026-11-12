'use strict';
// Reference documentation for a schema set, in Markdown or HTML: an overview per namespace, every
// global element, type, group and attribute group with its documentation, content table,
// attributes, facets and "used by" list, and an alphabetical type index.

const P = require('../xml/parser');
const C = require('../schema/content');
const N = require('../schema/navigate');
const U = require('../util');

const KIND_TITLE = { element: 'Elements', complexType: 'Complex types', simpleType: 'Simple types', group: 'Groups', attributeGroup: 'Attribute groups', attribute: 'Attributes' };
const ORDER = ['element', 'complexType', 'simpleType', 'group', 'attributeGroup', 'attribute'];

function anchor(comp) { return (comp.kind + '-' + (comp.ns ? comp.ns.replace(/[^A-Za-z0-9]+/g, '-') + '-' : '') + comp.name).toLowerCase().replace(/[^a-z0-9-]/g, '-'); }

/** Builds the neutral content of the documentation; renderers turn it into Markdown or HTML. */
function collect(set, options) {
  const opts = options || {};
  const comps = set.all().filter(function (c) { return ORDER.indexOf(c.kind) !== -1 && (!opts.onlyUris || opts.onlyUris.indexOf(c.doc.uri) !== -1); });
  const byNs = new Map();
  for (const c of comps) {
    if (!byNs.has(c.ns)) byNs.set(c.ns, []);
    byNs.get(c.ns).push(c);
  }
  // "Used by": references to each component inside the set.
  const usedBy = new Map();
  for (const c of comps) {
    const refs = N.referencesInSet(set, { space: c.space, ns: c.ns, local: c.name });
    const users = new Set();
    for (const r of refs) {
      const entry = set.parsedByUri.get(r.uri);
      if (!entry || !entry.parsed) continue;
      const el = P.elementAt(entry.parsed.root, r.start);
      const top = topComponentOf(set, el);
      if (top && top !== c) users.add(top);
    }
    usedBy.set(c, Array.from(users));
  }
  const sections = [];
  for (const [ns, list] of Array.from(byNs.entries()).sort(function (a, b) { return a[0].localeCompare(b[0]); })) {
    const docs = set.docs.filter(function (d) { return d.ns === ns && !d.embedded; });
    const kinds = [];
    for (const k of ORDER) {
      const items = list.filter(function (c) { return c.kind === k; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
      if (!items.length) continue;
      kinds.push({ kind: k, title: KIND_TITLE[k], items: items.map(function (c) { return describe(set, c, usedBy.get(c) || []); }) });
    }
    sections.push({
      ns: ns, files: Array.from(new Set(docs.map(function (d) { return U.baseName(d.uri); }))),
      versions: Array.from(new Set(docs.map(function (d) { return d.version; }).filter(Boolean))),
      intro: docs.map(function (d) { return C.documentation(d, d.root); }).filter(Boolean).join('\n\n'),
      kinds: kinds
    });
  }
  const index = comps.filter(function (c) { return c.space === 'type'; }).sort(function (a, b) { return a.name.localeCompare(b.name) || a.ns.localeCompare(b.ns); })
    .map(function (c) { return { name: c.name, ns: c.ns, anchor: anchor(c), kind: c.kind }; });
  return { sections: sections, index: index, count: comps.length };
}

function topComponentOf(set, el) {
  for (let e = el; e; e = e.parent) {
    const p = e.parent;
    if (p && p.ns === C.S.XSD && (p.local === 'schema' || p.local === 'redefine' || p.local === 'override') && P.attr(e, 'name') !== undefined) {
      const doc = set.docOfNode(e);
      if (!doc) return null;
      const space = C.S.SPACE_OF[e.local];
      const list = space ? set.components.get(C.S.key(space, doc.ns, P.attr(e, 'name'))) : null;
      return list ? list.find(function (c) { return c.node === e; }) || list[0] : null;
    }
  }
  return null;
}

function rowsOfParticle(set, particle) {
  return C.flattenElements(particle).map(function (e) {
    const p = e.particle;
    const choice = e.path.some(function (c) { return c.p === 'choice' && c.items.length > 1; });
    if (p.p === 'any') return { name: '(any element)', type: p.namespace, occurs: U.occursText(p.min, p.max), note: p.processContents, doc: '' };
    const t = C.elementType(set, p);
    return { name: p.name, type: C.typeLabel(t, p.decl), occurs: U.occursText(p.min, p.max), note: choice ? 'choice' : '', doc: U.collapse(C.documentation(p.declDoc, p.decl)) };
  });
}

function rowsOfAttributes(set, map) {
  return Array.from(map.values()).map(function (a) {
    return {
      name: '@' + a.name, type: C.typeLabel(C.attributeType(set, a), a.decl), use: a.use,
      value: a.fixed !== undefined ? 'fixed ' + a.fixed : a.default !== undefined ? 'default ' + a.default : '',
      doc: a.decl ? U.collapse(C.documentation(a.declDoc, a.decl)) : ''
    };
  });
}

function facetsOf(def) {
  const out = [];
  if (!def) return out;
  const f = def.facets || {};
  if (def.variety === 'list') out.push(['list of', C.typeLabel(def.itemDef, def.node)]);
  if (def.variety === 'union') out.push(['union of', (def.memberDefs || []).map(function (m) { return C.typeLabel(m, def.node); }).join(', ')]);
  if (f.enumeration) out.push(['enumeration', f.enumeration.map(function (e) { return e.value; }).join(', ')]);
  for (const lvl of f.patterns || []) out.push(['pattern', lvl.map(function (p) { return p.value; }).join(' | ')]);
  for (const k of ['length', 'minLength', 'maxLength', 'minInclusive', 'minExclusive', 'maxInclusive', 'maxExclusive', 'totalDigits', 'fractionDigits', 'whiteSpace']) if (f[k]) out.push([k, f[k].value]);
  return out;
}

function describe(set, comp, users) {
  const item = { kind: comp.kind, name: comp.name, ns: comp.ns, anchor: anchor(comp), file: U.baseName(comp.loc.uri), line: comp.doc.lines.positionAt(comp.node.start).line + 1, doc: C.documentation(comp.doc, comp.node), usedBy: users.map(function (u) { return { label: u.kind + ' ' + u.name, anchor: anchor(u) }; }) };
  if (comp.kind === 'element') {
    const p = C.elementOfComp(set, comp);
    const def = C.elementType(set, p);
    item.type = C.typeLabel(def, comp.node);
    if (def.category === 'complex' && def.anonymous) { item.content = rowsOfParticle(set, def.particle); item.attributes = rowsOfAttributes(set, def.attributes || new Map()); }
    if (def.category === 'simple' && def.anonymous) item.facets = facetsOf(def);
    item.flags = [p.abstract ? 'abstract' : '', p.nillable ? 'nillable' : '', p.substitutionGroup ? 'substitutes for ' + p.substitutionGroup : ''].filter(Boolean).join(', ');
  } else if (comp.kind === 'complexType' || comp.kind === 'simpleType') {
    const def = C.defOfComp(set, comp);
    const chain = C.baseChain(def).map(function (d) { return C.typeLabel(d, comp.node); });
    item.base = chain.slice(0, 6).join(' > ');
    item.derivation = def.derivation || '';
    if (def.category === 'complex') {
      item.content = def.contentKind === 'simple' ? [] : rowsOfParticle(set, def.particle);
      item.attributes = rowsOfAttributes(set, def.attributes || new Map());
      item.flags = [def.abstract ? 'abstract' : '', def.mixed ? 'mixed content' : '', def.contentKind === 'simple' ? 'text content: ' + C.typeLabel(def.simpleDef, comp.node) : ''].filter(Boolean).join(', ');
      if (def.contentKind === 'simple') item.facets = facetsOf(def.simpleDef);
    } else item.facets = facetsOf(def);
  } else if (comp.kind === 'group') {
    item.content = rowsOfParticle(set, C.groupParticle(set, comp));
  } else if (comp.kind === 'attributeGroup') {
    item.attributes = rowsOfAttributes(set, C.attributeGroupUses(set, comp));
  } else if (comp.kind === 'attribute') {
    const use = C.attributeUses(set, comp.doc, { children: [comp.node] }, null).values().next().value;
    if (use) { item.type = C.typeLabel(C.attributeType(set, use), comp.node); item.facets = facetsOf(C.attributeType(set, use)); }
  }
  return item;
}

function mdTable(head, rows) {
  if (!rows || !rows.length) return [];
  const out = ['| ' + head.join(' | ') + ' |', '| ' + head.map(function () { return '---'; }).join(' | ') + ' |'];
  for (const r of rows) out.push('| ' + r.map(U.escapeMarkdown).join(' | ') + ' |');
  return out;
}

/** Markdown documentation of a set. */
function toMarkdown(set, title, options) {
  const d = collect(set, options);
  const out = ['# ' + U.escapeMarkdown(title || 'Schema documentation'), ''];
  out.push(d.count + ' global components in ' + d.sections.length + ' namespace' + (d.sections.length === 1 ? '' : 's') + '.', '');
  for (const s of d.sections) {
    out.push('## Namespace ' + (s.ns ? '`' + s.ns.replace(/`/g, '') + '`' : '(none)'), '');
    if (s.files.length) out.push('Files: ' + s.files.map(U.escapeMarkdown).join(', ') + (s.versions.length ? '. Version: ' + s.versions.map(U.escapeMarkdown).join(', ') : ''), '');
    if (s.intro) out.push(U.escapeMarkdown(s.intro), '');
    for (const k of s.kinds) {
      out.push('### ' + k.title, '');
      for (const it of k.items) {
        out.push('#### <a id="' + it.anchor + '"></a>' + U.escapeMarkdown(it.name), '');
        out.push('*' + it.kind + '*, ' + U.escapeMarkdown(it.file) + ' line ' + it.line + (it.type ? '. Type: `' + it.type.replace(/`/g, '') + '`' : '') + (it.base ? '. Base: ' + U.escapeMarkdown(it.base) : '') + (it.flags ? '. ' + U.escapeMarkdown(it.flags) : ''), '');
        if (it.doc) out.push(U.escapeMarkdown(it.doc), '');
        out.push.apply(out, mdTable(['Element', 'Type', 'Occurs', 'Note', 'Documentation'], (it.content || []).map(function (r) { return [r.name, r.type, r.occurs, r.note, r.doc]; })));
        if (it.content && it.content.length) out.push('');
        out.push.apply(out, mdTable(['Attribute', 'Type', 'Use', 'Value', 'Documentation'], (it.attributes || []).map(function (r) { return [r.name, r.type, r.use, r.value, r.doc]; })));
        if (it.attributes && it.attributes.length) out.push('');
        out.push.apply(out, mdTable(['Facet', 'Value'], it.facets || []));
        if (it.facets && it.facets.length) out.push('');
        if (it.usedBy.length) out.push('Used by: ' + it.usedBy.map(function (u) { return '[' + U.escapeMarkdown(u.label) + '](#' + u.anchor + ')'; }).join(', '), '');
      }
    }
  }
  if (d.index.length) {
    out.push('## Type index', '');
    for (const t of d.index) out.push('- [' + U.escapeMarkdown(t.name) + '](#' + t.anchor + ')' + (t.ns ? ' (' + U.escapeMarkdown(t.ns) + ')' : ''));
    out.push('');
  }
  return out.join('\n');
}

/** HTML documentation of a set: one self-contained page without scripts. */
function toHtml(set, title, options) {
  const d = collect(set, options);
  const h = U.escapeHtml;
  const table = function (head, rows) {
    if (!rows || !rows.length) return '';
    return '<table><thead><tr>' + head.map(function (x) { return '<th scope="col">' + h(x) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr>' + r.map(function (x) { return '<td>' + h(x) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>';
  };
  const parts = ['<!DOCTYPE html>', '<html lang="en"><head><meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">',
    '<title>' + h(title || 'Schema documentation') + '</title>',
    '<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:2rem;max-width:1100px;color:#1b1f23}table{border-collapse:collapse;width:100%;margin:.5rem 0 1rem}' +
    'th,td{border:1px solid #d0d7de;padding:4px 8px;text-align:left;vertical-align:top;font-size:13px}th{background:#f3f5f7}h4{margin-bottom:.2rem}.meta{color:#57606a;font-size:13px}' +
    'p.doc{white-space:pre-wrap}</style></head><body>', '<h1>' + h(title || 'Schema documentation') + '</h1>',
    '<p>' + d.count + ' global components in ' + d.sections.length + ' namespace' + (d.sections.length === 1 ? '' : 's') + '.</p>'];
  for (const s of d.sections) {
    parts.push('<h2>Namespace ' + (s.ns ? '<code>' + h(s.ns) + '</code>' : '(none)') + '</h2>');
    if (s.files.length) parts.push('<p class="meta">Files: ' + h(s.files.join(', ')) + (s.versions.length ? '. Version: ' + h(s.versions.join(', ')) : '') + '</p>');
    if (s.intro) parts.push('<p class="doc">' + h(s.intro) + '</p>');
    for (const k of s.kinds) {
      parts.push('<h3>' + h(k.title) + '</h3>');
      for (const it of k.items) {
        parts.push('<h4 id="' + h(it.anchor) + '">' + h(it.name) + '</h4>');
        parts.push('<p class="meta">' + h(it.kind) + ', ' + h(it.file) + ' line ' + it.line + (it.type ? '. Type: <code>' + h(it.type) + '</code>' : '') + (it.base ? '. Base: ' + h(it.base) : '') + (it.flags ? '. ' + h(it.flags) : '') + '</p>');
        if (it.doc) parts.push('<p class="doc">' + h(it.doc) + '</p>');
        parts.push(table(['Element', 'Type', 'Occurs', 'Note', 'Documentation'], (it.content || []).map(function (r) { return [r.name, r.type, r.occurs, r.note, r.doc]; })));
        parts.push(table(['Attribute', 'Type', 'Use', 'Value', 'Documentation'], (it.attributes || []).map(function (r) { return [r.name, r.type, r.use, r.value, r.doc]; })));
        parts.push(table(['Facet', 'Value'], it.facets || []));
        if (it.usedBy.length) parts.push('<p class="meta">Used by: ' + it.usedBy.map(function (u) { return '<a href="#' + h(u.anchor) + '">' + h(u.label) + '</a>'; }).join(', ') + '</p>');
      }
    }
  }
  if (d.index.length) {
    parts.push('<h2>Type index</h2><ul>');
    for (const t of d.index) parts.push('<li><a href="#' + h(t.anchor) + '">' + h(t.name) + '</a>' + (t.ns ? ' <span class="meta">' + h(t.ns) + '</span>' : '') + '</li>');
    parts.push('</ul>');
  }
  parts.push('</body></html>');
  return parts.filter(Boolean).join('\n') + '\n';
}

module.exports = { collect: collect, toMarkdown: toMarkdown, toHtml: toHtml, anchor: anchor };
