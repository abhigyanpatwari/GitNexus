import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { createSymbolTable } from '../../src/core/ingestion/model/index.js';
import { processParsingSequential } from '../../src/core/ingestion/parsing-processor.js';

describe('Go multi-name declaration metadata in sequential parsing', () => {
  it('enriches every const and var name when workers are skipped', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-multi-name-seq-'));
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/multi\n\ngo 1.22\n');
    fs.writeFileSync(
      path.join(dir, 'main.go'),
      [
        'package main',
        '',
        'const X, Y int = 1, 2',
        '',
        'var (',
        '  a, b string',
        '  c bool',
        ')',
        '',
        'func main() {}',
        '',
      ].join('\n'),
    );

    const graph = createKnowledgeGraph();
    const symbolTable = createSymbolTable();
    const astCache = createASTCache();
    const scopeTreeCache = createASTCache();
    await processParsingSequential(
      graph,
      [
        {
          path: path.join(dir, 'main.go'),
          content: fs.readFileSync(path.join(dir, 'main.go'), 'utf8'),
        },
      ],
      symbolTable,
      astCache,
      scopeTreeCache,
    );

    const metadata = new Map<string, string | undefined>();
    graph.forEachNode((node) => {
      if (node.label === 'Const' || node.label === 'Variable') {
        metadata.set(node.properties.name, node.properties.declaredType as string | undefined);
      }
    });

    expect(metadata.get('X')).toBe('int');
    expect(metadata.get('Y')).toBe('int');
    expect(metadata.get('a')).toBe('string');
    expect(metadata.get('b')).toBe('string');
    expect(metadata.get('c')).toBe('bool');
  });
});
