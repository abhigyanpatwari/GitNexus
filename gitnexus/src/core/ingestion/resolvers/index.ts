/**
 * Language-specific import resolvers.
 * Extracted from import-processor.ts for maintainability.
 */

export { EXTENSIONS, tryResolveWithExtensions, buildSuffixIndex, suffixResolve, EMPTY_INDEX } from './utils.js';
export type { SuffixIndex } from './utils.js';

export { KOTLIN_EXTENSIONS, appendKotlinWildcard, resolveJvmWildcard, resolveJvmMemberImport } from './jvm.js';

export { resolveGoPackageDir, resolveGoPackage } from './go.js';
export type { GoModuleConfig } from './go.js';

export { resolveCSharpImport, resolveCSharpNamespaceDir } from './csharp.js';
export type { CSharpProjectConfig } from './csharp.js';

export { resolvePhpImport } from './php.js';
export type { ComposerConfig } from './php.js';

export { resolveRustImport, tryRustModulePath } from './rust.js';

export { resolveRubyImport } from './ruby.js';

export { resolvePythonImport } from './python.js';

export { resolveImportPath, RESOLVE_CACHE_CAP } from './standard.js';
export type { TsconfigPaths } from './standard.js';
