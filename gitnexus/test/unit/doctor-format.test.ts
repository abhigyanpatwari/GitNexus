import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  displayWidth,
  doctorCommand,
  localEmbeddingDoctorStatus,
  padDisplayEnd,
  pageSizeDoctorLines,
} from '../../src/cli/doctor.js';

describe('doctor output formatting', () => {
  it('keeps ASCII padding equivalent to String.padEnd', () => {
    expect(displayWidth('OS:')).toBe(3);
    expect(padDisplayEnd('OS:', 10)).toBe('OS:'.padEnd(10));
  });

  it('pads CJK labels by terminal display width, not code-unit length', () => {
    const padded = padDisplayEnd('系统：', 10);

    expect(displayWidth('系统：')).toBe(6);
    expect(displayWidth(padded)).toBe(10);
    expect(padded).toBe('系统：    ');
  });

  it('does not truncate labels that are already wider than the target width', () => {
    expect(padDisplayEnd('图存储：', 4)).toBe('图存储：');
  });
});

describe('doctor embedding-runtime support status', () => {
  it('flags local embeddings as unavailable on macOS Intel (darwin/x64)', () => {
    const { status, detail } = localEmbeddingDoctorStatus({
      httpMode: false,
      platform: 'darwin',
      arch: 'x64',
    });
    expect(status).toBe('✗ local embeddings unavailable on darwin/x64');
    expect(detail).not.toBeNull();
    expect(detail).toMatch(/macOS Intel/);
    expect(detail).toMatch(/native binding/i);
  });

  it('reports local embeddings as supported on darwin/arm64, linux/x64, and win32/x64', () => {
    for (const [platform, arch] of [
      ['darwin', 'arm64'],
      ['linux', 'x64'],
      ['win32', 'x64'],
    ] as Array<[NodeJS.Platform, NodeJS.Architecture]>) {
      const { status, detail } = localEmbeddingDoctorStatus({ httpMode: false, platform, arch });
      expect(status).toBe('✓ local embeddings supported');
      expect(detail).toBeNull();
    }
  });

  it('reports HTTP backend as configured and never blocks on platform', () => {
    const { status, detail } = localEmbeddingDoctorStatus({
      httpMode: true,
      platform: 'darwin',
      arch: 'x64',
    });
    expect(status).toBe('✓ http endpoint configured');
    expect(detail).toBeNull();
  });

  it('flags a pruned optional embedding stack with reinstall guidance (#2370)', () => {
    const { status, detail } = localEmbeddingDoctorStatus({
      httpMode: false,
      platform: 'linux',
      arch: 'x64',
      resolution: null,
    });
    expect(status).toBe('✗ optional embedding stack not installed');
    expect(detail).toContain('ONNXRUNTIME_NODE_INSTALL=skip');
  });

  it('reports a package-sourced stack as supported regardless of Node loadability', () => {
    const { status, detail } = localEmbeddingDoctorStatus({
      httpMode: false,
      platform: 'linux',
      arch: 'x64',
      resolution: { source: 'package' },
      prefixLoadable: false,
    });
    expect(status).toBe('✓ local embeddings supported');
    expect(detail).toBeNull();
  });

  it('flags a prefix-sourced stack that this Node cannot load (#2372)', () => {
    const { status, detail } = localEmbeddingDoctorStatus({
      httpMode: false,
      platform: 'linux',
      arch: 'x64',
      resolution: { source: 'runtime-prefix' },
      prefixLoadable: false,
    });
    expect(status).toBe('✗ embedding stack installed in the prefix but not loadable on this Node');
    expect(detail).toContain('module.registerHooks');
  });

  it('reports a prefix-sourced stack as supported when this Node can load it', () => {
    const { status, detail } = localEmbeddingDoctorStatus({
      httpMode: false,
      platform: 'linux',
      arch: 'x64',
      resolution: { source: 'runtime-prefix' },
      prefixLoadable: true,
    });
    expect(status).toBe('✓ local embeddings supported');
    expect(detail).toBeNull();
  });

  it('prefers the platform blocker over the missing-stack report on macOS Intel', () => {
    const { status } = localEmbeddingDoctorStatus({
      httpMode: false,
      platform: 'darwin',
      arch: 'x64',
      resolution: null,
    });
    expect(status).toBe('✗ local embeddings unavailable on darwin/x64');
  });

  it('never reports a missing stack in HTTP mode', () => {
    const { status, detail } = localEmbeddingDoctorStatus({
      httpMode: true,
      resolution: null,
    });
    expect(status).toBe('✓ http endpoint configured');
    expect(detail).toBeNull();
  });
});

describe('doctor page-size lines (#1231, #2424 review)', () => {
  it('warns on a non-4K page size with a pre-0.18.0 @ladybugdb/core', () => {
    const lines = pageSizeDoctorLines(16384, '0.17.1');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`  ${padDisplayEnd('page size', 10)}16384`);
    // Byte-identical to the pre-extraction inline rendering — guards the
    // helper extraction against output drift.
    expect(lines[1]).toBe(
      `  ${padDisplayEnd('', 10)}⚠ non-4K page size with @ladybugdb/core < 0.18.0 — ` +
        `'gitnexus analyze' may fail during COPY (#1231). Upgrade gitnexus (npm install -g gitnexus@latest).`,
    );
  });

  it.each([
    ['page-size-aware LadybugDB', 16384, '0.18.0'],
    ['a 4 KiB page size', 4096, '0.17.1'],
  ])('prints the page size without a warning for %s', (_label, pageSize, version) => {
    const lines = pageSizeDoctorLines(pageSize, version);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('page size');
    expect(lines[0]).toContain(String(pageSize));
  });

  it('prints nothing when the page size is unknown', () => {
    expect(pageSizeDoctorLines(undefined, '0.17.1')).toHaveLength(0);
  });

  it('names an unknown version instead of asserting "< 0.18.0" about it', () => {
    const lines = pageSizeDoctorLines(16384, undefined);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('an unknown @ladybugdb/core version (may predate 0.18.0)');
    expect(lines[1]).not.toContain('with @ladybugdb/core < 0.18.0');
    expect(lines[1]).toContain('npm install -g gitnexus@latest');
  });
});

describe('doctor survives a malformed GITNEXUS_EMBEDDING_DIMS (#2385)', () => {
  const ENV_KEYS = [
    'GITNEXUS_EMBEDDING_URL',
    'GITNEXUS_EMBEDDING_MODEL',
    'GITNEXUS_EMBEDDING_DIMS',
  ] as const;
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('does not crash at the unguarded isHttpMode() call sites', async () => {
    process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
    process.env.GITNEXUS_EMBEDDING_DIMS = '1024abc';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    // Before the isHttpMode() root-cause fix (#2385) this threw at doctor.ts:167
    // (isHttpMode -> readConfig -> throw on the malformed DIMS); now the presence
    // probe never throws, so `gitnexus doctor` completes and reports the backend.
    await expect(doctorCommand()).resolves.toBeUndefined();
  });
});
