import { describe, expect, it } from 'vitest';
import {
  isStructuredCloneable,
  makeWorkerResultCloneSafe,
  type SkippedPath,
} from '../../src/core/ingestion/workers/clone-safety.js';
import type { ParseWorkerResult } from '../../src/core/ingestion/workers/parse-worker.js';

/**
 * #2112: the worker result boundary must survive a value the structured-clone
 * algorithm can't serialize. The reporter's case was a node `properties` value
 * pointing at a native `toString`, which crashed the whole parse phase.
 */
describe('clone-safety', () => {
  describe('isStructuredCloneable', () => {
    it('accepts plain data and the structured-clone-native containers', () => {
      expect(isStructuredCloneable({ a: 1, b: [2, 3], c: 'x' })).toBe(true);
      expect(isStructuredCloneable(new Map([['k', [1]]]))).toBe(true);
      expect(isStructuredCloneable(new Set([1, 2]))).toBe(true);
      expect(isStructuredCloneable(new Date())).toBe(true);
      expect(isStructuredCloneable(/re/g)).toBe(true);
    });

    it('rejects functions and symbols', () => {
      expect(isStructuredCloneable(() => 1)).toBe(false);
      expect(isStructuredCloneable({ fn: () => 1 })).toBe(false);
      expect(isStructuredCloneable({ s: Symbol('x') })).toBe(false);
    });
  });

  describe('makeWorkerResultCloneSafe', () => {
    const opts = {
      dropWholeElement: new Set(['parsedFiles']),
      skipFields: new Set(['skippedPaths']),
    };

    it('leaves a fully cloneable result untouched (referential identity preserved)', () => {
      const nodes = [{ id: 'n1', properties: { filePath: 'a.ts', name: 'foo' } }];
      const result: Record<string, unknown> = {
        nodes,
        parsedFiles: [{ filePath: 'a.ts', scopes: [{ bindings: new Map([['x', [1]]]) }] }],
        skippedLanguages: { ada: 2 },
        fileCount: 1,
      };
      const { skipped } = makeWorkerResultCloneSafe(result, opts);
      expect(skipped).toEqual([]);
      // Untouched arrays keep their identity (no needless copy).
      expect(result.nodes).toBe(nodes);
      expect(isStructuredCloneable(result)).toBe(true);
    });

    it('strips a non-cloneable value from a plain record, keeps the record, attributes the path', () => {
      // The exact #2112 shape: a node whose properties carry an own native fn.
      const props: Record<string, unknown> = { filePath: 'pkg/bad.cpp', name: 'wedge' };
      props.toString = Object.prototype.toString;
      const result: Record<string, unknown> = {
        nodes: [
          { id: 'good', properties: { filePath: 'pkg/ok.cpp', name: 'ok' } },
          { id: 'bad', properties: props },
        ],
        parsedFiles: [],
        skippedLanguages: {},
        fileCount: 2,
      };
      expect(isStructuredCloneable(result)).toBe(false); // red: would crash postMessage

      const { skipped } = makeWorkerResultCloneSafe(result, opts);

      expect(isStructuredCloneable(result)).toBe(true); // green: now deliverable
      const nodes = result.nodes as Array<{ id: string; properties: Record<string, unknown> }>;
      expect(nodes).toHaveLength(2); // record kept, not dropped
      expect(nodes[1].properties.toString).toBeUndefined(); // offending value stripped
      expect(nodes[1].properties.name).toBe('wedge'); // legitimate data preserved
      expect(skipped).toHaveLength(1);
      expect(skipped[0].path).toBe('pkg/bad.cpp');
      expect(skipped[0].reason).toContain('nodes');
      // The reason names the exact offending key path — what lets the leak be
      // located from a single log line, not just the array field.
      expect(skipped[0].reason).toContain('properties.toString');
    });

    it('does not touch a result whose only "exotic" value is a clean Map (the refuted Map hypothesis)', () => {
      const result: Record<string, unknown> = {
        symbols: [{ id: 's', filePath: 'a.ts', bindings: new Map([['t', 'T']]) }],
        parsedFiles: [],
        skippedLanguages: {},
        fileCount: 1,
      };
      const { skipped } = makeWorkerResultCloneSafe(result, opts);
      expect(skipped).toEqual([]);
      expect(result.symbols as unknown[]).toHaveLength(1);
    });

    it('drops a whole ParsedFile when its captureSideChannel is non-cloneable (re-parse path)', () => {
      const sideChannel: Record<string, unknown> = { staticNames: ['a'] };
      sideChannel.leaked = () => 1; // a function leaked into the side-channel
      const result: Record<string, unknown> = {
        nodes: [],
        parsedFiles: [
          { filePath: 'keep.c', scopes: [] },
          { filePath: 'drop.c', captureSideChannel: sideChannel },
        ],
        skippedLanguages: {},
        fileCount: 2,
      };
      const { skipped } = makeWorkerResultCloneSafe(result, opts);

      expect(isStructuredCloneable(result)).toBe(true);
      const parsedFiles = result.parsedFiles as Array<{ filePath: string }>;
      expect(parsedFiles).toHaveLength(1); // bad file dropped whole, not stripped
      expect(parsedFiles[0].filePath).toBe('keep.c');
      expect(skipped).toHaveLength(1);
      expect(skipped[0].path).toBe('drop.c');
      expect(skipped[0].reason).toContain('dropped');
    });

    it('strips a non-cloneable value that is not a function/symbol (e.g. a Promise) and keeps the record', () => {
      const result: Record<string, unknown> = {
        calls: [
          { id: 'c1', filePath: 'a.ts' },
          { id: 'c2', filePath: 'b.ts', pending: Promise.resolve(1) }, // Promise: not cloneable, not a fn
        ],
        parsedFiles: [],
        skippedLanguages: {},
        fileCount: 2,
      };
      const { skipped } = makeWorkerResultCloneSafe(result, opts);
      expect(isStructuredCloneable(result)).toBe(true);
      const calls = result.calls as Array<{ id: string; pending?: unknown }>;
      expect(calls.map((c) => c.id)).toEqual(['c1', 'c2']); // record kept
      expect(calls[1].pending).toBeUndefined(); // unsalvageable value stripped to undefined
      expect(skipped).toHaveLength(1);
      expect(skipped[0].path).toBe('b.ts');
      expect(skipped[0].reason).toContain('calls');
    });

    it('never recurses into the skippedPaths field it populates', () => {
      const result: Record<string, unknown> = {
        nodes: [{ id: 'n', properties: { filePath: 'a.ts' } }],
        skippedPaths: [{ path: 'prior.ts', reason: 'earlier sub-batch' }],
        parsedFiles: [],
        skippedLanguages: {},
        fileCount: 1,
      };
      const before = result.skippedPaths;
      makeWorkerResultCloneSafe(result, opts);
      expect(result.skippedPaths).toBe(before); // untouched
    });
  });

  // U1 (#2112): the sanitizer must not recurse to a stack overflow on a deeply
  // nested record — an over-deep subtree is bounded (treated non-cloneable) and
  // the result is salvaged rather than the sanitizer throwing and re-arming the
  // cascade it exists to prevent.
  describe('bounded recursion depth', () => {
    const opts = {
      dropWholeElement: new Set(['parsedFiles']),
      skipFields: new Set(['skippedPaths']),
    };

    // Build a plain-object chain `{ child: { child: { … } } }` of the given
    // depth with a non-cloneable function at the bottom.
    const deepChainWithFn = (depth: number): Record<string, unknown> => {
      let node: Record<string, unknown> = { leaked: () => 1 };
      for (let i = 0; i < depth; i++) node = { child: node };
      return node;
    };

    it('salvages a deeply-nested non-cloneable record without throwing RangeError', () => {
      const result: Record<string, unknown> = {
        nodes: [{ id: 'deep', filePath: 'deep.ts', tree: deepChainWithFn(5000) }],
        parsedFiles: [],
        skippedLanguages: {},
        fileCount: 1,
      };
      // Must not throw (no RangeError escaping the sanitizer)...
      expect(() => makeWorkerResultCloneSafe(result, opts)).not.toThrow();
      // ...and the rewritten result is deliverable across postMessage.
      expect(isStructuredCloneable(result)).toBe(true);
    });

    it('a shallow result is unaffected by the depth bound', () => {
      const nodes = [{ id: 'n', properties: { filePath: 'a.ts', name: 'ok' } }];
      const result: Record<string, unknown> = {
        nodes,
        parsedFiles: [],
        skippedLanguages: {},
        fileCount: 1,
      };
      const { skipped } = makeWorkerResultCloneSafe(result, opts);
      expect(skipped).toEqual([]);
      expect(result.nodes).toBe(nodes); // identity preserved, no needless copy
    });
  });

  // U2 (#2112): two sanitizer-defeat vectors that previously let the re-post
  // throw — a throwing getter and a detached ArrayBuffer/view.
  describe('sanitizer-defeat hardening', () => {
    const opts = {
      dropWholeElement: new Set(['parsedFiles']),
      skipFields: new Set(['skippedPaths']),
    };

    it('drops a throwing getter and delivers the rest of the record', () => {
      const el: Record<string, unknown> = { id: 'g', filePath: 'g.ts', name: 'keep' };
      Object.defineProperty(el, 'boom', {
        enumerable: true,
        get() {
          throw new Error('getter boom');
        },
      });
      const result: Record<string, unknown> = {
        nodes: [el],
        parsedFiles: [],
        skippedLanguages: {},
        fileCount: 1,
      };
      expect(() => makeWorkerResultCloneSafe(result, opts)).not.toThrow();
      expect(isStructuredCloneable(result)).toBe(true);
      const out = (result.nodes as Array<Record<string, unknown>>)[0];
      expect(out.name).toBe('keep'); // legitimate data preserved
      expect('boom' in out).toBe(false); // throwing getter stripped
    });

    it('drops a detached ArrayBuffer view and delivers the rest', () => {
      const buf = new ArrayBuffer(8);
      const view = new Uint8Array(buf);
      structuredClone(buf, { transfer: [buf] }); // detaches buf → view is now detached
      const result: Record<string, unknown> = {
        nodes: [{ id: 'd', filePath: 'd.ts', data: view }],
        parsedFiles: [],
        skippedLanguages: {},
        fileCount: 1,
      };
      const { skipped } = makeWorkerResultCloneSafe(result, opts);
      expect(isStructuredCloneable(result)).toBe(true);
      expect((result.nodes as Array<Record<string, unknown>>)[0].data).toBeUndefined();
      expect(skipped).toHaveLength(1);
    });

    it('does NOT drop a legitimately empty but live view (byteLength false-positive guard)', () => {
      const nodes = [{ id: 'e', filePath: 'e.ts', data: new Uint8Array(0) }];
      const result: Record<string, unknown> = {
        nodes,
        parsedFiles: [],
        skippedLanguages: {},
        fileCount: 1,
      };
      const { skipped } = makeWorkerResultCloneSafe(result, opts);
      expect(skipped).toEqual([]);
      expect(result.nodes).toBe(nodes); // untouched — empty live view clones fine
    });
  });

  // R1 (#2135 tri-review): structuredClone serializes an array's NON-index
  // own-enumerable properties and throws on a non-cloneable one. The index-only
  // scan used to wave such an array through (`skipped: []`), leaving the result
  // non-cloneable so the re-post threw and fail-closed → re-arming the cascade.
  describe('array non-index own-enumerable properties', () => {
    const opts = {
      dropWholeElement: new Set(['parsedFiles']),
      skipFields: new Set(['skippedPaths']),
    };

    it('strips a non-index function property off a nested array and delivers the record', () => {
      const tags: unknown[] & { meta?: unknown } = [1, 2, 3];
      tags.meta = () => {}; // non-index own prop carrying a function
      // sanity: this is the exact shape structuredClone rejects
      expect(isStructuredCloneable({ tags })).toBe(false);
      const result: Record<string, unknown> = {
        nodes: [{ id: 'a', filePath: 'a.ts', tags }],
        parsedFiles: [],
        skippedLanguages: {},
        fileCount: 1,
      };
      const { skipped } = makeWorkerResultCloneSafe(result, opts);
      expect(isStructuredCloneable(result)).toBe(true); // net no longer defeated
      expect(skipped.length).toBeGreaterThan(0);
      const outTags = (result.nodes as Array<{ tags: unknown[] & { meta?: unknown } }>)[0].tags;
      expect(Array.from(outTags)).toEqual([1, 2, 3]); // indexed elements preserved
      expect(outTags.meta).toBeUndefined(); // the function was stripped
    });

    it('carries a CLONEABLE non-index property through the strip', () => {
      const tags: unknown[] & { note?: unknown; bad?: unknown } = [1];
      tags.note = 'keep'; // cloneable non-index prop — must survive
      tags.bad = () => {}; // forces the array dirty
      const result: Record<string, unknown> = {
        nodes: [{ id: 'b', filePath: 'b.ts', tags }],
        parsedFiles: [],
        skippedLanguages: {},
        fileCount: 1,
      };
      makeWorkerResultCloneSafe(result, opts);
      expect(isStructuredCloneable(result)).toBe(true);
      const outTags = (result.nodes as Array<{ tags: { note?: unknown; bad?: unknown } }>)[0].tags;
      expect(outTags.note).toBe('keep'); // data prop carried onto the stripped copy
      expect(outTags.bad).toBeUndefined();
    });
  });

  // R2 (#2135 tri-review): a throw DURING the sanitizer's own structural
  // enumeration (a throwing getter on a path-less element reached by
  // findFilePath, or a Proxy structural trap reached by instanceof/Object.keys)
  // used to escape makeWorkerResultCloneSafe to the fail-closed {type:'error'},
  // re-arming the cascade. findFilePath now reads defensively, and each element's
  // sanitize is wrapped to drop-on-throw.
  describe('sanitizer-internal throw is contained (drop-on-throw)', () => {
    const opts = {
      dropWholeElement: new Set(['parsedFiles']),
      skipFields: new Set(['skippedPaths']),
    };

    it('a throwing getter at a non-path key on a PATH-LESS element does not escape', () => {
      // No top-level path key → findFilePath falls to its generic sweep and
      // (pre-fix) read the throwing getter, throwing out of the sanitizer.
      const el: Record<string, unknown> = { id: 'p', name: 'keep' };
      Object.defineProperty(el, 'boom', {
        enumerable: true,
        get() {
          throw new RangeError('boom');
        },
      });
      const result: Record<string, unknown> = {
        nodes: [el],
        parsedFiles: [],
        skippedLanguages: {},
        fileCount: 1,
      };
      expect(() => makeWorkerResultCloneSafe(result, opts)).not.toThrow();
      expect(isStructuredCloneable(result)).toBe(true);
      const out = (result.nodes as Array<Record<string, unknown>>)[0];
      expect(out.name).toBe('keep'); // legitimate data delivered
      expect('boom' in out).toBe(false); // throwing getter stripped, not escaped
    });

    it('a Proxy with a throwing structural trap is dropped, clean siblings survive', () => {
      const trap = new Proxy(
        { id: 'b' },
        {
          getPrototypeOf() {
            throw new Error('structural trap');
          },
        },
      );
      const result: Record<string, unknown> = {
        nodes: [{ id: 'a', filePath: 'a.ts' }, trap, { id: 'c', filePath: 'c.ts' }],
        parsedFiles: [],
        skippedLanguages: {},
        fileCount: 3,
      };
      let skipped: SkippedPath[] = [];
      expect(() => {
        skipped = makeWorkerResultCloneSafe(result, opts).skipped;
      }).not.toThrow();
      expect(isStructuredCloneable(result)).toBe(true);
      const ids = (result.nodes as Array<{ id: string }>).map((n) => n.id);
      expect(ids).toEqual(['a', 'c']); // trap element dropped, siblings preserved
      expect(skipped.some((s) => s.reason.includes('sanitizer error'))).toBe(true);
    });
  });

  // R3 (#2135 tri-review): the per-field loop rewrites ARRAY fields only. A
  // final isStructuredCloneable(result) gate strips any remaining non-array
  // field so "the result is cloneable after this call" is a hard postcondition
  // regardless of future result-shape changes.
  describe('non-array field safety gate', () => {
    const opts = {
      dropWholeElement: new Set(['parsedFiles']),
      skipFields: new Set(['skippedPaths']),
    };

    it('strips a non-cloneable value carried on a non-ARRAY result field', () => {
      const result: Record<string, unknown> = {
        nodes: [],
        parsedFiles: [],
        skippedLanguages: {},
        fileCount: 0,
        summary: { kept: 1, build: () => {} }, // non-array field, non-cloneable
      };
      const { skipped } = makeWorkerResultCloneSafe(result, opts);
      expect(isStructuredCloneable(result)).toBe(true);
      expect((result.summary as { kept: number; build?: unknown }).kept).toBe(1);
      expect((result.summary as { build?: unknown }).build).toBeUndefined();
      expect(skipped.some((s) => s.reason.includes('summary'))).toBe(true);
    });

    it('is a no-op when the array loop already made the result cloneable', () => {
      const result: Record<string, unknown> = {
        nodes: [{ id: 'a', filePath: 'a.ts', leak: () => {} }],
        parsedFiles: [],
        skippedLanguages: {},
        fileCount: 1,
      };
      const { skipped } = makeWorkerResultCloneSafe(result, opts);
      expect(isStructuredCloneable(result)).toBe(true);
      // Only the array-element strip was recorded; the gate added no '(result)' entry.
      expect(skipped.every((s) => s.path !== '(result)')).toBe(true);
    });
  });

  // R12 (#2135 tri-review): the "dropped unsalvageable" branch — a dirty element
  // whose stripped copy is STILL not structured-cloneable must be dropped (not
  // delivered), so the re-post can't throw. Triggered here with a non-plain
  // member that the strip-time probe sees as clean but that turns non-cloneable
  // on the final post-strip verification (a stateful getter).
  describe('unsalvageable element drop', () => {
    const opts = {
      dropWholeElement: new Set(['parsedFiles']),
      skipFields: new Set(['skippedPaths']),
    };

    it('drops an element that is still non-cloneable after stripping', () => {
      let reads = 0;
      class Blob {}
      const blob = new Blob();
      Object.defineProperty(blob, 'data', {
        enumerable: true,
        // Clean on the strip-time probe (kept by reference), a function on the
        // post-strip verification probe → the cleaned element is unsalvageable.
        get() {
          reads++;
          return reads === 1 ? 'ok' : () => {};
        },
      });
      const result: Record<string, unknown> = {
        nodes: [{ id: 'x', filePath: 'x.ts', leak: () => {}, blob }],
        parsedFiles: [],
        skippedLanguages: {},
        fileCount: 1,
      };
      const { skipped } = makeWorkerResultCloneSafe(result, opts);
      expect(isStructuredCloneable(result)).toBe(true); // run survives
      expect((result.nodes as unknown[]).length).toBe(0); // unsalvageable element dropped
      expect(skipped.some((s) => s.reason.includes('unsalvageable'))).toBe(true);
    });
  });

  // U3 (#2112): a DAG-aliased record (the same subobject reached via two paths)
  // carrying a non-cloneable must be stripped-and-KEPT, not over-dropped — the
  // old shared-WeakSet returned the un-stripped original on revisit, failing the
  // last-resort guard and dropping the whole record.
  describe('DAG-aliased records (memoized strip copies)', () => {
    const opts = {
      dropWholeElement: new Set(['parsedFiles']),
      skipFields: new Set(['skippedPaths']),
    };

    it('keeps a DAG element whose shared subobject carries a non-cloneable value', () => {
      const shared: Record<string, unknown> = { tag: 's', leaked: () => 1 };
      const el: Record<string, unknown> = {
        id: 'dag',
        filePath: 'dag.ts',
        left: shared,
        right: shared,
      };
      const result: Record<string, unknown> = {
        nodes: [el],
        parsedFiles: [],
        skippedLanguages: {},
        fileCount: 1,
      };
      const { skipped } = makeWorkerResultCloneSafe(result, opts);
      expect(isStructuredCloneable(result)).toBe(true);
      const out = (result.nodes as Array<Record<string, unknown>>)[0];
      // Record is KEPT (stripped), not dropped as "unsalvageable".
      expect(out).toBeDefined();
      expect(skipped[0].reason).toContain('stripped');
      const left = out.left as Record<string, unknown>;
      const right = out.right as Record<string, unknown>;
      expect(left.tag).toBe('s'); // legitimate data preserved
      expect(left.leaked).toBeUndefined(); // function value stripped to undefined
      // DAG shape preserved — the two aliases resolve to the SAME stripped copy.
      expect(left).toBe(right);
    });

    it('terminates on a self-referential (cyclic) record', () => {
      const cyc: Record<string, unknown> = { id: 'c', filePath: 'c.ts', bad: () => 1 };
      cyc.self = cyc;
      const result: Record<string, unknown> = {
        nodes: [cyc],
        parsedFiles: [],
        skippedLanguages: {},
        fileCount: 1,
      };
      expect(() => makeWorkerResultCloneSafe(result, opts)).not.toThrow();
      expect(isStructuredCloneable(result)).toBe(true);
      const out = (result.nodes as Array<Record<string, unknown>>)[0];
      expect(out.self).toBe(out); // cycle preserved against the stripped copy
      expect(out.bad).toBeUndefined(); // function value stripped to undefined
    });
  });

  // U4 (#2112): single-pass scan rebuilds only the dirty array (from the first
  // dirty element on), and leaves every clean array untouched by identity.
  describe('single-pass identity preservation', () => {
    const opts = {
      dropWholeElement: new Set(['parsedFiles']),
      skipFields: new Set(['skippedPaths']),
    };

    it('reassigns only the dirty field; clean fields keep identity', () => {
      const cleanSymbols = [{ id: 's', filePath: 's.ts' }];
      const cleanPrefix = { id: 'n0', properties: { filePath: 'n0.ts' } };
      const dirtyNodes = [
        cleanPrefix,
        { id: 'n1', properties: { filePath: 'n1.ts', bad: () => 1 } },
      ];
      const result: Record<string, unknown> = {
        nodes: dirtyNodes,
        symbols: cleanSymbols,
        parsedFiles: [],
        skippedLanguages: {},
        fileCount: 2,
      };
      makeWorkerResultCloneSafe(result, opts);
      expect(result.symbols).toBe(cleanSymbols); // clean field untouched (identity)
      expect(result.nodes).not.toBe(dirtyNodes); // dirty field rebuilt
      const outNodes = result.nodes as Array<Record<string, unknown>>;
      expect(outNodes[0]).toBe(cleanPrefix); // clean prefix copied by reference
      expect(isStructuredCloneable(result)).toBe(true);
    });
  });

  // U7 (#2112): a ParsedNode is attributed to properties.filePath even when a
  // sibling child also carries a path-like key — the generic sweep alone could
  // return the wrong sibling's path.
  describe('findFilePath attribution (via skip reporting)', () => {
    const opts = {
      dropWholeElement: new Set(['parsedFiles']),
      skipFields: new Set(['skippedPaths']),
    };

    it('prefers properties.filePath over a sibling child path key', () => {
      const result: Record<string, unknown> = {
        nodes: [
          {
            id: 'n',
            meta: { file: 'sibling-wrong.ts' }, // sibling child with a path-like key, declared first
            properties: { filePath: 'right.ts', bad: () => 1 },
          },
        ],
        parsedFiles: [],
        skippedLanguages: {},
        fileCount: 1,
      };
      const { skipped } = makeWorkerResultCloneSafe(result, opts);
      expect(skipped).toHaveLength(1);
      expect(skipped[0].path).toBe('right.ts'); // not 'sibling-wrong.ts'
    });

    it('uses a top-level filePath when present', () => {
      const result: Record<string, unknown> = {
        parsedFiles: [{ filePath: 'top.c', captureSideChannel: { leaked: () => 1 } }],
        nodes: [],
        skippedLanguages: {},
        fileCount: 1,
      };
      const { skipped } = makeWorkerResultCloneSafe(result, opts);
      expect(skipped[0].path).toBe('top.c');
    });
  });

  // C12 (#2112): contract — a representative ParseWorkerResult must be
  // structured-cloneable. Typed as ParseWorkerResult so a NEW field added to
  // the result shape forces this test to be updated (compile error until it is),
  // and the runtime assert catches a field whose type becomes non-cloneable.
  describe('ParseWorkerResult clone contract', () => {
    it('a representative result is structured-cloneable', () => {
      const result: ParseWorkerResult = {
        nodes: [
          {
            id: 'func:src/a.ts#foo',
            label: 'Function',
            properties: {
              name: 'foo',
              filePath: 'src/a.ts',
              startLine: 1,
              endLine: 3,
              language:
                'typescript' as ParseWorkerResult['nodes'][number]['properties']['language'],
              isExported: true,
            },
          },
        ],
        relationships: [],
        symbols: [],
        calls: [],
        assignments: [],
        routes: [],
        fetchCalls: [],
        fetchWrapperDefs: [],
        decoratorRoutes: [],
        routerIncludes: [],
        routerImports: [],
        routerModuleAliases: [],
        toolDefs: [],
        ormQueries: [],
        constructorBindings: [],
        fileScopeBindings: [],
        parsedFiles: [],
        skippedLanguages: { ada: 2 },
        skippedPaths: [{ path: 'x.ts', reason: 'prior' }],
        fileCount: 1,
      };
      expect(isStructuredCloneable(result)).toBe(true);
    });
  });
});
