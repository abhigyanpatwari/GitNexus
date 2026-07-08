/**
 * Unit tests for C header scanning — specifically the skip-list
 * for build output directories.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { scanHeaderFiles } from '../../../../src/core/ingestion/languages/c/header-scan.js';

const TMP = join(__dirname, '__header_scan_tmp__');

function touch(rel: string): void {
  const full = join(TMP, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, '');
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('scanHeaderFiles — build-directory skip list', () => {
  it('finds .h files in source directories', () => {
    touch('src/foo.h');
    touch('include/bar.h');
    const headers = scanHeaderFiles(TMP);
    expect(headers).toContain('src/foo.h');
    expect(headers).toContain('include/bar.h');
  });

  it('skips node_modules', () => {
    touch('node_modules/dep/header.h');
    touch('src/real.h');
    const headers = scanHeaderFiles(TMP);
    expect(headers).not.toContain('node_modules/dep/header.h');
    expect(headers).toContain('src/real.h');
  });

  it('skips .git directory', () => {
    touch('.git/refs/header.h');
    const headers = scanHeaderFiles(TMP);
    expect(headers.size).toBe(0);
  });

  it('skips vendor directory', () => {
    touch('vendor/lib/header.h');
    const headers = scanHeaderFiles(TMP);
    expect(headers.size).toBe(0);
  });

  it('skips dist directory', () => {
    touch('dist/generated.h');
    touch('src/real.h');
    const headers = scanHeaderFiles(TMP);
    expect(headers).not.toContain('dist/generated.h');
    expect(headers).toContain('src/real.h');
  });

  it('skips build directory', () => {
    touch('build/config.h');
    const headers = scanHeaderFiles(TMP);
    expect(headers).not.toContain('build/config.h');
  });

  it('skips out directory', () => {
    touch('out/gen/auto.h');
    const headers = scanHeaderFiles(TMP);
    expect(headers.size).toBe(0);
  });

  it('skips target directory', () => {
    touch('target/release/bindings.h');
    const headers = scanHeaderFiles(TMP);
    expect(headers.size).toBe(0);
  });

  it('skips _build directory', () => {
    touch('_build/default/lib.h');
    const headers = scanHeaderFiles(TMP);
    expect(headers.size).toBe(0);
  });

  it('skips .next directory', () => {
    touch('.next/cache/header.h');
    const headers = scanHeaderFiles(TMP);
    expect(headers.size).toBe(0);
  });

  it('skips cmake-build-* directories', () => {
    touch('cmake-build-debug/generated.h');
    touch('cmake-build-release/generated.h');
    touch('src/real.h');
    const headers = scanHeaderFiles(TMP);
    expect(headers).not.toContain('cmake-build-debug/generated.h');
    expect(headers).not.toContain('cmake-build-release/generated.h');
    expect(headers).toContain('src/real.h');
  });
});
