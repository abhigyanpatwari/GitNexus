import { describe, expect, it } from 'vitest';

import { dropDanglingInFileOwnerEdges } from '../../src/core/ingestion/workers/owner-edge-guard.js';
import type { ParseWorkerResult } from '../../src/core/ingestion/workers/parse-worker.js';

type Slice = Pick<ParseWorkerResult, 'nodes' | 'relationships'>;
type Rel = Slice['relationships'][number];

const node = (id: string): Slice['nodes'][number] =>
  ({ id, label: id.slice(0, id.indexOf(':')), properties: {} }) as Slice['nodes'][number];

const rel = (type: Rel['type'], sourceId: string, targetId: string): Rel => ({
  id: `${type}:${sourceId}->${targetId}`,
  sourceId,
  targetId,
  type,
  confidence: 1,
  reason: '',
});

const summarize = (slice: Slice): string[] =>
  slice.relationships.map((r) => `${r.type} ${r.sourceId} -> ${r.targetId}`);

describe('dropDanglingInFileOwnerEdges', () => {
  it('re-attaches a member whose in-file owner was never emitted to its File', () => {
    const slice: Slice = {
      nodes: [node('Function:types/lib.d.ts:m.connect')],
      relationships: [
        rel('HAS_METHOD', "Trait:types/lib.d.ts:'m'", 'Function:types/lib.d.ts:m.connect'),
      ],
    };
    dropDanglingInFileOwnerEdges(slice, 'types/lib.d.ts', 0, 0);
    expect(summarize(slice)).toEqual([
      'DEFINES File:types/lib.d.ts -> Function:types/lib.d.ts:m.connect',
    ]);
  });

  it('drops the edge without duplicating an existing DEFINES', () => {
    const slice: Slice = {
      nodes: [node('Function:a.mjs:Context'), node('Function:a.mjs:Context.REPO')],
      relationships: [
        rel('DEFINES', 'File:a.mjs', 'Function:a.mjs:Context.REPO'),
        rel('HAS_METHOD', 'Const:a.mjs:Context', 'Function:a.mjs:Context.REPO'),
        rel('HAS_PROPERTY', 'Const:a.mjs:Context', 'Property:a.mjs:Context.REF'),
      ],
    };
    slice.nodes.push(node('Property:a.mjs:Context.REF'));
    dropDanglingInFileOwnerEdges(slice, 'a.mjs', 0, 0);
    expect(summarize(slice)).toEqual([
      'DEFINES File:a.mjs -> Function:a.mjs:Context.REPO',
      'DEFINES File:a.mjs -> Property:a.mjs:Context.REF',
    ]);
  });

  it('keeps edges whose owner the file emitted, owners in other files, and non-member edges', () => {
    const slice: Slice = {
      nodes: [node('Const:a.ts:svc'), node('Method:a.ts:load'), node('Method:a.ts:Server.run')],
      relationships: [
        rel('HAS_METHOD', 'Const:a.ts:svc', 'Method:a.ts:load'),
        rel('HAS_METHOD', 'Struct:b.ts:Server', 'Method:a.ts:Server.run'),
        rel('DECLARES', 'Const:a.ts:gone', 'Method:a.ts:load'),
      ],
    };
    const before = summarize(slice);
    dropDanglingInFileOwnerEdges(slice, 'a.ts', 0, 0);
    expect(summarize(slice)).toEqual(before);
  });

  it('does not treat a path that merely shares a prefix as the same file', () => {
    const slice: Slice = {
      nodes: [node('Method:a.ts:run')],
      relationships: [rel('HAS_METHOD', 'Class:a.ts.bak:Foo', 'Method:a.ts:run')],
    };
    const before = summarize(slice);
    dropDanglingInFileOwnerEdges(slice, 'a.ts', 0, 0);
    expect(summarize(slice)).toEqual(before);
  });

  it('only inspects the current file slice', () => {
    const slice: Slice = {
      nodes: [node('Method:prev.ts:m'), node('Method:cur.ts:m')],
      relationships: [
        rel('HAS_METHOD', 'Const:cur.ts:Owner', 'Method:prev.ts:m'),
        rel('HAS_METHOD', 'Const:cur.ts:Owner', 'Method:cur.ts:m'),
      ],
    };
    dropDanglingInFileOwnerEdges(slice, 'cur.ts', 1, 1);
    expect(summarize(slice)).toEqual([
      'HAS_METHOD Const:cur.ts:Owner -> Method:prev.ts:m',
      'DEFINES File:cur.ts -> Method:cur.ts:m',
    ]);
  });

  it('treats an owner emitted earlier in the same file as present', () => {
    const slice: Slice = {
      nodes: [node('Class:cur.ts:Foo'), node('Method:cur.ts:Foo.m')],
      relationships: [rel('HAS_METHOD', 'Class:cur.ts:Foo', 'Method:cur.ts:Foo.m')],
    };
    dropDanglingInFileOwnerEdges(slice, 'cur.ts', 0, 0);
    expect(summarize(slice)).toEqual(['HAS_METHOD Class:cur.ts:Foo -> Method:cur.ts:Foo.m']);
  });
});
