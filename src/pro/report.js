'use strict';
// Diff reports in Markdown, HTML and CSV. Every value from a schema is escaped for the target
// format; CSV cells that a spreadsheet would run as formulas are neutralised.

const U = require('../util');

const CLASSES = ['BREAKING', 'NON-BREAKING', 'DOCUMENTATION'];
const CSV_HEADER = ['class', 'code', 'component', 'path', 'change', 'before', 'after', 'old location', 'new location'];

function where(l) { return l ? U.baseName(l.uri) + ':' + l.line : ''; }

function summary(result) {
  const c = result.counts;
  return c.BREAKING + ' breaking, ' + c['NON-BREAKING'] + ' non-breaking, ' + c.DOCUMENTATION + ' documentation';
}

/** Markdown report of a diff result. */
function toMarkdown(result, title) {
  const out = [];
  out.push('# ' + U.escapeMarkdown(title || 'Schema comparison'));
  out.push('');
  out.push('Old: ' + U.escapeMarkdown(result.labels.old) + '  ');
  out.push('New: ' + U.escapeMarkdown(result.labels.new));
  out.push('');
  out.push('**' + summary(result) + '** (' + result.changes.length + ' changes)');
  out.push('');
  out.push('Classes: BREAKING = documents valid under the old version can become invalid or change meaning; NON-BREAKING = old documents stay valid; DOCUMENTATION = text only.');
  for (const cls of CLASSES) {
    const rows = result.changes.filter(function (c) { return c.severity === cls; });
    if (!rows.length) continue;
    out.push('');
    out.push('## ' + cls + ' (' + rows.length + ')');
    out.push('');
    out.push('| Component | Path | Change | Before | After | Code |');
    out.push('| --- | --- | --- | --- | --- | --- |');
    for (const c of rows) {
      out.push('| ' + [c.component, c.path, c.message, c.before, c.after, c.code].map(U.escapeMarkdown).join(' | ') + ' |');
    }
  }
  if (!result.changes.length) { out.push(''); out.push('No differences were found.'); }
  out.push('');
  return out.join('\n');
}

/** A complete, self-contained HTML page (no scripts, no external resources). */
function toHtml(result, title) {
  const h = U.escapeHtml;
  const t = title || 'Schema comparison';
  const parts = [];
  parts.push('<!DOCTYPE html>');
  parts.push('<html lang="en"><head><meta charset="utf-8">');
  parts.push('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">');
  parts.push('<title>' + h(t) + '</title>');
  parts.push('<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:2rem;color:#1b1f23}table{border-collapse:collapse;width:100%;margin:1rem 0}' +
    'th,td{border:1px solid #d0d7de;padding:4px 8px;text-align:left;vertical-align:top;font-size:13px}th{background:#f3f5f7}' +
    'code{font-family:Consolas,monospace}.BREAKING{color:#b42318}.NON-BREAKING{color:#1d6b34}.DOCUMENTATION{color:#57606a}</style>');
  parts.push('</head><body>');
  parts.push('<h1>' + h(t) + '</h1>');
  parts.push('<p>Old: <code>' + h(result.labels.old) + '</code><br>New: <code>' + h(result.labels.new) + '</code></p>');
  parts.push('<p><strong>' + h(summary(result)) + '</strong> (' + result.changes.length + ' changes)</p>');
  for (const cls of CLASSES) {
    const rows = result.changes.filter(function (c) { return c.severity === cls; });
    if (!rows.length) continue;
    parts.push('<h2 class="' + cls + '">' + cls + ' (' + rows.length + ')</h2>');
    parts.push('<table><thead><tr><th scope="col">Component</th><th scope="col">Path</th><th scope="col">Change</th><th scope="col">Before</th><th scope="col">After</th><th scope="col">Code</th><th scope="col">Location</th></tr></thead><tbody>');
    for (const c of rows) {
      parts.push('<tr><td><code>' + h(c.component) + '</code></td><td><code>' + h(c.path) + '</code></td><td>' + h(c.message) + '</td><td><code>' + h(c.before) +
        '</code></td><td><code>' + h(c.after) + '</code></td><td>' + h(c.code) + '</td><td>' + h([where(c.oldLoc), where(c.newLoc)].filter(Boolean).join(' / ')) + '</td></tr>');
    }
    parts.push('</tbody></table>');
  }
  if (!result.changes.length) parts.push('<p>No differences were found.</p>');
  parts.push('</body></html>');
  return parts.join('\n') + '\n';
}

/** CSV report (RFC 4180, CRLF line ends, formula cells neutralised unless options.neutralise is false). */
function toCsv(result, options) {
  const neutralise = !(options && options.neutralise === false);
  let s = U.csvRow(CSV_HEADER, neutralise);
  for (const c of result.changes) s += U.csvRow([c.severity, c.code, c.component, c.path, c.message, c.before, c.after, where(c.oldLoc), where(c.newLoc)], neutralise);
  return s;
}

module.exports = { toMarkdown: toMarkdown, toHtml: toHtml, toCsv: toCsv, summary: summary, CSV_HEADER: CSV_HEADER };
