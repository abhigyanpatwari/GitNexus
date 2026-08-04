import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { buildTestGraph } from '../helpers/test-graph.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { streamAllCSVsToDisk } from '../../src/core/lbug/csv-generator.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

const CLASS_ID = 'Class:src/BillingService.java:BillingService';
const FRAMEWORK_MARKER = 'com.acme.FrameworkMarker';
const itLbugReopen = process.platform === 'win32' ? it.skip : it;

withTestLbugDB('spring-bean-metadata-roundtrip', (handle) => {
  it('preserves Class framework annotations through all write paths', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
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
    await fs.mkdir(repoDir, { recursive: true });
    await streamAllCSVsToDisk(graph, repoDir, csvDir);

    const classCsvPath = path.join(csvDir, 'class.csv');
    const classCsv = await fs.readFile(classCsvPath, 'utf8');
    expect(classCsv.split('\n')[0]).toBe(
      'id,name,filePath,startLine,endLine,isExported,content,description,frameworkAnnotations,language,sourceIdentity,sourceRole,declarationKey,annotations',
    );
    expect(classCsv).toContain('org.springframework.stereotype.Service');
    expect(classCsv).toContain(FRAMEWORK_MARKER);

    await adapter.executeQuery(adapter.getCopyQuery('Class', classCsvPath.replace(/\\/g, '/')));
    expect(
      await adapter.executeQuery(
        `MATCH (c:Class {id: '${CLASS_ID}'}) RETURN c.frameworkAnnotations AS frameworkAnnotations`,
      ),
    ).toEqual([
      {
        frameworkAnnotations: ['org.springframework.stereotype.Service', FRAMEWORK_MARKER],
      },
    ]);

    expect(
      await adapter.insertNodeToLbug('Class', {
        id: 'Class:src/Widget.java:Widget',
        name: 'Widget',
        filePath: 'src/Widget.java',
        frameworkAnnotations: ['org.springframework.stereotype.Component'],
      }),
    ).toBe(true);
    expect(
      await adapter.executeQuery(
        `MATCH (c:Class {id: 'Class:src/Widget.java:Widget'}) RETURN c.frameworkAnnotations AS frameworkAnnotations`,
      ),
    ).toEqual([
      {
        frameworkAnnotations: ['org.springframework.stereotype.Component'],
      },
    ]);
  });

  itLbugReopen('preserves Class framework annotations through batch upserts', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    // The batch helper owns its connection, so release the singleton lock for
    // the call and restore it before the shared fixture tears down.
    await adapter.closeLbug();
    let upsertResult: { inserted: number; failed: number };
    try {
      upsertResult = await adapter.batchInsertNodesToLbug(
        [
          {
            label: 'Class',
            properties: {
              id: CLASS_ID,
              name: 'BillingService',
              filePath: 'src/BillingService.java',
              frameworkAnnotations: ['org.springframework.stereotype.Repository', FRAMEWORK_MARKER],
            },
          },
        ],
        handle.dbPath,
      );
    } finally {
      await adapter.initLbug(handle.dbPath);
    }

    expect(upsertResult).toEqual({ inserted: 1, failed: 0 });
    expect(
      await adapter.executeQuery(
        `MATCH (c:Class {id: '${CLASS_ID}'}) RETURN c.frameworkAnnotations AS frameworkAnnotations`,
      ),
    ).toEqual([
      {
        frameworkAnnotations: ['org.springframework.stereotype.Repository', FRAMEWORK_MARKER],
      },
    ]);
  });

  itLbugReopen(
    'preserves existing non-Objective-C metadata during sparse batch upserts',
    async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const sparseId = 'Class:src/SparseService.java:SparseService';
      expect(
        await adapter.insertNodeToLbug('Class', {
          id: sparseId,
          name: 'SparseService',
          filePath: 'src/SparseService.java',
          language: 'java',
          sourceIdentity: 'java:v1:SparseService',
          sourceRole: 'implementation',
          declarationKey: 'com.acme.SparseService',
          annotations: ['java:service'],
        }),
      ).toBe(true);

      await adapter.closeLbug();
      let upsertResult: { inserted: number; failed: number };
      try {
        upsertResult = await adapter.batchInsertNodesToLbug(
          [
            {
              label: 'Class',
              properties: {
                id: sparseId,
                name: 'SparseServiceRenamed',
                filePath: 'src/SparseService.java',
                frameworkAnnotations: ['org.springframework.stereotype.Service'],
              },
            },
          ],
          handle.dbPath,
        );
      } finally {
        await adapter.initLbug(handle.dbPath);
      }

      expect(upsertResult).toEqual({ inserted: 1, failed: 0 });
      expect(
        await adapter.executeQuery(
          `MATCH (c:Class {id: '${sparseId}'}) RETURN c.name AS name, c.language AS language, c.sourceIdentity AS sourceIdentity, c.sourceRole AS sourceRole, c.declarationKey AS declarationKey, c.annotations AS annotations`,
        ),
      ).toEqual([
        {
          name: 'SparseServiceRenamed',
          language: 'java',
          sourceIdentity: 'java:v1:SparseService',
          sourceRole: 'implementation',
          declarationKey: 'com.acme.SparseService',
          annotations: JSON.stringify(['java:service']),
        },
      ]);
    },
  );

  it('rejects framework annotation items that COPY cannot encode losslessly', async () => {
    const graph = buildTestGraph([
      {
        id: 'Class:src/Unsafe.java:Unsafe',
        label: 'Class',
        name: 'Unsafe',
        filePath: 'src/Unsafe.java',
        extra: { frameworkAnnotations: ['com.acme.Has,Comma'] },
      },
    ]);
    const csvDir = path.join(handle.tmpHandle.dbPath, 'csv-unsafe-framework-annotation');
    const repoDir = path.join(handle.tmpHandle.dbPath, 'repo-unsafe-framework-annotation');
    await fs.mkdir(repoDir, { recursive: true });

    await expect(streamAllCSVsToDisk(graph, repoDir, csvDir)).rejects.toThrow(
      'Cannot safely encode CSV string-list item',
    );
  });

  it('persists pipeline-produced Class and Method INJECTS edges to Bean declarations', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const root = path.join(handle.tmpHandle.dbPath, 'spring-bean-injects-roundtrip');
    const repoDir = path.join(root, 'repo');
    const storageDir = path.join(root, 'storage');
    await fs.mkdir(repoDir, { recursive: true });
    await fs.mkdir(storageDir, { recursive: true });
    await Promise.all([
      fs.writeFile(
        path.join(repoDir, 'Gateway.java'),
        `package com.persisted;
public interface Gateway {}
`,
      ),
      fs.writeFile(
        path.join(repoDir, 'DefaultGateway.java'),
        `package com.persisted;
public class DefaultGateway implements Gateway {}
`,
      ),
      fs.writeFile(
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
      fs.writeFile(
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
    expect(
      graph.relationships.some(
        (relationship) =>
          relationship.type === 'INJECTS' &&
          graph.getNode(relationship.sourceId)?.properties.name === 'PersistedConsumer' &&
          graph.getNode(relationship.targetId)?.properties.name === 'persistedGateway',
      ),
    ).toBe(true);
    expect(
      graph.relationships.some(
        (relationship) =>
          relationship.type === 'INJECTS' &&
          graph.getNode(relationship.sourceId)?.properties.name === 'persistedAggregate' &&
          graph.getNode(relationship.targetId)?.properties.name === 'persistedGateway',
      ),
    ).toBe(true);

    await adapter.loadGraphToLbug(graph, repoDir, storageDir);

    expect(
      await adapter.executeQuery(
        `MATCH (source:Class)-[r:CodeRelation]->(target:CodeElement)
         WHERE r.type = 'INJECTS'
           AND source.name = 'PersistedConsumer'
           AND target.name = 'persistedGateway'
         RETURN source.name AS source, target.name AS target`,
      ),
    ).toEqual([{ source: 'PersistedConsumer', target: 'persistedGateway' }]);
    expect(
      await adapter.executeQuery(
        `MATCH (source:Method)-[r:CodeRelation]->(target:CodeElement)
         WHERE r.type = 'INJECTS'
           AND source.name = 'persistedAggregate'
           AND target.name = 'persistedGateway'
         RETURN source.name AS source, target.name AS target`,
      ),
    ).toEqual([{ source: 'persistedAggregate', target: 'persistedGateway' }]);
  }, 90_000);
});
