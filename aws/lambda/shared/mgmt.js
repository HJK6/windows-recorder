'use strict';

/*
 * mgmt.js — send a message down a desktop's WebSocket connection via the API
 * Gateway Management API (@connections). Only the delivery role may do this
 * (least privilege, spec §13). A GoneException means the connection is dead.
 */

const {
  ApiGatewayManagementApiClient, PostToConnectionCommand, GoneException,
} = require('@aws-sdk/client-apigatewaymanagementapi');

function createSender(endpoint) {
  const client = new ApiGatewayManagementApiClient({ endpoint });
  return async function postToConnection(connectionId, message) {
    try {
      await client.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(message)),
      }));
      return { delivered: true };
    } catch (err) {
      if (err instanceof GoneException || err.name === 'GoneException') {
        return { delivered: false, gone: true };
      }
      throw err;
    }
  };
}

module.exports = { createSender };
