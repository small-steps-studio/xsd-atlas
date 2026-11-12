'use strict';
// Release gate: everything that must hold before a package is built.
//   node scripts/release-gate.js [--skip-tests] [--prepublish] [--allow-placeholders]
// Exits with code 1 and a list of problems when anything fails.
//
// --allow-placeholders (or the environment variable XSD_ATLAS_LOCAL_PACKAGE=1, set by
// scripts/package-local.js) accepts the placeholder product ids, for a local test package that
// is never uploaded. Every other rule still applies, and the placeholders are listed.
//
// Further checks of the shipped texts and of what may be published are kept outside this
// folder: the gate runs them from tools/xsd-atlas-private-gate.js next to the project and fails
// when that file is missing or reports a problem (an automated build, which has no such file,
// notes that they were not run).

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const problems = [];
const notes = [];
function fail(text) { problems.push(text); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

function listFiles(dir, out) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = (dir ? dir + '/' : '') + entry.name;
    if (entry.name === 'node_modules' || entry.name === '.git' || rel === 'test/.tmp') continue;
    if (entry.isDirectory()) listFiles(rel, out);
    else out.push(rel);
  }
  return out;
}

function ignored(rel, patterns) {
  return patterns.some(function (p) {
    if (p.endsWith('/**')) return rel === p.slice(0, -3) || rel.startsWith(p.slice(0, -3) + '/');
    if (p.startsWith('**/')) {
      const tail = p.slice(3);
      if (tail.startsWith('*')) return rel.endsWith(tail.slice(1));
      return rel === tail || rel.endsWith('/' + tail);
    }
    if (p.indexOf('*') !== -1) return new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$').test(rel);
    return rel === p;
  });
}

const argv = process.argv.slice(2);
const skipTests = argv.indexOf('--skip-tests') !== -1 || argv.indexOf('--prepublish') !== -1;
const allowPlaceholders = argv.indexOf('--allow-placeholders') !== -1 || process.env.XSD_ATLAS_LOCAL_PACKAGE === '1';
const pkg = JSON.parse(read('package.json'));

// 1. Unit tests.
if (!skipTests) {
  process.stdout.write('Running the unit suite...\n');
  const r = cp.spawnSync(process.execPath, ['--test'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  const summary = (r.stdout || '').split('\n').filter(function (l) { return /^ℹ (tests|pass|fail|skipped) /.test(l); }).join(', ');
  process.stdout.write('  ' + summary + '\n');
  if (r.status !== 0) fail('the unit suite failed (' + summary + ')');
}

// 2. Licence configuration and manifest.
const config = require(path.join(ROOT, 'src/licence/config'));
try { config.assertShippable(pkg, { allowPlaceholders: allowPlaceholders }); } catch (e) { fail(e.message); }
const ph = config.placeholderIds();
if (ph.length && allowPlaceholders) notes.push('NOT FOR PUBLISHING: placeholder product ids accepted for a local package: ' + ph.join(', '));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) fail('version is not x.y.z');
if (pkg.pricing !== 'Trial') fail('pricing must be Trial (a 14-day trial of the Pro features is offered)');
if (pkg.keywords.length > 30) fail('more than 30 keywords');
if (pkg.dependencies || pkg.devDependencies) fail('the package must have no dependencies');
if (!read('CHANGELOG.md').includes('## ' + pkg.version)) fail('CHANGELOG.md has no entry for ' + pkg.version);
const props = pkg.contributes.configuration.properties;
// (assertShippable above also refuses any setting or command that selects the licence environment.)

// 3. Every problem code is documented, and every documented code exists.
const codeRe = /'((?:XML|XSD|WSDL)-[A-Z0-9-]+)'/g;
const codes = new Set();
for (const f of ['src/xml/parser.js', 'src/schema/check.js', 'src/schema/set.js', 'src/schema/content.js', 'src/wsdl/check.js']) {
  for (const m of read(f).matchAll(codeRe)) codes.add(m[1]);
}
const problemsDoc = read('docs/problems.md');
for (const c of codes) if (!problemsDoc.includes('`' + c + '`')) fail('docs/problems.md does not document ' + c);
for (const m of problemsDoc.matchAll(/`((?:XML|XSD|WSDL)-[A-Z0-9-]+)`/g)) if (!codes.has(m[1])) fail('docs/problems.md documents a code that does not exist: ' + m[1]);

// 4. Every comparison code is documented with its class.
const RULES = require(path.join(ROOT, 'src/pro/diff')).RULES;
const rulesDoc = read('docs/diff-rules.md');
for (const [code, cls] of Object.entries(RULES)) {
  const row = rulesDoc.split('\n').find(function (l) { return l.startsWith('| `' + code + '` |'); });
  if (!row) fail('docs/diff-rules.md does not document ' + code);
  else if (!row.includes('| ' + cls + ' |')) fail('docs/diff-rules.md gives ' + code + ' another class than ' + cls);
}
for (const m of rulesDoc.matchAll(/^\| `([a-z-]+)` \|/gm)) if (!Object.prototype.hasOwnProperty.call(RULES, m[1])) fail('docs/diff-rules.md documents a code that does not exist: ' + m[1]);

// 5. Secrets, private paths, line endings and development files.
const ignore = read('.vscodeignore').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
const gitIgnore = read('.gitignore').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l && l[0] !== '#'; })
  .map(function (l) { return l.endsWith('/') ? l + '**' : l; });
const all = listFiles('', []);
const shipped = all.filter(function (f) { return !ignored(f, ignore) && !/\.(png|vsix)$/.test(f); });
const textFiles = all.filter(function (f) { return /\.(md|json|js|txt|yml|svg|xsd|wsdl|xml|py)$/.test(f); });
const working = function (f) { return ignored(f, gitIgnore); };
for (const f of new Set(shipped.concat(textFiles))) {
  const text = read(f);
  const tooling = /^(test|scripts)\//.test(f) || working(f);
  if (/(sk|pk|lk)_(live|test)_[A-Za-z0-9]{16,}/.test(text)) fail(f + ' looks like it contains a secret');
  if (/MOCK-KEY|dodo_test_[a-z_]*key/.test(text) && !tooling) fail(f + ' refers to a test key');
  if (/[A-Za-z]:\\Users\\|\/home\/[a-z]+\/|\/Users\/[a-z]+\//.test(text) && !tooling) fail(f + ' contains a private file path');
  if (/\r\n/.test(text) && !/^test\/fixtures\//.test(f) && !working(f)) fail(f + ' has CRLF line endings');
}
for (const f of shipped) if (/\.test\.js$|^test\/|^scripts\/|^docs\/|SPEC|STATUS|TODO|NOTES|QA-|RELEASE-NOTES/.test(f)) fail('would ship a development file: ' + f);
// Working notes must be kept out of the package and the repository by name pattern, whatever
// they are called, so that a new note can never ship or be pushed by accident.
for (const probe of ['QA-AUDIT-9.9.9.md', 'STATUS.md', 'MY-NOTES.md', 'X-SPEC.md', 'SPEC-LOCAL.md', 'RELEASE-NOTES-9.9.9.md', 'TODO-BEFORE-PUBLISH.md', 'debug.log', 'old.vsix']) {
  if (!ignored(probe, ignore)) fail('.vscodeignore would let a file named ' + probe + ' into the package');
  if (!ignored(probe, gitIgnore)) fail('.gitignore would let a file named ' + probe + ' into the repository');
}
for (const probe of ['test/smoke/run.js', 'demo/x.xsd']) if (!ignored(probe, gitIgnore)) fail('.gitignore would let ' + probe + ' into the repository');

// 6. The private checks (wording, personal details, what may be pushed) are kept outside this folder.
const privateGate = path.join(ROOT, '..', 'tools', 'xsd-atlas-private-gate.js');
if (!fs.existsSync(privateGate)) {
  // A clone of the public repository has no such file. Only an automated build (CI is set by the
  // hosted runners) may go on without it; a release is never built that way.
  if (process.env.CI) notes.push('the additional release checks that live outside this repository were not run (automated build)');
  else fail('the additional release checks were not found next to the project (tools/xsd-atlas-private-gate.js); they must pass before a release');
} else {
  const pr = cp.spawnSync(process.execPath, [privateGate, ROOT], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write((pr.stdout || '').split('\n').map(function (l) { return l ? '  ' + l + '\n' : ''; }).join(''));
  if (pr.status !== 0) fail('the private checks failed (see above)');
}

// 7. README, walkthrough media, screenshots, icon.
const readme = read('README.md');
for (const c of pkg.contributes.commands) {
  const t = c.title.replace(pkg.displayName + ': ', '').replace(/ \(Pro\)$/, '');
  if (['Refresh Outline', 'Reveal In Editor', 'Reveal Change'].indexOf(t) === -1 && !readme.includes(t)) fail('README does not mention the command ' + t);
}
for (const k of Object.keys(props)) if (!readme.includes('`' + k + '`')) fail('README does not document the setting ' + k);
for (const w of pkg.contributes.walkthroughs) for (const s of w.steps) if (!fs.existsSync(path.join(ROOT, s.media.markdown))) fail('walkthrough media missing: ' + s.media.markdown);
for (const m of readme.matchAll(/\]\((media\/screenshots\/[a-z0-9-]+\.png)\)/g)) {
  if (fs.existsSync(path.join(ROOT, m[1]))) continue;
  // A local test package (used to take the screenshots) may be built before they exist.
  if (allowPlaceholders) notes.push('local package: README screenshot not taken yet: ' + m[1]);
  else fail('README screenshot missing: ' + m[1]);
}
const icon = fs.readFileSync(path.join(ROOT, 'media/icon.png'));
if (icon.readUInt32BE(16) !== 128 || icon.readUInt32BE(20) !== 128) fail('media/icon.png must be 128 x 128');
for (const t of ['TERMS.md', 'PRIVACY.md', 'LICENSE.txt']) if (!fs.existsSync(path.join(ROOT, t))) fail(t + ' is missing');

for (const n of notes) process.stdout.write(n + '\n');
if (problems.length) {
  process.stdout.write('RELEASE GATE FAILED\n' + problems.map(function (p) { return '  - ' + p; }).join('\n') + '\n');
  process.exit(1);
}
process.stdout.write('RELEASE GATE PASSED (' + shipped.length + ' files would ship, ' + codes.size + ' problem codes and ' + Object.keys(RULES).length + ' comparison codes documented' + (allowPlaceholders && ph.length ? '; placeholder product ids accepted for a local package only' : '') + ')\n');
