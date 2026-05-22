import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import i18n, { LANGUAGE_STORAGE_KEY, i18nReady } from '../../src/i18n';
import { normalizeSupportedLanguage } from '../../src/i18n/languages';
import { namespaceList, resources } from '../../src/i18n/resources';
import { LanguageSwitcher } from '../../src/components/LanguageSwitcher';

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
    flattenKeys(nested, prefix ? `${prefix}.${key}` : key),
  );
}

describe('web i18n', () => {
  afterEach(async () => {
    delete (i18n.getResourceBundle('en', 'settings') as Record<string, unknown> | undefined)
      ?.crossNamespaceProbe;
    delete (i18n.getResourceBundle('zh-CN', 'graph') as Record<string, unknown> | undefined)
      ?.crossNamespaceProbe;
    i18n.removeResourceBundle('en', 'fallback-test');
    await i18n.changeLanguage('en');
    window.localStorage.clear();
  });

  it('loads matching namespace and key sets for English and Simplified Chinese', () => {
    expect(namespaceList).toContain('common');
    expect(Object.keys(resources.en ?? {}).sort()).toEqual(
      Object.keys(resources['zh-CN'] ?? {}).sort(),
    );

    for (const namespace of namespaceList) {
      const enKeys = flattenKeys(resources.en?.[namespace]).sort();
      const zhKeys = flattenKeys(resources['zh-CN']?.[namespace]).sort();
      expect(zhKeys, namespace).toEqual(enKeys);
    }
  });

  it('switches to zh-CN, updates html lang, and returns Chinese translations', async () => {
    await i18nReady;
    await i18n.changeLanguage('zh-CN');

    expect(i18n.t('common:progress.connecting')).toBe('正在连接服务器...');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('falls back to English when the active language misses a key', async () => {
    await i18nReady;
    i18n.addResourceBundle('en', 'fallback-test', { only: 'Fallback only' });
    await i18n.changeLanguage('zh-CN');

    expect(i18n.t('fallback-test:only')).toBe('Fallback only');
  });

  it('does not fall back across unrelated namespaces', async () => {
    await i18nReady;
    i18n.addResource('en', 'settings', 'crossNamespaceProbe', 'English settings fallback');
    i18n.addResource('zh-CN', 'graph', 'crossNamespaceProbe', 'Wrong graph fallback');
    await i18n.changeLanguage('zh-CN');

    expect(i18n.t('settings:crossNamespaceProbe')).toBe('English settings fallback');
  });

  it('normalizes supported detector aliases and rejects unsupported languages', () => {
    expect(normalizeSupportedLanguage('zh')).toBe('zh-CN');
    expect(normalizeSupportedLanguage('zh-cn')).toBe('zh-CN');
    expect(normalizeSupportedLanguage('zh_CN.UTF-8')).toBe('zh-CN');
    expect(normalizeSupportedLanguage('en-US')).toBe('en');
    expect(normalizeSupportedLanguage('fr')).toBeNull();
    expect(normalizeSupportedLanguage('zh-TW')).toBeNull();
  });

  it('does not cache unsupported language codes', async () => {
    await i18nReady;
    window.localStorage.clear();

    await i18n.changeLanguage('fr');

    await waitFor(() => expect(document.documentElement.lang).toBe('en'));
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).not.toBe('fr');
    expect((i18n.options.detection as { caches?: string[] }).caches).toEqual([]);
  });

  it('persists language changes from the header switcher', async () => {
    await i18nReady;
    const user = userEvent.setup();
    render(<LanguageSwitcher />);

    await user.selectOptions(screen.getByLabelText('Select language'), 'zh-CN');

    await waitFor(() => expect(document.documentElement.lang).toBe('zh-CN'));
    expect(i18n.t('common:progress.connecting')).toBe('正在连接服务器...');
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
  });
});
