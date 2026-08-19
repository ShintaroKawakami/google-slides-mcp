# Environment variables

Single source of truth for every environment variable this server reads. stdio mode needs none of them — the token store is enough. HTTP mode requires an API key and a complete Google credential.

Deployed values live in `~/.config/agent-hub/.env` (the SSOT file loaded into the process environment by the service manager). Never commit real keys or tokens.

| Variable                    | Required            | Default       | Meaning                                                                                                                                                                     | Where the value lives                          |
| --------------------------- | ------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `GOOGLE_SLIDES_MCP_API_KEY` | HTTP yes, stdio n/a | —             | API key checked on every `/mcp` request (`X-API-Key` header, or `?api_key` query fallback). The HTTP server refuses to start (exit 1) when unset or empty.                    | `~/.config/agent-hub/.env` (SSOT); never commit |
| `PORT`                      | no                  | `8813`        | HTTP listen port. `0` binds an ephemeral free port; the actual port appears in the stderr `listening on` line.                                                                 | service manager env                             |
| `HOST`                      | no                  | `127.0.0.1`   | HTTP listen address. Keep it on loopback and let a tunnel connect locally.                                                                                                    | service manager env                             |
| `GOOGLE_CLIENT_ID`          | no                  | token store   | Overrides the OAuth client id from the token store. HTTP mode needs a complete credential at startup and never opens the browser.                                             | `~/.config/agent-hub/.env` (SSOT)               |
| `GOOGLE_CLIENT_SECRET`      | no                  | token store   | Overrides the OAuth client secret from the token store.                                                                                                                       | `~/.config/agent-hub/.env` (SSOT)               |
| `GOOGLE_REFRESH_TOKEN`      | no                  | token store   | Overrides the OAuth refresh token from the token store.                                                                                                                       | `~/.config/agent-hub/.env` (SSOT)               |

The token store defaults to the OS keychain, with `~/.config/google-slides-mcp/credential.json` (mode `0600`) as the file fallback. Env overrides win per field; a complete credential from any combination is persisted back to the store on stdio startup.

See [http-mode.md](http-mode.md) for the HTTP endpoints, auth behavior, and startup examples.
