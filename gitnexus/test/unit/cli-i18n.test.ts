import { describe, expect, it, afterEach } from 'vitest';
import { detectCliLanguage, getCliLanguage, setCliLanguage, t } from '../../src/cli/i18n/index.js';
import { cliResources } from '../../src/cli/i18n/resources.js';

describe('cli i18n', () => {
  afterEach(() => setCliLanguage(null));

  it('detects Chinese from GitNexus-specific or locale environment variables', () => {
    expect(detectCliLanguage({ GITNEXUS_LANG: 'zh-CN' } as NodeJS.ProcessEnv)).toBe('zh-CN');
    expect(detectCliLanguage({ LC_ALL: 'zh_CN.UTF-8' } as NodeJS.ProcessEnv)).toBe('zh-CN');
    expect(detectCliLanguage({ LANG: 'en_US.UTF-8' } as NodeJS.ProcessEnv)).toBe('en');
  });

  it('does not map Traditional Chinese locales to Simplified Chinese', () => {
    expect(detectCliLanguage({ LANG: 'zh_TW.UTF-8' } as NodeJS.ProcessEnv)).toBe('en');
    expect(detectCliLanguage({ LANG: 'zh_HK.UTF-8' } as NodeJS.ProcessEnv)).toBe('en');
    expect(detectCliLanguage({ LANG: 'zh-Hant.UTF-8' } as NodeJS.ProcessEnv)).toBe('en');
  });

  it('supports explicit language override and interpolation', () => {
    setCliLanguage('zh-CN');
    expect(getCliLanguage()).toBe('zh-CN');
    expect(t('list.title', { count: 2 })).toBe('已索引仓库（2）');
  });

  it('resolves plural suffixes when count is provided', () => {
    setCliLanguage('en');
    expect(t('doctor.nodes', { count: 1 })).toBe('1 node');
    expect(t('doctor.nodes', { count: 2 })).toBe('2 nodes');
    expect(t('doctor.chunks', { count: 1 })).toBe('1 chunk');
    expect(t('doctor.chunks', { count: 2 })).toBe('2 chunks');

    setCliLanguage('zh-CN');
    expect(t('doctor.nodes', { count: 1 })).toBe('1 个节点');
    expect(t('doctor.nodes', { count: 2 })).toBe('2 个节点');
  });

  it('keeps base-key interpolation when no plural suffix exists', () => {
    setCliLanguage('en');
    expect(t('list.title', { count: 1 })).toBe('Indexed Repositories (1)');
  });

  it('keeps resource keys in parity across supported languages', () => {
    const englishKeys = Object.keys(cliResources.en).sort();
    for (const [language, messages] of Object.entries(cliResources)) {
      expect(Object.keys(messages).sort(), language).toEqual(englishKeys);
    }
  });
});
