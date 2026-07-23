import type { CallGraphMap, MoveFactsMap } from './compiler-facts.js';
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
): Promise<ClosureCaptureResult> {
  const calls: CallGraphMap = {};
  const failures: FunctionUsageFailure[] = [];

  for (const [moduleQualified, moduleFacts] of Object.entries(facts)) {
    for (const fn of moduleFacts.functions ?? []) {
      if (fn.isLambdaLifted) continue;
      const functionQualified = `${moduleQualified}::${fn.name}`;
      try {
        const usage = await client.functionUsage(packageRoot, moveShortSymbol(functionQualified));
        const known = new Set([...usage.called, ...(callGraph[functionQualified] ?? [])]);
        const captured = usage.used.filter((target) => !known.has(target));
        if (captured.length > 0) calls[functionQualified] = [...new Set(captured)];
      } catch (error) {
        failures.push({
          functionQualified,
          message: error instanceof Error ? error.message : String(error),
        });
        return { calls, failures };
      }
    }
  }

  return { calls, failures };
}
