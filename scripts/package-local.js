'use strict';
// Builds a package with the release gate in its local mode: placeholder product ids and
// screenshots that are not taken yet are accepted and listed ("NOT FOR PUBLISHING" is printed when a placeholder is accepted).
// The real product ids are in place, so this script is only needed for experiments; a package
// for release is built with `npm run package`, which accepts neither.

const cp = require('node:child_process');
const path = require('node:path');

const env = Object.assign({}, process.env, { XSD_ATLAS_LOCAL_PACKAGE: '1' });
const r = cp.spawnSync('npx --yes @vscode/vsce package --no-dependencies', { cwd: path.join(__dirname, '..'), env: env, stdio: 'inherit', shell: true, windowsHide: true });
process.exit(r.status === null ? 1 : r.status);
