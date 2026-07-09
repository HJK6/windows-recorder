'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RS = require('../src/shared/recorderState');

// Small driver: fold a sequence of event types over the machine, collecting
// every effect emitted along the way.
function run(events, start) {
  let state = start || RS.initialState();
  const effects = [];
  for (const type of events) {
    const out = RS.reduce(state, { type });
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
}

test('initial state is idle and unmuted', () => {
  assert.deepEqual(RS.initialState(), { status: RS.IDLE, muted: false });
});

test('START moves idle -> recording and enables audio then starts', () => {
  const { state, effects } = run(['START']);
  assert.equal(state.status, RS.RECORDING);
  assert.equal(state.muted, false);
  assert.deepEqual(effects, [RS.EFFECTS.AUDIO_ENABLE, RS.EFFECTS.START]);
});

test('PAUSE halts recording (both tracks) and keeps status paused', () => {
  const { state, effects } = run(['START', 'PAUSE']);
  assert.equal(state.status, RS.PAUSED);
  assert.deepEqual(effects.slice(-1), [RS.EFFECTS.PAUSE]);
});

test('RESUME returns paused -> recording', () => {
  const { state, effects } = run(['START', 'PAUSE', 'RESUME']);
  assert.equal(state.status, RS.RECORDING);
  assert.deepEqual(effects.slice(-1), [RS.EFFECTS.RESUME]);
});

test('MUTE silences audio WITHOUT pausing the recorder (video keeps rolling)', () => {
  const { state, effects } = run(['START', 'MUTE']);
  // The core operator requirement: muted but still RECORDING.
  assert.equal(state.status, RS.RECORDING);
  assert.equal(state.muted, true);
  assert.deepEqual(effects.slice(-1), [RS.EFFECTS.AUDIO_DISABLE]);
  // Crucially, muting must NOT emit a recorder pause.
  assert.ok(!effects.includes(RS.EFFECTS.PAUSE));
});

test('UNMUTE re-enables audio, still recording', () => {
  const { state, effects } = run(['START', 'MUTE', 'UNMUTE']);
  assert.equal(state.status, RS.RECORDING);
  assert.equal(state.muted, false);
  assert.deepEqual(effects.slice(-1), [RS.EFFECTS.AUDIO_ENABLE]);
});

test('mute is independent of pause: can pause while muted and stay muted', () => {
  const { state } = run(['START', 'MUTE', 'PAUSE']);
  assert.equal(state.status, RS.PAUSED);
  assert.equal(state.muted, true, 'mute persists across pause');
});

test('can mute while paused (audio disable) without resuming', () => {
  const { state, effects } = run(['START', 'PAUSE', 'MUTE']);
  assert.equal(state.status, RS.PAUSED);
  assert.equal(state.muted, true);
  assert.deepEqual(effects.slice(-1), [RS.EFFECTS.AUDIO_DISABLE]);
});

test('STOP returns to idle and resets mute', () => {
  const { state, effects } = run(['START', 'MUTE', 'STOP']);
  assert.deepEqual(state, { status: RS.IDLE, muted: false });
  assert.deepEqual(effects.slice(-1), [RS.EFFECTS.STOP]);
});

test('invalid transitions are no-ops (no spurious effects)', () => {
  // PAUSE before START, RESUME while recording, double START, UNMUTE when not muted.
  assert.deepEqual(run(['PAUSE']).effects, []);
  assert.deepEqual(run(['RESUME']).effects, []);
  assert.deepEqual(run(['START', 'START']).effects,
    [RS.EFFECTS.AUDIO_ENABLE, RS.EFFECTS.START]); // second START ignored
  assert.deepEqual(run(['START', 'UNMUTE']).effects.slice(1), [RS.EFFECTS.START]); // UNMUTE ignored
  assert.deepEqual(run(['STOP']).effects, []); // stop when idle
});

test('button predicates gate the UI correctly', () => {
  const idle = RS.initialState();
  assert.equal(RS.canPause(idle), false);
  assert.equal(RS.isActive(idle), false);

  const rec = RS.reduce(idle, { type: 'START' }).state;
  assert.equal(RS.canPause(rec), true);
  assert.equal(RS.canResume(rec), false);
  assert.equal(RS.canMute(rec), true);
  assert.equal(RS.canUnmute(rec), false);

  const muted = RS.reduce(rec, { type: 'MUTE' }).state;
  assert.equal(RS.canMute(muted), false);
  assert.equal(RS.canUnmute(muted), true);

  const paused = RS.reduce(rec, { type: 'PAUSE' }).state;
  assert.equal(RS.canPause(paused), false);
  assert.equal(RS.canResume(paused), true);
});
