import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getAnalyzeReexecArgv } from '../../src/cli/analyze.js';

describe('getAnalyzeReexecArgv', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves symlinked CLI entrypoints to their real path', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-analyze-'));
    tempDirs.push(tempDir);

    const realEntry = path.join(tempDir, 'dist', 'cli', 'index.js');
    const symlinkEntry = path.join(tempDir, 'bin', 'gitnexus');
    fs.mkdirSync(path.dirname(realEntry), { recursive: true });
    fs.mkdirSync(path.dirname(symlinkEntry), { recursive: true });
    fs.writeFileSync(realEntry, '#!/usr/bin/env node\n');
    fs.symlinkSync(realEntry, symlinkEntry);

    expect(
      getAnalyzeReexecArgv(['/usr/bin/node', symlinkEntry, 'analyze', '--no-stats', '/tmp/repo']),
    ).toEqual([realEntry, 'analyze', '--no-stats', '/tmp/repo']);
  });

  it('preserves the original entry when realpath resolution fails', () => {
    expect(getAnalyzeReexecArgv(['/usr/bin/node', '/missing/bin/gitnexus', 'analyze'])).toEqual([
      '/missing/bin/gitnexus',
      'analyze',
    ]);
  });
});
