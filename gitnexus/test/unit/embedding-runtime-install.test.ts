import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  buildEmbeddingInstallCommand,
  getEmbeddingRuntimeDir,
  getEmbeddingStackSpecs,
  resolveEmbeddingRuntime,
} from '../../src/core/embeddings/runtime-install.js';

const require = createRequire(import.meta.url);

const ENV_KEYS = ['GITNEXUS_EMBEDDING_RUNTIME_DIR', 'ONNXRUNTIME_NODE_INSTALL'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('getEmbeddingRuntimeDir', () => {
  it('defaults to ~/.gitnexus/embedding-runtime and honours the env override', () => {
    expect(getEmbeddingRuntimeDir()).toBe(join(homedir(), '.gitnexus', 'embedding-runtime'));
    process.env.GITNEXUS_EMBEDDING_RUNTIME_DIR = '/custom/runtime';
    expect(getEmbeddingRuntimeDir()).toBe('/custom/runtime');
  });
});

describe('getEmbeddingStackSpecs', () => {
  it('mirrors the optionalDependencies manifest exactly (drift guard, #2370)', () => {
    const manifest = require('../../package.json') as {
      optionalDependencies: Record<string, string>;
    };
    expect(getEmbeddingStackSpecs()).toEqual({
      '@huggingface/transformers': manifest.optionalDependencies['@huggingface/transformers'],
      'onnxruntime-node': manifest.optionalDependencies['onnxruntime-node'],
    });
    expect(manifest.optionalDependencies['@huggingface/transformers']).toBeDefined();
    expect(manifest.optionalDependencies['onnxruntime-node']).toBeDefined();
  });
});

describe('buildEmbeddingInstallCommand', () => {
  it('defaults to a registry-only install: --ignore-scripts and the CUDA-download skip env', () => {
    process.env.GITNEXUS_EMBEDDING_RUNTIME_DIR = '/custom/runtime';
    const { args, env } = buildEmbeddingInstallCommand();
    expect(args.slice(0, 3)).toEqual(['install', '--prefix', '/custom/runtime']);
    expect(args).toContain('--ignore-scripts');
    const specs = getEmbeddingStackSpecs();
    expect(args).toContain(`@huggingface/transformers@${specs['@huggingface/transformers']}`);
    expect(args).toContain(`onnxruntime-node@${specs['onnxruntime-node']}`);
    expect(env.ONNXRUNTIME_NODE_INSTALL).toBe('skip');
  });

  it('with cuda: runs install scripts and leaves the CUDA download enabled', () => {
    const { args, env } = buildEmbeddingInstallCommand({ cuda: true });
    expect(args).not.toContain('--ignore-scripts');
    expect(env.ONNXRUNTIME_NODE_INSTALL).toBeUndefined();
  });
});

describe('resolveEmbeddingRuntime', () => {
  it('finds the normally-installed stack (package source wins over the prefix)', () => {
    process.env.GITNEXUS_EMBEDDING_RUNTIME_DIR = '/nonexistent/for/this/test';
    expect(resolveEmbeddingRuntime()).toEqual({ source: 'package' });
  });
});
