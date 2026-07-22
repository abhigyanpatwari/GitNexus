import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import {
  deriveSpringBeanMetadata,
  type SpringBeanMetadata,
} from '../../core/ingestion/frameworks/spring/bean-catalog.js';

export async function queryClassBeanMetadata(
  lbugPath: string,
  symbolId: string,
  symbolType: string,
): Promise<SpringBeanMetadata | undefined> {
  if (symbolType !== 'Class') return undefined;

  try {
    const rows = await executeParameterized(
      lbugPath,
      `
      MATCH (c:Class {id: $symbolId})
      RETURN c.frameworkAnnotations AS frameworkAnnotations
      LIMIT 1
    `,
      { symbolId },
    );
    const row = rows[0];
    if (!row) return undefined;

    const value = row.frameworkAnnotations ?? row[0];
    if (!Array.isArray(value)) return undefined;

    return deriveSpringBeanMetadata(
      value.filter((annotation): annotation is string => typeof annotation === 'string'),
    );
  } catch {
    // Older or partially upgraded indexes may not have the column. This
    // enrichment is additive, so context and impact must still succeed.
    return undefined;
  }
}
