'use strict';
// Exact comparison of two child-element patterns: does the new pattern accept every sequence of
// child elements that the old one accepts?
//
// A child-element pattern (sequence, choice, all, element and wildcard particles with minOccurs and
// maxOccurs) is a regular expression over element names with counted repetition. The comparison
// explores both expressions side by side, one child element at a time, using derivatives (the
// derivative of a pattern by an element name is what is left of it after that element). A
// pair in which the old rest may end and the new rest may not is a child sequence that the old
// version accepts and the new one refuses; the search is breadth first, so the sequence it
// reports is a shortest one. Element names that behave alike in both patterns are explored once.
//
// The search stops after a fixed amount of work and after a fixed time (default 150 ms), and then
// answers 'unknown'; the caller then reports a changed content as not verified (BREAKING). The
// content of an xs:all (every child at most once, in any order) is decided directly, without the
// search: its interleavings would make the search slow for dozens of children. Only the names and
// the order of child elements are compared here; types, values and attributes are compared by
// the callers.

const EMPTY = 0;
const EPS = 1;
const MAX_STEPS = 250000;
const MAX_PAIRS = 40000;
const MAX_NESTING = 200;
const MAX_MILLIS = 150;

class Budget extends Error {}

class Lang {
  constructor(maxSteps) {
    this.nodes = [{ k: 'empty' }, { k: 'eps' }];
    this.ids = new Map();
    this.nullMemo = [false, true];
    this.derivMemo = new Map();
    this.leafIndex = new Map();
    this.leaves = [];
    this.match = null;
    this.maxSteps = maxSteps || MAX_STEPS;
    this.steps = 0;
    this.deadline = Infinity;
  }

  intern(key, node) {
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.nodes.length;
      this.nodes.push(node);
      this.ids.set(key, id);
      if (this.nodes.length > this.maxSteps) throw new Budget();
    }
    return id;
  }

  /** A leaf: `key` identifies what it matches (the same key on both sides means the same names). */
  leaf(key, test) {
    let i = this.leafIndex.get(key);
    if (i === undefined) {
      i = this.leaves.length;
      this.leaves.push({ key: key, test: test });
      this.leafIndex.set(key, i);
    }
    return this.intern('S' + i, { k: 'sym', leaf: i });
  }

  seq(list) {
    const items = [];
    for (const x of list) {
      if (x === EMPTY) return EMPTY;
      if (x === EPS) continue;
      const n = this.nodes[x];
      if (n.k === 'seq') for (const y of n.items) items.push(y);
      else items.push(x);
    }
    if (!items.length) return EPS;
    if (items.length === 1) return items[0];
    return this.intern('Q' + items.join(','), { k: 'seq', items: items });
  }

  alt(list) {
    const set = new Set();
    for (const x of list) {
      if (x === EMPTY) continue;
      const n = this.nodes[x];
      if (n.k === 'alt') for (const y of n.items) set.add(y);
      else set.add(x);
    }
    if (set.has(EPS) && set.size > 1) {
      for (const y of set) if (y !== EPS && this.nullable(y)) { set.delete(EPS); break; }
    }
    const items = Array.from(set).sort(function (a, b) { return a - b; });
    if (!items.length) return EMPTY;
    if (items.length === 1) return items[0];
    return this.intern('A' + items.join(','), { k: 'alt', items: items });
  }

  rep(a, min, max) {
    let m = min;
    if (max === 0) return EPS;
    if (a === EMPTY) return m === 0 ? EPS : EMPTY;
    if (a === EPS) return EPS;
    // A content that may be empty may also be repeated zero times.
    if (m > 0 && this.nullable(a)) m = 0;
    if (m === 1 && max === 1) return a;
    if (m === 0 && max === 1 && this.nullable(a)) return a;
    const inner = this.nodes[a];
    if (inner.k === 'rep' && inner.m === 0 && inner.n === Infinity && max === Infinity && m <= 1) return a;
    return this.intern('R' + a + ',' + m + ',' + (max === Infinity ? '*' : max), { k: 'rep', a: a, m: m, n: max });
  }

  shuf(list) {
    const items = [];
    for (const x of list) {
      if (x === EMPTY) return EMPTY;
      if (x === EPS) continue;
      const n = this.nodes[x];
      if (n.k === 'shuf') for (const y of n.items) items.push(y);
      else items.push(x);
    }
    items.sort(function (a, b) { return a - b; });
    if (!items.length) return EPS;
    if (items.length === 1) return items[0];
    return this.intern('H' + items.join(','), { k: 'shuf', items: items });
  }

  nullable(id) {
    const memo = this.nullMemo[id];
    if (memo !== undefined) return memo;
    const n = this.nodes[id];
    let v;
    const self = this;
    if (n.k === 'sym') v = false;
    else if (n.k === 'seq' || n.k === 'shuf') v = n.items.every(function (x) { return self.nullable(x); });
    else if (n.k === 'alt') v = n.items.some(function (x) { return self.nullable(x); });
    else if (n.k === 'rep') v = n.m === 0 || this.nullable(n.a);
    else v = false;
    this.nullMemo[id] = v;
    return v;
  }

  deriv(id, c) {
    if (id === EMPTY || id === EPS) return EMPTY;
    const key = id + ':' + c;
    const memo = this.derivMemo.get(key);
    if (memo !== undefined) return memo;
    if (++this.steps > this.maxSteps) throw new Budget();
    if ((this.steps & 127) === 0 && Date.now() > this.deadline) throw new Budget();
    const n = this.nodes[id];
    let r;
    if (n.k === 'sym') r = this.match[n.leaf][c] ? EPS : EMPTY;
    else if (n.k === 'seq') {
      const out = [];
      for (let i = 0; i < n.items.length; i++) {
        const d = this.deriv(n.items[i], c);
        if (d !== EMPTY) out.push(this.seq([d].concat(n.items.slice(i + 1))));
        if (!this.nullable(n.items[i])) break;
      }
      r = this.alt(out);
    } else if (n.k === 'alt') {
      const self = this;
      r = this.alt(n.items.map(function (x) { return self.deriv(x, c); }));
    } else if (n.k === 'rep') {
      const d = this.deriv(n.a, c);
      r = d === EMPTY ? EMPTY : this.seq([d, this.rep(n.a, Math.max(n.m - 1, 0), n.n === Infinity ? Infinity : n.n - 1)]);
    } else if (n.k === 'shuf') {
      const out = [];
      for (let i = 0; i < n.items.length; i++) {
        const d = this.deriv(n.items[i], c);
        if (d === EMPTY) continue;
        const rest = n.items.slice();
        rest[i] = d;
        out.push(this.shuf(rest));
      }
      r = this.alt(out);
    } else r = EMPTY;
    this.derivMemo.set(key, r);
    return r;
  }
}

/**
 * Builds the expression of a particle tree. `leafOf(particle)` returns { key, test } for element
 * and wildcard particles, where test({ ns, local }) says whether a child element with that name
 * matches the particle.
 */
function build(lang, particle, leafOf) {
  function walk(p, depth) {
    if (!p) return EPS;
    if (depth > MAX_NESTING) throw new Budget();
    const max = p.max === undefined ? 1 : p.max;
    const min = p.min === undefined ? 1 : p.min;
    if (max === 0) return EPS;
    let body;
    if (p.p === 'element' || p.p === 'any') {
      const l = leafOf(p);
      body = lang.leaf(l.key, l.test);
    } else {
      const items = (p.items || []).map(function (x) { return walk(x, depth + 1); });
      if (p.p === 'choice') body = items.length ? lang.alt(items) : EMPTY;
      else if (p.p === 'all') body = lang.shuf(items);
      else body = lang.seq(items);
    }
    return lang.rep(body, min, max);
  }
  return walk(particle, 0);
}

/**
 * Compares two particle trees (either may be null for "no child elements").
 *   options.leafOf(side, particle)  -> { key, test } (see build)
 *   options.symbols()               -> candidate child names [{ ns, local, label, plain }] beyond
 *                                      the names of the element particles: representatives for
 *                                      wildcards (`plain` marks a description, not a name)
 *   options.maxSteps                -> work limit
 * Returns { status: 'equal' | 'included' | 'narrowed' | 'unknown', witness: [symbols], steps };
 * the witness is a shortest child sequence that the old pattern accepts and the new one refuses.
 */
function compareContent(oldParticle, newParticle, options) {
  const o = options || {};
  const direct = o.forceSearch ? null : compareAll(oldParticle, newParticle, o);
  if (direct) return direct;
  const lang = new Lang(o.maxSteps);
  lang.deadline = Date.now() + (o.maxMillis > 0 ? o.maxMillis : MAX_MILLIS);
  const r = search(lang, oldParticle, newParticle, o);
  r.steps = lang.steps + lang.nodes.length;
  return r;
}

/**
 * The names of an xs:all particle: { min, names: Map key -> { symbol, required, index } }, or null
 * when the particle is not a plain xs:all (another kind of particle, a wildcard, a child that may
 * occur more than once, the same name twice).
 */
function allShape(p, side, o) {
  if (!p || p.p !== 'all') return null;
  const min = p.min === undefined ? 1 : p.min;
  const max = p.max === undefined ? 1 : p.max;
  if (max !== 1 || min > 1) return null;
  const names = new Map();
  const items = p.items || [];
  for (let i = 0; i < items.length; i++) {
    const x = items[i];
    if (!x || x.p !== 'element') return null;
    const xmin = x.min === undefined ? 1 : x.min;
    const xmax = x.max === undefined ? 1 : x.max;
    if (xmax > 1 || xmin > xmax) return null;
    if (xmax === 0) continue;
    const l = o.leafOf(side, x);
    if (names.has(l.key)) return null;
    names.set(l.key, { symbol: l.symbol, required: xmin > 0, index: i });
  }
  let required = 0;
  for (const v of names.values()) if (v.required) required++;
  return { min: min, names: names, required: required };
}

/** Whether an xs:all accepts the children that are the given set of names (in any order). */
function allAccepts(shape, present) {
  if (present.length === 0) return shape.min === 0 || shape.required === 0;
  const set = new Set(present);
  for (const k of set) if (!shape.names.has(k)) return false;
  for (const [k, v] of shape.names) if (v.required && !set.has(k)) return false;
  return true;
}

/**
 * Decides two xs:all particles without the search. The sets of names that the old one accepts are
 * the empty set (when it may be empty), and every set between its required names and all its
 * names; so it is enough to try the smallest sets, the required names with one more name, and the
 * set of all names. Returns null when either particle is not a plain xs:all.
 */
function compareAll(oldParticle, newParticle, o) {
  const a = allShape(oldParticle, 'old', o);
  const b = a ? allShape(newParticle, 'new', o) : null;
  if (!a || !b) return null;
  const byIndex = Array.from(a.names.entries()).sort(function (x, y) { return x[1].index - y[1].index; });
  const requiredKeys = byIndex.filter(function (e) { return e[1].required; }).map(function (e) { return e[0]; });
  const candidates = [[]];
  if (requiredKeys.length) candidates.push(requiredKeys);
  for (const [k, v] of byIndex) if (!v.required) candidates.push(requiredKeys.concat([k]));
  candidates.push(byIndex.map(function (e) { return e[0]; }));
  for (const c of candidates) {
    if (!allAccepts(a, c) || allAccepts(b, c)) continue;
    const ordered = byIndex.filter(function (e) { return c.indexOf(e[0]) !== -1; });
    return { status: 'narrowed', witness: ordered.map(function (e) { return e[1].symbol; }) };
  }
  return { status: 'included', witness: [] };
}

function search(lang, oldParticle, newParticle, o) {
  try {
    const symbols = new Map();
    const addSymbol = function (s) { const k = '{' + s.ns + '}' + s.local; if (!symbols.has(k)) symbols.set(k, s); };
    const leafOf = function (side) {
      return function (p) {
        const l = o.leafOf(side, p);
        if (l.symbol) addSymbol(l.symbol);
        return l;
      };
    };
    const A = build(lang, oldParticle, leafOf('old'));
    const B = build(lang, newParticle, leafOf('new'));
    if (A === B) return { status: 'equal', witness: [] };
    for (const s of (o.symbols ? o.symbols() : [])) addSymbol(s);
    // Names that match the same leaves behave alike: one representative per group.
    const classes = [];
    const bySignature = new Map();
    for (const s of symbols.values()) {
      let sig = '';
      for (const l of lang.leaves) sig += l.test(s) ? '1' : '0';
      if (sig.indexOf('1') === -1 || bySignature.has(sig)) continue;
      bySignature.set(sig, classes.length);
      classes.push(s);
    }
    lang.match = lang.leaves.map(function (l) { return classes.map(function (s) { return l.test(s); }); });
    // Breadth-first search over pairs of rests.
    const seen = new Map();
    const queue = [[A, B, -1, -1]];
    seen.set(A + ',' + B, 0);
    for (let head = 0; head < queue.length; head++) {
      if ((head & 63) === 63 && Date.now() > lang.deadline) throw new Budget();
      const [x, y] = queue[head];
      if (lang.nullable(x) && !lang.nullable(y)) {
        const witness = [];
        for (let k = head; k > 0; k = queue[k][2]) witness.push(classes[queue[k][3]]);
        return { status: 'narrowed', witness: witness.reverse() };
      }
      for (let c = 0; c < classes.length; c++) {
        const dx = lang.deriv(x, c);
        if (dx === EMPTY) continue;
        const dy = lang.deriv(y, c);
        const key = dx + ',' + dy;
        if (seen.has(key)) continue;
        if (queue.length >= MAX_PAIRS) throw new Budget();
        seen.set(key, queue.length);
        queue.push([dx, dy, head, c]);
      }
    }
    return { status: 'included', witness: [] };
  } catch (e) {
    if (e instanceof Budget || e instanceof RangeError) return { status: 'unknown', witness: [] };
    throw e;
  }
}

module.exports = { compareContent: compareContent, Lang: Lang, build: build, EMPTY: EMPTY, EPS: EPS };
