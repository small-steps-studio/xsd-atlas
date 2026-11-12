'use strict';
// The diagnostics block that "Report A Problem" copies to the clipboard. It holds versions, the
// platform, the kind of the active file with its problem counts, the settings and the licence or
// trial state. It never holds file contents, file names, paths, namespaces, the licence key or its
// hint, user names, computer names or e-mail addresses. The two workspace glob patterns, which may
// name folders, appear only as "default" or "custom".

const config = require('./licence/config');

const SETTING_KEYS = ['maxFileSizeMB', 'validateOnType', 'hover.enabled', 'workspace.include', 'workspace.exclude', 'workspace.maxFiles', 'sample.repeat', 'sample.seed', 'export.neutraliseFormulas'];
// Settings whose values may hold folder names: reported only as default or custom.
const PATTERN_KEYS = ['workspace.include', 'workspace.exclude'];

function licenceLine(st) {
  if (!st) return 'unknown';
  const trial = st.trial || { state: 'unused' };
  let text;
  if (st.pro && st.via === 'grace') text = 'Pro (licence, offline grace period)';
  else if (st.pro) text = 'Pro (' + (st.licenceType || 'licence') + ', verified)';
  else if (st.hasKey && st.via === 'product') text = (trial.state === 'active' ? 'Trial' : 'Free') + ' (stored key of another product)';
  else if (st.hasKey && st.via === 'rejected') text = (trial.state === 'active' ? 'Trial' : 'Free') + ' (stored key rejected by the server)';
  else if (st.hasKey) text = (trial.state === 'active' ? 'Trial' : 'Free') + ' (stored key, grace period over)';
  else if (trial.state === 'active') text = 'Trial (' + trial.daysLeft + ' day' + (trial.daysLeft === 1 ? '' : 's') + ' left)';
  else if (trial.state === 'expired') text = 'Free (trial ended)';
  else text = 'Free (trial not started)';
  return text + ', licence server: ' + (st.mode || 'live');
}

function settingValue(v) {
  if (v === undefined) return 'default';
  return typeof v === 'object' || typeof v === 'string' ? JSON.stringify(v) : String(v);
}

/**
 * Builds the block from `info`: extensionVersion, editorName, editorVersion, platform, osRelease,
 * arch, nodeVersion, settings (flat object keyed as SETTING_KEYS), licence (status), active
 * ({ kind, size, documents, counts: { error, warning, info }, skipped } or null).
 */
function diagnosticsBlock(info) {
  const i = info || {};
  const lines = [];
  lines.push(config.productName + ' ' + (i.extensionVersion || 'unknown version'));
  lines.push('Editor: ' + (i.editorName || 'unknown') + ' ' + (i.editorVersion || ''));
  lines.push('Platform: ' + (i.platform || 'unknown') + ' ' + (i.osRelease || '') + ' ' + (i.arch || '') + (i.nodeVersion ? ', Node ' + i.nodeVersion : ''));
  const a = i.active;
  if (!a) lines.push('Active file: none');
  else {
    let detail = '';
    if (a.skipped === 'size') detail = ', not analysed automatically (over the size limit)';
    else if (a.skipped === 'limit') detail = ', not analysed (over the fixed analysis limit)';
    else if (a.skipped) detail = ', not analysed (' + a.skipped + ')';
    else if (a.counts) detail = ', ' + (a.documents || 0) + ' schema documents loaded, ' + a.counts.error + ' errors, ' + a.counts.warning + ' warnings, ' + a.counts.info + ' notes';
    lines.push('Active file: ' + (a.kind || 'unknown kind') + (typeof a.size === 'number' ? ', ' + a.size + ' characters' : '') + detail);
  }
  lines.push('Settings:');
  const s = i.settings || {};
  for (const k of SETTING_KEYS) {
    const v = PATTERN_KEYS.indexOf(k) !== -1 ? (s[k] === undefined || s[k] === 'default' ? 'default' : 'custom') : settingValue(s[k]);
    lines.push('  ' + k + ' = ' + v);
  }
  lines.push('Licence: ' + licenceLine(i.licence));
  lines.push('Issues page: ' + config.issuesUrl);
  return lines.join('\n') + '\n';
}

function reportProblemText(opened) {
  return 'A diagnostics block (version numbers, platform, settings, licence state; no file contents, names or namespaces) was copied to the clipboard. ' +
    (opened ? 'Paste it into the issue that opens in your browser, add what you did and what you expected, and attach a small example schema without confidential content.'
      : 'Open ' + config.issuesUrl + ', create a new issue, paste the block and describe what you did and what you expected.');
}

module.exports = { diagnosticsBlock: diagnosticsBlock, licenceLine: licenceLine, reportProblemText: reportProblemText, SETTING_KEYS: SETTING_KEYS };
