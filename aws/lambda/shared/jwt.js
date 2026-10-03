/*
 * jwt.js — minimal HS256 JSON Web Token sign/verify using only Node's built-in
 * crypto. No external dependency. Used by the mock IdP (test + Lambda) to mint
 * short-lived, scoped, signed tokens and by validators to fail closed.
 *
 * This is a POC stand-in for a real corporate SSO / Twilio Flex token validator
 * (swapped in behind the IdentityProvider interface). It is NOT an accept-any
 * acceptor: every token is signature-checked and expiry-checked.
 *
 * Dual-module: require() in Node (main process, tests, Lambda copy).
 */
(function () {
  'use strict';

  const nodeCrypto = (typeof require === 'function') ? require('node:crypto') : null;

  function b64url(input) {
    return Buffer.from(input).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlJson(obj) { return b64url(JSON.stringify(obj)); }
  function fromB64url(str) {
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }

  function hmac(secret, data) {
    return nodeCrypto.createHmac('sha256', secret).update(data).digest();
  }

  // sign(payload, secret, { expiresInSec }) -> compact JWT string.
  function sign(payload, secret, { expiresInSec = 900, now = Date.now } = {}) {
    if (!secret) throw new Error('jwt secret required');
    const iat = Math.floor(now() / 1000);
    const body = { iat, exp: iat + expiresInSec, ...payload };
    const header = b64urlJson({ alg: 'HS256', typ: 'JWT' });
    const claims = b64urlJson(body);
    const signingInput = `${header}.${claims}`;
    const sig = b64url(hmac(secret, signingInput));
    return `${signingInput}.${sig}`;
  }

  // verify(token, secret, { now }) -> { valid, payload?, reason? }. Fail-closed.
  function verify(token, secret, { now = Date.now } = {}) {
    if (!secret) return { valid: false, reason: 'no_secret' };
    if (typeof token !== 'string' || token.length === 0) return { valid: false, reason: 'missing' };
    const parts = token.split('.');
    if (parts.length !== 3) return { valid: false, reason: 'malformed' };
    const [header, claims, sig] = parts;
    const expected = b64url(hmac(secret, `${header}.${claims}`));
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !nodeCrypto.timingSafeEqual(a, b)) {
      return { valid: false, reason: 'bad_signature' };
    }
    let payload;
    try { payload = JSON.parse(fromB64url(claims).toString('utf8')); } catch (_) {
      return { valid: false, reason: 'bad_claims' };
    }
    const nowSec = Math.floor(now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
      return { valid: false, reason: 'expired' };
    }
    return { valid: true, payload };
  }

  // hasScope(payload, required) — space- or array-delimited scope claim.
  function hasScope(payload, required) {
    if (!payload || !payload.scope) return false;
    const scopes = Array.isArray(payload.scope) ? payload.scope : String(payload.scope).split(/\s+/);
    return scopes.includes(required);
  }

  const api = { sign, verify, hasScope, b64url };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.FleetJwt = api;
})();
