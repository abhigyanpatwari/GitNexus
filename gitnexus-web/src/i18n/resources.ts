import type { Resource } from 'i18next';

const localeModules = import.meta.glob('../locales/*/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, Record<string, unknown>>;

export const resources: Resource = {};
export const namespaces = new Set<string>();

for (const [path, translations] of Object.entries(localeModules)) {
  const match = path.match(/\.\.\/locales\/([^/]+)\/([^/.]+)\.json$/);
  if (!match) continue;
  const [, language, namespace] = match;
  resources[language] ??= {};
  resources[language][namespace] = translations;
  namespaces.add(namespace);
}

export const namespaceList = Array.from(namespaces).sort();
