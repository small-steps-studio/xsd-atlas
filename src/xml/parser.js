'use strict';
// A small, safe XML 1.0 parser with namespaces, written for schema files.
//
// * Works on a string (the editor's document text or decoded file bytes). Positions are offsets
//   into that string, so ranges map directly to editor positions.
// * Namespaces: every element and attribute carries its prefix, local name and namespace name.
// * Entities: the five predefined entities, character references and internal general entities
//   declared in the internal DTD subset. External entities (SYSTEM or PUBLIC) are recorded but
//   NEVER read: there is no code path in this module that opens a file or a URL. Expansion is
//   bounded (nesting depth and total size), so entity "bombs" are refused with an error.
// * CDATA sections, comments, processing instructions, the XML declaration and a byte order mark
//   are understood. Comments and processing instructions are skipped.
// * Lazy text: text nodes keep only their offsets; the value is decoded when it is asked for.
//   Whitespace-only text is not kept. This keeps the tree small for very large files.
// * Error tolerant: well-formedness problems are reported with codes and ranges and parsing goes
//   on, so a half-typed file still has a usable tree.
// Pure JavaScript without any dependency; never throws for any input string.

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

const NAME_START = ':A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\uD800-\\uDBFF';
const NAME_CHAR = NAME_START + '\\uDC00-\\uDFFF\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040';
const NAME_RE = new RegExp('[' + NAME_START + '][' + NAME_CHAR + ']*', 'y');
const UNQUOTED_END_RE = /[\s>]/g;
const TEXT_BAD_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|\]\]>/g;
const NAME_FULL = new RegExp('^[' + NAME_START + '][' + NAME_CHAR + ']*$');

const MAX_ERRORS = 200;
const MAX_DEPTH = 2048;
const MAX_ENTITY_DEPTH = 16;
const MAX_ENTITY_EXPANSION = 1000000;
const PREDEFINED = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' });

class XmlElement {
  constructor(name, start, parent) {
    this.name = name;
    this.prefix = '';
    this.local = name;
    this.ns = '';
    this.attrs = [];
    this.children = null;
    this.parent = parent;
    this.start = start;
    this.nameEnd = start + 1 + name.length;
    this.tagEnd = -1;
    this.end = -1;
    this.nsDecls = null;
    this.selfClosing = false;
  }
}

class XmlAttr {
  constructor(name, start) {
    this.name = name;
    this.prefix = '';
    this.local = name;
    this.ns = '';
    this.value = '';
    this.start = start;
    this.end = start;
    this.valueStart = start;
    this.valueEnd = start;
  }
}

class XmlText {
  constructor(start, end, cdata) {
    this.start = start;
    this.end = end;
    this.cdata = cdata;
  }
}

function isWs(c) { return c === 0x20 || c === 0x0A || c === 0x09 || c === 0x0D; }

function isXmlChar(cp) {
  return cp === 0x9 || cp === 0xA || cp === 0xD || (cp >= 0x20 && cp <= 0xD7FF) || (cp >= 0xE000 && cp <= 0xFFFD) || (cp >= 0x10000 && cp <= 0x10FFFF);
}

function splitQName(name) {
  const i = name.indexOf(':');
  if (i === -1) return { prefix: '', local: name };
  return { prefix: name.slice(0, i), local: name.slice(i + 1) };
}

/** True for a name that is a valid XML name. */
function isName(s) { return typeof s === 'string' && NAME_FULL.test(s); }
/** True for a valid NCName (an XML name without a colon). */
function isNCName(s) { return isName(s) && s.indexOf(':') === -1; }
/** True for a valid QName (NCName or NCName:NCName). */
function isQName(s) {
  if (typeof s !== 'string') return false;
  const i = s.indexOf(':');
  if (i === -1) return isNCName(s);
  return isNCName(s.slice(0, i)) && isNCName(s.slice(i + 1));
}

function normaliseNewlines(s) {
  return s.indexOf('\r') === -1 ? s : s.replace(/\r\n?/g, '\n');
}

/**
 * Parses `text`. Options: `keepWhitespace` (keep whitespace-only text nodes, default false).
 * Returns { root, errors, source, declaration, doctype, entities, textOf(node) }.
 */
function parseXml(input, options) {
  const opts = options || {};
  const s = typeof input === 'string' ? input : String(input === undefined || input === null ? '' : input);
  const len = s.length;
  const errors = [];
  const entities = new Map();
  const entityInfo = new Map();
  const parseBudget = { left: MAX_ENTITY_EXPANSION };
  let root = null;
  let declaration = null;
  let doctype = null;
  let stopped = false;

  function err(code, message, start, end) {
    if (errors.length >= MAX_ERRORS) {
      if (errors.length === MAX_ERRORS) errors.push({ code: 'XML-TOO-MANY-ERRORS', message: 'More than ' + MAX_ERRORS + ' well-formedness problems; the rest are not listed.', start: start, end: Math.max(start, end), severity: 'error' });
      return;
    }
    errors.push({ code: code, message: message, start: start, end: Math.max(start + 1, end), severity: 'error' });
  }

  // ---- entities ------------------------------------------------------------------------------

  // Expanded length of an internal entity (memoised); Infinity when it is recursive or too large.
  function entityLength(name, stack) {
    const known = entityInfo.get(name);
    if (known && known.length !== undefined) return known.length;
    const e = entities.get(name);
    if (!e) return 0;
    if (e.external) return 0;
    if (stack.indexOf(name) !== -1 || stack.length > MAX_ENTITY_DEPTH) return Infinity;
    let total = 0;
    const v = e.value;
    let i = 0;
    while (i < v.length) {
      const amp = v.indexOf('&', i);
      if (amp === -1) { total += v.length - i; break; }
      total += amp - i;
      const semi = v.indexOf(';', amp);
      if (semi === -1) { total += v.length - amp; break; }
      const ref = v.slice(amp + 1, semi);
      if (ref.charAt(0) === '#') total += 2;
      else if (PREDEFINED[ref] !== undefined) total += 1;
      else total += entityLength(ref, stack.concat([name]));
      if (total > MAX_ENTITY_EXPANSION) { total = Infinity; break; }
      i = semi + 1;
    }
    entityInfo.set(name, { length: total });
    return total;
  }

  // Decodes one reference body (between & and ;). Returns the replacement text or null.
  function decodeCharRef(body, at) {
    let cp;
    if (/^#x[0-9A-Fa-f]+$/.test(body)) cp = parseInt(body.slice(2), 16);
    else if (/^#[0-9]+$/.test(body)) cp = parseInt(body.slice(1), 10);
    else { if (at >= 0) err('XML-INVALID-CHAR-REF', 'Malformed character reference "&' + body + ';".', at, at + body.length + 2); return null; }
    if (!(cp >= 0 && cp <= 0x10FFFF) || !isXmlChar(cp)) {
      if (at >= 0) err('XML-INVALID-CHAR-REF', 'Character reference "&' + body + ';" names a character that XML does not allow.', at, at + body.length + 2);
      return null;
    }
    return String.fromCodePoint(cp);
  }

  // Expands the references in `raw`. `at` is the offset of raw in the source, used for errors
  // (negative: report nothing, the references were checked already). `inAttribute` applies the
  // attribute value whitespace rule (tab, CR, LF become spaces).
  function expand(raw, at, inAttribute, depth, report, budget) {
    let out = '';
    let i = 0;
    const n = raw.length;
    while (i < n) {
      const amp = raw.indexOf('&', i);
      const stop = amp === -1 ? n : amp;
      if (stop > i) {
        let chunk = raw.slice(i, stop);
        if (inAttribute) chunk = chunk.replace(/\r\n|[\r\n\t]/g, ' ');
        else chunk = normaliseNewlines(chunk);
        out += chunk;
      }
      if (amp === -1) break;
      const relSemi = raw.slice(amp + 1, amp + 66).indexOf(';');
      const semi = relSemi === -1 ? -1 : amp + 1 + relSemi;
      const body = semi === -1 ? '' : raw.slice(amp + 1, semi);
      const where = at >= 0 ? at + amp : -1;
      if (semi === -1 || semi - amp > 64 || !body) {
        if (report && where >= 0) err('XML-BARE-AMPERSAND', 'An "&" must start a reference such as "&amp;". Write "&amp;" for a literal ampersand.', where, where + 1);
        out += '&';
        i = amp + 1;
        continue;
      }
      if (body.charAt(0) === '#') {
        const ch = decodeCharRef(body, report ? where : -1);
        if (ch !== null) out += ch;
      } else if (PREDEFINED[body] !== undefined) {
        out += PREDEFINED[body];
      } else if (!isName(body)) {
        if (report && where >= 0) err('XML-BARE-AMPERSAND', 'An "&" must start a reference such as "&amp;". Write "&amp;" for a literal ampersand.', where, where + 1);
        out += '&';
        i = amp + 1;
        continue;
      } else {
        const e = entities.get(body);
        if (!e) {
          if (report && where >= 0) err('XML-UNDEFINED-ENTITY', 'The entity "&' + body + ';" is not declared.', where, where + body.length + 2);
        } else if (e.external) {
          if (report && where >= 0) err('XML-EXTERNAL-ENTITY', 'The entity "&' + body + ';" refers to an external resource. External entities are never loaded, so it is left out.', where, where + body.length + 2);
        } else if (e.value.indexOf('<') !== -1) {
          if (report && where >= 0) err('XML-ENTITY-MARKUP', 'The entity "&' + body + ';" contains markup; entities with markup are not expanded here.', where, where + body.length + 2);
        } else {
          const length = entityLength(body, []);
          if (length === Infinity || depth >= MAX_ENTITY_DEPTH) {
            if (report && where >= 0) err('XML-ENTITY-LIMIT', 'The entity "&' + body + ';" is recursive or expands to more than ' + MAX_ENTITY_EXPANSION + ' characters, so it is not expanded.', where, where + body.length + 2);
          } else if (length > budget.left) {
            if (report && where >= 0) err('XML-ENTITY-LIMIT', 'The entities of this document expand to more than ' + MAX_ENTITY_EXPANSION + ' characters in total; "&' + body + ';" is not expanded.', where, where + body.length + 2);
          } else {
            budget.left -= length;
            out += expand(e.value, -1, inAttribute, depth + 1, false, budget);
          }
        }
      }
      i = semi + 1;
    }
    return out;
  }

  // ---- doctype -------------------------------------------------------------------------------

  function skipWs(p) { while (p < len && isWs(s.charCodeAt(p))) p++; return p; }

  function readQuoted(p) {
    const q = s.charAt(p);
    if (q !== '"' && q !== '\'') return null;
    const close = s.indexOf(q, p + 1);
    if (close === -1) return null;
    return { value: s.slice(p + 1, close), next: close + 1 };
  }

  // Skips a markup declaration up to its closing '>' (quotes respected). Returns the next offset.
  function skipDecl(p) {
    while (p < len) {
      const c = s.charAt(p);
      if (c === '"' || c === '\'') {
        const close = s.indexOf(c, p + 1);
        if (close === -1) return len;
        p = close + 1;
      } else if (c === '>') return p + 1;
      else p++;
    }
    return len;
  }

  function parseDoctype(start) {
    let p = start + 9;
    p = skipWs(p);
    NAME_RE.lastIndex = p;
    const m = NAME_RE.exec(s);
    const info = { name: m ? m[0] : '', start: start, end: start, external: null, internalSubset: false };
    if (m) p += m[0].length;
    p = skipWs(p);
    if (s.startsWith('SYSTEM', p) || s.startsWith('PUBLIC', p)) {
      const isPublic = s.startsWith('PUBLIC', p);
      p = skipWs(p + 6);
      const first = readQuoted(p);
      if (first) {
        p = skipWs(first.next);
        if (isPublic) {
          const second = readQuoted(p);
          if (second) { info.external = second.value; p = skipWs(second.next); }
        } else info.external = first.value;
      }
    }
    if (s.charAt(p) === '[') {
      info.internalSubset = true;
      p++;
      while (p < len) {
        p = skipWs(p);
        if (p >= len) break;
        if (s.charAt(p) === ']') { p++; break; }
        if (s.startsWith('<!--', p)) {
          const close = s.indexOf('-->', p + 4);
          p = close === -1 ? len : close + 3;
        } else if (s.startsWith('<?', p)) {
          const close = s.indexOf('?>', p + 2);
          p = close === -1 ? len : close + 2;
        } else if (s.startsWith('<!ENTITY', p)) {
          const declStart = p;
          p = skipWs(p + 8);
          let param = false;
          if (s.charAt(p) === '%') { param = true; p = skipWs(p + 1); }
          NAME_RE.lastIndex = p;
          const nm = NAME_RE.exec(s);
          if (!nm) { err('XML-BAD-DOCTYPE', 'An entity declaration has no valid name.', declStart, declStart + 8); p = skipDecl(p); continue; }
          p = skipWs(p + nm[0].length);
          let entity = null;
          const lit = readQuoted(p);
          if (lit) entity = { value: lit.value, external: false };
          else if (s.startsWith('SYSTEM', p) || s.startsWith('PUBLIC', p)) entity = { value: '', external: true };
          p = skipDecl(p);
          if (!param && entity && !entities.has(nm[0]) && PREDEFINED[nm[0]] === undefined) entities.set(nm[0], entity);
        } else if (s.charAt(p) === '%') {
          const semi = s.indexOf(';', p);
          p = semi === -1 ? len : semi + 1;
        } else if (s.startsWith('<!', p)) {
          p = skipDecl(p);
        } else {
          err('XML-BAD-DOCTYPE', 'Unexpected text in the document type declaration.', p, p + 1);
          const close = s.indexOf(']', p);
          p = close === -1 ? len : close;
        }
      }
    }
    p = skipWs(p);
    if (s.charAt(p) === '>') p++;
    else {
      err('XML-BAD-DOCTYPE', 'The document type declaration is not closed with ">".', start, start + 9);
      p = skipDecl(p);
    }
    info.end = p;
    return info;
  }

  // ---- namespaces ----------------------------------------------------------------------------

  function lookup(el, prefix) {
    if (prefix === 'xml') return XML_NS;
    if (prefix === 'xmlns') return XMLNS_NS;
    for (let e = el; e; e = e.parent) {
      if (e.nsDecls && Object.prototype.hasOwnProperty.call(e.nsDecls, prefix)) return e.nsDecls[prefix];
    }
    return prefix === '' ? '' : null;
  }

  // ---- main loop -----------------------------------------------------------------------------

  let pos = 0;
  if (s.charCodeAt(0) === 0xFEFF) pos = 1;
  const contentStart = pos;
  let current = null;
  let depth = 0;
  const keepWs = opts.keepWhitespace === true;

  function addChild(parent, node) {
    if (!parent.children) parent.children = [node];
    else parent.children.push(node);
  }

  // Position of the next "&" at or after i (cached, so that text without references costs one scan).
  let ampNext = -2;
  function nextAmp(i) {
    if (ampNext === -1) return -1;
    if (ampNext < i) ampNext = s.indexOf('&', i);
    return ampNext;
  }

  // Characters XML 1.0 forbids, and "]]>", in element text (next match cached like "&" above).
  let badNext = -2;
  let badLen = 0;
  function findBad(i) {
    TEXT_BAD_RE.lastIndex = i;
    const m = TEXT_BAD_RE.exec(s);
    badNext = m ? m.index : -1;
    badLen = m ? m[0].length : 0;
  }
  function checkTextChars(from, to) {
    if (badNext === -1) return;
    if (badNext < from) findBad(from);
    while (badNext !== -1 && badNext < to) {
      if (badLen === 3) err('XML-CDATA-END-IN-TEXT', 'The text "]]>" is not allowed in element content; write "]]&gt;".', badNext, badNext + 3);
      else err('XML-INVALID-CHARACTER', 'The character U+' + s.charCodeAt(badNext).toString(16).toUpperCase().padStart(4, '0') + ' is not allowed in XML 1.0 text.', badNext, badNext + 1);
      findBad(badNext + badLen);
    }
  }

  function checkTextRefs(from, to) {
    let a = nextAmp(from);
    while (a !== -1 && a < to) {
      const rel = s.slice(a + 1, Math.min(to, a + 66)).indexOf(';');
      const semi = rel === -1 ? -1 : a + 1 + rel;
      if (semi === -1) {
        err('XML-BARE-AMPERSAND', 'An "&" must start a reference such as "&amp;". Write "&amp;" for a literal ampersand.', a, a + 1);
      } else {
        expand(s.slice(a, semi + 1), a, false, 0, true, parseBudget);
      }
      a = nextAmp(a + 1);
    }
  }

  while (pos < len && !stopped) {
    const lt = s.indexOf('<', pos);
    const textEnd = lt === -1 ? len : lt;
    if (textEnd > pos) {
      // Text between markup.
      let p = pos;
      while (p < textEnd && isWs(s.charCodeAt(p))) p++;
      const blank = p === textEnd;
      if (!current) {
        if (!blank) err('XML-TEXT-OUTSIDE-ROOT', 'Text is not allowed outside the root element.', p, Math.min(textEnd, p + 20));
      } else {
        if (!blank) { checkTextRefs(pos, textEnd); checkTextChars(pos, textEnd); }
        if (!blank || keepWs) addChild(current, new XmlText(pos, textEnd, false));
      }
      pos = textEnd;
      if (lt === -1) break;
    }
    // Markup at pos ('<').
    const next = s.charAt(pos + 1);
    if (next === '/') {
      const start = pos;
      NAME_RE.lastIndex = pos + 2;
      const m = NAME_RE.exec(s);
      const name = m && m.index === pos + 2 ? m[0] : '';
      let p = skipWs(pos + 2 + name.length);
      if (s.charAt(p) === '>') p++;
      else {
        err('XML-UNCLOSED-TAG', 'The end tag "</' + name + '" is not closed with ">".', start, p);
        const gt = s.indexOf('>', p);
        const lt2 = s.indexOf('<', p);
        p = gt !== -1 && (lt2 === -1 || gt < lt2) ? gt + 1 : p;
      }
      if (!current) {
        err('XML-UNEXPECTED-END-TAG', 'The end tag "</' + name + '>" has no matching start tag.', start, p);
      } else if (current.name === name) {
        current.end = p;
        current = current.parent;
        depth--;
      } else {
        // Find the element it closes; elements in between were not closed.
        let target = current.parent;
        while (target && target.name !== name) target = target.parent;
        if (!target) {
          err('XML-MISMATCHED-END-TAG', 'The end tag "</' + name + '>" does not match the open element "<' + current.name + '>".', start, p);
        } else {
          for (let e = current; e !== target; e = e.parent) {
            err('XML-UNCLOSED-ELEMENT', 'The element "<' + e.name + '>" is not closed.', e.start, e.nameEnd);
            e.end = start;
            depth--;
          }
          target.end = p;
          current = target.parent;
          depth--;
        }
      }
      pos = p;
      continue;
    }
    if (next === '!') {
      if (s.startsWith('<!--', pos)) {
        const close = s.indexOf('-->', pos + 4);
        if (close === -1) { err('XML-UNCLOSED-COMMENT', 'The comment is not closed with "-->".', pos, pos + 4); pos = len; break; }
        const dd = s.indexOf('--', pos + 4);
        if (dd !== -1 && dd < close) err('XML-COMMENT-DOUBLE-HYPHEN', 'A comment must not contain "--".', dd, dd + 2);
        pos = close + 3;
        continue;
      }
      if (s.startsWith('<![CDATA[', pos)) {
        const close = s.indexOf(']]>', pos + 9);
        const end = close === -1 ? len : close;
        if (close === -1) err('XML-UNCLOSED-CDATA', 'The CDATA section is not closed with "]]>".', pos, pos + 9);
        if (!current) err('XML-TEXT-OUTSIDE-ROOT', 'A CDATA section is not allowed outside the root element.', pos, pos + 9);
        else addChild(current, new XmlText(pos + 9, end, true));
        pos = close === -1 ? len : close + 3;
        continue;
      }
      if (s.startsWith('<!DOCTYPE', pos)) {
        if (root || doctype) err('XML-BAD-DOCTYPE', 'A document type declaration must come once, before the root element.', pos, pos + 9);
        const info = parseDoctype(pos);
        if (!root && !doctype) doctype = info;
        pos = info.end;
        continue;
      }
      err('XML-INVALID-MARKUP', 'Unknown markup "<!". Expected a comment, a CDATA section or a document type declaration.', pos, pos + 2);
      pos = skipDecl(pos + 2);
      continue;
    }
    if (next === '?') {
      const close = s.indexOf('?>', pos + 2);
      if (close === -1) { err('XML-UNCLOSED-PI', 'The processing instruction is not closed with "?>".', pos, pos + 2); pos = len; break; }
      NAME_RE.lastIndex = pos + 2;
      const m = NAME_RE.exec(s);
      const target = m && m.index === pos + 2 ? m[0] : '';
      if (!target) err('XML-INVALID-NAME', 'A processing instruction needs a target name.', pos, pos + 2);
      else if (target.toLowerCase() === 'xml') {
        if (target !== 'xml' || pos !== contentStart || declaration) {
          err('XML-DECLARATION-POSITION', 'The XML declaration must be the very first thing in the file (only a byte order mark may come before it).', pos, pos + 5);
        } else {
          const body = s.slice(pos + 5, close);
          const ver = /version\s*=\s*["']([^"']*)["']/.exec(body);
          const enc = /encoding\s*=\s*["']([^"']*)["']/.exec(body);
          const sa = /standalone\s*=\s*["']([^"']*)["']/.exec(body);
          declaration = { version: ver ? ver[1] : '', encoding: enc ? enc[1] : '', standalone: sa ? sa[1] : '' };
          if (!ver) err('XML-BAD-DECLARATION', 'The XML declaration has no version.', pos, close + 2);
          else if (!/^1\.[0-9]+$/.test(ver[1])) err('XML-BAD-DECLARATION', 'Unsupported XML version "' + ver[1] + '".', pos, close + 2);
        }
      }
      pos = close + 2;
      continue;
    }
    // Start tag.
    const start = pos;
    NAME_RE.lastIndex = pos + 1;
    const m = NAME_RE.exec(s);
    if (!m || m.index !== pos + 1) {
      err('XML-INVALID-NAME', 'A "<" must start a tag with a valid name. Write "&lt;" for a literal "<".', pos, pos + 1);
      if (current) addChild(current, new XmlText(pos, pos + 1, false));
      pos++;
      continue;
    }
    const name = m[0];
    const el = new XmlElement(name, start, current);
    let p = pos + 1 + name.length;
    let closed = false;
    const seen = new Set();
    let nextLt = -2;
    while (p < len) {
      const before = p;
      p = skipWs(p);
      const c = s.charAt(p);
      if (c === '>') { p++; closed = true; break; }
      if (c === '/' && s.charAt(p + 1) === '>') { p += 2; closed = true; el.selfClosing = true; break; }
      if (c === '<' || p >= len) break;
      NAME_RE.lastIndex = p;
      const an = NAME_RE.exec(s);
      if (!an || an.index !== p) {
        err('XML-INVALID-ATTRIBUTE', 'Unexpected character "' + c + '" in the tag <' + name + '>.', p, p + 1);
        p++;
        continue;
      }
      if (before === p) err('XML-MISSING-SPACE', 'Attributes must be separated by white space.', p, p + an[0].length);
      const attr = new XmlAttr(an[0], p);
      p = skipWs(p + an[0].length);
      if (s.charAt(p) !== '=') {
        err('XML-ATTRIBUTE-WITHOUT-VALUE', 'The attribute "' + an[0] + '" has no value (expected ="...").', attr.start, p);
        attr.end = p;
        continue;
      }
      p = skipWs(p + 1);
      const q = s.charAt(p);
      if (q !== '"' && q !== '\'') {
        err('XML-UNQUOTED-ATTRIBUTE', 'The value of "' + an[0] + '" must be in quotes.', attr.start, p + 1);
        UNQUOTED_END_RE.lastIndex = p;
        const stop = UNQUOTED_END_RE.exec(s);
        p = stop ? stop.index : len;
        continue;
      }
      const close = s.indexOf(q, p + 1);
      // The next "<" is searched once per tag and reused while the attributes move past it, so a
      // tag with very many attributes stays linear.
      if (nextLt !== -1 && nextLt < p + 1) nextLt = s.indexOf('<', p + 1);
      const lt2 = nextLt;
      if (close === -1 || (lt2 !== -1 && lt2 < close)) {
        if (close === -1) {
          err('XML-UNCLOSED-ATTRIBUTE', 'The value of "' + an[0] + '" is not closed with ' + q + '.', attr.start, p + 1);
          p = len;
          break;
        }
        err('XML-LT-IN-ATTRIBUTE', 'An attribute value must not contain "<"; write "&lt;".', lt2, lt2 + 1);
      }
      attr.valueStart = p + 1;
      attr.valueEnd = close;
      attr.end = close + 1;
      const raw = s.slice(p + 1, close);
      attr.value = raw.indexOf('&') === -1 && !/[\t\r\n]/.test(raw) ? raw : expand(raw, p + 1, true, 0, true, parseBudget);
      p = close + 1;
      if (seen.has(attr.name)) err('XML-DUPLICATE-ATTRIBUTE', 'The attribute "' + attr.name + '" appears twice in <' + name + '>.', attr.start, attr.end);
      seen.add(attr.name);
      if (attr.name === 'xmlns' || attr.name.startsWith('xmlns:')) {
        const declared = attr.name === 'xmlns' ? '' : attr.name.slice(6);
        if (!el.nsDecls) el.nsDecls = Object.create(null);
        if (declared === 'xmlns') err('XML-BAD-NAMESPACE-DECLARATION', 'The prefix "xmlns" cannot be declared.', attr.start, attr.end);
        else if (declared === 'xml' && attr.value !== XML_NS) err('XML-BAD-NAMESPACE-DECLARATION', 'The prefix "xml" cannot be bound to another namespace.', attr.start, attr.end);
        else if (declared !== '' && attr.value === '') err('XML-BAD-NAMESPACE-DECLARATION', 'A prefix cannot be bound to an empty namespace name in XML 1.0.', attr.start, attr.end);
        else el.nsDecls[declared] = attr.value;
        attr.prefix = declared === '' ? '' : 'xmlns';
        attr.local = declared === '' ? 'xmlns' : declared;
        attr.ns = XMLNS_NS;
      }
      el.attrs.push(attr);
    }
    if (!closed) {
      err('XML-UNCLOSED-TAG', 'The start tag <' + name + ' is not closed with ">".', start, Math.min(len, start + 1 + name.length));
      el.selfClosing = true;
    }
    el.tagEnd = p;
    // Resolve the namespaces of the element and its attributes.
    const qn = splitQName(name);
    el.prefix = qn.prefix;
    el.local = qn.local;
    if (name.indexOf(':') !== name.lastIndexOf(':') || (qn.prefix && !qn.local) || name.charAt(0) === ':') {
      err('XML-INVALID-NAME', 'The element name "' + name + '" is not a valid qualified name.', start + 1, el.nameEnd);
    }
    const ens = lookup(el, qn.prefix);
    if (ens === null) {
      err('XML-UNDECLARED-PREFIX', 'The prefix "' + qn.prefix + '" of <' + name + '> is not declared.', start + 1, start + 1 + qn.prefix.length);
      el.ns = '';
    } else el.ns = ens;
    const expanded = new Set();
    for (const a of el.attrs) {
      if (a.ns === XMLNS_NS) continue;
      const aq = splitQName(a.name);
      a.prefix = aq.prefix;
      a.local = aq.local;
      if (aq.prefix) {
        const ans = lookup(el, aq.prefix);
        if (ans === null) {
          err('XML-UNDECLARED-PREFIX', 'The prefix "' + aq.prefix + '" of the attribute "' + a.name + '" is not declared.', a.start, a.start + aq.prefix.length);
          a.ns = '';
        } else a.ns = ans;
      }
      const key = a.ns + '|' + a.local;
      if (expanded.has(key) && aq.prefix) err('XML-DUPLICATE-ATTRIBUTE', 'The attribute "' + a.name + '" is the same qualified attribute as another one in <' + name + '>.', a.start, a.end);
      expanded.add(key);
    }
    if (!current) {
      if (root) err('XML-MULTIPLE-ROOTS', 'Only one root element is allowed; <' + name + '> comes after the root element.', start, el.nameEnd);
      else root = el;
    } else addChild(current, el);
    if (el.selfClosing) {
      el.end = p;
    } else {
      depth++;
      if (depth > MAX_DEPTH) {
        err('XML-TOO-DEEP', 'Elements are nested more than ' + MAX_DEPTH + ' levels deep; the rest of the file is not read.', start, el.nameEnd);
        stopped = true;
      }
      current = el;
    }
    pos = p;
  }

  if (current) {
    for (let e = current; e; e = e.parent) {
      err('XML-UNCLOSED-ELEMENT', 'The element "<' + e.name + '>" is not closed.', e.start, e.nameEnd);
      e.end = len;
    }
  }
  if (!root && !stopped) err('XML-NO-ROOT', 'The file contains no root element.', 0, Math.min(len, 1));

  function textOf(node) {
    if (!node || node.start === undefined) return '';
    const raw = s.slice(node.start, node.end);
    if (node.cdata) return normaliseNewlines(raw);
    return raw.indexOf('&') === -1 ? normaliseNewlines(raw) : expand(raw, -1, false, 0, false, { left: MAX_ENTITY_EXPANSION });
  }

  return {
    root: root,
    errors: errors,
    source: s,
    declaration: declaration,
    doctype: doctype,
    entities: entities,
    textOf: textOf
  };
}

// ---- tree helpers ------------------------------------------------------------------------------

/** The element children of an element (text left out). */
function childElements(el) {
  const out = [];
  if (el && el.children) for (const c of el.children) if (c instanceof XmlElement) out.push(c);
  return out;
}

/** The value of an attribute without namespace, or undefined. */
function attr(el, local) {
  if (!el) return undefined;
  for (const a of el.attrs) if (a.local === local && a.ns === '' && a.prefix === '') return a.value;
  return undefined;
}

/** The attribute object (with positions) of an attribute without namespace, or null. */
function attrNode(el, local) {
  if (!el) return null;
  for (const a of el.attrs) if (a.local === local && a.ns === '' && a.prefix === '') return a;
  return null;
}

/** The namespace bound to `prefix` in the scope of `el` ('' for no namespace), or null when undeclared. */
function lookupNamespace(el, prefix) {
  if (prefix === 'xml') return XML_NS;
  for (let e = el; e; e = e.parent) {
    if (e.nsDecls && Object.prototype.hasOwnProperty.call(e.nsDecls, prefix)) return e.nsDecls[prefix];
  }
  return prefix === '' ? '' : null;
}

/** All prefixes in scope at `el`: { prefix: namespace }. The nearest declaration wins. */
function inScopeNamespaces(el) {
  const out = Object.create(null);
  const chain = [];
  for (let e = el; e; e = e.parent) chain.push(e);
  for (let i = chain.length - 1; i >= 0; i--) {
    const d = chain[i].nsDecls;
    if (d) for (const k of Object.keys(d)) out[k] = d[k];
  }
  return out;
}

/** The concatenated text of an element and its descendants. */
function textContent(parsed, el) {
  if (!el || !el.children) return '';
  let out = '';
  const stack = [{ node: el, i: 0 }];
  while (stack.length) {
    const top = stack[stack.length - 1];
    const kids = top.node.children;
    if (!kids || top.i >= kids.length) { stack.pop(); continue; }
    const c = kids[top.i++];
    if (c instanceof XmlText) out += parsed.textOf(c);
    else if (c instanceof XmlElement && c.children) stack.push({ node: c, i: 0 });
  }
  return out;
}

/** The innermost element whose range contains `offset` (start tag to end tag), or null. */
function elementAt(root, offset) {
  if (!root || offset < root.start || offset > root.end) return null;
  let el = root;
  for (;;) {
    let next = null;
    const kids = el.children;
    if (kids) {
      // Children are in document order: binary search for the last child starting at or before offset.
      let lo = 0;
      let hi = kids.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (kids[mid].start <= offset) { found = mid; lo = mid + 1; } else hi = mid - 1;
      }
      for (let i = found; i >= 0 && i >= found - 1; i--) {
        const c = kids[i];
        if (c instanceof XmlElement && offset >= c.start && offset <= c.end) { next = c; break; }
      }
    }
    if (!next) return el;
    el = next;
  }
}

/** The attribute of `el` whose name or value contains `offset`, or null. */
function attrAt(el, offset) {
  if (!el) return null;
  for (const a of el.attrs) if (offset >= a.start && offset <= a.end) return a;
  return null;
}

module.exports = {
  parseXml: parseXml,
  childElements: childElements,
  attr: attr,
  attrNode: attrNode,
  lookupNamespace: lookupNamespace,
  inScopeNamespaces: inScopeNamespaces,
  textContent: textContent,
  elementAt: elementAt,
  attrAt: attrAt,
  isName: isName,
  isNCName: isNCName,
  isQName: isQName,
  splitQName: splitQName,
  XmlElement: XmlElement,
  XmlText: XmlText,
  XmlAttr: XmlAttr,
  XML_NS: XML_NS,
  XMLNS_NS: XMLNS_NS,
  MAX_DEPTH: MAX_DEPTH,
  MAX_ENTITY_EXPANSION: MAX_ENTITY_EXPANSION
};
