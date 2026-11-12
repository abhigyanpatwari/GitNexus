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
  const cliPath = path.resolve(__dirname, '..', '..', 'dist', 'cli', 'index.js');
  return fs.existsSync(cliPath) ? cliPath : '';
}

function resolveCli() {
  const cliPath = resolveCliPath();
  return cliPath ? { command: process.execPath, args: [cliPath] } : null;
}

runClaudeHook({ resolveCli, acquireHookSlot });
