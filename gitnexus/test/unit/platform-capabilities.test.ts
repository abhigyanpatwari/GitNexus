import { describe, expect, it } from 'vitest';
import {
  getRuntimeCapabilities,
  getRuntimeFingerprint,
} from '../../src/core/platform/capabilities.js';

describe('platform capabilities', () => {
  it('reports VECTOR as platform-available everywhere, Windows included (#2623 follow-up)', () => {
    // LadybugDB ships win_amd64 VECTOR artifacts for every 0.18.x extension
    // version, so no platform is categorically excluded any more. Whether the
    // extension actually LOADS on a machine is a runtime question answered by
    // probeVectorExtensionLoad (doctor) and loadVectorExtension (analyze).
    const caps = getRuntimeCapabilities();
    expect(caps.vector).toBe('available');
    expect(caps.semanticMode).toBe('vector-index');
    expect(caps.reason).toBeUndefined();
  });

  it('resolves the LadybugDB version even though @ladybugdb/core exports omit ./package.json (#2374)', () => {
    expect(getRuntimeFingerprint().ladybugdb).toMatch(/^\d+\.\d+\.\d+/);
  });
});
