'use strict';
// SOAP 1.1 and 1.2 envelope samples for an operation of a WSDL binding: request, response and one
// envelope per fault, built from the schema types of the messages. Nothing is sent anywhere.

const P = require('../xml/parser');
const W = require('../wsdl/read');
const WC = require('../wsdl/check');
const C = require('../schema/content');
const SM = require('../sample/sample');
const U = require('../util');

const ENV = { '1.1': 'http://schemas.xmlsoap.org/soap/envelope/', '1.2': 'http://www.w3.org/2003/05/soap-envelope' };

/** Every SOAP operation of the loaded WSDL documents: [{ binding, operation, version, label }]. */
function soapOperations(set) {
  const out = [];
  for (const w of set.wsdlDocs) {
    for (const b of w.info.bindings) {
      if (!b.soap) continue;
      for (const op of b.operations) out.push({ wsdl: w, binding: b, operation: op, version: b.soap, label: op.name + ' (' + b.name + ', SOAP ' + b.soap + ')' });
    }
  }
  return out;
}

function partParticle(set, part) {
  if (part.element) {
    const qn = WC.resolveName(part.element);
    if (qn.error) return { error: 'The prefix of "' + part.element.value + '" is not declared.' };
    const comp = set.lookup('element', qn.ns, qn.local);
    if (!comp) return { error: 'The element "' + part.element.value + '" is not declared in the loaded schemas.' };
    return { particle: C.elementOfComp(set, comp) };
  }
  if (part.type) {
    return { particle: { p: 'element', name: part.name, ns: '', min: 1, max: 1, node: part.node, doc: null, decl: part.node, declDoc: null, typeValue: part.type.value, typeNode: null, global: null, ref: false } };
  }
  return { error: 'The part "' + part.name + '" has neither element nor type.' };
}

function fragment(set, particle, options, indent, notes) {
  const r = SM.sampleForParticle(set, particle, options, indent);
  for (const n of r.notes) if (notes.indexOf(n) === -1) notes.push(n);
  return r.text;
}

function messageParts(set, ref) {
  const hit = ref ? WC.lookupWsdl(set, 'message', ref) : null;
  return hit ? hit.item.parts : null;
}

function bodyFor11(set, ctx, portOp, bindIo, wrapperName, options, indent, notes) {
  if (!portOp || !portOp.message) return '';
  const parts = messageParts(set, portOp.message);
  if (!parts) { notes.push('The message "' + portOp.message.value + '" was not found.'); return ''; }
  const chosen = bindIo && bindIo.parts ? parts.filter(function (p) { return bindIo.parts.indexOf(p.name) !== -1; }) : parts;
  const lines = [];
  if (ctx.style === 'rpc') {
    const ns = bindIo && bindIo.namespace ? bindIo.namespace : ctx.tns;
    lines.push(indent + '<op:' + wrapperName + ' xmlns:op="' + U.escapeXml(ns) + '">');
    for (const p of chosen) {
      const pp = partParticle(set, p);
      if (pp.error) { notes.push(pp.error); continue; }
      const particle = p.element ? pp.particle : Object.assign({}, pp.particle);
      const text = fragment(set, particle, options, indent + '  ', notes);
      if (p.element) lines.push(indent + '  <' + p.name + '>', text.replace(/^/gm, '  '), indent + '  </' + p.name + '>');
      else lines.push(text);
    }
    lines.push(indent + '</op:' + wrapperName + '>');
  } else {
    for (const p of chosen) {
      const pp = partParticle(set, p);
      if (pp.error) { notes.push(pp.error); continue; }
      if (!p.element) notes.push('The part "' + p.name + '" names a type in a document-style operation; it is shown as an element named after the part.');
      lines.push(fragment(set, pp.particle, options, indent, notes));
    }
  }
  return lines.join('\n');
}

function headersFor11(set, bindIo, options, indent, notes) {
  if (!bindIo || !bindIo.headers.length) return '';
  const out = [];
  for (const h of bindIo.headers) {
    const parts = messageParts(set, h.message);
    const part = parts ? parts.find(function (p) { return p.name === h.part; }) : null;
    if (!part) { notes.push('The header part "' + h.part + '" was not found.'); continue; }
    const pp = partParticle(set, part);
    if (pp.error) { notes.push(pp.error); continue; }
    out.push(fragment(set, pp.particle, options, indent, notes));
  }
  return out.join('\n');
}

function envelope(version, header, body, comment) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  if (comment) lines.push('<!-- ' + comment.replace(/--/g, '- -') + ' -->');
  lines.push('<soap:Envelope xmlns:soap="' + ENV[version] + '">');
  if (header) lines.push('  <soap:Header>', header, '  </soap:Header>');
  lines.push('  <soap:Body>');
  if (body) lines.push(body);
  lines.push('  </soap:Body>', '</soap:Envelope>');
  return lines.join('\n') + '\n';
}

function faultBody(version, detail, name) {
  const lines = [];
  if (version === '1.1') {
    lines.push('    <soap:Fault>', '      <faultcode>soap:Server</faultcode>', '      <faultstring>' + U.escapeXml(name || 'Fault') + '</faultstring>');
    if (detail) lines.push('      <detail>', detail, '      </detail>');
    lines.push('    </soap:Fault>');
  } else {
    lines.push('    <soap:Fault>', '      <soap:Code><soap:Value>soap:Receiver</soap:Value></soap:Code>',
      '      <soap:Reason><soap:Text xml:lang="en">' + U.escapeXml(name || 'Fault') + '</soap:Text></soap:Reason>');
    if (detail) lines.push('      <soap:Detail>', detail, '      </soap:Detail>');
    lines.push('    </soap:Fault>');
  }
  return lines.join('\n');
}

function httpLine(version, action) {
  if (version === '1.1') return 'SOAP 1.1. HTTP headers: Content-Type: text/xml; charset=utf-8; SOAPAction: "' + (action || '') + '"';
  return 'SOAP 1.2. HTTP header: Content-Type: application/soap+xml; charset=utf-8' + (action ? '; action="' + action + '"' : '');
}

/**
 * Envelope samples for one entry of soapOperations(). Options are passed to the sample builder
 * (mode, seed, realistic, ...). Returns { request, response, faults: [{ name, text }], notes, address, action }.
 */
function buildEnvelopes(set, entry, options) {
  const notes = [];
  const w = entry.wsdl;
  const b = entry.binding;
  const op = entry.operation;
  const version = entry.version;
  const itf = b.type ? WC.lookupWsdl(set, 'interface', b.type) : null;
  const portOp = itf ? itf.item.operations.find(function (o) { return o.name === op.name; }) : null;
  if (!portOp) notes.push('The operation "' + op.name + '" was not found in the ' + (w.info.version === '2.0' ? 'interface' : 'port type') + ' of the binding.');
  const addresses = [];
  for (const ww of set.wsdlDocs) for (const s of ww.info.services) for (const p of s.ports) {
    const hit = p.binding ? WC.lookupWsdl(set, 'binding', p.binding) : null;
    if (hit && hit.item === b && p.address) addresses.push(p.address);
  }
  const action = op.soapAction || '';
  const ind = '    ';
  let request = '';
  let response = '';
  const faults = [];
  if (w.info.version === '1.1') {
    const ctx = { style: op.style || b.style || 'document', tns: w.info.targetNamespace };
    const encoded = [op.input, op.output].some(function (io) { return io && (io.use === 'encoded' || (io.headers || []).some(function (h) { return h.use === 'encoded'; })); });
    if (encoded) notes.push('The binding uses use="encoded" (SOAP encoding). The envelopes are written as literal XML: they carry no xsi:type or encodingStyle attributes and no multi-reference values, so a service that expects SOAP encoding may need those added.');
    if (portOp && portOp.input) {
      request = envelope(version, headersFor11(set, op.input, options, ind, notes), bodyFor11(set, ctx, portOp.input, op.input, op.name, options, ind, notes), httpLine(version, action) + (addresses.length ? '. Endpoint: ' + addresses[0] : ''));
    }
    if (portOp && portOp.output) {
      response = envelope(version, headersFor11(set, op.output, options, ind, notes), bodyFor11(set, ctx, portOp.output, op.output, op.name + 'Response', options, ind, notes), 'Response of ' + op.name);
    }
    for (const f of portOp ? portOp.faults : []) {
      const parts = messageParts(set, f.message) || [];
      const detail = parts.map(function (p) { const pp = partParticle(set, p); return pp.error ? '' : fragment(set, pp.particle, options, '        ', notes); }).filter(Boolean).join('\n');
      faults.push({ name: f.name, text: envelope(version, '', faultBody(version, detail, f.name), 'Fault ' + f.name + ' of ' + op.name) });
    }
  } else {
    const elementFor = function (io) {
      if (!io || !io.element) return '';
      if (io.element.value.charAt(0) === '#') { notes.push('The message "' + io.name + '" is ' + io.element.value + ', so its body has no fixed element.'); return ''; }
      const pp = partParticle(set, { element: io.element, name: io.name });
      if (pp.error) { notes.push(pp.error); return ''; }
      return fragment(set, pp.particle, options, ind, notes);
    };
    if (portOp && portOp.input) request = envelope(version, '', elementFor(portOp.input), httpLine(version, action) + (addresses.length ? '. Endpoint: ' + addresses[0] : ''));
    if (portOp && portOp.output) response = envelope(version, '', elementFor(portOp.output), 'Response of ' + op.name);
    for (const f of portOp ? portOp.faults : []) {
      const r = f.ref ? WC.resolveName(f.ref) : null;
      const decl = r && !r.error ? (itf.item.faults || []).find(function (x) { return x.name === r.local; }) : null;
      const detail = decl && decl.element ? elementFor({ element: decl.element, name: decl.name }).replace(/^ {4}/gm, '        ') : '';
      faults.push({ name: decl ? decl.name : f.name, text: envelope(version, '', faultBody(version, detail, decl ? decl.name : f.name), 'Fault ' + (decl ? decl.name : f.name) + ' of ' + op.name) });
    }
  }
  return { request: request, response: response, faults: faults, notes: notes, address: addresses[0] || '', action: action, version: version };
}

module.exports = { soapOperations: soapOperations, buildEnvelopes: buildEnvelopes, ENV: ENV, W: W, P: P };
