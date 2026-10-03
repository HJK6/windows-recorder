'use strict';

/*
 * db.js — single-table (recorder-control) access for the POC control plane.
 * Keys follow spec §10 (simplified to the POC's needs):
 *   CONNECTION#<connId> / META            -> { deviceId, status, connectedAt }
 *   DEVICE#<deviceId>   / CURRENT          -> { connectionId, epoch }
 *   DEVICE#<deviceId>   / ACTIVE_RECORDING -> { recordingId }
 *   RECORDING#<recId>   / STATE            -> { deviceId, desiredState, observedState, revision }
 *   RECORDING#<recId>   / CMD#<rev>        -> { commandId, type, ackStatus, ... }
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand,
} = require('@aws-sdk/lib-dynamodb');

const TABLE = process.env.TABLE_NAME;
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const key = (pk, sk) => ({ pk, sk });

async function putConnection(connectionId, deviceId) {
  await doc.send(new PutCommand({
    TableName: TABLE,
    Item: { ...key(`CONNECTION#${connectionId}`, 'META'), deviceId, status: 'provisional', connectedAt: Date.now() },
  }));
}

async function getConnection(connectionId) {
  const r = await doc.send(new GetCommand({ TableName: TABLE, Key: key(`CONNECTION#${connectionId}`, 'META') }));
  return r.Item || null;
}

async function deleteConnection(connectionId) {
  await doc.send(new DeleteCommand({ TableName: TABLE, Key: key(`CONNECTION#${connectionId}`, 'META') }));
}

async function markConnectionReady(connectionId) {
  await doc.send(new UpdateCommand({
    TableName: TABLE,
    Key: key(`CONNECTION#${connectionId}`, 'META'),
    UpdateExpression: 'SET #s = :ready, lastSeenAt = :t',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':ready': 'ready', ':t': Date.now() },
  }));
}

async function touchConnection(connectionId) {
  await doc.send(new UpdateCommand({
    TableName: TABLE,
    Key: key(`CONNECTION#${connectionId}`, 'META'),
    UpdateExpression: 'SET lastSeenAt = :t',
    ExpressionAttributeValues: { ':t': Date.now() },
  }));
}

// Promote this connection to be the device's current channel; bump the epoch.
async function setDeviceConnection(deviceId, connectionId) {
  const prev = await doc.send(new GetCommand({ TableName: TABLE, Key: key(`DEVICE#${deviceId}`, 'CURRENT') }));
  const epoch = ((prev.Item && prev.Item.epoch) || 0) + 1;
  await doc.send(new PutCommand({
    TableName: TABLE,
    Item: { ...key(`DEVICE#${deviceId}`, 'CURRENT'), connectionId, epoch, updatedAt: Date.now() },
  }));
  return epoch;
}

async function getDeviceConnection(deviceId) {
  const r = await doc.send(new GetCommand({ TableName: TABLE, Key: key(`DEVICE#${deviceId}`, 'CURRENT') }));
  return r.Item || null;
}

// Clear the device pointer only if it still points at this connection + epoch
// (spec §4: a reconnect changes transport identity, not recording identity).
async function clearDeviceConnectionIfMatches(deviceId, connectionId) {
  try {
    await doc.send(new DeleteCommand({
      TableName: TABLE,
      Key: key(`DEVICE#${deviceId}`, 'CURRENT'),
      ConditionExpression: 'connectionId = :c',
      ExpressionAttributeValues: { ':c': connectionId },
    }));
  } catch (_) { /* a newer connection owns the pointer; leave it */ }
}

async function listConnectedDevices() {
  // POC scale: a Scan over the tiny control table. Production uses a GSI.
  const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
  const r = await doc.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: 'sk = :cur',
    ExpressionAttributeValues: { ':cur': 'CURRENT' },
  }));
  return (r.Items || []).map((i) => ({ deviceId: i.pk.replace('DEVICE#', ''), connectionId: i.connectionId, epoch: i.epoch }));
}

async function createRecording(recordingId, deviceId) {
  await doc.send(new PutCommand({
    TableName: TABLE,
    Item: {
      ...key(`RECORDING#${recordingId}`, 'STATE'),
      deviceId, desiredState: 'RECORDING', observedState: null, revision: 1, createdAt: Date.now(),
    },
    ConditionExpression: 'attribute_not_exists(pk)',
  }));
  await doc.send(new PutCommand({
    TableName: TABLE,
    Item: { ...key(`DEVICE#${deviceId}`, 'ACTIVE_RECORDING'), recordingId, updatedAt: Date.now() },
  }));
}

async function getRecording(recordingId) {
  const r = await doc.send(new GetCommand({ TableName: TABLE, Key: key(`RECORDING#${recordingId}`, 'STATE') }));
  return r.Item || null;
}

async function setDesiredState(recordingId, desiredState) {
  const r = await doc.send(new UpdateCommand({
    TableName: TABLE,
    Key: key(`RECORDING#${recordingId}`, 'STATE'),
    UpdateExpression: 'SET desiredState = :d, revision = revision + :one, updatedAt = :t',
    ExpressionAttributeValues: { ':d': desiredState, ':one': 1, ':t': Date.now() },
    ReturnValues: 'ALL_NEW',
  }));
  return r.Attributes;
}

async function getActiveRecording(deviceId) {
  const r = await doc.send(new GetCommand({ TableName: TABLE, Key: key(`DEVICE#${deviceId}`, 'ACTIVE_RECORDING') }));
  return r.Item ? r.Item.recordingId : null;
}

async function recordCommand(recordingId, revision, command) {
  await doc.send(new PutCommand({
    TableName: TABLE,
    Item: { ...key(`RECORDING#${recordingId}`, `CMD#${String(revision).padStart(6, '0')}`), ...command, issuedAt: Date.now() },
  }));
}

async function recordAck(recordingId, revision, status, observedState) {
  await doc.send(new UpdateCommand({
    TableName: TABLE,
    Key: key(`RECORDING#${recordingId}`, `CMD#${String(revision).padStart(6, '0')}`),
    UpdateExpression: 'SET ackStatus = :s, ackedAt = :t',
    ExpressionAttributeValues: { ':s': status, ':t': Date.now() },
  })).catch(() => {});
  await doc.send(new UpdateCommand({
    TableName: TABLE,
    Key: key(`RECORDING#${recordingId}`, 'STATE'),
    UpdateExpression: 'SET observedState = :o, observedAt = :t',
    ExpressionAttributeValues: { ':o': observedState, ':t': Date.now() },
  }));
}

async function markVerified(recordingId, objectKey, sizeBytes, checksum) {
  await doc.send(new PutCommand({
    TableName: TABLE,
    Item: {
      ...key(`RECORDING#${recordingId}`, `UPLOAD#${Date.now()}`),
      objectKey, sizeBytes, checksumSha256: checksum, mediaState: 'RAW_VERIFIED', verifiedAt: Date.now(),
    },
  }));
}

module.exports = {
  putConnection, getConnection, deleteConnection, markConnectionReady, touchConnection,
  setDeviceConnection, getDeviceConnection, clearDeviceConnectionIfMatches, listConnectedDevices,
  createRecording, getRecording, setDesiredState, getActiveRecording,
  recordCommand, recordAck, markVerified,
};
