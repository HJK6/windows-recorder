'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Session = require('../src/shared/sessionState');

test('session transitions offline through activation to online and back', () => {
  let state = Session.initialState();
  assert.equal(Session.canCommand(state), false);
  state = Session.reduce(state, { type: 'ACTIVATE_START' });
  assert.equal(state.session, Session.ACTIVATING);
  state = Session.reduce(state, {
    type: 'ACTIVATE_SUCCESS',
    identity: { email: 'agent@example.invalid', agentId: 'mock-agent' },
    sessionId: 'mock-session-id',
  });
  assert.equal(Session.canCommand(state), true);
  assert.equal(state.sessionId, 'mock-session-id');
  state = Session.reduce(state, { type: 'DEACTIVATE' });
  assert.deepEqual(state, Session.initialState());
});

test('demo state is controllable without activation while the default stays fail-closed', () => {
  const normal = Session.initialState();
  const demo = Session.initialState({ demoMode: true });
  assert.equal(Session.canCommand(normal), false);
  assert.equal(Session.canCommand(demo), true);
  assert.equal(demo.session, Session.ONLINE);
  assert.equal(demo.identity.agentId, 'demo-local');
  assert.equal(normal.demoMode, false);
  assert.equal(demo.demoMode, true);
});

test('demo mode is immutable across session transitions and cannot be spoofed by session id', () => {
  let normal = Session.reduce(Session.initialState(), { type: 'ACTIVATE_START' });
  normal = Session.reduce(normal, {
    type: 'ACTIVATE_SUCCESS', identity: {}, sessionId: 'demo-local',
  });
  assert.equal(normal.demoMode, false);

  const deactivatedDemo = Session.reduce(
    Session.initialState({ demoMode: true }),
    { type: 'DEACTIVATE' },
  );
  assert.equal(deactivatedDemo.demoMode, true);
  assert.equal(deactivatedDemo.session, Session.ONLINE);
});

test('activation failure is fail-closed and permits another attempt', () => {
  let state = Session.reduce(Session.initialState(), { type: 'ACTIVATE_START' });
  state = Session.reduce(state, { type: 'ACTIVATE_FAILURE' });
  assert.equal(state.session, Session.ERROR);
  assert.equal(Session.canCommand(state), false);
  state = Session.reduce(state, { type: 'ACTIVATE_START' });
  assert.equal(state.session, Session.ACTIVATING);
});

test('a second activation is rejected while validation is in flight', () => {
  const activating = Session.reduce(Session.initialState(), { type: 'ACTIVATE_START' });
  assert.equal(Session.canActivate(activating), false);
  assert.equal(Session.reduce(activating, { type: 'ACTIVATE_START' }), activating);
});

test('online activation replacement is blocked while recording', () => {
  let state = Session.reduce(Session.initialState(), { type: 'ACTIVATE_START' });
  state = Session.reduce(state, {
    type: 'ACTIVATE_SUCCESS', identity: {}, sessionId: 'session-a',
  });
  state = Session.reduce(state, { type: 'RECORDER_STATE', status: 'recording', muted: false });
  assert.equal(Session.canActivate(state), false);
  assert.equal(Session.reduce(state, { type: 'ACTIVATE_START' }), state);
});
