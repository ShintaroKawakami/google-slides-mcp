#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { resolveGoogleCredential } from './auth/resolveCredential.js';
import { buildServer } from './serverFactory.js';

const start = async (): Promise<void> => {
  const credential = await resolveGoogleCredential();
  const handle = serveStdio(() => buildServer(credential));
  const shutdown = (): void => {
    handle
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.error('Google Slides MCP server running and connected via stdio.');
};

start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Failed to start Google Slides MCP server:', message);
  process.exit(1);
});
