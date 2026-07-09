'use strict';

// Runs with nodeIntegration (test harness only). Captures fake camera+mic,
// merges into one MediaStream, records through a pause/resume + mute/unmute
// cycle, and ships the merged WebM bytes to the main process.

const { ipcRenderer } = require('electron');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0];
    if (!videoTrack || !audioTrack) throw new Error('missing fake tracks');

    const combined = new MediaStream([videoTrack, audioTrack]);
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';

    const rec = new MediaRecorder(combined, { mimeType: mime });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await ipcRenderer.invoke('smoke-save', bytes);
      ipcRenderer.send('smoke-done', true);
    };

    rec.start(500);
    await wait(700);
    rec.pause();                 // pause: both tracks
    await wait(300);
    rec.resume();
    audioTrack.enabled = false;  // mute: audio only, video keeps recording
    await wait(400);
    audioTrack.enabled = true;   // unmute
    await wait(500);
    rec.stop();
  } catch (err) {
    console.error('SMOKE-ERROR', (err && err.stack) || err);
    ipcRenderer.send('smoke-done', false);
  }
})();
