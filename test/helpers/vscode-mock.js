'use strict';
// A stand-in for the editor API, large enough to activate the extension and drive its commands
// and providers in unit tests. It records what the extension registers, shows and opens.

const Module = require('node:module');
const { LineIndex } = require('../../src/util');

class Uri {
  constructor(scheme, path, raw) { this.scheme = scheme; this.path = path; this.raw = raw; this.fsPath = path; }
  toString() { return this.raw; }
  static parse(text) { const m = /^([a-zA-Z][\w+.-]*):(.*)$/.exec(text); return new Uri(m ? m[1] : 'file', m ? m[2].replace(/^\/\//, '') : text, text); }
  static file(p) { return Uri.parse('file:///' + p.replace(/\\/g, '/').replace(/^\//, '')); }
  static joinPath(base, name) { return Uri.parse(base.raw.replace(/\/$/, '') + '/' + name); }
}
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range {
  constructor(a, b, c, d) {
    if (a instanceof Position) { this.start = a; this.end = b; } else { this.start = new Position(a, b); this.end = new Position(c, d); }
  }
  contains(r) { const le = (x, y) => x.line < y.line || (x.line === y.line && x.character <= y.character); return le(this.start, r.start) && le(r.end, this.end); }
}
class Selection extends Range {}
class EventEmitter { constructor() { this.listeners = []; this.event = (fn) => { this.listeners.push(fn); return { dispose() {} }; }; } fire(v) { this.listeners.forEach((f) => f(v)); } dispose() {} }

function makeDocument(uriText, text, languageId) {
  const li = new LineIndex(text);
  return {
    uri: Uri.parse(uriText), languageId: languageId || 'xml', version: 1,
    getText: () => text,
    positionAt: (o) => { const p = li.positionAt(o); return new Position(p.line, p.character); },
    offsetAt: (p) => li.offsetAt(p.line, p.character)
  };
}

function createMock(options) {
  const o = options || {};
  const disposable = { dispose() {} };
  const state = {
    commands: new Map(), infoMessages: [], warningMessages: [], errorMessages: [], opened: [], openedDocs: [], clipboard: null,
    inputAnswers: (o.inputAnswers || []).slice(), quickPickAnswers: (o.quickPickAnswers || []).slice(), buttonAnswers: (o.buttonAnswers || []).slice(),
    config: Object.assign({}, o.config || {}), documents: [], diagnostics: new Map(), providers: {}, trees: {}, statusItems: [], written: new Map(), files: new Map(Object.entries(o.files || {}))
  };
  for (const [uri, text] of state.files) state.documents.push(makeDocument(uri, text));
  state.activeTextEditor = o.active ? { document: state.documents.find((d) => d.uri.toString() === o.active), selection: new Selection(0, 0, 0, 0), revealRange() {} } : undefined;
  const nextButton = () => state.buttonAnswers.shift();
  const vscode = {
    Uri: Uri, Position: Position, Range: Range, Selection: Selection, EventEmitter: EventEmitter,
    Location: class { constructor(uri, range) { this.uri = uri; this.range = range; } },
    Hover: class { constructor(contents, range) { this.contents = contents; this.range = range; } },
    MarkdownString: class { constructor(v) { this.value = v; } },
    Diagnostic: class { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    DocumentSymbol: class { constructor(name, detail, kind, range, sel) { Object.assign(this, { name, detail, kind, range, selectionRange: sel, children: [] }); } },
    SymbolKind: new Proxy({}, { get: (t, k) => String(k) }),
    TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15 },
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    version: '1.99.0',
    env: {
      appName: 'Visual Studio Code',
      clipboard: { writeText: async (t) => { state.clipboard = t; } },
      openExternal: async (uri) => { state.opened.push(uri.toString()); return true; }
    },
    extensions: { getExtension: () => undefined },
    commands: {
      registerCommand: (id, fn) => { state.commands.set(id, fn); return disposable; },
      executeCommand: async (id, ...args) => { const fn = state.commands.get(id); if (!fn) return undefined; return fn(...args); }
    },
    languages: {
      createDiagnosticCollection: () => ({ set: (uri, d) => state.diagnostics.set(uri.toString(), d), delete: (uri) => state.diagnostics.delete(uri.toString()), dispose() {} }),
      registerHoverProvider: (s, p) => { state.providers.hover = p; return disposable; },
      registerDefinitionProvider: (s, p) => { state.providers.definition = p; return disposable; },
      registerReferenceProvider: (s, p) => { state.providers.references = p; return disposable; },
      registerDocumentSymbolProvider: (s, p) => { state.providers.symbols = p; return disposable; }
    },
    window: {
      get activeTextEditor() { return state.activeTextEditor; },
      get visibleTextEditors() { return state.activeTextEditor ? [state.activeTextEditor] : []; },
      showInformationMessage: async (text, ...buttons) => { state.infoMessages.push({ text, buttons }); return nextButton(); },
      showWarningMessage: async (text, ...rest) => { state.warningMessages.push({ text, rest }); return nextButton(); },
      showErrorMessage: async (text, ...buttons) => { state.errorMessages.push({ text, buttons }); return nextButton(); },
      showInputBox: async (opts) => { const a = state.inputAnswers.shift(); if (opts && opts.validateInput && a !== undefined) state.lastValidation = opts.validateInput(a); return a; },
      showQuickPick: async (items) => { const want = state.quickPickAnswers.shift(); const list = await items; if (want === undefined) return undefined; return typeof want === 'function' ? list.find(want) : list[want]; },
      showOpenDialog: async () => o.openDialog || undefined,
      showTextDocument: async (doc) => { state.activeTextEditor = { document: doc, selection: new Selection(0, 0, 0, 0), revealRange() {} }; return state.activeTextEditor; },
      createTreeView: (id, opts) => { state.trees[id] = opts.treeDataProvider; return disposable; },
      createStatusBarItem: () => { const item = { text: '', show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} }; state.statusItems.push(item); return item; },
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      setStatusBarMessage: () => disposable,
      withProgress: async (opts, fn) => fn({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => disposable }),
      onDidChangeActiveTextEditor: () => disposable,
      onDidChangeTextEditorSelection: () => disposable
    },
    workspace: {
      get workspaceFolders() { return o.folders || undefined; },
      get isTrusted() { return o.untrusted !== true; },
      getWorkspaceFolder: (uri) => (o.folders || []).find((f) => uri.toString().startsWith(String(f.uri).replace(/\/$/, '') + '/')),
      get textDocuments() { return state.documents; },
      getConfiguration: () => ({ get: (key, fallback) => (key in state.config ? state.config[key] : fallback) }),
      onDidChangeConfiguration: () => disposable, onDidOpenTextDocument: () => disposable, onDidSaveTextDocument: () => disposable,
      onDidChangeTextDocument: () => disposable, onDidCloseTextDocument: () => disposable,
      createFileSystemWatcher: () => ({ onDidChange: () => disposable, onDidCreate: () => disposable, onDidDelete: () => disposable, dispose() {} }),
      openTextDocument: async (arg) => {
        if (arg && arg.content !== undefined) { const d = makeDocument('untitled:Untitled-' + (state.openedDocs.length + 1), arg.content, arg.language); state.openedDocs.push(d); return d; }
        const key = arg.toString();
        return state.documents.find((d) => d.uri.toString() === key) || makeDocument(key, state.written.get(key) || state.files.get(key) || '');
      },
      asRelativePath: (u) => String(u.path || u).replace(/^.*\//, ''),
      findFiles: async () => Array.from(state.files.keys()).filter((k) => /\.(xsd|wsdl)$/.test(k)).map((k) => Uri.parse(k)),
      fs: {
        stat: async (uri) => { const k = uri.toString(); if (state.files.has(k) || state.written.has(k)) return { size: (state.files.get(k) || state.written.get(k)).length, mtime: 1 }; throw new Error('not found'); },
        readFile: async (uri) => { const k = uri.toString(); if (!state.files.has(k)) throw new Error('not found'); return Buffer.from(state.files.get(k), 'utf8'); },
        writeFile: async (uri, data) => { state.written.set(uri.toString(), Buffer.from(data).toString('utf8')); }
      }
    }
  };
  return { vscode: vscode, state: state };
}

function install(mock) {
  const original = Module._load;
  Module._load = function (request) {
    if (request === 'vscode') return mock;
    return original.apply(this, arguments);
  };
  return function uninstall() { Module._load = original; };
}

function makeContext(pkg, extensionMode) {
  const secrets = new Map();
  const global = new Map();
  return {
    subscriptions: [],
    extensionMode: extensionMode || 1,
    extension: { packageJSON: pkg },
    secretsMap: secrets, globalMap: global,
    secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); } },
    globalState: { get: (k) => global.get(k), update: async (k, v) => { if (v === undefined) global.delete(k); else global.set(k, v); } }
  };
}

module.exports = { createMock: createMock, install: install, makeContext: makeContext, Uri: Uri, makeDocument: makeDocument };
