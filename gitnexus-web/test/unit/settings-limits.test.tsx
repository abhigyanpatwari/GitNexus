import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../../src/components/SettingsPanel';
import {
  clearSettings,
  getAgentConfig,
  getModelNameForSettings,
  loadSettings,
  normalizeMaxIterations,
  normalizeTokenBudget,
  saveSettings,
} from '../../src/core/llm/settings-service';
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_TOKEN_BUDGET,
  MAX_MAX_ITERATIONS,
  MIN_MAX_ITERATIONS,
} from '../../src/core/llm/types';

vi.mock('../../src/core/llm/settings-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/llm/settings-service')>();
  return {
    ...actual,
    checkOllamaStatus: vi.fn().mockResolvedValue({ ok: false, error: null }),
  };
});

describe('agent limits settings-service helpers', () => {
  beforeEach(() => {
    clearSettings();
  });

  it('normalizes maxIterations within [1, 50] and defaults on invalid inputs', () => {
    expect(normalizeMaxIterations(undefined)).toBe(DEFAULT_MAX_ITERATIONS);
    expect(normalizeMaxIterations(Number.NaN)).toBe(DEFAULT_MAX_ITERATIONS);
    expect(normalizeMaxIterations(0)).toBe(DEFAULT_MAX_ITERATIONS);
    expect(normalizeMaxIterations(-10)).toBe(DEFAULT_MAX_ITERATIONS);
    expect(normalizeMaxIterations(MIN_MAX_ITERATIONS)).toBe(MIN_MAX_ITERATIONS);
    expect(normalizeMaxIterations(99)).toBe(MAX_MAX_ITERATIONS);
    expect(normalizeMaxIterations(12.6)).toBe(12);
  });

  it('normalizes tokenBudget to non-negative integers with default 0', () => {
    expect(normalizeTokenBudget(undefined)).toBe(DEFAULT_TOKEN_BUDGET);
    expect(normalizeTokenBudget(Number.NaN)).toBe(0);
    expect(normalizeTokenBudget(-500)).toBe(0);
    expect(normalizeTokenBudget(15000.4)).toBe(15000);
  });

  it('persists and reloads agent limits via loadSettings/saveSettings', () => {
    const initial = loadSettings();
    expect(getAgentConfig(initial)).toEqual({
      maxIterations: 8,
      tokenBudget: 0,
    });

    saveSettings({
      ...initial,
      agent: { maxIterations: 15, tokenBudget: 25000 },
    });

    expect(getAgentConfig(loadSettings())).toEqual({
      maxIterations: 15,
      tokenBudget: 25000,
    });
  });

  it('resolves active model name across standard and Azure providers', () => {
    const base = loadSettings();
    const openAISettings = {
      ...base,
      activeProvider: 'openai' as const,
      openai: { apiKey: 'k', model: 'gpt-4o' },
    };
    expect(getModelNameForSettings(openAISettings)).toBe('gpt-4o');

    const azureSettings = {
      ...base,
      activeProvider: 'azure-openai' as const,
      azureOpenAI: {
        apiKey: 'k',
        endpoint: 'https://example.openai.azure.com',
        deploymentName: 'gpt-4o-mini-deploy',
      },
    };
    expect(getModelNameForSettings(azureSettings)).toBe('gpt-4o-mini-deploy');
  });
});

describe('SettingsPanel agent limits UI', () => {
  beforeEach(() => {
    clearSettings();
  });

  it('renders and persists clamped maxIterations and tokenBudget on Save', () => {
    const onSettingsSaved = vi.fn();
    render(<SettingsPanel isOpen={true} onClose={() => {}} onSettingsSaved={onSettingsSaved} />);

    const maxIterInput = screen.getByLabelText(
      'settings:agentLimits.maxIterationsLabel',
    ) as HTMLInputElement;
    const tokenBudgetInput = screen.getByLabelText(
      'settings:agentLimits.tokenBudgetLabel',
    ) as HTMLInputElement;

    expect(maxIterInput.value).toBe('8');
    expect(tokenBudgetInput.value).toBe('0');

    fireEvent.change(maxIterInput, { target: { value: '14' } });
    fireEvent.change(tokenBudgetInput, { target: { value: '12000' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings:saveSettings' }));

    expect(onSettingsSaved).toHaveBeenCalledTimes(1);
    expect(getAgentConfig(loadSettings())).toEqual({
      maxIterations: 14,
      tokenBudget: 12000,
    });

    // Out-of-bounds value is clamped upon save
    fireEvent.change(maxIterInput, { target: { value: '999' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings:saveSettings' }));

    expect(getAgentConfig(loadSettings()).maxIterations).toBe(MAX_MAX_ITERATIONS);

    // Exponent-form numeric inputs (valid in <input type="number">) are parsed accurately
    fireEvent.change(maxIterInput, { target: { value: '1e1' } });
    fireEvent.change(tokenBudgetInput, { target: { value: '1e3' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings:saveSettings' }));

    expect(getAgentConfig(loadSettings())).toEqual({
      maxIterations: 10,
      tokenBudget: 1000,
    });
  });
});
