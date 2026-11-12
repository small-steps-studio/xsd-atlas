'use strict';
// Turns the bytes of a file into text. The byte order mark wins; without one the encoding named in
// the XML declaration is used (UTF-8, UTF-16, ISO-8859-1, Windows-1252, US-ASCII); without either
// the file is read as UTF-8. Never throws: a file that cannot be decoded gives `{ text: null, error }`.

const LATIN1_NAMES = ['iso-8859-1', 'iso8859-1', 'latin1', 'latin-1', 'l1', 'iso_8859-1', 'cp819', 'ibm819'];
const CP1252_NAMES = ['windows-1252', 'cp1252', 'x-cp1252'];
const ASCII_NAMES = ['us-ascii', 'ascii', 'iso646-us'];
const UTF8_NAMES = ['utf-8', 'utf8'];
const UTF16_NAMES = ['utf-16', 'utf16', 'ucs-2', 'utf-16le', 'utf-16be'];

// Windows-1252 differs from ISO-8859-1 in 0x80-0x9F.
const CP1252_HIGH = [0x20AC, 0xFFFD, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0xFFFD, 0x017D, 0xFFFD,
  0xFFFD, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0xFFFD, 0x017E, 0x0178];

function singleByte(bytes, start, table) {
  const parts = [];
  const CHUNK = 8192;
  for (let i = start; i < bytes.length; i += CHUNK) {
    const end = Math.min(bytes.length, i + CHUNK);
    const codes = new Array(end - i);
    for (let j = i; j < end; j++) {
      const b = bytes[j];
      codes[j - i] = table && b >= 0x80 && b <= 0x9F ? table[b - 0x80] : b;
    }
    parts.push(String.fromCharCode.apply(null, codes));
  }
  return parts.join('');
}

/** Reads the encoding pseudo-attribute of an XML declaration at the start of ASCII-compatible bytes. */
function declaredEncoding(bytes, start) {
  const head = singleByte(bytes.subarray(start, Math.min(bytes.length, start + 200)), 0, null);
  const m = /^<\?xml[\s\S]*?encoding\s*=\s*["']([A-Za-z][A-Za-z0-9._-]*)["'][\s\S]*?\?>/.exec(head);
  return m ? m[1].toLowerCase() : '';
}

function utf8(bytes, start) {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start)), encoding: 'utf-8' };
  } catch (e) {
    return { text: null, encoding: 'utf-8', error: 'The file is not valid UTF-8 and declares no other encoding.' };
  }
}

function utf16(bytes, start, littleEndian) {
  const n = Math.floor((bytes.length - start) / 2);
  const parts = [];
  const CHUNK = 8192;
  for (let i = 0; i < n; i += CHUNK) {
    const end = Math.min(n, i + CHUNK);
    const codes = new Array(end - i);
    for (let j = i; j < end; j++) {
      const p = start + j * 2;
      codes[j - i] = littleEndian ? bytes[p] | (bytes[p + 1] << 8) : (bytes[p] << 8) | bytes[p + 1];
    }
    parts.push(String.fromCharCode.apply(null, codes));
  }
  return { text: parts.join(''), encoding: littleEndian ? 'utf-16le' : 'utf-16be' };
}

/**
 * Decodes file bytes (Uint8Array or Buffer). Returns `{ text, encoding, bom }` or
 * `{ text: null, encoding, error }` for bytes that are not valid in the detected encoding.
 */
function decodeBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return Object.assign(utf8(bytes, 3), { bom: true });
  }
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return Object.assign(utf16(bytes, 2, true), { bom: true });
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return Object.assign(utf16(bytes, 2, false), { bom: true });
  // UTF-16 without a byte order mark, recognised by "<?" or "<" followed by a zero byte.
  if (bytes.length >= 4 && bytes[0] === 0x3C && bytes[1] === 0x00 && bytes[2] !== 0x00) return Object.assign(utf16(bytes, 0, true), { bom: false });
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x3C && bytes[3] !== 0x00) return Object.assign(utf16(bytes, 0, false), { bom: false });
  const declared = declaredEncoding(bytes, 0);
  if (!declared || UTF8_NAMES.indexOf(declared) !== -1) return Object.assign(utf8(bytes, 0), { bom: false });
  if (LATIN1_NAMES.indexOf(declared) !== -1) return { text: singleByte(bytes, 0, null), encoding: 'iso-8859-1', bom: false };
  if (CP1252_NAMES.indexOf(declared) !== -1) return { text: singleByte(bytes, 0, CP1252_HIGH), encoding: 'windows-1252', bom: false };
  if (ASCII_NAMES.indexOf(declared) !== -1) {
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] > 0x7F) return { text: null, encoding: 'us-ascii', error: 'The file declares US-ASCII but contains a byte above 127 at offset ' + i + '.' };
    }
    return { text: singleByte(bytes, 0, null), encoding: 'us-ascii', bom: false };
  }
  if (UTF16_NAMES.indexOf(declared) !== -1) {
    // A declaration readable as single bytes cannot be UTF-16; read it as UTF-8 as parsers do.
    return Object.assign(utf8(bytes, 0), { bom: false });
  }
  try {
    const text = new TextDecoder(declared, { fatal: true }).decode(bytes);
    return { text: text, encoding: declared, bom: false };
  } catch (e) {
    return { text: null, encoding: declared, error: 'The encoding "' + declared + '" named in the XML declaration is not supported here. Save the file as UTF-8.' };
  }
}

module.exports = { decodeBytes: decodeBytes, declaredEncoding: declaredEncoding };
