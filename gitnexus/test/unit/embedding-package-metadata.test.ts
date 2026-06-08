import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('local embedding package metadata', () => {
  it('declares onnxruntime-common directly for strict package managers', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    ) as { dependencies: Record<string, string> };
    const lock = JSON.parse(
      readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf-8'),
    ) as {
      packages: Record<
        string,
        { dependencies?: Record<string, string>; version?: string }
      >;
    };

    expect(pkg.dependencies['@huggingface/transformers']).toBeDefined();
    expect(pkg.dependencies['onnxruntime-node']).toBeDefined();
    expect(pkg.dependencies['onnxruntime-common']).toBe('^1.26.0');
    expect(lock.packages[''].dependencies?.['onnxruntime-common']).toBe('^1.26.0');
    expect(lock.packages['node_modules/onnxruntime-common'].version).toBe('1.26.0');
  });
});
