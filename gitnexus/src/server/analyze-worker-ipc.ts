/**
 * JSON-safe projection of `AnalyzeResult` for the analyze-worker → parent IPC
 * boundary (#2112 boundary audit; #2135).
 *
 * The forked analyze worker (`analyze-worker.ts`) reports completion to the
 * parent over `child_process` IPC, which uses Node's DEFAULT `'json'`
 * serialization — `api.ts` forks the worker with no `serialization:` option, so
 * the channel runs `JSON.stringify`/`JSON.parse`, NOT V8 structured clone.
 *
 * `AnalyzeResult.pipelineResult` is populated on every successful analysis
 * (`run-analyze.ts`) and carries `pipelineResult.graph` — the live
 * `KnowledgeGraph` closure object. Sending the raw result across this channel is
 * wrong three ways:
 *   1. Waste — the graph's `nodes`/`relationships` getters force-materialize the
 *      ENTIRE graph into two arrays, then JSON-stringify them, on every analyze.
 *      On a large repo (the #2112 scenario) that is a multi-hundred-MB
 *      stringify+parse whose result is immediately discarded.
 *   2. Silent corruption — the graph's methods are own function properties;
 *      `JSON.stringify` drops them with no error, so a `pipelineResult.graph`
 *      that survived the wire is a data-only husk whose `forEachNode(...)` throws
 *      "is not a function" far from the cause.
 *   3. Conditional crash — a BigInt or circular reference anywhere in the
 *      payload makes `process.send` throw `TypeError` synchronously; the throw is
 *      caught in the worker and re-sent as `{type:'error'}`, turning a
 *      SUCCESSFUL analysis (DB already written) into a reported FAILURE. This is
 *      the #2112 failure family on the server path, and — unlike the parse-worker
 *      result boundary — it has no clone-safety net.
 *
 * The parent (`api.ts`) reads only `result.repoName`; `pipelineResult`'s real
 * consumers (CLI skill generation) call `runFullAnalysis` in-process and never
 * cross this fork. So the worker sends an explicit allowlist of the scalar
 * fields, JSON-safe by construction.
 */
import type { AnalyzeResult } from '../core/run-analyze.js';

/**
 * The JSON-safe subset of `AnalyzeResult` that crosses the analyze-worker IPC
 * boundary. Typed as `Omit<…, 'pipelineResult'>` so that if a future,
 * non-serializable field is added to `AnalyzeResult`, `projectAnalyzeResultForIpc`
 * fails to compile until that field is deliberately handled here.
 */
export type AnalyzeResultIpc = Omit<AnalyzeResult, 'pipelineResult'>;

/**
 * Project an `AnalyzeResult` down to the JSON-safe scalar fields the parent
 * consumes, dropping `pipelineResult` (the live `KnowledgeGraph`).
 *
 * Deliberately an explicit allowlist rather than a `{ pipelineResult, ...rest }`
 * denylist: a future non-scalar field added to `AnalyzeResult` must be added
 * here on purpose, so this boundary can never silently start carrying a new
 * non-serializable value.
 */
export function projectAnalyzeResultForIpc(result: AnalyzeResult): AnalyzeResultIpc {
  return {
    repoName: result.repoName,
    repoPath: result.repoPath,
    stats: result.stats,
    alreadyUpToDate: result.alreadyUpToDate,
    ftsRepairedOnly: result.ftsRepairedOnly,
    ftsSkipped: result.ftsSkipped,
  };
}
