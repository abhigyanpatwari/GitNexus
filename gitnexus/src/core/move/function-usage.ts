import type { CallGraphMap, MoveFactsMap } from './compiler-facts.js';
import { mapWithConcurrency } from './concurrency.js';
import type { MoveFlowClient } from './mcp-client.js';
import { moveShortSymbol } from './symbol-id.js';

export interface FunctionUsageFailure {
  functionQualified: string;
  message: string;
}

export interface ClosureCaptureResult {
  calls: CallGraphMap;
  failures: FunctionUsageFailure[];
}

/**
 * Recover compiler-known calls through function values. `used` contains direct
 * calls and closure captures; subtracting `called` leaves the missing callable
 * edges. `call_graph` callees are subtracted too: the two queries may classify
 * the same edge differently (invoked AND passed as a value), and an edge the
 * package call graph already carries must not be emitted a second time under
 * the closure-use reason. Failures are supplemental diagnostics and do not
 * discard facts or the ordinary call graph. The first failure stops the
 * supplemental scan so a broken or slow query cannot multiply the package
 * timeout by every function.
 */
export async function collectClosureCaptureCalls(
  client: MoveFlowClient,
  packageRoot: string,
  facts: MoveFactsMap,
  callGraph: CallGraphMap,
  limit: number,
): Promise<ClosureCaptureResult> {
  const candidates: string[] = [];
  for (const [moduleQualified, moduleFacts] of Object.entries(facts)) {
    for (const fn of moduleFacts.functions ?? []) {
      if (fn.isLambdaLifted || fn.isNative) continue;
      candidates.push(`${moduleQualified}::${fn.name}`);
    }
  }

  const calls: CallGraphMap = {};
  const { failure } = await mapWithConcurrency(
    candidates,
    limit,
    async (functionQualified) => {
      const usage = await client.functionUsage(packageRoot, moveShortSymbol(functionQualified));
      const known = new Set([...usage.called, ...(callGraph[functionQualified] ?? [])]);
      const captured = usage.used.filter((t) => !known.has(t));
      if (captured.length > 0) calls[functionQualified] = [...new Set(captured)];
    },
    { failFast: true },
  );

  const failures: FunctionUsageFailure[] = failure
    ? [
        {
          functionQualified: String(failure.item),
          message: failure.error instanceof Error ? failure.error.message : String(failure.error),
        },
      ]
    : [];

  return { calls, failures };
}
