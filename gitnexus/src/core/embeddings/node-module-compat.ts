/**
 * The single access point for `module.registerHooks` (#2372).
 *
 * `module.registerHooks` — the synchronous ESM/CJS resolution-hook API the
 * embedding-stack resolvers rely on — was added in Node 22.15.0 (and 23.5.0 on
 * the 23.x line). The gitnexus engines floor is `>=22.0.0`, which admits Node
 * 22.0–22.14 AND 23.0–23.4, where the export is absent.
 *
 * In this `"type": "module"` package, a *static named* import of a missing
 * builtin export (`import { registerHooks } from 'node:module'`) is a
 * `SyntaxError` at ESM link time — thrown before any `typeof registerHooks`
 * guard in the module body can run, so every module carrying that import fails
 * to load on those Node versions. This module owns the only namespace import of
 * `node:module` and hands callers a value-or-`undefined` they guard at runtime,
 * so the graceful-degradation path is finally reachable.
 *
 * `@types/node` types `registerHooks` as always-present, so `nodeModule.registerHooks`
 * would type as defined while being `undefined` at runtime on older Node. The
 * `Partial` narrow surfaces the real optionality without an `any` cast.
 */
import * as nodeModule from 'node:module';

/** `module.registerHooks` if this Node exposes it (>=22.15 / >=23.5), else `undefined`. */
export const getRegisterHooks = (): typeof nodeModule.registerHooks | undefined =>
  (nodeModule as Partial<typeof nodeModule>).registerHooks;
