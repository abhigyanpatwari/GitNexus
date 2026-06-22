/**
 * Taint-site safety validation (#2083 M3 U1, plan KTD2).
 *
 * Mirrors `hasEmitSafeFacts` (cfg/emit.ts): an untrusted `cfgSideChannel`
 * element — possibly from a corrupted durable parsedfile store — must never
 * crash the taint pass or fabricate matches from out-of-range indices. The
 * degradation contract is per-FUNCTION and one-directional: a CFG whose sites
 * fail this check is SKIPPED FOR TAINT ONLY — the BasicBlock/CFG layer and
 * the REACHING_DEF projection (guarded by their own checks) are unaffected.
 *
 * Checked: exactly the indices the taint matcher dereferences — binding
 * indices (`receiver`/`object`/`resultDefs`/arg occurrences) against the
 * function's binding table, and intra-statement site references (`parent`
 * site / via-tags) against the OWNING statement's `sites` array. Site
 * references are statement-local by construction (each statement's
 * FactAccumulator starts at index 0); a cross-statement reference is
 * corruption, not a feature.
 *
 * Lives in `taint/` (not cfg/emit.ts): U4's taint emit path is the only
 * consumer, and the guard must evolve with the matcher that dereferences
 * these fields.
 */
import type { FunctionCfg, SiteRecord } from '../cfg/types.js';

const SITE_KINDS = new Set<SiteRecord['kind']>(['call', 'new', 'member-read']);

/**
 * Whether a structurally-valid CFG's M3 `sites` annotations are safe to feed
 * to the taint matcher/propagator. `true` when no statement carries sites
 * (pre-M3 channel, or no calls) — absence is the well-formed empty case.
 */
export const hasTaintSafeSites = (cfg: FunctionCfg): boolean => {
  // Sites carry binding indices — a channel with sites but no binding table
  // has nothing to range-check them against: reject (checked per statement).
  const bindingCount = Array.isArray(cfg.bindings) ? cfg.bindings.length : -1;
  for (const block of cfg.blocks) {
    const stmts = block.statements;
    if (stmts === undefined) continue;
    if (!Array.isArray(stmts)) return false;
    for (const s of stmts) {
      if (s?.sites === undefined) continue;
      if (bindingCount < 0) return false;
      if (!isSafeSiteList(s.sites, bindingCount)) return false;
    }
  }
  return true;
};

const isSafeSiteList = (sites: unknown, bindingCount: number): boolean => {
  if (!Array.isArray(sites)) return false;
  const siteCount = sites.length;
  const bindingInRange = (i: unknown): boolean =>
    Number.isInteger(i) && (i as number) >= 0 && (i as number) < bindingCount;
  const siteInRange = (i: unknown): boolean =>
    Number.isInteger(i) && (i as number) >= 0 && (i as number) < siteCount;

  for (const site of sites as ReadonlyArray<Partial<SiteRecord> | null | undefined>) {
    if (site === null || typeof site !== 'object') return false;
    if (typeof site.kind !== 'string' || !SITE_KINDS.has(site.kind)) return false;
    if (site.callee !== undefined && typeof site.callee !== 'string') return false;
    if (site.receiver !== undefined && !bindingInRange(site.receiver)) return false;
    if (site.requireArg !== undefined && typeof site.requireArg !== 'string') return false;
    if (site.template !== undefined && typeof site.template !== 'boolean') return false;
    if (
      site.spread !== undefined &&
      (!Number.isInteger(site.spread) || (site.spread as number) < 0)
    ) {
      return false;
    }
    if (site.parent !== undefined) {
      const p = site.parent;
      if (!Array.isArray(p) || p.length !== 2) return false;
      if (!siteInRange(p[0])) return false;
      if (!Number.isInteger(p[1]) || (p[1] as number) < 0) return false;
    }
    if (site.resultDefs !== undefined) {
      if (!Array.isArray(site.resultDefs) || !site.resultDefs.every(bindingInRange)) return false;
    }
    if (site.args !== undefined) {
      if (!Array.isArray(site.args)) return false;
      for (const position of site.args) {
        if (!Array.isArray(position)) return false;
        for (const entry of position) {
          if (typeof entry === 'number') {
            if (!bindingInRange(entry)) return false;
          } else if (Array.isArray(entry) && entry.length === 2) {
            if (!bindingInRange(entry[0]) || !siteInRange(entry[1])) return false;
          } else {
            return false;
          }
        }
      }
    }
    if (site.kind === 'member-read') {
      // The matcher dereferences both unconditionally on member reads.
      if (!bindingInRange(site.object) || typeof site.property !== 'string') return false;
    } else {
      if (site.object !== undefined && !bindingInRange(site.object)) return false;
      if (site.property !== undefined && typeof site.property !== 'string') return false;
    }
  }
  return true;
};
