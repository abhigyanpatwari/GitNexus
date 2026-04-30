import { describe, expect, it, vi } from 'vitest';
import { collectGroupStatusesForApi } from '../../src/server/api.js';

describe('collectGroupStatusesForApi', () => {
  it('filters group statuses to groups containing the requested repo', async () => {
    const groupList = vi.fn(async (params: Record<string, unknown>) => {
      if (!params.name) return { groups: ['product', 'infra'] };
      if (params.name === 'product') {
        return { name: 'product', repos: { 'app/backend': 'api', 'app/frontend': 'web' } };
      }
      return { name: 'infra', repos: { 'ops/worker': 'worker' } };
    });
    const groupStatus = vi.fn(async (params: Record<string, unknown>) => ({
      group: params.name,
      summary: { contractsStale: true },
    }));

    const result = await collectGroupStatusesForApi({ groupList, groupStatus }, 'web');

    expect(result.errors).toEqual([]);
    expect(result.groups).toEqual([{ group: 'product', summary: { contractsStale: true } }]);
    expect(groupStatus).toHaveBeenCalledTimes(1);
    expect(groupStatus).toHaveBeenCalledWith({ name: 'product' });
  });

  it('returns per-group errors without failing the whole response', async () => {
    const groupList = vi.fn(async (params: Record<string, unknown>) => {
      if (!params.name) return { groups: ['good', 'bad'] };
      return { name: params.name, repos: { app: 'repo' } };
    });
    const groupStatus = vi.fn(async (params: Record<string, unknown>) =>
      params.name === 'bad' ? { error: 'contracts.json is invalid' } : { group: 'good' },
    );

    const result = await collectGroupStatusesForApi({ groupList, groupStatus });

    expect(result.groups).toEqual([{ group: 'good' }]);
    expect(result.errors).toEqual([{ group: 'bad', error: 'contracts.json is invalid' }]);
  });
});
