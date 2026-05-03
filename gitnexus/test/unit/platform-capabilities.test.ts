import { describe, expect, it } from 'vitest';
import { isVectorExtensionSupportedByPlatform } from '../../src/core/platform/capabilities.js';

describe('platform capabilities', () => {
  it('keeps Ladybug VECTOR disabled by default on Windows', () => {
    expect(isVectorExtensionSupportedByPlatform('win32')).toBe(false);
  });

  it('allows VECTOR probing on Linux and macOS', () => {
    expect(isVectorExtensionSupportedByPlatform('linux')).toBe(true);
    expect(isVectorExtensionSupportedByPlatform('darwin')).toBe(true);
  });
});
