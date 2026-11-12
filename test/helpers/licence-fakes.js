'use strict';
// Stand-ins for the editor stores and the public licence endpoints, with the documented answer
// shapes (activate 201 with product and customer blocks, validate 200 { valid }, deactivate 200
// with an empty body). Used by the licence tests.

const config = require('../../src/licence/config');
const L = require('../../src/licence/licence');

function stores(options) {
  const o = options || {};
  const secrets = new Map();
  const global = new Map();
  return {
    secretsMap: secrets,
    globalMap: global,
    secrets: {
      get: async (k) => { if (o.failGet) throw new Error('no keyring'); return secrets.get(k); },
      store: async (k, v) => { if (o.failStore) throw new Error('no keyring'); secrets.set(k, v); },
      delete: async (k) => { secrets.delete(k); }
    },
    globalState: {
      get: (k) => global.get(k),
      update: async (k, v) => { if (o.readOnly) throw new Error('read only'); if (v === undefined) global.delete(k); else global.set(k, v); }
    }
  };
}

/**
 * options.keys maps a key to the product it belongs to; options.limit is the seat limit per key;
 * options.down makes every request fail; options.noDeactivate answers deactivate with 500;
 * options.validateStatus answers validate with that HTTP status; options.invalid makes validate
 * answer { valid: false }.
 */
function server(options) {
  const o = Object.assign({
    keys: {
      'KEY-PERSONAL': config.products.test.personal, 'KEY-BUSINESS': config.products.test.business,
      'KEY-LIVE': config.products.live.personal, 'KEY-OTHER': 'pdt_OtherProduct0001', 'KEY-LIVE-PERSONAL': config.products.live.personal
    },
    limit: 3
  }, options || {});
  const calls = [];
  const active = new Map();
  let seq = 0;
  async function fetch(url, init) {
    const body = JSON.parse(init.body);
    calls.push({ url: url, body: body });
    if (o.down) throw new Error('offline');
    const path = url.replace(/^https:\/\/[^/]+/, '');
    const reply = function (status, data) { return { status: status, json: async () => { if (data === undefined) throw new Error('no body'); return data; } }; };
    if (o.status) return reply(o.status, { code: 'X' });
    if (path === '/licenses/activate') {
      const product = o.keys[body.license_key];
      if (!product) return reply(404, { code: 'NOT_FOUND' });
      const used = Array.from(active.values()).filter((k) => k === body.license_key).length;
      if (used >= o.limit) return reply(422, { code: 'LIMIT' });
      const id = 'lki_' + (++seq);
      active.set(id, body.license_key);
      const answer = { id: id, business_id: 'bus_1', name: body.name, license_key_id: 'lic_1', created_at: '2026-11-12T00:00:00Z', customer: { customer_id: 'cus_1', name: 'Test Buyer', email: 'buyer@example.com', phone_number: null, metadata: {} } };
      if (!o.noProduct) answer.product = { product_id: product, name: 'Product' };
      return reply(201, answer);
    }
    if (path === '/licenses/validate') {
      if (o.validateStatus) return reply(o.validateStatus, { code: 'X' });
      return reply(200, { valid: o.invalid ? false : active.has(body.license_key_instance_id) });
    }
    if (path === '/licenses/deactivate') {
      if (o.noDeactivate) return reply(500, { code: 'X' });
      active.delete(body.license_key_instance_id);
      return reply(200, undefined);
    }
    return reply(404, {});
  }
  const count = function (suffix) { return calls.filter((c) => c.url.endsWith(suffix)).length; };
  return { fetch: fetch, calls: calls, active: active, options: o, count: count };
}

function make(opts) {
  const o = opts || {};
  const s = o.stores || stores();
  const srv = o.server || server();
  let t = o.start || Date.UTC(2026, 10, 12, 10, 0, 0);
  const lic = L.createLicence({ secrets: s.secrets, globalState: s.globalState, fetch: srv.fetch, now: () => t, getMode: () => o.mode || 'test', platform: 'win32' });
  return { lic: lic, s: s, srv: srv, advance: (ms) => { t += ms; }, now: () => t };
}

module.exports = { stores: stores, server: server, make: make };
