'use strict';

/*
 * identity.js — the desktop sign-in sits behind this narrow IdentityProvider
 * interface so the POC mock IdP can be swapped for a real corporate SSO / Twilio
 * Flex validator with no change to the WS client.
 *
 *   IdentityProvider = {
 *     getDeviceToken() -> Promise<{ token, expiresAt }>   // scoped, short-lived
 *     reset()                                             // drop the cache
 *   }
 *
 * The mock provider authenticates the device to the HTTPS token endpoint using
 * device-scoped enrollment material (a bootstrap secret provisioned at install /
 * launch — NEVER baked into the packaged build or the public repo), and receives
 * a signed, expiring, `device`-scoped token. It is not an accept-any acceptor;
 * an invalid secret fails closed at the server.
 */

// Refresh a little before expiry so an in-flight reconnect always has a live
// token (spec §3.2: refresh with jitter before expiration).
const REFRESH_SKEW_MS = 60 * 1000;

function createMockIdentity({
  tokenEndpoint,
  deviceId,
  bootstrapSecret,
  fetchImpl = globalThis.fetch,
  now = Date.now,
}) {
  if (!tokenEndpoint) throw new Error('tokenEndpoint required');
  if (!deviceId) throw new Error('deviceId required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation required');

  let cached = null; // { token, expiresAtMs }
  let inflight = null;

  async function fetchToken() {
    const res = await fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId, bootstrapSecret, scope: 'device' }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.token) {
      const err = new Error(payload.error || `device auth failed: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const expiresAtMs = payload.expiresAt ? Date.parse(payload.expiresAt) : now() + 15 * 60 * 1000;
    cached = { token: payload.token, expiresAtMs };
    return cached;
  }

  async function getDeviceToken() {
    if (cached && cached.expiresAtMs - now() > REFRESH_SKEW_MS) {
      return { token: cached.token, expiresAt: new Date(cached.expiresAtMs).toISOString() };
    }
    if (!inflight) {
      inflight = fetchToken().finally(() => { inflight = null; });
    }
    const fresh = await inflight;
    return { token: fresh.token, expiresAt: new Date(fresh.expiresAtMs).toISOString() };
  }

  return {
    getDeviceToken,
    reset() { cached = null; },
    get deviceId() { return deviceId; },
  };
}

// Test/offline helper: a provider that returns a fixed token (or a factory),
// used by unit tests that drive the WS client without a live token endpoint.
function createStaticIdentity(tokenOrFn, { deviceId = 'test-device', expiresAt = null } = {}) {
  return {
    async getDeviceToken() {
      const token = typeof tokenOrFn === 'function' ? await tokenOrFn() : tokenOrFn;
      return { token, expiresAt };
    },
    reset() {},
    get deviceId() { return deviceId; },
  };
}

module.exports = { createMockIdentity, createStaticIdentity };
