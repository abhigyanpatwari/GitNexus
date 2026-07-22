import { describe, expect, it, vi } from 'vitest';

vi.mock('../gitnexus/src/mcp/local/pdg-impact.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, pdgStampForMode: vi.fn().mockResolvedValue(false) };
});

import { LocalBackend } from '../gitnexus/src/mcp/local/local-backend.js';

describe('hidden oracle: pdg_query missing sub-layer note', () => {
  it.each([
    ['controls', 'CDG'],
    ['flows', 'REACHING_DEF'],
  ] as const)("names the %s mode's %s sub-layer", async (mode, expectedLayer) => {
    const backend = Object.create(LocalBackend.prototype) as LocalBackend & {
      ensureInitialized: () => Promise<void>;
      _pdgQueryImpl: (repo: unknown, params: unknown) => Promise<Record<string, unknown>>;
    };
    backend.ensureInitialized = vi.fn().mockResolvedValue(undefined);

    const result = await backend._pdgQueryImpl(
      { lbugPath: '/unreachable-hidden-oracle-db' },
      { mode, target: 'src/example.ts' },
    );

    expect(result).toMatchObject({ mode, results: [], total: 0 });
    expect(String(result.note)).toContain(expectedLayer);
    expect(String(result.note)).toContain('gitnexus analyze --pdg');
  });
});
