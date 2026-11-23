import { getLanguageFromFilename, SupportedLanguages } from 'gitnexus-shared';
import { COBOL_EXTENSIONS, JCL_EXTENSIONS } from '../cobol/file-types.js';
import type { LanguageProvider } from '../language-provider.js';
import { isTemplateRouteCandidate } from '../utils/template-file.js';
import { dartQueryHooks } from './dart/query-provider.js';
import { pythonQueryHooks } from './python/query-provider.js';
import { swiftQueryHooks } from './swift/query-provider.js';
import { tsJsHooks } from './typescript/query-provider.js';
import { zigQueryHooks } from './zig/query-provider.js';

/** Capabilities available to graph queries without initializing ingestion. */
export type QueryLanguageHooks = Pick<
  LanguageProvider,
  | 'callCompatibility'
  | 'typeImportAttribution'
  | 'notExportedIsFilePrivate'
  | 'additionalIndexedExtensions'
  | 'nonInitializingImportReasons'
>;
type QueryLanguageProvider = QueryLanguageHooks & Pick<LanguageProvider, 'id'>;

const hooks: Partial<Record<SupportedLanguages, QueryLanguageHooks>> = {
  [SupportedLanguages.Python]: pythonQueryHooks,
  [SupportedLanguages.Dart]: dartQueryHooks,
  [SupportedLanguages.Cobol]: { additionalIndexedExtensions: JCL_EXTENSIONS },
  [SupportedLanguages.TypeScript]: tsJsHooks,
  [SupportedLanguages.JavaScript]: tsJsHooks,
  [SupportedLanguages.Swift]: swiftQueryHooks,
  [SupportedLanguages.Zig]: zigQueryHooks,
};
export const providerNonInitializingImportReasons: readonly string[] = [
  ...new Set(
    Object.values(hooks).flatMap((provider) => provider.nonInitializingImportReasons ?? []),
  ),
];
const queryProviders: Partial<Record<SupportedLanguages, QueryLanguageProvider>> = {};
const standaloneExtensions = new Map(
  [...COBOL_EXTENSIONS].map((ext) => [ext, SupportedLanguages.Cobol]),
);
const additionalIndexedExtensions = new Set(
  Object.values(hooks).flatMap((h) => [...(h.additionalIndexedExtensions ?? [])]),
);

export function getQueryProvider(id: SupportedLanguages): QueryLanguageProvider {
  return (queryProviders[id] ??= { id, ...hooks[id] });
}

export function getQueryProviderForFile(filePath: string): QueryLanguageProvider | null {
  const id =
    getLanguageFromFilename(filePath) ??
    standaloneExtensions.get(filePath.slice(filePath.lastIndexOf('.')).toLowerCase());
  return id ? getQueryProvider(id) : null;
}

/** Include standalone inputs and templates when checking graph coverage for a source diff. */
export function isIndexedSourceFile(filePath: string): boolean {
  return (
    getQueryProviderForFile(filePath) !== null ||
    additionalIndexedExtensions.has(filePath.slice(filePath.lastIndexOf('.')).toLowerCase()) ||
    isTemplateRouteCandidate(filePath)
  );
}
