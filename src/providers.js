'use strict';
// Editor features of the free tier: problems, hover, go to definition, find references, document
// symbols (Outline view and breadcrumbs), the outline tree view and the status bar path.

const { checkFile } = require('./schema/check');
const N = require('./schema/navigate');
const D = require('./schema/describe');
const O = require('./schema/outline');
const U = require('./util');

const DEBOUNCE_MS = 600;
const TYPING_LIMIT = 2 * 1024 * 1024;

function rangeOf(vscode, document, start, end) {
  return new vscode.Range(document.positionAt(start), document.positionAt(Math.max(start, end)));
}

// ---- problems -----------------------------------------------------------------------------------

function createDiagnostics(app) {
  const vscode = app.vscode;
  const collection = vscode.languages.createDiagnosticCollection('xsdAtlas');
  const timers = new Map();
  const summaries = new Map();
  const SEVERITY = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information };

  async function run(document, force) {
    const key = document.uri.toString();
    if (!app.service.isSchemaDocument(document)) { collection.delete(document.uri); summaries.delete(key); return null; }
    if (app.service.beyondLimit && app.service.beyondLimit(document)) {
      collection.delete(document.uri);
      summaries.set(key, { skipped: 'limit' });
      return { skipped: 'limit' };
    }
    if (!force && app.service.tooLarge(document)) {
      collection.delete(document.uri);
      summaries.set(key, { skipped: 'size' });
      return { skipped: 'size' };
    }
    const version = document.version;
    const set = await app.service.setFor(document, force);
    if (!set || document.version !== version) return null;
    const problems = checkFile(set, key);
    const diags = problems.slice(0, app.getSettings().maxProblems).map(function (p) {
      const d = new vscode.Diagnostic(rangeOf(vscode, document, p.start, p.end), p.message, SEVERITY[p.severity] !== undefined ? SEVERITY[p.severity] : vscode.DiagnosticSeverity.Error);
      d.code = p.code;
      d.source = 'XSD Atlas';
      return d;
    });
    collection.set(document.uri, diags);
    const counts = { error: 0, warning: 0, info: 0 };
    for (const p of problems) counts[p.severity === 'warning' ? 'warning' : p.severity === 'info' ? 'info' : 'error']++;
    const summary = { counts: counts, documents: set.docs.length, kind: set.entryKind };
    summaries.set(key, summary);
    return summary;
  }

  function schedule(document) {
    const key = document.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(function () {
      timers.delete(key);
      run(document, false).then(undefined, function () { /* the document was closed meanwhile */ });
    }, DEBOUNCE_MS));
  }

  const subs = [
    collection,
    vscode.workspace.onDidOpenTextDocument(function (d) { schedule(d); }),
    vscode.workspace.onDidSaveTextDocument(function (d) { app.service.invalidate(d.uri.toString()); schedule(d); }),
    vscode.workspace.onDidChangeTextDocument(function (e) {
      if (!app.service.isSchemaDocument(e.document)) return;
      app.service.invalidate();
      if (app.getSettings().validateOnType && e.document.getText().length <= TYPING_LIMIT) schedule(e.document);
    }),
    vscode.workspace.onDidCloseTextDocument(function (d) { collection.delete(d.uri); summaries.delete(d.uri.toString()); })
  ];
  for (const d of vscode.workspace.textDocuments) schedule(d);
  return {
    run: run,
    summaryOf: function (document) { return summaries.get(document.uri.toString()) || null; },
    dispose: function () { for (const t of timers.values()) clearTimeout(t); subs.forEach(function (s) { s.dispose(); }); }
  };
}

// ---- hover, definition, references, symbols ----------------------------------------------------

function registerLanguageFeatures(app) {
  const vscode = app.vscode;
  const selector = [{ language: 'xml' }, { pattern: '**/*.{xsd,wsdl}' }];
  const subs = [];

  async function context(document, position) {
    const set = await app.service.setFor(document, false);
    if (!set) return null;
    const offset = document.offsetAt(position);
    const target = N.targetAt(set, document.uri.toString(), offset);
    return { set: set, offset: offset, target: target };
  }

  subs.push(vscode.languages.registerHoverProvider(selector, {
    provideHover: async function (document, position) {
      if (!app.getSettings().hoverEnabled) return null;
      const c = await context(document, position);
      if (!c || !c.target || c.target.what === 'location') return null;
      const comp = c.target.what === 'local' ? null : N.componentOf(c.set, c.target);
      let text = D.describeTarget(c.set, c.target, comp, c.target.node);
      if (!text && c.target.what === 'ref') {
        const found = await findInWorkspace(app, c.target);
        if (found.length) text = D.code(c.target.local) + ' is declared in ' + U.escapeMarkdown(U.baseName(found[0].uri)) + ', which this schema does not import or include.';
      }
      if (!text) return null;
      const md = new vscode.MarkdownString(text);
      md.isTrusted = false;
      md.supportHtml = false;
      return new vscode.Hover(md, rangeOf(vscode, document, c.target.start, c.target.end));
    }
  }));

  subs.push(vscode.languages.registerDefinitionProvider(selector, {
    provideDefinition: async function (document, position, token) {
      const c = await context(document, position);
      if (!c || !c.target) return null;
      let locs = N.definitionAt(c.set, document.uri.toString(), c.offset);
      if (!locs.length && c.target.what === 'ref') locs = await findInWorkspace(app, c.target, token);
      return toLocations(app, locs);
    }
  }));

  subs.push(vscode.languages.registerReferenceProvider(selector, {
    provideReferences: async function (document, position, ctx, token) {
      const c = await context(document, position);
      if (!c || !c.target || (c.target.what !== 'ref' && c.target.what !== 'decl') || c.target.ns === null) return null;
      const target = { space: c.target.space, ns: c.target.ns, local: c.target.local };
      const seen = new Set();
      const out = [];
      function add(l) { const k = l.uri + '#' + l.start; if (!seen.has(k)) { seen.add(k); out.push(l); } }
      N.referencesInSet(c.set, target).forEach(add);
      const index = await app.service.getWorkspaceIndex(token);
      for (const [uri, entry] of index.files) {
        if (token && token.isCancellationRequested) break;
        if (c.set.parsedByUri.has(uri)) continue;
        N.referencesInFile(entry.parsed, uri, target).filter(function (r) { return !r.possible; }).forEach(add);
      }
      if (ctx && ctx.includeDeclaration) {
        const comp = N.componentOf(c.set, target);
        if (comp && comp.loc) add({ uri: comp.loc.uri, start: comp.loc.nameStart, end: comp.loc.nameEnd });
      }
      return toLocations(app, out);
    }
  }));

  subs.push(vscode.languages.registerDocumentSymbolProvider(selector, {
    provideDocumentSymbols: async function (document) {
      const set = await app.service.setFor(document, false);
      if (!set) return [];
      return O.outlineOf(set, document.uri.toString()).map(function (n) { return toSymbol(vscode, document, n, 0); }).filter(Boolean);
    }
  }, { label: 'XSD Atlas' }));
  return subs;
}

const SYMBOL_KIND = {
  schema: 'Module', wsdl: 'Module', folder: 'Package', element: 'Field', attribute: 'Property', complexType: 'Class', simpleType: 'Enum',
  group: 'Struct', attributeGroup: 'Struct', notation: 'Constant', identity: 'Key', substitution: 'Interface', directive: 'File', compositor: 'Array',
  derivation: 'TypeParameter', facet: 'EnumMember', facetValue: 'EnumMember', any: 'Variable', groupRef: 'Struct', attributeGroupRef: 'Struct',
  message: 'Event', part: 'Field', interface: 'Interface', operation: 'Method', io: 'Event', binding: 'Object', service: 'Namespace', port: 'Constant'
};

function toSymbol(vscode, document, n, depth) {
  if (depth > 30 || n.foreign) return null;
  const kind = vscode.SymbolKind[SYMBOL_KIND[n.kind] || 'Object'];
  const range = rangeOf(vscode, document, n.start, n.end);
  let sel = rangeOf(vscode, document, n.selStart, n.selEnd);
  if (!range.contains(sel)) sel = new vscode.Range(range.start, range.start);
  const sym = new vscode.DocumentSymbol(n.label || '?', n.detail || '', kind, range, sel);
  sym.children = n.children.map(function (c) { return toSymbol(vscode, document, c, depth + 1); }).filter(Boolean);
  return sym;
}

async function toLocations(app, locs) {
  const vscode = app.vscode;
  const out = [];
  for (const l of locs) {
    const uri = vscode.Uri.parse(l.uri, true);
    if (l.file) { out.push(new vscode.Location(uri, new vscode.Position(0, 0))); continue; }
    const r = await app.service.read(l.uri);
    if (typeof r.text !== 'string') continue;
    const li = new U.LineIndex(r.text);
    const a = li.positionAt(l.start);
    const b = li.positionAt(l.end);
    out.push(new vscode.Location(uri, new vscode.Range(a.line, a.character, b.line, b.character)));
  }
  return out;
}

/** Global declarations matching a reference anywhere in the workspace: [{ uri, start, end }]. */
async function findInWorkspace(app, target, token) {
  if (target.ns === null || target.ns === undefined) return [];
  const index = await app.service.getWorkspaceIndex(token);
  const out = [];
  for (const [uri, entry] of index.files) {
    for (const d of entry.decls) if (d.space === target.space && d.ns === target.ns && d.local === target.local) out.push({ uri: uri, start: d.start, end: d.end });
  }
  return out;
}

// ---- outline tree view --------------------------------------------------------------------------

const ICON = {
  schema: 'symbol-namespace', wsdl: 'symbol-namespace', folder: 'folder', element: 'symbol-field', attribute: 'symbol-property', complexType: 'symbol-class',
  simpleType: 'symbol-enum', group: 'symbol-structure', attributeGroup: 'symbol-structure', directive: 'file-symlink-file', compositor: 'list-ordered',
  derivation: 'type-hierarchy-sub', facet: 'symbol-enum-member', facetValue: 'symbol-constant', any: 'symbol-variable', identity: 'key',
  substitution: 'symbol-interface', message: 'mail', part: 'symbol-field', interface: 'symbol-interface', operation: 'symbol-method', io: 'arrow-swap',
  binding: 'plug', service: 'server', port: 'globe', groupRef: 'symbol-structure', attributeGroupRef: 'symbol-structure', notation: 'symbol-constant'
};

function createOutlineTree(app) {
  const vscode = app.vscode;
  const emitter = new vscode.EventEmitter();
  let roots = [];
  let docUri = null;
  let timer = null;

  async function refresh() {
    const editor = vscode.window.activeTextEditor;
    const doc = editor ? editor.document : null;
    if (!doc || !app.service.isSchemaDocument(doc)) {
      // Another kind of editor (a sample just built, for example): the outline keeps showing the
      // last schema for as long as that schema is still open.
      const key = docUri ? docUri.toString() : '';
      const stillOpen = key && vscode.workspace.textDocuments.some(function (d) { return d.uri.toString() === key; });
      if (!stillOpen && (roots.length || docUri)) { roots = []; docUri = null; emitter.fire(undefined); }
      return;
    }
    const set = await app.service.setFor(doc, false);
    roots = set ? O.outlineOf(set, doc.uri.toString()) : [];
    docUri = doc.uri;
    emitter.fire(undefined);
  }
  function later() { clearTimeout(timer); timer = setTimeout(function () { refresh().then(undefined, function () { /* ignore */ }); }, 400); }

  const provider = {
    onDidChangeTreeData: emitter.event,
    getChildren: function (el) { return el ? el.children : roots; },
    getTreeItem: function (n) {
      const item = new vscode.TreeItem(n.label, n.children.length ? (n.kind === 'folder' || n.kind === 'schema' || n.kind === 'wsdl' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None);
      item.description = n.detail;
      item.tooltip = n.tooltip || undefined;
      item.iconPath = new vscode.ThemeIcon(ICON[n.kind] || 'circle-outline');
      item.contextValue = 'xsdAtlas.' + n.kind;
      if (n.kind === 'directive' && n.target && n.status === 'loaded') item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.parse(n.target, true)] };
      else if (n.foreign && n.targetUri) item.command = { command: 'xsdAtlas.revealRange', title: 'Reveal', arguments: [n.targetUri, n.targetStart, n.targetStart] };
      else if (docUri && n.kind !== 'folder') item.command = { command: 'xsdAtlas.revealRange', title: 'Reveal', arguments: [docUri.toString(), n.selStart, n.selEnd] };
      return item;
    }
  };
  const view = vscode.window.createTreeView('xsdAtlas.outline', { treeDataProvider: provider, showCollapseAll: true });
  const subs = [view, emitter,
    vscode.window.onDidChangeActiveTextEditor(later),
    vscode.workspace.onDidChangeTextDocument(function (e) { if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) later(); }),
    vscode.workspace.onDidSaveTextDocument(later),
    vscode.workspace.onDidCloseTextDocument(later)];
  later();
  return { refresh: refresh, dispose: function () { clearTimeout(timer); subs.forEach(function (s) { s.dispose(); }); } };
}

// ---- status bar path ----------------------------------------------------------------------------

function createStatus(app) {
  const vscode = app.vscode;
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.name = 'XSD Atlas path';
  item.command = 'xsdAtlas.copyPath';
  let last = null;
  function update() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !app.service.isSchemaDocument(editor.document)) { item.hide(); return; }
    if (app.service.tooLarge(editor.document)) {
      item.text = '$(symbol-structure) XSD Atlas: file over limit';
      item.tooltip = 'Larger than the xsdAtlas.maxFileSizeMB setting; run "XSD Atlas: Check Current File" to check it on demand.';
      item.show();
      return;
    }
    const parsed = app.parsedOf(editor.document);
    const p = parsed ? N.pathAt(parsed, editor.document.offsetAt(editor.selection.active)) : null;
    last = p;
    const summary = app.diagnostics ? app.diagnostics.summaryOf(editor.document) : null;
    const counts = summary && summary.counts ? ' $(error) ' + summary.counts.error + ' $(warning) ' + summary.counts.warning : '';
    item.text = '$(symbol-structure) ' + (p ? U.shorten(p.text, 70) : 'XSD Atlas') + counts;
    item.tooltip = p ? 'Path of the declaration at the cursor: ' + p.text + '\nClick to copy it.' : 'XSD Atlas';
    item.show();
  }
  const subs = [item,
    vscode.window.onDidChangeTextEditorSelection(function () { update(); }),
    vscode.window.onDidChangeActiveTextEditor(function () { update(); })];
  update();
  return { update: update, current: function () { return last; }, dispose: function () { subs.forEach(function (s) { s.dispose(); }); } };
}

module.exports = { createDiagnostics: createDiagnostics, registerLanguageFeatures: registerLanguageFeatures, createOutlineTree: createOutlineTree, createStatus: createStatus, toLocations: toLocations, findInWorkspace: findInWorkspace, rangeOf: rangeOf };
