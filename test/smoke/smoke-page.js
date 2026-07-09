'use strict';

// Runs with nodeIntegration (test harness only). Drives capture through the
// SHIPPED state machine (recorderState) + effect layer (applyEffect) — not a
// reimplementation — and tries the real getDisplayMedia path (falling back to a
// fake camera if xvfb can't screen-capture). Produces a merged WebM.

const { ipcRenderer } = require('electron');
const RS = require('../../src/shared/recorderState');
const AE = require('../../src/shared/applyEffect');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let state = RS.initialState();
let recorder = null;
let audioTrack = null;
const chunks = [];

// Same dispatch shape the renderer uses: reduce -> apply each effect.
function dispatch(type) {
  const out = RS.reduce(state, { type });
  for (const e of out.effects) AE.applyRecorderEffect(e, { recorder, audioTrack, timesliceMs: 500 });
  state = out.state;
}

(async () => {
  try {
    // Prefer the real screen path (exercises the production main-process
    // setDisplayMediaRequestHandler); fall back to a fake camera under xvfb.
    let videoStream;
    try {
      videoStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      console.log('SMOKE: using getDisplayMedia (screen path)');
    } catch (e) {
      console.log('SMOKE: getDisplayMedia unavailable under xvfb, using fake camera:', e.message);
      videoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    const videoTrack = videoStream.getVideoTracks()[0];
    audioTrack = micStream.getAudioTracks()[0];
    if (!videoTrack || !audioTrack) throw new Error('missing tracks');

    const combined = new MediaStream([videoTrack, audioTrack]);
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';
    recorder = new MediaRecorder(combined, { mimeType: mime });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await ipcRenderer.invoke('smoke-save', bytes);
      ipcRenderer.send('smoke-done', true);
    };

    // Drive through the production reducer + effect layer.
    dispatch('START');
    await wait(700);
    dispatch('PAUSE');  await wait(300); dispatch('RESUME');
    dispatch('MUTE');   await wait(400); dispatch('UNMUTE');
    await wait(500);
    dispatch('STOP');
  } catch (err) {
    console.error('SMOKE-ERROR', (err && err.stack) || err);
    ipcRenderer.send('smoke-done', false);
  }
})();
