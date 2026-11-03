import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  RelPairRouter,
  UndeclaredPairCollector,
  UndeclaredRelationPairError,
  checkDeclaredPair,
  createRelationPairMatcher,
  findUndeclaredRelationPairError,
  getNodeLabel,
  parseRelationSchemaPairs,
  relPairKeyFor,
  splitRelPairKey,
} from '../../src/core/lbug/rel-pair-routing.js';

/**
 * Unit tests for RelPairRouter (#2203 U2) — the production per-pair emit path.
 *
 * Mirrors test/unit/rel-csv-split.test.ts: drives the router with an injected
 * mock WriteStream factory so the error, backpressure, and teardown paths are
 * exercised without LadybugDB or real disk streams. These paths are otherwise
 * unreachable in the integration suite (which only hits the no-backpressure
 * happy path), so this is the coverage for the router's failure modes.
 */

// Controllable backpressure + error injection (same shape as the split oracle's mock).
class MockWriteStream extends EventEmitter {
  public chunks: string[] = [];
  public destroyed = false;
  public ended = false;
  public blocked = false;
  public maxDrainListenersSeen = 0;
  // State flags + events so `stream/promises.finished(ws)` (used by the
  // router's close()) resolves against this mock instead of hanging.
  public writable = true;
  public writableEnded = false;
  public writableFinished = false;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    const count = this.listenerCount('drain');
    if (count > this.maxDrainListenersSeen) this.maxDrainListenersSeen = count;
    return !this.blocked;
  }

  end(cb?: (err?: Error) => void): this {
    this.ended = true;
    this.writableEnded = true;
    this.writableFinished = true;
    this.writable = false;
    if (cb) cb();
    queueMicrotask(() => {
      this.emit('finish');
      this.emit('close');
    });
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  unblock(): void {
    this.blocked = false;
    this.emit('drain');
  }

  triggerError(err: Error): void {
    this.emit('error', err);
  }
}

const HEADER = '"from","to","type","confidence","reason","step"';
const VALID = new Set<string>(['File', 'Function', 'Community', 'Process']);
const DECLARED = new Set<string>(['File|Function', 'Function|Function', 'Community|Community']);

const row = (from: string, to: string, type = 'CALLS'): string =>
  `"${from}","${to}","${type}",1.0,"auto",0`;

function mockFactory(streams: MockWriteStream[], opts?: { blocked?: boolean }) {
  return (() => {
    const ws = new MockWriteStream();
    if (opts?.blocked) ws.blocked = true;
    streams.push(ws);
    return ws;
  }) as unknown as (filePath: string) => import('fs').WriteStream;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-pair-routing-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('getNodeLabel', () => {
  it('maps comm_/proc_ prefixes and otherwise splits on the first colon', () => {
    expect(getNodeLabel('comm_42')).toBe('Community');
    expect(getNodeLabel('proc_7')).toBe('Process');
    expect(getNodeLabel('Function:src/a.ts:f:1')).toBe('Function');
    expect(getNodeLabel('File:src/a.ts')).toBe('File');
  });
});

/**
 * `relPairKeyFor` is the ONE classifier `RelPairRouter.route`,
 * `GraphEmitSink.addRelationship`, `PdgEmitSink.addRelationship` and the
 * `structural-pair-coverage` corpus guard all route through. Each used to
 * inline the same three lines; the corpus guard's docblock said it "mirrors
 * RelPairRouter.route", which meant a change to the skip rule here would leave
 * the guard classifying by the old rule — green while `analyze` aborts.
 */
describe('relPairKeyFor', () => {
  const VALID_PAIR_TABLES = new Set(['File', 'Function', 'Community']);

  it('keys an edge whose endpoints are both node tables, and skips one that is not', () => {
    expect(relPairKeyFor('File:src/a.ts', 'Function:src/a.ts:f:1', VALID_PAIR_TABLES)).toBe(
      'File|Function',
    );
    // Synthetic ids still classify through getNodeLabel's prefix rules.
    expect(relPairKeyFor('comm_1', 'comm_2', VALID_PAIR_TABLES)).toBe('Community|Community');
    // `undefined` = SKIP, on either endpoint. Every caller drops the edge.
    expect(
      relPairKeyFor('Bogus:src/a.ts', 'Function:src/a.ts:f:1', VALID_PAIR_TABLES),
    ).toBeUndefined();
    expect(relPairKeyFor('File:src/a.ts', 'Bogus:src/a.ts', VALID_PAIR_TABLES)).toBeUndefined();
  });

  it('agrees with the labels getNodeLabel derives (no second derivation rule)', () => {
    const from = 'File:src/a.ts';
    const to = 'Function:src/a.ts:f:1';
    expect(relPairKeyFor(from, to, VALID_PAIR_TABLES)).toBe(
      `${getNodeLabel(from)}|${getNodeLabel(to)}`,
    );
  });

  it('round-trips through splitRelPairKey, the only sanctioned decoder', () => {
    const key = relPairKeyFor('File:src/a.ts', 'Function:src/a.ts:f:1', VALID_PAIR_TABLES);
    expect(splitRelPairKey(key ?? '')).toEqual(['File', 'Function']);
    // `|` cannot occur inside a NODE_TABLES identifier, so the FIRST `|` is
    // always the separator — that invariant is what makes decoding safe.
    expect(splitRelPairKey('BasicBlock|BasicBlock')).toEqual(['BasicBlock', 'BasicBlock']);
  });
});

describe('parseRelationSchemaPairs', () => {
  it('extracts plain and quoted FROM→TO labels for router validation', () => {
    expect(
      parseRelationSchemaPairs(`
        CREATE REL TABLE CodeRelation(
          FROM Class TO CodeElement,
          FROM \`Enum\` TO \`TypeAlias\`,
          type STRING
        )
      `),
    ).toEqual(new Set(['Class|CodeElement', 'Enum|TypeAlias']));
  });
});

/**
 * The `FROM…TO` pattern is exported so `test/unit/schema-pair-coverage.test.ts`
 * can COUNT raw occurrences with the very regex the parser de-duplicates with
 * (count > set size ⇒ a pair is duplicated in the DDL ⇒ LadybugDB rejects
 * `CREATE REL TABLE` and every `analyze` dies). While that guard inlined its own
 * copy, a widening on either side would have degraded it to
 * `declared.size === declared.size` with nothing failing. These tests pin both
 * halves of the coupling: the factory's freshness contract, and the exact pair
 * set the shared pattern produces for the widening-adjacent DDL shapes.
 */
describe('createRelationPairMatcher', () => {
  it('returns a fresh global matcher per call so lastIndex cannot leak between consumers', () => {
    const first = createRelationPairMatcher();
    const second = createRelationPairMatcher();
    expect(first).not.toBe(second);
    expect([first.global, first.lastIndex, second.lastIndex]).toEqual([true, 0, 0]);

    first.exec('FROM Class TO CodeElement');
    // The used instance advanced; a newly built one is still at the start.
    expect([first.lastIndex > 0, createRelationPairMatcher().lastIndex]).toEqual([true, 0]);
  });

  it('is the pattern parseRelationSchemaPairs itself uses (no re-inlined copy)', () => {
    // Each shape is either a form the pattern accepts today or a widening the
    // finding calls out (dotted identifier, multi-target `FROM x TO y, z`).
    const ddlShapes = [
      'FROM Class TO CodeElement',
      'FROM `Enum` TO `TypeAlias`',
      'CREATE REL TABLE IF NOT EXISTS CodeRelation(FROM A TO B, FROM A TO B, type STRING)',
      'FROM ns.Class TO Other',
      'FROM A TO B, C',
    ];
    const viaMatcher = ddlShapes.map((ddl) =>
      [...ddl.matchAll(createRelationPairMatcher())].map((m) => `${m[1]}|${m[2]}`),
    );

    // Pins what the shared pattern matches. Widening the exported matcher
    // without updating the duplicate-count guard's expectations fails here.
    expect(viaMatcher).toEqual([
      ['Class|CodeElement'],
      ['Enum|TypeAlias'],
      ['A|B', 'A|B'], // duplicate survives the raw count; the parser dedups it
      [], // dotted identifiers are NOT matched today
      ['A|B'], // multi-target: only the first target is matched today
    ]);
    // Re-inlining a DIFFERENT regex inside parseRelationSchemaPairs breaks this.
    expect(ddlShapes.map((ddl) => [...parseRelationSchemaPairs(ddl)])).toEqual(
      viaMatcher.map((pairs) => [...new Set(pairs)]),
    );
  });
});

describe('checkDeclaredPair', () => {
  const DECLARED_ONE = new Set<string>(['Function|Function']);

  /** Run one undeclared edge through the guard and return what the collector throws. */
  const failOnce = (
    pairKey: string,
    relationType: string,
    fromId: string,
    toId: string,
  ): unknown => {
    const undeclared = new UndeclaredPairCollector();
    checkDeclaredPair(pairKey, DECLARED_ONE, undeclared, relationType, fromId, toId);
    try {
      undeclared.throwIfAny();
      return undefined;
    } catch (err) {
      return err;
    }
  };

  it('passes a declared pair and records an undeclared one instead of throwing', () => {
    const undeclared = new UndeclaredPairCollector();
    expect(
      checkDeclaredPair(
        'Function|Function',
        DECLARED_ONE,
        undeclared,
        'CALLS',
        'Function:src/a.ts:f:1',
        'Function:src/a.ts:g:2',
      ),
    ).toBe(true);
    expect(() => undeclared.throwIfAny()).not.toThrow();

    expect(
      checkDeclaredPair(
        'Method|Annotation',
        DECLARED_ONE,
        undeclared,
        'ANNOTATED_BY',
        'Method:src/app/Config.java:Config.dataSource#12',
        'Annotation:src/app/Config.java:ConditionalOnMissingBean',
      ),
    ).toBe(false);
    expect(undeclared.size).toBe(1);
    expect(() => undeclared.throwIfAny()).toThrow(UndeclaredRelationPairError);
  });

  it('carries the pair, relationship type, both node ids and the source file (#2789)', () => {
    const thrown = failOnce(
      'Method|Annotation',
      'ANNOTATED_BY',
      'Method:src/app/Config.java:Config.dataSource#12',
      'Annotation:src/app/Config.java:ConditionalOnMissingBean',
    );

    expect(thrown).toBeInstanceOf(UndeclaredRelationPairError);
    expect(thrown).toMatchObject({
      name: 'UndeclaredRelationPairError',
      pairKey: 'Method|Annotation',
      relationType: 'ANNOTATED_BY',
      fromId: 'Method:src/app/Config.java:Config.dataSource#12',
      toId: 'Annotation:src/app/Config.java:ConditionalOnMissingBean',
      sourceFile: 'src/app/Config.java',
    });
    // Everything a bug report needs must also survive in the message alone:
    // `gitnexus serve` forwards nothing but `err.message` over worker IPC, so
    // this message is the ONLY rendering — `cli/analyze.ts` prints it verbatim
    // rather than re-formatting the structured fields into a second copy.
    // Filter-to-empty rather than an array of booleans: the failure output
    // NAMES the missing string instead of making you count `true`s.
    const message = (thrown as UndeclaredRelationPairError).message;
    const required = [
      'Method → Annotation is not declared in the LadybugDB relation schema',
      'ANNOTATED_BY',
      'Method:src/app/Config.java:Config.dataSource#12',
      'Annotation:src/app/Config.java:ConditionalOnMissingBean',
      'src/app/Config.java',
      // The two ACTIONABLE items. They live in the message, not in the CLI
      // branch, so a `gitnexus serve` user gets them too.
      'https://github.com/abhigyanpatwari/GitNexus/issues/new',
      '.gitnexusignore',
      "gap in GitNexus's own relation schema",
      're-running the analysis will fail in exactly the same place',
    ];
    expect(required.filter((needle) => !message.includes(needle))).toEqual([]);
    expect(message).not.toContain('other files may contain the same pairs');
  });

  it('warns about unlisted files when a single pair occurs more than once', () => {
    const undeclared = new UndeclaredPairCollector();
    for (const file of ['Config.java', 'Other.kt']) {
      undeclared.record(
        'Method|Annotation',
        'ANNOTATED_BY',
        `Method:src/app/${file}:configure#12`,
        `Annotation:src/app/${file}:Bean`,
      );
    }

    let thrown: unknown;
    try {
      undeclared.throwIfAny();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UndeclaredRelationPairError);
    const err = thrown as UndeclaredRelationPairError;
    expect(err.pairs).toHaveLength(1);
    expect(err.pairs[0]).toMatchObject({ pairKey: 'Method|Annotation', edges: 2 });
    expect(err.message).toContain('Only the first edge of each pair is shown');
    expect(err.message).toContain(
      'other files may contain the same pairs and need to be excluded too',
    );
    expect(err.message).not.toContain('To finish indexing the rest');
    expect(err.message).toContain('src/app/Config.java');
    expect(err.message).not.toContain('Other.kt');
  });

  it('reports every undeclared pair of the emit in one error (#2797)', () => {
    const undeclared = new UndeclaredPairCollector();
    const edges: Array<[string, string, string, string]> = [
      [
        'Method|Annotation',
        'ANNOTATED_BY',
        'Method:src/app/Config.java:Config.dataSource#12',
        'Annotation:src/app/Config.java:ConditionalOnMissingBean',
      ],
      ['Method|File', 'CALLS', 'Method:src/App.vue:App.onSave#3', 'File:src/Child.vue'],
      [
        'Method|Annotation',
        'ANNOTATED_BY',
        'Method:src/app/Other.kt:Other.cache#7',
        'Annotation:src/app/Other.kt:Bean',
      ],
      ['Class|Tool', 'DEFINES', 'Class:tools/search.py:Search', 'Tool:tools/search.py:search'],
    ];
    for (const [pairKey, type, from, to] of edges) {
      expect(checkDeclaredPair(pairKey, DECLARED_ONE, undeclared, type, from, to)).toBe(false);
    }

    let thrown: unknown;
    try {
      undeclared.throwIfAny();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UndeclaredRelationPairError);
    const err = thrown as UndeclaredRelationPairError;
    // The top-level fields stay those of the first pair, so existing consumers
    // (the CLI's machine-readable fields) keep their meaning.
    expect(err).toMatchObject({
      pairKey: 'Method|Annotation',
      relationType: 'ANNOTATED_BY',
      sourceFile: 'src/app/Config.java',
    });
    expect(err.pairs.map((pair) => [pair.pairKey, pair.edges])).toEqual([
      ['Method|Annotation', 2],
      ['Method|File', 1],
      ['Class|Tool', 1],
    ]);
    const required = [
      '3 relationship label pairs are not declared',
      'Method → Annotation (2 edges, first one below)',
      'Method → File (1 edge, first one below)',
      'Class → Tool (1 edge, first one below)',
      'Method:src/app/Config.java:Config.dataSource#12',
      'src/App.vue',
      'tools/search.py',
      'Report the missing pairs',
      'adding the example files (or their directories)',
      'Only the first edge of each pair is shown',
      'other files may contain the same pairs and need to be excluded too',
      'https://github.com/abhigyanpatwari/GitNexus/issues/new',
      're-running the analysis will fail in exactly the same place',
    ];
    expect(required.filter((needle) => !err.message.includes(needle))).toEqual([]);
    expect(err.message).not.toContain('To finish indexing the rest');
    // The second Method→Annotation edge is counted, not listed.
    expect(err.message).not.toContain('Other.kt');
  });

  it('reports no source file for synthetic community/process ids instead of guessing', () => {
    const err = new UndeclaredRelationPairError(
      'Community|Process',
      'BELONGS_TO',
      'comm_4',
      'proc_7',
    );
    expect(err.sourceFile).toBeUndefined();
    expect(['(none — synthetic node id)'].filter((n) => !err.message.includes(n))).toEqual([]);
  });

  it("is findable through the phase runner's cause chain", () => {
    const original = new UndeclaredRelationPairError(
      'Method|Annotation',
      'ANNOTATED_BY',
      'Method:src/app/Config.java:Config.dataSource#12',
      'Annotation:src/app/Config.java:ConditionalOnMissingBean',
    );
    const wrapped = new Error("Phase 'graph-emit' failed: …", {
      cause: new Error('emit failed', { cause: original }),
    });

    expect(findUndeclaredRelationPairError(wrapped)).toBe(original);
    expect(findUndeclaredRelationPairError(original)).toBe(original);
    expect(findUndeclaredRelationPairError(new Error('unrelated'))).toBeUndefined();
    expect(findUndeclaredRelationPairError('not an error')).toBeUndefined();
  });
});

describe('RelPairRouter', () => {
  it('routes valid edges to per-pair files (header first) and skips invalid-label edges', async () => {
    const streams: MockWriteStream[] = [];
    const router = new RelPairRouter(tmpDir, HEADER, VALID, DECLARED, mockFactory(streams));

    const route = async (from: string, to: string) => {
      const p = router.route(from, to, row(from, to), 'CALLS');
      if (p) await p;
    };
    await route('File:a', 'Function:a:f:1');
    await route('File:a', 'Function:a:g:2'); // same pair
    await route('Function:a:f:1', 'Function:a:g:2'); // different pair
    await route('Bogus:x', 'File:a'); // invalid FROM label → skipped
    await route('File:a', 'Bogus:y'); // invalid TO label → skipped (other branch)
    await router.close();

    expect(router.skipped).toBe(2);
    expect(router.total).toBe(3);
    expect([...router.byPair.keys()].sort()).toEqual(['File|Function', 'Function|Function']);
    expect(router.byPair.get('File|Function')!.rows).toBe(2);
    // Header is the first chunk written to each pair stream.
    expect(streams[0].chunks[0]).toBe(HEADER + '\n');
    expect(streams.every((s) => s.ended)).toBe(true);
  });

  it('skips every valid-label pair absent from the relation schema and rejects at close with all of them', async () => {
    const streams: MockWriteStream[] = [];
    const router = new RelPairRouter(tmpDir, HEADER, VALID, DECLARED, mockFactory(streams));

    const route = async (from: string, to: string, type: string) => {
      const p = router.route(from, to, row(from, to, type), type);
      if (p) await p;
    };
    // Routing does not throw on an undeclared pair: it keeps going so the
    // later ones are found in the same run.
    await route('File:src/a.ts', 'Community:1', 'DEFINES');
    await route('File:src/a.ts', 'Function:src/a.ts:f:1', 'DEFINES');
    await route('Function:src/b.ts:g:2', 'Process:3', 'STEP_IN_PROCESS');
    await route('File:src/c.ts', 'Community:4', 'DEFINES');

    const closing = router.close();
    await expect(closing).rejects.toThrow(UndeclaredRelationPairError);
    const err = (await closing.catch((e: unknown) => e)) as UndeclaredRelationPairError;
    // The row is already CSV-escaped here, so the router must forward the edge
    // context itself — otherwise the error names only the abstract label pair.
    expect(err.pairs.map((pair) => [pair.pairKey, pair.relationType, pair.edges])).toEqual([
      ['File|Community', 'DEFINES', 2],
      ['Function|Process', 'STEP_IN_PROCESS', 1],
    ]);
    expect(err.message).toContain('File → Community (2 edges, first one below)');
    expect(err.message).toContain('Function:src/b.ts:g:2');
    // Only the declared edge reached a pair file; undeclared ones are not
    // counted as skipped (that counter is for invalid node labels).
    expect([...router.byPair.keys()]).toEqual(['File|Function']);
    expect(router.total).toBe(1);
    expect(router.skipped).toBe(0);
    expect(streams.every((s) => s.ended)).toBe(true);
  });

  it('returns a drain promise under backpressure and completes once unblocked', async () => {
    const streams: MockWriteStream[] = [];
    const router = new RelPairRouter(
      tmpDir,
      HEADER,
      VALID,
      DECLARED,
      mockFactory(streams, { blocked: true }),
    );

    const pending = router.route(
      'File:a',
      'Function:a:f:1',
      row('File:a', 'Function:a:f:1'),
      'DEFINES',
    );
    expect(pending).toBeInstanceOf(Promise); // header write hit backpressure
    streams[0].unblock();
    await pending;

    expect(streams[0].maxDrainListenersSeen).toBeLessThanOrEqual(1);
    expect(streams[0].chunks[0]).toBe(HEADER + '\n');
    expect(router.total).toBe(1);
  });

  it('on a stream error: route() throws the real error, lastError exposes it, close() rejects + destroys', async () => {
    const streams: MockWriteStream[] = [];
    const router = new RelPairRouter(tmpDir, HEADER, VALID, DECLARED, mockFactory(streams));

    const first = router.route(
      'File:a',
      'Function:a:f:1',
      row('File:a', 'Function:a:f:1'),
      'DEFINES',
    );
    if (first) await first;

    const err = new Error('EMFILE: too many open files');
    streams[0].triggerError(err);

    // The next route surfaces the REAL error, not a generic AbortError.
    expect(() =>
      router.route('File:a', 'Function:a:g:2', row('File:a', 'Function:a:g:2'), 'DEFINES'),
    ).toThrow('EMFILE');
    expect(router.lastError).toBe(err);
    await expect(router.close()).rejects.toThrow('EMFILE');
    expect(streams[0].destroyed).toBe(true);
  });

  it('destroy() tears down every open pair stream', async () => {
    const streams: MockWriteStream[] = [];
    const router = new RelPairRouter(tmpDir, HEADER, VALID, DECLARED, mockFactory(streams));

    const a = router.route('File:a', 'Function:a:f:1', row('File:a', 'Function:a:f:1'), 'DEFINES');
    if (a) await a;
    const b = router.route(
      'Community:1',
      'Community:2',
      row('Community:1', 'Community:2'),
      'RELATED_TO',
    );
    if (b) await b;

    router.destroy();
    expect(streams.length).toBe(2);
    expect(streams.every((s) => s.destroyed)).toBe(true);
  });
});
