/**
 * C# import resolution config.
 * Namespace-based strategy via .csproj configs, then standard fallback.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig, ImportResolverStrategy } from '../types.js';
import { createStandardStrategy } from '../standard.js';
import { resolveCSharpImportInternal, resolveCSharpNamespaceDir } from '../csharp.js';
import { csharpSuffixFallbackAllowed } from '../../csharp-namespace-gate.js';

/** C# namespace-based resolution strategy via .csproj configs. */
export const csharpNamespaceStrategy: ImportResolverStrategy = (rawImportPath, _filePath, ctx) => {
  const csharpConfigs = ctx.configs.csharpConfigs;
  const evidence = ctx.configs.csharpNamespaces;
  if (csharpConfigs.length === 0) {
    // No csproj → there's no namespace→directory mapping to apply, so the
    // generic strategy would normally take over. But that generic suffix match
    // is UNGATED: it re-introduces the BCL→local spurious match the #1881 gate
    // exists to stop. Mirror the registry leg's no-csproj path — defer to the
    // generic strategy ONLY for imports that align with an in-repo declared
    // namespace; for everything else (BCL usings) return an authoritative empty
    // result that STOPS the chain (#2 parity). With no evidence threaded the
    // gate fails open, so behavior is unchanged when the scan didn't run.
    if (!csharpSuffixFallbackAllowed(rawImportPath, evidence)) {
      return { kind: 'files', files: [] };
    }
    return null;
  }

  const resolvedFiles = resolveCSharpImportInternal(
    rawImportPath,
    csharpConfigs,
    ctx.normalizedFileList,
    ctx.allFileList,
    ctx.index,
    evidence,
  );
  if (resolvedFiles.length > 1) {
    const dirSuffix = resolveCSharpNamespaceDir(rawImportPath, csharpConfigs);
    if (dirSuffix) {
      return { kind: 'package', files: resolvedFiles, dirSuffix };
    }
  }
  // Authoritative once csproj configs exist: return even an empty result to
  // STOP the chain, so the generic suffix fallback can't re-introduce the
  // gated BCL→local match this resolver just suppressed (#1881).
  return { kind: 'files', files: resolvedFiles };
};

export const csharpImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.CSharp,
  strategies: [csharpNamespaceStrategy, createStandardStrategy(SupportedLanguages.CSharp)],
};
