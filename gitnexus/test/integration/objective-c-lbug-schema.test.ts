import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';

import { streamAllCSVsToDisk } from '../../src/core/lbug/csv-generator.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { PARSE_CACHE_VERSION, type ParseCache } from '../../src/storage/parse-cache.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'lang-resolution', 'objective-c-core');
const itLbugReopen = process.platform === 'win32' ? it.skip : it;

interface ObjectiveCWriteCase {
  label:
    | 'Function'
    | 'Class'
    | 'Interface'
    | 'Method'
    | 'CodeElement'
    | 'Property'
    | 'Enum'
    | 'Variable';
  tableLabel: string;
  properties: Record<string, unknown> & { id: string };
  returnClause: string;
  expected: Record<string, unknown>;
}

const objectiveCWriteCases = (prefix: string, marker: string): ObjectiveCWriteCase[] => {
  const annotation = `objc:${marker}`;
  const sourceIdentity = `objc:v1:${prefix}:${marker}`;
  const common = {
    name: `${prefix}-${marker}`,
    filePath: `${prefix}.m`,
    startLine: 3,
    endLine: 7,
    content: '',
    language: 'objective-c',
    sourceIdentity,
  };

  return [
    {
      label: 'Function',
      tableLabel: 'Function',
      properties: {
        id: `Function:${prefix}:${marker}`,
        ...common,
        isExported: false,
      },
      returnClause: 'n.language AS language, n.sourceIdentity AS sourceIdentity',
      expected: { language: 'objective-c', sourceIdentity },
    },
    {
      label: 'Class',
      tableLabel: 'Class',
      properties: {
        id: `Class:${prefix}:${marker}`,
        ...common,
        isExported: false,
        frameworkAnnotations: ['Foundation.NSObject'],
        sourceRole: 'implementation',
        declarationKey: `${prefix}:class`,
        annotations: [annotation],
      },
      returnClause:
        'n.frameworkAnnotations AS frameworkAnnotations, n.language AS language, n.sourceIdentity AS sourceIdentity, n.sourceRole AS sourceRole, n.declarationKey AS declarationKey, n.annotations AS annotations',
      expected: {
        frameworkAnnotations: ['Foundation.NSObject'],
        language: 'objective-c',
        sourceIdentity,
        sourceRole: 'implementation',
        declarationKey: `${prefix}:class`,
        annotations: JSON.stringify([annotation]),
      },
    },
    {
      label: 'Interface',
      tableLabel: 'Interface',
      properties: {
        id: `Interface:${prefix}:${marker}`,
        ...common,
        isExported: false,
        sourceRole: 'declaration',
        declarationKey: `${prefix}:protocol`,
        annotations: [annotation],
      },
      returnClause:
        'n.language AS language, n.sourceIdentity AS sourceIdentity, n.sourceRole AS sourceRole, n.declarationKey AS declarationKey, n.annotations AS annotations',
      expected: {
        language: 'objective-c',
        sourceIdentity,
        sourceRole: 'declaration',
        declarationKey: `${prefix}:protocol`,
        annotations: JSON.stringify([annotation]),
      },
    },
    {
      label: 'Method',
      tableLabel: 'Method',
      properties: {
        id: `Method:${prefix}:${marker}`,
        ...common,
        isExported: false,
        parameterCount: 1,
        returnType: 'NSString *',
        selector: 'valueForKey:',
        isStatic: false,
        sourceRole: 'implementation',
        declarationKey: `${prefix}:method`,
        dispatchKey: `-${prefix}:valueForKey:`,
        categoryName: 'Testing',
        parameterTypes: ['NSString *'],
        annotations: [annotation],
      },
      returnClause:
        'n.parameterCount AS parameterCount, n.returnType AS returnType, n.language AS language, n.sourceIdentity AS sourceIdentity, n.selector AS selector, n.isStatic AS isStatic, n.sourceRole AS sourceRole, n.declarationKey AS declarationKey, n.dispatchKey AS dispatchKey, n.categoryName AS categoryName, n.parameterTypes AS parameterTypes, n.annotations AS annotations',
      expected: {
        parameterCount: 1,
        returnType: 'NSString *',
        language: 'objective-c',
        sourceIdentity,
        selector: 'valueForKey:',
        isStatic: false,
        sourceRole: 'implementation',
        declarationKey: `${prefix}:method`,
        dispatchKey: `-${prefix}:valueForKey:`,
        categoryName: 'Testing',
        parameterTypes: JSON.stringify(['NSString *']),
        annotations: JSON.stringify([annotation]),
      },
    },
    {
      label: 'CodeElement',
      tableLabel: 'CodeElement',
      properties: {
        id: `CodeElement:${prefix}:${marker}`,
        ...common,
        isExported: false,
        sourceRole: 'implementation',
        categoryName: 'Testing',
        hostClassName: prefix,
        declarationKey: `${prefix}:selector`,
        selector: 'save:',
        annotations: [annotation],
      },
      returnClause:
        'n.language AS language, n.sourceIdentity AS sourceIdentity, n.sourceRole AS sourceRole, n.categoryName AS categoryName, n.hostClassName AS hostClassName, n.declarationKey AS declarationKey, n.selector AS selector, n.annotations AS annotations',
      expected: {
        language: 'objective-c',
        sourceIdentity,
        sourceRole: 'implementation',
        categoryName: 'Testing',
        hostClassName: prefix,
        declarationKey: `${prefix}:selector`,
        selector: 'save:',
        annotations: JSON.stringify([annotation]),
      },
    },
    {
      label: 'Property',
      tableLabel: '`Property`',
      properties: {
        id: `Property:${prefix}:${marker}`,
        ...common,
        declaredType: 'NSString *',
        sourceRole: 'declaration',
        declarationKey: `${prefix}:property`,
        getterSelector: '-displayName',
        setterSelector: '-setDisplayName:',
        annotations: [annotation],
      },
      returnClause:
        'n.declaredType AS declaredType, n.language AS language, n.sourceIdentity AS sourceIdentity, n.sourceRole AS sourceRole, n.declarationKey AS declarationKey, n.getterSelector AS getterSelector, n.setterSelector AS setterSelector, n.annotations AS annotations',
      expected: {
        declaredType: 'NSString *',
        language: 'objective-c',
        sourceIdentity,
        sourceRole: 'declaration',
        declarationKey: `${prefix}:property`,
        getterSelector: '-displayName',
        setterSelector: '-setDisplayName:',
        annotations: JSON.stringify([annotation]),
      },
    },
    {
      label: 'Enum',
      tableLabel: '`Enum`',
      properties: {
        id: `Enum:${prefix}:${marker}`,
        ...common,
        annotations: [annotation],
        underlyingType: 'NSInteger',
      },
      returnClause:
        'n.language AS language, n.sourceIdentity AS sourceIdentity, n.annotations AS annotations, n.underlyingType AS underlyingType',
      expected: {
        language: 'objective-c',
        sourceIdentity,
        annotations: JSON.stringify([annotation]),
        underlyingType: 'NSInteger',
      },
    },
    {
      label: 'Variable',
      tableLabel: '`Variable`',
      properties: {
        id: `Variable:${prefix}:${marker}`,
        ...common,
        annotations: [annotation],
      },
      returnClause:
        'n.language AS language, n.sourceIdentity AS sourceIdentity, n.annotations AS annotations',
      expected: {
        language: 'objective-c',
        sourceIdentity,
        annotations: JSON.stringify([annotation]),
      },
    },
  ];
};

withTestLbugDB('objective-c-language-metadata-roundtrip', (handle) => {
  it('preserves Objective-C metadata through single-node writes', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');

    for (const testCase of objectiveCWriteCases('SingleWrite', 'initial')) {
      expect(await adapter.insertNodeToLbug(testCase.label, testCase.properties)).toBe(true);
      expect(
        await adapter.executeQuery(
          `MATCH (n:${testCase.tableLabel} {id: '${testCase.properties.id}'}) RETURN ${testCase.returnClause}`,
        ),
      ).toEqual([testCase.expected]);
    }
  });

  itLbugReopen('preserves and updates Objective-C metadata through batch-node writes', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const initial = objectiveCWriteCases('BatchWrite', 'initial');
    const updated = objectiveCWriteCases('BatchWrite', 'updated').map((testCase, index) => ({
      ...testCase,
      properties: { ...testCase.properties, id: initial[index].properties.id },
    }));

    await adapter.closeLbug();
    let inserted: { inserted: number; failed: number } | undefined;
    let merged: { inserted: number; failed: number } | undefined;
    try {
      inserted = await adapter.batchInsertNodesToLbug(
        initial.map(({ label, properties }) => ({ label, properties })),
        handle.dbPath,
      );
      merged = await adapter.batchInsertNodesToLbug(
        updated.map(({ label, properties }) => ({ label, properties })),
        handle.dbPath,
      );
    } finally {
      await adapter.initLbug(handle.dbPath);
    }

    expect(inserted).toEqual({ inserted: initial.length, failed: 0 });
    expect(merged).toEqual({ inserted: updated.length, failed: 0 });
    for (const testCase of updated) {
      expect(
        await adapter.executeQuery(
          `MATCH (n:${testCase.tableLabel} {id: '${testCase.properties.id}'}) RETURN ${testCase.returnClause}`,
        ),
      ).toEqual([testCase.expected]);
    }
  });

  it('persists Objective-C graph facts identically after a warm parse-cache run', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const repoDir = path.join(handle.tmpHandle.dbPath, 'objc-repo');
    await fs.cp(FIXTURE, repoDir, { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'PersistenceFacts.m'),
      [
        'typedef NS_ENUM(NSInteger, PersistedMode) { PersistedModeReady };',
        'typedef NS_OPTIONS(NSUInteger, PersistedFeatures) { PersistedFeatureFast = 1 };',
        '@protocol PersistedParent',
        '- (void)parentRequirement;',
        '@end',
        '@protocol PersistedChild <PersistedParent>',
        '@end',
        'API_AVAILABLE(ios(14.0)) @interface PersistenceFacts : NSObject {',
        '  NSString *_token;',
        '}',
        '- (void)probe;',
        '@end',
        '@implementation PersistenceFacts',
        '- (void)probe { SEL first = @selector(save:); SEL second = @selector(save:); }',
        '@end',
        '',
      ].join('\n'),
    );
    const parseCache: ParseCache = {
      version: PARSE_CACHE_VERSION,
      entries: new Map(),
      usedKeys: new Set(),
    };
    const cold = await runPipelineFromRepo(repoDir, () => {}, {
      skipGraphPhases: true,
      parseCache,
    });
    const warm = await runPipelineFromRepo(repoDir, () => {}, {
      skipGraphPhases: true,
      parseCache,
    });
    const graph = warm.graph;
    const objectiveCFacts = (candidate: typeof graph) =>
      candidate.nodes
        .filter(
          (node) =>
            node.properties.filePath === 'PersistenceFacts.m' &&
            ['Class', 'Interface', 'Variable', 'CodeElement', 'Enum'].includes(node.label),
        )
        .map((node) => ({ id: node.id, label: node.label, properties: node.properties }))
        .sort((left, right) => left.id.localeCompare(right.id));
    expect(cold.usedWorkerPool).toBe(true);
    expect(warm.usedWorkerPool).toBe(false);
    expect(objectiveCFacts(graph)).toEqual(objectiveCFacts(cold.graph));

    const csvDir = path.join(handle.tmpHandle.dbPath, 'objc-csv');
    await streamAllCSVsToDisk(graph, repoDir, csvDir);

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
    const selectors = graph.nodes
      .filter(
        (node) =>
          node.label === 'CodeElement' &&
          node.properties.filePath === 'PersistenceFacts.m' &&
          node.properties.name === '@selector(save:)',
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const enums = graph.nodes
      .filter(
        (node) =>
          node.label === 'Enum' &&
          node.properties.filePath === 'PersistenceFacts.m' &&
          ['PersistedMode', 'PersistedFeatures'].includes(node.properties.name),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const persistedClass = graph.nodes.find(
      (node) =>
        node.label === 'Class' &&
        node.properties.filePath === 'PersistenceFacts.m' &&
        node.properties.name === 'PersistenceFacts' &&
        (node.properties.annotations as string[] | undefined)?.some((annotation) =>
          annotation.startsWith('objc:availability:'),
        ),
    );
    const persistedProtocol = graph.nodes.find(
      (node) =>
        node.label === 'Interface' &&
        node.properties.filePath === 'PersistenceFacts.m' &&
        node.properties.name === 'PersistedChild',
    );
    const persistedIvar = graph.nodes.find(
      (node) =>
        node.label === 'Variable' &&
        node.properties.filePath === 'PersistenceFacts.m' &&
        node.properties.name === '_token',
    );
    expect(storeHeader?.properties).toMatchObject({
      language: 'objective-c',
      languageReason: 'objective-c-syntax',
      languageClassifierVersion: 1,
    });
    expect(runMethod).toBeDefined();
    expect(readyProperty).toBeDefined();
    expect(category).toBeDefined();
    if (
      storeHeader === undefined ||
      runMethod === undefined ||
      readyProperty === undefined ||
      category === undefined ||
      persistedClass === undefined ||
      persistedProtocol === undefined ||
      persistedIvar === undefined
    ) {
      throw new Error('Expected Objective-C persistence fixtures to produce all graph nodes');
    }
    expect(selectors).toHaveLength(2);
    expect(new Set(selectors.map((node) => node.properties.sourceIdentity))).toHaveLength(2);
    expect(selectors.every((node) => node.properties.startLine === 13)).toBe(true);
    expect(selectors.every((node) => node.properties.endLine === 13)).toBe(true);
    expect(enums).toHaveLength(2);
    expect(persistedClass.properties.annotations).toContain(
      'objc:availability:API_AVAILABLE(ios(14.0))',
    );
    expect(persistedProtocol.properties.annotations).toContain(
      'objc:protocol-parents:["PersistedParent"]',
    );
    expect(persistedIvar.properties.annotations).toContain('objc:ivar');

    for (const table of [
      'File',
      'Class',
      'Interface',
      'Method',
      'Property',
      'CodeElement',
      'Enum',
      'Variable',
    ] as const) {
      const csvPath = path.join(csvDir, `${table.toLowerCase()}.csv`).replace(/\\/g, '/');
      await adapter.executeQuery(adapter.getCopyQuery(table, csvPath));
    }

    expect(
      await adapter.executeQuery(
        `MATCH (f:File {id: '${storeHeader.id}'}) RETURN f.language AS language, f.languageReason AS languageReason, f.languageClassifierVersion AS classifierVersion`,
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
        `MATCH (m:Method {id: '${runMethod.id}'}) RETURN m.language AS language, m.selector AS selector, m.sourceRole AS sourceRole, m.sourceIdentity AS sourceIdentity, m.dispatchKey AS dispatchKey`,
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
        `MATCH (p:\`Property\` {id: '${readyProperty.id}'}) RETURN p.getterSelector AS getterSelector, p.setterSelector AS setterSelector, p.annotations AS annotations`,
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
        `MATCH (c:CodeElement {id: '${category.id}'}) RETURN c.categoryName AS categoryName, c.hostClassName AS hostClassName, c.sourceRole AS sourceRole`,
      ),
    ).toEqual([{ categoryName: 'Testing', hostClassName: 'Store', sourceRole: 'implementation' }]);

    const selectorRows = (
      await adapter.executeQuery(
        `MATCH (c:CodeElement) WHERE c.filePath = 'PersistenceFacts.m' AND c.name = '@selector(save:)' RETURN c.id AS id, c.startLine AS startLine, c.endLine AS endLine, c.selector AS selector, c.annotations AS annotations, c.sourceRole AS sourceRole, c.sourceIdentity AS sourceIdentity`,
      )
    ).sort((left, right) => String(left.id).localeCompare(String(right.id)));
    expect(selectorRows).toEqual(
      selectors.map((node) => ({
        id: node.id,
        startLine: node.properties.startLine,
        endLine: node.properties.endLine,
        selector: 'save:',
        annotations: JSON.stringify(node.properties.annotations),
        sourceRole: 'implementation',
        sourceIdentity: node.properties.sourceIdentity,
      })),
    );

    const enumRows = (
      await adapter.executeQuery(
        `MATCH (e:\`Enum\`) WHERE e.filePath = 'PersistenceFacts.m' RETURN e.id AS id, e.name AS name, e.annotations AS annotations, e.underlyingType AS underlyingType`,
      )
    ).sort((left, right) => String(left.id).localeCompare(String(right.id)));
    expect(enumRows).toEqual(
      enums.map((node) => ({
        id: node.id,
        name: node.properties.name,
        annotations: JSON.stringify(node.properties.annotations),
        underlyingType: node.properties.underlyingType,
      })),
    );

    expect(
      await adapter.executeQuery(
        `MATCH (c:Class {id: '${persistedClass.id}'}) RETURN c.annotations AS annotations`,
      ),
    ).toEqual([{ annotations: JSON.stringify(persistedClass.properties.annotations) }]);
    expect(
      await adapter.executeQuery(
        `MATCH (i:Interface {id: '${persistedProtocol.id}'}) RETURN i.annotations AS annotations`,
      ),
    ).toEqual([{ annotations: JSON.stringify(persistedProtocol.properties.annotations) }]);
    expect(
      await adapter.executeQuery(
        `MATCH (v:\`Variable\` {id: '${persistedIvar.id}'}) RETURN v.annotations AS annotations`,
      ),
    ).toEqual([{ annotations: JSON.stringify(persistedIvar.properties.annotations) }]);

    const methodHeader = (await fs.readFile(path.join(csvDir, 'method.csv'), 'utf8')).split(
      '\n',
    )[0];
    expect(methodHeader).toContain('language,sourceIdentity,selector,isStatic,sourceRole');
    const codeElementHeader = (
      await fs.readFile(path.join(csvDir, 'codeelement.csv'), 'utf8')
    ).split('\n')[0];
    expect(codeElementHeader).toContain('selector,annotations');
    const enumHeader = (await fs.readFile(path.join(csvDir, 'enum.csv'), 'utf8')).split('\n')[0];
    expect(enumHeader).toContain('annotations,underlyingType');
    const classHeader = (await fs.readFile(path.join(csvDir, 'class.csv'), 'utf8')).split('\n')[0];
    const interfaceHeader = (await fs.readFile(path.join(csvDir, 'interface.csv'), 'utf8')).split(
      '\n',
    )[0];
    const variableHeader = (await fs.readFile(path.join(csvDir, 'variable.csv'), 'utf8')).split(
      '\n',
    )[0];
    expect(classHeader).toContain('declarationKey,annotations');
    expect(interfaceHeader).toContain('declarationKey,annotations');
    expect(variableHeader).toContain('sourceIdentity,annotations');
  });
});
