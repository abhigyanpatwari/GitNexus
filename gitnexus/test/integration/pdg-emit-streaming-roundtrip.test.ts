/**
 * Integration test: streamed PDG-emit manifest round-trips the bulk-COPY load
 * path (issue #2202 U5).
 *
 * Simulates the streaming case end-to-end at the persistence boundary: the
 * BasicBlock + intra-file PDG-edge layer is flushed to CSV by a real
 * `PdgEmitSink` (so the in-memory graph holds ZERO BasicBlocks, exactly as in a
 * streamed run), and `loadGraphToLbug` is handed the resulting manifest. Asserts
 * the BasicBlock nodes + every PDG edge type land in the DB via the manifest,
 * alongside the structural graph — and that there is no double-COPY.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { PdgEmitSink } from '../../src/core/lbug/pdg-emit-sink.js';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';

let tmpBase: string;
let storagePath: string;

const FILE_ID = 'File:src/a.ts';
const BB = (i: number) => `BasicBlock:src/a.ts:1:0:${i}`;
const PDG_TYPES = ['CFG', 'REACHING_DEF', 'CDG', 'POST_DOMINATE', 'TAINTED', 'SANITIZES'] as const;

beforeAll(async () => {
  // mkdtemp (unpredictable, unique) — not a predictable os-temp path.
  tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-pdg-stream-rt-'));
  storagePath = path.join(tmpBase, '.gitnexus');
  await fs.mkdir(path.join(storagePath, 'lbug'), { recursive: true });

  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  await adapter.initLbug(path.join(storagePath, 'lbug'));

  // Structural graph — NO BasicBlock nodes (they were "streamed out").
  const graph = createKnowledgeGraph();
  graph.addNode({
    id: FILE_ID,
    label: 'File',
    properties: { name: 'a.ts', filePath: 'src/a.ts' },
  });

  // Real sink → real manifest: route 3 BasicBlocks + one edge of each PDG type.
  const sink = new PdgEmitSink(graph, path.join(storagePath, 'pdg-csv'));
  for (let i = 0; i < 3; i++) {
    const node: GraphNode = {
      id: BB(i),
      label: 'BasicBlock',
      properties: {
        name: '',
        filePath: 'src/a.ts',
        startLine: i + 1,
        endLine: i + 2,
        text: `b${i}`,
      },
    };
    sink.addNode(node);
  }
  for (const type of PDG_TYPES) {
    const rel: GraphRelationship = {
      id: `${type}:0->1`,
      sourceId: BB(0),
      targetId: BB(1),
      type,
      confidence: 1,
      reason: type === 'REACHING_DEF' ? 'x' : type === 'CDG' ? 'T' : `${type}-edge`,
    };
    sink.addRelationship(rel);
  }
  const manifest = sink.finalize();

  // The sink offloaded the whole PDG layer — the graph has only the File node.
  expect(graph.nodeCount).toBe(1);

  await adapter.loadGraphToLbug(graph, tmpBase, storagePath, undefined, manifest);
});

afterAll(async () => {
  try {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.closeLbug();
  } catch {
    /* may not have opened */
  }
  if (tmpBase) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.rm(tmpBase, { recursive: true, force: true });
        return;
      } catch {
        if (attempt < 4) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }
});

describe('streamed PDG manifest → bulk COPY (#2202 U5)', () => {
  it('BasicBlock nodes from the manifest land in the DB with span + text', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const rows = await adapter.executeQuery(
      'MATCH (n:BasicBlock) RETURN n.id AS id, n.text AS text, n.startLine AS startLine ORDER BY n.id',
    );
    expect(rows).toHaveLength(3);
    expect(rows[0].id).toBe(BB(0));
    expect(rows[0].text).toBe('b0');
    expect(Number(rows[0].startLine)).toBe(1);
  });

  it('the structural graph (File node) loaded alongside the manifest', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const rows = await adapter.executeQuery(
      `MATCH (f:File {id: '${FILE_ID}'}) RETURN count(f) AS c`,
    );
    expect(Number(rows[0].c)).toBe(1);
  });

  it('every PDG edge type round-trips via the manifest (no double-COPY)', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    for (const type of PDG_TYPES) {
      const rows = await adapter.executeQuery(
        `MATCH (:BasicBlock)-[r:CodeRelation {type: '${type}'}]->(:BasicBlock) RETURN count(r) AS c`,
      );
      // Exactly one — not two (double-COPY would double these).
      expect(Number(rows[0].c), `${type} should round-trip exactly once`).toBe(1);
    }
  });

  it('REACHING_DEF carries its variable in reason (manifest path)', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const rows = await adapter.executeQuery(
      "MATCH (a:BasicBlock)-[r:CodeRelation {type: 'REACHING_DEF', reason: 'x'}]->(b:BasicBlock) RETURN a.id AS from, b.id AS to",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].from).toBe(BB(0));
    expect(rows[0].to).toBe(BB(1));
  });
});

describe('streamed PDG manifest → disjoint-key merge guard (#2202 review #3)', () => {
  // The merge in loadGraphToLbug assumes the streamed manifest and the
  // structural csvResult are disjoint: when streaming is on the in-memory graph
  // holds ZERO BasicBlocks, so streamAllCSVsToDisk emits no basicblock.csv and
  // the manifest is the sole source. A future BasicBlock-leak-into-graph would
  // make both sides carry a "BasicBlock" entry; silently overwriting one CSV
  // with the other would drop its rows. The guard fails loudly instead.

  it('throws when the manifest collides with a structural node CSV', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');

    // A graph that DOES contain a BasicBlock → streamAllCSVsToDisk emits a
    // structural basicblock.csv (the invariant-violation scenario).
    const leakyGraph = createKnowledgeGraph();
    leakyGraph.addNode({
      id: BB(0),
      label: 'BasicBlock',
      properties: { name: '', filePath: 'src/a.ts', startLine: 1, endLine: 2, text: 'leak' },
    });

    // A manifest that ALSO declares a BasicBlock node CSV → disjoint-key clash.
    const collideBase = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-pdg-collide-'));
    const collideStorage = path.join(collideBase, '.gitnexus');
    await fs.mkdir(collideStorage, { recursive: true });
    const sink = new PdgEmitSink(createKnowledgeGraph(), path.join(collideStorage, 'pdg-csv'));
    sink.addNode({
      id: BB(1),
      label: 'BasicBlock',
      properties: { name: '', filePath: 'src/a.ts', startLine: 3, endLine: 4, text: 'm' },
    });
    const manifest = sink.finalize();

    try {
      await expect(
        adapter.loadGraphToLbug(leakyGraph, collideBase, collideStorage, undefined, manifest),
      ).rejects.toThrow(/collides with a structural node CSV for "BasicBlock"/);
    } finally {
      await fs.rm(collideBase, { recursive: true, force: true });
    }
  });
});

describe('streamed PDG manifest → rel-pair collision guard (#2226 F3)', () => {
  // The rel-pair analogue of the node-CSV guard above, for the case Codex
  // flagged on PR #2226. The collision check was moved ahead of node COPY so the
  // serial escape hatch detects it before committing node rows; this asserts the
  // guard fires in BOTH the overlap (default) and serial paths.

  // A leaky graph carrying a structural BasicBlock→BasicBlock EDGE but NO
  // BasicBlock nodes: RelPairRouter derives the label from the `BasicBlock:` id
  // prefix, so the structural relsByPair gets a `BasicBlock|BasicBlock` pair
  // while nodeFiles stays empty — isolating the REL-pair collision from the
  // node-CSV one. The manifest declares the same pair via PdgEmitSink.
  const buildRelCollision = async (label: string) => {
    const leakyGraph = createKnowledgeGraph();
    leakyGraph.addRelationship({
      id: 'CFG:0->1-structural',
      sourceId: BB(0),
      targetId: BB(1),
      type: 'CFG',
      confidence: 1,
      reason: 'leak',
    });
    const base = await fs.mkdtemp(path.join(os.tmpdir(), `gitnexus-lbug-relcollide-${label}-`));
    const storage = path.join(base, '.gitnexus');
    await fs.mkdir(storage, { recursive: true });
    const sink = new PdgEmitSink(createKnowledgeGraph(), path.join(storage, 'pdg-csv'));
    sink.addRelationship({
      id: 'CFG:0->1-manifest',
      sourceId: BB(0),
      targetId: BB(1),
      type: 'CFG',
      confidence: 1,
      reason: 'manifest',
    });
    const manifest = sink.finalize();
    return { leakyGraph, base, storage, manifest };
  };

  it('throws on a rel-pair collision in the overlap (default) path', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const { leakyGraph, base, storage, manifest } = await buildRelCollision('overlap');
    try {
      await expect(
        adapter.loadGraphToLbug(leakyGraph, base, storage, undefined, manifest),
      ).rejects.toThrow(/collides with a structural relationship CSV for pair/);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('throws on a rel-pair collision in the serial (GITNEXUS_SERIAL_LBUG_LOAD=1) path', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const { leakyGraph, base, storage, manifest } = await buildRelCollision('serial');
    process.env.GITNEXUS_SERIAL_LBUG_LOAD = '1';
    try {
      await expect(
        adapter.loadGraphToLbug(leakyGraph, base, storage, undefined, manifest),
      ).rejects.toThrow(/collides with a structural relationship CSV for pair/);
    } finally {
      delete process.env.GITNEXUS_SERIAL_LBUG_LOAD;
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});
