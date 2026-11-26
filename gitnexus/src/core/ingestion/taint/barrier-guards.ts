/**
 * Validating-predicate barrier guards (#3913).
 *
 * Taint is killed by transforming sanitizers today. Patched CVEs often guard
 * a sink with a validating predicate instead (`if (!isValidHostName(x)) return;
 * exec(x)`). When the sink use of binding `b` is control-dependent on such a
 * predicate over `b` on the *validated* branch sense, suppress the finding.
 *
 * Proto-key helpers (`return key !== "__proto__"`) are discovered for
 * same-file writers, but only name-heuristic validators (`isValid*` /
 * `validate*` / `validX`) KIND_ORDER-suppress — rejecting `__proto__` alone
 * must not kind-blind kill command-injection. `.filter(pred)` is intentionally
 * not a neutralization path for the same reason.
 *
 * PURE AND DETERMINISTIC: no I/O, no logger. Under-kill only — unknown or
 * non-dominating predicates never kill.
 */
import {
  computeControlDependence,
  type CdgLabel,
  type ControlDepEdge,
} from '../cfg/control-dependence.js';
import type { FunctionCfg, SiteRecord } from '../cfg/types.js';
import type { ProgramPoint } from '../cfg/reaching-defs.js';

export interface BarrierController {
  readonly controllerBlock: number;
  readonly subjectBinding: number;
  /** CDG label on which the subject is considered validated. */
  readonly validatedLabel: CdgLabel;
  readonly siteIndex: number;
  readonly statementIndex: number;
  readonly callee: string;
}

export interface BarrierGuardIndex {
  /** Controllers keyed by the binding they validate. */
  readonly bySubject: ReadonlyMap<number, readonly BarrierController[]>;
  /** CDG edges for this function (empty when CDG is unavailable/empty). */
  readonly cdg: readonly ControlDepEdge[];
  /**
   * Callee leaf names treated as barriers for this file (name heuristic +
   * `__proto__` guard functions discovered across sibling CFGs).
   */
  readonly barrierCalleeNames: ReadonlySet<string>;
}

export interface BarrierGuardOptions {
  /** Extra barrier callee leaf names (e.g. proto-guard functions). */
  readonly extraBarrierCallees?: ReadonlySet<string>;
  /** Precomputed CDG edges (tests); otherwise computed when needed. */
  readonly cdgEdges?: readonly ControlDepEdge[];
}

/**
 * Validator-name heuristic (#3913), under-kill only.
 *
 * Accepts `isValid*` / `validate*` / `validX` shapes that vouch for the value.
 * Rejects:
 * - bare `isX` / `checkX` / `hasX` (e.g. `checkToken` must not kill command-injection)
 * - names containing `invalid` (`isInvalid` must not barrier the true branch)
 * - builtins like `isNaN` / `isArray`
 */
export function isBarrierCalleeName(callee: string): boolean {
  const base = calleeLeaf(callee);
  if (!base) return false;
  if (/invalid/i.test(base)) return false;
  if (/^isValid/i.test(base)) return true;
  if (/^validate/i.test(base)) return true;
  // `validHost` / `validKey` — but not substring matches inside unrelated words.
  if (/^valid[A-Z_]/.test(base)) return true;
  return false;
}

export function calleeLeaf(callee: string): string {
  if (!callee) return '';
  return callee.includes('.') ? (callee.split('.').pop() ?? callee) : callee;
}

const PROTO_LIT = `['"]__proto__['"]`;

/** True when `text` affirms the key is not `__proto__` (return or expr body). */
function isAffirmingProtoRejectReturn(text: string): boolean {
  if (!new RegExp(PROTO_LIT).test(text)) return false;
  // Inverted acceptors return false when key !== "__proto__" — not a guard.
  if (/\breturn\s+false\b/.test(text)) return false;
  const rejectsProto =
    new RegExp(`!==\\s*${PROTO_LIT}`).test(text) ||
    new RegExp(`(?<![=!])!=(?!=)\\s*${PROTO_LIT}`).test(text) ||
    new RegExp(`${PROTO_LIT}\\s*!==`).test(text) ||
    new RegExp(`${PROTO_LIT}\\s*!=(?!=)`).test(text) ||
    text.includes('includes(') ||
    text.includes('indexOf(');
  if (!rejectsProto) return false;
  // `return key !== "__proto__"` (possibly with &&).
  if (/\breturn\b/.test(text)) return true;
  // Expression-bodied arrow: whole block is the predicate. Reject bare
  // parenthesized conditions like `(key !== "__proto__")` from `if (...)`.
  let s = text.replace(/\s+/g, '');
  while (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1);
  if (
    !s.includes('&&') &&
    !s.includes('||') &&
    !s.includes('includes(') &&
    !s.includes('indexOf(')
  ) {
    return false;
  }
  return true;
}

/** True when `text` has a real `===`/`==` against `__proto__` (not `!==`/`!=`). */
function hasProtoEquality(text: string): boolean {
  return (
    new RegExp(`(?<![=!])===\\s*${PROTO_LIT}`).test(text) ||
    new RegExp(`(?<![=!])==(?!=)\\s*${PROTO_LIT}`).test(text) ||
    new RegExp(`${PROTO_LIT}\\s*===`).test(text) ||
    new RegExp(`${PROTO_LIT}\\s*==(?!=)`).test(text)
  );
}

/**
 * True when a function CFG body *rejects* the `__proto__` key.
 * Under-kill: require an affirming `return … !== "__proto__"` (set-value
 * shape), or equality + `return false`. Inequality only in an `if` that
 * returns false for safe keys (`acceptsProto`) must not qualify.
 */
export function functionContainsProtoGuard(cfg: FunctionCfg): boolean {
  let sawEqualityProto = false;
  let sawReturnFalse = false;
  for (const block of cfg.blocks) {
    const text = block.text;
    if (/\breturn\s+false\b/.test(text)) sawReturnFalse = true;
    if (isAffirmingProtoRejectReturn(text)) return true;
    if (hasProtoEquality(text)) sawEqualityProto = true;
  }
  return sawEqualityProto && sawReturnFalse;
}

/**
 * Discover same-file functions whose body guards against `__proto__`
 * (#3913 proposal §2). Requires `functionName` on the CFG (TS/JS harvest).
 */
export function discoverProtoGuardCallees(cfgs: readonly FunctionCfg[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const cfg of cfgs) {
    if (!cfg.functionName) continue;
    if (functionContainsProtoGuard(cfg)) out.add(cfg.functionName);
  }
  return out;
}

/** Optional `qual.qual.` prefix before a callee leaf. */
const QUALIFIED_PREFIX = '(?:[A-Za-z_$][\\w$]*\\.)*';

/**
 * True when the condition is ONLY the validator call (optional parens / !,
 * optional `qual.` chain). Rejects compounds like `isValid(x) || debugMode`
 * that can take the true branch without the validator accepting.
 */
export function isSimpleValidatorCondition(blockText: string, callee: string): boolean {
  const leaf = calleeLeaf(callee);
  if (!leaf || !blockText.includes(leaf)) return false;
  if (blockText.includes('||') || blockText.includes('&&') || blockText.includes('??'))
    return false;
  let s = blockText.replace(/\s+/g, '');
  while (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1);
  const escaped = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // [!][qual.]*leaf(...) — supports `!validators.isValidHostName(x)`.
  return new RegExp(`^!*${QUALIFIED_PREFIX}${escaped}\\([^)]*\\)$`).test(s);
}

/**
 * Which CDG label means "predicate accepted / validated" for a condition
 * block whose text wraps `callee`. Odd leading `!` before the (possibly
 * qualified) call flips true→F. Returns undefined when the condition is not
 * a simple validator expression.
 */
export function validatedLabelForCondition(
  blockText: string,
  callee: string,
): CdgLabel | undefined {
  if (!isSimpleValidatorCondition(blockText, callee)) return undefined;
  const leaf = calleeLeaf(callee);
  let s = blockText.replace(/\s+/g, '');
  while (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1);
  const escaped = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Capture leading bangs before any `qual.` chain + leaf.
  const m = s.match(new RegExp(`^(!*)${QUALIFIED_PREFIX}${escaped}\\(`));
  if (!m) return undefined;
  return m[1].length % 2 === 0 ? 'T' : 'F';
}

/** Direct binding indices in argument position `pos` only (not thisArg etc.). */
function argPositionBindings(site: SiteRecord, pos: number): number[] {
  const out: number[] = [];
  const entries = site.args?.[pos];
  if (!entries) return out;
  for (const e of entries) {
    if (typeof e === 'number') out.push(e);
  }
  return out;
}

/** First-argument bindings only — the value a unary validator checks. */
function primaryArgBindings(site: SiteRecord): number[] {
  return argPositionBindings(site, 0);
}

function isFilterCallee(callee: string | undefined): boolean {
  if (!callee) return false;
  return callee === 'filter' || callee.endsWith('.filter');
}

function isBarrierCallName(callee: string, barrierCalleeNames: ReadonlySet<string>): boolean {
  if (isBarrierCalleeName(callee)) return true;
  return barrierCalleeNames.has(calleeLeaf(callee));
}

/** Collect validating-predicate controllers from CFG call sites. */
export function collectBarrierControllers(
  cfg: FunctionCfg,
  barrierCalleeNames: ReadonlySet<string> = new Set(),
): BarrierController[] {
  const out: BarrierController[] = [];
  for (const block of cfg.blocks) {
    const statements = block.statements;
    if (!statements) continue;
    for (let statementIndex = 0; statementIndex < statements.length; statementIndex++) {
      const stmt = statements[statementIndex];
      const sites = stmt.sites;
      if (!sites) continue;
      for (let siteIndex = 0; siteIndex < sites.length; siteIndex++) {
        const site = sites[siteIndex];
        if (site.kind !== 'call' || !site.callee) continue;
        if (!isBarrierCallName(site.callee, barrierCalleeNames)) continue;
        // Skip `.filter(…)` — not a CDG validator call (and not a kind-safe kill).
        if (isFilterCallee(site.callee)) continue;
        // Only the primary (first) argument is the validated subject — later
        // args may be options / unrelated tainted values.
        const subjects = primaryArgBindings(site);
        if (subjects.length === 0) continue;
        const validatedLabel = validatedLabelForCondition(block.text, site.callee);
        if (validatedLabel === undefined) continue; // compound / non-simple condition
        for (const subjectBinding of subjects) {
          out.push({
            controllerBlock: block.index,
            subjectBinding,
            validatedLabel,
            siteIndex,
            statementIndex,
            callee: site.callee,
          });
        }
      }
    }
  }
  return out;
}

/** Build a per-function barrier index (CDG + controllers + name set). */
export function buildBarrierGuardIndex(
  cfg: FunctionCfg,
  options?: BarrierGuardOptions,
): BarrierGuardIndex {
  const barrierCalleeNames = new Set<string>(options?.extraBarrierCallees ?? []);
  const controllers = collectBarrierControllers(cfg, barrierCalleeNames);
  const bySubject = new Map<number, BarrierController[]>();
  for (const c of controllers) {
    const list = bySubject.get(c.subjectBinding);
    if (list) list.push(c);
    else bySubject.set(c.subjectBinding, [c]);
  }
  const needsCdg = controllers.length > 0;
  const cdg =
    options?.cdgEdges ??
    (needsCdg ? computeControlDependence(cfg).edges : ([] as ControlDepEdge[]));
  return { bySubject, cdg, barrierCalleeNames };
}

/**
 * True when `sinkBlock` is control-dependent on a validating predicate over
 * `bindingIdx` on the validated branch sense.
 *
 * When `taintDefPoint` is provided, refuse the barrier if that def was itself
 * assigned on the validated branch (value reassigned after the check).
 */
export function isBarrierGuarded(
  index: BarrierGuardIndex,
  bindingIdx: number,
  sinkBlock: number,
  taintDefPoint?: ProgramPoint,
): BarrierController | undefined {
  const controllers = index.bySubject.get(bindingIdx);
  if (!controllers || controllers.length === 0) return undefined;
  for (const edge of index.cdg) {
    if (edge.dependentBlock !== sinkBlock) continue;
    for (const c of controllers) {
      if (c.controllerBlock !== edge.controllerBlock) continue;
      if (c.validatedLabel !== edge.label) continue;
      // Reassignment after validation: the reaching def lives on the validated
      // branch of the same controller → the checked value was overwritten.
      if (taintDefPoint !== undefined) {
        const defAfterCheck = index.cdg.some(
          (e) =>
            e.controllerBlock === c.controllerBlock &&
            e.dependentBlock === taintDefPoint.blockIndex &&
            e.label === c.validatedLabel,
        );
        if (defAfterCheck) continue;
      }
      return c;
    }
  }
  return undefined;
}

/** Program point of a barrier controller (for SANITIZES / kill records). */
export function barrierControllerPoint(
  cfg: FunctionCfg,
  controller: BarrierController,
): ProgramPoint {
  const line =
    cfg.blocks[controller.controllerBlock]?.statements?.[controller.statementIndex]?.line ?? 0;
  return {
    blockIndex: controller.controllerBlock,
    stmtIndex: controller.statementIndex,
    line,
  };
}
