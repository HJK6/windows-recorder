'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RS = require('../src/shared/recorderState');
const { applyRecorderEffect } = require('../src/shared/applyEffect');

// Fakes standing in for a real MediaRecorder + MediaStreamTrack, recording the
// calls the SHIPPED effect layer makes on them.
function makeFakes() {
  const calls = [];
  const recorder = {
    start: (ts) => calls.push(['start', ts]),
    pause: () => calls.push(['pause']),
    resume: () => calls.push(['resume']),
    stop: () => calls.push(['stop']),
  };
  const audioTrack = { enabled: true };
  return { calls, recorder, audioTrack };
}

test('each effect maps to the right recorder/track action', () => {
  const { calls, recorder, audioTrack } = makeFakes();
  const ctx = { recorder, audioTrack, timesliceMs: 250 };

  assert.equal(applyRecorderEffect(RS.EFFECTS.START, ctx), 'start');
  assert.deepEqual(calls.at(-1), ['start', 250]);

  assert.equal(applyRecorderEffect(RS.EFFECTS.PAUSE, ctx), 'pause');
  assert.deepEqual(calls.at(-1), ['pause']);

  assert.equal(applyRecorderEffect(RS.EFFECTS.RESUME, ctx), 'resume');
  assert.deepEqual(calls.at(-1), ['resume']);

  applyRecorderEffect(RS.EFFECTS.AUDIO_DISABLE, ctx);
  assert.equal(audioTrack.enabled, false);
  applyRecorderEffect(RS.EFFECTS.AUDIO_ENABLE, ctx);
  assert.equal(audioTrack.enabled, true);

  assert.equal(applyRecorderEffect(RS.EFFECTS.STOP, ctx), 'stop');
  assert.deepEqual(calls.at(-1), ['stop']);
});

// The integration QA asked for: drive the reducer's effects through the SHIPPED
// applyRecorderEffect against real-ish objects, and prove mute never pauses.
test('full record->pause->resume->mute->unmute->stop drives correct device calls', () => {
  const { calls, recorder, audioTrack } = makeFakes();
  const ctx = { recorder, audioTrack, timesliceMs: 1000 };
  let state = RS.initialState();
  for (const type of ['START', 'PAUSE', 'RESUME', 'MUTE', 'UNMUTE', 'STOP']) {
    const out = RS.reduce(state, { type });
    for (const e of out.effects) applyRecorderEffect(e, ctx);
    state = out.state;
  }
  const names = calls.map((c) => c[0]);
  assert.deepEqual(names, ['start', 'pause', 'resume', 'stop']);
  assert.equal(audioTrack.enabled, true); // unmuted at end
});

test('MUTE disables the audio track WITHOUT pausing the recorder (video keeps rolling)', () => {
  const { calls, recorder, audioTrack } = makeFakes();
  const ctx = { recorder, audioTrack };
  let state = RS.reduce(RS.initialState(), { type: 'START' }).state; // recording
  applyRecorderEffect(RS.EFFECTS.START, ctx); // start the fake recorder

  const out = RS.reduce(state, { type: 'MUTE' });
  for (const e of out.effects) applyRecorderEffect(e, ctx);

  assert.equal(audioTrack.enabled, false, 'audio muted');
  assert.ok(!calls.some((c) => c[0] === 'pause'), 'recorder was NOT paused by mute');
  assert.equal(out.state.status, RS.RECORDING, 'still recording while muted');
});
