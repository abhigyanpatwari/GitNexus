/**
 * Shared scope-model builder for scope-resolution unit tests.
 *
 * `finalizeScopeModel({ hooks: { resolveImportTarget, mergeBindings } })` is
 * the incantation a test must perform before it can call any resolution pass,
 * and it was being hand-copied per file — and, inside a single file, once per
 * language. The only thing that ever varied was the resolver, the source and
 * the file path, so those are the parameters here.
 *
 * The model is built from REAL extraction rather than a hand-assembled index
 * on purpose: the defects these tests pin are cases where source-level
 * intuition about what a binding CONTAINS is wrong (Go normalizes a free
 * parameter's `*Host` to `Host` at capture but leaves a method receiver's
 * spelled `*Host` intact), so a fixture that asserted the binding shape by
 * hand would pin the intuition instead of the code.
 */
import type { ParsedFile, ScopeId } from 'gitnexus-shared';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';
import { finalizeScopeModel } from '../../src/core/ingestion/finalize-orchestrator.js';
import {
  buildWorkspaceResolutionIndex,
  type WorkspaceResolutionIndex,
} from '../../src/core/ingestion/scope-resolution/workspace-index.js';
import type { ScopeResolver } from '../../src/core/ingestion/scope-resolution/contract/scope-resolver.js';
import type { ScopeResolutionIndexes } from '../../src/core/ingestion/model/scope-resolution-indexes.js';

export interface ScopeModelFixture {
  /** The extracted file — for tests that must start a fold in a scope other
   *  than the module scope, or read the raw scope list. */
  readonly parsed: ParsedFile;
  readonly scopes: ScopeResolutionIndexes;
  readonly index: WorkspaceResolutionIndex;
  /** `parsed.referenceSites`: the sites a resolution pass walks. */
  readonly sites: ParsedFile['referenceSites'];
  /** `parsed.moduleScope`: the default `inScope` for a top-level position. */
  readonly moduleScope: ScopeId;
  /** Carried so callers can thread the language's own contract hooks
   *  (`elementTypeOf`, `stripTypePreservingDecoration`, …) without naming the
   *  resolver a second time. */
  readonly resolver: ScopeResolver;
}

/**
 * Extract `source` with `resolver`'s provider, run owner population and the
 * shared finalize, and return the resolution indexes a pass needs.
 *
 * Throws rather than asserting, because callers build fixtures at module load
 * where a failed `expect` has no test to attach to.
 */
export function buildScopeModel(
  resolver: ScopeResolver,
  source: string,
  filePath: string,
): ScopeModelFixture {
  const parsed = extractParsedFile(resolver.languageProvider, source, filePath);
  if (parsed === undefined) throw new Error(`scope extraction failed for ${filePath}`);
  resolver.populateOwners(parsed);
  const parsedFiles: ParsedFile[] = [parsed];
  const allFilePaths = new Set(parsedFiles.map((p) => p.filePath));
  const scopes = finalizeScopeModel(parsedFiles, {
    hooks: {
      resolveImportTarget: (targetRaw, fromFile) =>
        resolver.resolveImportTarget(targetRaw, fromFile, allFilePaths),
      mergeBindings: (existing, incoming, scopeId) =>
        resolver.mergeBindings(existing, incoming, scopeId),
    },
  });
  return {
    parsed,
    scopes,
    index: buildWorkspaceResolutionIndex(parsedFiles),
    sites: parsed.referenceSites,
    moduleScope: parsed.moduleScope,
    resolver,
  };
}
