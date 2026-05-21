import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import i18n, { i18nReady } from '../../src/i18n';
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
    window.localStorage.clear();
    i18n.removeResourceBundle('en', 'fallback-test');
    await i18n.changeLanguage('en');
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

  it('persists language changes from the header switcher', async () => {
    await i18nReady;
    const user = userEvent.setup();
    render(<LanguageSwitcher />);

    await user.selectOptions(screen.getByLabelText('Select language'), 'zh-CN');

    await waitFor(() => expect(document.documentElement.lang).toBe('zh-CN'));
    expect(i18n.t('common:progress.connecting')).toBe('正在连接服务器...');
    expect(window.localStorage.getItem('gitnexus.lng')).toBe('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
  });
});
