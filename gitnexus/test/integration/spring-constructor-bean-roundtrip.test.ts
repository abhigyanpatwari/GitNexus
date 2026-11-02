/** Regression for #3238: a constructor's dynamic @Bean lookup must survive COPY. */
import { expect, it } from 'vitest';
import path from 'path';
import { FIXTURES, runPipelineFromRepo } from './resolvers/helpers.js';
import { createTempDir } from '../helpers/test-db.js';
import * as adapter from '../../src/core/lbug/lbug-adapter.js';

it('persists the constructor-to-factory-bean INJECTS edge from the real pipeline', async () => {
  const fixture = path.join(FIXTURES, 'spring-constructor-bean-lookup');
  const result = await runPipelineFromRepo(fixture, () => {}, { workerPoolSize: 1 });
  const temp = await createTempDir();
  try {
    await adapter.initLbug(path.join(temp.dbPath, 'lbug'));
    await adapter.loadGraphToLbug(result.graph, fixture, temp.dbPath);
    const rows = await adapter.executeQuery(
      "MATCH (c:`Constructor`)-[r:CodeRelation]->(b:CodeElement) WHERE r.type = 'INJECTS' " +
        'RETURN c.filePath AS sourceFile, b.filePath AS targetFile, b.name AS beanName',
    );
    expect(rows).toEqual([
      {
        sourceFile: 'src/example/Worker.java',
        targetFile: 'src/example/AppConfig.java',
        beanName: 'handler',
      },
    ]);
  } finally {
    await adapter.closeLbug();
    await temp.cleanup();
  }
}, 120_000);
