#!/usr/bin/env node
// [2026-08-19][feat] Background: hosts that cannot spawn processes (claude.ai over a Cloudflare Tunnel) need an always-on HTTP entrance; this launcher mirrors bin/start-mcp.js by installing deps and compiling into the plugin data dir, never into the repo.
// Business rules: GOOGLE_SLIDES_MCP_API_KEY must come from the caller's environment (values sourced from the ~/.config/agent-hub/.env SSOT); the repo stays source-only with no committed build output.
// Alternatives rejected: shipping prebuilt build/ output and compiling into the repo (plugin data dir keeps installs reproducible per package-lock hash).
// Handling: install only when package.json / lock hashes change, compile, then spawn build/http.js with inherited stdio and forward exit code/signal.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? dirname(fileURLToPath(new URL('..', import.meta.url)));
const pluginData = process.env.CLAUDE_PLUGIN_DATA ?? join(homedir(), '.claude', 'plugins', 'data', 'google-slides-mcp');

const sameText = (left, right) =>
  existsSync(left) && existsSync(right) && readFileSync(left, 'utf8') === readFileSync(right, 'utf8');

const runQuiet = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    stdio: ['ignore', process.stderr, process.stderr],
  });
  return result.status ?? 1;
};

const installDeps = () => {
  mkdirSync(pluginData, { recursive: true });
  const srcPkg = join(pluginRoot, 'package.json');
  const dstPkg = join(pluginData, 'package.json');
  const srcLock = join(pluginRoot, 'package-lock.json');
  const dstLock = join(pluginData, 'package-lock.json');
  if (sameText(srcPkg, dstPkg) && sameText(srcLock, dstLock) && existsSync(join(pluginData, 'node_modules'))) {
    return;
  }
  copyFileSync(srcPkg, dstPkg);
  copyFileSync(srcLock, dstLock);
  const status = runQuiet('npm', ['ci'], pluginData);
  if (status !== 0) {
    process.exit(status);
  }
};

const compile = () => {
  const tsc = join(pluginData, 'node_modules', '.bin', 'tsc');
  const status = runQuiet(
    tsc,
    [
      '-p',
      join(pluginRoot, 'tsconfig.json'),
      '--outDir',
      join(pluginData, 'build'),
      '--rootDir',
      join(pluginRoot, 'src'),
    ],
    pluginRoot
  );
  if (status !== 0) {
    process.exit(status);
  }
};

installDeps();
compile();
const child = spawn(process.execPath, [join(pluginData, 'build', 'http.js')], {
  stdio: 'inherit',
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
