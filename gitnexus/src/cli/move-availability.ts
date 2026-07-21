/** Warn once if a repo has Move sources but no usable move-flow binary is reachable. */

import { tryCreateMoveFlowClient } from '../core/move/mcp-client.js';
import { cliWarn } from './cli-message.js';

export function warnIfMoveUnavailable(opts: { repoHasMove: boolean; context?: string }): void {
  if (!opts.repoHasMove) return;
  if (tryCreateMoveFlowClient()) return;
  const ctx = opts.context ? ` [${opts.context}]` : '';
  cliWarn(
    `GitNexus${ctx}: move-flow is unavailable — .move files will not be indexed. Reinstall without GITNEXUS_SKIP_MOVE_FLOW=1, or set MOVE_FLOW to a move-flow binary from aptos-labs/aptos-ai.`,
    { binary: 'move-flow', context: opts.context },
  );
}
