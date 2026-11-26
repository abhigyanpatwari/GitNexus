/**
 * Validating-predicate barrier guards (#3913).
 *
 * Taint is killed by transforming sanitizers today. Patched CVEs often guard
 * a sink with a validating predicate instead (`if (!isValidHostName(x)) return;
 * exec(x)`). When the sink use of binding `b` is control-dependent on such a
 * predicate over `b` on the *validated* branch sense, suppress the finding.
 *
 * Controllers are name-heuristic only (`isValid*` / `validate*` / `validX`).
 * Same-file affirming `__proto__` reject helpers are *excluded* from that set
 * even when named `isValid*` (rejecting `__proto__` must not kind-blind kill
 * command-injection). Compound validator args and post-check member writes
 * also under-kill.
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
  /**
   * When the validator argument is a member-read (`req.body`), the property
   * that was checked. Absent for plain bindings (`hostname`). Matching a sink
   * requires the same property (or both absent) so validating `req.body`
   * cannot suppress `exec(req.query)`.
   */
  readonly subjectProperty?: string;
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

export interface BarrierGuardOptions {
  /**
   * Same-file affirming `__proto__` reject helpers (from
   * {@link discoverProtoGuardCallees}). Excluded from CDG barriers even when
   * the name matches `isValid*` — rejecting `__proto__` must not kind-blind
   * kill command-injection.
   */
  readonly excludeBarrierCallees?: ReadonlySet<string>;
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
 * Under-kill: affirming `return … !== "__proto__"`, or
 * `if (key === "__proto__") return false` where `return false` is
 * control-dependent on the equality's true branch (not merely co-present).
 */
export function functionContainsProtoGuard(cfg: FunctionCfg): boolean {
  for (const block of cfg.blocks) {
    if (isAffirmingProtoRejectReturn(block.text)) return true;
  }
  const equalityControllers = cfg.blocks.filter((b) => hasProtoEquality(b.text));
  if (equalityControllers.length === 0) return false;
  const cdg = computeControlDependence(cfg).edges;
  for (const controller of equalityControllers) {
    for (const dep of cfg.blocks) {
      if (!/\breturn\s+false\b/.test(dep.text)) continue;
      const onTrue = cdg.some(
        (e) =>
          e.controllerBlock === controller.index &&
          e.dependentBlock === dep.index &&
          e.label === 'T',
      );
      if (onTrue) return true;
    }
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

/** Optional `qual.qual.` prefix before a callee leaf. */
const QUALIFIED_PREFIX = '(?:[A-Za-z_$][\\w$]*\\.)*';

/**
 * True when the condition is ONLY the validator call (optional parens / !,
 * optional `qual.` chain). Rejects compounds like `isValid(x) || debugMode`
 * that can take the true branch without the validator accepting.
 */
/** True when the call argument is a bare ident or member path (not `a+b`). */
function isSimpleValidatorArg(arg: string): boolean {
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(arg);
}

export function isSimpleValidatorCondition(blockText: string, callee: string): boolean {
  const leaf = calleeLeaf(callee);
  if (!leaf || !blockText.includes(leaf)) return false;
  if (blockText.includes('||') || blockText.includes('&&') || blockText.includes('??'))
    return false;
  let s = blockText.replace(/\s+/g, '');
  while (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1);
  const escaped = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // [!][qual.]*leaf(simpleArg) — supports `!validators.isValidHostName(x)`.
  const m = s.match(new RegExp(`^!*${QUALIFIED_PREFIX}${escaped}\\(([^)]*)\\)$`));
  if (!m) return false;
  return isSimpleValidatorArg(m[1]);
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

function isFilterCallee(callee: string | undefined): boolean {
  if (!callee) return false;
  return callee === 'filter' || callee.endsWith('.filter');
}

/** Subject(s) of validator arg 0: prefer member-read property when present. */
function primaryArgSubjects(
  sites: readonly SiteRecord[],
  callSiteIndex: number,
  callSite: SiteRecord,
): readonly { binding: number; property?: string }[] {
  const memberSubjects: { binding: number; property?: string }[] = [];
  for (const s of sites) {
    if (s.kind !== 'member-read' || s.object === undefined) continue;
    if (s.parent?.[0] !== callSiteIndex || s.parent?.[1] !== 0) continue;
    memberSubjects.push({ binding: s.object, property: s.property });
  }
  // Compound args do not vouch for any operand individually.
  if (memberSubjects.length > 1) return [];
  // Count occurrences (not unique names) so `isValid(command + command)`
  // is not mistaken for a plain single-binding validator.
  const plainOccs = argPositionBindings(callSite, 0);
  if (memberSubjects.length === 1) {
    // `isValid(req.body + suffix)` lists object + other bindings in arg 0.
    if (plainOccs.length > 1) return [];
    return memberSubjects;
  }
  // Plain bindings: require exactly one occurrence (`isValid(x)`).
  if (plainOccs.length !== 1) return [];
  return [{ binding: plainOccs[0] }];
}

/**
 * Distinct member-read properties feeding call `siteIndex` arg `argPos`.
 * Empty when the arg is a plain binding. Multiple properties (e.g.
 * `exec(p.body + p.query)`) means barrier suppression must under-kill —
 * a single validated property must not clear the whole argument.
 */
export function memberPropertiesAtArg(
  sites: readonly SiteRecord[],
  siteIndex: number,
  argPos: number,
): readonly string[] {
  const props = new Set<string>();
  for (const s of sites) {
    if (s.kind !== 'member-read' || s.property === undefined) continue;
    if (s.parent?.[0] === siteIndex && s.parent?.[1] === argPos) props.add(s.property);
  }
  return [...props];
}

/** Collect validating-predicate controllers from CFG call sites. */
export function collectBarrierControllers(
  cfg: FunctionCfg,
  excludeBarrierCallees: ReadonlySet<string> = new Set(),
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
        // Name-heuristic validators only. Proto-reject helpers are excluded
        // only for *bare* same-file calls (`isValidKey`), not qualified
        // `obj.isValidKey` / `validators.isValidKey` (avoid cross-object FPs).
        if (!isBarrierCalleeName(site.callee)) continue;
        if (!site.callee.includes('.') && excludeBarrierCallees.has(site.callee)) continue;
        // Skip `.filter(…)` — not a CDG validator call (and not a kind-safe kill).
        if (isFilterCallee(site.callee)) continue;
        const subjects = primaryArgSubjects(sites, siteIndex, site);
        if (subjects.length === 0) continue;
        const validatedLabel = validatedLabelForCondition(block.text, site.callee);
        if (validatedLabel === undefined) continue; // compound / non-simple condition
        for (const subject of subjects) {
          out.push({
            controllerBlock: block.index,
            subjectBinding: subject.binding,
            ...(subject.property !== undefined ? { subjectProperty: subject.property } : {}),
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

/** Build a per-function barrier index (CDG + name-heuristic controllers). */
export function buildBarrierGuardIndex(
  cfg: FunctionCfg,
  options?: BarrierGuardOptions,
): BarrierGuardIndex {
  const controllers = collectBarrierControllers(cfg, options?.excludeBarrierCallees ?? new Set());
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
  return { bySubject, cdg };
}

/** True when statement `stmt` defines binding `b`. */
function statementDefines(
  stmt: { defs: readonly number[]; mayDefs?: readonly number[] },
  b: number,
): boolean {
  if (stmt.defs.includes(b)) return true;
  return stmt.mayDefs?.includes(b) === true;
}

/**
 * True when the subject object binding is redefined on the validated branch
 * before the sink (`req = other` after validating `req.body`).
 */
export function subjectBindingAssignedOnValidatedPath(
  cfg: FunctionCfg,
  index: BarrierGuardIndex,
  controller: BarrierController,
  sinkPoint: ProgramPoint,
): boolean {
  const b = controller.subjectBinding;
  for (const edge of index.cdg) {
    if (edge.controllerBlock !== controller.controllerBlock) continue;
    if (edge.label !== controller.validatedLabel) continue;
    const block = cfg.blocks[edge.dependentBlock];
    const stmts = block?.statements;
    if (!stmts) continue;
    if (block.index === sinkPoint.blockIndex) {
      for (let i = 0; i < sinkPoint.stmtIndex && i < stmts.length; i++) {
        if (statementDefines(stmts[i], b)) return true;
      }
      continue;
    }
    if (block.endLine < sinkPoint.line) {
      for (const stmt of stmts) {
        if (statementDefines(stmt, b)) return true;
      }
    }
  }
  return false;
}

/**
 * Index of the *sink* call in `block.text` (not merely the first call).
 * Prefers `call.at` when present; otherwise the nth same-callee occurrence
 * matching `sinkSiteIndex` among this statement's call sites.
 */
function sinkCallTextIndex(
  block: FunctionCfg['blocks'][number],
  sinkPoint: ProgramPoint,
  sinkSiteIndex: number,
): number {
  const stmt = block.statements?.[sinkPoint.stmtIndex];
  const sites = stmt?.sites ?? [];
  const call = sites[sinkSiteIndex];
  if (!call || call.kind !== 'call' || !call.callee) return -1;

  // Harvester `at` is the call-expression start — most precise when present.
  if (call.at) {
    const [line, col] = call.at;
    const lines = block.text.split('\n');
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineNo = block.startLine + i;
      if (lineNo === line) return offset + Math.min(col, lines[i].length);
      offset += lines[i].length + 1;
    }
  }

  const leaf = call.callee.includes('.')
    ? (call.callee.split('.').pop() ?? call.callee)
    : call.callee;
  const escaped = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\s*\\(`, 'g');
  // How many same-leaf calls appear at or before this site in the statement?
  let ordinal = 0;
  for (let i = 0; i < sinkSiteIndex; i++) {
    const prev = sites[i];
    if (prev?.kind !== 'call' || !prev.callee) continue;
    const prevLeaf = prev.callee.includes('.')
      ? (prev.callee.split('.').pop() ?? prev.callee)
      : prev.callee;
    if (prevLeaf === leaf) ordinal++;
  }
  let match: RegExpExecArray | null;
  let seen = 0;
  while ((match = re.exec(block.text)) !== null) {
    if (seen === ordinal) return match.index;
    seen++;
  }
  return -1;
}

/**
 * True when a validated member property is assigned on the controller's
 * validated branch *before* the sink (`req.body = …` then `exec(req.body)`).
 * Matches the *receiver binding* plus property (`req.body =`), not a bare
 * `.body =` on a different object. In the sink block, compares assign vs
 * *this* sink-call position in `block.text` (not the first call).
 */
export function memberPropertyAssignedOnValidatedPath(
  cfg: FunctionCfg,
  index: BarrierGuardIndex,
  controller: BarrierController,
  sinkPoint: ProgramPoint,
  sinkSiteIndex: number,
): boolean {
  const prop = controller.subjectProperty;
  if (!prop) return false;
  const receiver = cfg.bindings?.[controller.subjectBinding]?.name;
  if (!receiver) return false;
  const escapedProp = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedRecv = receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Require the validated object name — `other.body =` must not invalidate
  // a barrier over `req.body`.
  const assignRe = new RegExp(
    `\\b${escapedRecv}\\s*(\\.${escapedProp}|\\[['"]${escapedProp}['"]\\])\\s*=`,
  );
  for (const edge of index.cdg) {
    if (edge.controllerBlock !== controller.controllerBlock) continue;
    if (edge.label !== controller.validatedLabel) continue;
    const block = cfg.blocks[edge.dependentBlock];
    if (!block?.text) continue;
    if (block.index === sinkPoint.blockIndex) {
      const assignIdx = block.text.search(assignRe);
      if (assignIdx < 0) continue;
      const sinkIdx = sinkCallTextIndex(block, sinkPoint, sinkSiteIndex);
      // Assign before sink call in source text (same-line / multiline safe).
      if (sinkIdx < 0 || assignIdx < sinkIdx) return true;
      continue;
    }
    if (block.endLine < sinkPoint.line) {
      if (assignRe.test(block.text)) return true;
    }
  }
  return false;
}

/**
 * True when `sinkBlock` is control-dependent on a validating predicate over
 * `bindingIdx` on the validated branch sense.
 *
 * `sinkProperty` must match the controller's `subjectProperty` (both absent
 * for plain bindings) so validating `req.body` cannot suppress `req.query`.
 *
 * When `taintDefPoint` is provided, refuse the barrier if that def was itself
 * assigned on the validated branch (value reassigned after the check).
 */
export function isBarrierGuarded(
  index: BarrierGuardIndex,
  bindingIdx: number,
  sinkBlock: number,
  taintDefPoint?: ProgramPoint,
  sinkProperty?: string,
): BarrierController | undefined {
  const controllers = index.bySubject.get(bindingIdx);
  if (!controllers || controllers.length === 0) return undefined;
  for (const edge of index.cdg) {
    if (edge.dependentBlock !== sinkBlock) continue;
    for (const c of controllers) {
      if (c.controllerBlock !== edge.controllerBlock) continue;
      if (c.validatedLabel !== edge.label) continue;
      if ((c.subjectProperty ?? undefined) !== (sinkProperty ?? undefined)) continue;
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
