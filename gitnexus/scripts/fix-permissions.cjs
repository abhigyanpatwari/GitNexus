#!/usr/bin/env node
/**
 * Post-install script to fix executable permissions on Unix systems.
 * npm preserves file permissions from the published tarball, but if the
 * source files were committed without +x, the installed CLI and hooks
 * won't be executable (#330).
 *
 * This script is a no-op on Windows (where chmod is not applicable).
 */
'use strict';

const { chmodSync, existsSync } = require('fs');
const { join } = require('path');

// Only fix permissions on Unix-like systems
if (process.platform === 'win32') {
  process.exit(0);
}

const root = join(__dirname, '..');

const files = [
  'dist/cli/index.js',
  'hooks/claude/pre-tool-use.sh',
  'hooks/claude/session-start.sh',
  'hooks/claude/gitnexus-hook.cjs',
];

for (const file of files) {
  const fullPath = join(root, file);
  if (existsSync(fullPath)) {
    try {
      chmodSync(fullPath, 0o755);
    } catch {
      // Best-effort — don't fail install on permission errors
    }
  }
}
