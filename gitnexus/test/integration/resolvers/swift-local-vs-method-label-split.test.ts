/**
 * #2807 follow-up — a FUNCTION-LOCAL callable must keep its own graph node when
 * the def and the node disagree about the callable LABEL.
 *
 * Swift's structure phase emits a type's methods as `Function` nodes while the
 * scope extractor derives `Method` from the `@declaration.method` anchor. Every
 * key `resolveDefGraphId` builds is scoped to one label, so under that split the
 * position key (#2699) missed AND the fail-closed guard beside it could never
 * fire — the guard is scoped to the def's own label too, so it was unreachable
 * in exactly the case the sibling-label retry below it serves. The local then
 * fell through to that retry and was aliased onto the class method of the same
 * name.
 *
 * Measured before the fix, on this fixture: the local `func helper` inside
 * `Host.run` resolved to `Function:src/app.swift:Host.helper#1`, so the `sink()`
 * call in the LOCAL's body was emitted as an outgoing edge of the public
 * one-argument method — a caller that does not make that call, present in the
 * graph, in a file whose two `helper`s do not even share an arity.
 *
 * The two `helper`s are deliberately given DIFFERENT arities. Arity is the
 * disambiguator every name-keyed bridge lookup falls back on, so a fixture where
 * they matched could pass on a lookup that still cannot tell the two apart.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';
import { cleanupTempDirSync } from '../../helpers/test-db.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

const swiftAvailable = isLanguageAvailable(SupportedLanguages.Swift);

const FILE = 'src/app.swift';

/**
 * Line/column-sensitive: the local's node id encodes its declaration position
 * (`@8:8` — 0-based row 8, column 8), so reindenting or moving a line renames
 * that node. The inventory test below fails loudly rather than silently
 * measuring nothing if this fixture is edited.
 */
const SOURCE = `func sink(_ v: Int) -> Int { return v }
func probe(_ v: Int) -> Int { return v }

class Host {
    func helper(_ a: Int) -> Int {
        return probe(a)
    }
    func run(_ x: Int) -> Int {
        func helper(_ v: Int, _ w: Int) -> Int {
            return sink(v + w)
        }
        return helper(x, x)
    }
}
`;

const METHOD_HELPER = `Function:${FILE}:Host.helper#1`;
const LOCAL_HELPER = `Function:${FILE}:Host.run.helper@8:8#2`;
const RUN = `Function:${FILE}:Host.run#1`;
const SINK = `Function:${FILE}:sink`;
const PROBE = `Function:${FILE}:probe`;

describe.skipIf(!swiftAvailable)('a function-local callable keeps its own node (#2807)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-label-split-'));
    try {
      writeFixtureRepo(dir, { [FILE]: SOURCE });
      // CALLS resolution completes before the graph phases run and nothing here
      // reads what they produce.
      result = await runPipelineFromRepo(dir, () => {}, { skipGraphPhases: true });
    } finally {
      // Not a bare `rmSync`: a pipeline run can still hold a handle open when
      // this fires, which surfaces as EBUSY/EPERM on Windows — `force` does not
      // suppress that — and this suite runs in the sharded Windows CI.
      cleanupTempDirSync(dir);
    }
  }, 120000);

  /** Distinct CALLS targets emitted by one exact caller id, sorted. */
  const targetsFrom = (callerId: string): string[] =>
    [
      ...new Set(
        getRelationships(result, 'CALLS')
          .filter((edge) => edge.rel.sourceId === callerId)
          .map((edge) => edge.rel.targetId),
      ),
    ].sort();

  // Non-vacuity: the whole point is that the local and the method are TWO
  // nodes. If the structure phase ever stopped minting the local — or the
  // fixture drifted and renamed it — every edge assertion below would degrade
  // into an empty-vs-empty comparison and pass while measuring nothing.
  it('mints a distinct node for the method and for the function-local', () => {
    expect({
      method: result.graph.getNode(METHOD_HELPER) !== undefined,
      local: result.graph.getNode(LOCAL_HELPER) !== undefined,
      run: result.graph.getNode(RUN) !== undefined,
    }).toEqual({ method: true, local: true, run: true });
  });

  // The regression itself. Asserted as ONE object over both callers on purpose:
  // the defect moved an edge from one to the other, so checking either side
  // alone would let a fix that merely dropped the edge look correct.
  it('attributes each body’s call to the callable that actually contains it', () => {
    expect({
      [METHOD_HELPER]: targetsFrom(METHOD_HELPER),
      [LOCAL_HELPER]: targetsFrom(LOCAL_HELPER),
    }).toEqual({
      [METHOD_HELPER]: [PROBE],
      [LOCAL_HELPER]: [SINK],
    });
  });

  /**
   * KNOWN GAP, pinned so it cannot be mistaken for part of the fix above.
   *
   * `helper(x, x)` inside `run` still targets the one-argument METHOD instead of
   * the two-argument local. That is decided upstream of the graph bridge: the
   * free-call binding hands `emitFreeCallFallback` the class-member def
   * (`def:src/app.swift#5:4:Method:helper`), never the local's
   * (`def:src/app.swift#9:8:Method:helper`), so no def→node mapping can correct
   * it — both defs carry the same `qualifiedName` and the same label, and the
   * binding walk picks the member. Recorded here rather than fixed because it
   * lives in the scope walk, not in `resolveDefGraphId`.
   */
  it('KNOWN GAP: the call to the local still binds to the same-named method', () => {
    expect(targetsFrom(RUN)).toEqual([METHOD_HELPER]);
  });
});
