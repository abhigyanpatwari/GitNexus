/**
 * Default symbol resolver for cross-repo trace.
 *
 * This module contains framework-aware logic (RPC / MQ consumer /
 * service-naming conventions) that would otherwise be hard-coded inside
 * trace.ts.  trace.ts itself remains framework-agnostic: it calls the
 * SymbolResolver interface and knows nothing about concrete framework patterns.
 *
 * DefaultSymbolResolver is a reference implementation. To support a different
 * RPC framework or naming convention, implement SymbolResolver and pass it to
 * runGroupTraceWithResolver — no changes to the BFS engine needed.
 */

import { executeParameterized } from '../lbug/pool-adapter.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SymbolCandidate = { id: string; name: string; type: string; filePath: string };
export type ResolvedSymbol = { id: string; name: string; type: string; filePath: string };

/**
 * Context passed to resolveSymbolByName.
 * Carries hints extracted from contracts.json so the resolver can skip
 * heuristic scoring when precise data is available.
 */
export interface ResolveContext {
  /** contracts.json symbolRef.filePath for the target endpoint (may be client-side) */
  hintFilePath?: string;
  /** true when the hop originates from a topic/MQ crossLink */
  isTopic?: boolean;
}

/**
 * Pluggable symbol-resolution strategy.
 *
 * All methods are optional.  When a method is absent the BFS engine falls back
 * to a minimal built-in behaviour described in each comment.
 */
export interface SymbolResolver {
  /**
   * Return true when symbolName is a synthetic, non-Java identifier that will
   * never exist in LadybugDB (e.g. "mqConsumer(some-topic)", "scheduler.task.foo").
   * Fallback: always return false (attempt resolution for every name).
   */
  isUnresolvableSymbolName?: (symbolName: string) => boolean;

  /**
   * Score a candidate symbol node for BFS entry quality.
   * Higher score = better entry point.
   * Fallback: all candidates score 0 (first candidate in DB order is used).
   */
  scoreCandidate?: (
    candidate: SymbolCandidate,
    classVariants?: string[],
    targetName?: string,
  ) => number;

  /**
   * Resolve a cross-repo hop symbolName to a concrete lbug Method node.
   * Called by processOneSegment for each non-entry hop.
   *
   * Return null to skip this segment (treated as unresolvable).
   * Fallback: exact n.name match with LIMIT 1.
   */
  resolveSymbolByName?: (
    repoId: string,
    symbolName: string,
    context: ResolveContext,
  ) => Promise<ResolvedSymbol | null>;

  /**
   * Given a class/interface node, return the best Method node in the same file
   * for BFS seeding.  Called from resolveEntrySymbols when a candidate is a
   * non-Method node.
   * Fallback: return the node unchanged.
   */
  drillDownToMethod?: (
    repoId: string,
    node: SymbolCandidate,
    preferredMethodName?: string,
  ) => Promise<ResolvedSymbol>;
}

// ---------------------------------------------------------------------------
// DefaultSymbolResolver — generic reference implementation
// ---------------------------------------------------------------------------

/**
 * Generic symbol resolver with no framework-specific knowledge.
 *
 * Covers the common case: symbol names follow `ClassName.methodName` or
 * plain `methodName` conventions, and implementation classes live in
 * `-service/` or `-impl/` modules.
 *
 * For framework-specific resolution (e.g. custom RPC frameworks, MQ
 * consumers, proprietary service-naming conventions), extend this class
 * and override the methods you need, then pass your resolver to
 * `runGroupTraceWithResolver`.
 */
export class DefaultSymbolResolver implements SymbolResolver {
  // ---- scoreCandidate ----

  scoreCandidate(c: SymbolCandidate, classVariants?: string[], target?: string): number {
    let s = 0;
    const idAndPath = `${c.id}|${c.filePath}`;

    if (classVariants) {
      for (const variant of classVariants) {
        if (idAndPath.includes(variant)) {
          s += 100;
          break;
        }
      }
    }

    // Method nodes preferred over Class/Interface
    const nodeType = c.type || (c.id.indexOf(':') > 0 ? c.id.slice(0, c.id.indexOf(':')) : '');
    if (nodeType === 'Method') s += 10;

    if (c.filePath && (c.filePath.includes('-server/') || c.filePath.includes('-service/')))
      s += 50;
    if (c.filePath && (c.filePath.toLowerCase().includes('impl') || c.filePath.includes('-impl/')))
      s += 20;

    if (/gateway|delegate|adapter|proxy|wrapper/i.test(c.id)) s -= 15;

    // Semantic relevance via PascalCase target name
    if (target && target.length > 0) {
      const pascalTarget = target[0].toUpperCase() + target.slice(1);
      if (idAndPath.includes(pascalTarget)) s += 40;
    }

    if (c.filePath && (c.filePath.includes('-client/') || c.filePath.includes('-client-'))) s -= 60;

    // Utility / DTO penalty
    const combined = `${c.id.toLowerCase()}|${(c.filePath || '').toLowerCase()}`;
    if (
      /utils?[./|]/.test(combined) ||
      /enum[./|]/.test(combined) ||
      /validate[./|]/.test(combined) ||
      /convert[./|]/.test(combined) ||
      /dto[./|]/.test(combined) ||
      /entity[./|]/.test(combined) ||
      /\.set[A-Z]/.test(c.id) ||
      /\.get[A-Z]/.test(c.id) ||
      /\.is[A-Z]/.test(c.id)
    )
      s -= 80;

    // Test file penalty
    const lower = (c.filePath || '').toLowerCase();
    if (
      lower.includes('/test/') ||
      lower.includes('/tests/') ||
      lower.includes('/__tests__/') ||
      lower.includes('.test.') ||
      lower.includes('.spec.') ||
      lower.includes('_test.')
    )
      s -= 50;

    return s;
  }

  // ---- drillDownToMethod ----

  async drillDownToMethod(
    repoId: string,
    node: SymbolCandidate,
    preferredMethodName?: string,
  ): Promise<ResolvedSymbol> {
    if (node.id.startsWith('Method:')) return node;
    if (!node.filePath) return node;

    const methods = await executeParameterized(
      repoId,
      `MATCH (m:Method) WHERE m.filePath = $fp
       RETURN m.id AS id, m.name AS name, labels(m)[0] AS type, m.filePath AS filePath`,
      { fp: node.filePath },
    );
    if (methods.length === 0) return node;

    let bestMethod: Record<string, unknown> | null = null;
    let bestScore = -Infinity;

    for (const m of methods) {
      const mName = (m.name ?? m[1]) as string;
      const mId = (m.id ?? m[0]) as string;
      let score = 0;
      if (preferredMethodName && mName === preferredMethodName) score += 200;
      if (mId.includes('Impl') || mId.includes('Server')) score += 20;
      if (/^(get|set|is|toString|hashCode|equals)/.test(mName)) score -= 50;
      if (mName === '<init>' || mName === '<clinit>') score -= 100;
      if (score > bestScore) {
        bestScore = score;
        bestMethod = m;
      }
    }
    if (!bestMethod) bestMethod = methods[0];

    const result: ResolvedSymbol = {
      id: (bestMethod.id ?? bestMethod[0]) as string,
      name: (bestMethod.name ?? bestMethod[1]) as string,
      type: (bestMethod.type ?? bestMethod[2]) as string,
      filePath: (bestMethod.filePath ?? bestMethod[3]) as string,
    };
    logger.info(
      `[trace] drillDownToMethod: "${node.id}" → "${result.id}" (${methods.length} methods in file)`,
    );
    return result;
  }

  // ---- resolveSymbolByName ----

  /**
   * Returns true when a file path belongs to a client/IDL module that should
   * not be used as a BFS seed. Override in subclasses to add framework-specific
   * dead-end patterns (e.g. generated client stubs, IDL output directories).
   */
  protected isClientPath(fp: string): boolean {
    if (!fp) return false;
    const f = fp.toLowerCase();
    return (
      f.includes('-client/') ||
      f.includes('-client-') ||
      f.includes('_client/') ||
      f.includes('/idl/') ||
      f.endsWith('.thrift') ||
      /-api\//.test(f) ||
      /[_-]client\d/.test(f)
    );
  }

  async resolveSymbolByName(
    repoId: string,
    symbolName: string,
    context: ResolveContext,
  ): Promise<ResolvedSymbol | null> {
    const { hintFilePath } = context;
    const isClientPath = (fp: string) => this.isClientPath(fp);

    // Exact full-name match
    const rows = await executeParameterized(
      repoId,
      `MATCH (n) WHERE n.name = $name
       RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
       LIMIT 1`,
      { name: symbolName },
    );
    if (rows.length > 0) {
      const r = rows[0];
      const matched: SymbolCandidate = {
        id: (r.id ?? r[0]) as string,
        name: (r.name ?? r[1]) as string,
        type: (r.type ?? r[2]) as string,
        filePath: (r.filePath ?? r[3]) as string,
      };
      if (matched.id.startsWith('Method:')) return matched;
      return this.drillDownToMethod(repoId, matched, symbolName);
    }

    const lastDot = symbolName.lastIndexOf('.');
    if (lastDot < 0) return null;

    const classPrefix = symbolName.slice(0, lastDot);
    const shortName = symbolName.slice(lastDot + 1);

    const rows2 = await executeParameterized(
      repoId,
      `MATCH (n) WHERE n.name = $name
       RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath`,
      { name: shortName },
    );
    if (rows2.length === 0) return null;

    const candidates: SymbolCandidate[] = rows2.map((r: Record<string, unknown>) => ({
      id: (r.id ?? r[0]) as string,
      name: (r.name ?? r[1]) as string,
      type: (r.type ?? r[2]) as string,
      filePath: (r.filePath ?? r[3]) as string,
    }));

    // Fast path: hintFilePath pins the exact implementation file
    if (hintFilePath && !isClientPath(hintFilePath)) {
      const pinned = candidates.find((c) => c.filePath === hintFilePath);
      if (pinned) {
        logger.info(`[trace] resolveSymbolByName "${symbolName}": pinned via hintFilePath`);
        return this.drillDownToMethod(repoId, pinned, shortName);
      }
    }

    // Build class-name variants: Service ↔ Server ↔ Impl
    const classVariants = [classPrefix];
    if (classPrefix.endsWith('Service')) {
      classVariants.push(
        classPrefix.replace(/Service$/, 'Server'),
        classPrefix.replace(/Service$/, 'Impl'),
        classPrefix.replace(/Service$/, ''),
      );
    } else if (classPrefix.endsWith('Server')) {
      classVariants.push(
        classPrefix.replace(/Server$/, 'Service'),
        classPrefix.replace(/Server$/, 'Impl'),
        classPrefix.replace(/Server$/, ''),
      );
    } else if (classPrefix.endsWith('Impl')) {
      classVariants.push(
        classPrefix.replace(/Impl$/, 'Service'),
        classPrefix.replace(/Impl$/, 'Server'),
        classPrefix.replace(/Impl$/, ''),
      );
    }

    candidates.sort(
      (a, b) => this.scoreCandidate(b, classVariants) - this.scoreCandidate(a, classVariants),
    );

    const best = candidates[0];
    if (candidates.length > 1) {
      logger.info(
        `[trace] resolveSymbolByName "${symbolName}": ${candidates.length} candidates, ` +
          `selected "${best.id}" (score=${this.scoreCandidate(best, classVariants)})`,
      );
    }

    return this.drillDownToMethod(repoId, best, shortName);
  }
}
