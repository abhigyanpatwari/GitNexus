import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createTempDir } from '../../../../test/helpers/test-db.js';

test(
  'rejects a FIFO promptly instead of blocking on open',
  { skip: process.platform === 'win32', timeout: 30_000 },
  async (t) => {
    const repo = await createTempDir('gn-rc-repo-');
    t.after(repo.cleanup);
    const outside = await createTempDir('gn-rc-fifo-');
    t.after(outside.cleanup);
    const fifo = path.join(outside.dbPath, 'rc.fifo');
    execFileSync('mkfifo', [fifo]);
    const script = path.join(outside.dbPath, 'load.mts');
    const module = new URL('../../../../dist/cli/analyze-config.js', import.meta.url).href;
    await writeFile(
      script,
      `import { loadAnalyzeConfig } from ${JSON.stringify(module)};\n` +
        `try { loadAnalyzeConfig(${JSON.stringify(repo.dbPath)}); console.log('loaded'); }\n` +
        `catch (error) { console.log(String((error as Error).message)); }\n`,
    );
    const output = execFileSync(process.execPath, ['--import', 'tsx', script], {
      env: { ...process.env, GITNEXUS_RC: fifo },
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.match(output, /not a regular file/);
  },
);
