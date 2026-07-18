/**
 * CLI flag persistence must be save-on-effective-change: omc watch passes
 * --provider/--model on every 30s tick, and unconditional saves rewrote
 * ~/.gitnexus/config.json (plus printed "Config saved") on every run.
 */
import { describe, it, expect } from 'vitest';
import { applyCliConfigOverrides } from '../../src/cli/wiki.js';

describe('applyCliConfigOverrides', () => {
  it('reports no change when flags match the saved config (local provider model routing)', () => {
    const existing = { provider: 'claude' as const, claudeModel: 'opus' };
    const { merged, changed } = applyCliConfigOverrides(
      { provider: 'claude', model: 'opus' },
      existing,
    );
    expect(changed).toBe(false);
    expect(merged).toEqual(existing);
  });

  it('reports a change when the model differs', () => {
    const { merged, changed } = applyCliConfigOverrides(
      { provider: 'claude', model: 'sonnet' },
      { provider: 'claude', claudeModel: 'opus' },
    );
    expect(changed).toBe(true);
    expect(merged.claudeModel).toBe('sonnet');
  });

  it('routes non-local provider models to the flat model key', () => {
    const { merged, changed } = applyCliConfigOverrides(
      { provider: 'openai', model: 'gpt-4o' },
      { provider: 'openai', model: 'gpt-4o-mini' },
    );
    expect(changed).toBe(true);
    expect(merged.model).toBe('gpt-4o');
  });

  it('treats reasoningModel=false as an explicit override', () => {
    const { changed } = applyCliConfigOverrides(
      { reasoningModel: false },
      { isReasoningModel: true },
    );
    expect(changed).toBe(true);
  });

  it('reports no change when identical flags repeat (watch-loop case)', () => {
    const existing = {
      provider: 'claude' as const,
      claudeModel: 'opus',
      isReasoningModel: false,
    };
    const { changed } = applyCliConfigOverrides(
      { provider: 'claude', model: 'opus', reasoningModel: false },
      existing,
    );
    expect(changed).toBe(false);
  });
});
