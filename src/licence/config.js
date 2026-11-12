'use strict';
// Licence server settings, product ids, prices, the trial length and the support links: the one
// place where these values live. The extension only talks to the public licence endpoints of the
// payment provider, so no secret key is ever shipped.
//
// ALLOWED_PRODUCT_IDS lists, per environment, the products whose keys unlock Pro. A key of any
// other product of the same seller is refused when it is activated, and the activation made for
// the check is released again.
//
// The installed extension always uses the live environment. The test environment (host, checkout
// address and product ids) lives in ./test-environment.js, which is not part of the packaged
// extension: it exists only for a development host of the extension (see src/extension.js) and for
// the unit tests, and no setting or command can select it. Without that file every request for
// the test environment is answered with the live one. The release gate refuses to build a package
// while any product id is a placeholder or while the manifest offers a way to change the
// environment.

let testEnvironment = null;
try { testEnvironment = require('./test-environment'); } catch (e) { testEnvironment = null; }

const PRODUCTS = {
  live: { personal: 'pdt_0NrlyVvfLevuTEDqI9l53', business: 'pdt_0NrlydO9yqFrkNiBEKi1G' },
  test: testEnvironment ? testEnvironment.products : { personal: '', business: '' }
};

const ALLOWED_PRODUCT_IDS = Object.freeze({
  live: Object.freeze([PRODUCTS.live.personal, PRODUCTS.live.business]),
  test: Object.freeze(testEnvironment ? [PRODUCTS.test.personal, PRODUCTS.test.business] : [])
});

const PLACEHOLDER_IDS = Object.freeze(['PDT_PERSONAL_LIVE', 'PDT_BUSINESS_LIVE', 'PDT_PERSONAL_TEST', 'PDT_BUSINESS_TEST']);

const config = {
  productName: 'XSD Atlas',
  commandPrefix: 'xsdAtlas',
  mode: 'live',
  apiBaseTest: testEnvironment ? testEnvironment.apiBase : '',
  apiBaseLive: 'https://live.dodopayments.com',
  checkoutBaseTest: testEnvironment ? testEnvironment.checkoutBase : '',
  checkoutBaseLive: 'https://checkout.dodopayments.com/buy/',
  productIdLive: PRODUCTS.live.personal,
  productIdTest: PRODUCTS.test.personal,
  // True when the test environment is available (a development checkout, not a packaged copy).
  testEnvironmentAvailable: !!testEnvironment,
  products: PRODUCTS,

  // Length of the free Pro trial in days. Every message, document and test reads this value.
  trialDays: 14,
  // Days a validated licence keeps working while the licence server cannot be reached.
  graceDays: 14,
  // Hours a successful licence check is trusted before the server is asked again.
  cacheHours: 24,
  // Number of computers one key may be active on (set on the payment provider's product).
  activationLimit: 3,
  // One-time prices as shown in messages (the checkout page shows the final amount and taxes).
  priceText: 'USD 29',
  businessPriceText: 'USD 59 per user',
  // Largest number of users the Buy command accepts for one Business checkout.
  maxUsers: 100,
  businessSeatsText: 'One key per user: a purchase for N users gives N keys, each for up to 3 computers.',
  // Name of the payment provider and merchant of record, as shown in licence messages.
  providerName: 'Dodo Payments',

  // Support and documentation links. Never put a personal name or a private address here.
  supportEmail: '',
  issuesUrl: 'https://github.com/small-steps-studio/xsd-atlas/issues',
  docsUrl: 'https://github.com/small-steps-studio/xsd-atlas#readme',
  repositoryUrl: 'https://github.com/small-steps-studio/xsd-atlas',
  docsBaseUrl: 'https://github.com/small-steps-studio/xsd-atlas/blob/HEAD/docs/'
};

const TIERS = ['personal', 'business'];

/**
 * Settings and commands of a manifest that mention the licence environment or the test host.
 * A shippable manifest has none: the environment is never user-selectable.
 */
function environmentSwitches(manifest) {
  const found = [];
  const c = manifest && manifest.contributes;
  if (!c) return found;
  const re = /licen[cs]e.?(mode|env|environment|server)|test.?(mode|env|environment)|test\.dodopayments|sandbox/i;
  const props = c.configuration && c.configuration.properties ? c.configuration.properties : {};
  for (const k of Object.keys(props)) {
    if (re.test(k) || re.test(JSON.stringify(props[k]))) found.push('setting ' + k);
  }
  for (const cmd of c.commands || []) if (re.test(cmd.command || '') || re.test(cmd.title || '')) found.push('command ' + cmd.command);
  return found;
}

/**
 * Resolves the effective environment. `modeOverride` is 'test' only in a development host of the
 * extension and in tests; anything other than 'test' or 'live' falls back to the default mode.
 */
function resolve(modeOverride) {
  const mode = modeOf(modeOverride);
  if (mode === 'live') return { mode: mode, api: config.apiBaseLive, buyUrl: buyUrlFor(mode, 'personal', 1) };
  return { mode: mode, api: config.apiBaseTest, buyUrl: buyUrlFor(mode, 'personal', 1) };
}

function modeOf(modeOverride) {
  if (modeOverride === 'test') return testEnvironment ? 'test' : 'live';
  return modeOverride === 'live' ? 'live' : config.mode;
}

/** The product ids whose keys unlock Pro in the given environment. */
function allowedProductIds(modeOverride) { return ALLOWED_PRODUCT_IDS[modeOf(modeOverride)].slice(); }

/** 'personal' or 'business' for a product id of the given environment, or '' for any other id. */
function licenceTypeOf(modeOverride, productId) {
  if (typeof productId !== 'string' || !productId) return '';
  const set = PRODUCTS[modeOf(modeOverride)];
  for (const t of TIERS) if (set[t] === productId) return t;
  return '';
}

/**
 * The checkout link of a tier in the given environment. `users` (1 to maxUsers) is the quantity
 * of a Business purchase; a Personal purchase is always one licence. '' when the input is invalid.
 */
function buyUrlFor(modeOverride, tier, users) {
  const mode = modeOf(modeOverride);
  const id = PRODUCTS[mode][tier];
  if (typeof id !== 'string' || !id) return '';
  let quantity = 1;
  if (tier === 'business') {
    quantity = users;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > config.maxUsers) return '';
  }
  return (mode === 'live' ? config.checkoutBaseLive : config.checkoutBaseTest) + id + '?quantity=' + quantity;
}

/** The support contact in one phrase for messages. */
function supportContact() {
  return config.supportEmail ? config.supportEmail + ' or ' + config.issuesUrl : config.issuesUrl;
}

/** The product ids that are still placeholders (the release gate refuses to ship while any is). */
function placeholderIds() {
  const out = [];
  for (const env of testEnvironment ? ['live', 'test'] : ['live']) for (const t of TIERS) {
    const id = PRODUCTS[env][t];
    if (PLACEHOLDER_IDS.indexOf(id) !== -1 || !/^pdt_[A-Za-z0-9]{10,60}$/.test(id)) out.push(env + ' ' + t + ' (' + id + ')');
  }
  return out;
}

/**
 * Throws when this build must not be published. `options.allowPlaceholders` skips only the
 * placeholder product id rule (for a local test package that is never uploaded).
 */
function assertShippable(manifest, options) {
  const problems = [];
  const opts = options || {};
  if (config.mode !== 'live') problems.push('the default licence mode must be live');
  const switches = environmentSwitches(manifest);
  if (switches.length) problems.push('the manifest must not offer a way to select the licence environment: ' + switches.join(', '));
  if (!/^https:\/\//.test(config.apiBaseLive) || (testEnvironment && !/^https:\/\//.test(config.apiBaseTest))) problems.push('licence API base URLs must be https');
  if (config.apiBaseLive !== 'https://live.dodopayments.com') problems.push('the live licence host must be live.dodopayments.com');
  if (config.checkoutBaseLive !== 'https://checkout.dodopayments.com/buy/') problems.push('the live checkout base is wrong');
  if (!/^https:\/\//.test(config.issuesUrl) || !/^https:\/\//.test(config.docsUrl)) problems.push('support links must be https URLs');
  if (PRODUCTS.live.personal === PRODUCTS.live.business || (testEnvironment && PRODUCTS.test.personal === PRODUCTS.test.business)) problems.push('the Personal and Business products must be different');
  if (testEnvironment && (PRODUCTS.live.personal === PRODUCTS.test.personal || PRODUCTS.live.business === PRODUCTS.test.business)) problems.push('live and test product ids must differ');
  if (config.productIdLive !== PRODUCTS.live.personal || config.productIdTest !== PRODUCTS.test.personal) problems.push('productIdLive/productIdTest must be the Personal products');
  if (!opts.allowPlaceholders) {
    const ph = placeholderIds();
    if (ph.length) problems.push('product ids are still placeholders: ' + ph.join(', '));
  }
  if (!(config.trialDays >= 1 && config.trialDays <= 90)) problems.push('trialDays must be between 1 and 90');
  if (problems.length) throw new Error('Refusing to build: ' + problems.join('; '));
  return true;
}

module.exports = Object.assign(config, {
  resolve: resolve, environmentSwitches: environmentSwitches, allowedProductIds: allowedProductIds, licenceTypeOf: licenceTypeOf, buyUrlFor: buyUrlFor,
  supportContact: supportContact, placeholderIds: placeholderIds, assertShippable: assertShippable,
  ALLOWED_PRODUCT_IDS: ALLOWED_PRODUCT_IDS, PLACEHOLDER_IDS: PLACEHOLDER_IDS, TIERS: TIERS
});
