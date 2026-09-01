import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { executeQuery } from '../../src/core/lbug/lbug-adapter.js';
import { PARSE_CACHE_VERSION, type ParseCache } from '../../src/storage/parse-cache.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'spring-destination-app');

/**
 * The database half of the destination keying rule, which no in-process test
 * can see.
 *
 * Two things only show up here:
 *
 *  1. The DISK-BACKED ParsedFile path. A `parseCache` with a `storagePath` — so,
 *     every real run of the CLI — flushes worker ParsedFiles to disk and hands
 *     the parse phase back an EMPTY `parsedFiles`. A phase that iterated it
 *     found nothing in production while every direct-pipeline test passed. This
 *     suite runs the pipeline the way the CLI does, so that asymmetry cannot
 *     come back silently.
 *
 *  2. NULL versus the empty string. The in-memory rule is that an unresolved
 *     destination has no `address` PROPERTY, but the CSV column has to hold
 *     something, and an empty string is a value that another empty string
 *     matches. If those loaded as `''` rather than NULL, two services that each
 *     merely wrote a placeholder would join on it after the round trip — the
 *     exact false connection the id rule prevents, reintroduced one layer down.
 */
withTestLbugDB(
  'spring-destinations',
  () => {
    describe('Destination round trip through LadybugDB', () => {
      it('persists every destination the pipeline resolved', async () => {
        const rows = await executeQuery(
          'MATCH (d:Destination) RETURN d.address AS address, d.broker AS broker, d.resolution AS resolution ORDER BY d.id',
        );
        expect(rows.length).toBe(13);
        const resolved = rows
          .filter((row) => row.address !== null && row.address !== undefined)
          .map((row) => row.address as string)
          .sort();
        expect(resolved).toEqual([
          'audit.v1',
          'kotlin.arrayof.v1',
          'orders-out-0',
          'orders.created',
          'orders.jms',
          'orders.queue',
          'orders.v1',
          'returns.v1',
          'shipments.v1',
        ]);
      });

      it('stores an unresolved address as NULL, not as the empty string', async () => {
        const [row] = await executeQuery(
          "MATCH (d:Destination) WHERE d.address IS NULL RETURN count(d) AS nulls, count(CASE WHEN d.resolution = 'unresolved-config-key' THEN 1 END) AS placeholders",
        );
        expect(row?.nulls).toBe(4);
        expect(row?.placeholders).toBe(4);
      });

      it('produces no false join between two unresolved destinations', async () => {
        // The assertion the whole feature rests on, stated in the language a
        // cross-repository pass would actually use.
        const [row] = await executeQuery(
          'MATCH (a:Destination), (b:Destination) WHERE a.address = b.address AND a.id <> b.id RETURN count(*) AS falseJoins',
        );
        expect(row?.falseJoins).toBe(0);
      });

      it('joins a publisher and a subscriber on the resolved address', async () => {
        const rows = await executeQuery(
          "MATCH (m)-[r:CodeRelation]->(d:Destination) WHERE d.address = 'orders.v1' RETURN r.type AS type, m.name AS name ORDER BY name",
        );
        const types = new Set(rows.map((row) => row.type as string));
        expect(types).toEqual(new Set(['CONSUMES_FROM', 'PUBLISHES_TO']));
        const names = rows.map((row) => row.name as string);
        expect(names).toContain('publishLiteral');
        expect(names).toContain('consumeLiteral');
      });

      it('links an unresolved placeholder to its configuration keys', async () => {
        const rows = await executeQuery(
          "MATCH (d:Destination)-[r:CodeRelation]->(p:Property) WHERE r.type = 'USES' RETURN p.name AS key",
        );
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) expect(row.key).toBe('app.messaging.shared-topic');
      });
    });
  },
  {
    beforeFTS: async (dbPath) => {
      const storageDir = path.dirname(dbPath);
      // A cold cache WITH a storagePath: this is what makes the parse phase use
      // the disk-backed ParsedFile store, which is the production shape.
      const cache: ParseCache = {
        version: PARSE_CACHE_VERSION,
        entries: new Map(),
        usedKeys: new Set(),
        storagePath: path.join(storageDir, 'parse-cache'),
        onDiskKeys: new Set(),
      };
      const result = await runPipelineFromRepo(FIXTURE, () => {}, {
        parseCache: cache,
        workerPoolSize: 1,
      });
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await adapter.loadGraphToLbug(result.graph, FIXTURE, storageDir);
    },
    timeout: 180_000,
  },
);
