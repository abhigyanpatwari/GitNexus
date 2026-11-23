import { SupportedLanguages } from 'gitnexus-shared';

/** Hand-written shipped JavaScript/TypeScript roots. Vendored grammars, build outputs,
 * test fixtures and the offline evaluation harness are outside the runtime boundary. */
export const productionPaths = [
  'gitnexus/src',
  'gitnexus/hooks',
  'gitnexus/scripts',
  'gitnexus-shared/src',
  'gitnexus-web/src',
  'gitnexus-claude-plugin',
  'gitnexus-cursor-integration',
  'gitnexus-factory-plugin',
  'docker-server.mjs',
];

const registries = new Set([
  'gitnexus-shared/src/languages.ts',
  'gitnexus-shared/src/language-detection.ts',
  'gitnexus-shared/src/scope-resolution/language-classification.ts',
  'gitnexus/src/core/analysis-feature-registry.ts',
  'gitnexus/src/core/ingestion/languages/index.ts',
  'gitnexus/src/core/ingestion/languages/analyze-config.ts',
  'gitnexus/src/core/ingestion/languages/query-providers.ts',
  'gitnexus/src/core/ingestion/languages/import-candidates.ts',
  'gitnexus/src/core/ingestion/scope-resolution/pipeline/registry.ts',
  'gitnexus/src/core/ingestion/tree-sitter-queries.ts',
  'gitnexus/src/core/tree-sitter/grammar-sources.ts',
]);

export function isSharedProductionFile(
  file: string,
  namesLanguage: (value: string) => boolean,
): boolean {
  if (
    !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) ||
    /\/(?:__tests__|__fixtures__|fixtures)\//.test(file)
  )
    return false;
  if (registries.has(file)) return false;

  // Language implementations are exempt only at their ownership boundaries. A file named
  // python-impact.ts in a shared MCP or storage directory still belongs to shared code.
  const provider = file
    .match(/^gitnexus\/src\/core\/ingestion\/languages\/([^/]+)/)?.[1]
    .replace(/\.ts$/, '');
  if (
    provider &&
    (provider === 'c-cpp' || Object.values(SupportedLanguages).some((id) => id === provider))
  )
    return false;
  const owned = file.match(
    /^gitnexus\/src\/core\/ingestion\/(?:(?:call|class|field|method|type|variable)-extractors|cfg\/visitors|taint)\/(.+)$/,
  );
  if (owned && namesLanguage(owned[1])) return false;
  // These directories are per-framework implementations and protocol pattern registries.
  if (/^gitnexus\/src\/core\/ingestion\/(?:frameworks\/spring|cobol)\//.test(file)) return false;
  if (
    /^gitnexus\/src\/core\/group\/extractors\/(?:grpc|http|topic|thrift)-patterns\/(?:index|node|jvm)\.ts$/.test(
      file,
    )
  )
    return false;
  if (
    /^gitnexus\/src\/core\/ingestion\/route-extractors\/(?:django|fastapi|laravel|nextjs|spring|trpc)(?:[-.])/.test(
      file,
    )
  )
    return false;
  if (
    /^gitnexus\/src\/core\/ingestion\/(?:ipynb-extractor|vue-sfc-extractor|markdown-processor|cobol-processor)\.ts$/.test(
      file,
    )
  )
    return false;
  return true;
}
