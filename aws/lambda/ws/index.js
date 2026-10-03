'use strict';

/*
 * ws/index.js — API Gateway WebSocket handler for $connect, $disconnect and the
 * application routes (hello, heartbeat, command.ack). The route is selected by
 * the message `type` (routeSelectionExpression = $request.body.type).
 *
 * The connection is only treated as a live channel after `hello` (spec §4): we
 * promote it to the device's current connection and send `welcome` with the
 * CURRENT desired state only — never a replay of historical commands.
 */

const db = require('../shared/db');
const { createSender } = require('../shared/mgmt');

function senderFor(event) {
  const { domainName, stage } = event.requestContext;
  return createSender(`https://${domainName}/${stage}`);
}

async function onConnect(event) {
  const deviceId = event.requestContext.authorizer && event.requestContext.authorizer.deviceId;
  if (!deviceId) return { statusCode: 401, body: 'no device identity' };
  await db.putConnection(event.requestContext.connectionId, deviceId);
  return { statusCode: 200, body: 'connected' };
}

async function onDisconnect(event) {
  const connId = event.requestContext.connectionId;
  const conn = await db.getConnection(connId);
  await db.deleteConnection(connId);
  if (conn && conn.deviceId) await db.clearDeviceConnectionIfMatches(conn.deviceId, connId);
  return { statusCode: 200, body: 'disconnected' };
}

async function onHello(event, body) {
  const connId = event.requestContext.connectionId;
  const conn = await db.getConnection(connId);
  if (!conn) return { statusCode: 410, body: 'unknown connection' };
  await db.markConnectionReady(connId);
  const epoch = await db.setDeviceConnection(conn.deviceId, connId);

  const recordings = [];
  const activeId = await db.getActiveRecording(conn.deviceId);
  if (activeId) {
    const rec = await db.getRecording(activeId);
    if (rec && rec.desiredState && rec.desiredState !== 'STOPPED') {
      recordings.push({ recordingId: activeId, revision: rec.revision, desiredState: rec.desiredState });
    }
  }
  await senderFor(event)(connId, {
    type: 'welcome',
    serverTime: new Date().toISOString(),
    connectionEpoch: epoch,
    agentVersion: body.agentVersion || null,
    recordings,
  });
  return { statusCode: 200, body: 'welcomed' };
}

async function onHeartbeat(event) {
  const connId = event.requestContext.connectionId;
  await db.touchConnection(connId);
  await senderFor(event)(connId, { type: 'heartbeat.ack', serverTime: new Date().toISOString() });
  return { statusCode: 200, body: 'ok' };
}

async function onAck(event, body) {
  if (!body.recordingId || typeof body.revision !== 'number') return { statusCode: 400, body: 'bad ack' };
  // Authorize the ack: the acking connection's device must own this recording,
  // and the ack's revision must not exceed the server's issued revision. This
  // stops a device acking another device's recording or inventing a state.
  const conn = await db.getConnection(event.requestContext.connectionId);
  const rec = await db.getRecording(body.recordingId);
  if (!conn || !rec || rec.deviceId !== conn.deviceId) {
    console.warn('rejected ack: device/recording mismatch');
    return { statusCode: 403, body: 'forbidden' };
  }
  if (typeof rec.revision === 'number' && body.revision > rec.revision) {
    console.warn('rejected ack: revision ahead of issued');
    return { statusCode: 409, body: 'stale' };
  }
  await db.recordAck(body.recordingId, body.revision, body.status || 'APPLIED', body.observedState || null);
  return { statusCode: 200, body: 'ack' };
}

exports.handler = async (event) => {
  const routeKey = event.requestContext.routeKey;
  try {
    if (routeKey === '$connect') return await onConnect(event);
    if (routeKey === '$disconnect') return await onDisconnect(event);
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (_) { body = {}; }
    if ((event.body || '').length > 8192) return { statusCode: 413, body: 'too large' };
    switch (body.type) {
      case 'hello': return await onHello(event, body);
      case 'heartbeat': return await onHeartbeat(event);
      case 'command.ack': return await onAck(event, body);
      default: return { statusCode: 400, body: 'unknown type' };
    }
  } catch (err) {
    console.error('ws handler error', routeKey, err && err.message);
    return { statusCode: 500, body: 'error' };
  }
};
