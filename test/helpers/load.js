'use strict';
// Test helpers: load schema sets from files on disk or from in-memory texts.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { loadSchemaSet } = require('../../src/schema/set');
const { checkFile } = require('../../src/schema/check');
const { decodeBytes } = require('../../src/xml/decode');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function uriOf(file) { return pathToFileURL(file).toString(); }

async function diskRead(uri) {
  try {
    const file = fileURLToPath(uri);
    const d = decodeBytes(fs.readFileSync(file));
    return d.text === null ? { error: 'unreadable', message: d.error } : { text: d.text };
  } catch (e) {
    return { error: 'missing' };
  }
}

/** Loads the set whose entry is a file on disk. */
async function loadFile(file, options) {
  const d = decodeBytes(fs.readFileSync(file));
  return loadSchemaSet({ uri: uriOf(file), text: d.text }, Object.assign({ read: diskRead }, options || {}));
}

/** Loads a set from in-memory files: { 'main.xsd': text, ... }; entry is the first key unless named. */
async function loadTexts(files, entryName) {
  const base = 'file:///mem/';
  const names = Object.keys(files);
  const entry = entryName || names[0];
  return loadSchemaSet({ uri: base + entry, text: files[entry] }, {
    read: async function (uri) {
      const n = decodeURIComponent(uri.slice(base.length));
      return Object.prototype.hasOwnProperty.call(files, n) ? { text: files[n] } : { error: 'missing' };
    }
  });
}

/** Wraps declarations in an xs:schema element with a target namespace and the tns prefix. */
function schema(body, attrs) {
  return '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:t="urn:t" targetNamespace="urn:t" elementFormDefault="qualified"' +
    (attrs ? ' ' + attrs : '') + '>' + body + '</xs:schema>';
}

async function problemsOf(text) {
  const set = await loadTexts({ 'main.xsd': text });
  return checkFile(set, 'file:///mem/main.xsd');
}

function corpusFiles(kind) {
  const dir = path.join(FIXTURES, 'corpus', kind);
  return fs.readdirSync(dir).filter(function (f) { return /\.(xsd|wsdl)$/.test(f); }).sort().map(function (f) { return path.join(dir, f); });
}

module.exports = { FIXTURES: FIXTURES, uriOf: uriOf, diskRead: diskRead, loadFile: loadFile, loadTexts: loadTexts, schema: schema, problemsOf: problemsOf, corpusFiles: corpusFiles, checkFile: checkFile };
