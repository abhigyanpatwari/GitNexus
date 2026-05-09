/**
 * Optional grammar availability check.
 *
 * tree-sitter-dart and tree-sitter-proto are optionalDependencies that
 * require a `node-gyp rebuild` at install time. The build can be skipped
 * via GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1 (postinstall scripts), or it can
 * silently soft-fail when the C++ toolchain is missing.
 *
 * Either path produces the same observable: the .node binding is absent
 * at runtime. This helper detects that condition and surfaces a single
 * stderr line per missing grammar so users learn why .dart/.proto support
 * is unavailable instead of silently getting a degraded index.
 */

import { createRequire } from 'module';
import { cliWarn } from './cli-message.js';

const _require = createRequire(import.meta.url);

interface OptionalGrammar {
  /** Display name in warnings */
  name: string;
  /** Module name to require.resolve */
  pkg: string;
  /** File extensions this grammar parses */
  extensions: string[];
}

const OPTIONAL_GRAMMARS: OptionalGrammar[] = [
  { name: 'tree-sitter-dart', pkg: 'tree-sitter-dart', extensions: ['.dart'] },
  { name: 'tree-sitter-proto', pkg: 'tree-sitter-proto', extensions: ['.proto'] },
];

export interface MissingGrammar {
  name: string;
  extensions: string[];
}

/**
 * Returns the list of optional grammars whose native binding cannot be
 * loaded. Actually `require()`s the package — `require.resolve` would
 * locate the entry path even when the `.node` binding is absent (the
 * `file:` package directory is installed regardless of postinstall
 * outcome), giving false negatives for the exact users we want to warn:
 * those who installed with `GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1` or whose
 * native rebuild soft-failed for missing toolchain.
 *
 * Node's module cache memoizes `require()` for us — calling this multiple
 * times is cheap. The catch distinguishes "missing" (MODULE_NOT_FOUND or
 * the typical node-gyp-build "could not find any binding" pattern) from
 * "broken" (SyntaxError, EACCES, native crash). Broken bindings surface a
 * separate stderr line so users get an actionable message instead of a
 * misleading "reinstall" hint.
 */
export function detectMissingOptionalGrammars(): MissingGrammar[] {
  const missing: MissingGrammar[] = [];
  for (const g of OPTIONAL_GRAMMARS) {
    try {
      _require(g.pkg);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const msg = err instanceof Error ? err.message : String(err);
      const looksMissing =
        code === 'MODULE_NOT_FOUND' ||
        code === 'ERR_MODULE_NOT_FOUND' ||
        /could not find|no native build|prebuilds/i.test(msg);
      if (!looksMissing) {
        // Present but broken — surface so the user doesn't get a misleading
        // "reinstall" recovery message that wouldn't actually help. cliWarn
        // writes plain text to stderr AND tees a structured logger.warn
        // record; the merged repo-wide ESLint pino-migration rule forbids
        // direct `console.error` in CLI code (only `console.log` is allowed
        // there for tool-data stdout output).
        cliWarn(
          `GitNexus: optional grammar "${g.name}" is installed but failed to load (${msg.slice(0, 200)}). ${g.extensions.join('/')} files will not be parsed.`,
          { grammar: g.name, extensions: g.extensions, error: msg },
        );
      }
      missing.push({ name: g.name, extensions: g.extensions });
    }
  }
  return missing;
}

/**
 * Log a one-line stderr warning for each missing grammar. Safe to call
 * unconditionally — silent if all grammars are present.
 *
 * `relevantExtensions`, if provided, filters the warning to grammars whose
 * extensions appear in the set (e.g. an analyze run can pass the set of
 * extensions actually present in the target repo so users without any
 * .dart/.proto files don't see noise).
 */
export function warnMissingOptionalGrammars(opts?: {
  context?: string;
  relevantExtensions?: ReadonlySet<string>;
}): void {
  const missing = detectMissingOptionalGrammars();
  if (missing.length === 0) return;
  const ctx = opts?.context ? ` [${opts.context}]` : '';
  // Hoist the optional set into a local so the closure below can narrow
  // its type; references to `opts?.relevantExtensions` inside `.some()`
  // lose the outer null-check narrowing and require a non-null assertion.
  const relevantExtensions = opts?.relevantExtensions;
  for (const g of missing) {
    if (relevantExtensions && !g.extensions.some((e) => relevantExtensions.has(e))) {
      continue;
    }
    cliWarn(
      `GitNexus${ctx}: optional grammar "${g.name}" is unavailable — ${g.extensions.join('/')} files will not be parsed. Reinstall without GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1 (and ensure python3, make, g++) to enable.`,
      { grammar: g.name, extensions: g.extensions, context: opts?.context },
    );
  }
}
