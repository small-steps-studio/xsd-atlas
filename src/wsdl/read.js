'use strict';
// Reads the structure of a WSDL 1.1 or WSDL 2.0 document from its parse tree: imports, embedded
// schemas, messages, port types / interfaces, bindings (SOAP 1.1, SOAP 1.2) and services. QName
// references are kept as written, with their node, so that they can be resolved later.

const P = require('../xml/parser');

const WSDL11 = 'http://schemas.xmlsoap.org/wsdl/';
const WSDL20 = 'http://www.w3.org/ns/wsdl';
const SOAP11_BINDING = 'http://schemas.xmlsoap.org/wsdl/soap/';
const SOAP12_BINDING = 'http://schemas.xmlsoap.org/wsdl/soap12/';
const HTTP_BINDING = 'http://schemas.xmlsoap.org/wsdl/http/';
const WSOAP = 'http://www.w3.org/ns/wsdl/soap';
const XSD = 'http://www.w3.org/2001/XMLSchema';

function kids(el, ns, local) {
  return P.childElements(el).filter(function (c) { return c.ns === ns && (local === undefined || c.local === local); });
}
function kid(el, ns, local) { return kids(el, ns, local)[0] || null; }
function soapKid(el, local) {
  for (const c of P.childElements(el)) {
    if ((c.ns === SOAP11_BINDING || c.ns === SOAP12_BINDING) && c.local === local) return c;
  }
  return null;
}
function ref(el, name) {
  const v = P.attr(el, name);
  return v === undefined ? null : { value: v.trim(), node: el, attr: name };
}

function read11(root, info) {
  info.version = '1.1';
  for (const imp of kids(root, WSDL11, 'import')) {
    info.imports.push({ kind: 'import', namespace: P.attr(imp, 'namespace') || '', location: P.attr(imp, 'location') || '', node: imp, status: 'none', resolved: '' });
  }
  for (const types of kids(root, WSDL11, 'types')) {
    for (const s of kids(types, XSD, 'schema')) info.schemas.push(s);
  }
  for (const m of kids(root, WSDL11, 'message')) {
    info.messages.push({
      name: P.attr(m, 'name') || '', node: m,
      parts: kids(m, WSDL11, 'part').map(function (p) {
        return { name: P.attr(p, 'name') || '', element: ref(p, 'element'), type: ref(p, 'type'), node: p };
      })
    });
  }
  for (const pt of kids(root, WSDL11, 'portType')) {
    info.interfaces.push({
      name: P.attr(pt, 'name') || '', node: pt, extends: [],
      operations: kids(pt, WSDL11, 'operation').map(function (op) {
        const input = kid(op, WSDL11, 'input');
        const output = kid(op, WSDL11, 'output');
        return {
          name: P.attr(op, 'name') || '', node: op, pattern: input && output ? (P.childElements(op)[0] === output ? 'solicit-response' : 'request-response') : input ? 'one-way' : output ? 'notification' : '',
          input: input ? { name: P.attr(input, 'name') || '', message: ref(input, 'message'), node: input } : null,
          output: output ? { name: P.attr(output, 'name') || '', message: ref(output, 'message'), node: output } : null,
          faults: kids(op, WSDL11, 'fault').map(function (f) { return { name: P.attr(f, 'name') || '', message: ref(f, 'message'), node: f }; })
        };
      })
    });
  }
  for (const b of kids(root, WSDL11, 'binding')) {
    const sb = soapKid(b, 'binding');
    const http = kid(b, HTTP_BINDING, 'binding');
    const binding = {
      name: P.attr(b, 'name') || '', node: b, type: ref(b, 'type'),
      soap: sb ? (sb.ns === SOAP12_BINDING ? '1.2' : '1.1') : null,
      protocol: sb ? 'soap' : http ? 'http' : '',
      style: sb ? (P.attr(sb, 'style') || 'document') : '',
      transport: sb ? (P.attr(sb, 'transport') || '') : '',
      operations: []
    };
    for (const op of kids(b, WSDL11, 'operation')) {
      const so = soapKid(op, 'operation');
      function msg(el) {
        if (!el) return null;
        const body = soapKid(el, 'body');
        return {
          use: body ? (P.attr(body, 'use') || 'literal') : '',
          namespace: body ? (P.attr(body, 'namespace') || '') : '',
          parts: body && P.attr(body, 'parts') !== undefined ? P.attr(body, 'parts').trim().split(/\s+/).filter(Boolean) : null,
          headers: P.childElements(el).filter(function (c) { return (c.ns === SOAP11_BINDING || c.ns === SOAP12_BINDING) && c.local === 'header'; })
            .map(function (h) { return { message: ref(h, 'message'), part: P.attr(h, 'part') || '', use: P.attr(h, 'use') || 'literal', node: h }; }),
          node: el
        };
      }
      binding.operations.push({
        name: P.attr(op, 'name') || '', node: op,
        soapAction: so && P.attr(so, 'soapAction') !== undefined ? P.attr(so, 'soapAction') : null,
        style: so && P.attr(so, 'style') ? P.attr(so, 'style') : binding.style,
        input: msg(kid(op, WSDL11, 'input')),
        output: msg(kid(op, WSDL11, 'output')),
        faults: kids(op, WSDL11, 'fault').map(function (f) { return { name: P.attr(f, 'name') || '', node: f }; })
      });
    }
    info.bindings.push(binding);
  }
  for (const s of kids(root, WSDL11, 'service')) {
    info.services.push({
      name: P.attr(s, 'name') || '', node: s, interface: null,
      ports: kids(s, WSDL11, 'port').map(function (p) {
        const addr = P.childElements(p).find(function (c) { return c.local === 'address' && (c.ns === SOAP11_BINDING || c.ns === SOAP12_BINDING || c.ns === HTTP_BINDING); });
        return { name: P.attr(p, 'name') || '', binding: ref(p, 'binding'), address: addr ? (P.attr(addr, 'location') || '') : '', node: p };
      })
    });
  }
}

function read20(root, info) {
  info.version = '2.0';
  for (const imp of kids(root, WSDL20, 'import')) {
    info.imports.push({ kind: 'import', namespace: P.attr(imp, 'namespace') || '', location: P.attr(imp, 'location') || '', node: imp, status: 'none', resolved: '' });
  }
  for (const inc of kids(root, WSDL20, 'include')) {
    info.imports.push({ kind: 'include', namespace: '', location: P.attr(inc, 'location') || '', node: inc, status: 'none', resolved: '' });
  }
  for (const types of kids(root, WSDL20, 'types')) {
    for (const s of kids(types, XSD, 'schema')) info.schemas.push(s);
  }
  for (const itf of kids(root, WSDL20, 'interface')) {
    const ext = P.attr(itf, 'extends');
    info.interfaces.push({
      name: P.attr(itf, 'name') || '', node: itf,
      extends: ext ? ext.trim().split(/\s+/).map(function (v) { return { value: v, node: itf, attr: 'extends' }; }) : [],
      faults: kids(itf, WSDL20, 'fault').map(function (f) { return { name: P.attr(f, 'name') || '', element: ref(f, 'element'), node: f }; }),
      operations: kids(itf, WSDL20, 'operation').map(function (op) {
        const input = kid(op, WSDL20, 'input');
        const output = kid(op, WSDL20, 'output');
        return {
          name: P.attr(op, 'name') || '', node: op, pattern: (P.attr(op, 'pattern') || '').replace(/^.*\//, ''),
          input: input ? { name: P.attr(input, 'messageLabel') || 'In', element: ref(input, 'element'), node: input } : null,
          output: output ? { name: P.attr(output, 'messageLabel') || 'Out', element: ref(output, 'element'), node: output } : null,
          faults: kids(op, WSDL20).filter(function (c) { return c.local === 'infault' || c.local === 'outfault'; })
            .map(function (f) { return { name: f.local, ref: ref(f, 'ref'), node: f }; })
        };
      })
    });
  }
  for (const b of kids(root, WSDL20, 'binding')) {
    const type = P.attr(b, 'type') || '';
    const isSoap = type === WSOAP;
    let version = null;
    if (isSoap) {
      const v = b.attrs.find(function (a) { return a.ns === WSOAP && a.local === 'version'; });
      version = v ? v.value : '1.2';
    }
    const protocolAttr = b.attrs.find(function (a) { return a.ns === WSOAP && a.local === 'protocol'; });
    info.bindings.push({
      name: P.attr(b, 'name') || '', node: b, type: ref(b, 'interface'),
      soap: isSoap ? (version === '1.1' ? '1.1' : '1.2') : null,
      protocol: isSoap ? 'soap' : type ? 'http' : '',
      style: 'document',
      transport: protocolAttr ? protocolAttr.value : '',
      operations: kids(b, WSDL20, 'operation').map(function (op) {
        const action = op.attrs.find(function (a) { return a.ns === WSOAP && a.local === 'action'; });
        return { name: (P.attr(op, 'ref') || '').replace(/^.*:/, ''), ref: ref(op, 'ref'), node: op, soapAction: action ? action.value : null, style: 'document', input: null, output: null, faults: [] };
      })
    });
  }
  for (const s of kids(root, WSDL20, 'service')) {
    info.services.push({
      name: P.attr(s, 'name') || '', node: s, interface: ref(s, 'interface'),
      ports: kids(s, WSDL20, 'endpoint').map(function (e) {
        return { name: P.attr(e, 'name') || '', binding: ref(e, 'binding'), address: P.attr(e, 'address') || '', node: e };
      })
    });
  }
}

/** Reads a WSDL parse result. Returns the structure described at the top of this file. */
function readWsdl(parsed, uri) {
  const root = parsed && parsed.root;
  const info = {
    uri: uri, version: '', root: root, parsed: parsed,
    targetNamespace: root ? (P.attr(root, 'targetNamespace') || '') : '',
    name: root ? (P.attr(root, 'name') || '') : '',
    imports: [], schemas: [], messages: [], interfaces: [], bindings: [], services: []
  };
  if (!root) return info;
  if (root.ns === WSDL11 && root.local === 'definitions') read11(root, info);
  else if (root.ns === WSDL20 && root.local === 'description') read20(root, info);
  return info;
}

module.exports = {
  readWsdl: readWsdl, WSDL11: WSDL11, WSDL20: WSDL20, SOAP11_BINDING: SOAP11_BINDING, SOAP12_BINDING: SOAP12_BINDING,
  HTTP_BINDING: HTTP_BINDING, WSOAP: WSOAP
};
