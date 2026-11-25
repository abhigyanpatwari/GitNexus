/**
 * Tree lifetime in the HTTP source scan.
 *
 * node-tree-sitter frees a Tree's native memory only in a finalizer that Node
 * runs from a `setImmediate` after GC. The extractor must therefore (a) keep
 * no tree reachable once its own file is done, and (b) yield a macrotask every
 * `PARSES_PER_RELEASE` parses so those finalizers run. A large Kotlin/Android
 * monorepo otherwise held every tree of the family pass at once (gigabytes of
 * native memory) between two graph queries.
 */
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import v8 from 'node:v8';
import Parser from 'tree-sitter';
import { compareCodeUnits } from '../../../compare.mjs';
import {
  countingTurns,
  maxParsesPerTurn,
  recordParseTurns,
  turnProbe,
} from '../../../../../test/helpers/event-loop-turns.js';
import type { HttpLanguagePlugin } from '../../../../../src/core/group/extractors/http-patterns/types.js';
import type { CypherExecutor } from '../../../../../src/core/group/contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../../../../../src/core/group/types.js';
import {
  createTreeReleaser,
  PARSES_PER_RELEASE,
} from '../../../../../dist/core/tree-sitter/native-tree-release.js';

const parseModule = new URL('../../../../../dist/core/tree-sitter/safe-parse.js', import.meta.url);
const parseMock = mock.module(parseModule.href, {
  namedExports: recordParseTurns(
    await import('../../../../../dist/core/tree-sitter/safe-parse.js'),
  ),
});
after(() => parseMock.restore());

const { HttpRouteExtractor } =
  await import('../../../../../dist/core/group/extractors/http-route-extractor.js');
const { getPluginForFile } =
  await import('../../../../../dist/core/group/extractors/http-patterns/index.js');
const { TopicExtractor } =
  await import('../../../../../dist/core/group/extractors/topic-extractor.js');
const { ThriftExtractor } =
  await import('../../../../../dist/core/group/extractors/thrift-extractor.js');

const TreeClass = (Parser as unknown as { Tree: abstract new (...args: never[]) => unknown }).Tree;
/** Reachable Tree wrappers; `queryObjects` runs a full GC first. */
const liveTrees = (): number => v8.queryObjects(TreeClass, { format: 'count' });

/** The Kotlin grammar is optional; the Kotlin cases run only where it is built. */
const KOTLIN = getPluginForFile('x.kt') !== undefined;

const PLUGIN_SAMPLE_FILES = ['x.java', 'x.kt', 'x.ts', 'x.tsx', 'x.js', 'x.go', 'x.py', 'x.php'];

/** Every distinct registered plugin, so each one's scan can be observed. */
function registeredPlugins(): HttpLanguagePlugin[] {
  const plugins = PLUGIN_SAMPLE_FILES.map((f) => getPluginForFile(f)).filter(
    (p): p is HttpLanguagePlugin => p !== undefined,
  );
  return [...new Set(plugins)];
}

function write(root: string, rel: string, text: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

const makeRepo = (repoPath: string): RepoHandle => ({
  id: 'tree-lifetime',
  path: 'test/tree-lifetime',
  repoPath,
  storagePath: path.join(repoPath, '.gitnexus'),
});

/** Every plugin, interface-inherited Spring routes, a constant-folded route. */
function writeMixedFixture(root: string): void {
  for (let i = 0; i < 6; i++) {
    write(
      root,
      `legacy/src/main/java/com/example/api/Thing${i}Api.java`,
      `package com.example.api;

import org.springframework.web.bind.annotation.*;

@RequestMapping("/api/things${i}")
public interface Thing${i}Api {
  @GetMapping("/{id}")
  String get(@PathVariable("id") Long id);
}
`,
    );
    write(
      root,
      `legacy/src/main/java/com/example/api/Thing${i}Controller.java`,
      `package com.example.api;

import org.springframework.web.bind.annotation.*;

@RestController
public class Thing${i}Controller implements Thing${i}Api {
  @Override
  public String get(Long id) { return "t" + id; }

  @PostMapping("/api/direct${i}")
  public String post(@RequestBody String body) { return body; }
}
`,
    );
    write(
      root,
      `app/src/main/kotlin/com/example/pay/Pay${i}Api.kt`,
      `package com.example.pay

import org.springframework.web.bind.annotation.*

@RequestMapping("/api/payments${i}")
interface Pay${i}Api {
    @GetMapping("/{id}")
    fun getPayment(@PathVariable id: Long): String
}
`,
    );
    write(
      root,
      `app/src/main/kotlin/com/example/pay/Pay${i}Controller.kt`,
      `package com.example.pay

import org.springframework.web.bind.annotation.RestController

@RestController
class Pay${i}Controller : Pay${i}Api {
    override fun getPayment(id: Long): String = "p$id"
}
`,
    );
  }
  write(
    root,
    'legacy/src/main/java/com/example/client/OrderClient.java',
    `package com.example.client;

import org.springframework.web.client.RestTemplate;

public class OrderClient {
  private final RestTemplate restTemplate = new RestTemplate();

  public String fetchThing() {
    return restTemplate.getForObject("/api/things1/7", String.class);
  }
}
`,
  );
  // Opens the Java and Python `prepareRepo` parse passes (a constants class and
  // an `include_router` call), so trees those passes keep would show up here.
  // Neither file yields a contract.
  write(
    root,
    'legacy/src/main/java/com/example/api/ApiRoutes.java',
    `package com.example.api;

public final class ApiRoutes {
  public static final String BASE = "/api/base";
}
`,
  );
  write(
    root,
    'py/app/main.py',
    `from fastapi import FastAPI
from app.empty import router

app = FastAPI()
app.include_router(router, prefix="/v1")
`,
  );
  write(
    root,
    'py/app/empty.py',
    `from fastapi import APIRouter

router = APIRouter()
`,
  );
  write(
    root,
    'app/src/main/kotlin/com/example/pay/ApiPaths.kt',
    `package com.example.pay

object ApiPaths {
    const val REPORTS = "/api/reports"
}
`,
  );
  write(
    root,
    'app/src/main/kotlin/com/example/pay/AccountController.kt',
    `package com.example.pay

import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("/api/accounts")
class AccountController {
    @GetMapping(ApiPaths.REPORTS)
    fun reports(): String = "r"
}
`,
  );
  write(
    root,
    'web/src/server.ts',
    `import express from 'express';
import { health } from './handlers';

const router = express.Router();
router.get('/api/health', health);
router.post('/api/events', (_req, res) => res.send('ok'));

export default router;
`,
  );
  write(
    root,
    'web/src/handlers.ts',
    `export function health(_req: unknown, res: { send: (x: string) => void }) {
  res.send('ok');
}
`,
  );
  write(
    root,
    'web/src/client.ts',
    `import axios from 'axios';

export async function loadThing(id: number) {
  const res = await fetch('/api/things2/' + id);
  return res.json();
}

export async function loadPayment() {
  return axios.get('/api/payments3/5');
}
`,
  );
  for (let i = 0; i < 4; i++) {
    write(root, `web/src/util${i}.ts`, `export const helper${i} = (x: number) => x + ${i};\n`);
  }
  write(
    root,
    'web/src/view.tsx',
    `export function View() {
  fetch('/api/accounts/api/reports');
  return <div />;
}
`,
  );
  for (let i = 0; i < 3; i++) {
    write(
      root,
      `py/app/routes${i}.py`,
      `from fastapi import FastAPI

app = FastAPI()


@app.get("/py/items${i}")
def items${i}():
    return []
`,
    );
    write(
      root,
      `go/cmd/server${i}.go`,
      `package main

import "net/http"

func handler${i}(w http.ResponseWriter, r *http.Request) {}

func main() {
  http.HandleFunc("/go/items${i}", handler${i})
}
`,
    );
  }
  for (let i = 0; i < 2; i++) {
    write(
      root,
      `php/routes/web${i}.php`,
      String.raw`<?php
use Illuminate\Support\Facades\Route;

Route::get('/php/items${i}', function () { return []; });
`,
    );
  }
}

/** Files per family: enough that one unbroken turn would exceed the bound. */
const BULK = 3 * PARSES_PER_RELEASE;
/** Java, TS and Go, and Kotlin where its grammar is built. */
const BULK_FAMILIES = KOTLIN ? 4 : 3;
/** In the platform's spelling, as the file scan lists it. */
const BULK_JAVA_CONTROLLER = path.join(
  'legacy',
  'src',
  'main',
  'java',
  'com',
  'example',
  'bulk',
  'Ctl0.java',
);

/**
 * Many files per plugin and nothing that triggers a `prepareRepo` parse (no
 * Java or Kotlin constant declarations, no axios), so every parse comes from
 * the scan passes themselves.
 */
function writeBulkFixture(root: string): void {
  for (let i = 0; i < BULK; i++) {
    write(
      root,
      `legacy/src/main/java/com/example/bulk/Ctl${i}.java`,
      `package com.example.bulk;

import org.springframework.web.bind.annotation.*;

@RestController
public class Ctl${i} {
  @GetMapping("/java/${i}")
  public String get() { return "j"; }
}
`,
    );
    write(
      root,
      `app/src/main/kotlin/com/example/bulk/Ctl${i}.kt`,
      `package com.example.bulk

import org.springframework.web.bind.annotation.*

@RestController
class Ctl${i} {
    @GetMapping("/kt/${i}")
    fun get(): String = "k"
}
`,
    );
    write(root, `web/src/client${i}.ts`, `export const load${i} = () => fetch('/ts/${i}');\n`);
    write(
      root,
      `go/cmd/server${i}.go`,
      `package main

import "net/http"

func handler${i}(w http.ResponseWriter, r *http.Request) {}

func register${i}() {
  http.HandleFunc("/go/${i}", handler${i})
}
`,
    );
  }
}

/** HANDLES_ROUTE rows without `handlerSymbolId` send the graph pass to the source scan. */
function unresolvedRouteDb(filePath: string, routePath: string): CypherExecutor {
  return async (query) => {
    if (!query.includes("type: 'HANDLES_ROUTE'")) return [];
    return [
      {
        fileId: `file:${filePath}`,
        filePath,
        routePath,
        routeId: `route:${routePath}`,
        routeMethod: 'GET',
        handlerSymbolId: '',
        responseKeys: null,
        routeSource: 'decorator-GetMapping',
      },
    ];
  };
}

/** Contracts in a compact, order-independent form for parity checks. */
function contractKeys(contracts: ExtractedContract[]): string[] {
  return contracts
    .map((c) => `${c.role} ${c.contractId} ${c.symbolRef.filePath} ${c.symbolName} ${c.confidence}`)
    .sort(compareCodeUnits);
}

/**
 * Contracts of the mixed fixture without a graph, captured before the scan
 * stopped holding trees. Interface-inherited Spring routes (Java and Kotlin)
 * and the constant-folded Kotlin route come from the project scan.
 */
const MIXED_CONTRACTS = [
  'consumer http::GET::/api/accounts/api/reports web/src/view.tsx fetch 0.7',
  'consumer http::GET::/api/payments3/{param} web/src/client.ts fetch 0.7',
  'consumer http::GET::/api/things1/{param} legacy/src/main/java/com/example/client/OrderClient.java fetch 0.7',
  'provider http::*::/go/items0 go/cmd/server0.go handler0 0.8',
  'provider http::*::/go/items1 go/cmd/server1.go handler1 0.8',
  'provider http::*::/go/items2 go/cmd/server2.go handler2 0.8',
  'provider http::GET::/api/accounts/api/reports app/src/main/kotlin/com/example/pay/AccountController.kt reports 0.8',
  'provider http::GET::/api/health web/src/server.ts health 0.8',
  'provider http::GET::/api/payments0/{param} app/src/main/kotlin/com/example/pay/Pay0Controller.kt getPayment 0.8',
  'provider http::GET::/api/payments1/{param} app/src/main/kotlin/com/example/pay/Pay1Controller.kt getPayment 0.8',
  'provider http::GET::/api/payments2/{param} app/src/main/kotlin/com/example/pay/Pay2Controller.kt getPayment 0.8',
  'provider http::GET::/api/payments3/{param} app/src/main/kotlin/com/example/pay/Pay3Controller.kt getPayment 0.8',
  'provider http::GET::/api/payments4/{param} app/src/main/kotlin/com/example/pay/Pay4Controller.kt getPayment 0.8',
  'provider http::GET::/api/payments5/{param} app/src/main/kotlin/com/example/pay/Pay5Controller.kt getPayment 0.8',
  'provider http::GET::/api/things0/{param} legacy/src/main/java/com/example/api/Thing0Controller.java get 0.8',
  'provider http::GET::/api/things1/{param} legacy/src/main/java/com/example/api/Thing1Controller.java get 0.8',
  'provider http::GET::/api/things2/{param} legacy/src/main/java/com/example/api/Thing2Controller.java get 0.8',
  'provider http::GET::/api/things3/{param} legacy/src/main/java/com/example/api/Thing3Controller.java get 0.8',
  'provider http::GET::/api/things4/{param} legacy/src/main/java/com/example/api/Thing4Controller.java get 0.8',
  'provider http::GET::/api/things5/{param} legacy/src/main/java/com/example/api/Thing5Controller.java get 0.8',
  'provider http::GET::/php/items0 php/routes/web0.php handler 0.8',
  'provider http::GET::/php/items1 php/routes/web1.php handler 0.8',
  'provider http::GET::/py/items0 py/app/routes0.py handler 0.8',
  'provider http::GET::/py/items1 py/app/routes1.py handler 0.8',
  'provider http::GET::/py/items2 py/app/routes2.py handler 0.8',
  'provider http::POST::/api/direct0 legacy/src/main/java/com/example/api/Thing0Controller.java post 0.8',
  'provider http::POST::/api/direct1 legacy/src/main/java/com/example/api/Thing1Controller.java post 0.8',
  'provider http::POST::/api/direct2 legacy/src/main/java/com/example/api/Thing2Controller.java post 0.8',
  'provider http::POST::/api/direct3 legacy/src/main/java/com/example/api/Thing3Controller.java post 0.8',
  'provider http::POST::/api/direct4 legacy/src/main/java/com/example/api/Thing4Controller.java post 0.8',
  'provider http::POST::/api/direct5 legacy/src/main/java/com/example/api/Thing5Controller.java post 0.8',
  'provider http::POST::/api/events web/src/server.ts handler 0.8',
].filter((key) => KOTLIN || !/\.kt /.test(key));

/** With a graph route lacking a handler id, that provider keeps the graph's file-level symbol. */
const MIXED_CONTRACTS_WITH_GRAPH_ROUTE = MIXED_CONTRACTS.map((key) =>
  key.startsWith('provider http::GET::/api/accounts/api/reports ')
    ? 'provider http::GET::/api/accounts/api/reports app/src/main/kotlin/com/example/pay/AccountController.kt AccountController.kt 0.9'
    : key,
).sort(compareCodeUnits);

/** `prepareRepo` inputs whose content gates admit every file to the parse pass. */
const PREPARE_PASS_FILES: Array<[string, (i: number) => [string, string]]> = [
  [
    'x.java',
    (i) => [
      `src/C${i}.java`,
      `public class C${i} {\n  public static final String P = "/java/${i}";\n}\n`,
    ],
  ],
  ...(KOTLIN
    ? [
        [
          'x.kt',
          (i: number) => [`src/C${i}.kt`, `object C${i} {\n    const val P = "/kt/${i}"\n}\n`],
        ] as [string, (i: number) => [string, string]],
      ]
    : []),
  [
    'x.py',
    (i) => [
      `app/m${i}.py`,
      `from fastapi import APIRouter\nrouter = APIRouter()\napp.include_router(router, prefix="/py/${i}")\n`,
    ],
  ],
  [
    'x.ts',
    (i) => [`web/c${i}.ts`, `import axios from 'axios';\nexport const c${i} = axios.create();\n`],
  ],
];

describe('HTTP source scan tree lifetime', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-http-tree-lifetime-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    'keeps at most the tree of the file being scanned reachable',
    { timeout: 120_000 },
    async () => {
      writeMixedFixture(tmpDir);
      // The tree-sitter binding itself keeps one recently parsed tree reachable,
      // whoever else holds it. A warm-up parse puts that tree into the baseline.
      const warmUp = new Parser();
      warmUp.setLanguage(registeredPlugins()[0].language);
      warmUp.parse('class WarmUp {}');
      const baseline = liveTrees();
      // Every sample forces a full GC, which is slow in a test worker's large
      // heap, so only the first, every SAMPLE_EVERY-th and the last scan or
      // collect call samples. A leak grows with the files scanned, and one
      // held by a pre-pass stays for the whole scan, so the stride still sees it.
      const SAMPLE_EVERY = 8;
      let calls = 0;
      let lastCall = 0;
      let maxLive = 0;
      let samples = 0;
      const sample = (): void => {
        calls += 1;
        if (lastCall === 0) return;
        if (calls !== 1 && calls % SAMPLE_EVERY !== 0 && calls !== lastCall) return;
        samples += 1;
        maxLive = Math.max(maxLive, liveTrees() - baseline);
      };
      // Plain wrappers, rather than a call-recording spy: a spy records its arguments, and those
      // arguments are the very trees this test must see released.
      const restores: Array<() => void> = [];
      const projectScans = new Set<NonNullable<HttpLanguagePlugin['projectScan']>>();
      for (const plugin of registeredPlugins()) {
        const scan = plugin.scan;
        plugin.scan = (...args) => {
          sample();
          return scan.apply(plugin, args);
        };
        restores.push(() => {
          plugin.scan = scan;
        });
        if (plugin.projectScan) projectScans.add(plugin.projectScan);
      }
      for (const projectScan of projectScans) {
        const collect = projectScan.collect;
        projectScan.collect = (...args) => {
          sample();
          return collect.apply(projectScan, args);
        };
        restores.push(() => {
          projectScan.collect = collect;
        });
      }

      let contracts: ExtractedContract[];
      try {
        // A first run only counts the calls, so that the second can sample its last.
        await new HttpRouteExtractor().extract(null, tmpDir, makeRepo(tmpDir));
        lastCall = calls;
        calls = 0;
        contracts = await new HttpRouteExtractor().extract(null, tmpDir, makeRepo(tmpDir));
      } finally {
        for (const restore of restores) restore();
      }

      assert.ok(contracts.length > 0);
      assert.equal(calls, lastCall);
      assert.ok(lastCall > 40);
      assert.ok(samples > lastCall / SAMPLE_EVERY);
      assert.ok(maxLive <= 1);
    },
  );

  for (const [label, makeDb] of [
    ['without a graph', () => null],
    [
      'with graph routes that need the source scan',
      () => unresolvedRouteDb(BULK_JAVA_CONTROLLER, '/java/0'),
    ],
  ] as const) {
    it(`yields to the event loop between parse batches ${label}`, async () => {
      writeBulkFixture(tmpDir);

      const contracts = await countingTurns(() =>
        new HttpRouteExtractor().extract(makeDb(), tmpDir, makeRepo(tmpDir)),
      );

      assert.ok(contracts.length > 0);
      // Every bulk file is parsed exactly once.
      assert.equal(turnProbe.parseTurns.length, BULK_FAMILIES * BULK);
      assert.ok(maxParsesPerTurn() <= PARSES_PER_RELEASE);
    });
  }

  it('parses a graph file at most once more when the graph spells its path the other way', async () => {
    // On Windows a graph path in POSIX spelling misses the scanned file's
    // cached detections and parses that file once more; it must stay one parse.
    writeBulkFixture(tmpDir);
    const other = path.sep === '/' ? '\\' : '/';

    const contracts = await countingTurns(() =>
      new HttpRouteExtractor().extract(
        unresolvedRouteDb(BULK_JAVA_CONTROLLER.split(path.sep).join(other), '/java/0'),
        tmpDir,
        makeRepo(tmpDir),
      ),
    );

    assert.ok(contracts.length > 0);
    assert.ok(turnProbe.parseTurns.length >= BULK_FAMILIES * BULK);
    assert.ok(turnProbe.parseTurns.length <= BULK_FAMILIES * BULK + 1);
    assert.ok(maxParsesPerTurn() <= PARSES_PER_RELEASE);
  });

  it('counts the prepareRepo parses and the scan parses together', async () => {
    // Fewer constant files than one batch, and as many controllers: each pass
    // alone stays under the bound, the two together in one turn would not.
    const half = PARSES_PER_RELEASE - 1;
    for (let i = 0; i < half; i++) {
      write(
        tmpDir,
        `src/main/java/com/example/C${i}.java`,
        `package com.example;\n\npublic class C${i} {\n  public static final String P = "/c${i}";\n}\n`,
      );
      write(
        tmpDir,
        `src/main/java/com/example/Ctl${i}.java`,
        `package com.example;\n\nimport org.springframework.web.bind.annotation.*;\n\n@RestController\npublic class Ctl${i} {\n  @GetMapping("/ctl${i}")\n  public String get() { return "j"; }\n}\n`,
      );
    }

    const contracts = await countingTurns(() =>
      new HttpRouteExtractor().extract(null, tmpDir, makeRepo(tmpDir)),
    );

    assert.equal(contracts.length, half);
    // The constant files are parsed by `prepareRepo` and again by the scan.
    assert.equal(turnProbe.parseTurns.length, 3 * half);
    assert.ok(maxParsesPerTurn() <= PARSES_PER_RELEASE);
  });

  it('counts failed parses toward the yield', async () => {
    writeBulkFixture(tmpDir);

    const contracts = await countingTurns(() => {
      turnProbe.failParse = (source) => source.includes('class Ctl');
      return new HttpRouteExtractor().extract(null, tmpDir, makeRepo(tmpDir));
    });

    // The Java and Kotlin parses fail; the TS and Go files still give contracts.
    assert.ok(contracts.length > 0);
    assert.equal(turnProbe.parseTurns.length, BULK_FAMILIES * BULK);
    assert.ok(maxParsesPerTurn() <= PARSES_PER_RELEASE);
  });

  for (const [sample, makeFile] of PREPARE_PASS_FILES) {
    it(`yields to the event loop between parse batches in the ${sample} prepareRepo pass`, async () => {
      const plugin = getPluginForFile(sample);
      if (!plugin?.prepareRepo) throw new Error(`expected a prepareRepo pass for ${sample}`);
      const files = new Map(Array.from({ length: BULK }, (_, i) => makeFile(i)));

      await countingTurns(() =>
        Promise.resolve(
          plugin.prepareRepo?.({
            repoPath: tmpDir,
            files: [...files.keys()],
            parser: new Parser(),
            readFile: (rel) => files.get(rel) ?? null,
            parseSource: (parser, src) => {
              turnProbe.parseTurns.push(turnProbe.turn);
              return parser.parse(src);
            },
          }),
        ),
      );

      assert.equal(turnProbe.parseTurns.length, BULK);
      assert.ok(maxParsesPerTurn() <= PARSES_PER_RELEASE);
    });
    it(`awaits the releaser it is given once per parse in the ${sample} prepareRepo pass`, async () => {
      const plugin = getPluginForFile(sample);
      if (!plugin?.prepareRepo) throw new Error(`expected a prepareRepo pass for ${sample}`);
      const files = new Map(Array.from({ length: BULK }, (_, i) => makeFile(i)));
      // The orchestrator's releaser, counted; every third parse fails.
      const release = createTreeReleaser();
      let released = 0;
      let parses = 0;

      await plugin.prepareRepo({
        repoPath: tmpDir,
        files: [...files.keys()],
        parser: new Parser(),
        readFile: (rel) => files.get(rel) ?? null,
        parseSource: (parser, src) => {
          parses += 1;
          return parses % 3 === 0 ? null : parser.parse(src);
        },
        releaseTrees: async () => {
          released += 1;
          await release();
        },
      });

      assert.equal(parses, BULK);
      assert.equal(released, parses);
    });
  }

  it('rejects project-scan facts that hold a syntax node', async (t) => {
    writeMixedFixture(tmpDir);
    const plugin = getPluginForFile('x.java');
    const projectScan = plugin?.projectScan;
    if (!projectScan) throw new Error('expected the Java project scan');
    t.mock.method(projectScan, 'collect', ({ tree }) => [{ node: tree.rootNode } as never]);

    const failure = await new HttpRouteExtractor().extract(null, tmpDir, makeRepo(tmpDir)).then(
      () => null,
      (err: unknown) => err,
    );
    // The error names the plugin and the file, and keeps the clone error.
    assert.ok(failure instanceof Error);
    assert.match(
      failure.message,
      new RegExp(String.raw`^HTTP plugin ${plugin?.name} failed on \S+\.java: `),
    );
    assert.equal((failure.cause as Error).name, 'DataCloneError');
  });

  const retainedSources = // A long literal per file, which V8 slices from the file's source, and
    // padding around it; files the `prepareRepo` pass parses.
    [
      [
        'x.java',
        (i, pad) => [
          `src/C${i}.java`,
          `// ${pad}\npublic class C${i} {\n  public static final String P = "/api/customer/preferences/v${i}/items";\n}\n`,
        ],
      ],
      [
        'x.kt',
        (i, pad) => [
          `src/C${i}.kt`,
          `// ${pad}\nobject C${i} {\n    const val P = "/api/customer/preferences/v${i}/items"\n}\n`,
        ],
      ],
      [
        'x.py',
        (i, pad) => [
          `app/main${i}.py`,
          `# ${pad}\nfrom fastapi import FastAPI\nfrom app.customer_preferences${i} import router as preferences_router${i}\napp = FastAPI()\napp.include_router(preferences_router${i}, prefix="/api/customer/preferences/v${i}/items")\n`,
        ],
      ],
      [
        'x.ts',
        (i, pad) => [
          `web/c${i}.ts`,
          `// ${pad}\nimport axios from 'axios';\nexport const customerPreferencesBase${i} = '/api/customer/preferences/v${i}/items';\nexport const customerPreferencesClient${i} = axios.create({ baseURL: customerPreferencesBase${i} });\n`,
        ],
      ],
    ] as Array<[string, (i: number, pad: string) => [string, string]]>;
  for (const [sample, makeFile] of retainedSources) {
    if (sample === 'x.kt' && !KOTLIN) continue;
    it(`keeps no file source alive through the ${sample} prepareRepo context`, async () => {
      const FILES = 32;
      // Below the JS/TS pass's 512 KB file cap.
      const LARGE_PAD = 448 * 1024;
      const plugin = getPluginForFile(sample);
      if (!plugin?.prepareRepo) throw new Error(`expected a prepareRepo pass for ${sample}`);
      const heapWithContext = async (padChars: number): Promise<number> => {
        const root = fs.mkdtempSync(path.join(tmpDir, 'pad-'));
        for (let i = 0; i < FILES; i++) write(root, ...makeFile(i, 'x'.repeat(padChars)));
        // Read once the pass has returned, while the orchestrator holds its
        // context; `liveTrees` runs a full GC.
        let withContext = 0;
        const prepareRepo = plugin.prepareRepo;
        plugin.prepareRepo = async (...args) => {
          const context = await prepareRepo?.apply(plugin, args);
          liveTrees();
          withContext = process.memoryUsage().heapUsed;
          return context;
        };
        try {
          liveTrees();
          const before = process.memoryUsage().heapUsed;
          await new HttpRouteExtractor().extract(null, root, makeRepo(root));
          assert.ok(withContext > 0);
          return withContext - before;
        } finally {
          plugin.prepareRepo = prepareRepo;
        }
      };

      const small = await heapWithContext(1024);
      const large = await heapWithContext(LARGE_PAD);
      // The large run reads 14 MB more source; the context must keep none of it.
      assert.ok(large - small < (FILES * LARGE_PAD) / 4);
    });
  }
  it('names the plugins of a project scan whose resolve throws', async (t) => {
    writeMixedFixture(tmpDir);
    const plugin = getPluginForFile('x.java');
    const projectScan = plugin?.projectScan;
    if (!projectScan) throw new Error('expected the Java project scan');
    const cause = new Error('resolve failed (test)');
    t.mock.method(projectScan, 'resolve', () => {
      throw cause;
    });

    const failure = await new HttpRouteExtractor().extract(null, tmpDir, makeRepo(tmpDir)).then(
      () => null,
      (err: unknown) => err,
    );
    assert.ok(failure instanceof Error);
    assert.equal(
      failure.message,
      `HTTP project scan of ${plugin?.name} failed: resolve failed (test)`,
    );
    assert.equal(failure.cause, cause);
  });

  it('emits the same contracts without a graph', async () => {
    writeMixedFixture(tmpDir);
    const contracts = await new HttpRouteExtractor().extract(null, tmpDir, makeRepo(tmpDir));
    assert.deepEqual(contractKeys(contracts), MIXED_CONTRACTS);
  });

  if (KOTLIN) {
    it('emits the same contracts when graph routes need the source scan', async () => {
      writeMixedFixture(tmpDir);
      const db = unresolvedRouteDb(
        'app/src/main/kotlin/com/example/pay/AccountController.kt',
        '/api/accounts/api/reports',
      );
      const contracts = await new HttpRouteExtractor().extract(db, tmpDir, makeRepo(tmpDir));
      assert.deepEqual(contractKeys(contracts), MIXED_CONTRACTS_WITH_GRAPH_ROUTE);
    });
  }
});

describe('sibling extractors release Java trees as they parse', () => {
  for (const [name, make] of [
    ['topic', () => new TopicExtractor()],
    ['Thrift', () => new ThriftExtractor()],
  ] as const) {
    it(`the ${name} extractor yields between parse batches`, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sibling-tree-release-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const files = 3 * PARSES_PER_RELEASE;
      for (let i = 0; i < files; i++) write(root, `src/C${i}.java`, `class C${i} {}\n`);
      await countingTurns(() => make().extract(null, root, makeRepo(root)));
      assert.equal(turnProbe.parseTurns.length, files);
      assert.ok(maxParsesPerTurn() <= PARSES_PER_RELEASE);
    });
  }
});
