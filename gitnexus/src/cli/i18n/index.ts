import { cliResources } from './resources.js';
import { en } from './en.js';

export type SupportedCliLanguage = keyof typeof cliResources;
export type CliMessageKey = keyof typeof en;
export type CliMessageVars = Record<string, string | number | boolean | undefined | null>;

let overrideLanguage: SupportedCliLanguage | null = null;

function normalizeCliLanguage(raw: string): SupportedCliLanguage {
  const normalized = raw.trim().split('.')[0]?.replace(/_/g, '-').toLowerCase() ?? '';
  if (!normalized) return 'en';

  // GitNexus currently ships Simplified Chinese only. Do not map Traditional
  // Chinese locales (zh-TW/zh-HK/zh-Hant) to zh-CN just because they start
  // with "zh".
  if (
    normalized === 'zh' ||
    normalized === 'zh-cn' ||
    normalized.startsWith('zh-cn-') ||
    normalized === 'zh-hans' ||
    normalized.startsWith('zh-hans-')
  ) {
    return 'zh-CN';
  }

  return 'en';
}

export function detectCliLanguage(env: NodeJS.ProcessEnv = process.env): SupportedCliLanguage {
  const raw = env.GITNEXUS_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  return normalizeCliLanguage(raw);
}

export function setCliLanguage(language: SupportedCliLanguage | null): void {
  overrideLanguage = language;
}

export function getCliLanguage(): SupportedCliLanguage {
  return overrideLanguage ?? detectCliLanguage();
}

export function t(key: CliMessageKey, vars: CliMessageVars = {}): string {
  const language = getCliLanguage();
  const count = typeof vars.count === 'number' && Number.isFinite(vars.count) ? vars.count : null;
  const pluralKey =
    count === null ? null : (`${String(key)}_${count === 1 ? 'one' : 'other'}` as CliMessageKey);
  const template =
    (pluralKey ? (cliResources[language][pluralKey] ?? cliResources.en[pluralKey]) : undefined) ??
    cliResources[language][key] ??
    cliResources.en[key] ??
    key;
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, name: string) => {
    const value = vars[name];
    return value === undefined || value === null ? '' : String(value);
  });
}
