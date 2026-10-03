'use strict';

/*
 * app-page.js — the POC browser control page (P3). Served over HTTPS, SAME
 * ORIGIN as the control API (GET /app on the HTTP API), so there is no CORS and
 * no local web server on the workstation. It makes exactly the calls a future
 * Twilio Flex plugin would make. It shows a CONFIRMED state only from the
 * desktop's applied acknowledgment (observedState), never optimistically.
 *
 * The control token is minted server-side and injected here; a text field lets
 * you paste an arbitrary token to exercise the authorization-denial path.
 */

function escapeJson(s) {
  return String(s).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function renderAppPage({ apiBase, controlToken = '' }) {
  const cfg = escapeJson(JSON.stringify({ apiBase, controlToken }));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fleet Recorder — POC control</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 640px; color: #111; }
  h1 { font-size: 1.2rem; }
  button { font-size: 1rem; padding: .5rem 1rem; margin: .25rem; cursor: pointer; }
  button:disabled { opacity: .4; cursor: not-allowed; }
  .state { font-size: 1.4rem; font-weight: 600; padding: .5rem 0; }
  .row { margin: .75rem 0; }
  .muted { color: #666; font-size: .85rem; }
  code { background: #f3f3f3; padding: .1rem .3rem; border-radius: 3px; }
  textarea { width: 100%; height: 3rem; font-family: monospace; }
  .confirmed { color: #0a7d2c; } .pending { color: #b26a00; } .error { color: #b00020; }
</style>
</head>
<body>
  <h1>AWS Fleet Recorder — POC control</h1>
  <p class="muted">Browser → AWS HTTPS → WebSocket → desktop recorder. The confirmed
  state below reflects the desktop's <em>applied acknowledgment</em> only.</p>

  <div class="row">
    <button id="start">Start</button>
    <button id="pause" disabled>Pause</button>
    <button id="resume" disabled>Resume</button>
    <button id="stop" disabled>Stop</button>
  </div>

  <div class="row">
    <div>Requested: <span id="desired" class="pending">—</span></div>
    <div class="state">Confirmed: <span id="observed">—</span></div>
    <div class="muted">recordingId <code id="recid">—</code> · revision <span id="rev">—</span>
      · device <span id="device">unknown</span></div>
    <div id="msg" class="muted"></div>
  </div>

  <div class="row">
    <div class="muted">Override control token (for denial testing — leave blank to use the issued token):</div>
    <textarea id="token" placeholder="paste a token to force a 401/403"></textarea>
  </div>

<script>
  var CFG = JSON.parse(${JSON.stringify(cfg)});
  var apiBase = CFG.apiBase.replace(/\\/$/, '');
  var recordingId = null;
  var el = function (id) { return document.getElementById(id); };
  function authToken() { return (el('token').value.trim() || CFG.controlToken); }
  function headers() { return { 'content-type': 'application/json', authorization: 'Bearer ' + authToken() }; }
  function setMsg(text, cls) { el('msg').textContent = text || ''; el('msg').className = cls || 'muted'; }

  async function post(path, body) {
    var res = await fetch(apiBase + path, { method: 'POST', headers: headers(), body: JSON.stringify(body || {}) });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) { setMsg('Denied (' + res.status + '): ' + (data.error || res.statusText), 'error'); throw new Error(data.error || res.status); }
    setMsg('Accepted: ' + path, 'muted');
    return data;
  }

  el('start').onclick = async function () {
    try { var r = await post('/v1/recordings', {}); recordingId = r.recordingId; el('recid').textContent = recordingId; } catch (e) {}
  };
  el('pause').onclick = function () { if (recordingId) post('/v1/recordings/' + recordingId + '/pause', {}).catch(function(){}); };
  el('resume').onclick = function () { if (recordingId) post('/v1/recordings/' + recordingId + '/resume', {}).catch(function(){}); };
  el('stop').onclick = function () { if (recordingId) post('/v1/recordings/' + recordingId + '/stop', {}).catch(function(){}); };

  function applyStatus(s) {
    el('desired').textContent = s.desiredState || '—';
    var observed = s.observedState || 'UNCONFIRMED';
    el('observed').textContent = observed;
    el('observed').className = (observed === 'RECORDING' || observed === 'PAUSED' || observed === 'IDLE') ? 'confirmed' : 'pending';
    el('rev').textContent = s.revision != null ? s.revision : '—';
    el('device').textContent = s.deviceOnline ? 'online' : 'offline';
    // Buttons gate on the CONFIRMED (observed) state, not the request.
    el('pause').disabled = observed !== 'RECORDING';
    el('resume').disabled = observed !== 'PAUSED';
    el('stop').disabled = !(observed === 'RECORDING' || observed === 'PAUSED');
    el('start').disabled = observed === 'RECORDING' || observed === 'PAUSED';
  }

  async function poll() {
    try {
      var url = apiBase + '/v1/recorder/status' + (recordingId ? ('?recordingId=' + encodeURIComponent(recordingId)) : '');
      var res = await fetch(url, { headers: headers() });
      if (!res.ok) { return; }
      applyStatus(await res.json());
    } catch (e) { /* transient */ }
  }
  setInterval(poll, 1000);
  poll();
</script>
</body>
</html>`;
}

module.exports = { renderAppPage };
