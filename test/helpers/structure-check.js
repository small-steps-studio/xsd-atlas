'use strict';
// Test helper: checks that an XML document is consistent with the structure of a schema set
// (element names and namespaces, order and occurrence of children, required and known attributes,
// facet-valid text). Used to check the sample documents; it is a test tool, not shipped, and
// covers the constructs the samples use (sequences, choices, all, wildcards, substitution groups,
// xsi:type, simple and mixed content).

const P = require('../../src/xml/parser');
const C = require('../../src/schema/content');
const F = require('../../src/schema/facets');
const B = require('../../src/schema/builtins');

function check(set, parsed) {
  const problems = [];
  const root = parsed.root;
  const comp = set.lookup('element', root.ns, root.local);
  if (!comp) return ['root element {' + root.ns + '}' + root.local + ' is not a global element'];
  checkElement(set, parsed, root, C.elementOfComp(set, comp), problems, '/' + root.local);
  return problems;
}

function substitutes(set, particle, el) {
  if (particle.ns === el.ns && particle.name === el.local) return particle;
  if (!particle.global) return null;
  const queue = set.membersOf(particle.global.key).slice();
  const seen = new Set();
  while (queue.length) {
    const m = queue.shift();
    if (seen.has(m.key)) continue;
    seen.add(m.key);
    if (m.ns === el.ns && m.name === el.local) return Object.assign(C.elementOfComp(set, m), { min: particle.min, max: particle.max });
    queue.push.apply(queue, set.membersOf(m.key));
  }
  return null;
}

function wildcardAllows(p, el) {
  const tokens = (p.namespace || '##any').split(/\s+/);
  const own = p.doc ? p.doc.ns : '';
  if (tokens.indexOf('##any') !== -1) return true;
  if (tokens.indexOf('##other') !== -1) return el.ns !== own && el.ns !== '';
  if (tokens.indexOf('##targetNamespace') !== -1 && el.ns === own) return true;
  if (tokens.indexOf('##local') !== -1 && el.ns === '') return true;
  return tokens.indexOf(el.ns) !== -1;
}

// Returns every end index reachable by matching particle p against kids starting at i, with the
// element assignments of one successful path.
function match(set, p, kids, i, depth) {
  if (depth > 60) return [];
  if (p.p === 'element' || p.p === 'any') {
    const results = [{ end: i, pairs: [] }];
    let frontier = [{ end: i, pairs: [] }];
    for (let n = 1; n <= Math.min(p.max, kids.length - i); n++) {
      const next = [];
      for (const f of frontier) {
        const el = kids[f.end];
        if (!el) continue;
        if (p.p === 'any') { if (wildcardAllows(p, el)) next.push({ end: f.end + 1, pairs: f.pairs.concat([{ el: el, any: p }]) }); }
        else { const s = substitutes(set, p, el); if (s) next.push({ end: f.end + 1, pairs: f.pairs.concat([{ el: el, particle: s }]) }); }
      }
      if (!next.length) break;
      for (const x of next) if (n >= p.min) results.push(x);
      frontier = next;
    }
    return results.filter(function (r) { return r.pairs.length >= p.min; });
  }
  let out = [];
  let frontier = [{ end: i, pairs: [] }];
  if (p.min === 0) out.push({ end: i, pairs: [] });
  for (let rep = 1; rep <= Math.min(p.max, kids.length + 1); rep++) {
    let next = [];
    for (const f of frontier) {
      if (p.p === 'sequence') {
        let partial = [f];
        for (const it of p.items) {
          const q = [];
          for (const x of partial) for (const r of match(set, it, kids, x.end, depth + 1)) q.push({ end: r.end, pairs: x.pairs.concat(r.pairs) });
          partial = dedupe(q);
        }
        next = next.concat(partial);
      } else if (p.p === 'choice') {
        for (const it of p.items) for (const r of match(set, it, kids, f.end, depth + 1)) next.push({ end: r.end, pairs: f.pairs.concat(r.pairs) });
      } else {
        // xs:all: any order, each item at most its max.
        next = next.concat(matchAll(set, p.items, kids, f, depth));
      }
    }
    const before = frontier.length ? Math.max.apply(null, frontier.map(function (fr) { return fr.end; })) : i;
    next = dedupe(next).filter(function (x) { return rep === 1 || x.end > before; });
    if (!next.length) break;
    if (rep >= p.min) out = out.concat(next);
    frontier = next;
  }
  return dedupe(out);
}

function matchAll(set, items, kids, start, depth) {
  let states = [{ end: start.end, pairs: start.pairs, used: items.map(function () { return 0; }) }];
  const done = [];
  for (let step = 0; step <= items.length; step++) {
    const next = [];
    for (const s of states) {
      if (items.every(function (it, k) { return s.used[k] >= it.min; })) done.push({ end: s.end, pairs: s.pairs });
      const el = kids[s.end];
      if (!el) continue;
      items.forEach(function (it, k) {
        if (s.used[k] >= it.max || it.p !== 'element') return;
        const sub = substitutes(set, it, el);
        if (sub) { const used = s.used.slice(); used[k]++; next.push({ end: s.end + 1, pairs: s.pairs.concat([{ el: el, particle: sub }]), used: used }); }
      });
    }
    states = next;
  }
  return done;
}

function dedupe(list) {
  const seen = new Map();
  for (const x of list) if (!seen.has(x.end)) seen.set(x.end, x);
  return Array.from(seen.values());
}

function typeOf(set, el, particle, problems, path) {
  let def = C.elementType(set, particle);
  const xsiType = el.attrs.find(function (a) { return a.ns === B.XSI_NS && a.local === 'type'; });
  if (xsiType) {
    const qn = P.splitQName(xsiType.value);
    const ns = P.lookupNamespace(el, qn.prefix);
    const comp = set.lookup('type', ns, qn.local);
    if (!comp) problems.push(path + ': unknown xsi:type ' + xsiType.value);
    else def = C.defOfComp(set, comp);
  }
  return def;
}

function checkElement(set, parsed, el, particle, problems, path) {
  if (problems.length > 20) return;
  const def = typeOf(set, el, particle, problems, path);
  if (def.abstract) problems.push(path + ': abstract type used without xsi:type');
  if (particle.abstract) problems.push(path + ': abstract element used');
  const attrs = def.category === 'complex' && def.attributes ? def.attributes : new Map();
  const seen = new Set();
  for (const a of el.attrs) {
    if (a.ns === P.XMLNS_NS || a.ns === B.XSI_NS) continue;
    const key = '{' + a.ns + '}' + a.local;
    seen.add(key);
    const use = attrs.get(key);
    if (!use) { if (!def.anyAttribute) problems.push(path + ': unexpected attribute ' + a.name); continue; }
    if (use.use === 'prohibited') problems.push(path + ': prohibited attribute ' + a.name);
    const r = F.checkValue(C.attributeType(set, use), a.value);
    if (r) problems.push(path + '/@' + a.name + ': ' + r + ' (' + a.value + ')');
    if (use.fixed !== undefined && a.value !== use.fixed) problems.push(path + '/@' + a.name + ': fixed value differs');
  }
  for (const [key, use] of attrs) if (use.use === 'required' && !seen.has(key)) problems.push(path + ': missing required attribute ' + use.name);
  const kids = P.childElements(el);
  const text = (el.children || []).filter(function (k) { return !(k instanceof P.XmlElement); }).map(function (k) { return parsed.textOf(k); }).join('');
  const simple = def.category === 'simple' || def.contentKind === 'simple';
  if (simple) {
    if (kids.length) problems.push(path + ': child elements in simple content');
    const value = text === '' && particle.default !== undefined ? particle.default : text;
    const r = F.checkValue(def, value);
    if (r) problems.push(path + ': ' + r + ' (' + value + ')');
    if (particle.fixed !== undefined && text !== '' && B.normaliseWhiteSpace(text, 'collapse') !== B.normaliseWhiteSpace(particle.fixed, 'collapse')) problems.push(path + ': fixed value differs');
    return;
  }
  if (def.builtin === 'anyType') return;
  if (def.contentKind !== 'mixed' && text.trim()) problems.push(path + ': text in element-only content');
  if (!def.particle || def.contentKind === 'empty') { if (kids.length) problems.push(path + ': children in empty content'); return; }
  const ends = match(set, def.particle, kids, 0, 0).filter(function (r) { return r.end === kids.length; });
  if (!ends.length) { problems.push(path + ': children ' + kids.map(function (k) { return k.local; }).join(',') + ' do not fit the content'); return; }
  for (const pair of ends[0].pairs) {
    if (pair.particle) checkElement(set, parsed, pair.el, pair.particle, problems, path + '/' + pair.el.local);
  }
}

module.exports = { check: check };
