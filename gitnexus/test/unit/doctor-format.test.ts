import { describe, expect, it } from 'vitest';
import { displayWidth, localEmbeddingDoctorStatus, padDisplayEnd } from '../../src/cli/doctor.js';

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
});
