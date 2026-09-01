import path from 'node:path';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'spring-destination-app');

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
describe('Spring destination resolution', () => {
  let result: PipelineResult;
  let destinations: GraphNode[];
  let messagingEdges: GraphRelationship[];

  beforeAll(async () => {
    result = await runPipelineFromRepo(FIXTURE, () => {}, {});
    destinations = [...result.graph.iterNodes()].filter((node) => node.label === 'Destination');
    messagingEdges = [...result.graph.iterRelationships()].filter(
      (edge) => edge.type === 'CONSUMES_FROM' || edge.type === 'PUBLISHES_TO',
    );
  }, 120_000);

  const withAddress = (address: string): GraphNode[] =>
    destinations.filter((node) => node.properties.address === address);

  const edgesTo = (node: GraphNode): GraphRelationship[] =>
    messagingEdges.filter((edge) => edge.targetId === node.id);

  const sourceNames = (node: GraphNode): string[] =>
    edgesTo(node)
      .map((edge) => String(result.graph.getNode(edge.sourceId)?.properties.name ?? edge.sourceId))
      .sort();

  it('resolves a literal destination on both sides', () => {
    const nodes = withAddress('orders.v1');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.properties.resolution).toBe('literal');
    expect(nodes[0]?.properties.broker).toBe('kafka');
  });

  it('joins a publisher and a subscriber that name the same address', () => {
    // The reason the node is keyed by address: this connection is one hop.
    const [orders] = withAddress('orders.v1');
    expect(orders).toBeDefined();
    const names = sourceNames(orders as GraphNode);
    expect(names).toContain('publishLiteral');
    expect(names).toContain('consumeLiteral');
    const types = new Set(edgesTo(orders as GraphNode).map((edge) => edge.type));
    expect([...types].sort()).toEqual(['CONSUMES_FROM', 'PUBLISHES_TO']);
  });

  it('resolves a constant reference and joins on it too', () => {
    const nodes = withAddress('shipments.v1');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.properties.resolution).toBe('constant');
    expect(sourceNames(nodes[0] as GraphNode)).toEqual(
      expect.arrayContaining(['consumeConstant', 'publishConstant']),
    );
  });

  it('resolves a placeholder default, because the default is written in the source', () => {
    const nodes = withAddress('audit.v1');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.properties.resolution).toBe('config-default');
  });

  it('emits one edge per element of an array-valued topics argument', () => {
    // `topics = {"orders.v1", "returns.v1"}` really does subscribe to two
    // places, so each gets its own edge and "who reads returns.v1" is one hop.
    const returns = withAddress('returns.v1');
    expect(returns).toHaveLength(1);
    const consumers = sourceNames(returns[0] as GraphNode);
    expect(consumers).toContain('consumeMany');
    expect(sourceNames(withAddress('orders.v1')[0] as GraphNode)).toContain('consumeMany');
  });

  it('reads the Kotlin bracket and arrayOf spellings', () => {
    expect(sourceNames(withAddress('orders.v1')[0] as GraphNode)).toContain('consumeArray');
    expect(withAddress('kotlin.arrayof.v1')).toHaveLength(1);
  });

  it('resolves the other brokers', () => {
    expect(withAddress('orders.queue')[0]?.properties.broker).toBe('rabbit');
    expect(withAddress('orders.jms')[0]?.properties.broker).toBe('jms');
    expect(withAddress('orders-out-0')[0]?.properties.broker).toBe('stream');
    // Rabbit publishes name a routing key; the exchange rides on the edge.
    const routingKey = withAddress('orders.created');
    expect(routingKey).toHaveLength(1);
    expect(edgesTo(routingKey[0] as GraphNode)[0]?.reason).toContain('exchange=orders.exchange');
  });

  // ── The rule the whole feature turns on ─────────────────────────────────

  it('gives two files that write the SAME placeholder two distinct nodes', () => {
    const unresolved = destinations.filter(
      (node) => node.properties.configKey === 'app.messaging.shared-topic',
    );
    // Two Java consumers, one Kotlin consumer, one Java publisher.
    expect(unresolved.length).toBeGreaterThanOrEqual(3);
    expect(new Set(unresolved.map((node) => node.id)).size).toBe(unresolved.length);
    const files = new Set(unresolved.map((node) => String(node.properties.filePath)));
    expect(files.size).toBe(unresolved.length);
  });

  it('gives a RESOLVED destination no location, so an incremental delete cannot cut it', () => {
    // `deleteNodesForFiles` removes nodes with `n.filePath IN [changed files]`
    // and DETACH DELETEs their edges. A shared destination stamped with its
    // first-seen file would be collateral damage whenever that file changed,
    // taking edges from files outside the write set with it — a publisher and
    // a subscriber that agree on an address would silently stop being
    // connected. An unresolved destination belongs to one site and SHOULD be
    // deleted with its file.
    for (const node of destinations) {
      const isResolved = node.properties.address !== undefined;
      expect((node.properties.filePath ?? '') === '').toBe(isResolved);
    }
  });

  it('never gives an unresolved destination an address property', () => {
    // The join key. An absent property cannot match another absent property,
    // so the guarantee survives being read back out of the database.
    for (const node of destinations) {
      const resolved = node.properties.resolution;
      const hasAddress = node.properties.address !== undefined;
      expect(hasAddress).toBe(
        resolved === 'literal' || resolved === 'constant' || resolved === 'config-default',
      );
    }
  });

  it('does not connect the two unrelated placeholder consumers', () => {
    const inventory = destinations.find((node) =>
      String(node.properties.filePath).endsWith('InventoryConsumer.java'),
    );
    const billing = destinations.find((node) =>
      String(node.properties.filePath).endsWith('BillingConsumer.java'),
    );
    expect(inventory).toBeDefined();
    expect(billing).toBeDefined();
    expect(inventory?.id).not.toBe(billing?.id);
    // Neither consumer appears on the other's destination, by any edge.
    const inventorySources = new Set(edgesTo(inventory as GraphNode).map((e) => e.sourceId));
    const billingSources = new Set(edgesTo(billing as GraphNode).map((e) => e.sourceId));
    expect([...inventorySources].filter((id) => billingSources.has(id))).toEqual([]);
  });

  it('keeps the placeholder text visible in name, and out of address', () => {
    const inventory = destinations.find((node) =>
      String(node.properties.filePath).endsWith('InventoryConsumer.java'),
    );
    expect(inventory?.properties.name).toContain('${app.messaging.shared-topic}');
    expect(inventory?.properties.address).toBeUndefined();
    expect(inventory?.properties.resolution).toBe('unresolved-config-key');
  });

  it('links an unresolved key to every Property node for it, without resolving it', () => {
    // `spring-config.ts` keys a Property per FILE, so the key declared in both
    // application.yml and application-prod.yml is two nodes and both are
    // linked. Finding them does NOT upgrade the destination: the VALUE is
    // still not in the graph.
    const inventory = destinations.find((node) =>
      String(node.properties.filePath).endsWith('InventoryConsumer.java'),
    ) as GraphNode;
    const links = [...result.graph.iterRelationships()].filter(
      (edge) => edge.sourceId === inventory.id && edge.type === 'USES',
    );
    expect(links.length).toBe(2);
    for (const link of links) {
      expect(result.graph.getNode(link.targetId)?.label).toBe('Property');
    }
    expect(inventory.properties.address).toBeUndefined();
  });

  // ── Refusals ────────────────────────────────────────────────────────────

  it('does not treat a topic pattern as an address', () => {
    expect(withAddress('orders\\..*')).toEqual([]);
    expect(destinations.some((node) => String(node.properties.name).includes('orders\\..*'))).toBe(
      false,
    );
  });

  it('does not model a WebSocket/STOMP mapping as a broker destination', () => {
    expect(destinations.some((node) => String(node.properties.name).startsWith('/orders'))).toBe(
      false,
    );
  });

  it('emits nothing for a publish whose destination is inside an object', () => {
    // `kafkaTemplate.send(record)` and `rabbitTemplate.convertAndSend(payload)`
    // name no address anywhere in the source.
    const sources = new Set(
      messagingEdges.map((edge) => result.graph.getNode(edge.sourceId)?.properties.name),
    );
    expect(sources.has('publishRecord')).toBe(false);
    expect(sources.has('publishToDefaultExchange')).toBe(false);
  });

  it('leaves the refused sites out of the graph entirely', () => {
    // Refusals are counted on the phase's own output (asserted in
    // `spring-destinations-phase.test.ts`, which can see it — `PipelineResult`
    // does not carry phase outputs). What is observable HERE is that a refusal
    // adds nothing: no node, no edge, no partial address.
    const addresses = destinations.map((node) => node.properties.address).filter(Boolean);
    expect(addresses).not.toContain('');
    expect(addresses.some((address) => String(address).includes('${'))).toBe(false);
  });
});
