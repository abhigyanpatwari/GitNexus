import { describe, expect, it } from 'vitest';
import {
  getRuntimeFingerprint,
  isVectorExtensionSupportedByPlatform,
} from '../../src/core/platform/capabilities.js';

describe('platform capabilities', () => {
  it('keeps Ladybug VECTOR disabled by default on Windows', () => {
    expect(isVectorExtensionSupportedByPlatform('win32')).toBe(false);
  });

  it('allows VECTOR probing on Linux and macOS', () => {
    expect(isVectorExtensionSupportedByPlatform('linux')).toBe(true);
    expect(isVectorExtensionSupportedByPlatform('darwin')).toBe(true);
  });

  it('resolves the LadybugDB version even though @ladybugdb/core exports omit ./package.json (#2374)', () => {
    expect(getRuntimeFingerprint().ladybugdb).toMatch(/^\d+\.\d+\.\d+/);
  });
});
