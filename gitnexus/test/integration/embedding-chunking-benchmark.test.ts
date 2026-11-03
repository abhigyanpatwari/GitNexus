import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

const baseline = process.env.GITNEXUS_CHUNK_BASELINE_REPO;
const enabled = process.env.GITNEXUS_BENCH === '1' && Boolean(baseline);

// A paired result needs an actual pinned baseline build, not a copied old
// algorithm inside the test. No timing threshold is used on shared CI hosts.
it.skipIf(!enabled)(
  'records paired embedding chunking and real-model timings',
  async () => {
    const repo = fileURLToPath(new URL('../../../', import.meta.url));
    const output =
      process.env.GITNEXUS_CHUNK_BENCH_RESULT ??
      path.join(tmpdir(), `gitnexus-chunk-bench-${process.pid}.json`);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--expose-gc',
        path.join(repo, 'gitnexus/scripts/benchmark-embedding-chunking.mjs'),
        baseline!,
        repo,
        output,
      ],
      { maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GITNEXUS_EMBEDDING_URL: '' } },
    );
    const result = JSON.parse(await readFile(output, 'utf8'));
    for (const pairs of Object.values(result.samples) as unknown[][])
      expect(pairs.length).toBeGreaterThanOrEqual(15);
    console.log(stdout);
    console.log(`Raw paired samples: ${output}`);
  },
  600_000,
);
