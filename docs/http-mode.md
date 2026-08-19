# HTTP mode (self-hosted)

The server has two entrances. stdio (`build/index.js`) is the default and unchanged. HTTP mode (`build/http.js`) exposes the same tools over [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) for hosts that cannot spawn a local process — for example an always-on home server reached through a Cloudflare Tunnel from claude.ai, Claude Code, Codex, or Hermes.

## Start

```bash
npm run build
GOOGLE_SLIDES_MCP_API_KEY=<KEY> npm run start:http
```

Or via the bin script (installs deps and compiles first, like `bin/start-mcp.js`):

```bash
GOOGLE_SLIDES_MCP_API_KEY=<KEY> bin/start-http.js
```

Stderr prints one line on start:

```
Google Slides MCP HTTP server listening on http://127.0.0.1:8813 (stateless Streamable HTTP at POST /mcp, health at GET /health).
```

Nothing is written to stdout.

## Environment variables

| Variable                    | Required | Default     | Meaning                                                                              |
| --------------------------- | -------- | ----------- | ------------------------------------------------------------------------------------ |
| `GOOGLE_SLIDES_MCP_API_KEY` | yes      | —           | API key checked on every `/mcp` request. Startup fails (exit 1) when unset or empty. |
| `PORT`                      | no       | `8813`      | Listen port.                                                                         |
| `HOST`                      | no       | `127.0.0.1` | Listen address. Keep loopback and let the tunnel connect locally.                    |
| `GOOGLE_CLIENT_ID`          | no       | token store | Overrides the client id from the token store.                                        |
| `GOOGLE_CLIENT_SECRET`      | no       | token store | Overrides the client secret from the token store.                                    |
| `GOOGLE_REFRESH_TOKEN`      | no       | token store | Overrides the refresh token from the token store.                                    |

## Endpoints

- `GET /health` — no auth. `200` with `{"ok":true,"name":"google-slides-mcp","version":"0.1.0"}`.
- `POST /mcp` — Streamable HTTP, stateless. Auth required.
- Every other path — `404` with a JSON body.

The `/mcp` endpoint is mounted stateless, following the SDK v2 `createMcpHandler` serving entry: each request is served by a fresh server instance built from the same tool definitions, no session id is issued, and `GET`/`DELETE` on `/mcp` (stateless session operations) answer `405`. Responses stream as SSE when the client accepts `text/event-stream`, plain JSON otherwise.

## Authentication

Every `/mcp` request must present the API key configured in `GOOGLE_SLIDES_MCP_API_KEY`:

1. `X-API-Key: <KEY>` request header (preferred).
2. `?api_key=<KEY>` query string fallback — for hosts such as claude.ai that cannot set custom headers.

Header takes precedence when both are present. Comparison is length-checked and constant-time. A missing, empty, or mismatched key answers `401` with a JSON body. `/health` is the only unauthenticated route. An unset or empty `GOOGLE_SLIDES_MCP_API_KEY` makes the process refuse to start (exit 1) so the server can never come up unauthenticated.

Generate a key once, for example with `openssl rand -hex 32`, and store it in your service manager environment. Never commit it.

## Google credential

HTTP mode resolves the Google credential once at startup and reuses it for every request. It never opens the browser consent flow:

- If the token store (keychain, or `~/.config/google-slides-mcp/credential.json`) plus env overrides form a complete credential, startup proceeds.
- If the credential is incomplete, the process prints an error and exits (exit 1). Complete the consent once by running the stdio server (`npm run start`) on a machine with a browser, or set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN`.

## Examples

Health check:

```bash
curl -s http://127.0.0.1:8813/health
```

Initialize (header auth):

```bash
curl -s -X POST http://127.0.0.1:8813/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'X-API-Key: <KEY>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0.0.0"}}}'
```

List tools (query-string fallback auth):

```bash
curl -s -X POST 'http://127.0.0.1:8813/mcp?api_key=<KEY>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

A successful initialize answers `200` with an SSE `event: message` frame carrying the result. With `--max-time` unset the stream may stay open after the frame; that is normal for Streamable HTTP.

## Cloudflare Tunnel notes

Point the tunnel at the local listener (`http://127.0.0.1:8813`). Keep `HOST` on loopback so the port is not exposed directly. TLS terminates at the tunnel; the API key remains the gate on `/mcp`. Health checks can probe `GET /health` through the tunnel without a key.
