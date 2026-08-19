#!/usr/bin/env node
// [2026-08-19][feat] Background: claude.ai connectors probe OAuth discovery URLs before sending credentials; a 404 there breaks the connection and can trigger a 429 retry storm (mcp-servers shared rule).
// Business rules: only `/` and `/health` are public info routes; `/mcp` stays behind the X-API-Key header (with ?api_key fallback) checked in constant time; no OAuth issuer is implemented because this server gates with a static API key.
// Alternatives rejected: real OAuth metadata endpoints (no OAuth flow exists here) and SSE transport (stateless Streamable HTTP via createMcpHandler).
// Handling: absorb the 11 discovery GET paths and POST /register with empty {} 200 before auth, serve GET / service info, keep /mcp and 404 behavior unchanged.
// [2026-08-19][fix] A missing API key answers 401 (unauthenticated) and a present-but-wrong key answers 403 (authenticated identity rejected), matching the mcp-servers shared `checkApiKey` split in asana-mcp `src/run_with_auth.ts` (`checkApiKey` ~L131-136, call site ~L219-223).
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { isCompleteCredential, mergeCredential } from './auth/credential.js';
import { resolveGoogleCredential } from './auth/resolveCredential.js';
import { readTokenStore } from './auth/tokenStore.js';
import { SERVER_NAME, SERVER_VERSION, buildServer } from './serverFactory.js';

const DEFAULT_PORT = 8813;
const DEFAULT_HOST = '127.0.0.1';
const MAX_PORT = 65535;
const SHUTDOWN_GRACE_MS = 5000;
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_ERROR = 500;

const SERVER_DESCRIPTION = 'MCP server for Google Slides integration';

const OAUTH_DISCOVERY_GET_PATHS = new Set([
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-authorization-server/mcp',
  '/.well-known/oauth-authorization-server/sse',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-protected-resource/sse',
  '/.well-known/openid-configuration',
  '/.well-known/openid-configuration/mcp',
  '/.well-known/openid-configuration/sse',
  '/mcp/.well-known/openid-configuration',
  '/sse/.well-known/openid-configuration',
]);

const PUBLIC_PATHS = new Set(['/', '/health']);

type RequestContext = {
  handler: McpHttpHandler;
  apiKey: string;
  req: IncomingMessage;
  res: ServerResponse;
};

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
};

const matchesApiKey = (received: string, expected: string): boolean => {
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  if (expectedBuffer.length === 0 || expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, receivedBuffer);
};

type AuthOutcome = 'authorized' | 'missing' | 'mismatch';

const authorize = (req: IncomingMessage, url: URL, apiKey: string): AuthOutcome => {
  const headerValue = req.headers['x-api-key'];
  const headerKey = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof headerKey === 'string' && headerKey !== '') {
    return matchesApiKey(headerKey, apiKey) ? 'authorized' : 'mismatch';
  }
  const queryKey = url.searchParams.get('api_key');
  if (queryKey !== null && queryKey !== '') {
    return matchesApiKey(queryKey, apiKey) ? 'authorized' : 'mismatch';
  }
  return 'missing';
};

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });

const appendHeaderValue = (headers: Headers, key: string, value: string | string[] | undefined): void => {
  if (value === undefined) {
    return;
  }
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    headers.append(key, item);
  }
};

const toWebRequest = async (req: IncomingMessage, url: URL): Promise<Request> => {
  const method = req.method ?? 'GET';
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    appendHeaderValue(headers, key, value);
  }
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body = hasBody ? new Uint8Array(await readBody(req)) : undefined;
  return new Request(url, {
    method,
    headers,
    body,
  });
};

const sendWebResponse = (res: ServerResponse, response: Response): void => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, response.statusText, headers);
  if (response.body === null) {
    res.end();
    return;
  }
  const nodeStream = Readable.from(response.body);
  nodeStream.pipe(res);
  nodeStream.on('error', () => {
    res.destroy();
  });
};

const requestUrl = (req: IncomingMessage): URL => new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

const serveMcp = async (ctx: RequestContext, url: URL): Promise<void> => {
  const outcome = authorize(ctx.req, url, ctx.apiKey);
  if (outcome === 'missing') {
    sendJson(ctx.res, HTTP_UNAUTHORIZED, { error: 'unauthorized' });
    return;
  }
  if (outcome === 'mismatch') {
    sendJson(ctx.res, HTTP_FORBIDDEN, { error: 'forbidden' });
    return;
  }
  const webRequest = await toWebRequest(ctx.req, url);
  const webResponse = await ctx.handler.fetch(webRequest);
  sendWebResponse(ctx.res, webResponse);
};

const servePublicGet = (res: ServerResponse, pathname: string): void => {
  if (pathname === '/') {
    sendJson(res, HTTP_OK, {
      name: SERVER_NAME,
      description: SERVER_DESCRIPTION,
      version: SERVER_VERSION,
      endpoints: {
        '/health': 'Health check (no auth).',
        '/mcp': 'MCP Streamable HTTP endpoint (API key auth required).',
      },
    });
    return;
  }
  sendJson(res, HTTP_OK, { ok: true, name: SERVER_NAME, version: SERVER_VERSION });
};

const handleNodeRequest = async (ctx: RequestContext): Promise<void> => {
  const url = requestUrl(ctx.req);
  const method = ctx.req.method ?? 'GET';
  if (method === 'GET' && OAUTH_DISCOVERY_GET_PATHS.has(url.pathname)) {
    sendJson(ctx.res, HTTP_OK, {});
    return;
  }
  if (method === 'POST' && url.pathname === '/register') {
    sendJson(ctx.res, HTTP_OK, {});
    return;
  }
  if (method === 'GET' && PUBLIC_PATHS.has(url.pathname)) {
    servePublicGet(ctx.res, url.pathname);
    return;
  }
  if (url.pathname === '/mcp') {
    await serveMcp(ctx, url);
    return;
  }
  sendJson(ctx.res, HTTP_NOT_FOUND, { error: 'not found' });
};

const parsePort = (raw: string | undefined): number => {
  const parsed = Number.parseInt(raw ?? '', 10);
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_PORT;
  return valid ? parsed : DEFAULT_PORT;
};

const requireApiKey = (): string => {
  const apiKey = process.env.GOOGLE_SLIDES_MCP_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    console.error(
      'GOOGLE_SLIDES_MCP_API_KEY must be set to a non-empty value. The HTTP server refuses to start unauthenticated.'
    );
    process.exit(1);
  }
  return apiKey;
};

const resolveCredentialWithoutConsent = async () => {
  const stored = await readTokenStore();
  const merged = mergeCredential(stored);
  if (!isCompleteCredential(merged)) {
    console.error(
      'Google credential is incomplete. Run the stdio server once to finish the browser consent flow, or set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN. The HTTP server never opens the browser.'
    );
    process.exit(1);
  }
  return resolveGoogleCredential();
};

const start = async (): Promise<void> => {
  const apiKey = requireApiKey();
  const credential = await resolveCredentialWithoutConsent();

  const handler = createMcpHandler(() => buildServer(credential), {
    onerror: (error: Error) => {
      console.error('MCP handler error:', error.message);
    },
  });

  const port = parsePort(process.env.PORT);
  const host = process.env.HOST ?? DEFAULT_HOST;
  const server = createServer((req, res) => {
    handleNodeRequest({ handler, apiKey, req, res }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Request handling failed:', message);
      if (!res.headersSent) {
        sendJson(res, HTTP_INTERNAL_ERROR, { error: 'internal error' });
        return;
      }
      res.destroy();
    });
  });

  server.listen(port, host, () => {
    const address = server.address();
    const listeningPort = typeof address === 'object' && address !== null ? address.port : port;
    console.error(
      `Google Slides MCP HTTP server listening on http://${host}:${listeningPort} (stateless Streamable HTTP at POST /mcp, health at GET /health).`
    );
  });

  const shutdown = (): void => {
    handler.close().catch(() => undefined);
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => {
      process.exit(0);
    }, SHUTDOWN_GRACE_MS).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Failed to start Google Slides MCP HTTP server:', message);
  process.exit(1);
});
