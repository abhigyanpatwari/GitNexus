/**
 * Merge of accumulated parse-worker results (sub-batch result → the conceptual
 * job's running accumulator).
 *
 * Extracted from `parse-worker.ts` into this side-effect-free module so the
 * merge can be imported and unit-tested directly — the parse worker is an entry
 * module (importing it constructs the parser, posts `ready`, and attaches the
 * real MessagePort handler), so a main-thread test cannot import a helper out of
 * it. Mirrors the `post-result.ts` extraction.
 *
 * `import type` of `ParseWorkerResult` is erased at runtime, so there is no
 * import cycle with `parse-worker.ts` (which imports this module's runtime).
 */
import type { ParseWorkerResult } from './parse-worker.js';

// Use a loop instead of push(...spread) to avoid hitting V8's argument limit
// when merging large result sets (push(...arr) calls apply() under the hood
// and blows the stack when arr has >~65k elements).
const appendAll = <T>(target: T[], src: T[]): void => {
  for (let i = 0; i < src.length; i++) target.push(src[i]);
};

/**
 * Merge `src` into `target` in place: append every boundary-crossing array,
 * sum the per-language skip counts, union the clone-safety `skippedPaths`, and
 * add the file count.
 */
export const mergeResult = (target: ParseWorkerResult, src: ParseWorkerResult): void => {
  appendAll(target.nodes, src.nodes);
  appendAll(target.relationships, src.relationships);
  appendAll(target.symbols, src.symbols);
  appendAll(target.calls, src.calls);
  appendAll(target.assignments, src.assignments);
  appendAll(target.routes, src.routes);
  appendAll(target.fetchCalls, src.fetchCalls);
  appendAll(target.fetchWrapperDefs, src.fetchWrapperDefs);
  appendAll(target.decoratorRoutes, src.decoratorRoutes);
  if (src.routerIncludes) appendAll(target.routerIncludes, src.routerIncludes);
  if (src.routerImports) appendAll(target.routerImports, src.routerImports);
  if (src.routerModuleAliases) {
    target.routerModuleAliases ??= [];
    appendAll(target.routerModuleAliases, src.routerModuleAliases);
  }
  if (src.springTypes) {
    target.springTypes ??= [];
    appendAll(target.springTypes, src.springTypes);
  }
  appendAll(target.toolDefs, src.toolDefs);
  appendAll(target.ormQueries, src.ormQueries);
  appendAll(target.constructorBindings, src.constructorBindings);
  appendAll(target.fileScopeBindings, src.fileScopeBindings);
  appendAll(target.parsedFiles, src.parsedFiles);
  for (const [lang, count] of Object.entries(src.skippedLanguages)) {
    target.skippedLanguages[lang] = (target.skippedLanguages[lang] || 0) + count;
  }
  if (src.skippedPaths && src.skippedPaths.length > 0) {
    (target.skippedPaths ??= []).push(...src.skippedPaths);
  }
  target.fileCount += src.fileCount;
};
