/**
 * `isInside` containment guard — cross-drive Windows correctness.
 *
 * `path.relative` cannot express a relative path between two Windows drives, so
 * it returns the absolute target. Without an `isAbsolute` rejection the `..`
 * checks alone classify an unrelated drive as *inside* the parent, which in this
 * module meant `resolveInvokedArtifact` adopting an out-of-tree file as the
 * invoked analyzer artifact — that file is then absent from the validated build
 * and identity resolution throws, so `analyze`/`status` fail outright on a
 * multi-drive Windows install.
 *
 * The `pathApi` argument makes the win32 semantics testable from a POSIX runner,
 * so these assertions are meaningful on every CI platform (no fixture, no fs).
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { _isInsideForTests as isInside } from '../../src/core/analyzer-identity.js';

describe('isInside — Windows cross-drive containment', () => {
  it('rejects a candidate on a different drive', () => {
    // Regression: path.win32.relative returns 'D:\\...' here, which does not
    // start with '..', so the pre-fix guard reported this as inside.
    expect(path.win32.relative('C:\\parent\\src', 'D:\\other\\file.js')).toBe('D:\\other\\file.js');
    expect(isInside('C:\\parent\\src', 'D:\\other\\file.js', path.win32)).toBe(false);
  });

  it('still accepts real containment on the same drive', () => {
    expect(isInside('C:\\parent\\src', 'C:\\parent\\src', path.win32)).toBe(true);
    expect(isInside('C:\\parent\\src', 'C:\\parent\\src\\core\\a.js', path.win32)).toBe(true);
  });

  it('still rejects a sibling escape on the same drive', () => {
    expect(isInside('C:\\parent\\src', 'C:\\parent\\other\\a.js', path.win32)).toBe(false);
    expect(isInside('C:\\parent\\src', 'C:\\parent', path.win32)).toBe(false);
  });

  it('is case- and separator-tolerant for a genuine child (win32 semantics)', () => {
    // win32 path.relative is case-insensitive on the drive letter.
    expect(isInside('C:\\parent', 'c:\\parent\\child.js', path.win32)).toBe(true);
  });

  it('keeps POSIX behavior unchanged', () => {
    expect(isInside('/parent/src', '/parent/src/core/a.js', path.posix)).toBe(true);
    expect(isInside('/parent/src', '/parent/src', path.posix)).toBe(true);
    expect(isInside('/parent/src', '/parent/other/a.js', path.posix)).toBe(false);
    expect(isInside('/parent/src', '/parent', path.posix)).toBe(false);
    // POSIX has no drive concept, so an unrelated root is expressed with '..'.
    expect(isInside('/parent/src', '/elsewhere/file.js', path.posix)).toBe(false);
  });

  it('defaults to the platform-bound path module', () => {
    const parent = path.resolve('parent');
    expect(isInside(parent, path.join(parent, 'child.js'))).toBe(true);
    expect(isInside(parent, path.resolve('sibling', 'child.js'))).toBe(false);
  });
});
