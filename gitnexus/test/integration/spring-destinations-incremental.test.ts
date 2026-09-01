/**
 * The SECOND analyze.
 *
 * Every other test for this feature indexes from scratch exactly once, and
 * that gap is precisely why both halves of the incremental defect survived
 * review: a resolved `Destination` stores no `filePath`, which is what stops
 * the per-file `DETACH DELETE ... WHERE n.filePath IN [...]` cutting a node
 * shared across files — and which also made the writeback unable to ADD one or
 * to REMOVE one.
 *
 *   Additions were lost. `extractChangedSubgraph` includes a node only when
 *   its filePath is in the write set or it is graph-wide, and `Destination`
 *   was neither. Adding a file that published to a NEW topic reported
 *   `added=1`, exited 0, printed no warning, and put neither the destination
 *   nor the publisher's edge into the graph. After the first index every newly
 *   introduced topic was invisible until a full rebuild.
 *
 *   Removals never happened. When the last file naming an address stopped
 *   naming it, the node survived as an edgeless orphan and accumulated on
 *   every run — still carrying `address`, the cross-repository join key, and
 *   still visible through the server API.
 *
 * This suite drives the real `runFullAnalysis` three times over a real git
 * repository and asserts the DB after each, which is the only place either
 * defect is observable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { executeQuery, closeLbug, initLbug } from '../../src/core/lbug/lbug-adapter.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

const isWin = process.platform === 'win32';

const CONSUMER = `package com.example.messaging;

import org.springframework.kafka.annotation.KafkaListener;

public class OrderConsumer {
    @KafkaListener(topics = "orders.v1")
    public void consume(String payload) {}
}
`;

const PUBLISHER = `package com.example.messaging;

import org.springframework.kafka.core.KafkaTemplate;

public class OrderPublisher {
    private final KafkaTemplate<String, String> kafkaTemplate;

    public OrderPublisher(KafkaTemplate<String, String> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    public void publish(String payload) {
        kafkaTemplate.send("orders.v1", payload);
    }
}
`;

/** The file added by the second analyze: a topic no other file names. */
const LATE_PUBLISHER = `package com.example.messaging;

import org.springframework.kafka.core.KafkaTemplate;

public class ShipmentPublisher {
    private final KafkaTemplate<String, String> kafkaTemplate;

    public ShipmentPublisher(KafkaTemplate<String, String> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    public void publish(String payload) {
        kafkaTemplate.send("shipments.v1", payload);
    }
}
`;

describe.skipIf(isWin)('Destination across a second, incremental analyze', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepo: Awaited<ReturnType<typeof createTempDir>>;
  let repo: string;
  let savedHome: string | undefined;
  const srcDir = (): string =>
    path.join(repo, 'src', 'main', 'java', 'com', 'example', 'messaging');

  const commit = (message: string): void => {
    execSync(`git add -A && git -c user.name=t -c user.email=t@t commit -q -m ${message}`, {
      cwd: repo,
      stdio: 'pipe',
    });
  };

  /** Run analyze and report whether the INCREMENTAL writeback branch ran. */
  const analyze = async (): Promise<{ incremental: boolean }> => {
    let incremental = false;
    await runFullAnalysis(
      repo,
      {},
      {
        onProgress: (_phase: string, _pct: number, message?: string) => {
          // Emitted only by the incremental writeback branch. Without this the
          // whole suite could pass vacuously on a silent full rebuild.
          if (message?.startsWith('Removing rows for changed files')) incremental = true;
        },
      },
    );
    return { incremental };
  };

  const openDb = async (): Promise<void> => {
    const { lbugPath } = getStoragePaths(repo);
    await initLbug(lbugPath);
  };

  const destinations = async (): Promise<
    Array<{ name: string; address: string | null; edges: number }>
  > => {
    await openDb();
    try {
      const rows = await executeQuery(
        'MATCH (d:Destination) OPTIONAL MATCH (m)-[r:CodeRelation]->(d) ' +
          'RETURN d.name AS name, d.address AS address, count(r) AS edges ORDER BY name',
      );
      return rows.map((row) => ({
        name: String(row.name),
        address: (row.address ?? null) as string | null,
        edges: Number(row.edges ?? 0),
      }));
    } finally {
      await closeLbug();
    }
  };

  beforeAll(async () => {
    tmpHome = await createTempDir('gn-dest-incr-home-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    tmpRepo = await createTempDir('gn-dest-incr-repo-');
    repo = tmpRepo.dbPath;
    execSync('git init -q', { cwd: repo, stdio: 'pipe' });
    await fs.mkdir(srcDir(), { recursive: true });
    await fs.writeFile(path.join(srcDir(), 'OrderConsumer.java'), CONSUMER);
    await fs.writeFile(path.join(srcDir(), 'OrderPublisher.java'), PUBLISHER);
    commit('init');
  }, 60_000);

  afterAll(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpRepo?.cleanup();
    await tmpHome?.cleanup();
  });

  it('indexes the shared destination on the first, from-scratch run', async () => {
    await analyze();
    const rows = await destinations();
    expect(rows).toEqual([{ name: 'orders.v1', address: 'orders.v1', edges: 2 }]);
  }, 180_000);

  it('ADDS a destination introduced by a new file on the second, incremental run', async () => {
    await fs.writeFile(path.join(srcDir(), 'ShipmentPublisher.java'), LATE_PUBLISHER);
    commit('add-publisher');

    const { incremental } = await analyze();
    expect(incremental).toBe(true);

    const rows = await destinations();
    // The defect: `shipments.v1` was absent entirely and ShipmentPublisher had
    // no PUBLISHES_TO edge, with exit 0 and no warning.
    expect(rows).toEqual([
      { name: 'orders.v1', address: 'orders.v1', edges: 2 },
      { name: 'shipments.v1', address: 'shipments.v1', edges: 1 },
    ]);
  }, 180_000);

  it('REMOVES a destination whose last referrer is gone, leaving no orphan', async () => {
    await fs.rm(path.join(srcDir(), 'ShipmentPublisher.java'));
    commit('drop-publisher');

    const { incremental } = await analyze();
    expect(incremental).toBe(true);

    const rows = await destinations();
    // The mirror defect: `shipments.v1` survived as an edgeless orphan that
    // still carried `address`, and accumulated on every subsequent run. The
    // untouched half must be intact — deleting the layer without re-including
    // it would show up here as orders.v1 losing its edges or vanishing.
    expect(rows).toEqual([{ name: 'orders.v1', address: 'orders.v1', edges: 2 }]);
  }, 180_000);
});
