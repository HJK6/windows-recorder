'use strict';

const actionIds = ['start', 'pause', 'resume', 'mute', 'unmute', 'stop'];
const buttons = Object.fromEntries(actionIds.map((id) => [id, document.getElementById(id)]));
const connection = document.getElementById('connection');
const recorder = document.getElementById('recorder');
const microphone = document.getElementById('microphone');
const message = document.getElementById('message');
let socket = null;
let state = null;
let reconnectTimer = null;

function requestId() {
  return window.crypto && window.crypto.randomUUID
    ? window.crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function setPill(element, className, text) {
  element.className = `pill ${className || ''}`.trim();
  element.querySelector('span:last-child').textContent = text;
}

function render() {
  const open = socket && socket.readyState === WebSocket.OPEN;
  const online = open && state && state.session === 'online';
  const status = state && state.recorder ? state.recorder.status : 'idle';
  const active = status === 'recording' || status === 'paused';
  const muted = Boolean(state && state.recorder && state.recorder.muted);

  setPill(connection, open ? 'connected' : '', open ? 'Recorder connected' : 'Recorder disconnected');
  setPill(recorder, active ? status : '', status === 'recording' ? 'Recording'
    : status === 'paused' ? 'Paused' : online ? 'Ready' : 'Waiting for recorder');
  microphone.textContent = muted ? 'Microphone muted' : 'Microphone ready';

  buttons.start.disabled = !online || active;
  buttons.pause.disabled = !online || status !== 'recording';
  buttons.resume.disabled = !online || status !== 'paused';
  buttons.mute.disabled = !online || !active || muted;
  buttons.unmute.disabled = !online || !active || !muted;
  buttons.stop.disabled = !online || !active;
}

function send(action) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ v: 1, type: 'command', action, requestId: requestId() }));
  message.textContent = `${buttons[action].textContent.trim()} requested…`;
}

function connect() {
  clearTimeout(reconnectTimer);
  const controlPort = window.HF_DEMO_CONFIG && window.HF_DEMO_CONFIG.controlPort;
  socket = new WebSocket(`ws://127.0.0.1:${controlPort || 18765}`);
  socket.onopen = () => {
    message.textContent = 'Connected. The desktop recorder is ready.';
    socket.send(JSON.stringify({ v: 1, type: 'status', requestId: requestId() }));
    render();
  };
  socket.onmessage = ({ data }) => {
    const payload = JSON.parse(data);
    if (payload.type === 'state') state = payload;
    if (payload.type === 'ack' && !payload.ok) message.textContent = payload.error.message;
    if (payload.type === 'event') {
      const labels = {
        recording_started: 'Recording started.',
        recording_stopped: 'Recording stopped. Saving locally…',
        saved_local: `Recording saved to ${payload.data.path || 'Documents\\HFRecorder'}`,
        capture_error: 'The recorder reported a capture error. Check the desktop app.',
      };
      if (labels[payload.event]) message.textContent = labels[payload.event];
    }
    render();
  };
  socket.onclose = () => {
    state = null;
    message.textContent = 'Recorder disconnected. Reconnecting…';
    render();
    reconnectTimer = setTimeout(connect, 1000);
  };
  socket.onerror = () => socket.close();
}

for (const action of actionIds) buttons[action].onclick = () => send(action);
render();
connect();
