'use strict';
// Loads schema sets for editor documents: reads imported and included files from open editors or
// from disk, caches parsed files by modification time, and keeps one set per document version.
// Also keeps a light index of the global declarations of every schema file in the workspace for
// workspace-wide go to definition and find references.

const { loadSchemaSet, looksLikeSchema, documentKind } = require('./schema/set');
const { decodeBytes } = require('./xml/decode');
const P = require('./xml/parser');
const S = require('./schema/set');
const N = require('./schema/navigate');

const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
// Largest schema set (in characters, all files together) that is analysed at all, also on demand:
// a dense set of this size stays under 1 GB of memory. Larger files are refused with a message.
const MAX_ANALYSIS_MB = 32;
const MAX_ANALYSIS_CHARS = MAX_ANALYSIS_MB * 1024 * 1024;

function createService(app) {
  const vscode = app.vscode;
  const setCache = new Map();
  const fileCache = new Map();
  let generation = 0;
  let workspaceIndex = null;

  function openText(uriText) {
    const d = vscode.workspace.textDocuments.find(function (x) { return x.uri.toString() === uriText; });
    return d ? d.getText() : null;
  }

  function insideWorkspace(uri) {
    try {
      return typeof vscode.workspace.getWorkspaceFolder === 'function' && !!vscode.workspace.getWorkspaceFolder(uri);
    } catch (e) { return false; }
  }

  async function statOf(uri) {
    try { return await vscode.workspace.fs.stat(uri); } catch (e) { return null; }
  }

  /** Reads a file for the loader: open editor text first, then the disk (decoded, cached by mtime). */
  async function read(uriText) {
    const open = openText(uriText);
    if (open !== null) return { text: open };
    let uri;
    try { uri = vscode.Uri.parse(uriText, true); } catch (e) { return { error: 'missing' }; }
    if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote' && uri.scheme !== 'vscode-vfs' && uri.scheme !== 'untitled') return { error: 'missing' };
    // A path on another computer written without a host (\\server\share as an empty-host file
    // URI) is never opened from here; the loader refuses such locations already.
    if (uri.scheme === 'file' && !uri.authority && /^[\\/]{2}/.test(uri.fsPath || '')) return { error: 'missing' };
    // In a workspace that is not trusted, only files of the workspace folders (and open editors,
    // above) are read; a schema location cannot reach anywhere else on this computer.
    if (vscode.workspace.isTrusted === false && !insideWorkspace(uri)) {
      return { error: 'missing', message: 'Files outside the workspace folders are not read in an untrusted workspace.' };
    }
    const st = await statOf(uri);
    if (!st) return { error: 'missing' };
    // Folders and devices are not schema files.
    if (typeof st.type === 'number' && (st.type & 1) === 0) return { error: 'missing' };
    if (st.size > MAX_IMPORT_BYTES) return { error: 'too-large', message: 'The file is larger than 64 MB.' };
    const cached = fileCache.get(uriText);
    if (cached && cached.mtime === st.mtime && cached.size === st.size) return { text: cached.text };
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const d = decodeBytes(bytes);
      if (d.text === null) return { error: 'unreadable', message: d.error };
      fileCache.set(uriText, { mtime: st.mtime, size: st.size, text: d.text });
      if (fileCache.size > 400) fileCache.delete(fileCache.keys().next().value);
      return { text: d.text };
    } catch (e) {
      return { error: 'unreadable', message: e && e.message ? e.message : String(e) };
    }
  }

  /** True when the document is an XSD or WSDL file (by extension or by its first characters). */
  function isSchemaDocument(document) {
    if (!document) return false;
    const path = document.uri.path || '';
    if (/\.(xsd|wsdl)$/i.test(path)) return true;
    if (document.languageId !== 'xml') return false;
    return looksLikeSchema(document.getText().slice(0, 8192));
  }

  function tooLarge(document) {
    return document.getText().length > app.getSettings().maxFileSizeMB * 1024 * 1024;
  }

  /** True above the fixed limit of every analysis, also on demand (memory of the editor host). */
  function beyondLimit(document) {
    return document.getText().length > MAX_ANALYSIS_CHARS;
  }

  /** The loaded set for a document (cached per version and file generation). Null for other files. */
  async function setFor(document, force) {
    if (!isSchemaDocument(document)) return null;
    if (beyondLimit(document)) return null;
    if (!force && tooLarge(document)) return null;
    const key = document.uri.toString();
    const hit = setCache.get(key);
    if (hit && hit.version === document.version && hit.generation === generation) return hit.promise;
    const promise = loadSchemaSet({ uri: key, text: document.getText() }, { read: read, limits: { maxTotalChars: MAX_ANALYSIS_CHARS } }).then(undefined, function () { return null; });
    setCache.set(key, { version: document.version, generation: generation, promise: promise });
    if (setCache.size > 30) setCache.delete(setCache.keys().next().value);
    return promise;
  }

  /** Forget cached files and sets (after a schema file changed on disk or in another editor). */
  function invalidate(uriText) {
    if (uriText) fileCache.delete(uriText);
    generation++;
    if (workspaceIndex && uriText) workspaceIndex.files.delete(uriText);
  }

  /** Schema and WSDL files of the workspace (by the include/exclude settings), at most maxFiles. */
  async function workspaceFiles(token) {
    const s = app.getSettings();
    if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length) return [];
    return vscode.workspace.findFiles(s.workspaceInclude, s.workspaceExclude, s.workspaceMaxFiles, token);
  }

  async function parsedFile(uri) {
    const r = await read(uri.toString());
    if (typeof r.text !== 'string') return null;
    return P.parseXml(r.text);
  }

  /** Index of global declarations in workspace files: Map uri -> { decls: [{ space, ns, local, start, end }], parsed }. */
  async function getWorkspaceIndex(token) {
    if (!workspaceIndex) workspaceIndex = { files: new Map() };
    const uris = await workspaceFiles(token);
    for (const uri of uris) {
      if (token && token.isCancellationRequested) break;
      const k = uri.toString();
      if (workspaceIndex.files.has(k)) continue;
      const parsed = await parsedFile(uri);
      if (!parsed) continue;
      workspaceIndex.files.set(k, { parsed: parsed, decls: declarationsOf(parsed) });
    }
    return workspaceIndex;
  }

  return {
    read: read, isSchemaDocument: isSchemaDocument, tooLarge: tooLarge, beyondLimit: beyondLimit, maxAnalysisMB: MAX_ANALYSIS_MB, setFor: setFor, invalidate: invalidate,
    workspaceFiles: workspaceFiles, getWorkspaceIndex: getWorkspaceIndex, parsedFile: parsedFile, documentKind: documentKind
  };
}

/** Global declarations of a parsed XSD or WSDL file (embedded schemas included). */
function declarationsOf(parsed) {
  const out = [];
  if (!parsed || !parsed.root) return out;
  const schemas = [];
  S.walkXsd(parsed.root, function (el) { if (el.local === 'schema') { schemas.push(el); return false; } return true; });
  for (const s of schemas) {
    const tns = P.attr(s, 'targetNamespace') || '';
    for (const c of P.childElements(s)) {
      const kids = c.ns === S.XSD && (c.local === 'redefine' || c.local === 'override') ? P.childElements(c) : [c];
      for (const k of kids) {
        if (k.ns !== S.XSD || !S.SPACE_OF[k.local]) continue;
        const a = P.attrNode(k, 'name');
        if (a) out.push({ space: S.SPACE_OF[k.local], ns: tns, local: a.value, start: a.valueStart, end: a.valueEnd });
      }
    }
  }
  return out;
}

module.exports = { createService: createService, declarationsOf: declarationsOf, N: N, MAX_ANALYSIS_MB: MAX_ANALYSIS_MB };
