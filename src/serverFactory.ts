// [2026-08-19][feat] Background: HTTP mode must expose the exact same tools as stdio, and each HTTP request builds a fresh server from the startup-resolved credential so no session state survives behind tunnel reconnects.
// Business rules: the Google credential is resolved once at startup (HTTP mode never opens the browser consent flow); tool definitions stay single-sourced here for both entrances.
// Alternatives rejected: per-session state and SSE transport (stateless createMcpHandler keeps the HTTP surface simple and restart-friendly).
// Handling: comment only — SERVER_NAME / SERVER_VERSION / slidesClient / buildServer exports and behavior are unchanged.
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
