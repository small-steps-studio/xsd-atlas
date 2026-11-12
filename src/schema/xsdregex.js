'use strict';
// XML Schema regular expressions (the `pattern` facet). Parses the XSD dialect (implicitly
// anchored; character class subtraction; \i \c and the other multi-character escapes; Unicode
// categories and the common block escapes), translates it to a JavaScript RegExp for matching, and
// builds sample strings that match it.

const NAME_START_CLASS = '_:A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const NAME_CLASS = NAME_START_CLASS + '\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040';

const CATEGORIES = ['L', 'Lu', 'Ll', 'Lt', 'Lm', 'Lo', 'M', 'Mn', 'Mc', 'Me', 'N', 'Nd', 'Nl', 'No', 'P', 'Pc', 'Pd', 'Ps', 'Pe', 'Pi', 'Pf', 'Po',
  'Z', 'Zs', 'Zl', 'Zp', 'S', 'Sm', 'Sc', 'Sk', 'So', 'C', 'Cc', 'Cf', 'Co', 'Cn'];

// Common Unicode blocks (XSD block escapes \p{IsName}); others are reported as unsupported.
const BLOCKS = {
  BasicLatin: [0x0000, 0x007F], 'Latin-1Supplement': [0x0080, 0x00FF], 'LatinExtended-A': [0x0100, 0x017F], 'LatinExtended-B': [0x0180, 0x024F],
  IPAExtensions: [0x0250, 0x02AF], SpacingModifierLetters: [0x02B0, 0x02FF], CombiningDiacriticalMarks: [0x0300, 0x036F], Greek: [0x0370, 0x03FF],
  GreekandCoptic: [0x0370, 0x03FF], Cyrillic: [0x0400, 0x04FF], Armenian: [0x0530, 0x058F], Hebrew: [0x0590, 0x05FF], Arabic: [0x0600, 0x06FF],
  Devanagari: [0x0900, 0x097F], Thai: [0x0E00, 0x0E7F], Georgian: [0x10A0, 0x10FF], LatinExtendedAdditional: [0x1E00, 0x1EFF],
  GreekExtended: [0x1F00, 0x1FFF], GeneralPunctuation: [0x2000, 0x206F], SuperscriptsandSubscripts: [0x2070, 0x209F], CurrencySymbols: [0x20A0, 0x20CF],
  LetterlikeSymbols: [0x2100, 0x214F], NumberForms: [0x2150, 0x218F], Arrows: [0x2190, 0x21FF], MathematicalOperators: [0x2200, 0x22FF],
  BoxDrawing: [0x2500, 0x257F], GeometricShapes: [0x25A0, 0x25FF], Hiragana: [0x3040, 0x309F], Katakana: [0x30A0, 0x30FF],
  CJKUnifiedIdeographs: [0x4E00, 0x9FFF], HangulSyllables: [0xAC00, 0xD7AF], PrivateUse: [0xE000, 0xF8FF], AlphabeticPresentationForms: [0xFB00, 0xFB4F],
  HalfwidthandFullwidthForms: [0xFF00, 0xFFEF], Specials: [0xFFF0, 0xFFFF]
};

const CAT_SAMPLE = { L: 'a', Lu: 'A', Ll: 'a', Lt: 'ǅ', Lm: 'ʰ', Lo: 'ª', M: '̀', Mn: '̀', Mc: 'ः', Me: '⃝',
  N: '0', Nd: '0', Nl: 'Ⅰ', No: '²', P: '!', Pc: '_', Pd: '-', Ps: '(', Pe: ')', Pi: '«', Pf: '»', Po: '!',
  Z: ' ', Zs: ' ', Zl: ' ', Zp: ' ', S: '+', Sm: '+', Sc: '$', Sk: '^', So: '©', C: '­', Cc: '\t', Cf: '­', Co: '', Cn: '͸' };

class RegexError extends Error {
  constructor(message, offset, unsupported) { super(message); this.offset = offset; this.unsupported = !!unsupported; }
}

/** Parses an XSD regular expression into a tree. Throws RegexError. */
function parse(src) {
  const s = String(src);
  const cps = Array.from(s);
  let i = 0;
  function peek() { return cps[i]; }
  function eat(c) { if (cps[i] === c) { i++; return true; } return false; }
  function fail(msg) { throw new RegexError(msg, i); }

  function regExp() {
    const branches = [branch()];
    while (eat('|')) branches.push(branch());
    return branches.length === 1 ? branches[0] : { t: 'alt', branches: branches };
  }
  function branch() {
    const items = [];
    while (i < cps.length && peek() !== '|' && peek() !== ')') items.push(piece());
    return { t: 'seq', items: items };
  }
  function piece() {
    const a = atom();
    const c = peek();
    if (c === '?') { i++; return { t: 'rep', node: a, min: 0, max: 1 }; }
    if (c === '*') { i++; return { t: 'rep', node: a, min: 0, max: Infinity }; }
    if (c === '+') { i++; return { t: 'rep', node: a, min: 1, max: Infinity }; }
    if (c === '{') {
      i++;
      let n = '';
      while (/[0-9]/.test(peek() || '')) n += cps[i++];
      if (!n) fail('A quantifier {n,m} needs a number.');
      let min = Number(n);
      let max = min;
      if (eat(',')) {
        let m = '';
        while (/[0-9]/.test(peek() || '')) m += cps[i++];
        max = m ? Number(m) : Infinity;
      }
      if (!eat('}')) fail('A quantifier is not closed with "}".');
      if (max < min) fail('In a quantifier {n,m} the second number must not be smaller than the first.');
      if (min > 100000) fail('A quantifier is too large.');
      return { t: 'rep', node: a, min: min, max: max };
    }
    return a;
  }
  function atom() {
    const c = peek();
    if (c === '(') {
      i++;
      const inner = regExp();
      if (!eat(')')) fail('A group "(" is not closed with ")".');
      return { t: 'group', node: inner };
    }
    if (c === '[') return { t: 'class', set: classExpr() };
    if (c === '.') { i++; return { t: 'dot' }; }
    if (c === '\\') return escape(false);
    if (c === ')' || c === ']' || c === '{' || c === '}' || c === '?' || c === '*' || c === '+') fail('The character "' + c + '" must be escaped with a backslash here.');
    i++;
    return { t: 'char', cp: c.codePointAt(0) };
  }
  function escape(inClass) {
    i++;
    const c = cps[i++];
    if (c === undefined) fail('A backslash at the end of the pattern escapes nothing.');
    if (c === 'n') return { t: 'char', cp: 10 };
    if (c === 'r') return { t: 'char', cp: 13 };
    if (c === 't') return { t: 'char', cp: 9 };
    if ('\\|.-^?*+{}()[]$'.indexOf(c) !== -1) return { t: 'char', cp: c.codePointAt(0) };
    if ('sSiIcCdDwW'.indexOf(c) !== -1) return { t: 'class', set: { neg: false, items: [{ t: 'esc', name: c }], sub: null } };
    if (c === 'p' || c === 'P') {
      if (!eat('{')) fail('\\' + c + ' must be followed by {name}.');
      let name = '';
      while (i < cps.length && peek() !== '}') name += cps[i++];
      if (!eat('}')) fail('\\' + c + '{ is not closed with "}".');
      let item;
      if (CATEGORIES.indexOf(name) !== -1) item = { t: 'cat', name: name, neg: c === 'P' };
      else if (name.startsWith('Is')) {
        const block = BLOCKS[name.slice(2)];
        if (!block) throw new RegexError('The Unicode block "' + name + '" is not known here.', i, true);
        item = { t: 'range', from: block[0], to: block[1], neg: c === 'P' };
      } else fail('Unknown character category "' + name + '".');
      return { t: 'class', set: { neg: false, items: [item], sub: null } };
    }
    if (inClass) fail('Unknown escape "\\' + c + '".');
    fail('Unknown escape "\\' + c + '".');
    return null;
  }
  function classChar() {
    // A single character inside a class, or null when the next thing is an escape class.
    const c = peek();
    if (c === '\\') {
      const save = i;
      const e = escape(true);
      if (e.t === 'char') return e.cp;
      i = save;
      return null;
    }
    if (c === '[' || c === ']') fail('"' + c + '" must be escaped inside a character class.');
    i++;
    return c.codePointAt(0);
  }
  function classExpr() {
    if (!eat('[')) fail('Expected "[".');
    const set = { neg: false, items: [], sub: null };
    if (peek() === '^') { set.neg = true; i++; }
    let first = true;
    while (i < cps.length && peek() !== ']') {
      if (peek() === '-' && cps[i + 1] === '[') {
        i++;
        set.sub = classExpr();
        if (peek() !== ']') fail('A subtraction must be the last part of a character class.');
        break;
      }
      if (peek() === '-' && !first && cps[i + 1] !== ']') fail('"-" must be escaped inside a character class unless it is first or last.');
      if (peek() === '\\') {
        const save = i;
        const e = escape(true);
        if (e.t === 'class') { set.items.push.apply(set.items, e.set.items); first = false; continue; }
        i = save;
      }
      const from = classChar();
      if (from === null) fail('Unexpected escape in a character class.');
      if (peek() === '-' && cps[i + 1] !== ']' && cps[i + 1] !== '[' && cps[i + 1] !== undefined) {
        i++;
        const to = classChar();
        if (to === null) fail('A range cannot end with a class escape.');
        if (to < from) fail('A range in a character class goes backwards.');
        set.items.push({ t: 'range', from: from, to: to });
      } else set.items.push({ t: 'range', from: from, to: from });
      first = false;
    }
    if (!eat(']')) fail('A character class "[" is not closed with "]".');
    if (!set.items.length) fail('A character class must not be empty.');
    return set;
  }

  const tree = regExp();
  if (i < cps.length) fail(peek() === ')' ? 'A ")" has no matching "(".' : 'Unexpected "' + peek() + '".');
  return tree;
}

// ---- translation to JavaScript ------------------------------------------------------------------

function esc(cp) {
  const ch = String.fromCodePoint(cp);
  if (/[A-Za-z0-9]/.test(ch)) return ch;
  return '\\u{' + cp.toString(16) + '}';
}

// One character class item as [simpleInside] contents or as a full expression.
function itemParts(item) {
  if (item.t === 'range') {
    const inside = item.from === item.to ? esc(item.from) : esc(item.from) + '-' + esc(item.to);
    return item.neg ? { expr: '[^' + inside + ']' } : { inside: inside };
  }
  if (item.t === 'cat') return { inside: (item.neg ? '\\P{' : '\\p{') + item.name + '}' };
  switch (item.name) {
    case 's': return { inside: ' \\t\\n\\r' };
    case 'S': return { expr: '[^ \\t\\n\\r]' };
    case 'd': return { inside: '\\p{Nd}' };
    case 'D': return { inside: '\\P{Nd}' };
    case 'i': return { inside: NAME_START_CLASS };
    case 'I': return { expr: '[^' + NAME_START_CLASS + ']' };
    case 'c': return { inside: NAME_CLASS };
    case 'C': return { expr: '[^' + NAME_CLASS + ']' };
    case 'w': return { expr: '[^\\p{P}\\p{Z}\\p{C}]' };
    case 'W': return { inside: '\\p{P}\\p{Z}\\p{C}' };
    default: return { inside: '' };
  }
}

function setExpr(set) {
  const inside = [];
  const exprs = [];
  for (const it of set.items) {
    const p = itemParts(it);
    if (p.inside !== undefined) inside.push(p.inside);
    else exprs.push(p.expr);
  }
  const alts = [];
  if (inside.length) alts.push('[' + inside.join('') + ']');
  for (const e of exprs) alts.push(e);
  let base = alts.length === 1 ? alts[0] : '(?:' + alts.join('|') + ')';
  if (set.neg) base = '(?:(?!' + base + ')[^])';
  if (set.sub) base = '(?:(?!' + setExpr(set.sub) + ')' + base + ')';
  return base;
}

function toJs(node) {
  switch (node.t) {
    case 'alt': return '(?:' + node.branches.map(toJs).join('|') + ')';
    case 'seq': return node.items.map(toJs).join('');
    case 'group': return '(?:' + toJs(node.node) + ')';
    case 'char': return esc(node.cp);
    case 'dot': return '[^\\n\\r]';
    case 'class': return setExpr(node.set);
    case 'rep': {
      const inner = '(?:' + toJs(node.node) + ')';
      if (node.min === 0 && node.max === 1) return inner + '?';
      if (node.min === 0 && node.max === Infinity) return inner + '*';
      if (node.min === 1 && node.max === Infinity) return inner + '+';
      return inner + '{' + node.min + (node.max === node.min ? '' : ',' + (node.max === Infinity ? '' : node.max)) + '}';
    }
    default: return '';
  }
}

/**
 * True when a repetition (more than once) contains another repetition (more than once), such as
 * (a+)+ or (\d{1,3})*: matching such a pattern against a value that does not fit can take
 * exponential time in the JavaScript engine, so values are not tested against it.
 */
function nestedRepeat(node, insideRepeat) {
  if (!node) return false;
  switch (node.t) {
    case 'rep': {
      const repeats = node.max > 1;
      if (repeats && insideRepeat && containsRepeat(node.node)) return true;
      if (repeats && insideRepeat) return true;
      return nestedRepeat(node.node, insideRepeat || repeats);
    }
    case 'alt': return node.branches.some(function (b) { return nestedRepeat(b, insideRepeat); });
    case 'seq': return node.items.some(function (b) { return nestedRepeat(b, insideRepeat); });
    case 'group': return nestedRepeat(node.node, insideRepeat);
    default: return false;
  }
}
function containsRepeat(node) {
  if (!node) return false;
  if (node.t === 'rep') return node.max > 1 || containsRepeat(node.node);
  if (node.t === 'alt') return node.branches.some(containsRepeat);
  if (node.t === 'seq') return node.items.some(containsRepeat);
  if (node.t === 'group') return containsRepeat(node.node);
  return false;
}

/** Longest value that is tested against a pattern; longer values are not tested (time bound). */
const MAX_TEST_LENGTH = 4096;

/** Tests a value against a compiled pattern within the safety limits; null when not tested. */
function safeTest(compiled, value) {
  if (!compiled || !compiled.ok) return null;
  if (compiled.risky || String(value).length > MAX_TEST_LENGTH) return null;
  return compiled.regex.test(value);
}

const cache = new Map();

/**
 * Compiles an XSD pattern. Returns { ok: true, regex, tree } or { ok: false, message, unsupported }.
 * `unsupported` is true when the pattern is valid XSD but uses a block escape this module does not
 * know (the pattern is then not checked rather than reported as wrong).
 */
function compile(pattern) {
  const key = String(pattern);
  if (cache.has(key)) return cache.get(key);
  let result;
  try {
    const tree = parse(key);
    const regex = new RegExp('^(?:' + toJs(tree) + ')$', 'u');
    result = { ok: true, regex: regex, tree: tree, risky: nestedRepeat(tree, false) };
  } catch (e) {
    result = { ok: false, message: e.message, unsupported: !!e.unsupported };
  }
  if (cache.size > 2000) cache.clear();
  cache.set(key, result);
  return result;
}

// ---- samples ------------------------------------------------------------------------------------

const PREFERRED = ['a', 'b', 'c', 'x', 'A', 'B', 'C', 'X', '0', '1', '5', '9', '-', '_', '.', '+', '/', '@', ':', '#'];

function isXmlSafe(cp) {
  return cp === 9 || cp === 10 || cp === 13 || (cp >= 0x20 && cp <= 0xD7FF) || (cp >= 0xE000 && cp <= 0xFFFD) || (cp >= 0x10000 && cp <= 0x10FFFF);
}

function candidatesFor(set, out) {
  for (const it of set.items) {
    if (it.t === 'range' && !it.neg) {
      out.push(it.from, it.to, Math.floor((it.from + it.to) / 2), it.from + 1);
    } else if (it.t === 'cat' && !it.neg) {
      out.push(CAT_SAMPLE[it.name].codePointAt(0));
    } else if (it.t === 'esc') {
      if (it.name === 'd') out.push(48, 49, 55);
      if (it.name === 's') out.push(32);
      if (it.name === 'i' || it.name === 'c' || it.name === 'w') out.push(97, 65);
    }
  }
  return out;
}

const classMatchers = new Map();
function classMatcher(set) {
  const src = '^' + setExpr(set) + '$';
  let re = classMatchers.get(src);
  if (!re) {
    re = new RegExp(src, 'u');
    if (classMatchers.size > 2000) classMatchers.clear();
    classMatchers.set(src, re);
  }
  return re;
}

function pickChar(set, rng) {
  const re = classMatcher(set);
  const cands = PREFERRED.map(function (p) { return p.codePointAt(0); });
  candidatesFor(set, cands);
  cands.push(32);
  const ok = [];
  const seen = new Set();
  for (const cp of cands) {
    if (seen.has(cp) || !isXmlSafe(cp) || (cp >= 0x7F && cp <= 0x9F)) continue;
    seen.add(cp);
    if (re.test(String.fromCodePoint(cp))) { ok.push(cp); if (!rng && ok.length) break; if (ok.length >= 6) break; }
  }
  if (!ok.length) {
    for (let cp = 0x21; cp < 0x3000 && ok.length < 3; cp++) {
      if (isXmlSafe(cp) && re.test(String.fromCodePoint(cp))) ok.push(cp);
    }
    if (!ok.length) for (const cp of [0x09, 0x0A, 0x0D, 0x20]) if (re.test(String.fromCodePoint(cp))) { ok.push(cp); break; }
  }
  if (!ok.length) return null;
  const nonSpace = ok.filter(function (c) { return c > 0x20; });
  const pool = nonSpace.length ? nonSpace : ok;
  return pool[rng ? Math.floor(rng() * pool.length) % pool.length : 0];
}

function build(node, ctx) {
  switch (node.t) {
    case 'alt': {
      const idx = ctx.rng ? Math.floor(ctx.rng() * node.branches.length) % node.branches.length : 0;
      return build(node.branches[idx], ctx);
    }
    case 'seq': {
      let out = '';
      for (const it of node.items) { const part = build(it, ctx); if (part === null) return null; out += part; }
      return out;
    }
    case 'group': return build(node.node, ctx);
    case 'char': return String.fromCodePoint(node.cp);
    case 'dot': return ctx.rng ? 'abcxyz'.charAt(Math.floor(ctx.rng() * 6) % 6) : 'a';
    case 'class': { const cp = pickChar(node.set, ctx.rng); return cp === null ? null : String.fromCodePoint(cp); }
    case 'rep': {
      let n = node.min;
      const extra = ctx.grow + (ctx.rng ? Math.floor(ctx.rng() * 3) % 3 : 0);
      n = Math.min(node.max, node.min + extra);
      if (n === Infinity) n = node.min + 1;
      let out = '';
      for (let k = 0; k < n; k++) {
        const part = build(node.node, ctx);
        if (part === null) return null;
        out += part;
        if (out.length > 100000) return null;
      }
      return out;
    }
    default: return '';
  }
}

/**
 * Builds a string that matches the pattern. `rng` (optional) is a function returning numbers in
 * [0, 1) for varied output; `grow` (default 0) adds that many repetitions to every quantifier.
 * Returns null when no matching string could be built.
 */
function sampleFor(pattern, rng, grow) {
  const c = compile(pattern);
  if (!c.ok) return null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const ctx = { rng: attempt === 0 && !rng ? null : (rng || seeded(attempt)), grow: grow || 0 };
    const s = build(c.tree, ctx);
    if (s !== null && s.length <= MAX_TEST_LENGTH && c.regex.test(s)) return s;
  }
  return null;
}

/** A small deterministic random number source (mulberry32). */
function seeded(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { parse: parse, compile: compile, sampleFor: sampleFor, seeded: seeded, safeTest: safeTest, RegexError: RegexError, toJs: toJs, MAX_TEST_LENGTH: MAX_TEST_LENGTH };
