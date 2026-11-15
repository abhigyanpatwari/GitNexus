import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { tsxLoaderUrl } from '../helpers/cli-entry.js';

it.each([0, 7])('delivers long argument lists intact and reports child status %i', (status) => {
  const root = mkdtempSync(path.join(tmpdir(), 'gitnexus runner & '));
  const files = Array.from(
    { length: 180 },
    (_, index) => `test/unit/path with spaces & (meta)/${'x'.repeat(35)}-${index}.test.ts`,
  );
  expect(files.join(' ').length).toBeGreaterThan(8191);
  try {
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    mkdirSync(path.join(root, 'node_modules/vitest'), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    for (const script of ['run-cross-platform.ts', 'shard-arg.ts']) {
      copyFileSync(
        new URL(`../../scripts/${script}`, import.meta.url),
        path.join(root, 'scripts', script),
      );
    }
    writeFileSync(
      path.join(root, 'scripts/cross-platform-tests.ts'),
      `export const ALL_CROSS_PLATFORM = ${JSON.stringify(files)};`,
    );
    for (const file of files) {
      const target = path.join(root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, '');
    }
    writeFileSync(
      path.join(root, 'node_modules/vitest/vitest.mjs'),
      `import { writeFileSync } from 'node:fs';
writeFileSync('received.json', JSON.stringify(process.argv.slice(2)));
process.exit(${status});`,
    );
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        tsxLoaderUrl(),
        path.join(root, 'scripts/run-cross-platform.ts'),
        '--shard=3/11',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, GITNEXUS_TEST_REPORT: 'receipt.json', npm_config_offline: 'true' },
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(status === 0 ? 0 : 1);
    expect(JSON.parse(readFileSync(path.join(root, 'received.json'), 'utf8'))).toEqual([
      'run',
      ...files,
      '--shard=3/11',
      '--reporter=default',
      '--reporter=./scripts/execution-reporter.ts',
      '--reporter=blob',
      '--outputFile.json=receipt.json',
      '--outputFile.blob=.vitest/blob/receipt.json',
    ]);
    if (status !== 0) expect(result.stderr).toContain(`vitest exited abnormally: status=${status}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
