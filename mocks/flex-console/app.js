'use strict';

const status = document.getElementById('status');
const controls = document.getElementById('controls');
let ws;
let lastState = null;
let lastEvent = null;

const requestId = () => crypto.randomUUID();
function render() {
  status.textContent = JSON.stringify({ state: lastState, lastEvent }, null, 2);
}
function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ v: 1, ...message }));
}
function connect() {
  if (ws && ws.readyState <= WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve) => {
    ws = new WebSocket('ws://127.0.0.1:8765');
    ws.onopen = resolve;
    ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.type === 'state') lastState = message;
      if (message.type === 'event') lastEvent = message;
      render();
    };
    ws.onclose = () => { status.textContent = 'Disconnected'; };
  });
}

for (const action of ['start', 'stop', 'pause', 'resume', 'mute', 'unmute']) {
  const button = document.createElement('button');
  button.textContent = action;
  button.onclick = () => send({ type: 'command', action, requestId: requestId() });
  controls.appendChild(button);
}

document.getElementById('activate').onclick = async () => {
  await connect();
  const agent = document.getElementById('agent').value.replace(/[^a-z0-9_-]/gi, '') || 'demo';
  send({
    type: 'activate', requestId: requestId(), flexToken: `mock-flex-${agent}`,
    context: { recordingKind: document.getElementById('kind').value },
  });
};
document.getElementById('deactivate').onclick = () => send({ type: 'deactivate', requestId: requestId() });
