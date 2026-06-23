/**
 * Source/sink/sanitizer config model (issue #2080 M0 seam, extended by #2083
 * M3 U2).
 *
 * The per-language taint configuration *shape*. M0 shipped only the bare
 * `{name, args?}` callable matcher and an empty registry seam; M3 U2 extends
 * it with the `kind` taxonomy and the resolution-mechanism fields the
 * import-aware matcher (`taint/match.ts`) needs, and fills the registry with
 * the built-in TS/JS model (`taint/typescript-model.ts`).
 *
 * Design rule: entries describe WHAT a callable is (category + how its name
 * resolves), never HOW matching works — matching semantics (import joins,
 * shadow checks, spread/template position rules) live in the matcher so the
 * spec stays declarative data that can hash into `taintModelVersion`.
 */

/** Categories of taint sources. M3 ships remote HTTP input only. */
export type SourceKind = 'remote-input';

/**
 * Vulnerability categories for sinks. Sanitizers reference the SAME taxonomy
 * via {@link TaintSanitizerEntry.neutralizes}: a sanitizer kill applies only
 * when it neutralizes the matched sink's kind (`path.basename` strips
 * directories, not shell metacharacters — a kind-blind kill is a suppressed
 * live command injection, the forbidden false-negative direction).
 */
export type SinkKind =
  | 'command-injection'
  | 'code-injection'
  | 'path-traversal'
  | 'sql-injection'
  | 'xss';

/**
 * Identifies a callable that participates in taint flow. `name` is the
 * callable's own (unqualified) name — qualification comes from the
 * resolution-mechanism fields on the extending entry types, not from dotted
 * `name` strings. `args` optionally narrows to specific 0-based argument
 * positions that carry taint into a sink (or are cleared by a sanitizer);
 * omit to mean "all positions".
 */
export interface TaintCallableMatcher<K extends string = string> {
  readonly name: string;
  readonly args?: readonly number[];
  /** Category label — drives finding classification and sanitizer kind-compat. */
  readonly kind: K;
}

/**
 * A sink callable. Exactly one resolution mechanism should be set per entry:
 *
 * - `module` — the callable lives in a package/builtin module; the matcher
 *   resolves call sites against it import-aware (ESM `parsedImports` aliases,
 *   namespace handles, and the CommonJS `require('<literal>')` join). `name`
 *   is the exported member (`'exec'` of `'child_process'`); the pseudo-name
 *   `'default'` denotes invoking the module's default export / the module
 *   handle itself.
 * - `global` — a true ECMAScript global (`eval`, `Function`); matched by bare
 *   name only when the name is not shadowed by an in-function declaration and
 *   not bound by an import. `newOnly` further restricts to `new` expressions
 *   (`new Function(body)`).
 * - `anyReceiver` — a method matched on ANY receiver chain by its final
 *   segment (`.query(sql)` / `.execute(sql)` on whatever the DB handle is
 *   named) — deliberately name-conventional, like Semgrep's default rules.
 * - `receivers` — a method matched only on the listed conventional receiver
 *   names (`res.send` / `res.write`); exactly `<receiver>.<name>`, name-based.
 */
export interface TaintSinkEntry extends TaintCallableMatcher<SinkKind> {
  readonly module?: string;
  readonly global?: boolean;
  /** Only meaningful with `global`: match `new <name>(…)` sites only. */
  readonly newOnly?: boolean;
  readonly anyReceiver?: boolean;
  readonly receivers?: readonly string[];
}

/**
 * A sanitizer callable. Carries the sink kinds it `neutralizes` instead of a
 * `kind` of its own. STRICTER resolution than sinks by design: only the
 * `module` (import-aware) and `global` mechanisms exist — never a bare-name
 * convention — because a sanitizer mis-match is a false KILL (a user's own
 * `escape` helper must not suppress findings), while a sink mis-match is
 * merely noise. `args` narrows which argument positions are cleared (omit =
 * all).
 */
export interface TaintSanitizerEntry {
  readonly name: string;
  readonly args?: readonly number[];
  readonly neutralizes: readonly SinkKind[];
  readonly module?: string;
  readonly global?: boolean;
}

/**
 * A member-read taint source: reading `<object>.<property>` where the object
 * is one of the conventional receiver `objects` names (`req`/`request`) and
 * the property is one of `properties` (`body`, `query`, …). Matching is
 * name-based on the harvested `member-read` site (Semgrep-convention, not
 * type-aware — the accepted M3 FP/FN trade recorded in the plan's risk
 * table). One entry fans out over the objects × properties product. `type`
 * remains optional so existing/custom model objects that predate the
 * discriminant continue to load as member-read sources.
 */
export interface TaintMemberSourceEntry {
  readonly type?: 'member-read';
  readonly kind: SourceKind;
  readonly objects: readonly string[];
  readonly properties: readonly string[];
}

/**
 * A call-result taint source: the result of `<receiver>.<method>(...)` becomes
 * tainted, but only when the call site records direct `resultDefs`. This keeps
 * source seeding tied to proven data-flow destinations instead of treating an
 * arbitrary nested call expression as a value occurrence.
 */
export interface TaintCallResultSourceEntry {
  readonly type: 'call-result';
  readonly kind: SourceKind;
  readonly receivers: readonly string[];
  readonly methods: readonly string[];
}

export type TaintSourceEntry = TaintMemberSourceEntry | TaintCallResultSourceEntry;

/**
 * The taint configuration for a single language: which member reads introduce
 * taint (sources), which callables are dangerous to reach with tainted input
 * (sinks), and which callables clear it (sanitizers). M3 sources are
 * member-read entries for JS/TS/Python and call-result entries for languages
 * whose request APIs return tainted values from calls.
 */
export interface SourceSinkSanitizerSpec {
  readonly sources: readonly TaintSourceEntry[];
  readonly sinks: readonly TaintSinkEntry[];
  readonly sanitizers: readonly TaintSanitizerEntry[];
}

/**
 * Canonical deterministic ordering of {@link SinkKind} values. The single
 * source of this order — the intra-procedural propagation engine
 * (`propagate.ts`) and the M4 summary harvest (`summary-harvest.ts`) both sort
 * `neutralized`/exclusion sets by it so their deterministic outputs (and the
 * summary version stamp) stay stable. Lives here, next to the `SinkKind`
 * union, so the two consumers never drift.
 */
export const SINK_KIND_ORDER: readonly SinkKind[] = [
  'code-injection',
  'command-injection',
  'path-traversal',
  'sql-injection',
  'xss',
];

const SINK_KIND_RANK = new Map<SinkKind, number>(SINK_KIND_ORDER.map((k, i) => [k, i]));

/** Dedupe + sort sink kinds by {@link SINK_KIND_ORDER} (deterministic). */
export function sortSinkKinds(kinds: Iterable<SinkKind>): SinkKind[] {
  return [...new Set(kinds)].sort(
    (a, b) => (SINK_KIND_RANK.get(a) ?? 99) - (SINK_KIND_RANK.get(b) ?? 99),
  );
}

/** Rank of a sink kind in {@link SINK_KIND_ORDER} (for comparator chaining). */
export function sinkKindRank(kind: SinkKind): number {
  return SINK_KIND_RANK.get(kind) ?? 99;
}
