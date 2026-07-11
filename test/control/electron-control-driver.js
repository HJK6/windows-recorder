'use strict';

const fs = require('node:fs/promises');
const { WebSocket } = require('ws');

const port = Number(process.env.HF_CONTROL_PORT);
const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'http://127.0.0.1:8788' });
const messages = [];
const waiters = [];

function receive(message) {
  messages.push(message);
  const index = messages.length - 1;
  if (message.type === 'event' && message.event === 'capture_error') {
    const error = new Error(`capture failed: ${message.data.reason || message.data.stage}`);
    for (const waiter of [...waiters]) waiter.reject(error);
  }
  for (const waiter of [...waiters]) {
    if (index < waiter.after || !waiter.predicate(message)) continue;
    waiters.splice(waiters.indexOf(waiter), 1);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }
}

function waitFor(predicate, label, after = 0, timeoutMs = 15000) {
  const existing = messages.slice(after).find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, reject, after, timer: null };
    waiter.timer = setTimeout(() => {
      waiters.splice(waiters.indexOf(waiter), 1);
      reject(new Error(`timed out waiting for ${label}`));
    }, timeoutMs);
    waiters.push(waiter);
  });
}

function send(message) { ws.send(JSON.stringify({ v: 1, ...message })); }
const isStateFor = (agent) => (message) => message.type === 'state'
  && message.session === 'online' && message.identity.agentId === agent;
const isActivatedFor = (agent) => (message) => message.type === 'event'
  && message.event === 'activated' && message.data.identity.agentId === agent;

ws.on('message', (raw) => receive(JSON.parse(raw.toString())));
ws.on('error', (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
ws.on('open', async () => {
  try {
    const first = messages.length;
    send({
      type: 'activate', requestId: 'stale-a', flexToken: 'mock-flex-delay600-a',
      context: { recordingKind: 'video' },
    });
    await waitFor((message) => message.type === 'state' && message.session === 'activating', 'A activating', first);
    send({ type: 'deactivate', requestId: 'cancel-a' });
    await waitFor((message) => message.type === 'event' && message.event === 'deactivated', 'A deactivated', first);
    send({
      type: 'activate', requestId: 'winner-b', flexToken: 'mock-flex-delay50-b',
      context: { recordingKind: 'video' },
    });
    await waitFor(isStateFor('mock-agent-delay50-b'), 'B online', first);
    await waitFor(isActivatedFor('mock-agent-delay50-b'), 'B activated', first);
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (messages.slice(first).some(isActivatedFor('mock-agent-delay600-a'))) {
      throw new Error('stale activation A emitted activated after B');
    }

    const second = messages.length;
    send({
      type: 'activate', requestId: 'stale-c', flexToken: 'mock-flex-delay100-c',
      context: { recordingKind: 'in_person' },
    });
    await waitFor((message) => message.type === 'state' && message.session === 'activating', 'C activating', second);
    send({ type: 'deactivate', requestId: 'cancel-c' });
    await waitFor((message) => message.type === 'event' && message.event === 'deactivated', 'C deactivated', second);
    send({
      type: 'activate', requestId: 'winner-d', flexToken: 'mock-flex-delay600-d',
      context: { recordingKind: 'call' },
    });
    const finalState = await waitFor(isStateFor('mock-agent-delay600-d'), 'D online', second);
    await waitFor(isActivatedFor('mock-agent-delay600-d'), 'D activated', second);
    if (messages.slice(second).some(isActivatedFor('mock-agent-delay100-c'))) {
      throw new Error('stale activation C emitted activated before D');
    }

    const firstRecording = messages.length;
    send({ type: 'command', action: 'start', requestId: 'start-1' });
    const started1 = await waitFor(
      (message) => message.type === 'event' && message.event === 'recording_started',
      'first recording_started', firstRecording,
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    send({ type: 'command', action: 'stop', requestId: 'stop-1' });
    await waitFor((message) => message.type === 'ack' && message.requestId === 'stop-1', 'first stop ack', firstRecording);
    send({ type: 'command', action: 'start', requestId: 'queued-start-2' });
    await waitFor((message) => message.type === 'ack' && message.requestId === 'queued-start-2', 'queued start ack', firstRecording);
    const metadata1 = await waitFor(
      (message) => message.type === 'event' && message.event === 'metadata_written'
        && message.data.recordingId === started1.data.recordingId,
      'first metadata', firstRecording,
    );
    const started2 = await waitFor(
      (message) => message.type === 'event' && message.event === 'recording_started'
        && message.data.recordingId !== started1.data.recordingId,
      'queued second recording_started', firstRecording,
    );
    if (messages.indexOf(started2) < messages.indexOf(metadata1)) {
      throw new Error('queued recording started before prior upload finalized');
    }

    await new Promise((resolve) => setTimeout(resolve, 1200));
    const secondRecording = messages.length;
    send({ type: 'command', action: 'stop', requestId: 'stop-2' });
    await waitFor((message) => message.type === 'ack' && message.requestId === 'stop-2', 'second stop ack', secondRecording);
    send({ type: 'deactivate', requestId: 'final-deactivate' });
    const metadata2 = await waitFor(
      (message) => message.type === 'event' && message.event === 'metadata_written'
        && message.data.recordingId === started2.data.recordingId,
      'second metadata', secondRecording,
    );
    const deactivated = await waitFor(
      (message) => message.type === 'event' && message.event === 'deactivated',
      'final deactivated', secondRecording,
    );
    if (messages.indexOf(deactivated) < messages.indexOf(metadata2)) {
      throw new Error('session deactivated before second metadata completed');
    }

    await fs.writeFile(process.env.HF_HARNESS_EXPECT, JSON.stringify({
      sessionId: finalState.sessionId,
      agentId: finalState.identity.agentId,
      recordingIds: [started1.data.recordingId, started2.data.recordingId],
    }));
    process.stdout.write('ELECTRON CONTROL PASS stale-activation and two-recording finalization\n');
    ws.close();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.stderr.write(`${JSON.stringify(messages.map((message) => ({
      type: message.type, event: message.event, requestId: message.requestId,
      session: message.session, identity: message.identity, recorder: message.recorder, data: message.data,
    })))}\n`);
    ws.close();
    process.exitCode = 1;
  }
});
