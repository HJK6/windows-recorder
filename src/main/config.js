'use strict';

/*
 * config.js — runtime configuration. The rejected localhost control server is
 * gone, so there are no listen ports. Instead the desktop is told where to make
 * its OUTBOUND connections:
 *   - FR_WS_URL        wss:// API Gateway WebSocket endpoint (control channel)
 *   - FR_HTTP_API_URL  https:// API Gateway HTTP API base (token + upload)
 *
 * Device enrollment material (FR_DEVICE_ID / FR_DEVICE_BOOTSTRAP_SECRET) is
 * supplied at launch and is NEVER baked into the packaged build or committed.
 *
 * When no WS/HTTP endpoints are configured the app runs in local demo mode:
 * the recorder is driven by the window's own buttons and saves locally. There
 * is still no network listener in either mode.
 */

function boolEnv(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes)$/i.test(value);
}

function loadConfig(env = process.env) {
  const wsUrl = env.FR_WS_URL || '';
  const httpApiUrl = env.FR_HTTP_API_URL || '';
  const connected = Boolean(wsUrl && httpApiUrl);
  return {
    wsUrl,
    httpApiUrl,
    tokenEndpoint: env.FR_TOKEN_ENDPOINT
      || (httpApiUrl ? `${httpApiUrl.replace(/\/$/, '')}/v1/auth/device-token` : ''),
    deviceId: env.FR_DEVICE_ID || 'poc-device-01',
    bootstrapSecret: env.FR_DEVICE_BOOTSTRAP_SECRET || '',
    tenant: env.FR_TENANT || 'poc',
    saveLocal: boolEnv(env.FR_SAVE_LOCAL),
    connected,
    demoMode: !connected,
  };
}

module.exports = { loadConfig };
