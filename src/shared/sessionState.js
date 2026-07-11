(function () {
  'use strict';

  const OFFLINE = 'offline';
  const ACTIVATING = 'activating';
  const ONLINE = 'online';
  const ERROR = 'error';

  function initialState() {
    return {
      session: OFFLINE,
      recorder: { status: 'idle', muted: false },
      identity: null,
      sessionId: null,
    };
  }

  function reduce(state, event) {
    switch (event && event.type) {
      case 'ACTIVATE_START':
        if (state.session === ACTIVATING
          || (state.session === ONLINE && state.recorder.status !== 'idle')) return state;
        return { ...state, session: ACTIVATING, identity: null, sessionId: null };
      case 'ACTIVATE_SUCCESS':
        if (state.session !== ACTIVATING) return state;
        return {
          ...state,
          session: ONLINE,
          identity: event.identity,
          sessionId: event.sessionId,
        };
      case 'ACTIVATE_FAILURE':
        if (state.session !== ACTIVATING) return state;
        return { ...state, session: ERROR, identity: null, sessionId: null };
      case 'RECORDER_STATE':
        return { ...state, recorder: { status: event.status, muted: Boolean(event.muted) } };
      case 'DEACTIVATE':
        return initialState();
      default:
        return state;
    }
  }

  function canCommand(state) { return state.session === ONLINE; }
  function canActivate(state) {
    if (state.session === ACTIVATING) return false;
    return state.session !== ONLINE || state.recorder.status === 'idle';
  }

  const api = { OFFLINE, ACTIVATING, ONLINE, ERROR, initialState, reduce, canCommand, canActivate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SessionState = api;
})();
