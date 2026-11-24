import { compareCodeUnits } from '../../compare.mjs';
import assert from 'node:assert/strict';
import { runPipelineFromRepo } from '../../../../dist/core/ingestion/pipeline.js';
import { runtimeParseIdentity, springFixture, withGraphDatabase } from '../spring-support.mjs';
import path from 'node:path';
import { executeQuery, closeLbug, initLbug } from '../../../../dist/core/lbug/lbug-adapter.js';
import { readFileResults } from '../../../../dist/storage/file-result-store.js';
import { execFileSync } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import { runFullAnalysis } from '../../../../dist/core/run-analyze.js';
import { getStoragePaths } from '../../../../dist/storage/repo-manager.js';
import { createTempDir } from '../../../../test/helpers/test-db.ts';
import { isDeepStrictEqual } from 'node:util';
export async function verifyDestinations() {
  const FIXTURE = springFixture('spring-destination-app');

  /**
   * End-to-end cover for the `springDestinations` phase: capture facts in,
   * `Destination` nodes and `CONSUMES_FROM` / `PUBLISHES_TO` edges out.
   *
   * The negative assertions carry as much weight here as the positive ones. The
   * whole feature turns on one rule — an address that did not resolve must not be
   * able to connect two services — and the test that proves it is the pair of
   * unrelated consumers that each write `${app.messaging.shared-topic}` and
   * nothing else. If those ever land on one node, every other assertion in this
   * file can pass while the graph reports a connection that does not exist.
   */
  // Spring destination resolution

  let destinations;
  let messagingEdges;
  const withAddress = (address) =>
    destinations.filter((node) => node.properties.address === address);

  /**
   * Nodes at one address on ONE broker — the exact identity.
   *
   * `withAddress` alone stopped being a unique lookup once the broker joined
   * the key: `orders.v1` is a Kafka topic AND an unrelated Rabbit queue in this
   * fixture, so an assertion that means "the Kafka topic" has to say so.
   */
  const withBrokerAddress = (broker, address) =>
    withAddress(address).filter((node) => node.properties.broker === broker);
  const edgesTo = (node) => messagingEdges.filter((edge) => edge.targetId === node.id);
  const sourceNames = (node) =>
    edgesTo(node)
      .map((edge) => String(result.graph.getNode(edge.sourceId)?.properties.name ?? edge.sourceId))
      .sort(compareCodeUnits);
  const result = await runPipelineFromRepo(FIXTURE, () => {}, {});
  destinations = [...result.graph.iterNodes()].filter((node) => node.label === 'Destination');
  messagingEdges = [...result.graph.iterRelationships()].filter(
    (edge) => edge.type === 'CONSUMES_FROM' || edge.type === 'PUBLISHES_TO',
  );
  // resolves a literal destination on both sides
  {
    const nodes = withBrokerAddress('kafka', 'orders.v1');
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0]?.properties.resolution, 'literal');
  }
  // joins a publisher and a subscriber that name the same address
  {
    // The reason the node is keyed by address: this connection is one hop.
    const [orders] = withBrokerAddress('kafka', 'orders.v1');
    assert.notEqual(orders, undefined);
    const names = sourceNames(orders);
    assert.ok(names.includes('publishLiteral'));
    assert.ok(names.includes('consumeLiteral'));
    const types = new Set(edgesTo(orders).map((edge) => edge.type));
    assert.deepStrictEqual([...types].sort(compareCodeUnits), ['CONSUMES_FROM', 'PUBLISHES_TO']);
  }
  // KEEPS that pair joined when a stranger names the same word on another broker

  // THE regression, end to end. `UnrelatedRabbitConsumer` listens on a Rabbit
  // queue it happened to call `orders.v1` and has nothing to do with the
  // Kafka pair above. While the address alone keyed the node, its mere
  // existence withdrew the address from all three sites and the pair — the
  // thing this feature exists to report — stopped being connected by a file
  // neither half of it knows about.
  const kafka = withBrokerAddress('kafka', 'orders.v1');
  const rabbit = withBrokerAddress('rabbit', 'orders.v1');
  assert.equal(kafka.length, 1);
  assert.equal(rabbit.length, 1);
  assert.notEqual(kafka[0]?.id, rabbit[0]?.id);

  // The pair still meets on ONE node, from two files.
  const pairSources = sourceNames(kafka[0]);
  assert.ok(pairSources.includes('publishLiteral'));
  assert.ok(pairSources.includes('consumeLiteral'));

  // The stranger is on its own node, alone, and is NOT on the pair's.
  assert.deepStrictEqual(sourceNames(rabbit[0]), ['consume']);
  assert.ok(!pairSources.includes('consume'));
  assert.deepStrictEqual(
    edgesTo(rabbit[0]).map((edge) => edge.type),
    ['CONSUMES_FROM'],
  );
  // resolves a constant reference and joins on it too
  {
    const nodes = withAddress('shipments.v1');
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0]?.properties.resolution, 'constant');
    const observed = sourceNames(nodes[0]);
    for (const row of ['consumeConstant', 'publishConstant'])
      assert.ok(
        observed.some((item) => isDeepStrictEqual(item, row)),
        'Missing row ' + JSON.stringify(row),
      );
  }
  // does NOT resolve a placeholder default, and keeps both key and default
  {
    // The default is written in the source, so it is read — but it holds only
    // while the key is not overridden, and configuration VALUES are absent from
    // this graph by design, so it cannot be an identity.
    assert.deepStrictEqual(withAddress('audit.v1'), []);
    const nodes = destinations.filter(
      (node) => node.properties.configKey === 'app.messaging.audit-topic',
    );
    // One Java consumer, one Kotlin consumer — two files, two nodes.
    assert.equal(nodes.length, 2);
    for (const node of nodes) {
      assert.equal(node.properties.resolution, 'overridable-config-default');
      assert.equal(node.properties.configDefault, 'audit.v1');
      assert.equal(node.properties.address, undefined);
    }
  }
  // does not merge two different keys that share a default

  // `${app.messaging.report-topic:events}` and
  // `${app.messaging.archive-topic:events}` collapsed onto one
  // `Destination:events` and reported a producer/consumer pair between two
  // services sharing nothing but a copy-pasted fallback.
  assert.deepStrictEqual(withAddress('events'), []);
  const shared = destinations.filter((node) => node.properties.configDefault === 'events');
  assert.equal(shared.length, 2);
  assert.equal(new Set(shared.map((node) => node.id)).size, 2);
  assert.deepStrictEqual(
    new Set(shared.map((node) => node.properties.configKey)),
    new Set(['app.messaging.report-topic', 'app.messaging.archive-topic']),
  );
  // emits one edge per element of an array-valued topics argument

  // `topics = {"orders.v1", "returns.v1"}` really does subscribe to two
  // places, so each gets its own edge and "who reads returns.v1" is one hop.
  const returns = withAddress('returns.v1');
  assert.equal(returns.length, 1);
  const consumers = sourceNames(returns[0]);
  assert.ok(consumers.includes('consumeMany'));
  assert.ok(sourceNames(withBrokerAddress('kafka', 'orders.v1')[0]).includes('consumeMany'));
  // reads the Kotlin bracket and arrayOf spellings

  assert.ok(sourceNames(withBrokerAddress('kafka', 'orders.v1')[0]).includes('consumeArray'));
  assert.equal(withAddress('kotlin.arrayof.v1').length, 1);
  // folds a KOTLIN constant, not only a Java one
  {
    // Two separate facts. Java's fold reaching this cascade says nothing about
    // Kotlin's: `makeConstantResolver` asks the OWNING provider for
    // `foldRoutePathOperands`, and the harvest behind it runs only for a
    // provider that declares `extractModuleConstants`. Kotlin declares both, so
    // `KotlinTopics.INVENTORY` resolves the same way `Topics.SHIPMENTS` does.
    const inventory = withAddress('kotlin.constant.v1');
    assert.equal(inventory.length, 1);
    assert.equal(inventory[0]?.properties.resolution, 'constant');
    assert.ok(sourceNames(inventory[0]).includes('publishConstant'));
  }
  // resolves the other brokers
  {
    assert.equal(withAddress('orders.jms')[0]?.properties.broker, 'jms');
    assert.equal(withAddress('orders-out-0')[0]?.properties.broker, 'stream');
    // Rabbit publishes name a routing key; the exchange rides on the edge.
    const routingKey = withAddress('orders.created');
    assert.equal(routingKey.length, 1);
    assert.ok(edgesTo(routingKey[0])[0]?.reason.includes('exchange=orders.exchange'));
  }
  // gives two files that write the SAME placeholder two distinct nodes

  const unresolved = destinations.filter(
    (node) => node.properties.configKey === 'app.messaging.shared-topic',
  );
  // Two Java consumers, one Kotlin consumer, one Java publisher.
  assert.ok(unresolved.length >= 3);
  assert.equal(new Set(unresolved.map((node) => node.id)).size, unresolved.length);
  const files = new Set(unresolved.map((node) => String(node.properties.filePath)));
  assert.equal(files.size, unresolved.length);
  // gives a RESOLVED destination no location, so an incremental delete cannot cut it

  // `deleteNodesForFiles` removes nodes with `n.filePath IN [changed files]`
  // and DETACH DELETEs their edges. A shared destination stamped with its
  // first-seen file would be collateral damage whenever that file changed,
  // taking edges from files outside the write set with it — a publisher and
  // a subscriber that agree on an address would silently stop being
  // connected. An unresolved destination belongs to one site and SHOULD be
  // deleted with its file.
  for (const node of destinations) {
    const isResolved = node.properties.address !== undefined;
    assert.equal((node.properties.filePath ?? '') === '', isResolved);
  }
  // never gives an unresolved destination an address property

  // The join key. An absent property cannot match another absent property,
  // so the guarantee survives being read back out of the database.
  for (const node of destinations) {
    const resolved = node.properties.resolution;
    const hasAddress = node.properties.address !== undefined;
    assert.equal(hasAddress, resolved === 'literal' || resolved === 'constant');
  }
  // gives two files that write the same SpEL expression two distinct nodes

  // A runtime bean expression is the archetypal unresolvable address. Filed
  // as a literal it produced ONE node with `address =
  // "#{@messagingProperties.ordersTopic}"` and a CONSUMES_FROM edge from each
  // of two unrelated services.
  const spel = destinations.filter((node) => node.properties.resolution === 'spel-expression');
  assert.equal(spel.length, 2);
  assert.equal(new Set(spel.map((node) => node.id)).size, 2);
  for (const node of spel) assert.equal(node.properties.address, undefined);
  assert.equal(
    destinations.some((node) => String(node.properties.address ?? '').includes('#{')),
    false,
  );
  // gives two Kotlin services writing the same string TEMPLATE two nodes

  // Kotlin interpolates; Java does not. `"orders-$env"` has no braces at all,
  // so the `${` test never saw it and both services shared the literal
  // address `orders-$env`.
  const templates = destinations.filter(
    (node) => node.properties.resolution === 'unescaped-interpolation',
  );
  // `"orders-$env"` in two files plus `"orders-${env}"` in one.
  assert.equal(templates.length, 3);
  assert.equal(new Set(templates.map((node) => node.id)).size, 3);
  for (const node of templates) {
    assert.equal(node.properties.address, undefined);
    // The braced form was read as a SPRING placeholder and invented
    // `configKey: "env"`, which the phase then linked to any Property of that
    // name — provenance with no source.
    assert.equal(node.properties.configKey, undefined);
  }
  assert.equal(
    destinations.some((node) => node.properties.address === 'orders-$env'),
    false,
  );
  // still reads the ESCAPED Kotlin dollar as a real Spring placeholder

  // `"\${app.topic}"` is how a Spring placeholder has to be written in
  // Kotlin, and the interpolation rule must not swallow it.
  const escaped = destinations.filter(
    (node) =>
      String(node.properties.filePath).endsWith('KotlinOrderPublishers.kt') &&
      node.properties.resolution === 'unresolved-config-key',
  );
  assert.equal(escaped.length, 1);
  assert.equal(escaped[0]?.properties.configKey, 'app.messaging.shared-topic');
  // never publishes a Rabbit EXCHANGE as an address
  {
    // `convertAndSend(Topics.ORDERS_EXCHANGE, routingKey, payload)` — an
    // ordinary publish whose routing key is a variable. Arity cannot tell it
    // from `(routingKey, message, postProcessor)`, and the discarded positional
    // fallback made the exchange the address, where it could join a listener on
    // a queue of that name.
    assert.deepStrictEqual(withAddress('orders.exchange'), []);
    assert.equal(
      destinations.some((node) => String(node.properties.name) === 'orders.exchange'),
      false,
    );
    const sources = new Set(
      messagingEdges.map((edge) => result.graph.getNode(edge.sourceId)?.properties.name),
    );
    assert.equal(sources.has('publishToExchangeWithVariableRoutingKey'), false);
  }
  // emits nothing for the ambiguous rabbit overload, and still reads the decidable one
  {
    // `convertAndSend("orders.rk", "body", correlationData)` is
    // `(exchange, routingKey, message)` OR
    // `(routingKey, message, correlationData)`, spelled identically. Reading
    // it either way publishes the other reading's payload as an address.
    assert.deepStrictEqual(withAddress('body'), []);
    assert.deepStrictEqual(withAddress('orders.rk'), []);
    const names = destinations.map((node) => String(node.properties.name));
    assert.ok(!names.includes('body'));
    assert.ok(!names.includes('orders.rk'));
    const sources = new Set(
      messagingEdges.map((edge) => result.graph.getNode(edge.sourceId)?.properties.name),
    );
    assert.equal(sources.has('publishWithAmbiguousOverload'), false);

    // The other half, which matters as much: the SAME arity with a constant in
    // slot 1 is decidable and must still resolve. A refusal that took this
    // with it would look identical in the graph — an absent destination — so
    // only asserting both together catches an over-broad suppression.
    const routingKey = withAddress('orders.created');
    assert.equal(routingKey.length, 1);
    assert.equal(routingKey[0]?.properties.resolution, 'constant');
    assert.equal(sources.has('publishToExchange'), true);
  }
  // does not connect the two unrelated placeholder consumers
  {
    const inventory = destinations.find((node) =>
      String(node.properties.filePath).endsWith('InventoryConsumer.java'),
    );
    const billing = destinations.find((node) =>
      String(node.properties.filePath).endsWith('BillingConsumer.java'),
    );
    assert.notEqual(inventory, undefined);
    assert.notEqual(billing, undefined);
    assert.notEqual(inventory?.id, billing?.id);
    // Neither consumer appears on the other's destination, by any edge.
    const inventorySources = new Set(edgesTo(inventory).map((e) => e.sourceId));
    const billingSources = new Set(edgesTo(billing).map((e) => e.sourceId));
    assert.deepStrictEqual(
      [...inventorySources].filter((id) => billingSources.has(id)),
      [],
    );
  }
  // does not connect a Rabbit queue and a JMS queue that share a name

  // `@RabbitListener(queues = "orders.queue")` and
  // `jmsTemplate.convertAndSend("orders.queue", payload)` name the same
  // string over two different brokers. Keyed on the address alone they were
  // one node, and the ordinary two-hop walk below reported a subscriber
  // reading what this publisher writes — which it does not.
  //
  // They are two nodes now because the BROKER is in the key, not because the
  // address was withdrawn from either of them: both resolve, both carry
  // `address`, and each is free to meet its own counterpart elsewhere. That
  // is the difference the assertions below are written to hold apart.
  const named = destinations.filter((node) => node.properties.name === 'orders.queue');
  assert.equal(named.length, 2);
  assert.equal(new Set(named.map((node) => node.id)).size, 2);
  assert.equal(withAddress('orders.queue').length, 2);
  for (const node of named) {
    assert.equal(node.properties.address, 'orders.queue');
    assert.equal(node.properties.resolution, 'literal');
    // Connecting, so no location — the incremental-delete rule applies to
    // these exactly as it does to any other joinable destination.
    assert.equal(node.properties.filePath, '');
  }
  assert.deepStrictEqual(
    new Set(named.map((node) => node.properties.broker)),
    new Set(['jms', 'rabbit']),
  );

  // The walk itself, stated the way a report would ask it: the Rabbit
  // subscription and the JMS publish land on DIFFERENT nodes, so neither
  // reaches the other.
  const consumerTargets = named.flatMap((node) =>
    edgesTo(node)
      .filter((edge) => edge.type === 'CONSUMES_FROM')
      .map((edge) => edge.targetId),
  );
  const publisherTargets = named.flatMap((node) =>
    edgesTo(node)
      .filter((edge) => edge.type === 'PUBLISHES_TO')
      .map((edge) => edge.targetId),
  );
  assert.equal(consumerTargets.length, 1);
  assert.equal(publisherTargets.length, 1);
  assert.notEqual(consumerTargets[0], publisherTargets[0]);
  // keeps the placeholder text visible in name, and out of address
  {
    const inventory = destinations.find((node) =>
      String(node.properties.filePath).endsWith('InventoryConsumer.java'),
    );
    // Unquoted, so an unresolved node's `name` is spelled the way a resolved
    // one's is rather than carrying the source's quotation marks.
    assert.equal(inventory?.properties.name, '${app.messaging.shared-topic}');
    assert.equal(inventory?.properties.address, undefined);
    assert.equal(inventory?.properties.resolution, 'unresolved-config-key');
  }
  // links an unresolved key to every Property node for it, without resolving it
  {
    // `spring-config.ts` keys a Property per FILE, so the key declared in both
    // application.yml and application-prod.yml is two nodes and both are
    // linked. Finding them does NOT upgrade the destination: the VALUE is
    // still not in the graph.
    const inventory = destinations.find((node) =>
      String(node.properties.filePath).endsWith('InventoryConsumer.java'),
    );
    const links = [...result.graph.iterRelationships()].filter(
      (edge) => edge.sourceId === inventory.id && edge.type === 'USES',
    );
    assert.equal(links.length, 2);
    for (const link of links) {
      assert.equal(result.graph.getNode(link.targetId)?.label, 'Property');
    }
    assert.equal(inventory.properties.address, undefined);
  }
  // does not treat a topic pattern as an address

  assert.deepStrictEqual(withAddress('orders\\..*'), []);
  assert.equal(
    destinations.some((node) => String(node.properties.name).includes('orders\\..*')),
    false,
  );
  // does not model a WebSocket/STOMP mapping as a broker destination

  assert.equal(
    destinations.some((node) => String(node.properties.name).startsWith('/orders')),
    false,
  );
  // emits nothing for a publish whose destination is inside an object
  {
    // `kafkaTemplate.send(record)` and `rabbitTemplate.convertAndSend(payload)`
    // name no address anywhere in the source.
    const sources = new Set(
      messagingEdges.map((edge) => result.graph.getNode(edge.sourceId)?.properties.name),
    );
    assert.equal(sources.has('publishRecord'), false);
    assert.equal(sources.has('publishToDefaultExchange'), false);
  }
  // leaves the refused sites out of the graph entirely

  // Refusals are counted on the phase's own output (asserted in
  // `spring-destinations-phase.test.ts`, which can see it — `PipelineResult`
  // does not carry phase outputs). What is observable HERE is that a refusal
  // adds nothing: no node, no edge, no partial address.
  const addresses = destinations.map((node) => node.properties.address).filter(Boolean);
  assert.ok(!addresses.includes(''));
  assert.equal(
    addresses.some((address) => String(address).includes('${')),
    false,
  );
}
export async function verifyDestinationsDatabase() {
  const parseIdentity = await runtimeParseIdentity();
  const FIXTURE = springFixture('spring-destination-app');

  /**
   * The database half of the destination keying rule, which no in-process test
   * can see.
   *
   * Two things only show up here:
   *
   *  1. The DISK-BACKED ParsedFile path. A `parseCache` with a `writeStoragePath` —
   *     as in a normal CLI run — flushes worker ParsedFiles to disk and hands
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
  await withGraphDatabase('spring-destinations', async (handle) => {
    await (async (dbPath) => {
      const storageDir = path.dirname(dbPath);
      const cacheDir = path.join(storageDir, 'parse-cache');
      // A cold cache WITH a writeStoragePath: this makes the parse phase use
      // the disk-backed ParsedFile store, which is the production shape.
      const cache = {
        identity: parseIdentity,
        entries: new Map(),
        usedKeys: new Set(),
        storagePath: cacheDir,
        writeStoragePath: cacheDir,
        onDiskKeys: new Set(),
      };
      const result = await runPipelineFromRepo(FIXTURE, () => {}, {
        parseCache: cache,
        workerPoolSize: 1,
      });
      assert.equal(result.usedWorkerPool, true);
      const store = cache.fileResults.stage;
      assert.equal(cache.fileResults.memory.size, 0);
      assert.ok(store.records.size > 0);
      assert.equal(
        (await readFileResults(store, [...store.records.keys()])).size,
        store.records.size,
      );
      const adapter = await import('../../../../dist/core/lbug/lbug-adapter.js');
      await adapter.loadGraphToLbug(result.graph, FIXTURE, storageDir);
    })(handle.dbPath);
    // Destination round trip through LadybugDB

    // persists every destination the pipeline resolved
    {
      const rows = await executeQuery(
        'MATCH (d:Destination) RETURN d.address AS address, d.broker AS broker, d.resolution AS resolution ORDER BY d.id',
      );
      assert.equal(rows.length, 25);
      const resolved = rows
        .filter((row) => row.address !== null && row.address !== undefined)
        .map((row) => row.address)
        .sort(compareCodeUnits);
      // `audit.v1` is deliberately NOT here: it is a `${key:default}`, and a
      // default the configuration can override is not an identity.
      //
      // `orders.queue` and `orders.v1` appear TWICE each, and that is the
      // point rather than a duplicate. Each is named by two brokers — a
      // Rabbit listener and a JMS publish, a Kafka pair and an unrelated
      // Rabbit listener — and identity is `(broker, address)`, so each
      // spelling is two rows that both keep the join key. Address alone is
      // therefore not unique in this table; `(address, broker)` is.
      assert.deepStrictEqual(resolved, [
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
    }
    // stores an unresolved address as NULL, not as the empty string
    {
      const [row] = await executeQuery(
        "MATCH (d:Destination) WHERE d.address IS NULL RETURN count(d) AS nulls, count(CASE WHEN d.resolution = 'unresolved-config-key' THEN 1 END) AS placeholders",
      );
      assert.equal(row?.nulls, 14);
      assert.equal(row?.placeholders, 5);
    }
    // stores the refusal breakdown, which is what this feature is measured on
    {
      const rows = await executeQuery(
        'MATCH (d:Destination) WHERE d.address IS NULL RETURN d.resolution AS reason, count(d) AS n ORDER BY reason',
      );
      // Every value in this column comes from the resolver's own closed
      // refusal set. The phase contributes none of its own: it withdraws no
      // address, so it has no verdict to record here.
      assert.deepStrictEqual(Object.fromEntries(rows.map((row) => [row.reason, Number(row.n)])), {
        'overridable-config-default': 4,
        'spel-expression': 2,
        'unescaped-interpolation': 3,
        'unresolved-config-key': 5,
      });
    }
    // keeps a `${key:default}` distinguishable from a bare `${key}` after the round trip
    {
      const rows = await executeQuery(
        "MATCH (d:Destination) WHERE d.configDefault = 'events' RETURN d.configKey AS key ORDER BY key",
      );
      // Two DIFFERENT keys that share a fallback. Substituting the default
      // merged them into one `Destination:events` node.
      assert.deepStrictEqual(
        rows.map((row) => row.key),
        ['app.messaging.archive-topic', 'app.messaging.report-topic'],
      );
    }
    // gives a resolved destination NULL lines, not line -1
    {
      const [row] = await executeQuery(
        'MATCH (d:Destination) WHERE d.address IS NOT NULL RETURN count(d) AS total, count(d.startLine) AS withLine',
      );
      // A resolved destination has no location at all — the same fact
      // `filePath` records — so the two columns must agree.
      assert.equal(Number(row?.total), 11);
      assert.equal(Number(row?.withLine), 0);
    }
    // produces no false join between two unresolved destinations
    {
      // The assertion the whole feature rests on, stated in the language a
      // cross-repository pass would actually use. `a.address = b.address` is
      // never true when both are NULL, so an unresolved destination cannot
      // match any other row — which is the property being asserted.
      const [row] = await executeQuery(
        'MATCH (a:Destination), (b:Destination) WHERE a.address = b.address AND a.broker = b.broker AND a.id <> b.id RETURN count(*) AS falseJoins',
      );
      assert.equal(row?.falseJoins, 0);

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
      assert.equal(shared.length, 4);
      for (const pair of shared) assert.notEqual(pair.mine, pair.theirs);
      assert.deepStrictEqual(
        shared.map((pair) => pair.address),
        ['orders.queue', 'orders.queue', 'orders.v1', 'orders.v1'],
      );
    }
    // joins a publisher and a subscriber on the resolved address
    {
      const rows = await executeQuery(
        "MATCH (m)-[r:CodeRelation]->(d:Destination) WHERE d.address = 'orders.v1' AND d.broker = 'kafka' RETURN r.type AS type, m.name AS name ORDER BY name",
      );
      const types = new Set(rows.map((row) => row.type));
      assert.deepStrictEqual(types, new Set(['CONSUMES_FROM', 'PUBLISHES_TO']));
      const names = rows.map((row) => row.name);
      assert.ok(names.includes('publishLiteral'));
      assert.ok(names.includes('consumeLiteral'));
    }
    // KEEPS that pair joined when a stranger names the same word on another broker
    {
      // THE regression, after the round trip. `UnrelatedRabbitConsumer`
      // listens on a Rabbit queue it happened to call `orders.v1`. While the
      // address alone keyed the node, that one file withdrew the address from
      // all three sites, re-keyed every one of them by source location, and
      // the Kafka pair above stopped being connected — a report asking "who
      // reads what this service publishes" answered nothing.
      const rows = await executeQuery(
        "MATCH (d:Destination) WHERE d.address = 'orders.v1' RETURN d.broker AS broker, d.id AS id, d.filePath AS filePath ORDER BY broker",
      );
      assert.deepStrictEqual(
        rows.map((row) => row.broker),
        ['kafka', 'rabbit'],
      );
      assert.equal(new Set(rows.map((row) => row.id)).size, 2);
      // Both connect, so neither is stamped with a file. The stranger's node
      // is as much a first-class destination as the pair's.
      for (const row of rows) assert.equal(row.filePath, null);

      // The pair's node carries both directions from two different files; the
      // stranger's carries one subscription and no publish, so the two-hop
      // walk between the JMS/Kafka publisher and this listener finds nothing.
      const stranger = await executeQuery(
        "MATCH (m)-[r:CodeRelation]->(d:Destination) WHERE d.address = 'orders.v1' AND d.broker = 'rabbit' RETURN r.type AS type, m.filePath AS filePath",
      );
      assert.deepStrictEqual(
        stranger.map((row) => row.type),
        ['CONSUMES_FROM'],
      );
      assert.ok(String(stranger[0]?.filePath).includes('UnrelatedRabbitConsumer.java'));
    }
    // keeps two brokers on one address as two rows that BOTH keep the address
    {
      // `@RabbitListener(queues = "orders.queue")` and
      // `jmsTemplate.convertAndSend("orders.queue", payload)` name one string
      // over two brokers. They are two rows because the broker is in the id,
      // not because the address was taken away from either of them — the
      // earlier rule withdrew it from both and this query returned two NULLs.
      const rows = await executeQuery(
        "MATCH (d:Destination) WHERE d.name = 'orders.queue' RETURN d.address AS address, d.broker AS broker, d.resolution AS resolution ORDER BY d.broker",
      );
      assert.deepStrictEqual(rows, [
        {
          address: 'orders.queue',
          broker: 'jms',
          resolution: 'literal',
        },
        {
          address: 'orders.queue',
          broker: 'rabbit',
          resolution: 'literal',
        },
      ]);

      // Both sides still have their own edge — the publish and the
      // subscription are real facts — and they land on two different nodes.
      const edges = await executeQuery(
        "MATCH (m)-[r:CodeRelation]->(d:Destination) WHERE d.address = 'orders.queue' RETURN r.type AS type, d.id AS destination ORDER BY type",
      );
      assert.deepStrictEqual(
        edges.map((row) => row.type),
        ['CONSUMES_FROM', 'PUBLISHES_TO'],
      );
      assert.equal(new Set(edges.map((row) => row.destination)).size, 2);
    }
    // links an unresolved placeholder to its configuration keys
    {
      const rows = await executeQuery(
        "MATCH (d:Destination)-[r:CodeRelation]->(p:Property) WHERE r.type = 'USES' RETURN p.name AS key",
      );
      assert.ok(rows.length > 0);
      // A `${key:default}` links to its key's Property nodes too — a default
      // changes nothing about where the real value comes from — so both keys
      // that are actually declared in the fixture's YAML appear. A key
      // declared nowhere links to nothing, which is normal: it may come from
      // an environment variable or a config server.
      assert.deepStrictEqual(
        new Set(rows.map((row) => row.key)),
        new Set(['app.messaging.shared-topic', 'app.messaging.audit-topic']),
      );
    }
  });
}
export async function verifyDestinationsIncremental() {
  const git =
    process.env.GIT_EXECUTABLE ??
    (process.platform === 'win32'
      ? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git', 'cmd', 'git.exe')
      : '/usr/bin/git');
  assert.ok(path.isAbsolute(git), 'GIT_EXECUTABLE must be an absolute path');
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
  if (!isWin) // Destination across a second, incremental analyze
  {
    let tmpHome;
    let tmpRepo;
    let repo;
    let savedHome;
    const srcDir = () => path.join(repo, 'src', 'main', 'java', 'com', 'example', 'messaging');

    // Two argv-form calls rather than one shell string joined by `&&`: the commit
    // message is a parameter, and interpolating it into a shell command would let
    // a message containing a space split into extra arguments — the command would
    // change meaning rather than fail visibly. No caller passes such a message
    // today, which is exactly why the shell form would have stayed wrong quietly.
    const commit = (message) => {
      execFileSync(git, ['add', '-A'], {
        cwd: repo,
        stdio: 'pipe',
      });
      execFileSync(
        git,
        ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message],
        {
          cwd: repo,
          stdio: 'pipe',
        },
      );
    };

    /** Run analyze and report whether the INCREMENTAL writeback branch ran. */
    const analyze = async () => {
      let incremental = false;
      await runFullAnalysis(
        repo,
        {},
        {
          onProgress: (_phase, _pct, message) => {
            // Emitted only by the incremental writeback branch. Without this the
            // whole suite could pass vacuously on a silent full rebuild.
            if (message?.startsWith('Removing rows for changed files')) incremental = true;
          },
        },
      );
      return {
        incremental,
      };
    };
    const openDb = async () => {
      const { lbugPath } = getStoragePaths(repo);
      await initLbug(lbugPath);
    };
    const destinations = async () => {
      await openDb();
      try {
        const rows = await executeQuery(
          'MATCH (d:Destination) OPTIONAL MATCH (m)-[r:CodeRelation]->(d) ' +
            'RETURN d.name AS name, d.address AS address, count(r) AS edges ORDER BY name',
        );
        return rows.map((row) => ({
          name: String(row.name),
          address: row.address ?? null,
          edges: Number(row.edges ?? 0),
        }));
      } finally {
        await closeLbug();
      }
    };
    try {
      tmpHome = await createTempDir('gn-dest-incr-home-');
      savedHome = process.env.GITNEXUS_HOME;
      process.env.GITNEXUS_HOME = tmpHome.dbPath;
      tmpRepo = await createTempDir('gn-dest-incr-repo-');
      repo = tmpRepo.dbPath;
      execFileSync(git, ['init', '-q'], {
        cwd: repo,
        stdio: 'pipe',
      });
      await fsPromises.mkdir(srcDir(), {
        recursive: true,
      });
      await fsPromises.writeFile(path.join(srcDir(), 'OrderConsumer.java'), CONSUMER);
      await fsPromises.writeFile(path.join(srcDir(), 'OrderPublisher.java'), PUBLISHER);
      commit('init');
      // indexes the shared destination on the first, from-scratch run
      {
        await analyze();
        const rows = await destinations();
        assert.deepStrictEqual(rows, [
          {
            name: 'orders.v1',
            address: 'orders.v1',
            edges: 2,
          },
        ]);
      }
      // ADDS a destination introduced by a new file on the second, incremental run
      {
        await fsPromises.writeFile(path.join(srcDir(), 'ShipmentPublisher.java'), LATE_PUBLISHER);
        commit('add-publisher');
        const { incremental } = await analyze();
        assert.equal(incremental, true);
        const rows = await destinations();
        // The defect: `shipments.v1` was absent entirely and ShipmentPublisher had
        // no PUBLISHES_TO edge, with exit 0 and no warning.
        assert.deepStrictEqual(rows, [
          {
            name: 'orders.v1',
            address: 'orders.v1',
            edges: 2,
          },
          {
            name: 'shipments.v1',
            address: 'shipments.v1',
            edges: 1,
          },
        ]);
      }
      // REMOVES a destination whose last referrer is gone, leaving no orphan
      {
        // Remove the last topic reference while retaining its source file to
        // exercise selective orphan cleanup after a source modification.
        await fsPromises.writeFile(
          path.join(srcDir(), 'ShipmentPublisher.java'),
          LATE_PUBLISHER.replace('kafkaTemplate.send("shipments.v1", payload);', ''),
        );
        commit('drop-topic-reference');
        const { incremental } = await analyze();
        assert.equal(incremental, true);
        const rows = await destinations();
        // The mirror defect: `shipments.v1` survived as an edgeless orphan that
        // still carried `address`, and accumulated on every subsequent run. The
        // untouched half must be intact — deleting the layer without re-including
        // it would show up here as orders.v1 losing its edges or vanishing.
        assert.deepStrictEqual(rows, [
          {
            name: 'orders.v1',
            address: 'orders.v1',
            edges: 2,
          },
        ]);
      }
    } finally {
      if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = savedHome;
      await tmpRepo?.cleanup();
      await tmpHome?.cleanup();
    }
  }
}
