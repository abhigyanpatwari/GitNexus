import { describe, expect, it } from 'vitest';
import {
  isDataCloneError,
  isStructuredCloneable,
  makeWorkerResultCloneSafe,
} from '../../src/core/ingestion/workers/clone-safety.js';

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

  describe('isDataCloneError', () => {
    it('matches the DataCloneError postMessage throws', () => {
      // Reproduce the EXACT failure the issue reported.
      let caught: unknown;
      try {
        const bad: Record<string, unknown> = {};
        bad.toString = Object.prototype.toString; // own native function value
        structuredClone(bad);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain('could not be cloned');
      expect(isDataCloneError(caught)).toBe(true);
    });

    it('does not match unrelated errors', () => {
      expect(isDataCloneError(new TypeError('nope'))).toBe(false);
      expect(isDataCloneError('a string')).toBe(false);
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
});
