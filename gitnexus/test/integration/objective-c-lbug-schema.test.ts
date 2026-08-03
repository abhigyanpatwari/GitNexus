import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';

import { streamAllCSVsToDisk } from '../../src/core/lbug/csv-generator.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'lang-resolution', 'objective-c-core');

withTestLbugDB('objective-c-language-metadata-roundtrip', (handle) => {
  it('persists File language and Objective-C symbol metadata through CSV COPY', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const { graph } = await runPipelineFromRepo(FIXTURE, () => {}, { skipGraphPhases: true });
    const csvDir = path.join(handle.tmpHandle.dbPath, 'objc-csv');
    await streamAllCSVsToDisk(graph, FIXTURE, csvDir);

    const storeHeader = graph.nodes.find(
      (node) => node.label === 'File' && node.properties.filePath === 'Store.h',
    );
    const runMethod = graph.nodes.find(
      (node) =>
        node.label === 'Method' &&
        node.properties.filePath === 'Store.m' &&
        node.properties.name === '-run',
    );
    const readyProperty = graph.nodes.find(
      (node) => node.label === 'Property' && node.properties.name === 'ready',
    );
    const category = graph.nodes.find(
      (node) =>
        node.label === 'CodeElement' &&
        node.properties.name === 'Store(Testing)' &&
        node.properties.sourceRole === 'implementation',
    );
    expect(storeHeader?.properties).toMatchObject({
      language: 'objective-c',
      languageReason: 'objective-c-syntax',
      languageClassifierVersion: 1,
    });
    expect(runMethod).toBeDefined();
    expect(readyProperty).toBeDefined();
    expect(category).toBeDefined();

    for (const table of [
      'File',
      'Class',
      'Interface',
      'Method',
      'Property',
      'CodeElement',
    ] as const) {
      const csvPath = path.join(csvDir, `${table.toLowerCase()}.csv`).replace(/\\/g, '/');
      await adapter.executeQuery(adapter.getCopyQuery(table, csvPath));
    }

    expect(
      await adapter.executeQuery(
        `MATCH (f:File {id: '${storeHeader!.id}'}) RETURN f.language AS language, f.languageReason AS languageReason, f.languageClassifierVersion AS classifierVersion`,
      ),
    ).toEqual([
      {
        language: 'objective-c',
        languageReason: 'objective-c-syntax',
        classifierVersion: 1,
      },
    ]);
    expect(
      await adapter.executeQuery(
        `MATCH (m:Method {id: '${runMethod!.id}'}) RETURN m.language AS language, m.selector AS selector, m.sourceRole AS sourceRole, m.sourceIdentity AS sourceIdentity, m.dispatchKey AS dispatchKey`,
      ),
    ).toEqual([
      expect.objectContaining({
        language: 'objective-c',
        selector: 'run',
        sourceRole: 'implementation',
        sourceIdentity: expect.stringMatching(/^objc:v1:/),
        dispatchKey: expect.stringMatching(/^objc:v1:/),
      }),
    ]);
    expect(
      await adapter.executeQuery(
        `MATCH (p:\`Property\` {id: '${readyProperty!.id}'}) RETURN p.getterSelector AS getterSelector, p.setterSelector AS setterSelector, p.annotations AS annotations`,
      ),
    ).toEqual([
      expect.objectContaining({
        getterSelector: '-isReady',
        setterSelector: '-setReady:',
        annotations: expect.stringContaining('objc:property:getter=isReady'),
      }),
    ]);
    expect(
      await adapter.executeQuery(
        `MATCH (c:CodeElement {id: '${category!.id}'}) RETURN c.categoryName AS categoryName, c.hostClassName AS hostClassName, c.sourceRole AS sourceRole`,
      ),
    ).toEqual([{ categoryName: 'Testing', hostClassName: 'Store', sourceRole: 'implementation' }]);

    const methodHeader = (await fs.readFile(path.join(csvDir, 'method.csv'), 'utf8')).split(
      '\n',
    )[0];
    expect(methodHeader).toContain('language,sourceIdentity,selector,isStatic,sourceRole');
  });
});
