'use strict';

function boolEnv(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes)$/i.test(value);
}

function loadConfig(env = process.env, argv = process.argv) {
  const authMode = boolEnv(env.HF_AUTH) || argv.includes('--auth');
  const demoMode = !authMode;
  return {
    controlPort: Number(env.HF_CONTROL_PORT || (demoMode ? 18765 : 8765)),
    bindAddr: '127.0.0.1',
    backendBaseUrl: env.HF_BACKEND_BASE_URL || 'http://127.0.0.1:8787',
    tenant: env.HF_TENANT || 'healthfirst',
    saveLocal: boolEnv(env.HF_SAVE_LOCAL),
    demoMode,
  };
}

module.exports = { loadConfig };
