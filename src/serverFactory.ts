import { McpServer } from '@modelcontextprotocol/server';
import { google, type slides_v1 } from 'googleapis';
import { setupToolHandlers } from './serverHandlers.js';
import type { GoogleCredential } from './auth/credential.js';

export const SERVER_NAME = 'google-slides-mcp';
export const SERVER_VERSION = '0.1.0';

export const slidesClient = (credential: GoogleCredential): slides_v1.Slides => {
  const oauth2Client = new google.auth.OAuth2(credential.clientId, credential.clientSecret);
  oauth2Client.setCredentials({
    refresh_token: credential.refreshToken,
  });
  return google.slides({
    version: 'v1',
    auth: oauth2Client,
  });
};

export const buildServer = (credential: GoogleCredential): McpServer => {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  setupToolHandlers(server, slidesClient(credential));
  return server;
};
