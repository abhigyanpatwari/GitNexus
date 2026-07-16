import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { glob } from 'glob';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('glob', () => ({ glob: vi.fn() }));
vi.mock('../../src/config/ignore-service.js', () => ({
  createIgnoreFilter: vi.fn(async () => []),
}));

import { walkRepositoryPaths } from '../../src/core/ingestion/filesystem-walker.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.mocked(glob).mockReset();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('walkRepositoryPaths ordering', () => {
  it('returns accepted files in canonical path order when glob order is unstable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-scan-order-'));
    temporaryRoots.push(root);
    await Promise.all(
      ['zeta.ts', 'alpha.ts', 'middle.ts'].map((file) =>
        fs.writeFile(path.join(root, file), `export const ${file[0]} = true;\n`),
      ),
    );
    vi.mocked(glob).mockResolvedValue(['zeta.ts', 'alpha.ts', 'middle.ts']);

    const result = await walkRepositoryPaths(root);

    expect(result.map((entry) => entry.path)).toEqual(['alpha.ts', 'middle.ts', 'zeta.ts']);
  });
});
