import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

describe('queryFTS parameterization wiring', () => {
  it('binds FTS query text via $query and executePrepared', async () => {
    const source = await fs.readFile(
      path.join(__dirname, '..', '..', 'src', 'core', 'lbug', 'lbug-adapter.ts'),
      'utf-8',
    );
    expect(source).toMatch(/QUERY_FTS_INDEX\('\$\{tableName\}', '\$\{indexName\}', \$query/);
    expect(source).toMatch(/executePrepared\(cypher,\s*\{\s*query\s*\}\)/);
  });
});
