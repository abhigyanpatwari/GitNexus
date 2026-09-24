/**
 * Import-target resolver for JavaScript.
 *
 * Delegates to the TypeScript resolver, which is correct rather than merely
 * convenient: `jsconfig.json` is a tsconfig by another name, `package.json`
 * governs both languages identically, and Node's algorithm does not branch on
 * which of the two wrote the file. The extension list already carries the JS
 * family, so a `.js`/`.jsx`/`.mjs`/`.cjs` source resolves the same way.
 *
 * CJS `require()` calls reference the same module-path strings as ESM `import`
 * statements, so the resolver handles them uniformly with no CJS-specific
 * logic here.
 *
 * ## What #2953 removed
 *
 * This adapter used to reach `resolveImportPath`, whose last step was
 * `suffixResolve` — a search for any repo file whose path ends in the
 * specifier, retried with each leading segment dropped. The header this
 * replaces recorded the symptom without naming it a defect: `import 'app/main'`
 * resolving to `node_modules/dep/lib/main.js`, "the first `/main.js` in file
 * order". A bare specifier now resolves only through a declared tsconfig
 * mapping or a package manifest, and otherwise not at all.
 */

import type { NodeWorkspacePackages } from '../../import-resolvers/node-workspace-packages.js';
import { resolveTsTarget } from '../typescript/import-target.js';
import type { TsconfigIndex } from '../typescript/tsconfig.js';

interface JsResolutionConfig {
  readonly tsconfigs?: TsconfigIndex | null;
  readonly nodeWorkspacePackages?: NodeWorkspacePackages | null;
}

/** Build the JavaScript `resolveImportTarget` adapter. */
export function makeJsResolveImportTarget(): (
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
  resolutionConfig?: unknown,
) => string | readonly string[] | null {
  return (targetRaw, fromFile, allFilePaths, resolutionConfig) => {
    const cfg = resolutionConfig as JsResolutionConfig | undefined;
    return resolveTsTarget(targetRaw, {
      fromFile,
      allFilePaths,
      tsconfigs: cfg?.tsconfigs ?? null,
      nodeWorkspacePackages: cfg?.nodeWorkspacePackages ?? null,
    });
  };
}
