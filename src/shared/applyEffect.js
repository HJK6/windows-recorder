/*
 * applyEffect.js — applies a recorderState effect to real capture objects.
 *
 * This is the SHIPPED effect-application layer, shared by the renderer and the
 * capture smoke so both exercise the same code (not a reimplementation). It
 * maps each effect string to the concrete MediaRecorder / MediaStreamTrack
 * action and returns the action name for assertions.
 *
 * Timer/chunk bookkeeping is intentionally NOT here — that is renderer-only UI
 * state, keyed off the same effect string by the caller.
 */
(function () {
  'use strict';

  const RS = (typeof module !== 'undefined' && module.exports)
    ? require('./recorderState')
    : window.RecorderState;
  const E = RS.EFFECTS;

  // ctx: { recorder, audioTrack, timesliceMs }
  function applyRecorderEffect(effect, ctx) {
    const recorder = ctx && ctx.recorder;
    const audioTrack = ctx && ctx.audioTrack;
    const timesliceMs = (ctx && ctx.timesliceMs) || 1000;
    switch (effect) {
      case E.START:
        recorder.start(timesliceMs);
        return 'start';
      case E.PAUSE:
        recorder.pause();
        return 'pause';
      case E.RESUME:
        recorder.resume();
        return 'resume';
      case E.STOP:
        recorder.stop();
        return 'stop';
      case E.AUDIO_ENABLE:
        if (audioTrack) audioTrack.enabled = true;
        return 'audio-enable';
      case E.AUDIO_DISABLE:
        if (audioTrack) audioTrack.enabled = false;
        return 'audio-disable';
      default:
        return null;
    }
  }

  const api = { applyRecorderEffect };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ApplyEffect = api;
})();
