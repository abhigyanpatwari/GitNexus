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
        expect(rows.length).toBe(24);
        const resolved = rows
          .filter((row) => row.address !== null && row.address !== undefined)
          .map((row) => row.address as string)
          .sort();
        // `audit.v1` is deliberately NOT here: it is a `${key:default}`, and a
        // default the configuration can override is not an identity.
        //
        // Neither is `orders.queue`: a Rabbit listener and a JMS publish claim
        // that name over two different brokers, so both sides are keyed by
        // site and neither carries the join key. It is two of the NULL rows
        // below, not one resolved row here.
        expect(resolved).toEqual([
          'kotlin.arrayof.v1',
          'kotlin.constant.v1',
          'orders-out-0',
          'orders.created',
          'orders.jms',
          'orders.v1',
          'returns.v1',
          'shipments.v1',
        ]);
      });

      it('stores an unresolved address as NULL, not as the empty string', async () => {
        const [row] = await executeQuery(
          "MATCH (d:Destination) WHERE d.address IS NULL RETURN count(d) AS nulls, count(CASE WHEN d.resolution = 'unresolved-config-key' THEN 1 END) AS placeholders",
        );
        expect(row?.nulls).toBe(16);
        expect(row?.placeholders).toBe(5);
      });

      it('stores the refusal breakdown, which is what this feature is measured on', async () => {
        const rows = await executeQuery(
          'MATCH (d:Destination) WHERE d.address IS NULL RETURN d.resolution AS reason, count(d) AS n ORDER BY reason',
        );
        expect(Object.fromEntries(rows.map((row) => [row.reason, Number(row.n)]))).toEqual({
          // Not a resolver refusal — no candidate declined this address, the
          // PHASE withdrew it because two brokers claimed it. It shares the
          // column so that the one query a reader writes finds both kinds.
          'broker-conflict': 2,
          'overridable-config-default': 4,
          'spel-expression': 2,
          'unescaped-interpolation': 3,
          'unresolved-config-key': 5,
        });
      });

      it('keeps a `${key:default}` distinguishable from a bare `${key}` after the round trip', async () => {
        const rows = await executeQuery(
          "MATCH (d:Destination) WHERE d.configDefault = 'events' RETURN d.configKey AS key ORDER BY key",
        );
        // Two DIFFERENT keys that share a fallback. Substituting the default
        // merged them into one `Destination:events` node.
        expect(rows.map((row) => row.key)).toEqual([
          'app.messaging.archive-topic',
          'app.messaging.report-topic',
        ]);
      });

      it('gives a resolved destination NULL lines, not line -1', async () => {
        const [row] = await executeQuery(
          'MATCH (d:Destination) WHERE d.address IS NOT NULL RETURN count(d) AS total, count(d.startLine) AS withLine',
        );
        // A resolved destination has no location at all — the same fact
        // `filePath` records — so the two columns must agree.
        expect(Number(row?.total)).toBe(8);
        expect(Number(row?.withLine)).toBe(0);
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

      it('stores the broker conflict instead of dropping it at the DB boundary', async () => {
        // The phase wrote `brokerConflict` and a comment said "a query can
        // filter on it", but the property was in neither DESTINATION_SCHEMA nor
        // the CSV writer, so it was dropped silently and this very query raised
        // a binder error.
        //
        // The disagreement is now what COSTS the two sides their shared node,
        // which makes surviving the round trip the only way a reader can find
        // out why the address vanished. Two rows, one per site, both with the
        // address withdrawn and both naming the same two brokers.
        const rows = await executeQuery(
          'MATCH (d:Destination) WHERE d.brokerConflict IS NOT NULL RETURN d.address AS address, d.name AS name, d.brokerConflict AS conflict, d.broker AS broker ORDER BY d.broker',
        );
        expect(rows).toEqual([
          { address: null, name: 'orders.queue', conflict: 'jms,rabbit', broker: 'jms' },
          { address: null, name: 'orders.queue', conflict: 'jms,rabbit', broker: 'rabbit' },
        ]);
      });

      it('leaves the two sides of a broker conflict UNJOINABLE after the round trip', async () => {
        // The point of the split, stated in the query a cross-repository pass
        // would actually run. A `brokerConflict` FLAG did not survive this
        // walk: the edges still met on one node and the traversal reported a
        // connection between a Rabbit listener and a JMS publish. Now nothing
        // matches on the address at all.
        const [byAddress] = await executeQuery(
          "MATCH (m)-[r:CodeRelation]->(d:Destination) WHERE d.address = 'orders.queue' RETURN count(r) AS edges",
        );
        expect(Number(byAddress?.edges)).toBe(0);

        // Both sides still have their own edge — the publish and the
        // subscription are real facts — but onto two different nodes.
        const rows = await executeQuery(
          'MATCH (m)-[r:CodeRelation]->(d:Destination) WHERE d.brokerConflict IS NOT NULL RETURN r.type AS type, d.id AS destination ORDER BY type',
        );
        expect(rows.map((row) => row.type)).toEqual(['CONSUMES_FROM', 'PUBLISHES_TO']);
        expect(new Set(rows.map((row) => row.destination)).size).toBe(2);
      });

      it('links an unresolved placeholder to its configuration keys', async () => {
        const rows = await executeQuery(
          "MATCH (d:Destination)-[r:CodeRelation]->(p:Property) WHERE r.type = 'USES' RETURN p.name AS key",
        );
        expect(rows.length).toBeGreaterThan(0);
        // A `${key:default}` links to its key's Property nodes too — a default
        // changes nothing about where the real value comes from — so both keys
        // that are actually declared in the fixture's YAML appear. A key
        // declared nowhere links to nothing, which is normal: it may come from
        // an environment variable or a config server.
        expect(new Set(rows.map((row) => row.key))).toEqual(
          new Set(['app.messaging.shared-topic', 'app.messaging.audit-topic']),
        );
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
