import { runInSequence } from '../../../../test/helpers/run-in-sequence.mjs';
import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HttpRouteExtractor } from '../../../../dist/core/group/extractors/http-route-extractor.js';
import { ThriftExtractor } from '../../../../dist/core/group/extractors/thrift-extractor.js';
import { writeFixtureRepo } from '../spring-support.mjs';

async function measureSafeParses(operation) {
  // V8 exposes real function entries, so this catches a direct parser.parse
  // bypass on Linux as well as a Windows native crash on a large Java input.
  const session = new Session();
  session.connect();
  try {
    await session.post('Profiler.enable');
    await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
    await operation();
    const { result } = await session.post('Profiler.takePreciseCoverage');
    const safeParse = result.find((script) =>
      script.url.endsWith('/core/tree-sitter/safe-parse.js'),
    );
    return (
      safeParse?.functions.find((fn) => fn.functionName === 'parseSourceSafe')?.ranges[0].count ?? 0
    );
  } finally {
    session.disconnect();
  }
}

export async function verifyLargeJavaInputsUseSafeParsing() {
  const padding = Array.from(
    { length: 600 },
    (_, i) =>
      '    public String helper' + i + '() { return "padding-' + i + '-aaaaaaaaaaaaaaaaaaa"; }\n',
  ).join('');
  await runInSequence(
    [
      {
        Extractor: HttpRouteExtractor,
        name: 'BigController',
        header: '@RestController\npublic class BigController {',
        files: {},
      },
      {
        Extractor: ThriftExtractor,
        name: 'BigClient',
        header:
          'import billing.v1.OrderService;\npublic class BigClient {\n  private OrderService.Iface client;',
        files: {
          'idl/order.thrift':
            'namespace java billing.v1\nservice OrderService {\n  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)\n}',
        },
      },
    ],
    async ({ Extractor, name, header, files }) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'java-large-extractor-'));
      try {
        const source = 'package com.example;\n' + header + '\n' + padding + '}\n';
        assert.ok(source.length > 40_000);
        writeFixtureRepo(root, { ...files, ['src/' + name + '.java']: source });
        const calls = await measureSafeParses(() =>
          new Extractor().extract(null, root, {
            id: 'large-input',
            path: name,
            repoPath: root,
            storagePath: path.join(root, '.gitnexus'),
          }),
        );
        assert.ok(calls > 0, Extractor.name + ' must call parseSourceSafe for a large source');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
