#!/usr/bin/env node
/** Package-owned entrypoint for Claude-schema hooks (gitnexus-hook). */
const fs = require('fs');
const path = require('path');
const { acquireHookSlot } = require('./hook-lock.cjs');
const { runClaudeHook } = require('./claude-hook-runtime.cjs');

// The entrypoint always runs from its package, beside the CLI it invokes.
function resolveCliPath() {
  const fromEnv = process.env.GITNEXUS_HOOK_CLI_PATH;
  if (fromEnv !== undefined && String(fromEnv).trim() && fs.existsSync(String(fromEnv))) {
    return String(fromEnv);
  }
  let cliPath = path.resolve(__dirname, '..', '..', 'dist', 'cli', 'index.js');
  if (!fs.existsSync(cliPath)) {
    try {
      cliPath = require.resolve('gitnexus/dist/cli/index.js');
    } catch {
      cliPath = '';
    }
  }
  return cliPath;
}

function resolveCli() {
  const cliPath = resolveCliPath();
  return cliPath
    ? { command: process.execPath, args: [cliPath] }
    : {
        command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
        args: ['-y', 'gitnexus'],
        npx: true,
      };
}

runClaudeHook({ resolveCli, acquireHookSlot });
