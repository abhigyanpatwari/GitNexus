import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { buildTestGraph } from '../helpers/test-graph.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { streamAllCSVsToDisk } from '../../src/core/lbug/csv-generator.js';

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
      'id,name,filePath,startLine,endLine,isExported,content,description,frameworkAnnotations',
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
});
