'use strict';
// Schema comparison: changes inside optional groups, choice branches, unions and attribute uses,
// each with a witness document that is valid under the old version and invalid under the new
// one. Every such pair must give at least one BREAKING change; when the lxml package for Python
// is installed, an independent schema processor confirms each witness as well.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const L = require('./helpers/load');
const { diffSets, RULES } = require('../src/pro/diff');

const { sch, T, el, seq, cho, doc, V, inlineStr, BREAKS, SAFE } = require('./helpers/diff-cases');

async function diff(oldText, newText) {
  const a = await L.loadTexts({ 'main.xsd': oldText });
  const b = await L.loadTexts({ 'main.xsd': newText });
  return diffSets(a, b);
}


for (const [name, oldText, newText, witness, code] of BREAKS) {
  test('comparison: ' + name + ' is BREAKING (' + code + ')', async () => {
    const r = await diff(oldText, newText);
    const breaking = r.changes.filter((c) => c.severity === 'BREAKING').map((c) => c.code);
    assert.ok(breaking.includes(code), 'BREAKING codes: ' + JSON.stringify(r.changes.map((c) => c.code + ' ' + c.severity)));
    assert.ok(witness.length > 0);
  });
}


for (const [name, oldText, newText, expected] of SAFE) {
  test('comparison: ' + name + ' is not BREAKING', async () => {
    const r = await diff(oldText, newText);
    assert.deepEqual(r.changes.filter((c) => c.severity === 'BREAKING').map((c) => c.code + ': ' + c.message), []);
    assert.deepEqual(r.changes.map((c) => c.code).sort(), expected.slice().sort());
  });
}

test('comparison: text enumerations still compare as text', async () => {
  const r = await diff(sch('<xs:simpleType name="S"><xs:restriction base="xs:string"><xs:enumeration value="1.0"/></xs:restriction></xs:simpleType>'),
    sch('<xs:simpleType name="S"><xs:restriction base="xs:string"><xs:enumeration value="1.00"/></xs:restriction></xs:simpleType>'));
  assert.deepEqual(r.changes.map((c) => c.code).sort(), ['enumeration-added', 'enumeration-removed']);
});

test('comparison: a strict wildcard without a matching declaration does not cover a removed element', async () => {
  const r = await diff(T(seq('', el('h'), el('a', 'minOccurs="0"'))), T(seq('', el('h'), '<xs:any namespace="##any" processContents="strict" minOccurs="0"/>')));
  assert.ok(r.changes.some((c) => c.code === 'child-removed' && c.severity === 'BREAKING'));
});

test('comparison: every new code is in the rule table with the right class', () => {
  const expected = {
    'child-added-conditional': 'BREAKING', 'became-required-in-group': 'BREAKING', 'became-optional-in-group': 'NON-BREAKING',
    'group-became-required': 'BREAKING', 'group-became-optional': 'NON-BREAKING', 'group-min-increased': 'BREAKING', 'content-not-verified': 'BREAKING', 'child-covered-by-wildcard': 'NON-BREAKING', 'attribute-covered-by-wildcard': 'NON-BREAKING'
  };
  for (const [code, cls] of Object.entries(expected)) assert.equal(RULES[code], cls, code);
});

function oracleAvailable() {
  const r = cp.spawnSync('python', ['-c', 'import lxml'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0;
}

test('comparison: an independent schema processor confirms every witness (libxml2, when installed)', { skip: !oracleAvailable() && 'the lxml package for Python is not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsdatlas-witness-'));
  try {
    const instances = [];
    BREAKS.forEach(function (c, i) {
      const o = path.join(dir, i + '-old.xsd');
      const n = path.join(dir, i + '-new.xsd');
      const w = path.join(dir, i + '-witness.xml');
      fs.writeFileSync(o, c[1]);
      fs.writeFileSync(n, c[2]);
      fs.writeFileSync(w, c[3]);
      instances.push([o, w], [n, w]);
    });
    const r = cp.spawnSync('python', [path.join(__dirname, 'helpers', 'oracle.py')], { input: JSON.stringify({ schemas: [], instances: instances }), encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 });
    assert.equal(r.status, 0, r.stderr);
    const answer = JSON.parse(r.stdout).instances;
    for (let i = 0; i < BREAKS.length; i++) {
      assert.equal(answer[2 * i].error, '', BREAKS[i][0] + ': the witness must be valid under the old version');
      assert.notEqual(answer[2 * i + 1].error, '', BREAKS[i][0] + ': the witness must be invalid under the new version');
      const d = await diff(BREAKS[i][1], BREAKS[i][2]);
      assert.ok(d.counts.BREAKING >= 1, BREAKS[i][0] + ': at least one BREAKING change');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
