/**
 * Creates a lazy-loaded CLI action that defers module import until invocation.
 * The generic constraints ensure the export name is a valid key of the module
 * at compile time — catching typos when used with concrete module imports.
 */

import { checkLbugNative } from '../core/lbug/native-check.js';

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

export function createLazyAction<
  TModule extends Record<string, unknown>,
  TKey extends string & keyof TModule,
>(loader: () => Promise<TModule>, exportName: TKey): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]): Promise<void> => {
    const module = await loader();
    const action = module[exportName];
    if (!isCallable(action)) {
      throw new Error(`Lazy action export not found: ${exportName}`);
    }
    await action(...args);
  };
}

export function createLbugLazyAction<
  TModule extends Record<string, unknown>,
  TKey extends string & keyof TModule,
>(loader: () => Promise<TModule>, exportName: TKey): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]): Promise<void> => {
    const check = checkLbugNative();
    if (!check.ok) {
      process.stderr.write(`\n  ${check.message?.replace(/\n/g, '\n  ')}\n\n`);
      process.exitCode = 1;
      return;
    }
    const module = await loader();
    const action = module[exportName];
    if (!isCallable(action)) {
      throw new Error(`Lazy action export not found: ${exportName}`);
    }
    await action(...args);
  };
}

/**
 * Analyze-specific lazy action. Unlike the generic LadybugDB wrapper, this
 * captures the complete analyzer receipt before probing/loading native code or
 * evaluating the analyzer module graph. The target export receives that start
 * receipt as its first argument and threads it to runFullAnalysis.
 */
export function createAnalyzerLbugLazyAction<
  TModule extends Record<string, unknown>,
  TKey extends string & keyof TModule,
>(
  identityLoader: () => Promise<
    Pick<typeof import('../core/analyzer-identity.js'), 'captureAnalyzerIdentityBeforeLoad'>
  >,
  loader: () => Promise<TModule>,
  exportName: TKey,
  analyzerModuleUrl: string,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]): Promise<void> => {
    const identityModule = await identityLoader();
    const prepared = await identityModule.captureAnalyzerIdentityBeforeLoad(
      analyzerModuleUrl,
      async () => {
        const check = checkLbugNative();
        if (!check.ok) return { check, module: null };
        return { check, module: await loader() };
      },
    );
    if (!prepared.loaded.check.ok) {
      process.stderr.write(`\n  ${prepared.loaded.check.message?.replace(/\n/g, '\n  ')}\n\n`);
      process.exitCode = 1;
      return;
    }
    const action = prepared.loaded.module?.[exportName];
    if (!isCallable(action)) {
      throw new Error(`Lazy action export not found: ${exportName}`);
    }
    await action(prepared.runnerIdentity, ...args);
  };
}
