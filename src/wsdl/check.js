'use strict';
// WSDL index (messages, port types / interfaces, bindings, services by expanded name across all
// loaded WSDL documents) and the structural problems of a WSDL document.

const P = require('../xml/parser');
const U = require('../util');

const CODES = {
  'WSDL-UNRESOLVED-MESSAGE': 'error', 'WSDL-UNRESOLVED-PORT-TYPE': 'error', 'WSDL-UNRESOLVED-INTERFACE': 'error', 'WSDL-UNRESOLVED-BINDING': 'error',
  'WSDL-UNRESOLVED-ELEMENT': 'error', 'WSDL-UNRESOLVED-TYPE': 'error', 'WSDL-UNRESOLVED-FAULT': 'error', 'WSDL-UNDECLARED-PREFIX': 'error',
  'WSDL-DUPLICATE-NAME': 'error', 'WSDL-PART-ELEMENT-AND-TYPE': 'error', 'WSDL-BINDING-OPERATION-MISSING': 'error', 'WSDL-OPERATION-NOT-BOUND': 'info',
  'WSDL-UNKNOWN-PART': 'error', 'WSDL-NO-ADDRESS': 'warning', 'WSDL-STYLE-MISMATCH': 'warning', 'WSDL-MISSING-FILE': 'error', 'WSDL-UNREACHABLE-IMPORT': 'info'
};

function wkey(kind, ns, name) { return kind + ' {' + (ns || '') + '}' + name; }

/** Index of WSDL components of a set: Map key -> { kind, item, wsdl }. Cached on the set. */
function wsdlIndex(set) {
  if (set.cache.has('wsdlIndex')) return set.cache.get('wsdlIndex');
  const map = new Map();
  const dupes = [];
  function add(kind, w, item) {
    const k = wkey(kind, w.info.targetNamespace, item.name);
    if (map.has(k)) dupes.push({ kind: kind, wsdl: w, item: item });
    else map.set(k, { kind: kind, item: item, wsdl: w });
  }
  for (const w of set.wsdlDocs) {
    for (const m of w.info.messages) add('message', w, m);
    for (const i of w.info.interfaces) add('interface', w, i);
    for (const b of w.info.bindings) add('binding', w, b);
    for (const s of w.info.services) add('service', w, s);
  }
  const index = { map: map, dupes: dupes };
  set.cache.set('wsdlIndex', index);
  return index;
}

/** Resolves a WSDL reference { value, node } to { ns, local } or { error }. */
function resolveName(refObj) {
  const qn = P.splitQName(refObj.value);
  const ns = P.lookupNamespace(refObj.node, qn.prefix);
  if (ns === null) return { error: 'prefix', prefix: qn.prefix, local: qn.local };
  return { ns: ns, local: qn.local, prefix: qn.prefix };
}

/** Looks up a WSDL component by kind and reference. Returns { kind, item, wsdl } or null. */
function lookupWsdl(set, kind, refObj) {
  if (!refObj) return null;
  const r = resolveName(refObj);
  if (r.error) return null;
  return wsdlIndex(set).map.get(wkey(kind, r.ns, r.local)) || null;
}

function attrRange(refObj) {
  const a = P.attrNode(refObj.node, refObj.attr);
  return a ? [a.valueStart, a.valueEnd] : [refObj.node.start + 1, refObj.node.nameEnd];
}

function push(out, code, message, start, end, severity) {
  out.push({ code: code, severity: severity || CODES[code], message: message, start: start, end: Math.max(start + 1, end) });
}

function checkRef(set, out, refObj, kind, code, what) {
  if (!refObj) return null;
  const r = resolveName(refObj);
  const range = attrRange(refObj);
  if (r.error) { push(out, 'WSDL-UNDECLARED-PREFIX', 'The prefix "' + r.prefix + '" is not declared.', range[0], range[0] + r.prefix.length); return null; }
  const hit = wsdlIndex(set).map.get(wkey(kind, r.ns, r.local));
  if (!hit) push(out, code, 'No ' + what + ' named "' + r.local + '" in the namespace "' + r.ns + '" is defined in the loaded WSDL documents.', range[0], range[1]);
  return hit;
}

function checkSchemaRef(set, out, refObj, space, code) {
  if (!refObj) return;
  const range = attrRange(refObj);
  if (refObj.value.charAt(0) === '#') return;
  const qn = P.splitQName(refObj.value);
  const ns = P.lookupNamespace(refObj.node, qn.prefix);
  if (ns === null) { push(out, 'WSDL-UNDECLARED-PREFIX', 'The prefix "' + qn.prefix + '" is not declared.', range[0], range[0] + qn.prefix.length); return; }
  if (set.lookup(space, ns, qn.local)) return;
  if (set.unreachableNamespaces.has(ns)) return;
  if (!set.loadedNamespaces.has(ns) && ns !== 'http://www.w3.org/2001/XMLSchema') {
    push(out, code, 'The ' + (space === 'type' ? 'type' : 'element') + ' "' + qn.local + '" is in the namespace "' + ns + '", which no loaded schema defines.', range[0], range[1]);
    return;
  }
  push(out, code, 'No ' + (space === 'type' ? 'type' : 'element') + ' named "' + qn.local + '" in the namespace "' + ns + '" is declared in the schemas of this WSDL.', range[0], range[1]);
}

/** Adds the problems of WSDL document `w` (from set.wsdlDocs) to `out`. */
function checkWsdl(set, w, out) {
  const info = w.info;
  const index = wsdlIndex(set);
  for (const d of index.dupes) {
    if (d.wsdl !== w) continue;
    const n = P.attrNode(d.item.node, 'name');
    push(out, 'WSDL-DUPLICATE-NAME', 'Another ' + d.kind + ' named "' + d.item.name + '" exists in this namespace.', n ? n.valueStart : d.item.node.start, n ? n.valueEnd : d.item.node.nameEnd);
  }
  for (const imp of info.imports) {
    const a = P.attrNode(imp.node, 'location');
    const range = a ? [a.valueStart, a.valueEnd] : [imp.node.start + 1, imp.node.nameEnd];
    if (imp.status === 'missing' || imp.status === 'error') push(out, 'WSDL-MISSING-FILE', 'The file "' + imp.location + '" was not found next to this file.', range[0], range[1]);
    else if (imp.status === 'remote') push(out, 'WSDL-UNREACHABLE-IMPORT', 'The location "' + imp.location + '" is ' + (imp.remoteKind === 'host' ? 'on another computer (for example a network share) and is not loaded automatically' : 'on the internet and is not loaded (no network requests)') + '; its definitions are not checked.', range[0], range[1]);
  }
  for (const m of info.messages) {
    for (const part of m.parts) {
      if (part.element && part.type) push(out, 'WSDL-PART-ELEMENT-AND-TYPE', 'A part names either an element or a type, not both.', part.node.start + 1, part.node.nameEnd);
      else if (!part.element && !part.type) push(out, 'WSDL-PART-ELEMENT-AND-TYPE', 'The part "' + part.name + '" needs an element or a type attribute.', part.node.start + 1, part.node.nameEnd);
      checkSchemaRef(set, out, part.element, 'element', 'WSDL-UNRESOLVED-ELEMENT');
      checkSchemaRef(set, out, part.type, 'type', 'WSDL-UNRESOLVED-TYPE');
    }
  }
  for (const itf of info.interfaces) {
    for (const ext of itf.extends) checkRef(set, out, ext, 'interface', 'WSDL-UNRESOLVED-INTERFACE', 'interface');
    for (const f of itf.faults || []) checkSchemaRef(set, out, f.element, 'element', 'WSDL-UNRESOLVED-ELEMENT');
    for (const op of itf.operations) {
      for (const io of [op.input, op.output]) {
        if (!io) continue;
        if (io.message) checkRef(set, out, io.message, 'message', 'WSDL-UNRESOLVED-MESSAGE', 'message');
        if (io.element) checkSchemaRef(set, out, io.element, 'element', 'WSDL-UNRESOLVED-ELEMENT');
      }
      for (const f of op.faults) {
        if (f.message) checkRef(set, out, f.message, 'message', 'WSDL-UNRESOLVED-MESSAGE', 'message');
        if (f.ref) {
          const r = resolveName(f.ref);
          const ok = !r.error && (itf.faults || []).some(function (x) { return x.name === r.local; });
          if (!ok) { const range = attrRange(f.ref); push(out, 'WSDL-UNRESOLVED-FAULT', 'No fault named "' + (r.local || f.ref.value) + '" is declared in this interface.', range[0], range[1]); }
        }
      }
    }
  }
  for (const b of info.bindings) {
    const hit = checkRef(set, out, b.type, 'interface', info.version === '2.0' ? 'WSDL-UNRESOLVED-INTERFACE' : 'WSDL-UNRESOLVED-PORT-TYPE', info.version === '2.0' ? 'interface' : 'port type');
    if (!hit) continue;
    const opNames = new Set(hit.item.operations.map(function (o) { return o.name; }));
    const bound = new Set();
    for (const op of b.operations) {
      bound.add(op.name);
      if (!opNames.has(op.name)) {
        const n = P.attrNode(op.node, info.version === '2.0' ? 'ref' : 'name');
        push(out, 'WSDL-BINDING-OPERATION-MISSING', 'The binding names the operation "' + op.name + '", which the ' + (info.version === '2.0' ? 'interface' : 'port type') + ' "' + hit.item.name + '" does not have.', n ? n.valueStart : op.node.start, n ? n.valueEnd : op.node.nameEnd);
        continue;
      }
      if (info.version === '1.1') {
        const pop = hit.item.operations.find(function (o) { return o.name === op.name; });
        for (const which of ['input', 'output']) {
          const bio = op[which];
          const pio = pop[which];
          if (!bio || !pio || !pio.message) continue;
          const msg = lookupWsdl(set, 'message', pio.message);
          if (!msg) continue;
          if (bio.parts) {
            for (const pn of bio.parts) {
              if (!msg.item.parts.some(function (p) { return p.name === pn; })) {
                const body = P.childElements(bio.node).find(function (c) { return c.local === 'body'; });
                const a = body ? P.attrNode(body, 'parts') : null;
                push(out, 'WSDL-UNKNOWN-PART', 'The message "' + msg.item.name + '" has no part named "' + pn + '".', a ? a.valueStart : bio.node.start, a ? a.valueEnd : bio.node.nameEnd);
              }
            }
          }
          for (const h of bio.headers) {
            const hm = h.message ? checkRef(set, out, h.message, 'message', 'WSDL-UNRESOLVED-MESSAGE', 'message') : null;
            if (hm && h.part && !hm.item.parts.some(function (p) { return p.name === h.part; })) {
              const a = P.attrNode(h.node, 'part');
              push(out, 'WSDL-UNKNOWN-PART', 'The message "' + hm.item.name + '" has no part named "' + h.part + '".', a ? a.valueStart : h.node.start, a ? a.valueEnd : h.node.nameEnd);
            }
          }
          const style = op.style || b.style;
          if (b.protocol === 'soap') {
            for (const p of msg.item.parts) {
              if (bio.parts && bio.parts.indexOf(p.name) === -1) continue;
              if (style === 'document' && p.type && !p.element) push(out, 'WSDL-STYLE-MISMATCH', 'The part "' + p.name + '" uses type= but the operation "' + op.name + '" is document style; document style parts normally name an element.', p.node.start + 1, p.node.nameEnd);
              if (style === 'rpc' && p.element && !p.type) push(out, 'WSDL-STYLE-MISMATCH', 'The part "' + p.name + '" uses element= but the operation "' + op.name + '" is rpc style; rpc style parts normally name a type.', p.node.start + 1, p.node.nameEnd);
            }
          }
        }
      }
    }
    for (const name of opNames) {
      if (!bound.has(name)) push(out, 'WSDL-OPERATION-NOT-BOUND', 'The operation "' + name + '" is not part of the binding "' + b.name + '".', b.node.start + 1, b.node.nameEnd);
    }
  }
  for (const s of info.services) {
    if (s.interface) checkRef(set, out, s.interface, 'interface', 'WSDL-UNRESOLVED-INTERFACE', 'interface');
    for (const port of s.ports) {
      checkRef(set, out, port.binding, 'binding', 'WSDL-UNRESOLVED-BINDING', 'binding');
      if (!port.address && info.version === '1.1') push(out, 'WSDL-NO-ADDRESS', 'The port "' + port.name + '" has no address element.', port.node.start + 1, port.node.nameEnd);
    }
  }
  return out;
}

module.exports = { checkWsdl: checkWsdl, wsdlIndex: wsdlIndex, lookupWsdl: lookupWsdl, resolveName: resolveName, wkey: wkey, CODES: CODES, U: U };
