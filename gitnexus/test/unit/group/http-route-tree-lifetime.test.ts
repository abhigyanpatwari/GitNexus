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

const probe = vi.hoisted(() => ({ turn: 0, parseTurns: [] as number[] }));

// Pass-through spy that records the event-loop turn of every parse. The
// orchestrator also hands this function to the plugins' `prepareRepo`.
vi.mock('../../../src/core/tree-sitter/safe-parse.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/core/tree-sitter/safe-parse.js')>();
  return {
    ...actual,
    parseSourceSafe: (...args: Parameters<typeof actual.parseSourceSafe>) => {
      probe.parseTurns.push(probe.turn);
      return actual.parseSourceSafe(...args);
    },
  };
});

import { HttpRouteExtractor } from '../../../src/core/group/extractors/http-route-extractor.js';
import { getPluginForFile } from '../../../src/core/group/extractors/http-patterns/index.js';
import type { HttpLanguagePlugin } from '../../../src/core/group/extractors/http-patterns/types.js';
import { PARSES_PER_RELEASE } from '../../../src/core/tree-sitter/native-tree-release.js';
import type { CypherExecutor } from '../../../src/core/group/contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../../../src/core/group/types.js';

const TreeClass = (Parser as unknown as { Tree: abstract new (...args: never[]) => unknown }).Tree;
/** Reachable Tree wrappers; `queryObjects` runs a full GC first. */
const liveTrees = (): number => v8.queryObjects(TreeClass, { format: 'count' });

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
const BULK_KOTLIN_CONTROLLER = 'app/src/main/kotlin/com/example/bulk/Ctl0.kt';

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

/** Run `fn` while a self-rescheduling `setImmediate` numbers event-loop turns. */
async function countingTurns<T>(fn: () => Promise<T>): Promise<T> {
  probe.turn = 0;
  probe.parseTurns = [];
  let running = true;
  const tick = (): void => {
    if (!running) return;
    probe.turn += 1;
    setImmediate(tick);
  };
  setImmediate(tick);
  try {
    return await fn();
  } finally {
    running = false;
  }
}

/** Most parses that ran inside one event-loop turn of the last `countingTurns`. */
function maxParsesPerTurn(): number {
  const perTurn = new Map<number, number>();
  for (const turn of probe.parseTurns) perTurn.set(turn, (perTurn.get(turn) ?? 0) + 1);
  return Math.max(0, ...perTurn.values());
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
];

/** With a graph route lacking a handler id, that provider keeps the graph's file-level symbol. */
const MIXED_CONTRACTS_WITH_GRAPH_ROUTE = MIXED_CONTRACTS.map((key) =>
  key.startsWith('provider http::GET::/api/accounts/api/reports ')
    ? 'provider http::GET::/api/accounts/api/reports app/src/main/kotlin/com/example/pay/AccountController.kt AccountController.kt 0.9'
    : key,
).sort();

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
    let maxLive = 0;
    let samples = 0;
    const sample = (): void => {
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
      contracts = await new HttpRouteExtractor().extract(null, tmpDir, makeRepo(tmpDir));
    } finally {
      for (const restore of restores) restore();
    }

    expect(contracts.length).toBeGreaterThan(0);
    expect(samples).toBeGreaterThan(40);
    expect(maxLive).toBeLessThanOrEqual(1);
    // Every sample forces a full GC, which is slow in a test worker's large heap.
  }, 120_000);

  it.each([
    ['without a graph', () => null],
    [
      'with graph routes that need the source scan',
      () => unresolvedRouteDb(BULK_KOTLIN_CONTROLLER, '/kt/0'),
    ],
  ])('yields to the event loop between parse batches %s', async (_label, makeDb) => {
    writeBulkFixture(tmpDir);

    const contracts = await countingTurns(() =>
      new HttpRouteExtractor().extract(makeDb(), tmpDir, makeRepo(tmpDir)),
    );

    expect(contracts.length).toBeGreaterThan(0);
    // Every bulk file is parsed exactly once.
    expect(probe.parseTurns.length).toBe(4 * BULK);
    expect(maxParsesPerTurn()).toBeLessThanOrEqual(PARSES_PER_RELEASE);
  });

  it('rejects project-scan facts that hold a syntax node', async () => {
    writeMixedFixture(tmpDir);
    const projectScan = getPluginForFile('x.kt')?.projectScan;
    if (!projectScan) throw new Error('expected the Kotlin project scan');
    vi.spyOn(projectScan, 'collect').mockImplementation(({ tree }) => [
      { node: tree.rootNode } as never,
    ]);

    await expect(
      new HttpRouteExtractor().extract(null, tmpDir, makeRepo(tmpDir)),
    ).rejects.toMatchObject({ name: 'DataCloneError' });
  });

  it('emits the same contracts without a graph', async () => {
    writeMixedFixture(tmpDir);
    const contracts = await new HttpRouteExtractor().extract(null, tmpDir, makeRepo(tmpDir));
    expect(contractKeys(contracts)).toEqual(MIXED_CONTRACTS);
  });

  it('emits the same contracts when graph routes need the source scan', async () => {
    writeMixedFixture(tmpDir);
    const db = unresolvedRouteDb(
      'app/src/main/kotlin/com/example/pay/AccountController.kt',
      '/api/accounts/api/reports',
    );
    const contracts = await new HttpRouteExtractor().extract(db, tmpDir, makeRepo(tmpDir));
    expect(contractKeys(contracts)).toEqual(MIXED_CONTRACTS_WITH_GRAPH_ROUTE);
  });
});
