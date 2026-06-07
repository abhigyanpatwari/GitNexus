import { describe, expect, it } from 'vitest';
import { planWikiProviderReadiness } from '../../src/core/wiki/provider-readiness.js';

describe('wiki provider readiness planning', () => {
  it('marks saved HTTP provider config ready without exposing secret material', () => {
    const status = planWikiProviderReadiness({
      config: {
        provider: 'openai',
        apiKey: 'sk-secret-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
      },
      env: {},
    });

    expect(status).toEqual({
      ready: true,
      provider: 'openai',
      source: 'saved-config',
    });
    expect(JSON.stringify(status)).not.toContain('sk-secret-key');
    expect(JSON.stringify(status)).not.toContain('api.openai.com');
  });

  it('marks environment-provided HTTP provider config ready without exposing key values', () => {
    const status = planWikiProviderReadiness({
      config: {
        provider: 'openrouter',
      },
      env: {
        GITNEXUS_API_KEY: 'env-secret-key',
        GITNEXUS_LLM_BASE_URL: 'https://openrouter.ai/api/v1',
      },
    });

    expect(status).toEqual({
      ready: true,
      provider: 'openrouter',
      source: 'environment',
    });
    expect(JSON.stringify(status)).not.toContain('env-secret-key');
    expect(JSON.stringify(status)).not.toContain('openrouter.ai');
  });

  it('does not treat local CLI providers as server-ready because status must not spawn providers', () => {
    const status = planWikiProviderReadiness({
      config: {
        provider: 'codex',
        codexModel: 'gpt-5',
      },
      env: {},
    });

    expect(status).toEqual({
      ready: false,
      provider: 'codex',
      source: 'saved-config',
      reason: 'local-cli-provider-not-server-ready',
    });
  });

  it('reports missing HTTP provider credentials without guessing readiness', () => {
    const status = planWikiProviderReadiness({
      config: {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
      },
      env: {},
    });

    expect(status).toEqual({
      ready: false,
      provider: 'openai',
      source: 'none',
      reason: 'missing-api-key',
    });
  });

  it('reports invalid provider base URLs without leaking the raw URL', () => {
    const status = planWikiProviderReadiness({
      config: {
        provider: 'custom',
        apiKey: 'secret-key',
        baseUrl: 'file:///secret/path',
      },
      env: {},
    });

    expect(status).toEqual({
      ready: false,
      provider: 'custom',
      source: 'saved-config',
      reason: 'invalid-base-url',
    });
    expect(JSON.stringify(status)).not.toContain('file:///secret/path');
    expect(JSON.stringify(status)).not.toContain('secret-key');
  });
});
