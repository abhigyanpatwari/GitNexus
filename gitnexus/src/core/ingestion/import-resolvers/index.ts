/**
 * Language-specific import resolvers.
 * Extracted from import-processor.ts for maintainability.
 */

export { EXTENSIONS, tryResolveWithExtensions, buildSuffixIndex, suffixResolve, EMPTY_INDEX } from './utils.js';
export type { SuffixIndex } from './utils.js';

export { KOTLIN_EXTENSIONS, appendKotlinWildcard, resolveJvmWildcard, resolveJvmMemberImport, resolveJavaImport, resolveKotlinImport } from './jvm.js';

export { resolveGoPackageDir, resolveGoPackage, resolveGoImport } from './go.js';
export type { GoModuleConfig } from './go.js';

export { resolveCSharpImportInternal, resolveCSharpNamespaceDir, resolveCSharpImport } from './csharp.js';
export type { CSharpProjectConfig } from './csharp.js';

export { resolvePhpImportInternal, resolvePhpImport } from './php.js';
export type { ComposerConfig } from './php.js';

export { resolveRustImportInternal, tryRustModulePath, resolveRustImport } from './rust.js';

export { resolveRubyImportInternal, resolveRubyImport } from './ruby.js';

export { resolvePythonImportInternal, resolvePythonImport } from './python.js';

export { resolveImportPath, RESOLVE_CACHE_CAP, resolveStandard, resolveJavascriptImport, resolveTypescriptImport, resolveCImport, resolveCppImport } from './standard.js';
export type { TsconfigPaths } from './standard.js';

export { resolveSwiftImport } from './swift.js';

export type { ImportResult, ImportConfigs, ResolveCtx, ImportResolverFn } from './types.js';
