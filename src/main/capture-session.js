'use strict';

/*
 * capture-session.js — wires the Chromium/Electron in-app capture permissions
 * onto a session. Shared by the production main process (main.js) and the
 * capture smoke (test/smoke/smoke-main.js) so both exercise the same handlers.
 *
 * Auto-grants media + display-capture for our own file:// origin only, and
 * serves the primary screen to getDisplayMedia via desktopCapturer.
 */

const Permissions = require('../shared/permissions');

const APP_ORIGIN = 'file://';

function wireCapturePermissions(session, desktopCapturer) {
  session.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details && details.requestingUrl)
      || (wc && typeof wc.getURL === 'function' ? wc.getURL() : '');
    callback(Permissions.shouldGrantCapture(permission, url, APP_ORIGIN));
  });

  session.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return Permissions.shouldGrantCapture(permission, requestingOrigin || APP_ORIGIN, APP_ORIGIN);
  });

  // getDisplayMedia() -> primary screen. Mic is captured separately via
  // getUserMedia in the renderer and merged there; no system audio in v1.
  session.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (!sources.length) { callback({}); return; }
      callback({ video: sources[0] });
    }).catch(() => callback({}));
  }, { useSystemPicker: false });
}

module.exports = { wireCapturePermissions, APP_ORIGIN };
