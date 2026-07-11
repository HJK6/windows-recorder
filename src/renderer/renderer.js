'use strict';

/*
 * Renderer: wires the DOM controls to the pure state machine (window.RecorderState)
 * and applies the machine's effects to a real MediaRecorder + microphone track.
 *
 * Capture model (v1): screen video (getDisplayMedia) + mic audio (getUserMedia)
 * are composed into ONE MediaStream and recorded by ONE MediaRecorder, so the
 * output WebM is already merged (no post-hoc mux, no A/V-sync drift).
 *   - Pause/Resume  -> recorder.pause()/resume()  (both tracks)
 *   - Mute/Unmute   -> audioTrack.enabled = false/true (audio only; video rolls)
 */

const RS = window.RecorderState;
const AE = window.ApplyEffect;

// ---- DOM refs -------------------------------------------------------------
const el = {
  dot: document.getElementById('dot'),
  stateLabel: document.getElementById('state-label'),
  timer: document.getElementById('timer'),
  muted: document.getElementById('muted'),
  record: document.getElementById('record'),
  pause: document.getElementById('pause'),
  resume: document.getElementById('resume'),
  mute: document.getElementById('mute'),
  unmute: document.getElementById('unmute'),
  stop: document.getElementById('stop'),
  banner: document.getElementById('banner'),
  bannerText: document.getElementById('banner-text'),
  openPrivacy: document.getElementById('open-privacy'),
  output: document.getElementById('output'),
  preview: document.getElementById('preview'),
  connection: document.getElementById('connection'),
  identity: document.getElementById('identity'),
};

// ---- Runtime capture objects ----------------------------------------------
let state = RS.initialState();
let screenStream = null;
let micStream = null;
let combinedStream = null;
let audioTrack = null;
let recorder = null;
let chunks = [];
let recordingId = null;
let recordingStartedAt = null;
let recordingEndedAt = null;
let sessionOnline = false;
let finishing = false; // true from STOP until the async save+teardown completes

function genRecordingId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID().slice(0, 8);
  return Math.floor(Math.random() * 0xffffffff).toString(16);
}

// ---- Timer (accumulates recording time, excluding paused spans) -----------
let timerBaseMs = 0;
let segStart = null;
let ticker = null;
const fmt = (ms) => {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
};
const elapsed = () => timerBaseMs + (segStart != null ? performance.now() - segStart : 0);
function startTicker() {
  stopTicker();
  ticker = setInterval(() => { el.timer.textContent = fmt(elapsed()); }, 250);
}
function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

// ---- Banner (OS-permission guidance) --------------------------------------
// showMicButton: whether to offer the "open Windows mic settings" deep-link
// (only relevant when the microphone is the problem).
function showBanner(msg, showMicButton) {
  el.bannerText.textContent = msg;
  el.openPrivacy.style.display = (showMicButton === false) ? 'none' : '';
  el.banner.classList.add('show');
}
function hideBanner() { el.banner.classList.remove('show'); }

// ---- Effect application ---------------------------------------------------
// Device actions (recorder + track) go through the shared, unit-tested
// applyRecorderEffect; only renderer-local timer/chunk bookkeeping lives here.
function applyEffect(effect) {
  if (effect === RS.EFFECTS.START) {
    chunks = [];
    recordingId = genRecordingId();
    recordingStartedAt = Date.now();
    recordingEndedAt = null;
  }

  AE.applyRecorderEffect(effect, { recorder, audioTrack, timesliceMs: 1000 });

  switch (effect) {
    case RS.EFFECTS.START:
      timerBaseMs = 0; segStart = performance.now(); startTicker();
      break;
    case RS.EFFECTS.PAUSE:
      timerBaseMs += performance.now() - segStart; segStart = null;
      break;
    case RS.EFFECTS.RESUME:
      segStart = performance.now();
      break;
    case RS.EFFECTS.STOP:
      if (segStart != null) { timerBaseMs += performance.now() - segStart; segStart = null; }
      recordingEndedAt = Date.now();
      stopTicker();
      finishing = true; // block Record until save + stream teardown finish
      break;
  }
}

function dispatch(type) {
  const out = RS.reduce(state, { type });
  for (const e of out.effects) applyEffect(e);
  state = out.state;
  render();
  window.hf.sendRecorderState({
    status: state.status,
    muted: state.muted,
    finishing: type === 'STOP' && out.effects.includes(RS.EFFECTS.STOP),
    ...(out.effects.includes(RS.EFFECTS.START)
      ? { event: 'recording_started', data: { recordingId } }
      : {}),
  });
}

// ---- Render UI from state -------------------------------------------------
function render() {
  const labels = { [RS.IDLE]: 'Idle', [RS.RECORDING]: 'Recording', [RS.PAUSED]: 'Paused' };
  el.stateLabel.textContent = labels[state.status];
  el.dot.className = state.status === RS.RECORDING ? 'recording'
    : state.status === RS.PAUSED ? 'paused' : '';
  el.muted.hidden = !state.muted;

  el.record.disabled = !sessionOnline || RS.isActive(state) || finishing;
  el.stop.disabled = !sessionOnline || !RS.isActive(state);

  el.pause.hidden = state.status === RS.PAUSED;
  el.pause.disabled = !sessionOnline || !RS.canPause(state);
  el.resume.hidden = state.status !== RS.PAUSED;
  el.resume.disabled = !sessionOnline || !RS.canResume(state);

  el.mute.hidden = state.muted;
  el.mute.disabled = !sessionOnline || !RS.canMute(state);
  el.unmute.hidden = !state.muted;
  el.unmute.disabled = !sessionOnline || !RS.canUnmute(state);
}

// ---- Stream setup / teardown ----------------------------------------------
async function setupStreams() {
  // Screen video (primary display, served by the main process handler).
  // Tag which capture stage failed so the error message points at the right layer.
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (err) { err.captureStage = 'screen'; throw err; }
  // Microphone audio.
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) { err.captureStage = 'mic'; throw err; }

  const videoTrack = screenStream.getVideoTracks()[0];
  audioTrack = micStream.getAudioTracks()[0];
  combinedStream = new MediaStream([videoTrack, audioTrack]);

  // If the user stops sharing via the OS, stop the recording gracefully.
  videoTrack.addEventListener('ended', () => { if (RS.isActive(state)) dispatch('STOP'); });

  el.preview.srcObject = combinedStream;
  el.preview.classList.add('show');

  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';
  recorder = new MediaRecorder(combinedStream, { mimeType: mime });
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = onRecordingStopped;
}

function teardownStreams() {
  for (const s of [screenStream, micStream]) {
    if (s) s.getTracks().forEach((t) => t.stop());
  }
  screenStream = micStream = combinedStream = audioTrack = recorder = null;
  el.preview.srcObject = null;
  el.preview.classList.remove('show');
}

async function onRecordingStopped() {
  const blob = new Blob(chunks, { type: 'video/webm' });
  chunks = [];
  // Pass the raw ArrayBuffer: it is a primary structured-clone type and crosses
  // the contextBridge boundary more reliably than a typed-array view.
  const buffer = await blob.arrayBuffer();
  const digest = await window.crypto.subtle.digest('SHA-256', buffer);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  window.hf.sendRecordingStopped(buffer, {
    recordingId,
    startedAt: recordingStartedAt,
    endedAt: recordingEndedAt,
    durationMs: Math.round(timerBaseMs),
    sha256,
  });
  el.output.textContent = 'Processing recording upload…';
  teardownStreams();
  finishing = false; // save + teardown done; Record is safe to re-enable
  render();
}

// ---- Record click: set up streams, then start the machine -----------------
async function onRecord() {
  if (finishing) return;
  hideBanner();
  el.output.textContent = '';
  try {
    await setupStreams();
  } catch (err) {
    teardownStreams();
    await explainCaptureFailure(err);
    window.hf.sendRecorderState({
      status: RS.IDLE,
      muted: false,
      event: 'capture_error',
      data: { stage: err && err.captureStage ? err.captureStage : 'unknown' },
    });
    return;
  }
  dispatch('START');
}

async function explainCaptureFailure(err) {
  const stage = err && err.captureStage;
  if (stage === 'mic') {
    // Only the mic layer is gated by Windows privacy — probe + guide there.
    let consent = { supported: false, value: 'unknown' };
    try { consent = await window.hf.probeMicConsent(); } catch (_) {}
    if (consent.supported && consent.value === 'Deny') {
      showBanner('Windows is blocking microphone access for desktop apps. '
        + 'Open Settings and allow microphone access, then try again.', true);
    } else {
      showBanner(`Microphone capture was blocked (${err.name || 'error'}). Check Windows `
        + 'microphone privacy settings and that a microphone is connected, then try again.', true);
    }
  } else if (stage === 'screen') {
    showBanner(`Screen capture could not start (${err.name || 'error'}). Try again; `
      + 'if it persists, restart the app.', false);
  } else {
    showBanner(`Could not start capture: ${err ? err.message : 'unknown error'}`, false);
  }
}

// ---- Wire buttons ---------------------------------------------------------
el.record.onclick = onRecord;
el.pause.onclick = () => dispatch('PAUSE');
el.resume.onclick = () => dispatch('RESUME');
el.mute.onclick = () => dispatch('MUTE');
el.unmute.onclick = () => dispatch('UNMUTE');
el.stop.onclick = () => dispatch('STOP');
el.openPrivacy.onclick = () => window.hf.openMicPrivacy();

window.hf.onCommand((action) => {
  if (action === 'start') onRecord();
  else dispatch(String(action).toUpperCase());
});
window.hf.onState((next) => {
  sessionOnline = next.session === 'online';
  el.connection.textContent = next.session.toUpperCase();
  el.connection.className = next.session;
  el.identity.textContent = next.identity
    ? `${next.identity.email} · ${next.identity.agentId}`
    : 'No active identity';
  render();
});
window.hf.onEvent(({ event, data }) => {
  if (event === 'uploaded') el.output.textContent = `Uploaded ${data.objectKey}`;
  if (event === 'metadata_written') el.output.textContent = `Complete ${data.objectKey}`;
  if (event === 'capture_error' && data.reason) el.output.textContent = `Recording error: ${data.reason}`;
});

// ---- Startup: pre-flight the OS mic-consent layer -------------------------
(async function init() {
  render();
  try {
    const consent = await window.hf.probeMicConsent();
    if (consent.supported && consent.value === 'Deny') {
      showBanner('Windows microphone access for desktop apps is currently OFF. '
        + 'Recording audio will fail until it is enabled.');
    }
  } catch (_) { /* non-fatal */ }
})();
