/**
 * Validating-predicate barrier guards (#3913).
 *
 * Taint is killed by transforming sanitizers today. Patched CVEs often guard
 * a sink with a validating predicate instead (`if (!isValidHostName(x)) return;
 * exec(x)`). When the sink use of binding `b` is control-dependent on such a
 * predicate over `b` on the *validated* branch sense, suppress the finding —
 * CodeQL's barrier-guard shape.
 *
 * PURE AND DETERMINISTIC: no I/O, no logger. Under-kill only — unknown or
 * non-dominating predicates never kill. Slice 1 uses a narrow name heuristic
 * (must look like a validator); model-registered barriers are a follow-up.
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
}

/**
 * Narrow validator-name heuristic. Requires a validity signal so ordinary
 * predicates (`isNaN`, `isArray`, `hasOwnProperty`) cannot false-kill.
 */
export function isBarrierCalleeName(callee: string): boolean {
  const base = callee.includes('.') ? (callee.split('.').pop() ?? callee) : callee;
  if (!base) return false;
  if (/valid/i.test(base)) return true;
  if (/^check[A-Z_]/.test(base)) return true;
  if (/^validate/i.test(base)) return true;
  return false;
}

/**
 * Which CDG label means "predicate accepted / validated" for a condition
 * block whose text wraps `callee`. Odd leading `!` flips true→F.
 */
export function validatedLabelForCondition(blockText: string, callee: string): CdgLabel {
  const idx = blockText.indexOf(callee);
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

/** Collect validating-predicate controllers from CFG call sites. */
export function collectBarrierControllers(cfg: FunctionCfg): BarrierController[] {
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
        if (site.kind !== 'call' || !site.callee || !isBarrierCalleeName(site.callee)) continue;
        const subjects = directArgBindings(site);
        if (subjects.length === 0) continue;
        const validatedLabel = validatedLabelForCondition(block.text, site.callee);
        // One controller per subject binding (multi-arg validators still
        // barrier each named argument independently).
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

/** Build a per-function barrier index (CDG + controllers). */
export function buildBarrierGuardIndex(
  cfg: FunctionCfg,
  cdgEdges?: readonly ControlDepEdge[],
): BarrierGuardIndex {
  const controllers = collectBarrierControllers(cfg);
  const bySubject = new Map<number, BarrierController[]>();
  for (const c of controllers) {
    const list = bySubject.get(c.subjectBinding);
    if (list) list.push(c);
    else bySubject.set(c.subjectBinding, [c]);
  }
  const cdg =
    cdgEdges ??
    (controllers.length > 0 ? computeControlDependence(cfg).edges : ([] as ControlDepEdge[]));
  return { bySubject, cdg };
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
