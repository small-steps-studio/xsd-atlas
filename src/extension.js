'use strict';
// XSD Atlas entry point. Builds the shared `app` object and installs every part of the extension;
// a failure in one part does not take the others down.

const vscode = require('vscode');
const os = require('node:os');
const P = require('./xml/parser');
const { createLicence } = require('./licence/licence');
const { createService } = require('./service');
const { createDiagnostics, registerLanguageFeatures, createOutlineTree, createStatus } = require('./providers');
const { registerCommands, createDiffTree } = require('./commands');

function numberSetting(value, fallback, min, max) {
  const n = Number(value);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * The licence server environment, fixed to the live one. No setting, command or other part of the
 * user interface can change it. Only an extension development host (the editor started on the
 * source folder of the extension for debugging or for its tests, never an installed copy) that
 * was started with the environment variable XSD_ATLAS_LICENCE_ENV=test uses the payment
 * provider's test environment.
 */
function licenceModeFor(context, environment) {
  const env = environment || process.env;
  const development = vscode.ExtensionMode !== undefined && !!context && context.extensionMode !== undefined &&
    context.extensionMode !== vscode.ExtensionMode.Production;
  const mode = development && env.XSD_ATLAS_LICENCE_ENV === 'test' ? 'test' : 'live';
  return function () { return mode; };
}

function activate(context) {
  let output = null;
  function log(text) {
    if (!output) output = vscode.window.createOutputChannel('XSD Atlas');
    output.appendLine(text);
  }

  let settingsCache = null;
  function getSettings() {
    if (settingsCache) return settingsCache;
    const c = vscode.workspace.getConfiguration('xsdAtlas');
    settingsCache = {
      maxFileSizeMB: numberSetting(c.get('maxFileSizeMB', 10), 10, 0.1, 32),
      maxProblems: Math.floor(numberSetting(c.get('maxProblems', 500), 500, 1, 10000)),
      validateOnType: c.get('validateOnType', true) !== false,
      hoverEnabled: c.get('hover.enabled', true) !== false,
      workspaceInclude: String(c.get('workspace.include', '**/*.{xsd,wsdl}') || '**/*.{xsd,wsdl}'),
      workspaceExclude: String(c.get('workspace.exclude', '**/{node_modules,.git}/**') || '**/{node_modules,.git}/**'),
      workspaceMaxFiles: Math.floor(numberSetting(c.get('workspace.maxFiles', 2000), 2000, 1, 20000)),
      sampleRepeat: Math.floor(numberSetting(c.get('sample.repeat', 2), 2, 1, 10)),
      sampleSeed: Math.floor(numberSetting(c.get('sample.seed', 1), 1, 0, 2147483647)),
      sampleRealistic: c.get('sample.realisticValues', true) !== false,
      neutraliseFormulas: c.get('export.neutraliseFormulas', true) !== false
    };
    return settingsCache;
  }

  const licence = createLicence({
    secrets: context.secrets,
    globalState: context.globalState,
    getMode: licenceModeFor(context)
  });
  licence.checkTrial().then(undefined, function () { /* read-only state */ });

  const parseCache = new WeakMap();
  const app = {
    vscode: vscode,
    context: context,
    licence: licence,
    getSettings: getSettings,
    service: null,
    diagnostics: null,
    tree: null,
    status: null,
    diffTree: null,
    lastDiff: null,
    extensionVersion: (context.extension && context.extension.packageJSON && context.extension.packageJSON.version) || require('../package.json').version,
    osRelease: function () { try { return os.release(); } catch (e) { return ''; } },
    // Parse tree of a document (cached per version); null for files over the size limit.
    parsedOf: function (document) {
      if (app.service && app.service.tooLarge(document)) return null;
      const hit = parseCache.get(document);
      if (hit && hit.version === document.version) return hit.parsed;
      const parsed = P.parseXml(document.getText());
      parseCache.set(document, { version: document.version, parsed: parsed });
      return parsed;
    },
    settingsForReport: function () {
      const s = getSettings();
      // Glob patterns may name folders; only whether they were changed is reported.
      return {
        maxFileSizeMB: s.maxFileSizeMB, validateOnType: s.validateOnType, 'hover.enabled': s.hoverEnabled,
        'workspace.include': s.workspaceInclude === '**/*.{xsd,wsdl}' ? 'default' : 'custom',
        'workspace.exclude': s.workspaceExclude === '**/{node_modules,.git}/**' ? 'default' : 'custom',
        'workspace.maxFiles': s.workspaceMaxFiles, 'sample.repeat': s.sampleRepeat, 'sample.seed': s.sampleSeed,
        'export.neutraliseFormulas': s.neutraliseFormulas
      };
    }
  };

  const subscriptions = context.subscriptions;
  subscriptions.push(vscode.workspace.onDidChangeConfiguration(function (event) {
    if (event.affectsConfiguration('xsdAtlas')) settingsCache = null;
  }));

  function install(name, fn) {
    try {
      const result = fn();
      if (Array.isArray(result)) result.forEach(function (d) { subscriptions.push(d); });
      else if (result && typeof result.dispose === 'function') subscriptions.push(result);
      return result;
    } catch (err) {
      log('Could not start ' + name + ': ' + (err && err.message ? err.message : err));
      return null;
    }
  }

  app.service = createService(app);
  install('commands', function () { return registerCommands(app); });
  app.diagnostics = install('problems', function () { return createDiagnostics(app); });
  install('language features', function () { return registerLanguageFeatures(app); });
  app.tree = install('outline', function () { return createOutlineTree(app); });
  app.diffTree = install('comparison view', function () { return createDiffTree(app); });
  app.status = install('status bar', function () { return createStatus(app); });
  install('file watcher', function () {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{xsd,wsdl}');
    const changed = function (uri) { app.service.invalidate(uri.toString()); };
    return [watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed)];
  });
}

function deactivate() {}

module.exports = { activate: activate, deactivate: deactivate, licenceModeFor: licenceModeFor };
