'use strict';
// Random content structures (sequences, choices and elements with occurrence ranges) and random edits
// of them, as schema texts, for the differential comparison test.

const NAMES = ['a', 'b', 'c'];

function rng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGenerator(random) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const occurs = () => ({ min: pick([0, 1, 1, 1, 2]), max: pick([1, 1, 1, 2, 3, 'unbounded']) });
  function fix(n) { if (n.max !== 'unbounded' && n.max < n.min) n.max = n.min; return n; }
  function node(depth) {
    if (depth >= 3 || random() < 0.45) return fix(Object.assign({ k: 'el', name: pick(NAMES) }, occurs()));
    const count = 1 + Math.floor(random() * 3);
    const items = [];
    for (let i = 0; i < count; i++) items.push(node(depth + 1));
    return fix(Object.assign({ k: pick(['seq', 'choice']), items: items }, random() < 0.6 ? { min: 1, max: 1 } : occurs()));
  }
  function walk(n, out) { out.push(n); if (n.items) n.items.forEach(function (x) { walk(x, out); }); return out; }
  function mutate(root) {
    const copy = JSON.parse(JSON.stringify(root));
    const edits = 1 + Math.floor(random() * 2);
    for (let e = 0; e < edits; e++) {
      const nodes = walk(copy, []);
      const n = pick(nodes);
      const kind = Math.floor(random() * 7);
      if (kind === 0) { n.min = pick([0, 1, 2]); fix(n); }
      else if (kind === 1) { n.max = pick([1, 2, 3, 'unbounded']); fix(n); }
      else if (kind === 2 && n.items) n.items.push(node(2));
      else if (kind === 3 && n.items && n.items.length > 1) n.items.splice(Math.floor(random() * n.items.length), 1);
      else if (kind === 4 && n.items && n.items.length > 1) n.items.reverse();
      else if (kind === 5 && n.items) n.k = n.k === 'seq' ? 'choice' : 'seq';
      else if (kind === 6 && n.k === 'el') n.name = pick(NAMES);
    }
    return copy;
  }
  // An xs:all of up to three different names, each optional or required, and a random edit of it.
  function allNode() {
    const pool = NAMES.slice();
    const items = [];
    const count = 1 + Math.floor(random() * 3);
    for (let i = 0; i < count && pool.length; i++) items.push({ k: 'el', name: pool.splice(Math.floor(random() * pool.length), 1)[0], min: pick([0, 0, 1]), max: 1 });
    return { k: 'all', items: items, min: pick([1, 1, 0]), max: 1 };
  }
  function allMutate(root) {
    const copy = JSON.parse(JSON.stringify(root));
    const edits = 1 + Math.floor(random() * 2);
    for (let e = 0; e < edits; e++) {
      const kind = Math.floor(random() * 4);
      const used = copy.items.map(function (x) { return x.name; });
      const free = NAMES.filter(function (n) { return used.indexOf(n) === -1; });
      if (kind === 0) copy.min = copy.min === 1 ? 0 : 1;
      else if (kind === 1 && copy.items.length) { const x = pick(copy.items); x.min = x.min === 1 ? 0 : 1; }
      else if (kind === 2 && free.length) copy.items.push({ k: 'el', name: pick(free), min: pick([0, 1]), max: 1 });
      else if (kind === 3 && copy.items.length > 1) copy.items.splice(Math.floor(random() * copy.items.length), 1);
    }
    return copy;
  }
  return { node: node, mutate: mutate, allNode: allNode, allMutate: allMutate };
}

/**
 * True when the structure stays small for the independent processor: at most nine nodes, no
 * repetition inside an unbounded repetition, and counted repetitions that multiply to at most 12.
 * (Nested stars of optional content make the libxml2 automaton construction take minutes.)
 */
function tame(root) {
  let count = 0;
  function walk(n, product, starred) {
    count++;
    const factor = n.max === 'unbounded' ? 3 : n.max;
    const unbounded = n.max === 'unbounded';
    if (unbounded && starred) return false;
    const next = product * (factor > 1 ? factor : 1);
    if (next > 12) return false;
    return !n.items || n.items.every(function (x) { return walk(x, next, starred || unbounded); });
  }
  return walk(root, 1, false) && count <= 9;
}

function occ(n) {
  return (n.min !== 1 ? ' minOccurs="' + n.min + '"' : '') + (n.max !== 1 ? ' maxOccurs="' + n.max + '"' : '');
}
function xml(n) {
  if (n.k === 'el') return '<xs:element name="' + n.name + '" type="xs:string"' + occ(n) + '/>';
  const tag = n.k === 'seq' ? 'xs:sequence' : n.k === 'all' ? 'xs:all' : 'xs:choice';
  return '<' + tag + occ(n) + '>' + n.items.map(xml).join('') + '</' + tag + '>';
}
function schema(root) {
  const body = root.k === 'el' ? '<xs:sequence>' + xml(root) + '</xs:sequence>' : xml(root);
  return '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:t="urn:t" targetNamespace="urn:t" elementFormDefault="qualified">' +
    '<xs:element name="root" type="t:T"/><xs:complexType name="T">' + body + '</xs:complexType></xs:schema>';
}

module.exports = { NAMES: NAMES, rng: rng, makeGenerator: makeGenerator, schema: schema, tame: tame };
