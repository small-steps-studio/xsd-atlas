'use strict';
// Small shared helpers without editor dependencies: line index, URI arithmetic, escaping for the
// export formats and a few string utilities.

/** Offsets of line starts for a text, with offset <-> { line, character } conversion. */
class LineIndex {
  constructor(text) {
    this.text = text;
    const starts = [0];
    let i = text.indexOf('\n');
    while (i !== -1) { starts.push(i + 1); i = text.indexOf('\n', i + 1); }
    this.starts = starts;
  }
  positionAt(offset) {
    const o = Math.max(0, Math.min(offset, this.text.length));
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= o) lo = mid; else hi = mid - 1;
    }
    return { line: lo, character: o - this.starts[lo] };
  }
  offsetAt(line, character) {
    if (line < 0) return 0;
    if (line >= this.starts.length) return this.text.length;
    return Math.min(this.text.length, this.starts[line] + Math.max(0, character));
  }
}

const lineCache = new WeakMap();
/** A cached LineIndex for a parse result object (keyed by object identity). */
function linesOf(holder, text) {
  let li = lineCache.get(holder);
  if (!li) { li = new LineIndex(text); lineCache.set(holder, li); }
  return li;
}

/**
 * Resolves a schemaLocation (or WSDL location) against the URI of the document that names it.
 * Backslashes are treated as slashes. Returns the absolute URI string or '' when it cannot be
 * resolved.
 */
function resolveUri(location, base) {
  if (typeof location !== 'string') return '';
  const loc = location.trim().replace(/\\/g, '/');
  if (!loc) return '';
  try {
    if (/^[A-Za-z]:\//.test(loc)) return new URL('file:///' + loc).toString();
    return new URL(loc, base).toString();
  } catch (e) {
    return '';
  }
}

/** True for http and https URIs (never fetched). */
function isRemote(uri) { return /^https?:/i.test(uri || ''); }

/**
 * The computer a URI points to: its host, or for a file URI whose path starts with two slashes
 * or backslashes (written out or percent-encoded, as in file:////server/share) the server of
 * that network path, which the operating system would contact. '' for this computer; null when
 * the path cannot be decoded.
 */
function hostOf(u) {
  if (u.host) return u.host.toLowerCase();
  if (u.protocol !== 'file:') return '';
  let p;
  try { p = decodeURIComponent(u.pathname); } catch (e) { return null; }
  const m = /^[\\/]{2,}([^\\/]*)/.exec(p);
  return m ? (m[1] || '?').toLowerCase() : '';
}

/**
 * Why a resolved location must not be read automatically from the document at `base`: 'internet'
 * for http(s), 'host' for a location on another computer (a file URI with another host, such as a
 * network share, or another scheme than the naming document), '' when it may be read. A document
 * that itself lives on a network share may name further files on that same share.
 */
function foreignLocation(resolved, base) {
  if (isRemote(resolved)) return isRemote(base) ? '' : 'internet';
  let r;
  let b;
  try { r = new URL(resolved); } catch (e) { return 'host'; }
  const rh = hostOf(r);
  // A file location has no query or fragment; such a URI is not a plain file path.
  if (rh === null || (r.protocol === 'file:' && (r.search || r.hash))) return 'host';
  try { b = new URL(base); } catch (e) { return r.protocol === 'file:' && !rh ? '' : 'host'; }
  // An unsaved editor may name local files by absolute path.
  if (b.protocol === 'untitled:' && r.protocol === 'file:' && !rh) return '';
  if (r.protocol !== b.protocol) return 'host';
  if (rh !== hostOf(b)) return 'host';
  return '';
}

/** The last path segment of a URI, decoded for display. */
function baseName(uri) {
  const clean = String(uri || '').split('#')[0].split('?')[0];
  const seg = clean.slice(clean.lastIndexOf('/') + 1);
  try { return decodeURIComponent(seg); } catch (e) { return seg; }
}

/** A path from `fromUri`'s folder to `toUri` (both file-like URIs), with forward slashes. */
function relativeUri(fromUri, toUri) {
  try {
    const a = new URL(fromUri);
    const b = new URL(toUri);
    if (a.protocol !== b.protocol || a.host !== b.host) return toUri;
    const from = a.pathname.split('/').slice(0, -1);
    const to = b.pathname.split('/');
    let i = 0;
    while (i < from.length && i < to.length - 1 && from[i].toLowerCase() === to[i].toLowerCase()) i++;
    const ups = from.slice(i).map(function () { return '..'; });
    const rest = to.slice(i);
    return decodeURIComponent(ups.concat(rest).join('/'));
  } catch (e) {
    return toUri;
  }
}

function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c];
  });
}

/** Escapes text for a Markdown table cell or paragraph: no HTML, no links, no table breaks. */
function escapeMarkdown(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/\r?\n|\r/g, ' ')
    .replace(/([\\`*_{}\[\]()#+!|<>~])/g, '\\$1')
    .replace(/&/g, '&amp;');
}

/** Escapes for XML text and attribute values; characters XML forbids are replaced. */
function escapeXml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '�')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, function (m, pre) { return (pre || '') + '�'; })
    .replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}

/**
 * One CSV cell (RFC 4180). Values that a spreadsheet would run as a formula (starting with =, +,
 * -, @, a tab or a carriage return) get a leading apostrophe, unless `neutralise` is false (the
 * setting xsdAtlas.export.neutraliseFormulas); quoting per RFC 4180 always applies.
 */
function csvCell(value, neutralise) {
  let s = String(value === undefined || value === null ? '' : value);
  if (neutralise !== false && /^[=+\-@\t\r]/.test(s)) s = '\'' + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function csvRow(cells, neutralise) { return cells.map(function (c) { return csvCell(c, neutralise); }).join(',') + '\r\n'; }

/**
 * True when the file path `file` lies inside the folder `folder` (or is the folder). Paths are
 * compared segment by segment, so /repo2/x is not inside /repo; case is ignored only on Windows
 * and macOS, whose file systems ignore it by default.
 */
function isInsideFolder(file, folder, platform) {
  const win = platform === 'win32';
  const norm = function (p) {
    let s = String(p || '');
    if (win) s = s.replace(/\\/g, '/');
    s = s.replace(/\/+$/, '');
    return platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s;
  };
  const f = norm(file);
  const d = norm(folder);
  if (!d) return false;
  return f === d || f.startsWith(d + '/');
}

/** Shortens text to `max` characters (code points) with an ellipsis. */
function shorten(text, max) {
  const s = String(text === undefined || text === null ? '' : text);
  if (s.length <= max) return s;
  const cps = Array.from(s.slice(0, max * 2 + 2));
  if (cps.length <= max) return s;
  return cps.slice(0, Math.max(1, max - 1)).join('') + '…';
}

/** Collapses white space to single spaces and trims. */
function collapse(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }

/** Formats an occurrence range: 1, 0..1, 1..*, 2..5. */
function occursText(min, max) {
  const a = String(min);
  const b = max === Infinity ? '*' : String(max);
  return a === b ? a : a + '..' + b;
}

module.exports = {
  LineIndex: LineIndex, linesOf: linesOf, resolveUri: resolveUri, isRemote: isRemote, foreignLocation: foreignLocation, baseName: baseName, relativeUri: relativeUri,
  escapeHtml: escapeHtml, escapeMarkdown: escapeMarkdown, escapeXml: escapeXml, csvCell: csvCell, csvRow: csvRow,
  shorten: shorten, collapse: collapse, occursText: occursText, isInsideFolder: isInsideFolder
};
