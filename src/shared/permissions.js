/*
 * permissions.js — pure, testable permission logic for the main process.
 *
 * Kept free of Electron so the grant decision and the Windows mic-consent
 * interpretation are unit-tested in plain Node. main.js supplies the real
 * session + `reg query` output; this module makes the decisions.
 */
(function () {
  'use strict';

  // Only these two Chromium permissions are ever granted, and only to our app.
  const CAPTURE_PERMISSIONS = ['media', 'display-capture'];

  function isSameOrigin(url, appOrigin) {
    if (!url || !appOrigin) return false;
    return String(url).startsWith(appOrigin);
  }

  // Grant a capture permission only for our own (file://) origin. Anything else
  // — a different permission, or a remote/unknown origin — is denied.
  function shouldGrantCapture(permission, requestingUrl, appOrigin) {
    if (!CAPTURE_PERMISSIONS.includes(permission)) return false;
    if (!appOrigin) return true; // origin unknown on this Electron build: allow capture perms
    return isSameOrigin(requestingUrl, appOrigin);
  }

  // Parse a `reg query <key> /v Value` stdout blob -> 'Allow' | 'Deny' | 'unknown'.
  function parseConsentValue(regStdout) {
    const m = /Value\s+REG_SZ\s+(\w+)/i.exec(regStdout || '');
    return m ? m[1] : 'unknown';
  }

  // A desktop (unpackaged) app's microphone access is gated by BOTH the global
  // consent (microphone\Value) AND the "let desktop apps access" consent
  // (microphone\NonPackaged\Value). Either 'Deny' => denied; access is 'Allow'
  // only when both allow; otherwise 'unknown' (probe couldn't determine).
  function effectiveMicConsent(globalValue, nonPackagedValue) {
    if (globalValue === 'Deny' || nonPackagedValue === 'Deny') return 'Deny';
    if (globalValue === 'Allow' && nonPackagedValue === 'Allow') return 'Allow';
    return 'unknown';
  }

  const api = {
    CAPTURE_PERMISSIONS,
    isSameOrigin,
    shouldGrantCapture,
    parseConsentValue,
    effectiveMicConsent,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Permissions = api;
})();
