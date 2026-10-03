'use strict';

/*
 * authorizer/index.js — API Gateway WebSocket $connect REQUEST authorizer.
 * Validates the desktop's Bearer device token (HS256 signature, expiry, and
 * scope=device) and fails CLOSED. It is NOT an accept-any authorizer. The
 * device identity is passed to the $connect integration via context.
 *
 * API Gateway WS authorizers run on $connect only (spec §4 [S3]); each message
 * handler re-checks authorization separately.
 */

const jwt = require('../shared/jwt');

const SECRET = process.env.TOKEN_SIGNING_SECRET;

function deny(reason) {
  // Returning an explicit Deny (or throwing 'Unauthorized') blocks the upgrade.
  const err = new Error('Unauthorized');
  err.reason = reason;
  throw err;
}

exports.handler = async (event) => {
  const header = (event.headers && (event.headers.Authorization || event.headers.authorization))
    || (event.queryStringParameters && event.queryStringParameters.access_token)
    || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  const result = jwt.verify(token, SECRET);
  if (!result.valid) deny(result.reason || 'invalid_token');
  if (!jwt.hasScope(result.payload, 'device')) deny('wrong_scope');

  const deviceId = result.payload.sub;
  return {
    principalId: deviceId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{ Action: 'execute-api:Invoke', Effect: 'Allow', Resource: event.methodArn }],
    },
    context: { deviceId, authExp: String(result.payload.exp) },
  };
};
