import { describe, expect, it, vi } from 'vitest';

import { getQueryRows } from './query-result';

describe('getQueryRows', () => {
  it('prefers getAllObjects when available', async () => {
    const rows = [{ name: 'foo' }];
    const getAllObjects = vi.fn().mockResolvedValue(rows);
    const getAllRows = vi.fn().mockResolvedValue([{ name: 'bar' }]);
    const getAll = vi.fn().mockResolvedValue([['baz']]);

    await expect(getQueryRows({ getAllObjects, getAllRows, getAll })).resolves.toEqual(rows);

    expect(getAllObjects).toHaveBeenCalledTimes(1);
    expect(getAllRows).not.toHaveBeenCalled();
    expect(getAll).not.toHaveBeenCalled();
  });

  it('falls back to getAllRows when getAllObjects is absent', async () => {
    const rows = [{ name: 'bar' }];
    const getAllRows = vi.fn().mockResolvedValue(rows);
    const getAll = vi.fn().mockResolvedValue([['baz']]);

    await expect(getQueryRows({ getAllRows, getAll })).resolves.toEqual(rows);

    expect(getAllRows).toHaveBeenCalledTimes(1);
    expect(getAll).not.toHaveBeenCalled();
  });

  it('falls back to getAll as a final fallback', async () => {
    const rows = [['baz']];
    const getAll = vi.fn().mockResolvedValue(rows);

    await expect(getQueryRows({ getAll })).resolves.toEqual(rows);
    expect(getAll).toHaveBeenCalledTimes(1);
  });

  it('throws when no supported query API is exposed', async () => {
    await expect(getQueryRows({})).rejects.toThrow('Unsupported LadybugDB QueryResult shape');
  });
});
