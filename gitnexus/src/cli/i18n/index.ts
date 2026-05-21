import { cliResources } from './resources.js';
import { en } from './en.js';

export type SupportedCliLanguage = keyof typeof cliResources;
export type CliMessageKey = keyof typeof en;
export type CliMessageVars = Record<string, string | number | boolean | undefined | null>;

let overrideLanguage: SupportedCliLanguage | null = null;

export function detectCliLanguage(env: NodeJS.ProcessEnv = process.env): SupportedCliLanguage {
  const raw = env.GITNEXUS_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  return raw.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export function setCliLanguage(language: SupportedCliLanguage | null): void {
  overrideLanguage = language;
}

export function getCliLanguage(): SupportedCliLanguage {
  return overrideLanguage ?? detectCliLanguage();
}

export function t(key: CliMessageKey, vars: CliMessageVars = {}): string {
  const language = getCliLanguage();
  const template = cliResources[language][key] ?? cliResources.en[key] ?? key;
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, name: string) => {
    const value = vars[name];
    return value === undefined || value === null ? '' : String(value);
  });
}
