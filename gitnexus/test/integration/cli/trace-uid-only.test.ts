/**
 * `gitnexus trace` must accept two exact UIDs without positional names, while
 * still rejecting an endpoint that has neither a name nor a UID. The dispatcher
 * used to declare `trace <from> <to>`, so Commander exited before traceCommand
 * could run.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLI_SPAWN_PREFIX } from '../../helpers/cli-entry.js';

function runTrace(args: string[]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-trace-uid-'));
  try {
    const r = spawnSync(process.execPath, [...CLI_SPAWN_PREFIX, 'trace', ...args], {
      env: { ...process.env, GITNEXUS_HOME: home, NODE_OPTIONS: '', CI: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { code: r.status, stderr: r.stderr ?? '' };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('CLI trace — UID-only endpoints', () => {
  it('does not fail argument parsing when both UIDs are supplied', () => {
    const { stderr } = runTrace([
      '--from-uid',
      'Function:a.ts:alpha',
      '--to-uid',
      'Function:a.ts:gamma',
    ]);
    expect(stderr).not.toContain('missing required argument');
    // Parsing succeeded, so the handler ran and hit the empty registry.
    expect(stderr).toContain('No indexed repositories found');
  }, 90_000);

  it('still prints usage when an endpoint has neither a name nor a UID', () => {
    const { code, stderr } = runTrace(['--from-uid', 'Function:a.ts:alpha']);
    expect(code).toBe(1);
    expect(stderr).toContain('Usage: gitnexus trace');
  }, 90_000);
});
