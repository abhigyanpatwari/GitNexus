/**
 * Streaming PDG-emit config gating (issue #2202 U3).
 *
 * Verifies:
 *  - `resolveStreamPdgEmit` engages only when pdg + full-rebuild (force) + an
 *    enable signal (explicit option OR GITNEXUS_STREAM_PDG_EMIT) all hold;
 *  - `resolvePdgEmitChunkSize` prefers the explicit option, falls back to
 *    GITNEXUS_PDG_EMIT_CHUNK_SIZE, else undefined;
 *  - the memory-only streaming knobs are NOT stamped into RepoMeta.pdg, so
 *    changing them never trips `pdgModeMismatch` (would force needless full
 *    writebacks otherwise).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  resolveStreamPdgEmit,
  resolvePdgEmitChunkSize,
  pdgModeMismatch,
  resolvePdgConfig,
} from '../../src/core/run-analyze.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveStreamPdgEmit — gating', () => {
  it('engages only with pdg + force + an enable signal', () => {
    // explicit option
    expect(resolveStreamPdgEmit({ pdg: true, force: true, streamPdgEmit: true })).toBe(true);
    // env toggle
    vi.stubEnv('GITNEXUS_STREAM_PDG_EMIT', '1');
    expect(resolveStreamPdgEmit({ pdg: true, force: true })).toBe(true);
  });

  it('does NOT engage without --force (incremental writeback reads BasicBlocks back)', () => {
    expect(resolveStreamPdgEmit({ pdg: true, force: false, streamPdgEmit: true })).toBe(false);
    expect(resolveStreamPdgEmit({ pdg: true, streamPdgEmit: true })).toBe(false);
  });

  it('does NOT engage without --pdg (nothing to stream)', () => {
    expect(resolveStreamPdgEmit({ pdg: false, force: true, streamPdgEmit: true })).toBe(false);
  });

  it('does NOT engage with no enable signal', () => {
    expect(resolveStreamPdgEmit({ pdg: true, force: true })).toBe(false);
    vi.stubEnv('GITNEXUS_STREAM_PDG_EMIT', '0');
    expect(resolveStreamPdgEmit({ pdg: true, force: true })).toBe(false);
  });
});

describe('resolvePdgEmitChunkSize', () => {
  it('prefers the explicit option over the env var', () => {
    vi.stubEnv('GITNEXUS_PDG_EMIT_CHUNK_SIZE', '128');
    expect(resolvePdgEmitChunkSize({ pdgEmitChunkSize: 999 })).toBe(999);
  });

  it('falls back to the env var, then to undefined', () => {
    vi.stubEnv('GITNEXUS_PDG_EMIT_CHUNK_SIZE', '128');
    expect(resolvePdgEmitChunkSize({})).toBe(128);
    vi.unstubAllEnvs();
    expect(resolvePdgEmitChunkSize({})).toBeUndefined();
  });

  it('rejects non-positive / non-integer env values (falls back to undefined)', () => {
    for (const bad of ['0', '-5', 'abc', '1.5', '']) {
      vi.stubEnv('GITNEXUS_PDG_EMIT_CHUNK_SIZE', bad);
      expect(resolvePdgEmitChunkSize({})).toBeUndefined();
    }
  });

  it('rejects an explicit non-positive option (0/negative is not nullish — would defeat buffering)', () => {
    expect(resolvePdgEmitChunkSize({ pdgEmitChunkSize: 0 })).toBeUndefined();
    expect(resolvePdgEmitChunkSize({ pdgEmitChunkSize: -10 })).toBeUndefined();
    // ...but an explicit 0 still falls back to a valid env value when present.
    vi.stubEnv('GITNEXUS_PDG_EMIT_CHUNK_SIZE', '256');
    expect(resolvePdgEmitChunkSize({ pdgEmitChunkSize: 0 })).toBe(256);
  });
});

describe('streaming knobs are NOT emit-affecting (no pdgModeMismatch)', () => {
  it('changing streamPdgEmit / pdgEmitChunkSize does not trip pdgModeMismatch', () => {
    const base = { pdg: true as const };
    const recorded = resolvePdgConfig(base);
    // Same pdg config, but with the streaming knobs flipped — must NOT mismatch.
    expect(
      pdgModeMismatch(recorded, {
        ...base,
        streamPdgEmit: true,
        pdgEmitChunkSize: 64,
      } as Parameters<typeof pdgModeMismatch>[1]),
    ).toBe(false);
  });

  it('streaming knobs are absent from the resolved RepoMeta.pdg stamp', () => {
    const stamp = resolvePdgConfig({ pdg: true });
    expect(stamp).toBeDefined();
    expect(stamp).not.toHaveProperty('streamPdgEmit');
    expect(stamp).not.toHaveProperty('pdgEmitChunkSize');
  });
});
