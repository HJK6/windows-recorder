'use strict';

const DEFAULT_ORIGINS = ['http://127.0.0.1:8788', 'http://localhost:8788'];

function boolEnv(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes)$/i.test(value);
}

function loadConfig(env = process.env, argv = process.argv) {
  const demoMode = boolEnv(env.HF_DEMO) || argv.includes('--demo');
  const demoSitePort = Number(env.HF_DEMO_SITE_PORT || 8788);
  const defaultOrigins = demoMode
    ? [`http://127.0.0.1:${demoSitePort}`, `http://localhost:${demoSitePort}`]
    : DEFAULT_ORIGINS;
  return {
    controlPort: Number(env.HF_CONTROL_PORT || (demoMode ? 18765 : 8765)),
    bindAddr: '127.0.0.1',
    allowedOrigins: (env.HF_ALLOWED_ORIGINS || defaultOrigins.join(','))
      .split(',').map((value) => value.trim()).filter(Boolean),
    backendBaseUrl: env.HF_BACKEND_BASE_URL || 'http://127.0.0.1:8787',
    tenant: env.HF_TENANT || 'healthfirst',
    saveLocal: boolEnv(env.HF_SAVE_LOCAL),
    demoMode,
    demoSitePort,
  };
}

module.exports = { DEFAULT_ORIGINS, loadConfig };
