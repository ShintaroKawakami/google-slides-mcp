// Spawns the compiled HTTP server (build/http.js) with dummy credentials, a temp
// XDG_CONFIG_HOME, and PORT=0, waits for the stderr listening line to learn the
// assigned port, then exercises the public/auth/404 surface over real HTTP.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_KEY = 'test-key';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HTTP_ENTRY = join(ROOT, 'build', 'http.js');
const LISTEN_TIMEOUT_MS = 20000;

const OAUTH_DISCOVERY_GET_PATHS = [
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
];

let child: ChildProcess | undefined;
let baseUrl = '';

const waitForListeningPort = (server: ChildProcess): Promise<number> =>
  new Promise((resolve, reject) => {
    const stderr = server.stderr;
    if (stderr === null) {
      reject(new Error('spawned server has no stderr pipe'));
      return;
    }
    let buffer = '';
    const finish = (): void => {
      clearTimeout(timer);
      stderr.off('data', onData);
      server.off('exit', onExit);
    };
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      const match = /listening on http:\/\/[^\s:]+:(\d+)/.exec(buffer);
      if (match) {
        finish();
        resolve(Number.parseInt(match[1], 10));
      }
    };
    const onExit = (): void => {
      finish();
      reject(new Error(`server exited before listening. stderr: ${buffer}`));
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error(`timed out waiting for the listening line. stderr: ${buffer}`));
    }, LISTEN_TIMEOUT_MS);
    stderr.on('data', onData);
    server.on('exit', onExit);
  });

const parseFirstSseFrame = (raw: string): unknown => {
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) {
      return JSON.parse(line.slice('data:'.length).trim()) as unknown;
    }
  }
  throw new Error(`no data frame in SSE payload: ${raw.slice(0, 200)}`);
};

const request = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> => {
  const response = await fetch(`${baseUrl}${path}`, init);
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (contentType.includes('text/event-stream')) {
    return { status: response.status, body: parseFirstSseFrame(text) };
  }
  if (contentType.includes('application/json')) {
    return { status: response.status, body: JSON.parse(text) as unknown };
  }
  return { status: response.status, body: text };
};

const jsonRpc = (id: number, method: string, params?: unknown): Record<string, unknown> => {
  const payload: Record<string, unknown> = { jsonrpc: '2.0', id, method };
  if (params !== undefined) {
    payload.params = params;
  }
  return payload;
};

const postJson = (payload: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify(payload),
});

before(async () => {
  const configHome = mkdtempSync(join(tmpdir(), 'google-slides-mcp-http-test-'));
  child = spawn(process.execPath, [HTTP_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      GOOGLE_SLIDES_MCP_API_KEY: API_KEY,
      GOOGLE_CLIENT_ID: 'dummy-client-id',
      GOOGLE_CLIENT_SECRET: 'dummy-client-secret',
      GOOGLE_REFRESH_TOKEN: 'dummy-refresh-token',
      XDG_CONFIG_HOME: configHome,
      PORT: '0',
      HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const port = await waitForListeningPort(child);
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });
});

describe('google-slides-mcp HTTP server', () => {
  it('GET /health answers 200 without auth', async () => {
    const { status, body } = await request('/health');
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true, name: 'google-slides-mcp', version: '0.1.0' });
  });

  it('GET on every OAuth discovery path answers empty 200 before auth', async () => {
    for (const path of OAUTH_DISCOVERY_GET_PATHS) {
      const { status, body } = await request(path);
      assert.equal(status, 200, path);
      assert.deepEqual(body, {}, path);
    }
  });

  it('POST /register answers empty 200 before auth', async () => {
    const { status, body } = await request('/register', { method: 'POST' });
    assert.equal(status, 200);
    assert.deepEqual(body, {});
  });

  it('GET / answers service info without auth', async () => {
    const { status, body } = await request('/');
    assert.equal(status, 200);
    const info = body as { name?: string; description?: string; version?: string; endpoints?: Record<string, string> };
    assert.equal(info.name, 'google-slides-mcp');
    assert.ok(typeof info.description === 'string' && info.description !== '');
    assert.ok(typeof info.version === 'string' && info.version !== '');
    assert.ok(info.endpoints !== undefined && '/health' in info.endpoints && '/mcp' in info.endpoints);
  });

  it('POST /mcp without an api key answers 401', async () => {
    const { status, body } = await request('/mcp', postJson(jsonRpc(1, 'tools/list')));
    assert.equal(status, 401);
    assert.deepEqual(body, { error: 'unauthorized' });
  });

  it('POST /mcp with a mismatched api key answers 401', async () => {
    const header = await request('/mcp', postJson(jsonRpc(1, 'tools/list'), { 'x-api-key': 'wrong-key' }));
    assert.equal(header.status, 401);
    assert.deepEqual(header.body, { error: 'unauthorized' });
    const query = await request(`/mcp?api_key=wrong-key`, postJson(jsonRpc(2, 'tools/list')));
    assert.equal(query.status, 401);
    assert.deepEqual(query.body, { error: 'unauthorized' });
  });

  it('POST /mcp with a matching X-API-Key answers initialize 200', async () => {
    const { status, body } = await request(
      '/mcp',
      postJson(
        jsonRpc(1, 'initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'http-test', version: '0.0.0' },
        }),
        { 'x-api-key': API_KEY }
      )
    );
    assert.equal(status, 200);
    const result = (body as { result?: { serverInfo?: { name?: string } } }).result;
    assert.ok(result !== undefined, 'initialize result is present');
    assert.equal(result?.serverInfo?.name, 'google-slides-mcp');
  });

  it('POST /mcp with a matching ?api_key answers tools/list 200', async () => {
    const { status, body } = await request(`/mcp?api_key=${API_KEY}`, postJson(jsonRpc(2, 'tools/list')));
    assert.equal(status, 200);
    const result = (body as { result?: { tools?: unknown[] } }).result;
    assert.ok(Array.isArray(result?.tools), 'tools is an array');
    assert.ok((result?.tools ?? []).length > 0, 'at least one tool is registered');
  });

  it('unknown paths answer 404', async () => {
    const get = await request('/no-such-path');
    assert.equal(get.status, 404);
    assert.deepEqual(get.body, { error: 'not found' });
    const getRegister = await request('/register');
    assert.equal(getRegister.status, 404);
  });
});
