import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { buildTestGraph, FIXTURES, withGraphDatabase } from '../spring-support.mjs';
import { streamAllCSVsToDisk } from '../../../../dist/core/lbug/csv-generator.js';
import { runPipelineFromRepo } from '../../../../dist/core/ingestion/pipeline.js';
import { createTempDir } from '../../../../test/helpers/test-db.ts';
import * as adapter from '../../../../dist/core/lbug/lbug-adapter.js';
export async function verifyBeanMetadataRoundtrip() {
  const CLASS_ID = 'Class:src/BillingService.java:BillingService';
  const FRAMEWORK_MARKER = 'com.acme.FrameworkMarker';
  await withGraphDatabase('spring-bean-metadata-roundtrip', async (handle) => {
    // preserves Class framework annotations through all write paths
    {
      const adapter = await import('../../../../dist/core/lbug/lbug-adapter.js');
      const graph = buildTestGraph([
        {
          id: CLASS_ID,
          label: 'Class',
          name: 'BillingService',
          filePath: 'src/BillingService.java',
          extra: {
            frameworkAnnotations: ['org.springframework.stereotype.Service', FRAMEWORK_MARKER],
          },
        },
      ]);
      const csvDir = path.join(handle.tmpHandle.dbPath, 'csv-spring-bean');
      const repoDir = path.join(handle.tmpHandle.dbPath, 'repo-spring-bean');
      await fsPromises.mkdir(repoDir, {
        recursive: true,
      });
      await streamAllCSVsToDisk(graph, repoDir, csvDir);
      const classCsvPath = path.join(csvDir, 'class.csv');
      const classCsv = await fsPromises.readFile(classCsvPath, 'utf8');
      assert.equal(
        classCsv.split('\n')[0],
        'id,name,filePath,startLine,endLine,isExported,content,description,frameworkAnnotations',
      );
      assert.ok(classCsv.includes('org.springframework.stereotype.Service'));
      assert.ok(classCsv.includes(FRAMEWORK_MARKER));
      await adapter.executeQuery(adapter.getCopyQuery('Class', classCsvPath.replace(/\\/g, '/')));
      assert.deepStrictEqual(
        await adapter.executeQuery(
          `MATCH (c:Class {id: '${CLASS_ID}'}) RETURN c.frameworkAnnotations AS frameworkAnnotations`,
        ),
        [
          {
            frameworkAnnotations: ['org.springframework.stereotype.Service', FRAMEWORK_MARKER],
          },
        ],
      );
      assert.equal(
        await adapter.insertNodeToLbug('Class', {
          id: 'Class:src/Widget.java:Widget',
          name: 'Widget',
          filePath: 'src/Widget.java',
          frameworkAnnotations: ['org.springframework.stereotype.Component'],
        }),
        true,
      );
      assert.deepStrictEqual(
        await adapter.executeQuery(
          `MATCH (c:Class {id: 'Class:src/Widget.java:Widget'}) RETURN c.frameworkAnnotations AS frameworkAnnotations`,
        ),
        [
          {
            frameworkAnnotations: ['org.springframework.stereotype.Component'],
          },
        ],
      );
    }
    // preserves Class framework annotations through batch upserts
    if (process.platform !== 'win32') {
      const adapter = await import('../../../../dist/core/lbug/lbug-adapter.js');
      // The batch helper owns its connection, so release the singleton lock for
      // the call and restore it before the shared fixture tears down.
      await adapter.closeLbug();
      let upsertResult;
      try {
        upsertResult = await adapter.batchInsertNodesToLbug(
          [
            {
              label: 'Class',
              properties: {
                id: CLASS_ID,
                name: 'BillingService',
                filePath: 'src/BillingService.java',
                frameworkAnnotations: [
                  'org.springframework.stereotype.Repository',
                  FRAMEWORK_MARKER,
                ],
              },
            },
          ],
          handle.dbPath,
        );
      } finally {
        await adapter.initLbug(handle.dbPath);
      }
      assert.deepStrictEqual(upsertResult, {
        inserted: 1,
        failed: 0,
      });
      assert.deepStrictEqual(
        await adapter.executeQuery(
          `MATCH (c:Class {id: '${CLASS_ID}'}) RETURN c.frameworkAnnotations AS frameworkAnnotations`,
        ),
        [
          {
            frameworkAnnotations: ['org.springframework.stereotype.Repository', FRAMEWORK_MARKER],
          },
        ],
      );
    }
    // rejects framework annotation items that COPY cannot encode losslessly
    {
      const graph = buildTestGraph([
        {
          id: 'Class:src/Unsafe.java:Unsafe',
          label: 'Class',
          name: 'Unsafe',
          filePath: 'src/Unsafe.java',
          extra: {
            frameworkAnnotations: ['com.acme.Has,Comma'],
          },
        },
      ]);
      const csvDir = path.join(handle.tmpHandle.dbPath, 'csv-unsafe-framework-annotation');
      const repoDir = path.join(handle.tmpHandle.dbPath, 'repo-unsafe-framework-annotation');
      await fsPromises.mkdir(repoDir, {
        recursive: true,
      });
      await assert.rejects(streamAllCSVsToDisk(graph, repoDir, csvDir), (error) =>
        error.message.includes('Cannot safely encode CSV string-list item'),
      );
    }
    // persists pipeline-produced Class and Method INJECTS edges to Bean declarations
    {
      const adapter = await import('../../../../dist/core/lbug/lbug-adapter.js');
      const root = path.join(handle.tmpHandle.dbPath, 'spring-bean-injects-roundtrip');
      const repoDir = path.join(root, 'repo');
      const storageDir = path.join(root, 'storage');
      await fsPromises.mkdir(repoDir, {
        recursive: true,
      });
      await fsPromises.mkdir(storageDir, {
        recursive: true,
      });
      await Promise.all([
        fsPromises.writeFile(
          path.join(repoDir, 'Gateway.java'),
          `package com.persisted;
public interface Gateway {}
`,
        ),
        fsPromises.writeFile(
          path.join(repoDir, 'DefaultGateway.java'),
          `package com.persisted;
public class DefaultGateway implements Gateway {}
`,
        ),
        fsPromises.writeFile(
          path.join(repoDir, 'PersistedConfig.java'),
          `package com.persisted;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
@Configuration
public class PersistedConfig {
  @Bean Gateway persistedGateway() { return new DefaultGateway(); }
  @Bean Object persistedAggregate(Gateway gateway) { return new Object(); }
}
`,
        ),
        fsPromises.writeFile(
          path.join(repoDir, 'PersistedConsumer.java'),
          `package com.persisted;
import jakarta.annotation.Resource;
public class PersistedConsumer {
  @Resource(name = "persistedGateway") Gateway selected;
}
`,
        ),
      ]);
      const { graph } = await runPipelineFromRepo(repoDir, () => {}, {});
      assert.equal(
        graph.relationships.some(
          (relationship) =>
            relationship.type === 'INJECTS' &&
            graph.getNode(relationship.sourceId)?.properties.name === 'PersistedConsumer' &&
            graph.getNode(relationship.targetId)?.properties.name === 'persistedGateway',
        ),
        true,
      );
      assert.equal(
        graph.relationships.some(
          (relationship) =>
            relationship.type === 'INJECTS' &&
            graph.getNode(relationship.sourceId)?.properties.name === 'persistedAggregate' &&
            graph.getNode(relationship.targetId)?.properties.name === 'persistedGateway',
        ),
        true,
      );
      await adapter.loadGraphToLbug(graph, repoDir, storageDir);
      assert.deepStrictEqual(
        await adapter.executeQuery(`MATCH (source:Class)-[r:CodeRelation]->(target:CodeElement)
         WHERE r.type = 'INJECTS'
           AND source.name = 'PersistedConsumer'
           AND target.name = 'persistedGateway'
         RETURN source.name AS source, target.name AS target`),
        [
          {
            source: 'PersistedConsumer',
            target: 'persistedGateway',
          },
        ],
      );
      assert.deepStrictEqual(
        await adapter.executeQuery(`MATCH (source:Method)-[r:CodeRelation]->(target:CodeElement)
         WHERE r.type = 'INJECTS'
           AND source.name = 'persistedAggregate'
           AND target.name = 'persistedGateway'
         RETURN source.name AS source, target.name AS target`),
        [
          {
            source: 'persistedAggregate',
            target: 'persistedGateway',
          },
        ],
      );
    }
  });
}
export async function verifyConstructorBeanRoundtrip() {
  // persists the constructor-to-factory-bean INJECTS edge from the real pipeline

  const fixture = path.join(FIXTURES, 'spring-constructor-bean-lookup');
  const result = await runPipelineFromRepo(fixture, () => {}, {
    workerPoolSize: 1,
  });
  const temp = await createTempDir();
  try {
    await adapter.initLbug(path.join(temp.dbPath, 'lbug'));
    await adapter.loadGraphToLbug(result.graph, fixture, temp.dbPath);
    const rows = await adapter.executeQuery(
      "MATCH (c:`Constructor`)-[r:CodeRelation]->(b:CodeElement) WHERE r.type = 'INJECTS' " +
        'RETURN c.filePath AS sourceFile, b.filePath AS targetFile, b.name AS beanName',
    );
    assert.deepStrictEqual(rows, [
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
}
