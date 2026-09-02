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
        expect(rows.length).toBe(25);
        const resolved = rows
          .filter((row) => row.address !== null && row.address !== undefined)
          .map((row) => row.address as string)
          .sort();
        // `audit.v1` is deliberately NOT here: it is a `${key:default}`, and a
        // default the configuration can override is not an identity.
        //
        // `orders.queue` and `orders.v1` appear TWICE each, and that is the
        // point rather than a duplicate. Each is named by two brokers — a
        // Rabbit listener and a JMS publish, a Kafka pair and an unrelated
        // Rabbit listener — and identity is `(broker, address)`, so each
        // spelling is two rows that both keep the join key. Address alone is
        // therefore not unique in this table; `(address, broker)` is.
        expect(resolved).toEqual([
          'kotlin.arrayof.v1',
          'kotlin.constant.v1',
          'orders-out-0',
          'orders.created',
          'orders.jms',
          'orders.queue',
          'orders.queue',
          'orders.v1',
          'orders.v1',
          'returns.v1',
          'shipments.v1',
        ]);
      });

      it('stores an unresolved address as NULL, not as the empty string', async () => {
        const [row] = await executeQuery(
          "MATCH (d:Destination) WHERE d.address IS NULL RETURN count(d) AS nulls, count(CASE WHEN d.resolution = 'unresolved-config-key' THEN 1 END) AS placeholders",
        );
        expect(row?.nulls).toBe(14);
        expect(row?.placeholders).toBe(5);
      });

      it('stores the refusal breakdown, which is what this feature is measured on', async () => {
        const rows = await executeQuery(
          'MATCH (d:Destination) WHERE d.address IS NULL RETURN d.resolution AS reason, count(d) AS n ORDER BY reason',
        );
        // Every value in this column comes from the resolver's own closed
        // refusal set. The phase contributes none of its own: it withdraws no
        // address, so it has no verdict to record here.
        expect(Object.fromEntries(rows.map((row) => [row.reason, Number(row.n)]))).toEqual({
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
        expect(Number(row?.total)).toBe(11);
        expect(Number(row?.withLine)).toBe(0);
      });

      it('produces no false join between two unresolved destinations', async () => {
        // The assertion the whole feature rests on, stated in the language a
        // cross-repository pass would actually use. `a.address = b.address` is
        // never true when both are NULL, so an unresolved destination cannot
        // match any other row — which is the property being asserted.
        const [row] = await executeQuery(
          'MATCH (a:Destination), (b:Destination) WHERE a.address = b.address AND a.broker = b.broker AND a.id <> b.id RETURN count(*) AS falseJoins',
        );
        expect(row?.falseJoins).toBe(0);

        // Stated the other way round, because the query above would also pass
        // if the table were empty: every row that shares an ADDRESS with
        // another differs from it by BROKER, and there are exactly the four
        // such rows this fixture writes on purpose (`orders.queue` and
        // `orders.v1`, two brokers each). Both halves are needed — the first
        // says the identity is not overloaded, the second says the identity is
        // still the thing that separates a real pair from a coincidence.
        const shared = await executeQuery(
          'MATCH (a:Destination), (b:Destination) WHERE a.address = b.address AND a.id <> b.id RETURN a.address AS address, a.broker AS mine, b.broker AS theirs ORDER BY address, mine',
        );
        expect(shared).toHaveLength(4);
        for (const pair of shared) expect(pair.mine).not.toBe(pair.theirs);
        expect(shared.map((pair) => pair.address)).toEqual([
          'orders.queue',
          'orders.queue',
          'orders.v1',
          'orders.v1',
        ]);
      });

      it('joins a publisher and a subscriber on the resolved address', async () => {
        const rows = await executeQuery(
          "MATCH (m)-[r:CodeRelation]->(d:Destination) WHERE d.address = 'orders.v1' AND d.broker = 'kafka' RETURN r.type AS type, m.name AS name ORDER BY name",
        );
        const types = new Set(rows.map((row) => row.type as string));
        expect(types).toEqual(new Set(['CONSUMES_FROM', 'PUBLISHES_TO']));
        const names = rows.map((row) => row.name as string);
        expect(names).toContain('publishLiteral');
        expect(names).toContain('consumeLiteral');
      });

      it('KEEPS that pair joined when a stranger names the same word on another broker', async () => {
        // THE regression, after the round trip. `UnrelatedRabbitConsumer`
        // listens on a Rabbit queue it happened to call `orders.v1`. While the
        // address alone keyed the node, that one file withdrew the address from
        // all three sites, re-keyed every one of them by source location, and
        // the Kafka pair above stopped being connected — a report asking "who
        // reads what this service publishes" answered nothing.
        const rows = await executeQuery(
          "MATCH (d:Destination) WHERE d.address = 'orders.v1' RETURN d.broker AS broker, d.id AS id, d.filePath AS filePath ORDER BY broker",
        );
        expect(rows.map((row) => row.broker)).toEqual(['kafka', 'rabbit']);
        expect(new Set(rows.map((row) => row.id)).size).toBe(2);
        // Both connect, so neither is stamped with a file. The stranger's node
        // is as much a first-class destination as the pair's.
        for (const row of rows) expect(row.filePath).toBeNull();

        // The pair's node carries both directions from two different files; the
        // stranger's carries one subscription and no publish, so the two-hop
        // walk between the JMS/Kafka publisher and this listener finds nothing.
        const stranger = await executeQuery(
          "MATCH (m)-[r:CodeRelation]->(d:Destination) WHERE d.address = 'orders.v1' AND d.broker = 'rabbit' RETURN r.type AS type, m.filePath AS filePath",
        );
        expect(stranger.map((row) => row.type)).toEqual(['CONSUMES_FROM']);
        expect(String(stranger[0]?.filePath)).toContain('UnrelatedRabbitConsumer.java');
      });

      it('keeps two brokers on one address as two rows that BOTH keep the address', async () => {
        // `@RabbitListener(queues = "orders.queue")` and
        // `jmsTemplate.convertAndSend("orders.queue", payload)` name one string
        // over two brokers. They are two rows because the broker is in the id,
        // not because the address was taken away from either of them — the
        // earlier rule withdrew it from both and this query returned two NULLs.
        const rows = await executeQuery(
          "MATCH (d:Destination) WHERE d.name = 'orders.queue' RETURN d.address AS address, d.broker AS broker, d.resolution AS resolution ORDER BY d.broker",
        );
        expect(rows).toEqual([
          { address: 'orders.queue', broker: 'jms', resolution: 'literal' },
          { address: 'orders.queue', broker: 'rabbit', resolution: 'literal' },
        ]);

        // Both sides still have their own edge — the publish and the
        // subscription are real facts — and they land on two different nodes.
        const edges = await executeQuery(
          "MATCH (m)-[r:CodeRelation]->(d:Destination) WHERE d.address = 'orders.queue' RETURN r.type AS type, d.id AS destination ORDER BY type",
        );
        expect(edges.map((row) => row.type)).toEqual(['CONSUMES_FROM', 'PUBLISHES_TO']);
        expect(new Set(edges.map((row) => row.destination)).size).toBe(2);
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
