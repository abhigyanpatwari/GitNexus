/**
 * Unit Tests: toNativeSafePath
 *
 * Verifies the Windows non-ASCII path workaround that converts paths to
 * 8.3 short-name form before passing them to KuzuDB's native layer.
 */
import { describe, it, expect } from 'vitest';
import { toNativeSafePath } from '../../src/core/lbug/lbug-config.js';

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
    it('attempts short-path conversion for non-ASCII paths on Windows', () => {
      // Use os.tmpdir() which exists — create a subdir with CJK chars,
      // then verify toNativeSafePath either converts it or falls back.
      const os = require('os');
      const fs = require('fs');
      const path = require('path');

      const tmpBase = path.join(os.tmpdir(), `gn-safepath-测试-${Date.now()}`);
      fs.mkdirSync(tmpBase, { recursive: true });
      try {
        const result = toNativeSafePath(tmpBase);
        // Either converted to a short path (all ASCII) or fell back to original
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
        // If 8.3 names are enabled, the result should be all-ASCII
        if (result !== tmpBase) {
          expect(/^[\x00-\x7F]+$/.test(result)).toBe(true);
        }
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    it('returns the original path when the target does not exist', () => {
      const nonexistent = 'C:\\不存在的路径\\test';
      const result = toNativeSafePath(nonexistent);
      expect(result).toBe(nonexistent);
    });
  }
});
