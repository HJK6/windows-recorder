/*
 * recorderState.js — pure, framework-free recorder state machine.
 *
 * Source of truth for the recorder's status + mute state. It never touches a
 * real MediaRecorder or MediaStreamTrack; instead reduce() returns the next
 * state plus a list of *effect* descriptors that the renderer maps onto real
 * objects. This keeps the record/pause/resume/mute/unmute/stop logic unit-
 * testable in plain Node with no Electron/DOM.
 *
 * Key invariant (the operator's requirement): PAUSE stops the whole recording
 * (both tracks) while MUTE only silences audio and leaves video recording.
 * So MUTE keeps status === RECORDING and merely flips `muted`, emitting an
 * audio:disable effect (audioTrack.enabled = false) — it does NOT pause the
 * recorder. PAUSE emits recorder:pause (halts video + audio data emission).
 *
 * Dual-module: usable via require() in Node tests and via a <script> tag in
 * the Electron renderer (attaches to window.RecorderState).
 */
(function () {
  'use strict';

  const IDLE = 'idle';
  const RECORDING = 'recording';
  const PAUSED = 'paused';

  // Effects the renderer knows how to apply to the real recorder/track.
  const EFFECTS = {
    START: 'recorder:start',
    PAUSE: 'recorder:pause',
    RESUME: 'recorder:resume',
    STOP: 'recorder:stop',
    AUDIO_ENABLE: 'audio:enable',
    AUDIO_DISABLE: 'audio:disable',
  };

  function initialState() {
    return { status: IDLE, muted: false };
  }

  /**
   * reduce(state, event) -> { state, effects }
   * Invalid transitions are no-ops (same state, no effects) so the UI can wire
   * every button unconditionally and rely on the machine to gate.
   * event: { type: 'START'|'PAUSE'|'RESUME'|'MUTE'|'UNMUTE'|'STOP' }
   */
  function reduce(state, event) {
    const noop = { state, effects: [] };
    switch (event && event.type) {
      case 'START':
        if (state.status !== IDLE) return noop;
        // Fresh recording always starts unmuted with audio enabled.
        return {
          state: { status: RECORDING, muted: false },
          effects: [EFFECTS.AUDIO_ENABLE, EFFECTS.START],
        };

      case 'PAUSE':
        if (state.status !== RECORDING) return noop;
        return {
          state: { status: PAUSED, muted: state.muted },
          effects: [EFFECTS.PAUSE],
        };

      case 'RESUME':
        if (state.status !== PAUSED) return noop;
        return {
          state: { status: RECORDING, muted: state.muted },
          effects: [EFFECTS.RESUME],
        };

      case 'MUTE':
        // Allowed while recording or paused; muting never changes status.
        if (state.status === IDLE || state.muted) return noop;
        return {
          state: { status: state.status, muted: true },
          effects: [EFFECTS.AUDIO_DISABLE],
        };

      case 'UNMUTE':
        if (state.status === IDLE || !state.muted) return noop;
        return {
          state: { status: state.status, muted: false },
          effects: [EFFECTS.AUDIO_ENABLE],
        };

      case 'STOP':
        if (state.status === IDLE) return noop;
        return {
          state: { status: IDLE, muted: false },
          effects: [EFFECTS.STOP],
        };

      default:
        return noop;
    }
  }

  // Convenience predicates for the UI (which buttons are enabled).
  function canPause(state) { return state.status === RECORDING; }
  function canResume(state) { return state.status === PAUSED; }
  function canMute(state) { return state.status !== IDLE && !state.muted; }
  function canUnmute(state) { return state.status !== IDLE && state.muted; }
  function isActive(state) { return state.status !== IDLE; }

  const api = {
    IDLE, RECORDING, PAUSED, EFFECTS,
    initialState, reduce,
    canPause, canResume, canMute, canUnmute, isActive,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.RecorderState = api;
})();
