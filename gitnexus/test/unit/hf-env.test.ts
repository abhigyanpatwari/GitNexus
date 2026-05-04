import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import { join } from 'node:path';
import { applyHfEnvOverrides, type HfEnvSubset } from '../../src/core/embeddings/hf-env.js';

describe('applyHfEnvOverrides', () => {
  let envStub: HfEnvSubset;
  // Snapshot the two env vars so tests don't leak state into each other (or
  // into the rest of the test run). `delete` + restore is the simplest pattern
  // — vitest doesn't reset `process.env` between tests by default.
  let originalHfHome: string | undefined;
  let originalHfEndpoint: string | undefined;

  beforeEach(() => {
    envStub = { cacheDir: '', remoteHost: '' };
    originalHfHome = process.env.HF_HOME;
    originalHfEndpoint = process.env.HF_ENDPOINT;
    delete process.env.HF_HOME;
    delete process.env.HF_ENDPOINT;
  });

  afterEach(() => {
    if (originalHfHome === undefined) delete process.env.HF_HOME;
    else process.env.HF_HOME = originalHfHome;
    if (originalHfEndpoint === undefined) delete process.env.HF_ENDPOINT;
    else process.env.HF_ENDPOINT = originalHfEndpoint;
  });

  it('cacheDir defaults to ~/.cache/huggingface when HF_HOME is unset', () => {
    applyHfEnvOverrides(envStub);
    expect(envStub.cacheDir).toBe(join(os.homedir(), '.cache', 'huggingface'));
  });

  it('cacheDir respects HF_HOME when set', () => {
    process.env.HF_HOME = '/custom/hf/cache';
    applyHfEnvOverrides(envStub);
    expect(envStub.cacheDir).toBe('/custom/hf/cache');
  });

  it('remoteHost is set when HF_ENDPOINT is set, with a trailing slash appended', () => {
    process.env.HF_ENDPOINT = 'https://hf-mirror.com';
    applyHfEnvOverrides(envStub);
    expect(envStub.remoteHost).toBe('https://hf-mirror.com/');
  });

  it('remoteHost preserves existing trailing slash on HF_ENDPOINT', () => {
    process.env.HF_ENDPOINT = 'https://hf-mirror.com/';
    applyHfEnvOverrides(envStub);
    expect(envStub.remoteHost).toBe('https://hf-mirror.com/');
  });

  it('remoteHost is left untouched when HF_ENDPOINT is unset', () => {
    // Pre-populate to a sentinel so we can prove the function does NOT
    // overwrite remoteHost when no env var is set. Without this guard a
    // future refactor that always assigns `env.remoteHost = ...` would
    // silently break consumers that have already configured it elsewhere.
    envStub.remoteHost = 'pre-existing-do-not-touch';
    applyHfEnvOverrides(envStub);
    expect(envStub.remoteHost).toBe('pre-existing-do-not-touch');
  });

  it('remoteHost is left untouched when HF_ENDPOINT is whitespace-only', () => {
    // Common copy-paste failure mode for users on restricted networks who
    // pull `HF_ENDPOINT` values from shell scripts or docs with stray
    // whitespace. The `.trim()` + truthiness guard ensures this is treated
    // as "unset" rather than as an invalid host like `'   /'` that would
    // silently misroute model downloads. Pinned by the @claude review on
    // PR #1252.
    process.env.HF_ENDPOINT = '   ';
    envStub.remoteHost = 'sentinel';
    applyHfEnvOverrides(envStub);
    expect(envStub.remoteHost).toBe('sentinel');
  });

  it('remoteHost trims surrounding whitespace from HF_ENDPOINT', () => {
    // Compatible mirror of the previous test for the case where the env
    // var is non-empty AFTER trimming. Without `.trim()`, the bogus
    // leading/trailing space would survive into the URL and break
    // downloads.
    process.env.HF_ENDPOINT = '  https://hf-mirror.com  ';
    applyHfEnvOverrides(envStub);
    expect(envStub.remoteHost).toBe('https://hf-mirror.com/');
  });
});
