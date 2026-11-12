'use strict';
// Plain descriptions of schema components for hovers: kind, name, namespace, where it is
// defined, the base type chain, effective facets, content and attributes, occurrence and the
// documentation. The output is Markdown with every schema-supplied value in code spans or
// escaped, so a schema cannot inject links or markup into the hover.

const P = require('../xml/parser');
const C = require('./content');
const S = require('./set');
const U = require('../util');

const MAX_ROWS = 25;

function code(s) {
  const t = String(s === undefined || s === null ? '' : s).replace(/[\r\n]+/g, ' ');
  const ticks = /`+/.exec(t) ? '``' : '`';
  return ticks + (ticks.length > 1 ? ' ' : '') + t + (ticks.length > 1 ? ' ' : '') + ticks;
}

function where(comp) {
  if (!comp || !comp.loc) return '';
  const doc = comp.doc;
  const line = doc ? doc.lines.positionAt(comp.loc.start).line + 1 : 0;
  return U.escapeMarkdown(U.baseName(comp.loc.uri)) + (line ? ', line ' + line : '');
}

/** Lines describing the facets of a simple type definition. */
function facetLines(def) {
  const out = [];
  if (!def) return out;
  if (def.variety === 'list') out.push('List of ' + code(C.typeLabel(def.itemDef, def.node)));
  if (def.variety === 'union') out.push('Union of ' + (def.memberDefs || []).map(function (m) { return code(C.typeLabel(m, def.node)); }).join(', '));
  const f = def.facets || {};
  if (f.enumeration && f.enumeration.length) {
    const vals = f.enumeration.slice(0, 12).map(function (e) { return code(e.value); }).join(', ');
    out.push('Allowed values: ' + vals + (f.enumeration.length > 12 ? ' and ' + (f.enumeration.length - 12) + ' more' : ''));
  }
  for (const lvl of f.patterns || []) out.push('Pattern: ' + lvl.map(function (p) { return code(p.value); }).join(' or '));
  for (const k of ['length', 'minLength', 'maxLength', 'minInclusive', 'minExclusive', 'maxInclusive', 'maxExclusive', 'totalDigits', 'fractionDigits', 'whiteSpace']) {
    if (f[k]) out.push(k + ': ' + code(f[k].value));
  }
  return out;
}

function chainText(def) {
  const chain = C.baseChain(def).filter(function (d) { return !(d.builtin === 'anyType' && def.category === 'complex') || true; });
  if (!chain.length) return '';
  return chain.slice(0, 8).map(function (d) { return code(C.typeLabel(d, def.node || null)); }).join(' → ');
}

function contentLines(set, def) {
  const out = [];
  if (!def || def.category !== 'complex') return out;
  if (def.contentKind === 'simple') {
    out.push('Text content: ' + code(C.typeLabel(def.simpleDef, def.node)));
  } else if (def.contentKind === 'empty') {
    out.push('Empty content (attributes only).');
  } else if (def.builtin !== 'anyType') {
    const items = C.flattenElements(def.particle);
    const rows = items.slice(0, MAX_ROWS).map(function (e) {
      const p = e.particle;
      const inChoice = e.path.some(function (c) { return c.p === 'choice' && c.items.length > 1; });
      if (p.p === 'any') return '- any element (' + U.escapeMarkdown(p.namespace) + ') ' + U.occursText(p.min, p.max);
      const t = C.elementType(set, p);
      return '- ' + code(p.name) + ' ' + U.occursText(p.min, p.max) + (inChoice ? ' (choice)' : '') + ': ' + code(C.typeLabel(t, p.decl));
    });
    if (rows.length) {
      out.push((def.mixed ? 'Mixed content' : 'Content') + ' (' + compositorWord(def.particle) + '):');
      out.push.apply(out, rows);
      if (items.length > MAX_ROWS) out.push('- ... and ' + (items.length - MAX_ROWS) + ' more');
    }
  }
  const attrs = Array.from(def.attributes ? def.attributes.values() : []);
  if (attrs.length) {
    out.push('Attributes:');
    for (const a of attrs.slice(0, MAX_ROWS)) {
      const t = C.attributeType(set, a);
      out.push('- ' + code('@' + a.name) + ' ' + (a.use === 'required' ? 'required' : 'optional') + ': ' + code(C.typeLabel(t, a.decl)) +
        (a.default !== undefined ? ', default ' + code(a.default) : '') + (a.fixed !== undefined ? ', fixed ' + code(a.fixed) : ''));
    }
  }
  if (def.anyAttribute) out.push('Any attribute (' + U.escapeMarkdown(def.anyAttribute.namespace) + ')');
  return out;
}

function compositorWord(p) {
  if (!p) return 'none';
  if (p.synthetic) return 'base content, then extension';
  return p.p;
}

/** Markdown for a type definition. */
function describeType(set, def, comp) {
  const lines = [];
  const kind = def.category === 'simple' ? 'simple type' : 'complex type';
  lines.push('**' + kind + '** ' + code(def.builtin ? 'xs:' + def.builtin : def.name || '(anonymous)') + (def.ns && !def.builtin ? ' — namespace ' + code(def.ns) : ''));
  if (def.builtin) lines.push('Built-in type of XML Schema.');
  if (comp && comp.loc) lines.push('Defined in ' + where(comp) + (comp.redefined ? ' (redefined)' : ''));
  const chain = chainText(def);
  if (chain && !def.builtin && def.derivation) lines.push((def.derivation === 'extension' ? 'Extends ' : def.derivation === 'list' || def.derivation === 'union' ? 'Derived from ' : 'Restricts ') + chain);
  if (def.abstract) lines.push('Abstract: documents must use a derived type.');
  if (def.category === 'simple') lines.push.apply(lines, facetLines(def));
  else {
    lines.push.apply(lines, contentLines(set, def));
    if (def.contentKind === 'simple' && def.simpleDef) lines.push.apply(lines, facetLines(def.simpleDef));
  }
  const doc = def.documentation || (comp && comp.node ? C.documentation(comp.doc, comp.node) : '');
  if (doc) lines.push('', U.escapeMarkdown(U.shorten(doc, 800)));
  return lines.join('\n\n');
}

/** Markdown for an element particle (local, global or reference). */
function describeElement(set, particle, comp) {
  const lines = [];
  lines.push('**element** ' + code(particle.name) + (particle.ns ? ' — namespace ' + code(particle.ns) : ' — no namespace'));
  if (comp && comp.loc) lines.push('Defined in ' + where(comp));
  const def = C.elementType(set, particle);
  lines.push('Type: ' + code(C.typeLabel(def, particle.decl)) + (def.category === 'complex' ? ' (complex)' : ' (simple)'));
  if (!(particle.global && particle.min === 1 && particle.max === 1 && !particle.ref)) lines.push('Occurs: ' + code(U.occursText(particle.min, particle.max)));
  const flags = [];
  if (particle.nillable) flags.push('nillable');
  if (particle.abstract) flags.push('abstract');
  if (particle.default !== undefined) flags.push('default ' + code(particle.default));
  if (particle.fixed !== undefined) flags.push('fixed ' + code(particle.fixed));
  if (particle.substitutionGroup) flags.push('substitutes for ' + code(particle.substitutionGroup));
  if (flags.length) lines.push(flags.join(', '));
  if (particle.global) {
    const members = set.membersOf(particle.global.key);
    if (members.length) lines.push('Substitution group members: ' + members.slice(0, 12).map(function (m) { return code(m.name); }).join(', '));
  }
  const chain = chainText(def);
  if (chain && !def.builtin && !def.anonymous) lines.push('Base types: ' + chain);
  if (def.category === 'simple') lines.push.apply(lines, facetLines(def));
  else {
    lines.push.apply(lines, contentLines(set, def));
    if (def.contentKind === 'simple' && def.simpleDef) lines.push.apply(lines, facetLines(def.simpleDef));
  }
  const doc = C.documentation(particle.declDoc, particle.decl) || (particle.ref ? '' : '') || def.documentation || '';
  if (doc) lines.push('', U.escapeMarkdown(U.shorten(doc, 800)));
  return lines.join('\n\n');
}

function describeAttribute(set, use, comp) {
  const lines = [];
  lines.push('**attribute** ' + code('@' + use.name) + (use.ns ? ' — namespace ' + code(use.ns) : ''));
  if (comp && comp.loc) lines.push('Defined in ' + where(comp));
  const def = C.attributeType(set, use);
  lines.push('Type: ' + code(C.typeLabel(def, use.decl)) + ', ' + (use.use === 'required' ? 'required' : use.use === 'prohibited' ? 'prohibited' : 'optional'));
  if (use.default !== undefined) lines.push('Default: ' + code(use.default));
  if (use.fixed !== undefined) lines.push('Fixed: ' + code(use.fixed));
  lines.push.apply(lines, facetLines(def));
  const doc = use.decl ? C.documentation(use.declDoc, use.decl) : '';
  if (doc) lines.push('', U.escapeMarkdown(U.shorten(doc, 800)));
  return lines.join('\n\n');
}

function describeGroup(set, comp) {
  const lines = ['**' + (comp.kind === 'group' ? 'group' : 'attribute group') + '** ' + code(comp.name) + ' — namespace ' + code(comp.ns || '(none)'), 'Defined in ' + where(comp)];
  if (comp.kind === 'group') {
    const p = C.groupParticle(set, comp);
    const items = C.flattenElements(p);
    if (items.length) {
      lines.push('Content (' + (p ? p.p : '') + '):');
      for (const e of items.slice(0, MAX_ROWS)) {
        const q = e.particle;
        lines.push(q.p === 'any' ? '- any element' : '- ' + code(q.name) + ' ' + U.occursText(q.min, q.max) + ': ' + code(C.typeLabel(C.elementType(set, q), q.decl)));
      }
    }
  } else {
    const uses = C.attributeGroupUses(set, comp);
    for (const a of Array.from(uses.values()).slice(0, MAX_ROWS)) lines.push('- ' + code('@' + a.name) + ' ' + (a.use === 'required' ? 'required' : 'optional') + ': ' + code(C.typeLabel(C.attributeType(set, a), a.decl)));
  }
  const doc = C.documentation(comp.doc, comp.node);
  if (doc) lines.push('', U.escapeMarkdown(U.shorten(doc, 800)));
  return lines.join('\n\n');
}

/**
 * Markdown for the thing a navigation target names (see navigate.targetAt), or '' when nothing is
 * known about it. `refNode` is the referring element (its occurrence is shown for element refs).
 */
function describeTarget(set, target, comp, refNode) {
  if (!target) return '';
  if (target.what === 'ref' && !comp) {
    if (target.unresolvedPrefix) return 'The prefix of this name is not declared.';
    if (set.unreachableNamespaces.has(target.ns)) return code(target.local) + ' is in the namespace ' + code(target.ns) + ', whose schema is not loaded (remote or missing location), so nothing more is known about it.';
    return 'No declaration named ' + code(target.local) + ' was found in the loaded schemas.';
  }
  if (target.what === 'local') {
    const doc = target.doc;
    if (target.space === 'element') {
      const p = C.particleOf(set, doc, target.node, null, []);
      return p ? describeElement(set, p, null) : '';
    }
    if (target.space === 'attribute') {
      const use = C.attributeUses(set, doc, { children: [target.node] }, null).values().next().value;
      return use ? describeAttribute(set, use, null) : '';
    }
    if (target.space === 'type') return describeType(set, C.defOfNode(set, doc, target.node, null), null);
    return '';
  }
  if (!comp) return '';
  if (comp.wsdl) return describeWsdl(set, comp);
  switch (comp.space) {
    case 'type': return describeType(set, C.defOfComp(set, comp), comp.builtin ? null : comp);
    case 'element': {
      let p = C.elementOfComp(set, comp);
      if (refNode && refNode.local === 'element' && P.attr(refNode, 'ref') !== undefined) {
        const o = C.occurs(refNode);
        p = Object.assign({}, p, { min: o.min, max: o.max, ref: true });
      }
      return describeElement(set, p, comp);
    }
    case 'attribute': {
      if (comp.builtin) return '**attribute** ' + code('xml:' + comp.name) + ' of the XML namespace.';
      const use = C.attributeUses(set, comp.doc, { children: [comp.node] }, null).values().next().value;
      return use ? describeAttribute(set, use, comp) : '';
    }
    case 'group': case 'attributeGroup': return describeGroup(set, comp);
    case 'identity': return '**' + comp.kind + '** ' + code(comp.name) + '\n\nDefined in ' + where(comp);
    case 'notation': return '**notation** ' + code(comp.name) + '\n\nDefined in ' + where(comp);
    default: return '';
  }
}

function describeWsdl(set, comp) {
  const item = comp.item;
  const lines = ['**' + (comp.kind === 'interface' ? 'port type / interface' : comp.kind) + '** ' + code(comp.name) + ' — namespace ' + code(comp.ns)];
  lines.push('Defined in ' + U.escapeMarkdown(U.baseName(comp.loc.uri)));
  if (comp.kind === 'message') for (const p of item.parts) lines.push('- part ' + code(p.name) + ': ' + (p.element ? 'element ' + code(p.element.value) : p.type ? 'type ' + code(p.type.value) : '(none)'));
  if (comp.kind === 'interface') for (const o of item.operations.slice(0, MAX_ROWS)) lines.push('- operation ' + code(o.name) + (o.pattern ? ' (' + U.escapeMarkdown(o.pattern) + ')' : ''));
  if (comp.kind === 'binding') {
    lines.push((item.soap ? 'SOAP ' + item.soap : item.protocol || 'binding') + (item.style ? ', ' + item.style + ' style' : ''));
    for (const o of item.operations.slice(0, MAX_ROWS)) lines.push('- ' + code(o.name) + (o.soapAction ? ' action ' + code(o.soapAction) : ''));
  }
  return lines.join('\n\n');
}

module.exports = { describeTarget: describeTarget, describeType: describeType, describeElement: describeElement, facetLines: facetLines, code: code, S: S };
