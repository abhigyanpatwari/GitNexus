import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import {
  deriveSpringBeanMetadata,
  type SpringBeanMetadata,
} from '../../core/ingestion/frameworks/spring/bean-catalog.js';
import {
  decodeSpringBeanFactoryReason,
  type SpringBeanFactoryMetadata,
} from '../../core/ingestion/frameworks/spring/bean-factories.js';

export async function queryClassBeanMetadata(
  lbugPath: string,
  symbolId: string,
  symbolType: string,
): Promise<SpringBeanMetadata | SpringBeanFactoryMetadata | undefined> {
  if (symbolType !== 'Class' && symbolType !== 'Method' && symbolType !== 'CodeElement') {
    return undefined;
  }

  try {
    if (symbolType !== 'Class') {
      const pattern =
        symbolType === 'Method'
          ? 'MATCH (m:Method {id: $symbolId})-[r:CodeRelation]->(b:CodeElement)'
          : 'MATCH (m:Method)-[r:CodeRelation]->(b:CodeElement {id: $symbolId})';
      const rows = await executeParameterized(
        lbugPath,
        `${pattern}
         WHERE r.type = 'DECLARES'
           AND r.reason STARTS WITH 'spring-bean-factory:'
         RETURN r.reason AS reason
         LIMIT 1`,
        { symbolId },
      );
      const row = rows[0];
      return row === undefined ? undefined : decodeSpringBeanFactoryReason(row.reason ?? row[0]);
    }

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
