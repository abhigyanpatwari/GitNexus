/**
 * Import-aware taint-site matcher (#2083 M3 U2, plan KTD7).
 *
 * Classifies a function's harvested {@link SiteRecord}s against a registered
 * {@link SourceSinkSanitizerSpec}: which member reads are SOURCES, which
 * call/new sites are SINKS (and at which argument positions), and which are
 * SANITIZERS. Pure main-thread data work — sites + bindings come from the U1
 * worker harvest, imports from `ParsedFile.parsedImports`; no AST, no I/O.
 *
 * PRECONDITION: the caller must gate the CFG through `hasTaintSafeSites`
 * (taint/site-safety.ts) first — this module dereferences binding/site
 * indices without re-validating them.
 *
 * ## Callee resolution precedence (bare and member-rooted calls)
 *
 * 1. ESM import join — the callee root's local name is resolved through the
 *    {@link TaintImportIndex} built from `parsedImports` (`named`/`alias`
 *    members, `namespace`/default-import module handles); `import { exec as
 *    run } from 'child_process'` makes `run(c)` resolve to
 *    `child_process.exec`, and `import * as cp …` makes `cp.exec(c)` resolve
 *    the same way.
 * 2. require-literal join — a binding whose in-function defining site carries
 *    `requireArg` resolves like a namespace handle (`const cp =
 *    require('child_process'); cp.exec(c)`). A BARE call of a require-joined
 *    binding is matched under BOTH interpretations, `<module>.default` (the
 *    module/default export invoked directly) and `<module>.<localName>`
 *    (non-renamed destructured require — the harvest attaches `resultDefs`
 *    to destructured bindings without recording the property path, and the
 *    binding name IS the member name in the non-renamed case).
 * 3. Bare-name fallback — TRUE GLOBALS only (`global: true` entries: `eval`,
 *    `new Function`, `encodeURIComponent`), and only when the name is neither
 *    import-bound nor shadowed. Conventional receiver names (`req`/`request`
 *    member-read sources, `res.send`, `.query`/`.execute`) are matched
 *    name-based by their own mechanisms, never via the global fallback.
 *
 * ## Shadowing rule (exact)
 *
 * A name is treated as function-local — blocking import/global resolution —
 * iff the function's binding table contains a NON-`synthetic` entry with that
 * name (an in-function `function exec(){}` / `const exec = …`). Synthetic
 * bindings (kind `module`, `synthetic: true`) are imports, true globals, or
 * enclosing-scope captures and do not shadow. Member-call roots use the
 * harvested `receiver` binding index directly (no name scan).
 *
 * ## Documented resolution gaps (direction stated, per plan KTD10)
 *
 * - MODULE-LEVEL `const cp = require('child_process')`: the binding is
 *   synthetic inside the function, produces no `ParsedImport`, and its
 *   defining site lives outside the function's harvested sites — the
 *   require join cannot see it. Module-mechanism sinks miss (FN) and
 *   sanitizers don't kill (FP noise — never a false kill, the safe
 *   direction). Only in-function requires resolve.
 * - RENAMED destructured require (`const { exec: run } = require(…)`):
 *   the dual interpretation resolves `run` to `child_process.run` — no
 *   match (FN). Non-renamed destructures resolve exactly.
 * - CONSERVATIVE shadow scan for bare calls: ANY non-synthetic binding of
 *   the callee name anywhere in the function blocks import/global
 *   resolution, even when the shadow is block-scoped elsewhere and the call
 *   site actually sees the import (FN; rare; safe for sanitizers).
 * - MODULE-LEVEL user declarations are indistinguishable from imports in
 *   the binding table (both synthetic). ESM forbids a module-level
 *   declaration colliding with an import name, so the import join is
 *   authoritative when an import exists; a module-level user function
 *   shadowing a TRUE GLOBAL (e.g. a local `encodeURIComponent`) is not
 *   detectable and would still match (pathological; accepted).
 * - Handle COPIES (`const c2 = cp; c2.exec(…)`) are not followed — joins
 *   are one level deep (binding → import/require), never through
 *   assignments (FN).
 * - `this.`/`super.`-rooted and call-rooted callee chains have no
 *   resolvable root: only the syntactic `anyReceiver`/`receivers`
 *   mechanisms can match them.
 * - `reexport`/`wildcard`/`dynamic-*`/`side-effect` imports introduce no
 *   matcher-visible local binding and are skipped by the index.
 */

import type { ParsedImport } from 'gitnexus-shared';
import type { FunctionCfg, SiteRecord } from '../cfg/types.js';
import type {
  TaintCallResultSourceEntry,
  SourceSinkSanitizerSpec,
  TaintMemberSourceEntry,
  TaintSourceEntry,
  TaintSanitizerEntry,
  TaintSinkEntry,
} from './source-sink-config.js';

/** What a local name imported into the file denotes. */
export interface TaintImportBinding {
  /** Normalized module specifier (`node:` scheme stripped). */
  readonly module: string;
  /**
   * Exported member bound by a named/aliased import; `undefined` when the
   * local name is a MODULE HANDLE (namespace import, or a default import —
   * CJS interop makes the default export ≈ the module object).
   */
  readonly member?: string;
  /**
   * True when the provider says `module` already includes `member`; used for
   * class-like imports where a receiver call should resolve as
   * `<module>.<method>`, not `<module>.<member>.<method>`.
   */
  readonly targetIncludesMember?: boolean;
}

/** Local name → import provenance for one file. Build once per file (U4). */
export type TaintImportIndex = ReadonlyMap<string, TaintImportBinding>;

/** A member-read site matched as a taint source. */
export interface MatchedSourceRead {
  readonly type: 'member-read';
  /** Index into the owning statement's `sites` array. */
  readonly siteIndex: number;
  readonly entry: TaintMemberSourceEntry;
}

/** A call-result source matched on a call site with direct result definitions. */
export interface MatchedSourceCall {
  readonly type: 'call-result';
  /** Index into the owning statement's `sites` array. */
  readonly siteIndex: number;
  readonly entry: TaintCallResultSourceEntry;
  /** Bindings directly defined by this call result. Never empty. */
  readonly resultDefs: readonly number[];
}

export type MatchedSource = MatchedSourceRead | MatchedSourceCall;

/** A call/new site matched as a sink. */
export interface MatchedSinkCall {
  /** Index into the owning statement's `sites` array. */
  readonly siteIndex: number;
  readonly entry: TaintSinkEntry;
  /**
   * Positions (indices into `site.args`) that are registered sink positions
   * AND carry at least one recorded binding occurrence, after the spread
   * rule (a recorded position ≥ `site.spread` matches when any registered
   * position ≥ the spread index exists — runtime positions after a spread
   * are unknowable) and the template rule (`template: true` aggregates all
   * substitutions at position 0 and matches any-position). Never empty — a
   * sink whose dangerous positions carry no occurrences cannot produce a
   * finding and is not reported.
   */
  readonly argPositions: readonly number[];
}

/** A call site matched as a sanitizer (import-aware/global only — see module doc). */
export interface MatchedSanitizerCall {
  /** Index into the owning statement's `sites` array. */
  readonly siteIndex: number;
  readonly entry: TaintSanitizerEntry;
  /**
   * Bindings the sanitizer's result defines directly (`const b = escape(t)`
   * ⇒ `b`) — U3's kill targets (KTD4b). Empty for value-position sanitizer
   * calls (`exec(escape(x))`), whose effect is occurrence INTERPOSITION via
   * the site's `parent`/via-tag chain, not a def kill.
   */
  readonly resultDefs: readonly number[];
}

/** All matches within one statement. Emitted only when at least one list is non-empty. */
export interface StatementMatches {
  readonly blockIndex: number;
  readonly statementIndex: number;
  readonly line: number;
  readonly sources: readonly MatchedSource[];
  readonly sinks: readonly MatchedSinkCall[];
  readonly sanitizers: readonly MatchedSanitizerCall[];
}

/** Classified sites for one function, in (block, statement, site, entry) order. */
export interface FunctionSiteMatches {
  readonly statements: readonly StatementMatches[];
  /** Fast-path gates for U4: the solver runs only when both are true. */
  readonly hasSource: boolean;
  readonly hasSink: boolean;
}

const stripNodeScheme = (specifier: string): string =>
  specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;

const isCallResultSource = (entry: TaintSourceEntry): entry is TaintCallResultSourceEntry =>
  entry.type === 'call-result';

/**
 * Build the local-name → module/member index from a file's `parsedImports`.
 * Only `named`/`alias`/`namespace` kinds bind matcher-visible local names;
 * `importedName === 'default'` collapses to a module handle.
 */
export function buildTaintImportIndex(imports: readonly ParsedImport[]): TaintImportIndex {
  const index = new Map<string, TaintImportBinding>();
  for (const imp of imports) {
    if (imp.kind === 'named' || imp.kind === 'alias') {
      const module = stripNodeScheme(imp.targetRaw);
      index.set(
        imp.localName,
        imp.importedName === 'default'
          ? { module }
          : {
              module,
              member: imp.importedName,
              ...(imp.targetIncludesImportedName === true ? { targetIncludesMember: true } : {}),
            },
      );
    } else if (imp.kind === 'namespace') {
      index.set(imp.localName, { module: stripNodeScheme(imp.targetRaw) });
    }
  }
  return index;
}

/** Internal: a callee's resolution — canonical dotted names + syntactic path. */
interface ResolvedCallee {
  /** Syntactic dotted path segments (`cp.exec` ⇒ `['cp','exec']`). */
  readonly path: readonly string[];
  /** Module-resolved canonical names this callee may denote. */
  readonly canonical: readonly string[];
  /** True when the bare root may denote an ECMAScript global (unshadowed, un-imported). */
  readonly globalRoot: boolean;
}

/**
 * Classify a function's harvested sites against a language spec. See the
 * module doc for resolution precedence, the shadowing rule, and gaps.
 */
export function matchFunctionSites(
  cfg: FunctionCfg,
  spec: SourceSinkSanitizerSpec,
  imports: TaintImportIndex,
): FunctionSiteMatches {
  const bindings = cfg.bindings ?? [];

  // Non-synthetic (in-function-declared) binding indices by name — the
  // shadow scan + bare-call require-join lookup.
  const nonSyntheticByName = new Map<string, number[]>();
  bindings.forEach((b, i) => {
    if (b.synthetic === true) return;
    const list = nonSyntheticByName.get(b.name);
    if (list) list.push(i);
    else nonSyntheticByName.set(b.name, [i]);
  });

  // require-literal join: binding index → module specifier. A binding def'd
  // by two DIFFERENT require literals is conflicted → dropped (resolving it
  // either way could fabricate a sanitizer kill).
  const requireByBinding = new Map<number, string>();
  const conflicted = new Set<number>();
  for (const block of cfg.blocks) {
    for (const stmt of block.statements ?? []) {
      for (const site of stmt.sites ?? []) {
        if (site.requireArg === undefined || site.resultDefs === undefined) continue;
        const module = stripNodeScheme(site.requireArg);
        for (const def of site.resultDefs) {
          if (conflicted.has(def)) continue;
          const prior = requireByBinding.get(def);
          if (prior === undefined) requireByBinding.set(def, module);
          else if (prior !== module) {
            requireByBinding.delete(def);
            conflicted.add(def);
          }
        }
      }
    }
  }

  const resolveCallee = (site: SiteRecord): ResolvedCallee | undefined => {
    if (site.callee === undefined) return undefined;
    const path = site.callee.split('.');
    const root = path[0];
    const rest = path.slice(1);
    const canonical: string[] = [];
    let globalRoot = false;
    const canonicalBase = (imp: TaintImportBinding): string[] =>
      imp.member === undefined || imp.targetIncludesMember === true
        ? [imp.module]
        : [imp.module, imp.member];

    if (site.receiver !== undefined) {
      // Member chain with an identifier root — origin known by binding index.
      const rb = bindings[site.receiver];
      if (rb.synthetic === true) {
        const imp = imports.get(rb.name);
        if (imp !== undefined) {
          canonical.push([...canonicalBase(imp), ...rest].join('.'));
        }
      } else {
        const module = requireByBinding.get(site.receiver);
        if (module !== undefined) canonical.push([module, ...rest].join('.'));
      }
    } else if (path.length === 1) {
      // Bare call. `this`/`super`/call-rooted chains never get here (those
      // are dotted-without-receiver or callee-less).
      const locals = nonSyntheticByName.get(root);
      if (locals !== undefined) {
        // Shadowed by an in-function declaration — only the require join
        // applies, under the dual interpretation (module doc).
        for (const idx of locals) {
          const module = requireByBinding.get(idx);
          if (module !== undefined) canonical.push(`${module}.default`, `${module}.${root}`);
        }
      } else {
        const imp = imports.get(root);
        if (imp !== undefined) {
          canonical.push(
            imp.member === undefined
              ? `${imp.module}.default`
              : imp.targetIncludesMember === true
                ? imp.module
                : `${imp.module}.${imp.member}`,
          );
        } else {
          globalRoot = true;
        }
      }
    }
    return { path, canonical, globalRoot };
  };

  /** The spread/template/registered-position rule (see MatchedSinkCall doc). */
  const positionMatches = (entry: TaintSinkEntry, site: SiteRecord, p: number): boolean => {
    if (site.template === true) return true;
    if (entry.args === undefined) return true;
    if (site.spread !== undefined && p >= site.spread) {
      const spread = site.spread;
      return entry.args.some((q) => q >= spread);
    }
    return entry.args.includes(p);
  };

  const sinkMechanismHit = (
    entry: TaintSinkEntry,
    site: SiteRecord,
    r: ResolvedCallee,
  ): boolean => {
    if (entry.module !== undefined) return r.canonical.includes(`${entry.module}.${entry.name}`);
    if (entry.global === true) {
      return (
        r.globalRoot &&
        r.path.length === 1 &&
        r.path[0] === entry.name &&
        (entry.newOnly !== true || site.kind === 'new')
      );
    }
    if (entry.anyReceiver === true) {
      return r.path.length >= 2 && r.path[r.path.length - 1] === entry.name;
    }
    if (entry.receivers !== undefined) {
      return r.path.length === 2 && entry.receivers.includes(r.path[0]) && r.path[1] === entry.name;
    }
    return false;
  };

  // Sanitizers: module + global mechanisms ONLY — never receiver-conventional,
  // never bare-name for non-globals (a false kill is the forbidden direction).
  const sanitizerMechanismHit = (entry: TaintSanitizerEntry, r: ResolvedCallee): boolean => {
    if (entry.module !== undefined) return r.canonical.includes(`${entry.module}.${entry.name}`);
    if (entry.global === true) {
      return r.globalRoot && r.path.length === 1 && r.path[0] === entry.name;
    }
    return false;
  };

  const statements: StatementMatches[] = [];
  let hasSource = false;
  let hasSink = false;

  cfg.blocks.forEach((block, blockIndex) => {
    block.statements?.forEach((stmt, statementIndex) => {
      const sites = stmt.sites;
      if (sites === undefined || sites.length === 0) return;
      const sources: MatchedSource[] = [];
      const sinks: MatchedSinkCall[] = [];
      const sanitizers: MatchedSanitizerCall[] = [];

      sites.forEach((site, siteIndex) => {
        if (site.kind === 'member-read') {
          if (site.object === undefined || site.property === undefined) return;
          const objectName = bindings[site.object].name;
          const property = site.property;
          for (const entry of spec.sources) {
            if (isCallResultSource(entry)) continue;
            if (entry.objects.includes(objectName) && entry.properties.includes(property)) {
              sources.push({ type: 'member-read', siteIndex, entry });
            }
          }
          return;
        }
        // call / new
        const resolved = resolveCallee(site);
        if (resolved === undefined) return;
        if (site.kind === 'call') {
          const resultDefs = site.resultDefs;
          if (resultDefs !== undefined && resultDefs.length > 0) {
            for (const entry of spec.sources) {
              if (!isCallResultSource(entry)) continue;
              if (
                resolved.path.length === 2 &&
                entry.receivers.includes(resolved.path[0]) &&
                entry.methods.includes(resolved.path[1])
              ) {
                sources.push({
                  type: 'call-result',
                  siteIndex,
                  entry,
                  resultDefs,
                });
              }
            }
          }
        }
        for (const entry of spec.sinks) {
          if (!sinkMechanismHit(entry, site, resolved)) continue;
          const argPositions: number[] = [];
          site.args?.forEach((occurrences, p) => {
            if (occurrences.length > 0 && positionMatches(entry, site, p)) argPositions.push(p);
          });
          if (argPositions.length > 0) sinks.push({ siteIndex, entry, argPositions });
        }
        for (const entry of spec.sanitizers) {
          if (!sanitizerMechanismHit(entry, resolved)) continue;
          sanitizers.push({ siteIndex, entry, resultDefs: site.resultDefs ?? [] });
        }
      });

      if (sources.length === 0 && sinks.length === 0 && sanitizers.length === 0) return;
      hasSource ||= sources.length > 0;
      hasSink ||= sinks.length > 0;
      statements.push({ blockIndex, statementIndex, line: stmt.line, sources, sinks, sanitizers });
    });
  });

  return { statements, hasSource, hasSink };
}
