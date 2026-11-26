import { runtimeParseIdentity } from '../../../../test/helpers/runtime-parse-identity.js';
import { compilerReport } from '../compiler-report.mjs';
import diagnostics from '../diagnostics.json' with { type: 'json' };
import { SyntaxKind } from 'typescript/unstable/ast';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  loadParseCache,
  pruneCache,
  saveParseCache,
  type ParseCache,
} from '../../../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../../../src/storage/parsedfile-store.js';
import {
  findDanglingEdges,
  getNodesByLabel,
  getNodesByLabelFull,
  getRelationships,
} from '../../../../test/helpers/resolution-graph.js';
import { runPipelineFromRepo } from '../../../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../../../src/types/pipeline.js';

const FIXTURES = path.resolve(import.meta.dirname, '../../../../test/fixtures/lang-resolution');

function assertSingleMatch(rows: readonly unknown[], expected: object) {
  assert.equal(rows.length, 1);
  assert.partialDeepStrictEqual(rows[0], expected);
}

function blockHandlerIds(result: PipelineResult): Map<string, string> {
  const handlers = new Map<string, string>();
  const fixture = 'lang-resolution/typescript-mcp-tools';
  const expected = new Set(['first_block_callback', 'second_block_callback']);
  compilerReport(path.resolve(FIXTURES, 'typescript-mcp-tools'), diagnostics[fixture], false, {
    onSourceFile(source, checker, project) {
      if (path.basename(source.fileName) !== 'server.ts') return;
      function visit(node) {
        if (node.kind === SyntaxKind.CallExpression) {
          const name = node.arguments[0]?.text;
          if (expected.has(name)) {
            const argument = node.arguments.at(-1);
            const declaration = checker
              .getSymbolAtLocation(argument)
              ?.valueDeclaration?.resolve(project);
            assert.equal(declaration?.initializer?.kind, SyntaxKind.ArrowFunction);
            const { line, character } = source.getLineAndCharacterOfPosition(
              declaration.initializer.getStart(),
            );
            const [handler] = getRelationships(result, 'HANDLES_TOOL').filter(
              (edge) => edge.target === name,
            );
            assert.ok(handler);
            const symbol = result.graph.getNode(handler.rel.sourceId);
            assert.equal(symbol?.label, 'Function');
            assert.partialDeepStrictEqual(symbol.properties, {
              filePath: 'src/server.ts',
              startLine: line,
              startColumn: character,
            });
            handlers.set(name, symbol.id);
          }
        }
        node.forEachChild(visit);
      }
      visit(source);
    },
  });
  assert.deepEqual(new Set(handlers.keys()), expected);
  assert.equal(new Set(handlers.values()).size, expected.size);
  return handlers;
}

const parseIdentity = await runtimeParseIdentity();

describe('JavaScript and TypeScript SDK tool registrations', () => {
  let result: PipelineResult;
  const unresolved = [
    'inline_callback',
    'imported_callback',
    'parameter_callback',
    'mutable_callback',
    'reassigned_callback',
    'shadowed_callback',
    'alias_callback',
  ];

  before(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-mcp-tools'), () => {});
    },
    { timeout: 60_000 },
  );

  for (const extension of ['ts', 'js'])
    it(`does not emit tools for a destructured method replacement in ${extension}`, async () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-mcp-tool-write-'));
      try {
        fs.writeFileSync(
          path.join(repo, `server.${extension}`),
          `
        import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
        const replaced = new McpServer({ name: 'replaced', version: '1' });
        ({ registerTool: replaced.registerTool } = { registerTool: () => undefined });
        replaced.registerTool('fake', {}, () => ({ content: [] }));
        const actual = new McpServer({ name: 'actual', version: '1' });
        actual.registerTool('real', {}, () => ({ content: [] }));
      `,
        );
        const pipeline = await runPipelineFromRepo(repo, () => {}, { workerPoolSize: 1 });
        assert.deepEqual(getNodesByLabel(pipeline, 'Tool'), ['real']);
        assert.deepEqual(findDanglingEdges(pipeline, ['HANDLES_TOOL', 'ENTRY_POINT_OF']), []);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

  for (const extension of ['ts', 'js'])
    it(
      `preserves namespace registrations through cold/warm ${extension} parsing`,
      { timeout: 120_000 },
      async () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-mcp-namespace-'));
        const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-mcp-namespace-cache-'));
        try {
          fs.writeFileSync(
            path.join(repo, `server.${extension}`),
            `
        import * as SDK from '@modelcontextprotocol/sdk/server/mcp.js';
        const server = new SDK.McpServer({});
        function handleNamespace() { return { content: [] }; }
        server.registerTool('namespace', { description: 'Namespace tool' }, handleNamespace);
        const replaced = new SDK.McpServer({});
        ({ method: replaced.registerTool } = other);
        replaced.registerTool('fake', {}, handleNamespace);
        ${extension === 'ts' ? "function install(typed: SDK.McpServer) { typed.tool('typed_namespace', handleNamespace); }" : ''}
      `,
          );
          const cache: ParseCache = {
            identity: parseIdentity,
            entries: new Map(),
            usedKeys: new Set(),
            storagePath: storageDir,
            writeStoragePath: storageDir,
            onDiskKeys: new Set(),
          };
          const cold = await runPipelineFromRepo(repo, () => {}, {
            parseCache: cache,
            workerPoolSize: 1,
          });
          assert.equal(cold.usedWorkerPool, true);
          pruneCache(cache, cache.usedKeys);
          const keys = await saveParseCache(storageDir, cache);
          await pruneAndSaveDurableParsedFileStore(
            getDurableParsedFileDir(storageDir),
            parseIdentity.base,
            new Set(keys),
          );
          const warmCache = await loadParseCache(storageDir, parseIdentity, storageDir);
          assert.ok(warmCache);
          const warm = await runPipelineFromRepo(repo, () => {}, {
            parseCache: warmCache,
            workerPoolSize: 1,
          });
          assert.equal(warm.usedWorkerPool, false);
          for (const pipeline of [cold, warm]) {
            assert.deepEqual(
              getNodesByLabel(pipeline, 'Tool'),
              extension === 'ts' ? ['namespace', 'typed_namespace'] : ['namespace'],
            );
            assert.equal(
              getNodesByLabelFull(pipeline, 'Tool').find((tool) => tool.name === 'namespace')
                ?.properties.description,
              'Namespace tool',
            );
            assertSingleMatch(
              getRelationships(pipeline, 'HANDLES_TOOL').filter(
                (edge) => edge.target === 'namespace',
              ),
              { source: 'handleNamespace', sourceLabel: 'Function' },
            );
            assert.deepEqual(findDanglingEdges(pipeline, ['HANDLES_TOOL', 'ENTRY_POINT_OF']), []);
          }
          assert.deepEqual(getNodesByLabelFull(warm, 'Tool'), getNodesByLabelFull(cold, 'Tool'));
          assert.deepEqual(
            getRelationships(warm, 'HANDLES_TOOL'),
            getRelationships(cold, 'HANDLES_TOOL'),
          );
        } finally {
          fs.rmSync(repo, { recursive: true, force: true });
          fs.rmSync(storageDir, { recursive: true, force: true });
        }
      },
    );

  it('discovers ordinary server files alongside deduplicated object manifests', () => {
    assert.deepEqual(
      getNodesByLabel(result, 'Tool'),
      [
        ...unresolved,
        'first_block_callback',
        'second_block_callback',
        'search-files',
        'read_file',
        'function_expression_tool',
        'js_ping',
        'manifest_tool',
      ].sort(),
    );
    const tools = new Map(
      getNodesByLabelFull(result, 'Tool').map((tool) => [tool.name, tool.properties]),
    );
    assert.partialDeepStrictEqual(tools.get('search-files'), {
      filePath: 'src/server.ts',
      description: 'Search files',
    });
    assert.partialDeepStrictEqual(tools.get('read_file'), {
      filePath: 'src/server.ts',
      description: 'Read a file',
    });
    assert.partialDeepStrictEqual(tools.get('js_ping'), {
      filePath: 'src/server.js',
      description: 'Ping JavaScript',
    });
    assert.partialDeepStrictEqual(tools.get('manifest_tool'), {
      filePath: 'src/tools.ts',
      description: 'Existing object manifest',
    });
    assert.equal(tools.get('inline_callback')?.description, '');
  });

  it('uses actual emitted callable nodes for supported local handlers', () => {
    const edges = getRelationships(result, 'HANDLES_TOOL');
    for (const [tool, handler] of [
      ['search-files', 'searchFiles'],
      ['read_file', 'readFile'],
      ['first_block_callback', 'handler'],
      ['second_block_callback', 'handler'],
      ['function_expression_tool', 'expressionHandler'],
      ['js_ping', 'jsPing'],
    ]) {
      assertSingleMatch(
        edges.filter((edge) => edge.target === tool),
        { source: handler, sourceLabel: 'Function' },
      );
    }
    assert.deepEqual(findDanglingEdges(result, ['HANDLES_TOOL', 'ENTRY_POINT_OF']), []);
  });

  it('links each same-file named handler only to its own execution flow', () => {
    const edges = getRelationships(result, 'ENTRY_POINT_OF').filter(
      (edge) => edge.sourceLabel === 'Tool',
    );
    const blockHandlers = blockHandlerIds(result);
    for (const [tool, handler] of [
      ['search-files', 'searchFiles'],
      ['read_file', 'readFile'],
      ...[...blockHandlers.keys()].map((name) => [name, 'handler']),
    ]) {
      const flows = edges.filter((edge) => edge.source === tool);
      assert.equal(flows.length, 1);
      const process = result.graph.getNode(flows[0].rel.targetId)!;
      const entry = result.graph.getNode(process.properties.entryPointId as string)!;
      assert.equal(entry.properties.name, handler);
      if (blockHandlers.has(tool)) assert.equal(entry.id, blockHandlers.get(tool));
    }
  });

  it('keeps unresolved callbacks at file attribution without unrelated same-file flows', () => {
    const handles = getRelationships(result, 'HANDLES_TOOL');
    const flows = getRelationships(result, 'ENTRY_POINT_OF');
    assert.equal(
      getNodesByLabelFull(result, 'Process').some((process) => {
        const entry = result.graph.getNode(process.properties.entryPointId as string);
        return entry?.properties.name === 'unrelatedEntry';
      }),
      true,
    );
    for (const name of unresolved) {
      assertSingleMatch(
        handles.filter((edge) => edge.target === name),
        { sourceLabel: 'File', sourceFilePath: 'src/server.ts' },
      );
      assert.deepEqual(
        flows.filter((edge) => edge.sourceLabel === 'Tool' && edge.source === name),
        [],
      );
    }
  });

  it(
    'preserves tool metadata, handler identities, and flow attribution on warm replay',
    { timeout: 120_000 },
    async () => {
      const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-mcp-tools-cache-'));
      try {
        const cold: ParseCache = {
          identity: parseIdentity,
          entries: new Map(),
          usedKeys: new Set(),
          storagePath: storageDir,
          writeStoragePath: storageDir,
          onDiskKeys: new Set(),
        };
        const fixture = path.join(FIXTURES, 'typescript-mcp-tools');
        const initial = await runPipelineFromRepo(fixture, () => {}, {
          parseCache: cold,
          workerPoolSize: 1,
        });
        assert.equal(initial.usedWorkerPool, true);
        pruneCache(cold, cold.usedKeys);
        const savedKeys = await saveParseCache(storageDir, cold);
        await pruneAndSaveDurableParsedFileStore(
          getDurableParsedFileDir(storageDir),
          parseIdentity.base,
          new Set(savedKeys),
        );
        const warm = await loadParseCache(storageDir, parseIdentity, storageDir);
        assert.ok(warm);
        const replay = await runPipelineFromRepo(fixture, () => {}, {
          parseCache: warm,
          workerPoolSize: 1,
        });
        assert.equal(replay.usedWorkerPool, false);

        const project = (pipeline: PipelineResult) => ({
          tools: getNodesByLabelFull(pipeline, 'Tool'),
          edges: [
            ...getRelationships(pipeline, 'HANDLES_TOOL'),
            ...getRelationships(pipeline, 'ENTRY_POINT_OF').filter(
              (edge) => edge.sourceLabel === 'Tool',
            ),
          ]
            .map(({ rel, source }) => ({
              type: rel.type,
              source,
              sourceId: rel.sourceId,
              targetId: rel.targetId,
            }))
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        });
        const expected = project(initial);
        assert.equal(expected.tools.length, unresolved.length + 7);
        assert.deepEqual(project(replay), expected);
        for (const name of unresolved) {
          assert.deepEqual(
            expected.edges.filter((edge) => edge.type === 'ENTRY_POINT_OF' && edge.source === name),
            [],
          );
        }
      } finally {
        fs.rmSync(storageDir, { recursive: true, force: true });
      }
    },
  );
});
