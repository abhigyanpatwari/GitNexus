import { describe, expect, it } from 'vitest';
import { createChatModel } from '../../src/core/llm/agent';
import { getAvailableModels } from '../../src/core/llm/settings-service';
import { DEFAULT_LLM_SETTINGS, type ProviderConfig } from '../../src/core/llm/types';

const anthropicParams = (model: string) => {
  const chat = createChatModel({
    provider: 'anthropic',
    apiKey: 'test-key',
    model,
    temperature: 0.1,
  } as ProviderConfig);
  return (chat as unknown as { invocationParams(): Record<string, unknown> }).invocationParams();
};

describe('default chat models', () => {
  it('does not default to retired Gemini or Anthropic models', () => {
    expect(DEFAULT_LLM_SETTINGS.gemini?.model).toBe('gemini-3.6-flash');
    expect(DEFAULT_LLM_SETTINGS.anthropic?.model).toBe('claude-sonnet-5-5');
    expect(getAvailableModels('gemini')).toContain(DEFAULT_LLM_SETTINGS.gemini?.model);
    expect(getAvailableModels('anthropic')).toContain(DEFAULT_LLM_SETTINGS.anthropic?.model);
  });

  // The saved default temperature (0.1) must not reach models that reject it.
  it.each(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-opus-4-8'])(
    'omits temperature for %s',
    (model) => {
      expect(anthropicParams(model).temperature).toBeUndefined();
    },
  );

  it.each(['claude-sonnet-4-5', 'claude-haiku-4-5'])('keeps temperature for %s', (model) => {
    expect(anthropicParams(model).temperature).toBe(0.1);
  });
});
