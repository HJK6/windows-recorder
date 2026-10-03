'use strict';

/*
 * ws-client.js — the desktop's single OUTBOUND WebSocket control channel to the
 * AWS API Gateway WebSocket API. This replaces the rejected loopback HTTP
 * control server: there is no listener on the workstation. AWS pushes narrowly
 * scoped commands down this desktop-initiated connection; the desktop relays
 * them to the capture renderer and reports an APPLIED acknowledgment only once
 * the recorder has actually reached the target state.
 *
 * Key invariants proved by the POC:
 *  - A routine socket drop / reconnect does NOT restart the encoder and does NOT
 *    create duplicate capture (the recorder keeps running; reconnect only
 *    re-establishes the channel and reconciles current desired state).
 *  - Duplicate/stale commands are idempotent (revision-guarded): they re-ack the
 *    current state rather than re-applying.
 *  - The UI shows a confirmed state only from an APPLIED ack.
 */

const DESIRED = { RECORDING: 'RECORDING', PAUSED: 'PAUSED', STOPPED: 'STOPPED' };

// Report the recorder's observed status in the canonical capture vocabulary
// (spec §5.1) so the server/UI compare like-for-like with desired state.
function toCapture(status) {
  switch (status) {
    case 'recording': return 'RECORDING';
    case 'paused': return 'PAUSED';
    case 'idle': return 'IDLE';
    default: return String(status || '').toUpperCase();
  }
}

// Does the recorder's observed state satisfy the command's desired state?
function reached(action, recorderStatus) {
  switch (action) {
    case 'start':
    case 'resume': return recorderStatus === 'recording';
    case 'pause': return recorderStatus === 'paused';
    case 'stop': return recorderStatus === 'idle';
    default: return false;
  }
}

// Map a desired capture state + the current recorder status onto the renderer
// action that reaches it. null => already satisfied (idempotent no-op).
function actionFor(desiredState, recorderStatus) {
  switch (desiredState) {
    case DESIRED.RECORDING:
      if (recorderStatus === 'idle') return 'start';
      if (recorderStatus === 'paused') return 'resume';
      return null; // already recording
    case DESIRED.PAUSED:
      return recorderStatus === 'recording' ? 'pause' : null;
    case DESIRED.STOPPED:
      return recorderStatus === 'idle' ? null : 'stop';
    default:
      return null;
  }
}

function fullJitter(baseMs, capMs, attempt) {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}

function createWsClient({
  wsUrl,
  identity,
  agentVersion = '0.2.0',
  getState,
  relay,
  events,
  WebSocketImpl = require('ws'),
  commandTimeoutMs = 10000,
  heartbeat = { idleMs: 60000, activeMs: 30000 },
  backoff = { baseMs: 1000, capMs: 60000 },
  healthyResetMs = 60000,
  now = Date.now,
  logger = { info() {}, warn() {}, error() {} },
  onConnection = () => {},
}) {
  let ws = null;
  let stopped = false;
  let ready = false; // true only after hello handshake is acknowledged by welcome
  let attempt = 0;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let connectedAt = 0;
  // Idempotency: highest applied revision per recordingId. Survives reconnects.
  const appliedRevision = new Map();
  // The recording currently owned by this desktop (server-authoritative id).
  let active = null; // { recordingId, revision }

  function recorderStatus() { return getState().recorder.status; }

  function sendRaw(obj) {
    if (!ws || ws.readyState !== WebSocketImpl.OPEN) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch (err) {
      logger.warn('ws send failed', err && err.message); return false;
    }
  }

  function scheduleHeartbeat() {
    clearTimeout(heartbeatTimer);
    const activeNow = recorderStatus() !== 'idle';
    const interval = activeNow ? heartbeat.activeMs : heartbeat.idleMs;
    // Randomized phase (spec §4): spread the fleet's heartbeats.
    const phase = Math.floor(Math.random() * Math.min(interval, 5000));
    heartbeatTimer = setTimeout(() => {
      sendRaw({ type: 'heartbeat', active: activeNow });
      scheduleHeartbeat();
    }, interval + phase);
  }

  // Wait until the recorder reaches the action's target, then resolve true;
  // resolve false on timeout. Returns a canceler to tear down a stuck wait.
  function awaitReached(action) {
    return new Promise((resolve) => {
      if (reached(action, recorderStatus())) { resolve(true); return; }
      let timer;
      const onState = (state) => {
        if (reached(action, state.recorder.status)) finish(true);
      };
      const finish = (ok) => { clearTimeout(timer); events.off('state', onState); resolve(ok); };
      timer = setTimeout(() => finish(false), commandTimeoutMs);
      events.on('state', onState);
    });
  }

  function ackFor(cmd, status) {
    sendRaw({
      type: 'command.ack',
      commandId: cmd.commandId,
      recordingId: cmd.recordingId,
      revision: cmd.revision,
      status,
      observedState: toCapture(recorderStatus()),
      at: new Date(now()).toISOString(),
    });
  }

  async function applyDesiredState(cmd, { viaReconcile = false } = {}) {
    const { recordingId, revision, desiredState } = cmd;
    if (!recordingId || typeof revision !== 'number') {
      logger.warn('ignoring malformed command', cmd); return;
    }
    const prior = appliedRevision.get(recordingId);
    // Lower/equal revision is a duplicate or stale retry: never re-apply; the
    // reconnect path relies on this so a resent start can't restart capture.
    if (prior != null && revision <= prior) {
      ackFor(cmd, 'APPLIED');
      return;
    }
    const action = actionFor(desiredState, recorderStatus());
    if (action === null) {
      // Desired state already satisfied (e.g. reconnect while already recording)
      // — record the revision and confirm without touching the encoder.
      appliedRevision.set(recordingId, revision);
      if (desiredState === DESIRED.RECORDING) active = { recordingId, revision };
      if (desiredState === DESIRED.STOPPED && active && active.recordingId === recordingId) active = null;
      ackFor(cmd, 'APPLIED');
      return;
    }
    if (action === 'start') active = { recordingId, revision };
    if (action === 'resume' && active) active = { recordingId, revision };
    try {
      relay(action, { recordingId, revision });
    } catch (err) {
      logger.error('relay failed', err && err.message);
      ackFor(cmd, 'FAILED');
      return;
    }
    const ok = await awaitReached(action);
    if (ok) {
      appliedRevision.set(recordingId, revision);
      if (action === 'stop' && active && active.recordingId === recordingId) active = null;
      ackFor(cmd, 'APPLIED');
    } else {
      ackFor(cmd, 'FAILED');
    }
    if (viaReconcile) logger.info('reconciled desired state', recordingId, desiredState);
  }

  function onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) {
      logger.warn('non-JSON ws message dropped'); return;
    }
    switch (msg.type) {
      case 'welcome':
        ready = true;
        attempt = 0;
        onConnection('online');
        // Reconcile CURRENT desired state only (not historical queue).
        if (Array.isArray(msg.recordings)) {
          for (const r of msg.recordings) {
            applyDesiredState(
              { commandId: `reconcile-${r.recordingId}-${r.revision}`, ...r },
              { viaReconcile: true },
            );
          }
        }
        scheduleHeartbeat();
        break;
      case 'command':
        if (msg.command && msg.command.type === 'recording.setDesiredState') {
          applyDesiredState(msg.command);
        } else {
          logger.warn('unknown command type', msg.command && msg.command.type);
        }
        break;
      case 'heartbeat.ack':
        break;
      default:
        logger.warn('unhandled ws message type', msg.type);
    }
  }

  async function connect() {
    if (stopped) return;
    ready = false;
    let token;
    try {
      ({ token } = await identity.getDeviceToken());
    } catch (err) {
      logger.error('device token fetch failed', err && err.message);
      scheduleReconnect();
      return;
    }
    if (stopped) return;
    try {
      ws = new WebSocketImpl(wsUrl, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      logger.error('ws construct failed', err && err.message);
      scheduleReconnect();
      return;
    }
    ws.on('open', () => {
      connectedAt = now();
      sendRaw({
        type: 'hello',
        agentVersion,
        deviceId: identity.deviceId,
        capabilities: { screen: true, mic: true },
        recovery: { active },
      });
    });
    ws.on('message', onMessage);
    ws.on('error', (err) => logger.warn('ws error', err && err.message));
    ws.on('close', () => {
      ready = false;
      onConnection('offline');
      clearTimeout(heartbeatTimer);
      if (now() - connectedAt >= healthyResetMs) attempt = 0; // healthy run resets backoff
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    const delay = fullJitter(backoff.baseMs, backoff.capMs, attempt);
    attempt += 1;
    reconnectTimer = setTimeout(connect, delay);
  }

  return {
    start() { stopped = false; connect(); },
    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      clearTimeout(heartbeatTimer);
      if (ws) { try { ws.close(); } catch (_) { /* ignore */ } }
    },
    isReady() { return ready; },
    getActiveRecording() { return active ? { ...active } : null; },
  };
}

module.exports = { createWsClient, reached, actionFor, DESIRED };
