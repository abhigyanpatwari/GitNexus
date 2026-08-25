import { executeParameterized } from '../../core/lbug/pool-adapter.js';

export interface ConvexDispatchMetadata {
  readonly factory?: string;
  readonly boundary: string;
  readonly staleIndex?: true;
}

function isMissingConvexMetadataProperty(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /cannot find property\s+convexEndpointFactory|property[^\n]*convexEndpointFactory[^\n]*not (?:defined|found)/i.test(
    message,
  );
}

export async function queryConvexDispatchMetadata(
  lbugPath: string,
  symbolId: string,
  symbolName: string,
  symbolType: string,
  runQuery: typeof executeParameterized = executeParameterized,
): Promise<ConvexDispatchMetadata | undefined> {
  if (symbolType !== 'Const') return undefined;

  try {
    const rows = await runQuery(
      lbugPath,
      `MATCH (n:Const {id: $symbolId})
       RETURN n.convexEndpointFactory AS factory
       LIMIT 1`,
      { symbolId },
    );
    const row = rows[0];
    if (row === undefined) return undefined;

    const factory = String(row.factory ?? row[0] ?? '');
    if (factory.length === 0) return undefined;

    return {
      factory,
      boundary:
        `${symbolName} is exported through Convex ${factory}({...}) and can be addressed through ` +
        `the anyApi runtime proxy; callers across that dynamic-dispatch boundary leave no static ` +
        `edge, so actual impact may be higher.`,
    };
  } catch (error) {
    if (isMissingConvexMetadataProperty(error)) {
      return {
        staleIndex: true,
        boundary:
          'Convex runtime-proxy metadata is unavailable because this index predates ' +
          'convexEndpointFactory; re-index before treating impact as exact.',
      };
    }
    // Additive evidence only. Transient failures must not abort impact.
    return undefined;
  }
}
