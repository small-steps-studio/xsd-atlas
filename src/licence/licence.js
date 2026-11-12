'use strict';
// Licence handling for the Pro tier. Only the public licence endpoints are used:
//   POST /licenses/activate    { license_key, name }                       -> 201 { id, product: { product_id, name }, customer: {...}, ... }
//   POST /licenses/validate    { license_key, license_key_instance_id }    -> 200 { valid }
//   POST /licenses/deactivate  { license_key, license_key_instance_id }    -> 200, empty body
// The key lives in the editor's secret storage; the activation id, the product id and the times
// of the last checks live in global state. A successful validation is trusted for 24 hours; when
// the server cannot be reached, the last successful validation keeps Pro working for 14 days.
//
// A key only unlocks Pro when the activation answer names one of the products in
// config.ALLOWED_PRODUCT_IDS (the validation answer carries only `valid`). Nothing else of the
// activation answer is kept: not the customer block, not the buyer's name or e-mail address.
//
// The free trial lives here too. It is recorded only in the editor's global state of this machine
// (start time, last use, last reminder), never sent anywhere, and needs no key and no network.
// It starts when the user first runs a Pro feature, not at install.
//
// No editor API is used: storage and the network function are injected (unit-testable).

const config = require('./config');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CACHE_MS = config.cacheHours * HOUR_MS;
const GRACE_MS = config.graceDays * DAY_MS;
const TRIAL_MS = config.trialDays * DAY_MS;
const REMINDER_MS = DAY_MS;
const RETRY_BACKOFF_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_KEY_LENGTH = 256;

const TRIAL_KEYS = Object.freeze({ startedAt: 'trial.startedAt', lastSeenAt: 'trial.lastSeenAt', lastNoticeAt: 'trial.lastNoticeAt', expiredAt: 'trial.expiredAt' });

function platformLabel(platform) {
  switch (platform) {
    case 'win32': return 'Windows';
    case 'darwin': return 'macOS';
    case 'linux': return 'Linux';
    default: return String(platform || 'unknown');
  }
}

/** The label sent as the activation name: `VS Code on <platform>` (never the host name). */
function instanceName(platform) { return 'VS Code on ' + platformLabel(platform); }

function asTime(value) { return typeof value === 'number' && isFinite(value) ? value : 0; }

/**
 * Creates the licence service. Options: secrets (async get/store/delete), globalState
 * (get/update), fetch, now, getMode, platform. The methods never throw.
 */
function createLicence(options) {
  const secrets = options.secrets;
  const state = options.globalState;
  const now = options.now || Date.now;
  const getMode = options.getMode || function () { return undefined; };
  const platform = options.platform || process.platform;
  let inflight = null;
  let retryNotBefore = 0;

  function env() { return config.resolve(getMode()); }
  function names() {
    const mode = env().mode;
    return {
      key: 'licence.key.' + mode, instance: 'licence.instanceId.' + mode, product: 'licence.productId.' + mode,
      checkedAt: 'licence.checkedAt.' + mode, checkedValid: 'licence.checkedValid.' + mode, lastGood: 'licence.lastGoodAt.' + mode
    };
  }

  async function post(path, body) {
    const fetchImpl = options.fetch || (typeof fetch === 'function' ? fetch : null);
    if (typeof fetchImpl !== 'function') return { status: 0, data: null, networkError: true };
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;
    try {
      const res = await fetchImpl(env().api + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined
      });
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      return { status: res.status, data: data };
    } catch (e) {
      return { status: 0, data: null, networkError: true };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function evaluate(force) {
    const n = names();
    let key;
    try { key = await secrets.get(n.key); } catch (e) { key = undefined; }
    const instanceId = state.get(n.instance);
    const mode = env().mode;
    if (typeof key !== 'string' || !key || typeof instanceId !== 'string' || !instanceId) return { pro: false, via: 'none', mode: mode, hasKey: typeof key === 'string' && !!key };
    const licenceType = config.licenceTypeOf(mode, state.get(n.product));
    if (!licenceType) return { pro: false, via: 'product', mode: mode, hasKey: true, key: key };
    const t = now();
    const lastGoodAt = asTime(state.get(n.lastGood));
    const checkedAt = asTime(state.get(n.checkedAt));
    const age = t - checkedAt;
    if (!force && checkedAt && age >= 0 && age < CACHE_MS) {
      const cachedValid = state.get(n.checkedValid) === true;
      return { pro: cachedValid, via: cachedValid ? 'cache' : 'rejected', mode: mode, hasKey: true, licenceType: licenceType, lastGoodAt: lastGoodAt, checkedAt: checkedAt, key: key };
    }
    let result = null;
    if (force || t >= retryNotBefore) result = await post('/licenses/validate', { license_key: key, license_key_instance_id: instanceId });
    if (result && result.status === 200 && result.data && typeof result.data.valid === 'boolean') {
      retryNotBefore = 0;
      await state.update(n.checkedAt, t);
      await state.update(n.checkedValid, result.data.valid);
      if (result.data.valid) {
        await state.update(n.lastGood, t);
        return { pro: true, via: 'server', mode: mode, hasKey: true, licenceType: licenceType, lastGoodAt: t, checkedAt: t, key: key };
      }
      // A key the server rejected must not come back through the offline grace period.
      await state.update(n.lastGood, undefined);
      return { pro: false, via: 'rejected', mode: mode, hasKey: true, licenceType: licenceType, lastGoodAt: 0, checkedAt: t, key: key };
    }
    if (result && (result.status === 403 || result.status === 404 || result.status === 422)) {
      retryNotBefore = 0;
      await state.update(n.checkedAt, t);
      await state.update(n.checkedValid, false);
      await state.update(n.lastGood, undefined);
      return { pro: false, via: 'rejected', mode: mode, hasKey: true, licenceType: licenceType, lastGoodAt: 0, checkedAt: t, key: key };
    }
    if (result) retryNotBefore = t + RETRY_BACKOFF_MS;
    if (state.get(n.checkedValid) === false) {
      // The last answer of the server was a rejection; an unreachable server does not change that.
      return { pro: false, via: 'rejected', mode: mode, hasKey: true, licenceType: licenceType, lastGoodAt: 0, checkedAt: checkedAt, key: key };
    }
    const graceAge = t - lastGoodAt;
    if (lastGoodAt && graceAge >= 0 && graceAge < GRACE_MS) {
      return { pro: true, via: 'grace', mode: mode, hasKey: true, licenceType: licenceType, lastGoodAt: lastGoodAt, graceEndsAt: lastGoodAt + GRACE_MS, key: key };
    }
    return { pro: false, via: 'expired', mode: mode, hasKey: true, licenceType: licenceType, lastGoodAt: lastGoodAt, key: key };
  }

  /** True when a valid licence is active (cached 24 h, shared in-flight check, 14-day grace). */
  function isPro() {
    if (inflight) return inflight;
    inflight = evaluate(false).then(function (r) { return r.pro === true; }, function () { return false; })
      .then(function (value) { inflight = null; return value; });
    return inflight;
  }

  /** Detailed state for Show Licence Status; `force` asks the server now. The key is never returned in full. */
  async function status(force) {
    let r;
    try { r = await evaluate(force === true); } catch (e) { r = { pro: false, via: 'none', mode: env().mode, hasKey: false }; }
    return {
      pro: r.pro, via: r.via, mode: r.mode, hasKey: r.hasKey, lastGoodAt: r.lastGoodAt || 0, graceEndsAt: r.graceEndsAt || 0,
      keyHint: r.key ? '...' + r.key.slice(-4) : '', licenceType: r.licenceType || '', trial: trialStatus()
    };
  }

  // Gives an activation back; true only when the server confirmed it.
  async function release(key, instanceId) {
    const r = await post('/licenses/deactivate', { license_key: key, license_key_instance_id: instanceId });
    return r.status === 200 || r.status === 201 || r.status === 204;
  }

  async function forget(n) {
    try { await secrets.delete(n.key); } catch (e) { /* nothing stored */ }
    for (const k of [n.instance, n.product, n.checkedAt, n.checkedValid, n.lastGood]) {
      try { await state.update(k, undefined); } catch (e) { /* read-only state */ }
    }
  }

  /**
   * Activates a key on this machine. Resolves to { ok: true, licenceType, already?, replaced?,
   * previousReleased? } or { ok: false, reason, released?, replaced?, previousReleased?,
   * nothingUsed? } with reason invalid | inactive | limit | network | storage | product |
   * unverified | error. `released` says whether the server confirmed that an activation made for
   * the check was given back.
   *
   * An activation is made only when one is needed, so that entering a key again never uses up
   * another seat:
   *   - the key that is already active here is validated instead (`already: true`);
   *   - an activation id that is stored without its key (an editor that lost its secrets) is tried
   *     with the entered key first;
   *   - another key replaces the stored one: once the new key is active and accepted, the seat of
   *     the old key is released first (`previousReleased`), then the new values are stored. A key
   *     that is refused leaves the stored licence as it was.
   */
  async function activate(rawKey) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!key || key.length > MAX_KEY_LENGTH || /\s/.test(key)) return { ok: false, reason: 'invalid' };
    const n = names();
    const mode = env().mode;
    let oldKey;
    try { oldKey = await secrets.get(n.key); } catch (e) { oldKey = undefined; }
    if (typeof oldKey !== 'string' || !oldKey) oldKey = undefined;
    let oldInstance = state.get(n.instance);
    if (typeof oldInstance !== 'string' || !oldInstance) oldInstance = undefined;
    const oldType = config.licenceTypeOf(mode, state.get(n.product));
    const oldValues = [n.instance, n.product, n.checkedAt, n.checkedValid, n.lastGood].map(function (k) { return [k, state.get(k)]; });

    // The stored activation may belong to this key: ask the server instead of activating again.
    if (oldInstance && oldType && (oldKey === key || !oldKey)) {
      const v = await post('/licenses/validate', { license_key: key, license_key_instance_id: oldInstance });
      if (v.status === 200 && v.data && v.data.valid === true) {
        const t = now();
        if (!oldKey) {
          try { await secrets.store(n.key, key); } catch (e) { return { ok: false, reason: 'storage', nothingUsed: true }; }
        }
        try {
          await state.update(n.checkedAt, t);
          await state.update(n.checkedValid, true);
          await state.update(n.lastGood, t);
        } catch (e) { /* the stored activation stays valid; the next check asks the server again */ }
        retryNotBefore = 0;
        return { ok: true, licenceType: oldType, already: true };
      }
      const answered = (v.status === 200 && v.data && v.data.valid === false) || v.status === 403 || v.status === 404 || v.status === 422;
      // No clear answer: do not risk a second seat; nothing is changed.
      if (!answered) return v.networkError ? { ok: false, reason: 'network' } : { ok: false, reason: 'error', status: v.status };
      // The server no longer knows that activation for this key, so there is nothing to release.
      // When the key itself was lost, the activation may belong to another key: its release is
      // still tried below.
      if (oldKey === key) oldInstance = undefined;
    }

    const r = await post('/licenses/activate', { license_key: key, name: instanceName(platform) });
    if ((r.status === 200 || r.status === 201) && r.data && typeof r.data.id === 'string' && r.data.id) {
      const t = now();
      const product = r.data.product;
      const productId = product && typeof product === 'object' && typeof product.product_id === 'string' ? product.product_id : '';
      const licenceType = config.licenceTypeOf(mode, productId);
      if (!licenceType) {
        // A key of another product, or an answer without a product: give the activation back.
        // The stored licence is not touched.
        const released = await release(key, r.data.id);
        return { ok: false, reason: productId ? 'product' : 'unverified', released: released };
      }
      // A licence that is replaced gives its seat back first, while its activation id is known.
      const replaced = !!oldInstance && oldInstance !== r.data.id;
      let previousReleased;
      if (replaced) previousReleased = await release(oldKey || key, oldInstance);
      try {
        await secrets.store(n.key, key);
        await state.update(n.instance, r.data.id);
        await state.update(n.product, productId);
        await state.update(n.checkedAt, t);
        await state.update(n.checkedValid, true);
        await state.update(n.lastGood, t);
      } catch (e) {
        // Nothing usable can be kept on this machine: the new activation is given back.
        const released = await release(key, r.data.id);
        if (replaced && previousReleased === false) {
          // The old licence may still be active: put its values back as they were.
          if (oldKey) { try { await secrets.store(n.key, oldKey); } catch (e2) { /* left as it is */ } }
          for (const [k, v] of oldValues) { try { await state.update(k, v); } catch (e2) { /* left as it is */ } }
        } else {
          // No licence before, or its seat was given back: nothing usable is left stored.
          await forget(n);
        }
        const failed = { ok: false, reason: 'storage', released: released };
        if (replaced) { failed.replaced = true; failed.previousReleased = previousReleased; }
        return failed;
      }
      retryNotBefore = 0;
      const result = { ok: true, licenceType: licenceType };
      if (replaced) { result.replaced = true; result.previousReleased = previousReleased; }
      return result;
    }
    if (r.networkError) return { ok: false, reason: 'network' };
    if (r.status === 422) return { ok: false, reason: 'limit' };
    if (r.status === 403) return { ok: false, reason: 'inactive' };
    if (r.status === 404 || r.status === 400) return { ok: false, reason: 'invalid' };
    return { ok: false, reason: 'error', status: r.status };
  }

  /** Removes the licence: frees the activation (best effort) and always clears the local key and state. */
  async function remove() {
    const n = names();
    let deactivated = false;
    try {
      const key = await secrets.get(n.key);
      const instanceId = state.get(n.instance);
      if (key && instanceId) deactivated = await release(key, instanceId);
      else deactivated = true;
    } catch (e) { deactivated = false; }
    try { await secrets.delete(n.key); } catch (e) { /* nothing stored */ }
    for (const k of [n.instance, n.product, n.checkedAt, n.checkedValid, n.lastGood]) {
      try { await state.update(k, undefined); } catch (e) { /* read-only state */ }
    }
    retryNotBefore = 0;
    return { ok: true, deactivated: deactivated };
  }

  /** Checkout link: Personal without arguments; tier 'business' with users (1-100). */
  function buyUrl(tier, users) {
    if (tier === undefined) return env().buyUrl;
    return config.buyUrlFor(env().mode, tier, users);
  }

  // ---- trial --------------------------------------------------------------------------------

  function trialNow() { return Math.max(now(), asTime(state.get(TRIAL_KEYS.lastSeenAt))); }

  /**
   * { state: unused | active | expired, startedAt, endsAt, daysLeft, lastNoticeAt } without side
   * effects. A trial that was once seen as ended stays ended (trial.expiredAt), and a start time
   * more than a day in the future (an edited record) counts as an ended trial.
   */
  function trialStatus() {
    const startedAt = asTime(state.get(TRIAL_KEYS.startedAt));
    const lastNoticeAt = asTime(state.get(TRIAL_KEYS.lastNoticeAt));
    if (!startedAt) return { state: 'unused', startedAt: 0, endsAt: 0, daysLeft: config.trialDays, lastNoticeAt: lastNoticeAt };
    const endsAt = startedAt + TRIAL_MS;
    const t = trialNow();
    const expiredAt = asTime(state.get(TRIAL_KEYS.expiredAt));
    const future = startedAt > now() + DAY_MS;
    if (expiredAt || future || t >= endsAt) {
      const shownEnd = future ? now() : expiredAt ? Math.min(endsAt, expiredAt) : endsAt;
      return { state: 'expired', startedAt: startedAt, endsAt: shownEnd, daysLeft: 0, lastNoticeAt: lastNoticeAt };
    }
    const daysLeft = Math.min(config.trialDays, Math.max(1, Math.ceil((endsAt - t) / DAY_MS)));
    return { state: 'active', startedAt: startedAt, endsAt: endsAt, daysLeft: daysLeft, lastNoticeAt: lastNoticeAt };
  }

  /** Starts the trial when it was never started; { state: 'unavailable' } when storage refuses. */
  async function startTrial() {
    const current = trialStatus();
    if (current.state !== 'unused') return current;
    const t = now();
    try {
      await state.update(TRIAL_KEYS.startedAt, t);
      await state.update(TRIAL_KEYS.lastSeenAt, t);
    } catch (e) {
      try { await state.update(TRIAL_KEYS.startedAt, undefined); } catch (e2) { /* nothing stored */ }
      return { state: 'unavailable', startedAt: 0, endsAt: 0, daysLeft: 0, lastNoticeAt: 0 };
    }
    return trialStatus();
  }

  /** Records a use of the trial (keeps the trial clock from running backwards). Never throws. */
  async function touchTrial() {
    if (!asTime(state.get(TRIAL_KEYS.startedAt))) return;
    const t = now();
    if (t > asTime(state.get(TRIAL_KEYS.lastSeenAt))) {
      try { await state.update(TRIAL_KEYS.lastSeenAt, t); } catch (e) { /* read-only state */ }
    }
    await recordTrialEnd();
  }

  /** Records the end of the trial once it is seen, so that a clock set back later cannot reopen it. */
  async function recordTrialEnd() {
    const st = trialStatus();
    if (st.state === 'expired' && !asTime(state.get(TRIAL_KEYS.expiredAt))) {
      try { await state.update(TRIAL_KEYS.expiredAt, Math.max(1, Math.min(st.endsAt, trialNow()))); } catch (e) { /* read-only state */ }
    }
    return trialStatus();
  }

  /** Trial status after recording the last use and, when it has ended, the end. Never throws. */
  async function checkTrial() {
    try { await touchTrial(); } catch (e) { /* read-only state */ }
    return trialStatus();
  }

  /** True when a trial reminder may be shown now (at most one a day); records it. */
  async function noteTrialReminder() {
    const t = now();
    const last = asTime(state.get(TRIAL_KEYS.lastNoticeAt));
    if (last && t - last < REMINDER_MS && t >= last) return false;
    try { await state.update(TRIAL_KEYS.lastNoticeAt, t); } catch (e) { /* read-only state */ }
    return true;
  }

  /** True when Pro may be used now: a valid licence or an active trial. Never starts the trial. */
  async function hasAccess() {
    if (await isPro()) return true;
    return (await checkTrial()).state === 'active';
  }

  return { isPro: isPro, hasAccess: hasAccess, status: status, activate: activate, remove: remove, buyUrl: buyUrl, trialStatus: trialStatus, startTrial: startTrial, touchTrial: touchTrial, checkTrial: checkTrial, noteTrialReminder: noteTrialReminder };
}

module.exports = { createLicence: createLicence, instanceName: instanceName, platformLabel: platformLabel, CACHE_MS: CACHE_MS, GRACE_MS: GRACE_MS, TRIAL_MS: TRIAL_MS, TRIAL_KEYS: TRIAL_KEYS };
