'use strict';

// Sandboxed, context-isolated page — no Node. Uses ONLY window.hf (the real
// preload), exactly like the production renderer. Builds a Uint8Array the way
// onRecordingStopped does (from a Blob's arrayBuffer) and emits it to main.

(async () => {
  try {
    const blob = new Blob([new Uint8Array(4096).fill(7)], { type: 'video/webm' });
    const buffer = await blob.arrayBuffer(); // matches production: pass the ArrayBuffer
    window.hf.sendRecordingStopped(buffer, {
      recordingId: 'harness12', startedAt: 1000, endedAt: 2000,
      durationMs: 1000, sha256: 'synthetic-harness-digest',
    });
  } catch (e) {
    // Main already logged the real error; swallow to avoid an unhandled rejection.
    console.error('PAGE save rejected:', e && e.message);
  }
})();
