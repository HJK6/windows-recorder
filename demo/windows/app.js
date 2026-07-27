'use strict';

// Standalone demo console. Drives the desktop recorder over its loopback HTTP
// control API (request/response only — no WebSocket, no polling). Status is read
// once on load; the not-running banner clears on Retry or the next action.
const BASE = 'http://127.0.0.1:18765';
const actionIds = ['start', 'pause', 'resume', 'mute', 'unmute', 'stop'];
const buttons = Object.fromEntries(actionIds.map((id) => [id, document.getElementById(id)]));
const connection = document.getElementById('connection');
const recorder = document.getElementById('recorder');
const microphone = document.getElementById('microphone');
const message = document.getElementById('message');
const retry = document.getElementById('retry');

let state = null;
let reachable = false;

function setPill(element, className, text) {
  element.className = `pill ${className || ''}`.trim();
  element.querySelector('span:last-child').textContent = text;
}

function render() {
  const online = reachable && state && state.online;
  const status = state ? state.recorder : 'idle';
  const active = status === 'recording' || status === 'paused';
  const muted = Boolean(state && state.muted);

  setPill(connection, reachable ? 'connected' : '', reachable ? 'Recorder connected' : 'Recorder disconnected');
  setPill(recorder, active ? status : '', status === 'recording' ? 'Recording'
    : status === 'paused' ? 'Paused' : online ? 'Ready' : 'Waiting for recorder');
  microphone.textContent = muted ? 'Microphone muted' : 'Microphone ready';
  retry.hidden = reachable;

  buttons.start.disabled = !online || active;
  buttons.pause.disabled = !online || status !== 'recording';
  buttons.resume.disabled = !online || status !== 'paused';
  buttons.mute.disabled = !online || !active || muted;
  buttons.unmute.disabled = !online || !active || !muted;
  buttons.stop.disabled = !online || !active;
}

function showNotRunning() {
  reachable = false;
  state = null;
  message.textContent = 'HF Recorder is not running. Open it from the Start menu, then click Retry.';
  render();
}

const LABELS = { start: 'Record', pause: 'Pause', resume: 'Resume', mute: 'Mute', unmute: 'Unmute', stop: 'Stop' };

function activityText(action) {
  if (!state) return '';
  if (state.recorder === 'idle') return action === 'stop' ? 'Recording saved to Documents\\HFRecorder' : 'Ready.';
  if (state.recorder === 'paused') return 'Paused.';
  return state.muted ? 'Recording — microphone muted.' : 'Recording…';
}

async function call(method, path, action) {
  let res;
  try {
    res = await fetch(BASE + path, { method });
  } catch (_) {
    showNotRunning();
    return null;
  }
  const body = await res.json().catch(() => null);
  reachable = true;
  if (body && typeof body.recorder === 'string') {
    state = { recorder: body.recorder, muted: body.muted, online: body.online };
  }
  if (body && body.ok === false) {
    message.textContent = body.error ? body.error.message : `${LABELS[action] || 'Command'} failed`;
  } else if (action) {
    message.textContent = activityText(action);
  }
  render();
  return body;
}

function refreshStatus() {
  message.textContent = 'Checking the recorder…';
  call('GET', '/status').then((body) => {
    if (body) message.textContent = 'Connected. The desktop recorder is ready.';
  });
}

for (const action of actionIds) {
  buttons[action].onclick = () => call('POST', `/${action}`, action);
}
retry.onclick = refreshStatus;
render();
refreshStatus();
