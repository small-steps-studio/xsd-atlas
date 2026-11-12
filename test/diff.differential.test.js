'use strict';
// The comparison against an independent schema processor on random content structures.
//
// Random pairs of content structures (sequences, choices and elements with random occurrence
// ranges, the second one a random edit of the first) are compiled by libxml2 (through the lxml
// package for Python, when installed). Every sequence of up to four child elements over three
// names is validated against both. Rule under test: when some sequence is valid under the old
// structure and invalid under the new one, the comparison must report at least one BREAKING
// change; the comparison may be more cautious than the processor, never less.
//
// XSD_ATLAS_DIFF_ROUNDS sets the number of pairs (default 300); XSD_ATLAS_DIFF_SEED the seed.
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const path = require('node:path');
const L = require('./helpers/load');
const { diffSets } = require('../src/pro/diff');
const INC = require('../src/pro/inclusion');

const R = require('./helpers/random-content');
const NAMES = R.NAMES;
const SEED = Number(process.env.XSD_ATLAS_DIFF_SEED) || 20261112;
const ROUNDS = Number(process.env.XSD_ATLAS_DIFF_ROUNDS) || 300;
const rng = R.rng;
const makeGenerator = R.makeGenerator;
const schema = R.schema;
const tame = R.tame;

function oracleAvailable() {
  const r = cp.spawnSync('python', ['-c', 'import lxml'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0;
}

test('comparison: random content structures never hide a change that the libxml2 processor sees (seeded)', { skip: !oracleAvailable() && 'the lxml package for Python is not installed' }, async () => {
  const gen = makeGenerator(rng(SEED));
  const pairs = [];
  while (pairs.length < ROUNDS) {
    const base = gen.node(0);
    const edited = gen.mutate(base);
    if (tame(base) && tame(edited)) pairs.push({ old: schema(base), new: schema(edited) });
  }
  const r = cp.spawnSync('python', [path.join(__dirname, 'helpers', 'sequences.py')], {
    input: JSON.stringify({ pairs: pairs, names: NAMES, maxLength: 4 }), encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 28
  });
  assert.equal(r.status, 0, r.stderr);
  const verdicts = JSON.parse(r.stdout);
  let compared = 0;
  let lostCases = 0;
  const missed = [];
  const alarms = [];
  for (let i = 0; i < pairs.length; i++) {
    if (!verdicts[i].ok) continue; // the processor refuses the schema (for example an ambiguous content)
    compared++;
    const a = await L.loadTexts({ 'main.xsd': pairs[i].old });
    const b = await L.loadTexts({ 'main.xsd': pairs[i].new });
    const d = diffSets(a, b);
    if (verdicts[i].lost.length) {
      lostCases++;
      if (!d.counts.BREAKING) missed.push({ round: i, witness: verdicts[i].lost[0], old: pairs[i].old.slice(pairs[i].old.indexOf('<xs:complexType')), new: pairs[i].new.slice(pairs[i].new.indexOf('<xs:complexType')) });
    } else if (d.counts.BREAKING && !verdicts[i].gained.length) {
      alarms.push(i);
    }
  }
  if (process.env.XSD_ATLAS_DIFF_VERBOSE) process.stdout.write('pairs ' + ROUNDS + ', compiled ' + compared + ', with a lost document ' + lostCases + ', cautious reports ' + alarms.length + ', missed ' + missed.length + '\n');
  assert.deepEqual(missed, [], 'changes that make old documents invalid but were not reported as BREAKING (seed ' + SEED + ')');
  assert.ok(compared >= ROUNDS / 4, 'enough pairs compile: ' + compared + ' of ' + ROUNDS);
  assert.ok(lostCases >= 1, 'the sample holds breaking changes at all');
  // A BREAKING report without any witness of up to four children is possible (a longer witness,
  // or a deliberately cautious verdict), but it must stay rare.
  assert.ok(alarms.length <= Math.max(3, compared * 0.1), 'cautious reports without a witness: ' + alarms.length + ' of ' + compared);
});

// xs:all contents are decided without the search; the decision must agree with the search and with
// the independent processor.
test('comparison: xs:all contents agree with the exact search and with libxml2 (seeded)', { skip: !oracleAvailable() && 'the lxml package for Python is not installed' }, async () => {
  const gen = makeGenerator(rng(SEED + 1));
  const pairs = [];
  const trees = [];
  for (let i = 0; i < ROUNDS; i++) {
    const base = gen.allNode();
    const edited = gen.allMutate(base);
    trees.push([base, edited]);
    pairs.push({ old: schema(base), new: schema(edited) });
  }
  const r = cp.spawnSync('python', [path.join(__dirname, 'helpers', 'sequences.py')], {
    input: JSON.stringify({ pairs: pairs, names: NAMES, maxLength: 3 }), encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 28
  });
  assert.equal(r.status, 0, r.stderr);
  const verdicts = JSON.parse(r.stdout);
  const particle = (n) => ({ p: 'all', min: n.min, max: 1, items: n.items.map((x) => ({ p: 'element', name: x.name, ns: 'urn:t', min: x.min, max: 1 })) });
  const options = (extra) => Object.assign({
    leafOf: (side, p) => ({ key: 'E' + p.name, symbol: { ns: 'urn:t', local: p.name, label: p.name }, test: (s) => s.local === p.name && s.ns === 'urn:t' })
  }, extra || {});
  let lost = 0;
  for (let i = 0; i < pairs.length; i++) {
    if (!verdicts[i].ok) continue;
    const direct = INC.compareContent(particle(trees[i][0]), particle(trees[i][1]), options());
    const search = INC.compareContent(particle(trees[i][0]), particle(trees[i][1]), options({ forceSearch: true }));
    assert.equal(direct.status === 'narrowed', search.status === 'narrowed', 'direct and search disagree for ' + pairs[i].old + ' and ' + pairs[i].new);
    assert.equal(direct.status === 'narrowed', verdicts[i].lost.length > 0, 'the independent processor disagrees for ' + pairs[i].old + ' and ' + pairs[i].new);
    if (direct.status === 'narrowed') lost++;
    const d = diffSets(await L.loadTexts({ 'main.xsd': pairs[i].old }), await L.loadTexts({ 'main.xsd': pairs[i].new }));
    if (verdicts[i].lost.length) assert.ok(d.counts.BREAKING >= 1, 'a breaking change was not reported: ' + pairs[i].new);
  }
  assert.ok(lost >= 1, 'the sample holds breaking changes at all');
});

// The same random pairs with the exact check forced to "unknown": the result may be more cautious,
// never less, so no change that breaks old documents may disappear.
test('comparison: with the exact check forced to "unknown", random pairs still never hide a breaking change (seeded)', { skip: !oracleAvailable() && 'the lxml package for Python is not installed' }, async () => {
  const gen = makeGenerator(rng(SEED + 2));
  const pairs = [];
  while (pairs.length < ROUNDS) {
    const base = gen.node(0);
    const edited = gen.mutate(base);
    if (tame(base) && tame(edited)) pairs.push({ old: schema(base), new: schema(edited) });
  }
  for (let i = 0; i < ROUNDS / 2; i++) {
    const base = gen.allNode();
    pairs.push({ old: schema(base), new: schema(gen.allMutate(base)) });
  }
  const r = cp.spawnSync('python', [path.join(__dirname, 'helpers', 'sequences.py')], {
    input: JSON.stringify({ pairs: pairs, names: NAMES, maxLength: 4 }), encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 28
  });
  assert.equal(r.status, 0, r.stderr);
  const verdicts = JSON.parse(r.stdout);
  const original = INC.compareContent;
  INC.compareContent = function () { return { status: 'unknown', witness: [], steps: 0 }; };
  const missed = [];
  let lost = 0;
  try {
    for (let i = 0; i < pairs.length; i++) {
      if (!verdicts[i].ok || !verdicts[i].lost.length) continue;
      lost++;
      const d = diffSets(await L.loadTexts({ 'main.xsd': pairs[i].old }), await L.loadTexts({ 'main.xsd': pairs[i].new }));
      if (!d.counts.BREAKING) missed.push({ round: i, witness: verdicts[i].lost[0], old: pairs[i].old.slice(pairs[i].old.indexOf('<xs:complexType')), new: pairs[i].new.slice(pairs[i].new.indexOf('<xs:complexType')) });
    }
  } finally { INC.compareContent = original; }
  assert.deepEqual(missed, [], 'breaking changes that disappeared without the exact check (seed ' + SEED + ')');
  assert.ok(lost >= 1, 'the sample holds breaking changes at all');
});
