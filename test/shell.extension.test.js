'use strict';
// The extension inside a stand-in editor: activation, commands, providers, the Pro gate and the
// licence commands.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./helpers/vscode-mock');
const P = require('../src/xml/parser');
const samples = require('../src/samples');
const pkg = require('../package.json');

const V1 = 'file:///work/order-v1.xsd';
const V2 = 'file:///work/order-v2.xsd';
const WSDL = 'file:///work/service.wsdl';

async function start(options) {
  const o = options || {};
  const mock = M.createMock(Object.assign({
    files: { [V1]: samples.sampleFor('schema').text, [V2]: samples.sampleFor('schemaV2').text, [WSDL]: samples.sampleFor('wsdl').text },
    active: V2, folders: [{ uri: M.Uri.parse('file:///work'), name: 'work' }]
  }, o));
  const uninstall = M.install(mock.vscode);
  const srcDir = require('node:path').join(__dirname, '..', 'src');
  for (const k of Object.keys(require.cache)) if (k.startsWith(srcDir)) delete require.cache[k];
  const ext = require('../src/extension');
  const context = M.makeContext(pkg);
  if (o.trialDaysAgo !== undefined) {
    const t = Date.now() - o.trialDaysAgo * 86400000;
    context.globalMap.set('trial.startedAt', t);
    context.globalMap.set('trial.lastSeenAt', t);
  }
  ext.activate(context);
  return { mock: mock, state: mock.state, context: context, uninstall: uninstall, run: (id, ...a) => mock.vscode.commands.executeCommand(id, ...a) };
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

test('activation registers every command of the manifest and nothing else', async () => {
  const x = await start();
  try {
    const declared = pkg.contributes.commands.map((c) => c.command).sort();
    assert.deepEqual(Array.from(x.state.commands.keys()).sort(), declared);
    assert.ok(x.state.providers.hover && x.state.providers.definition && x.state.providers.references && x.state.providers.symbols);
    assert.ok(x.state.trees['xsdAtlas.outline'] && x.state.trees['xsdAtlas.diff']);
  } finally { x.uninstall(); }
});

test('the sample files have no problems; the outline tree and symbols are filled', async () => {
  const x = await start();
  try {
    await wait(900);
    for (const uri of [V1, V2, WSDL]) assert.deepEqual((x.state.diagnostics.get(uri) || []).map((d) => d.code + ' ' + d.message), [], uri);
    const tree = x.state.trees['xsdAtlas.outline'];
    const roots = tree.getChildren();
    assert.equal(roots.length, 1);
    const item = tree.getTreeItem(roots[0]);
    assert.equal(item.label, 'schema');
    const doc = x.state.documents.find((d) => d.uri.toString() === V2);
    const symbols = await x.state.providers.symbols.provideDocumentSymbols(doc);
    assert.equal(symbols[0].name, 'schema');
    assert.ok(symbols[0].children.some((s) => s.name === 'Complex types'));
  } finally { x.uninstall(); }
});

test('hover and go to definition on a type reference', async () => {
  const x = await start();
  try {
    const doc = x.state.documents.find((d) => d.uri.toString() === V2);
    const offset = doc.getText().indexOf('type="gc:LineType"') + 8;
    const hover = await x.state.providers.hover.provideHover(doc, doc.positionAt(offset));
    assert.match(hover.contents.value, /complex type.*LineType[\s\S]*variety[\s\S]*potSize/);
    assert.equal(hover.contents.isTrusted, false);
    const defs = await x.state.providers.definition.provideDefinition(doc, doc.positionAt(offset));
    assert.equal(defs.length, 1);
    assert.equal(defs[0].uri.toString(), V2);
    assert.ok(defs[0].range.start.line > 5);
    const refs = await x.state.providers.references.provideReferences(doc, doc.positionAt(offset), { includeDeclaration: true });
    assert.ok(refs.length >= 2);
  } finally { x.uninstall(); }
});

test('Check Current File, Copy Path At Cursor and Create Sample XML', async () => {
  const x = await start({ quickPickAnswers: [(i) => i.label === 'plantOrder'] });
  try {
    await x.run('xsdAtlas.checkFile');
    assert.match(x.state.infoMessages.pop().text, /0 errors, 0 warnings/);
    const doc = x.state.activeTextEditor.document;
    const off = doc.getText().indexOf('name="quantity"');
    const p = doc.positionAt(off);
    x.state.activeTextEditor.selection = { active: p, start: p, end: p };
    await x.run('xsdAtlas.copyPath');
    assert.equal(x.state.clipboard, 'LineType: quantity');
    await x.run('xsdAtlas.sampleXml');
    const sample = x.state.openedDocs.pop();
    assert.deepEqual(P.parseXml(sample.getText()).errors, []);
    assert.match(sample.getText(), /<gc:plantOrder xmlns:gc="urn:example:garden-centre:order">/);
  } finally { x.uninstall(); }
});

test('a Pro command starts the trial once and then runs; the comparison fills the view', async () => {
  const x = await start({ quickPickAnswers: [(i) => i.label && i.label.includes('order-v1')] });
  try {
    await x.run('xsdAtlas.compareFiles');
    assert.match(x.state.infoMessages[0].text, /free 14-day trial of XSD Atlas Pro has started/);
    assert.ok(x.context.globalMap.has('trial.startedAt'));
    const roots = x.state.trees['xsdAtlas.diff'].getChildren();
    assert.deepEqual(roots.map((r) => r.label), ['BREAKING', 'NON-BREAKING', 'DOCUMENTATION']);
    const last = x.state.infoMessages[x.state.infoMessages.length - 1].text;
    assert.match(last, /2 breaking, 2 non-breaking and 2 documentation changes/);
  } finally { x.uninstall(); }
});

test('after the trial a Pro command shows the Pro notice and does nothing else', async () => {
  const x = await start({ trialDaysAgo: 20 });
  try {
    await x.run('xsdAtlas.flatten');
    const msg = x.state.infoMessages[0];
    assert.match(msg.text, /Flatten Schema is an XSD Atlas Pro feature\. Your 14-day trial ended/);
    assert.deepEqual(msg.buttons, ['Buy Pro', 'Enter Licence Key']);
    assert.equal(x.state.written.size, 0);
    assert.equal(x.state.openedDocs.length, 0);
  } finally { x.uninstall(); }
});

test('Buy Pro: Business asks for the number of users and opens the checkout with that quantity', async () => {
  const x = await start({ quickPickAnswers: [1], inputAnswers: ['7'] });
  try {
    await x.run('xsdAtlas.buyPro');
    assert.deepEqual(x.state.opened, ['https://checkout.dodopayments.com/buy/pdt_0NrlydO9yqFrkNiBEKi1G?quantity=7']);
  } finally { x.uninstall(); }
  const y = await start({ quickPickAnswers: [0] });
  try {
    await y.run('xsdAtlas.buyPro');
    assert.deepEqual(y.state.opened, ['https://checkout.dodopayments.com/buy/pdt_0NrlyVvfLevuTEDqI9l53?quantity=1']);
  } finally { y.uninstall(); }
  const z = await start({ quickPickAnswers: [1], inputAnswers: ['0'] });
  try {
    await z.run('xsdAtlas.buyPro');
    assert.deepEqual(z.state.opened, []);
    assert.match(z.state.warningMessages[0].text, /whole number from 1 to 100/);
  } finally { z.uninstall(); }
});

test('Report A Problem copies no file names, namespaces or keys', async () => {
  const x = await start();
  try {
    await x.context.secrets.store('licence.key.live', 'SECRET-KEY-1234');
    await x.run('xsdAtlas.reportProblem');
    const block = x.state.clipboard;
    assert.match(block, /^XSD Atlas 0\.1\.0/);
    assert.match(block, /export\.neutraliseFormulas = true/);
    assert.ok(!/licenceMode/.test(block), 'there is no licence mode setting');
    for (const bad of ['order-v2', 'garden-centre', 'SECRET', '1234', '/work/']) assert.ok(!block.includes(bad), bad);
    assert.deepEqual(x.state.opened, ['https://github.com/small-steps-studio/xsd-atlas/issues']);
  } finally { x.uninstall(); }
});

test('Enter Licence Key without network reports it and stores nothing', async () => {
  const x = await start({ inputAnswers: ['ABC-DEF'] });
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('offline'); };
  try {
    await x.run('xsdAtlas.enterKey');
    assert.match(x.state.errorMessages[0].text, /could not be reached/);
    assert.equal(x.context.secretsMap.size, 0);
  } finally { global.fetch = realFetch; x.uninstall(); }
});

test('commands on a non-schema file explain what they need', async () => {
  const x = await start({ files: { 'file:///work/notes.txt': 'hello' }, active: 'file:///work/notes.txt' });
  try {
    x.state.documents[0].languageId = 'plaintext';
    await x.run('xsdAtlas.sampleXml');
    assert.match(x.state.warningMessages[0].text, /needs an XSD or WSDL file/);
  } finally { x.uninstall(); }
});

test('SOAP envelope samples and documentation from the commands', async () => {
  const x = await start({ active: WSDL, quickPickAnswers: [0, 0] });
  try {
    await x.run('xsdAtlas.soapSamples');
    const env = x.state.openedDocs.pop();
    assert.ok(env, 'an envelope was opened');
    assert.match(env.getText(), /soap:Envelope[\s\S]*GetWateringAdvice/);
    x.state.activeTextEditor = { document: x.state.documents.find((d) => d.uri.toString() === WSDL), selection: { active: { line: 0, character: 0 } } };
    await x.run('xsdAtlas.createDocumentation');
    assert.match(x.state.openedDocs.pop().getText(), /^# service\.wsdl reference/);
  } finally { x.uninstall(); }
});
