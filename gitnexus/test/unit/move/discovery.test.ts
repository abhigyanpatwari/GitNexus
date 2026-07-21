import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('glob', () => ({ globIterate: vi.fn() }));

import { globIterate } from 'glob';
import { repoHasMove } from '../../../src/core/move/discovery.js';

const mockGlobIterate = vi.mocked(globIterate);

const results = async function* (values: string[]): AsyncGenerator<string> {
  yield* values;
};

describe('repoHasMove', () => {
  beforeEach(() => {
    mockGlobIterate.mockReset();
  });

  it('distinguishes an empty repository from a discovery failure', async () => {
    mockGlobIterate.mockReturnValueOnce(results([])).mockReturnValueOnce(
      (async function* () {
        throw new Error('permission denied');
      })(),
    );

    await expect(repoHasMove('/repo')).resolves.toBe(false);
    await expect(repoHasMove('/repo')).rejects.toThrow('permission denied');
  });

  it('reports Move when a manifest is found', async () => {
    mockGlobIterate.mockReturnValue(results(['contracts/Move.toml']));

    await expect(repoHasMove('/repo')).resolves.toBe(true);
  });
});
