/**
 * Validating-predicate barrier guards (#3913).
 *
 * Taint is killed by transforming sanitizers today. Patched CVEs often guard
 * a sink with a validating predicate instead (`if (!isValidHostName(x)) return;
 * exec(x)`), filter keys through a `__proto__` guard (set-value), or early-
 * return on a config flag. When the sink use of binding `b` is control-
 * dependent on such a predicate over `b` on the *validated* branch sense —
 * or flows through `.filter(isValidKey)` — suppress the finding.
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

/** Builtins that match `isX`/`hasX` but are not security validators. */
const BARRIER_NAME_DENYLIST = new Set([
  'isNaN',
  'isFinite',
  'isArray',
  'isInteger',
  'isSafeInteger',
  'isPrototypeOf',
  'isView',
  'hasOwnProperty',
  'hasOwn',
  'has',
]);

/**
 * Validator-name heuristic from #3913: `isX` / `validX` / `test`-shaped,
 * minus known non-security builtins.
 */
export function isBarrierCalleeName(callee: string): boolean {
  const base = calleeLeaf(callee);
  if (!base || BARRIER_NAME_DENYLIST.has(base)) return false;
  if (/valid/i.test(base)) return true;
  if (/^check[A-Z_]/.test(base)) return true;
  if (/^validate/i.test(base)) return true;
  if (/^is[A-Z_]/.test(base)) return true;
  if (/^has[A-Z_]/.test(base)) return true;
  if (base === 'test') return true;
  return false;
}

export function calleeLeaf(callee: string): string {
  if (!callee) return '';
  return callee.includes('.') ? (callee.split('.').pop() ?? callee) : callee;
}

/** True when a function CFG body compares against the `__proto__` literal. */
export function functionContainsProtoGuard(cfg: FunctionCfg): boolean {
  for (const block of cfg.blocks) {
    const text = block.text;
    if (!text.includes('__proto__')) continue;
    // Require a comparison / inequality so a comment alone cannot qualify.
    if (
      /['"]__proto__['"]/.test(text) &&
      (text.includes('===') ||
        text.includes('!==') ||
        text.includes('==') ||
        text.includes('!=') ||
        text.includes('includes(') ||
        text.includes('indexOf('))
    )
      return true;
  }
  return false;
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

/**
 * Which CDG label means "predicate accepted / validated" for a condition
 * block whose text wraps `callee`. Odd leading `!` flips true→F.
 */
export function validatedLabelForCondition(blockText: string, callee: string): CdgLabel {
  const leaf = calleeLeaf(callee);
  const idx = blockText.indexOf(leaf);
  if (idx < 0) return 'T';
  let bangs = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const c = blockText[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '(') continue;
    if (c === '!') {
      bangs++;
      continue;
    }
    break;
  }
  return bangs % 2 === 0 ? 'T' : 'F';
}

function directArgBindings(site: SiteRecord): number[] {
  const out: number[] = [];
  const args = site.args;
  if (!args) return out;
  for (const entries of args) {
    for (const e of entries) {
      if (typeof e === 'number') out.push(e);
    }
  }
  return out;
}

function isFilterCallee(callee: string | undefined): boolean {
  if (!callee) return false;
  return callee === 'filter' || callee.endsWith('.filter');
}

function callbackIsBarrier(
  site: SiteRecord,
  bindings: FunctionCfg['bindings'],
  barrierCalleeNames: ReadonlySet<string>,
): boolean {
  for (const bindingIdx of directArgBindings(site)) {
    const name = bindings?.[bindingIdx]?.name;
    if (!name) continue;
    if (isBarrierCalleeName(name) || barrierCalleeNames.has(name)) return true;
  }
  return false;
}

/**
 * True when `site` is a `.filter(barrierPred)` call whose callback name is a
 * barrier callee (set-value shape). Chained forms like
 * `path.split(".").filter(isValidKey)` harvest the outer call without a static
 * callee path (receiver is a call result); those are recognized via
 * `statementText` containing `.filter(`.
 */
export function isFilterBarrierCall(
  site: SiteRecord,
  bindings: FunctionCfg['bindings'],
  barrierCalleeNames: ReadonlySet<string>,
  statementText?: string,
): boolean {
  if (site.kind !== 'call') return false;
  if (!callbackIsBarrier(site, bindings, barrierCalleeNames)) return false;
  if (isFilterCallee(site.callee)) return true;
  // Chained `.filter(pred)` — no callee, has result defs, statement spells filter.
  if (
    !site.callee &&
    site.resultDefs &&
    site.resultDefs.length > 0 &&
    typeof statementText === 'string' &&
    /\.filter\s*\(/.test(statementText)
  )
    return true;
  return false;
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
        // `.filter(isValidKey)` is handled as a flow neutralization, not CDG.
        if (isFilterCallee(site.callee)) continue;
        const subjects = directArgBindings(site);
        if (subjects.length === 0) continue;
        const validatedLabel = validatedLabelForCondition(block.text, site.callee);
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
 */
export function isBarrierGuarded(
  index: BarrierGuardIndex,
  bindingIdx: number,
  sinkBlock: number,
): BarrierController | undefined {
  const controllers = index.bySubject.get(bindingIdx);
  if (!controllers || controllers.length === 0) return undefined;
  for (const edge of index.cdg) {
    if (edge.dependentBlock !== sinkBlock) continue;
    for (const c of controllers) {
      if (c.controllerBlock !== edge.controllerBlock) continue;
      if (c.validatedLabel !== edge.label) continue;
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
