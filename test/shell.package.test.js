'use strict';
// Marketplace and house rules for the package, as tests. Each test is one rule from the
// publishing playbook; a failing test names the rule that would get the listing refused or
// would break a promise made to buyers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const contributes = pkg.contributes;
const config = require('../src/licence/config');

function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }

function listFiles(dir, out) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir + '/' + entry.name;
    if (entry.isDirectory()) listFiles(rel, out);
    else out.push(rel);
  }
  return out;
}

const VALID_CATEGORIES = ['Programming Languages', 'Snippets', 'Linters', 'Themes', 'Debuggers', 'Formatters', 'Keymaps',
  'SCM Providers', 'Other', 'Extension Packs', 'Language Packs', 'Data Science', 'Visualization',
  'Notebooks', 'Education', 'Testing'];

test('manifest has the fields the marketplace needs', () => {
  assert.match(pkg.name, /^[a-z][a-z0-9-]*$/);
  assert.ok(pkg.displayName && pkg.displayName.length <= 60);
  assert.match(pkg.publisher, /^[A-Za-z0-9][A-Za-z0-9-]*$/);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.match(pkg.engines.vscode, /^\^1\.\d+\.\d+$/);
  assert.equal(pkg.license, 'SEE LICENSE IN LICENSE.txt');
  assert.equal(pkg.icon, 'media/icon.png');
  assert.equal(pkg.main, './src/extension.js');
  assert.ok(pkg.description.length > 20 && pkg.description.length <= 200, 'description must be 21-200 characters');
  assert.match(pkg.homepage, /^https:\/\//);
  assert.match(pkg.repository.url, /^https:\/\/github\.com\/[^/]+\/[^/]+$/);
  assert.equal(pkg.bugs.url, pkg.repository.url + '/issues');
  assert.ok(pkg.galleryBanner.color && ['dark', 'light'].includes(pkg.galleryBanner.theme));
  assert.equal(pkg.capabilities.untrustedWorkspaces.supported, true);
  assert.equal(pkg.dependencies, undefined, 'no runtime dependencies');
  assert.equal(pkg.devDependencies, undefined);
});

test('rule: the pricing label is Trial (14-day Pro trial; Pro is sold outside the Marketplace)', () => {
  assert.equal(pkg.pricing, 'Trial');
});

test('rule: categories are valid and keywords stay within the limit of 30', () => {
  assert.ok(pkg.categories.length >= 1 && pkg.categories.length <= 3);
  for (const c of pkg.categories) assert.ok(VALID_CATEGORIES.includes(c), 'unknown category ' + c);
  assert.ok(pkg.keywords.length >= 1 && pkg.keywords.length <= 30, 'keywords: 1 to 30');
  assert.equal(new Set(pkg.keywords.map((k) => k.toLowerCase())).size, pkg.keywords.length, 'keywords must be unique');
  for (const k of pkg.keywords) assert.ok(k.length >= 2 && k.length <= 40, 'keyword length: ' + k);
});

test('every file the manifest points to exists', () => {
  const files = [pkg.icon, pkg.main, 'README.md', 'CHANGELOG.md', 'LICENSE.txt', 'PRIVACY.md', '.vscodeignore'];
  for (const f of files) assert.ok(fs.existsSync(path.join(root, f)), f + ' is missing');
});

test('the icon is a square PNG of at least 128x128 without metadata chunks', () => {
  const data = fs.readFileSync(path.join(root, 'media/icon.png'));
  assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const w = data.readUInt32BE(16);
  const h = data.readUInt32BE(20);
  assert.equal(w, h);
  assert.ok(w >= 128 && w <= 512, 'icon size ' + w);
  const chunks = [];
  let pos = 8;
  while (pos < data.length) {
    const length = data.readUInt32BE(pos);
    chunks.push(data.toString('ascii', pos + 4, pos + 8));
    pos += 12 + length;
  }
  for (const c of chunks) assert.ok(['IHDR', 'IDAT', 'IEND', 'PLTE', 'tRNS'].includes(c), 'unexpected chunk ' + c);
  assert.ok(data.length < 100 * 1024);
});

test('commands are namespaced, titled with the product name and unique', () => {
  const ids = contributes.commands.map((c) => c.command);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of contributes.commands) {
    assert.ok(c.command.startsWith(config.commandPrefix + '.'), c.command);
    assert.ok(c.title.startsWith(pkg.displayName + ': '), c.title);
  }
  for (const needed of ['buyPro', 'enterKey', 'licenceStatus', 'removeLicence']) {
    assert.ok(ids.includes(config.commandPrefix + '.' + needed), 'licence command missing: ' + needed);
  }
  assert.equal(config.productName, pkg.displayName, 'config.productName must equal displayName');
});

test('rule: a Pro command says so in its title, and every Pro command is gated', () => {
  const src = read('src/commands.js');
  for (const c of contributes.commands) {
    const gated = new RegExp("reg\\('" + c.command.replace('.', '\\.') + "'[^]*?requirePro\\(").exec(src);
    const m = new RegExp("reg\\('" + c.command.replace('.', '\\.') + "', async function \\([^)]*\\) \\{[^]*?\\n  \\}\\);").exec(src);
    const body = m ? m[0] : '';
    if (c.title.endsWith('(Pro)')) assert.ok(/requirePro\(/.test(body), c.command + ' must call requirePro');
    else assert.ok(!/requirePro\(/.test(body), c.command + ' is free and must not call requirePro');
    assert.ok(gated !== undefined);
  }
});

test('rule: activation events reference real commands', () => {
  const ids = new Set(contributes.commands.map((c) => c.command));
  for (const e of pkg.activationEvents || []) {
    if (e.startsWith('onCommand:')) assert.ok(ids.has(e.slice('onCommand:'.length)), e);
  }
});

test('rule: no setting or command selects the licence environment, and every setting is described', () => {
  const props = contributes.configuration.properties;
  assert.deepEqual(config.environmentSwitches(pkg), []);
  assert.equal(props[config.commandPrefix + '.licenceMode'], undefined);
  // The rule itself catches such a setting or command.
  const probe = JSON.parse(JSON.stringify(pkg));
  probe.contributes.configuration.properties['xsdAtlas.licenceMode'] = { type: 'string', enum: ['test', 'live'], default: 'live' };
  probe.contributes.commands.push({ command: 'xsdAtlas.useTestServer', title: 'XSD Atlas: Use Test Licence Environment' });
  assert.equal(config.environmentSwitches(probe).length, 2);
  assert.throws(() => config.assertShippable(probe), /licence environment/);
  for (const [key, d] of Object.entries(props)) {
    assert.ok(key.startsWith(config.commandPrefix + '.'), key);
    assert.ok(d.markdownDescription || d.description, key + ' needs a description');
    assert.notEqual(d.default, undefined, key + ' needs a default');
    assert.ok(d.type, key);
  }
});

test('rule: the README documents every setting and every command', () => {
  const readme = read('README.md');
  for (const key of Object.keys(contributes.configuration.properties)) {
    assert.ok(readme.includes('`' + key + '`'), key + ' is missing from the README');
  }
  const hidden = (contributes.menus.commandPalette || []).filter((m) => m.when === 'false').map((m) => m.command);
  for (const c of contributes.commands) {
    if (hidden.includes(c.command)) continue;
    const short = c.title.replace(pkg.displayName + ': ', '').replace(/ \(Pro\)$/, '');
    assert.ok(readme.includes(short), 'README does not mention "' + short + '"');
  }
});

test('rule: README images are https links or relative paths, never http or SVG', () => {
  const readme = read('README.md');
  const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]);
  for (const src of images) {
    assert.ok(!/^http:\/\//i.test(src), 'http image: ' + src);
    assert.ok(!/\.svg(\?|#|$)/i.test(src), 'SVG image (not allowed by the Marketplace): ' + src);
    if (!/^https:\/\//i.test(src)) {
      assert.ok(fs.existsSync(path.join(root, src)) || /^media\/screenshots\//.test(src), 'missing image ' + src);
    }
  }
  assert.ok(!/<img\b/i.test(readme), 'use Markdown images, not <img> tags');
});

test('rule: the data disclosure is in the README and PRIVACY.md and the two agree', () => {
  const privacy = read('PRIVACY.md');
  const readme = read('README.md');
  for (const text of [privacy, readme]) {
    assert.match(text, /VS Code on <platform>/);
    assert.match(text, /no telemetry/i);
    assert.match(text, /24 hours/);
    assert.match(text, /14 days/);
    assert.match(text, /dodopayments\.com\/legal\/privacy-policy/);
    assert.match(text, /not anonymous/i);
    assert.match(text, /IP address/i);
  }
  for (const heading of ['When it happens', 'What is sent', 'Who receives it']) {
    assert.ok(readme.includes(heading), 'README data disclosure is missing "' + heading + '"');
  }
});

test('rule: the README states independence from third-party names', () => {
  assert.match(read('README.md'), /independent product/i);
  assert.match(read('README.md'), /no affiliation/i);
});

test('rule: the licence file states the terms buyers rely on', () => {
  const text = read('LICENSE.txt');
  assert.match(text, /free features/i);
  assert.match(text, /paid licence key/i);
  assert.match(text, /redistribute/i);
  assert.match(text, /without warranty/i);
  assert.match(text, /no bundled third-party components/i);
});

test('shipped code has no console output and no external dependencies', () => {
  const builtins = new Set(require('node:module').builtinModules);
  for (const f of listFiles('src', []).filter((x) => x.endsWith('.js'))) {
    const text = read(f);
    assert.ok(!/\bconsole\./.test(text), f + ' uses console');
    for (const m of text.matchAll(/require\('([^']+)'\)/g)) {
      const name = m[1];
      const ok = name.startsWith('.') || name === 'vscode' || builtins.has(name) || builtins.has(name.replace(/^node:/, ''));
      assert.ok(ok, f + ' requires ' + name);
    }
  }
});

test('the package script refuses a build with a bad or missing release setup', () => {
  assert.match(pkg.scripts['vscode:prepublish'], /release-gate\.js/);
  assert.match(read('scripts/release-gate.js'), /assertShippable/);
  assert.equal(pkg.scripts.test, 'node --test');
});

test('development folders and files are kept out of the package', () => {
  const ignore = read('.vscodeignore').split(/\r?\n/).map((l) => l.trim());
  for (const entry of ['test/**', 'scripts/**', 'media/screenshots/**', '**/*.vsix', 'node_modules/**']) {
    assert.ok(ignore.includes(entry), entry);
  }
});

test('the repository ignore file keeps secrets and build output out of git', () => {
  const ignore = read('.gitignore').split(/\r?\n/).map((l) => l.trim());
  for (const entry of ['node_modules/', '*.vsix', '.env']) assert.ok(ignore.includes(entry), entry);
});
