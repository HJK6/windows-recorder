'use strict';

const DEFAULT_ORIGINS = ['http://127.0.0.1:8788', 'http://localhost:8788'];

function boolEnv(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes)$/i.test(value);
}

function loadConfig(env = process.env) {
  return {
    controlPort: Number(env.HF_CONTROL_PORT || 8765),
    bindAddr: '127.0.0.1',
    allowedOrigins: (env.HF_ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(','))
      .split(',').map((value) => value.trim()).filter(Boolean),
    backendBaseUrl: env.HF_BACKEND_BASE_URL || 'http://127.0.0.1:8787',
    tenant: env.HF_TENANT || 'healthfirst',
    saveLocal: boolEnv(env.HF_SAVE_LOCAL),
  };
}

module.exports = { DEFAULT_ORIGINS, loadConfig };
