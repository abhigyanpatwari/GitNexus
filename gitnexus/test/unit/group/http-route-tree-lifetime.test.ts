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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import v8 from 'node:v8';
import Parser from 'tree-sitter';

// Pass-through spy that records the event-loop turn of every parse. The
// orchestrator also hands this function to the plugins' `prepareRepo`.
vi.mock('../../../src/core/tree-sitter/safe-parse.js', async (importOriginal) => {
  const { recordParseTurns } = await import('../../helpers/event-loop-turns.js');
  return recordParseTurns(
    await importOriginal<typeof import('../../../src/core/tree-sitter/safe-parse.js')>(),
  );
});

import { HttpRouteExtractor } from '../../../src/core/group/extractors/http-route-extractor.js';
import { getPluginForFile } from '../../../src/core/group/extractors/http-patterns/index.js';
import type { HttpLanguagePlugin } from '../../../src/core/group/extractors/http-patterns/types.js';
import { PARSES_PER_RELEASE } from '../../../src/core/tree-sitter/native-tree-release.js';
import { countingTurns, maxParsesPerTurn, turnProbe } from '../../helpers/event-loop-turns.js';
import type { CypherExecutor } from '../../../src/core/group/contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../../../src/core/group/types.js';

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
      `<?php
use Illuminate\\Support\\Facades\\Route;

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
    .sort();
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
).sort();

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
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps at most the tree of the file being scanned reachable', async () => {
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
    // Plain wrappers, not `vi.spyOn`: a spy records its arguments, and those
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

    expect(contracts.length).toBeGreaterThan(0);
    expect(calls).toBe(lastCall);
    expect(lastCall).toBeGreaterThan(40);
    expect(samples).toBeGreaterThan(lastCall / SAMPLE_EVERY);
    expect(maxLive).toBeLessThanOrEqual(1);
    // A backstop: the samples take a few seconds.
  }, 120_000);

  it.each([
    ['without a graph', () => null],
    [
      'with graph routes that need the source scan',
      () => unresolvedRouteDb(BULK_JAVA_CONTROLLER, '/java/0'),
    ],
  ])('yields to the event loop between parse batches %s', async (_label, makeDb) => {
    writeBulkFixture(tmpDir);

    const contracts = await countingTurns(() =>
      new HttpRouteExtractor().extract(makeDb(), tmpDir, makeRepo(tmpDir)),
    );

    expect(contracts.length).toBeGreaterThan(0);
    // Every bulk file is parsed exactly once.
    expect(turnProbe.parseTurns.length).toBe(BULK_FAMILIES * BULK);
    expect(maxParsesPerTurn()).toBeLessThanOrEqual(PARSES_PER_RELEASE);
  });

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

    expect(contracts.length).toBeGreaterThan(0);
    expect(turnProbe.parseTurns.length).toBeGreaterThanOrEqual(BULK_FAMILIES * BULK);
    expect(turnProbe.parseTurns.length).toBeLessThanOrEqual(BULK_FAMILIES * BULK + 1);
    expect(maxParsesPerTurn()).toBeLessThanOrEqual(PARSES_PER_RELEASE);
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

    expect(contracts.length).toBe(half);
    // The constant files are parsed by `prepareRepo` and again by the scan.
    expect(turnProbe.parseTurns.length).toBe(3 * half);
    expect(maxParsesPerTurn()).toBeLessThanOrEqual(PARSES_PER_RELEASE);
  });

  it('counts failed parses toward the yield', async () => {
    writeBulkFixture(tmpDir);

    const contracts = await countingTurns(() => {
      turnProbe.failParse = (source) => source.includes('class Ctl');
      return new HttpRouteExtractor().extract(null, tmpDir, makeRepo(tmpDir));
    });

    // The Java and Kotlin parses fail; the TS and Go files still give contracts.
    expect(contracts.length).toBeGreaterThan(0);
    expect(turnProbe.parseTurns.length).toBe(BULK_FAMILIES * BULK);
    expect(maxParsesPerTurn()).toBeLessThanOrEqual(PARSES_PER_RELEASE);
  });

  it.each(PREPARE_PASS_FILES)(
    'yields to the event loop between parse batches in the %s prepareRepo pass',
    async (sample, makeFile) => {
      const plugin = getPluginForFile(sample);
      if (!plugin?.prepareRepo) throw new Error(`expected a prepareRepo pass for ${sample}`);
      const files = new Map(Array.from({ length: BULK }, (_, i) => makeFile(i)));

      await countingTurns(async () =>
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
      );

      expect(turnProbe.parseTurns.length).toBe(BULK);
      expect(maxParsesPerTurn()).toBeLessThanOrEqual(PARSES_PER_RELEASE);
    },
  );

  it('rejects project-scan facts that hold a syntax node', async () => {
    writeMixedFixture(tmpDir);
    const plugin = getPluginForFile('x.java');
    const projectScan = plugin?.projectScan;
    if (!projectScan) throw new Error('expected the Java project scan');
    vi.spyOn(projectScan, 'collect').mockImplementation(({ tree }) => [
      { node: tree.rootNode } as never,
    ]);

    const failure = await new HttpRouteExtractor().extract(null, tmpDir, makeRepo(tmpDir)).then(
      () => null,
      (err: unknown) => err,
    );
    // The error names the plugin and the file, and keeps the clone error.
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      new RegExp(`^HTTP plugin ${plugin?.name} failed on \\S+\\.java: `),
    );
    expect((failure as Error).cause).toMatchObject({ name: 'DataCloneError' });
  });

  it('keeps no file source alive through the cached scan detections', async () => {
    // One detection per file, whose path V8 slices from the file's source, and
    // only the padding around it grows between the two runs.
    const FILES = 16;
    const LARGE_PAD = 1024 * 1024;
    const projectScan = getPluginForFile('x.ts')?.projectScan;
    if (!projectScan) throw new Error('expected the JS/TS project scan');
    const heapAtResolve = async (padChars: number): Promise<number> => {
      const root = fs.mkdtempSync(path.join(tmpDir, 'pad-'));
      for (let i = 0; i < FILES; i++) {
        write(
          root,
          `src/c${i}.ts`,
          `// ${'x'.repeat(padChars)}\nexport const load${i} = () => fetch('/api/customer/preferences${i}');\n`,
        );
      }
      // Every scanned file is cached by then; `liveTrees` runs a full GC.
      let atResolve = 0;
      const resolve = projectScan.resolve;
      projectScan.resolve = (...args) => {
        liveTrees();
        atResolve = process.memoryUsage().heapUsed;
        return resolve.apply(projectScan, args);
      };
      try {
        liveTrees();
        const before = process.memoryUsage().heapUsed;
        const contracts = await new HttpRouteExtractor().extract(null, root, makeRepo(root));
        expect(contracts).toHaveLength(FILES);
        return atResolve - before;
      } finally {
        projectScan.resolve = resolve;
      }
    };

    const small = await heapAtResolve(1024);
    const large = await heapAtResolve(LARGE_PAD);
    // The large run reads 16 MB more source; the detections must keep none of it.
    expect(large - small).toBeLessThan((FILES * LARGE_PAD) / 4);
  });

  it('keeps no scope view in the JS/TS project facts', () => {
    const plugin = getPluginForFile('x.ts');
    if (!plugin?.projectScan) throw new Error('expected the JS/TS project scan');
    const parser = new Parser();
    parser.setLanguage(plugin.language);
    const tree = parser.parse(
      "import { Router } from 'express';\nexport const r = Router();\nr.get('/items', (_req, res) => res.send('x'));\n",
    );
    const collected = plugin.projectScan.collect({ filePath: 'src/r.ts', tree });
    // A scope view (ParsedFile) has a module scope and its scope list; the
    // import resolvers need only file paths, so `resolve` must not get one.
    const scopeViews: string[] = [];
    const visit = (value: unknown, at: string): void => {
      if (value === null || typeof value !== 'object') return;
      if ('moduleScope' in value && 'scopes' in value) scopeViews.push(at);
      for (const [key, child] of Object.entries(value)) visit(child, `${at}.${key}`);
    };
    visit(collected, 'facts');
    expect(scopeViews).toEqual([]);
    expect(collected).toMatchObject({ filePath: 'src/r.ts', facts: { filePath: 'src/r.ts' } });
  });

  it('emits the same contracts without a graph', async () => {
    writeMixedFixture(tmpDir);
    const contracts = await new HttpRouteExtractor().extract(null, tmpDir, makeRepo(tmpDir));
    expect(contractKeys(contracts)).toEqual(MIXED_CONTRACTS);
  });

  it.skipIf(!KOTLIN)(
    'emits the same contracts when graph routes need the source scan',
    async () => {
      writeMixedFixture(tmpDir);
      const db = unresolvedRouteDb(
        'app/src/main/kotlin/com/example/pay/AccountController.kt',
        '/api/accounts/api/reports',
      );
      const contracts = await new HttpRouteExtractor().extract(db, tmpDir, makeRepo(tmpDir));
      expect(contractKeys(contracts)).toEqual(MIXED_CONTRACTS_WITH_GRAPH_ROUTE);
    },
  );
});
