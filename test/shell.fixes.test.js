'use strict';
// The extension inside a stand-in editor: the licence environment cannot be chosen by a user, the
// diagnostics block shows only what is true and harmless, the export setting is honoured, and
// files outside the workspace are not read in an untrusted workspace.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./helpers/vscode-mock');
const samples = require('../src/samples');
const pkg = require('../package.json');

const V1 = 'file:///work/order-v1.xsd';
const V2 = 'file:///work/order-v2.xsd';

async function start(options, extensionMode) {
  const o = options || {};
  const mock = M.createMock(Object.assign({
    files: { [V1]: samples.sampleFor('schema').text, [V2]: samples.sampleFor('schemaV2').text },
    active: V2, folders: [{ uri: M.Uri.parse('file:///work'), name: 'work' }]
  }, o));
  const uninstall = M.install(mock.vscode);
  const srcDir = require('node:path').join(__dirname, '..', 'src');
  for (const k of Object.keys(require.cache)) if (k.startsWith(srcDir)) delete require.cache[k];
  const ext = require('../src/extension');
  const context = M.makeContext(pkg, extensionMode);
  ext.activate(context);
  return { mock: mock, state: mock.state, context: context, ext: ext, uninstall: uninstall, run: (id, ...a) => mock.vscode.commands.executeCommand(id, ...a) };
}

function recordFetch(answer) {
  const urls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    urls.push(String(url));
    return { status: answer || 404, json: async () => ({ code: 'X' }) };
  };
  return { urls: urls, restore: () => { global.fetch = original; } };
}

test('licence environment: an installed copy always uses the live service, whatever the settings and the environment say', async () => {
  const previous = process.env.XSD_ATLAS_LICENCE_ENV;
  process.env.XSD_ATLAS_LICENCE_ENV = 'test';
  const config = {};
  for (const k of Object.keys(pkg.contributes.configuration.properties)) config[k.replace(/^xsdAtlas\./, '')] = 'test';
  for (const k of ['licenceMode', 'licence.mode', 'licenceEnvironment', 'licence.environment', 'mode', 'environment', 'testMode']) config[k] = 'test';
  const x = await start({ config: config, inputAnswers: ['SOME-KEY', 'SOME-KEY'], quickPickAnswers: [0, 0] }, 1);
  const net = recordFetch(404);
  try {
    await x.run('xsdAtlas.enterKey');
    await x.run('xsdAtlas.licenceStatus');
    await x.run('xsdAtlas.buyPro');
    assert.ok(net.urls.length >= 1, 'the key was sent to a licence service');
    for (const u of net.urls) assert.equal(new URL(u).host, 'live.dodopayments.com', u);
    assert.deepEqual(x.state.opened, ['https://checkout.dodopayments.com/buy/pdt_0NrlyVvfLevuTEDqI9l53?quantity=1']);
  } finally {
    net.restore();
    x.uninstall();
    if (previous === undefined) delete process.env.XSD_ATLAS_LICENCE_ENV; else process.env.XSD_ATLAS_LICENCE_ENV = previous;
  }
});

test('licence environment: only an extension development host started with the variable reaches the test service', async () => {
  const previous = process.env.XSD_ATLAS_LICENCE_ENV;
  try {
    for (const [mode, value, expected] of [[1, 'test', 'live'], [1, undefined, 'live'], [2, undefined, 'live'], [2, 'live', 'live'], [2, 'TEST', 'live'], [2, 'test', 'test'], [3, 'test', 'test']]) {
      if (value === undefined) delete process.env.XSD_ATLAS_LICENCE_ENV; else process.env.XSD_ATLAS_LICENCE_ENV = value;
      const x = await start({}, mode);
      try {
        assert.equal(x.ext.licenceModeFor({ extensionMode: mode })(), expected, 'mode ' + mode + ' variable ' + value);
      } finally { x.uninstall(); }
    }
    process.env.XSD_ATLAS_LICENCE_ENV = 'test';
    const dev = await start({ inputAnswers: ['SOME-KEY'] }, 2);
    const net = recordFetch(404);
    try {
      await dev.run('xsdAtlas.enterKey');
      assert.ok(net.urls.length >= 1);
      for (const u of net.urls) assert.equal(new URL(u).host, 'test.dodopayments.com', u);
    } finally { net.restore(); dev.uninstall(); }
  } finally {
    if (previous === undefined) delete process.env.XSD_ATLAS_LICENCE_ENV; else process.env.XSD_ATLAS_LICENCE_ENV = previous;
  }
});

test('the contributed settings and commands offer no way to the test environment or the licence server', () => {
  const props = pkg.contributes.configuration.properties;
  for (const [k, v] of Object.entries(props)) {
    assert.doesNotMatch(k + ' ' + JSON.stringify(v), /licen[cs]e.?(mode|env|server)|test.?(mode|env)|sandbox|dodopayments/i, k);
  }
  for (const c of pkg.contributes.commands) assert.doesNotMatch(c.command + ' ' + c.title, /test.?(mode|env)|sandbox|environment/i, c.command);
});

test('Report A Problem shows whether the glob settings were changed, never their text', async () => {
  const x = await start({ config: { 'workspace.include': 'clients/acme-bank/**/*.xsd', 'workspace.exclude': 'secret-project/**' } });
  try {
    await x.run('xsdAtlas.reportProblem');
    const block = x.state.clipboard;
    assert.match(block, /workspace\.include = custom/);
    assert.match(block, /workspace\.exclude = custom/);
    for (const bad of ['acme', 'bank', 'secret-project', 'clients']) assert.ok(!block.includes(bad), bad);
  } finally { x.uninstall(); }
  const y = await start();
  try {
    await y.run('xsdAtlas.reportProblem');
    assert.match(y.state.clipboard, /workspace\.include = default/);
    assert.match(y.state.clipboard, /workspace\.exclude = default/);
  } finally { y.uninstall(); }
});

test('the export setting is contributed, defaults to on, is honoured and is shown in the diagnostics', async () => {
  const p = pkg.contributes.configuration.properties['xsdAtlas.export.neutraliseFormulas'];
  assert.ok(p && p.type === 'boolean' && p.default === true);
  const on = await start();
  try {
    await on.run('xsdAtlas.reportProblem');
    assert.match(on.state.clipboard, /export\.neutraliseFormulas = true/);
  } finally { on.uninstall(); }
  const off = await start({ config: { 'export.neutraliseFormulas': false } });
  try {
    await off.run('xsdAtlas.reportProblem');
    assert.match(off.state.clipboard, /export\.neutraliseFormulas = false/);
  } finally { off.uninstall(); }
});

test('exports honour the formula setting: apostrophe on by default, exact values when turned off', async () => {
  const text = (values) => '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:t" xmlns:t="urn:t" elementFormDefault="qualified"><xs:simpleType name="Code"><xs:restriction base="xs:string">' +
    values.map((v) => '<xs:enumeration value="' + v + '"/>').join('') + '</xs:restriction></xs:simpleType><xs:element name="r" type="t:Code"/></xs:schema>';
  async function csvFor(config) {
    const x = await start({
      files: { 'file:///work/a.xsd': text(['ok']), 'file:///work/b.xsd': text(['ok', '=cmd|calc']) }, active: 'file:///work/b.xsd', config: config,
      quickPickAnswers: [(i) => i.label && i.label.includes('a.xsd'), (i) => i.label === 'CSV']
    });
    try {
      await x.run('xsdAtlas.compareFiles');
      await x.run('xsdAtlas.exportComparison');
      return x.state.openedDocs.map((d) => d.getText()).find((s) => /^class,/i.test(s)) || '';
    } finally { x.uninstall(); }
  }
  const on = await csvFor({});
  assert.ok(on.includes("'=cmd|calc"), on);
  assert.ok(!/(^|,)=cmd/m.test(on), 'no cell starts with a formula character by default');
  const off = await csvFor({ 'export.neutraliseFormulas': false });
  assert.ok(/(^|,)=cmd|calc/m.test(off), off);
  assert.ok(!off.includes("'=cmd"));
});

test('an untrusted workspace reads only files inside its folders; a network path is never read', async () => {
  const stats = [];
  const x = await start({ untrusted: true, files: { 'file:///work/in.xsd': '<a/>' }, active: 'file:///work/in.xsd' });
  try {
    // These exist on disk but are not open in an editor.
    for (const k of ['file:///other/out.xsd', 'file:////fileserver/share/x.xsd', 'file://fileserver/share/x.xsd', 'file:///work/on-disk.xsd']) x.state.files.set(k, '<a/>');
    const realStat = x.mock.vscode.workspace.fs.stat;
    x.mock.vscode.workspace.fs.stat = async (uri) => { stats.push(uri.toString()); return realStat(uri); };
    const { createService } = require('../src/service');
    const svc = createService({ vscode: x.mock.vscode, getSettings: () => ({ maxFileSizeMB: 10 }) });
    // Files that are open in an editor are always available.
    assert.equal((await svc.read('file:///work/in.xsd')).text, '<a/>');
    const out = await svc.read('file:///other/out.xsd');
    assert.equal(out.error, 'missing');
    assert.match(out.message, /outside the workspace folders are not read in an untrusted workspace/);
    assert.equal((await svc.read('file:////fileserver/share/x.xsd')).error, 'missing');
    assert.equal((await svc.read('file://fileserver/share/x.xsd')).error, 'missing');
    assert.equal((await svc.read('ftp://host/x.xsd')).error, 'missing');
    assert.deepEqual(stats, [], 'nothing outside the workspace was even looked at');
    assert.equal((await svc.read('file:///work/on-disk.xsd')).text, '<a/>', 'files inside the workspace folders are read');
  } finally { x.uninstall(); }
});

test('a schema set above 32 MB is refused with a message and never analysed', async () => {
  assert.equal(pkg.contributes.configuration.properties['xsdAtlas.maxFileSizeMB'].maximum, 32);
  const small = '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="r" type="xs:string"/></xs:schema>';
  const big = '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><!--' + ' '.repeat(33 * 1024 * 1024) + '--><xs:element name="r" type="xs:string"/></xs:schema>';
  const x = await start({ files: { 'file:///work/small.xsd': small, 'file:///work/big.xsd': big }, active: 'file:///work/big.xsd', config: { maxFileSizeMB: 500 } });
  try {
    const { createService } = require('../src/service');
    const svc = createService({ vscode: x.mock.vscode, getSettings: () => ({ maxFileSizeMB: 32 }) });
    const docs = x.state.documents;
    const bigDoc = docs.find((d) => d.uri.toString().endsWith('big.xsd'));
    const smallDoc = docs.find((d) => d.uri.toString().endsWith('small.xsd'));
    assert.equal(svc.beyondLimit(bigDoc), true);
    assert.equal(await svc.setFor(bigDoc, true), null, 'not even on demand');
    assert.equal(svc.beyondLimit(smallDoc), false);
    assert.ok(await svc.setFor(smallDoc, true));
    await x.run('xsdAtlas.checkFile');
    assert.match(x.state.warningMessages.concat(x.state.infoMessages).map((m) => m.text).join('\n'), /larger than 32 MB/);
    assert.equal(x.state.diagnostics.get('file:///work/big.xsd') === undefined || x.state.diagnostics.get('file:///work/big.xsd').length === 0, true);
  } finally { x.uninstall(); }
});

test('Compare With Another File runs inside a progress notification and stays fast on a wide xs:all', async () => {
  const fields = (n, extra) => Array.from({ length: n }, (_, i) => '<xs:element name="f' + i + '" type="xs:string" minOccurs="0"/>').join('') + (extra || '');
  const text = (body) => '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:t" xmlns:t="urn:t" elementFormDefault="qualified"><xs:element name="r" type="t:T"/><xs:complexType name="T"><xs:all>' + body + '</xs:all></xs:complexType></xs:schema>';
  const x = await start({
    files: { 'file:///work/a.xsd': text(fields(80)), 'file:///work/b.xsd': text(fields(80, '<xs:element name="added" type="xs:string" minOccurs="0"/>')) },
    active: 'file:///work/b.xsd', quickPickAnswers: [(i) => i.label && i.label.includes('a.xsd')]
  });
  try {
    const seen = [];
    const original = x.mock.vscode.window.withProgress;
    x.mock.vscode.window.withProgress = (opts, fn) => { seen.push(opts); return original(opts, fn); };
    const t0 = Date.now();
    await x.run('xsdAtlas.compareFiles');
    const ms = Date.now() - t0;
    assert.ok(seen.some((o) => o.location === x.mock.vscode.ProgressLocation.Notification && /comparing schemas/.test(o.title)), JSON.stringify(seen));
    assert.ok(ms < 1500, 'the whole command took ' + ms + ' ms');
    assert.match(x.state.infoMessages[x.state.infoMessages.length - 1].text, /0 breaking, 1 non-breaking and 0 documentation changes/);
  } finally { x.uninstall(); }
});
