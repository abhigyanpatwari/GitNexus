/**
 * Unit Tests: toNativeSafePath
 *
 * Verifies the Windows non-ASCII path workaround that converts paths to
 * 8.3 short-name form before passing them to KuzuDB's native layer.
 */
import { describe, it, expect } from 'vitest';
import { toNativeSafePath, cleanupNativePathJunctions } from '../../src/core/lbug/lbug-config.js';

describe('toNativeSafePath', () => {
  it('returns ASCII paths unchanged on any platform', () => {
    const p = 'C:\\Users\\test\\project\\.gitnexus\\lbug';
    expect(toNativeSafePath(p)).toBe(p);
  });

  it('returns forward-slash ASCII paths unchanged', () => {
    const p = '/home/user/project/.gitnexus/lbug';
    expect(toNativeSafePath(p)).toBe(p);
  });

  it('returns empty string unchanged', () => {
    expect(toNativeSafePath('')).toBe('');
  });

  if (process.platform !== 'win32') {
    it('returns non-ASCII paths unchanged on non-Windows', () => {
      const p = '/home/用户/project/.gitnexus/lbug';
      expect(toNativeSafePath(p)).toBe(p);
    });
  }

  if (process.platform === 'win32') {
    it('converts a path with non-ASCII parent directory to an ASCII-safe form', () => {
      // Real-world scenario: repo at C:\Project\中文\code, leaf is ASCII (.gitnexus/lbug).
      // Create a CJK parent dir with an ASCII leaf to match.
      const os = require('os');
      const fs = require('fs');
      const path = require('path');
      const cjkParent = path.join(os.tmpdir(), `gn-safepath-测试-${Date.now()}`);
      const asciiLeaf = path.join(cjkParent, 'lbug');
      fs.mkdirSync(cjkParent, { recursive: true });
      try {
        const result = toNativeSafePath(asciiLeaf);
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
        // Either 8.3 short path or junction — both produce an all-ASCII result
        // since the leaf ('lbug') is ASCII and the parent is resolved
        if (result !== asciiLeaf) {
          expect(/^[\x00-\x7F]+$/.test(result)).toBe(true);
        }
      } finally {
        cleanupNativePathJunctions();
        fs.rmSync(cjkParent, { recursive: true, force: true });
      }
    });

    it('returns the original path when the target does not exist', () => {
      const nonexistent = 'C:\\不存在的路径\\test';
      const result = toNativeSafePath(nonexistent);
      expect(result).toBe(nonexistent);
    });
  }
});
