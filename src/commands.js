'use strict';
// All commands: free helpers, first-run and support commands, licence and trial commands and the
// Pro commands (comparison, rich samples, documentation, flatten, SOAP envelopes, inventory).

const config = require('./licence/config');
const messages = require('./licence/messages');
const { sampleFor } = require('./samples');
const { diagnosticsBlock, reportProblemText } = require('./support');
const { loadSchemaSet } = require('./schema/set');
const { buildSample, listChoices } = require('./sample/sample');
const N = require('./schema/navigate');
const U = require('./util');

const WALKTHROUGH_ID = 'SmallStepsStudio.xsd-atlas#xsdAtlas.gettingStarted';
const BUTTONS = Object.freeze({ buy: 'Buy Pro', enter: 'Enter Licence Key', lost: 'Lost your key?', remove: 'Remove Licence', report: 'Report A Problem' });
const NAME = config.productName;

// The Pro modules are loaded when first used, which keeps start-up light.
function loadPro(name) {
  switch (name) {
    case 'diff': return require('./pro/diff');
    case 'report': return require('./pro/report');
    case 'docs': return require('./pro/docs');
    case 'flatten': return require('./pro/flatten');
    case 'soap': return require('./pro/soap');
    case 'inventory': return require('./pro/inventory');
    default: throw new Error('unknown module ' + name);
  }
}

function registerCommands(app) {
  const vscode = app.vscode;
  const disposables = [];

  function reg(id, fn) {
    disposables.push(vscode.commands.registerCommand(id, async function () {
      try {
        return await fn.apply(null, arguments);
      } catch (err) {
        const why = err && err.message ? err.message : 'the command could not be completed.';
        vscode.window.showErrorMessage(NAME + ': ' + why + ' If this keeps happening, run "' + NAME + ': Report A Problem".');
        return undefined;
      }
    }));
  }
  function info() { return vscode.window.showInformationMessage.apply(vscode.window, Array.prototype.slice.call(arguments)); }
  function warn(text) { return vscode.window.showWarningMessage(NAME + ': ' + text); }

  async function openExternal(url) {
    try { return await vscode.env.openExternal(vscode.Uri.parse(url)); } catch (e) {
      warn('The link could not be opened by the editor. Open it in your browser: ' + url);
      return false;
    }
  }
  async function handleLicenceButton(pick) {
    if (pick === BUTTONS.buy) await vscode.commands.executeCommand('xsdAtlas.buyPro');
    else if (pick === BUTTONS.enter) await vscode.commands.executeCommand('xsdAtlas.enterKey');
    else if (pick === BUTTONS.remove) await vscode.commands.executeCommand('xsdAtlas.removeLicence');
    else if (pick === BUTTONS.lost) await showLostKey();
  }
  async function showLostKey() {
    const pick = await info(messages.lostKeyText(), BUTTONS.enter, BUTTONS.report);
    if (pick === BUTTONS.enter) await vscode.commands.executeCommand('xsdAtlas.enterKey');
    else if (pick === BUTTONS.report) await vscode.commands.executeCommand('xsdAtlas.reportProblem');
  }

  // ---- Pro gate: licence first, then the free trial -----------------------------------------
  async function requirePro(feature) {
    if (await app.licence.isPro()) return true;
    let trial = await app.licence.checkTrial();
    if (trial.state === 'unused') {
      trial = await app.licence.startTrial();
      if (trial.state === 'active') {
        await app.licence.noteTrialReminder();
        info(messages.trialStartedText(trial), BUTTONS.buy, BUTTONS.enter).then(handleLicenceButton).then(undefined, function () { /* closed */ });
        return true;
      }
    }
    if (trial.state === 'active') {
      await app.licence.touchTrial();
      if (await app.licence.noteTrialReminder()) info(messages.trialReminderText(trial), BUTTONS.buy, BUTTONS.enter).then(handleLicenceButton).then(undefined, function () { /* closed */ });
      return true;
    }
    const pick = await info(messages.proNoticeText(feature, trial), BUTTONS.buy, BUTTONS.enter);
    await handleLicenceButton(pick);
    return false;
  }

  // The active editor when it shows a schema or WSDL file; otherwise says so and returns null.
  function schemaEditor() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !app.service.isSchemaDocument(editor.document)) {
      warn('This command needs an XSD or WSDL file in the active editor. Open one, or run "' + NAME + ': Open Sample Schema" to try one.');
      return null;
    }
    return editor;
  }
  function limitText() {
    return 'This file is larger than ' + app.service.maxAnalysisMB + ' MB, the largest size XSD Atlas analyses, so that the editor never runs out of memory. Split the schema into files that include each other, then open the part you need.';
  }
  async function setOfEditor(editor) {
    if (app.service.beyondLimit && app.service.beyondLimit(editor.document)) { warn(limitText()); return null; }
    const set = await app.service.setFor(editor.document, true);
    if (!set) { warn('The file could not be read as a schema.'); return null; }
    if (!set.docs.length) { warn('No XML Schema was found in this file (its root element is not xs:schema, wsdl:definitions or wsdl:description).'); return null; }
    return set;
  }
  // Opens content in a new unsaved editor. With `name` the editor gets that file name (numbered
  // when it is used already), so that saving proposes a sensible name.
  const untitledNames = new Map();
  async function openText(content, language, name) {
    if (name) {
      try {
        const n = (untitledNames.get(name) || 0) + 1;
        untitledNames.set(name, n);
        const unique = n === 1 ? name : name.replace(/(\.[^.]+)?$/, '-' + n + '$1');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse('untitled:' + unique));
        const editor = await vscode.window.showTextDocument(doc, { preview: false });
        if (editor && typeof editor.edit === 'function' && doc.getText() === '') {
          const ok = await editor.edit(function (b) { b.insert(new vscode.Position(0, 0), content); });
          if (ok) {
            if (language && doc.languageId !== language) await vscode.languages.setTextDocumentLanguage(doc, language).then(undefined, function () { /* keep */ });
            return doc;
          }
        }
      } catch (e) { /* fall back to an editor named by its content */ }
    }
    const doc = await vscode.workspace.openTextDocument({ content: content, language: language });
    await vscode.window.showTextDocument(doc, { preview: false });
    return doc;
  }
  function safeName(s) { return String(s || 'sample').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'sample'; }
  async function pickGlobalElement(set, uri) {
    const own = set.all('element').filter(function (c) { return c.doc.uri === uri; });
    const list = (own.length ? own : set.all('element')).slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    if (!list.length) { warn('This schema set declares no global element, so there is nothing to build a sample for.'); return null; }
    if (list.length === 1) return list[0];
    // Preselect the element whose declaration is at the cursor, when there is one.
    const items = list.map(function (c) { return { label: c.name, description: c.ns || '(no namespace)', detail: U.baseName(c.loc.uri), comp: c }; });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Global element to build a sample for' });
    return pick ? pick.comp : null;
  }

  // ---- free commands -------------------------------------------------------------------------
  reg('xsdAtlas.checkFile', async function () {
    const editor = schemaEditor();
    if (!editor) return;
    const r = await app.diagnostics.run(editor.document, true);
    if (r && r.skipped === 'limit') { warn(limitText()); return; }
    if (r && r.counts) info(NAME + ': ' + r.counts.error + ' errors, ' + r.counts.warning + ' warnings and ' + r.counts.info + ' notes in this file (' + r.documents + ' schema documents loaded).');
  });

  reg('xsdAtlas.copyPath', async function () {
    const editor = schemaEditor();
    if (!editor) return;
    const parsed = app.parsedOf(editor.document);
    const p = parsed ? N.pathAt(parsed, editor.document.offsetAt(editor.selection.active)) : null;
    if (!p) { warn('The cursor is not inside a declaration.'); return; }
    await vscode.env.clipboard.writeText(p.text);
    vscode.window.setStatusBarMessage(NAME + ': copied ' + U.shorten(p.text, 80), 4000);
  });

  reg('xsdAtlas.sampleXml', async function () {
    const editor = schemaEditor();
    if (!editor) return;
    const set = await setOfEditor(editor);
    if (!set) return;
    const comp = await pickGlobalElement(set, editor.document.uri.toString());
    if (!comp) return;
    const r = buildSample(set, comp, { mode: 'minimal' });
    await openText(r.text, 'xml', 'sample-' + safeName(comp.name) + '.xml');
    if (r.notes.length) info(NAME + ': ' + r.notes.join(' '));
  });

  reg('xsdAtlas.refreshOutline', function () { if (app.tree) return app.tree.refresh(); return undefined; });

  reg('xsdAtlas.revealRange', async function (uriText, start, end) {
    const uri = vscode.Uri.parse(String(uriText), true);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false, preview: true });
    const range = new vscode.Range(doc.positionAt(Number(start) || 0), doc.positionAt(Number(end) || Number(start) || 0));
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  });

  async function openSample(kind) {
    const s = sampleFor(kind);
    if (!s) { warn('This installation is incomplete; reinstall the extension.'); return; }
    await openText(s.text, s.languageId, s.fileName);
    vscode.window.setStatusBarMessage(NAME + ': opened the ' + s.title + ' (invented sample)', 5000);
  }
  reg('xsdAtlas.openSampleSchema', function () { return openSample('schema'); });
  reg('xsdAtlas.openSampleSchemaV2', function () { return openSample('schemaV2'); });
  reg('xsdAtlas.openSampleWsdl', function () { return openSample('wsdl'); });
  reg('xsdAtlas.openWalkthrough', async function () { await vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false); });
  reg('xsdAtlas.showDocumentation', async function () { await openExternal(config.docsUrl); });

  reg('xsdAtlas.reportProblem', async function () {
    const editor = vscode.window.activeTextEditor;
    let active = null;
    if (editor) {
      const summary = app.diagnostics ? app.diagnostics.summaryOf(editor.document) : null;
      active = {
        kind: app.service.isSchemaDocument(editor.document) ? (summary && summary.kind ? summary.kind : 'schema') : 'not a schema (' + editor.document.languageId + ')',
        size: editor.document.getText().length,
        counts: summary ? summary.counts : undefined, documents: summary ? summary.documents : undefined, skipped: summary ? summary.skipped : undefined
      };
    }
    const extension = app.context && app.context.extension;
    const block = diagnosticsBlock({
      extensionVersion: extension && extension.packageJSON ? extension.packageJSON.version : app.extensionVersion,
      editorName: vscode.env && vscode.env.appName, editorVersion: vscode.version, platform: process.platform, osRelease: app.osRelease ? app.osRelease() : '',
      arch: process.arch, nodeVersion: process.versions && process.versions.node, settings: app.settingsForReport(), licence: await app.licence.status(false), active: active
    });
    await vscode.env.clipboard.writeText(block);
    const opened = await openExternal(config.issuesUrl);
    info(NAME + ': ' + reportProblemText(opened !== false));
  });

  // ---- licence commands ----------------------------------------------------------------------
  reg('xsdAtlas.buyPro', async function () {
    const choice = await vscode.window.showQuickPick(messages.buyChoices(), { placeHolder: 'Which licence? Both unlock the same Pro features.', matchOnDescription: true, matchOnDetail: true });
    if (!choice) return;
    let users = 1;
    if (choice.tier === 'business') {
      const answer = await vscode.window.showInputBox({ title: NAME + ' Pro Business: ' + messages.businessUsersQuestion(), value: '1', ignoreFocusOut: true, validateInput: messages.businessUsersError });
      if (answer === undefined) return;
      if (messages.businessUsersError(answer)) { warn(messages.businessUsersError(answer) + ' The checkout page was not opened.'); return; }
      users = Number(String(answer).trim());
    }
    const url = app.licence.buyUrl(choice.tier, users);
    if (!url) { info(NAME + ': ' + choice.label + ' is not on sale yet. Please check the extension page again soon.'); return; }
    await openExternal(url);
  });

  reg('xsdAtlas.enterKey', async function () {
    const raw = await vscode.window.showInputBox({
      title: NAME + ' Pro: paste the licence key from your purchase e-mail', placeHolder: 'Licence key', ignoreFocusOut: true, password: false,
      validateInput: function (v) { return /\s/.test((v || '').trim()) ? 'A licence key contains no spaces.' : null; }
    });
    const key = (raw || '').trim();
    if (!key) return;
    const result = await app.licence.activate(key);
    if (result.ok) info(NAME + ': ' + messages.activatedText(result.licenceType, result));
    else {
      const pick = await vscode.window.showErrorMessage(NAME + ': ' + messages.activationFailureText(result), BUTTONS.lost);
      if (pick === BUTTONS.lost) await showLostKey();
    }
  });

  reg('xsdAtlas.licenceStatus', async function () {
    const st = await app.licence.status(true);
    const text = NAME + ': ' + messages.licenceStatusText(st);
    let pick;
    if (st.pro) pick = await info(text, BUTTONS.remove);
    else if (st.hasKey) pick = await info(text, BUTTONS.enter, BUTTONS.remove, BUTTONS.lost);
    else pick = await info(text, BUTTONS.buy, BUTTONS.enter, BUTTONS.lost);
    await handleLicenceButton(pick);
  });

  reg('xsdAtlas.removeLicence', async function () {
    const st = await app.licence.status(false);
    if (!st.hasKey) { info(NAME + ': No licence key is stored on this computer, so there is nothing to remove.'); return; }
    const pick = await vscode.window.showWarningMessage(NAME + ': ' + messages.removeConfirmText(), { modal: true }, BUTTONS.remove);
    if (pick !== BUTTONS.remove) return;
    const result = await app.licence.remove();
    info(NAME + ': ' + (result.deactivated
      ? 'The licence was removed from this computer and the activation was freed. You can enter the key on another computer now.'
      : 'The licence was removed from this computer. The licence server could not be reached, so the activation may still count against the limit of ' + config.activationLimit + '; if a later activation is refused, contact ' + config.supportContact() + '.'));
  });

  // ---- Pro: comparison -----------------------------------------------------------------------
  async function showDiff(result, title) {
    app.lastDiff = { result: result, title: title };
    if (app.diffTree) app.diffTree.show(result, title);
    await vscode.commands.executeCommand('xsdAtlas.diff.focus').then(undefined, function () { /* view not available */ });
    const c = result.counts;
    const pick = await info(NAME + ': ' + c.BREAKING + ' breaking, ' + c['NON-BREAKING'] + ' non-breaking and ' + c.DOCUMENTATION + ' documentation changes. The list is in the Schema Comparison view.', 'Export Report');
    if (pick === 'Export Report') await vscode.commands.executeCommand('xsdAtlas.exportComparison');
  }

  // The comparison runs in the extension host without a pause: the progress notice is shown first,
  // and the host gets a short turn to paint it, so that a long comparison is visible as such.
  function diffWithProgress(oldSet, newSet, options) {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: NAME + ': comparing schemas' }, async function () {
      await new Promise(function (resolve) { setTimeout(resolve, 30); });
      return loadPro('diff').diffSets(oldSet, newSet, options);
    });
  }

  async function pickOtherFile(exclude) {
    const open = vscode.workspace.textDocuments.filter(function (d) { return d.uri.toString() !== exclude && app.service.isSchemaDocument(d); })
      .map(function (d) { return { label: vscode.workspace.asRelativePath(d.uri, false), description: 'open editor', uri: d.uri }; });
    const items = open.concat([{ label: 'Browse...', description: 'pick a file', browse: true }]);
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'The OLD version to compare with (the active file is the NEW version)' });
    if (!pick) return null;
    if (!pick.browse) return pick.uri;
    const files = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Compare', filters: { 'Schemas': ['xsd', 'wsdl', 'xml'] } });
    return files && files[0] ? files[0] : null;
  }

  reg('xsdAtlas.compareFiles', async function () {
    const editor = schemaEditor();
    if (!editor) return;
    if (!(await requirePro('Compare Schema With Another File'))) return;
    const other = await pickOtherFile(editor.document.uri.toString());
    if (!other) return;
    const read = await app.service.read(other.toString());
    if (typeof read.text !== 'string') { warn('The file ' + U.baseName(other.toString()) + ' could not be read.'); return; }
    const oldSet = await loadSchemaSet({ uri: other.toString(), text: read.text }, { read: app.service.read });
    const newSet = await setOfEditor(editor);
    if (!newSet) return;
    if (!oldSet.docs.length) { warn('The chosen file contains no XML Schema.'); return; }
    const labels = { old: vscode.workspace.asRelativePath(other, false), new: vscode.workspace.asRelativePath(editor.document.uri, false) };
    await showDiff(await diffWithProgress(oldSet, newSet, { labels: labels }), labels.old + ' → ' + labels.new);
  });

  async function folderEntries(folder) {
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.{xsd,wsdl}'), '**/{node_modules,.git}/**', app.getSettings().workspaceMaxFiles);
    const out = [];
    for (const f of files) {
      const r = await app.service.read(f.toString());
      if (typeof r.text === 'string') out.push({ uri: f.toString(), text: r.text });
    }
    return out;
  }

  reg('xsdAtlas.compareFolders', async function () {
    if (!(await requirePro('Compare Two Schema Folders'))) return;
    const a = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Old version folder' });
    if (!a || !a[0]) return;
    const b = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'New version folder' });
    if (!b || !b[0]) return;
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: NAME + ': comparing folders' }, async function () {
      const ea = await folderEntries(a[0]);
      const eb = await folderEntries(b[0]);
      if (!ea.length || !eb.length) return { empty: true };
      const oldSet = await loadSchemaSet(ea, { read: app.service.read });
      const newSet = await loadSchemaSet(eb, { read: app.service.read });
      return loadPro('diff').diffSets(oldSet, newSet, { labels: { old: a[0].fsPath || a[0].toString(), new: b[0].fsPath || b[0].toString() } });
    });
    if (result.empty) { warn('One of the folders contains no .xsd or .wsdl file.'); return; }
    await showDiff(result, U.baseName(a[0].toString()) + ' → ' + U.baseName(b[0].toString()));
  });

  async function gitApi() {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) return null;
    try {
      const exp = ext.isActive ? ext.exports : await ext.activate();
      return exp && typeof exp.getAPI === 'function' ? exp.getAPI(1) : null;
    } catch (e) { return null; }
  }

  reg('xsdAtlas.compareRevisions', async function () {
    const editor = schemaEditor();
    if (!editor) return;
    if (!(await requirePro('Compare With Git Revision'))) return;
    const uri = editor.document.uri;
    const api = uri.scheme === 'file' ? await gitApi() : null;
    const repo = api ? api.getRepository(uri) : null;
    if (!repo) {
      const pick = await info(NAME + ': The built-in Git extension has no repository for this file (or Git is not available). Compare with another file instead?', 'Compare With Another File');
      if (pick) await vscode.commands.executeCommand('xsdAtlas.compareFiles');
      return;
    }
    let commits = [];
    try { commits = await repo.log({ maxEntries: 40, path: uri.fsPath }); } catch (e) { commits = []; }
    if (!commits.length) { warn('Git has no committed version of this file yet.'); return; }
    const items = commits.map(function (c) {
      return { label: String(c.hash).slice(0, 8) + '  ' + U.shorten(String(c.message || '').split('\n')[0], 70), description: c.authorDate ? new Date(c.authorDate).toLocaleDateString() : '', hash: c.hash };
    });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'The OLD revision; the working copy in the editor is the NEW version' });
    if (!pick) return;
    const root = repo.rootUri.fsPath;
    async function readAt(uriText) {
      let u;
      try { u = vscode.Uri.parse(uriText, true); } catch (e) { return { error: 'missing' }; }
      if (u.scheme !== 'file' || !U.isInsideFolder(u.fsPath, root, process.platform)) return app.service.read(uriText);
      try { return { text: await repo.show(pick.hash, u.fsPath) }; } catch (e) { return { error: 'missing' }; }
    }
    const oldText = await readAt(uri.toString());
    if (typeof oldText.text !== 'string') { warn('This file does not exist in revision ' + pick.hash.slice(0, 8) + '.'); return; }
    const oldSet = await loadSchemaSet({ uri: uri.toString(), text: oldText.text }, { read: readAt });
    const newSet = await setOfEditor(editor);
    if (!newSet) return;
    const base = vscode.workspace.asRelativePath(uri, false);
    await showDiff(await diffWithProgress(oldSet, newSet, { labels: { old: base + ' at ' + pick.hash.slice(0, 8), new: base + ' (working copy)' } }), base + ' since ' + pick.hash.slice(0, 8));
  });

  reg('xsdAtlas.exportComparison', async function () {
    if (!app.lastDiff) { warn('Run a comparison first (Compare Schema With Another File, Compare Two Schema Folders or Compare With Git Revision).'); return; }
    if (!(await requirePro('Export Comparison Report'))) return;
    const pick = await vscode.window.showQuickPick([{ label: 'Markdown', id: 'md' }, { label: 'HTML', id: 'html' }, { label: 'CSV', id: 'csv' }], { placeHolder: 'Report format' });
    if (!pick) return;
    const R = loadPro('report');
    const d = app.lastDiff;
    if (pick.id === 'md') await openText(R.toMarkdown(d.result, 'Schema comparison: ' + d.title), 'markdown', 'schema-comparison.md');
    else if (pick.id === 'html') await openText(R.toHtml(d.result, 'Schema comparison: ' + d.title), 'html', 'schema-comparison.html');
    else await openText(R.toCsv(d.result, { neutralise: app.getSettings().neutraliseFormulas }), 'plaintext', 'schema-comparison.csv');
    vscode.window.setStatusBarMessage(NAME + ': report opened as a new file; save it where you need it.', 5000);
  });

  reg('xsdAtlas.clearComparison', function () { app.lastDiff = null; if (app.diffTree) app.diffTree.show(null, ''); });

  reg('xsdAtlas.revealChange', async function (loc) {
    if (!loc || !loc.uri) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(loc.uri, true)).then(undefined, function () { return null; });
    if (!doc) { info(NAME + ': This version of the file is not on disk (for example a git revision); line ' + loc.line + '.'); return; }
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    const pos = doc.positionAt(loc.offset || 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  });

  // ---- Pro: rich sample, documentation, flatten, SOAP, inventory ----------------------------
  reg('xsdAtlas.sampleXmlFull', async function () {
    const editor = schemaEditor();
    if (!editor) return;
    if (!(await requirePro('Create Full Sample XML'))) return;
    const set = await setOfEditor(editor);
    if (!set) return;
    const comp = await pickGlobalElement(set, editor.document.uri.toString());
    if (!comp) return;
    const strategy = await vscode.window.showQuickPick([
      { label: 'First option of every choice', id: 'first' }, { label: 'Rotate through the options of each choice', id: 'rotate' },
      { label: 'Pick the option of each choice', id: 'pick' }, { label: 'Random options (repeatable with the seed)', id: 'random' }
    ], { placeHolder: 'Choices in the content' });
    if (!strategy) return;
    const picks = {};
    if (strategy.id === 'pick') {
      for (const ch of listChoices(set, comp)) {
        const sel = await vscode.window.showQuickPick(ch.options.map(function (o, i) { return { label: o, index: i }; }), { placeHolder: ch.label });
        if (!sel) return;
        picks[ch.key] = sel.index;
      }
    }
    const s = app.getSettings();
    const r = buildSample(set, comp, { mode: 'full', choice: strategy.id === 'pick' ? 'first' : strategy.id, picks: picks, repeat: s.sampleRepeat, seed: s.sampleSeed, realistic: s.sampleRealistic });
    await openText(r.text, 'xml', 'sample-' + safeName(comp.name) + '-full.xml');
    if (r.notes.length) info(NAME + ': ' + r.notes.join(' '));
  });

  reg('xsdAtlas.createDocumentation', async function () {
    const editor = schemaEditor();
    if (!editor) return;
    if (!(await requirePro('Create Schema Documentation'))) return;
    const set = await setOfEditor(editor);
    if (!set) return;
    const pick = await vscode.window.showQuickPick([{ label: 'Markdown', id: 'md' }, { label: 'HTML', id: 'html' }], { placeHolder: 'Documentation format' });
    if (!pick) return;
    const docs = loadPro('docs');
    const title = U.baseName(editor.document.uri.toString()) + ' reference';
    const base = safeName(U.baseName(editor.document.uri.toString()).replace(/\.[^.]+$/, ''));
    await openText(pick.id === 'md' ? docs.toMarkdown(set, title) : docs.toHtml(set, title), pick.id === 'md' ? 'markdown' : 'html', base + '-reference.' + (pick.id === 'md' ? 'md' : 'html'));
  });

  reg('xsdAtlas.flatten', async function () {
    const editor = schemaEditor();
    if (!editor) return;
    if (!(await requirePro('Flatten Schema'))) return;
    const set = await setOfEditor(editor);
    if (!set) return;
    const base = U.baseName(editor.document.uri.toString()).replace(/\.[^.]+$/, '') + '-flat';
    const r = loadPro('flatten').flattenSet(set, base);
    if (!r.ok) { warn(r.message); return; }
    const folder = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Write flattened files here' });
    if (!folder || !folder[0]) return;
    const targets = r.files.map(function (f) { return { file: f, uri: vscode.Uri.joinPath(folder[0], f.name) }; });
    const existing = [];
    for (const t of targets) { try { await vscode.workspace.fs.stat(t.uri); existing.push(t.file.name); } catch (e) { /* new file */ } }
    const question = 'Write ' + targets.length + ' file' + (targets.length === 1 ? '' : 's') + ' (' + targets.map(function (t) { return t.file.name; }).join(', ') + ')?' + (existing.length ? ' ' + existing.length + ' of them exist and will be replaced.' : '');
    const ok = await vscode.window.showWarningMessage(NAME + ': ' + question, { modal: true }, 'Write');
    if (ok !== 'Write') return;
    for (const t of targets) await vscode.workspace.fs.writeFile(t.uri, Buffer.from(t.file.text, 'utf8'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(targets[0].uri), { preview: false });
    info(NAME + ': ' + targets.length + ' flattened file' + (targets.length === 1 ? '' : 's') + ' written.' + (r.notes.length ? ' ' + r.notes.join(' ') : ''));
  });

  reg('xsdAtlas.soapSamples', async function () {
    const editor = schemaEditor();
    if (!editor) return;
    if (!(await requirePro('Create SOAP Envelope Samples'))) return;
    const set = await setOfEditor(editor);
    if (!set) return;
    const soap = loadPro('soap');
    const ops = soap.soapOperations(set);
    if (!ops.length) { warn('No SOAP binding was found. Open a WSDL file with a SOAP 1.1 or SOAP 1.2 binding.'); return; }
    const op = ops.length === 1 ? ops[0] : (await vscode.window.showQuickPick(ops.map(function (o) { return { label: o.label, entry: o }; }), { placeHolder: 'Operation' }) || {}).entry;
    if (!op) return;
    const s = app.getSettings();
    const e = soap.buildEnvelopes(set, op, { mode: 'full', repeat: 1, seed: s.sampleSeed, realistic: s.sampleRealistic });
    const choices = [];
    if (e.request) choices.push({ label: 'Request', text: e.request });
    if (e.response) choices.push({ label: 'Response', text: e.response });
    for (const f of e.faults) choices.push({ label: 'Fault ' + f.name, text: f.text });
    if (!choices.length) { warn('The operation has no messages that could be built. ' + e.notes.join(' ')); return; }
    const pick = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(choices, { placeHolder: 'Which envelope?' });
    if (!pick) return;
    await openText(pick.text, 'xml', 'soap-' + safeName(op.operation.name) + '-' + safeName(pick.label.toLowerCase()) + '.xml');
    if (e.notes.length) info(NAME + ': ' + e.notes.join(' '));
  });

  reg('xsdAtlas.inventory', async function () {
    if (!(await requirePro('Workspace Schema Inventory'))) return;
    if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length) { warn('Open a folder first; the inventory scans the workspace folders.'); return; }
    const pick = await vscode.window.showQuickPick([{ label: 'Markdown', id: 'md' }, { label: 'HTML', id: 'html' }, { label: 'CSV', id: 'csv' }], { placeHolder: 'Report format' });
    if (!pick) return;
    const inv = loadPro('inventory');
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: NAME + ': scanning schema files', cancellable: true }, async function (progress, token) {
      const uris = await app.service.workspaceFiles(token);
      const files = [];
      for (const u of uris) {
        if (token.isCancellationRequested) return null;
        const r = await app.service.read(u.toString());
        if (typeof r.text === 'string') files.push({ uri: u.toString(), text: r.text, rel: vscode.workspace.asRelativePath(u, true) });
      }
      return inv.buildInventory(files);
    });
    if (!result) return;
    if (!result.files.length) { warn('No .xsd or .wsdl files were found (setting xsdAtlas.workspace.include).'); return; }
    if (pick.id === 'md') await openText(inv.toMarkdown(result, 'Schema inventory'), 'markdown', 'schema-inventory.md');
    else if (pick.id === 'html') await openText(inv.toHtml(result, 'Schema inventory'), 'html', 'schema-inventory.html');
    else await openText(inv.toCsv(result, { neutralise: app.getSettings().neutraliseFormulas }), 'plaintext', 'schema-inventory.csv');
  });

  return disposables;
}

// ---- comparison tree view ---------------------------------------------------------------------

function createDiffTree(app) {
  const vscode = app.vscode;
  const emitter = new vscode.EventEmitter();
  let roots = [];
  const ICONS = { BREAKING: 'error', 'NON-BREAKING': 'pass', DOCUMENTATION: 'book' };
  function show(result, title) {
    roots = [];
    if (result) {
      for (const cls of ['BREAKING', 'NON-BREAKING', 'DOCUMENTATION']) {
        const rows = result.changes.filter(function (c) { return c.severity === cls; });
        if (!rows.length) continue;
        const byComp = new Map();
        for (const c of rows) { if (!byComp.has(c.component)) byComp.set(c.component, []); byComp.get(c.component).push(c); }
        roots.push({ label: cls, description: String(rows.length), cls: cls, children: Array.from(byComp.entries()).map(function (e) {
          return { label: e[0], description: e[1].length + ' change' + (e[1].length === 1 ? '' : 's'), children: e[1].map(function (c) { return { change: c, children: [] }; }) };
        }) });
      }
      if (!roots.length) roots.push({ label: 'No differences', description: title, children: [] });
    }
    emitter.fire(undefined);
  }
  const provider = {
    onDidChangeTreeData: emitter.event,
    getChildren: function (n) { return n ? n.children : roots; },
    getTreeItem: function (n) {
      if (n.change) {
        const c = n.change;
        const item = new vscode.TreeItem((c.path ? c.path + ': ' : '') + c.message, vscode.TreeItemCollapsibleState.None);
        item.description = c.code;
        item.tooltip = c.severity + ' ' + c.code + '\n' + c.message + (c.before ? '\nBefore: ' + c.before : '') + (c.after ? '\nAfter: ' + c.after : '');
        item.iconPath = new vscode.ThemeIcon(ICONS[c.severity]);
        const loc = c.newLoc || c.oldLoc;
        if (loc) item.command = { command: 'xsdAtlas.revealChange', title: 'Reveal', arguments: [loc] };
        return item;
      }
      const item = new vscode.TreeItem(n.label, n.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
      item.description = n.description;
      if (n.cls) item.iconPath = new vscode.ThemeIcon(ICONS[n.cls]);
      return item;
    }
  };
  const view = vscode.window.createTreeView('xsdAtlas.diff', { treeDataProvider: provider, showCollapseAll: true });
  return { show: show, dispose: function () { view.dispose(); emitter.dispose(); } };
}

module.exports = { registerCommands: registerCommands, createDiffTree: createDiffTree, BUTTONS: BUTTONS };
