import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, chmod, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  normalizeAsyncApiDocument,
  readAsyncApiDocuments,
  type AsyncApiRefusal,
} from '../../src/core/ingestion/asyncapi/document.js';
import {
  brokerForBindingKey,
  brokerForProtocol,
} from '../../src/core/ingestion/asyncapi/protocol.js';
import { destinationNodeKey } from '../../src/core/ingestion/destination-key.js';

/**
 * The pure half of AsyncAPI reading: version gating, the two-source broker
 * reading, the address rules, and the refusal taxonomy.
 *
 * DIRECTION IS PINNED HARDEST, because it is the one error this module can
 * make that leaves everything looking healthy. A reversed `send`/`receive`
 * mapping still emits both roles, still emits every edge, and still produces a
 * connected graph — only with every arrow backwards. An assertion that a node
 * or an operation EXISTS passes identically under both readings, so every
 * direction test below asserts the action itself.
 *
 * THE REFUSALS ARE PINNED AS HARD AS THE ACCEPTANCES. Every one of them is a
 * case where the document says something that looks like an address and is not
 * one; accepting it would connect two services that have said nothing about
 * each other, and a false connection is reported as a fact where a missing one
 * is visible as a gap. A refusal with no test is a refusal one refactor away
 * from silently becoming an acceptance.
 */

const CHANNEL_ADDRESS = 'orders';

function doc(body: Record<string, unknown>): Record<string, unknown> {
  return { asyncapi: '3.0.0', info: { title: 'Order Service', version: '1.0.0' }, ...body };
}

/** One kafka channel + one operation, parameterized by action. */
function singleOperation(action: string): Record<string, unknown> {
  return doc({
    servers: { broker: { host: 'example:9092', protocol: 'kafka' } },
    channels: {
      orders: { address: CHANNEL_ADDRESS, servers: [{ $ref: '#/servers/broker' }] },
    },
    operations: {
      op: { action, channel: { $ref: '#/channels/orders' }, bindings: { kafka: {} } },
    },
  });
}

describe('brokerForProtocol', () => {
  it('maps the AMQP family onto the broker name Spring capture already mints', () => {
    expect(brokerForProtocol('amqp')).toBe('rabbit');
    expect(brokerForProtocol('amqp1')).toBe('rabbit');
  });

  it('folds transport-security variants onto the plain protocol', () => {
    // AsyncAPI's SERVER vocabulary distinguishes these; its BINDINGS vocabulary
    // does not. Without the fold, a secured cluster's own document contradicts
    // itself and every operation in it is refused.
    expect(brokerForProtocol('kafka-secure')).toBe('kafka');
    expect(brokerForProtocol('secure-mqtt')).toBe('mqtt');
    expect(brokerForProtocol('mqtts')).toBe('mqtt');
    expect(brokerForProtocol('wss')).toBe('ws');
    expect(brokerForProtocol('stomps')).toBe('stomp');
  });

  it('passes an unmapped protocol through as its own literal', () => {
    // The point of the pass-through: an `mqtt` document still mints a keyable
    // destination instead of being dropped for not fitting a closed union.
    expect(brokerForProtocol('mqtt')).toBe('mqtt');
    expect(brokerForProtocol('NATS')).toBe('nats');
  });

  it('treats a blank protocol as silence, not as a broker', () => {
    expect(brokerForProtocol('   ')).toBeUndefined();
    expect(brokerForProtocol(undefined)).toBeUndefined();
  });

  it('rejects a broker containing whitespace, which would collide in the node key', () => {
    // `destinationNodeKey` joins with a space, so a broker holding one makes
    // two different destinations the same node. This module is the first caller
    // to feed that helper text a document wrote rather than a closed union, so
    // it is the first place the collision becomes reachable — and the last
    // place it can be stopped without changing the shared key encoding.
    expect(brokerForProtocol('kafka orders')).toBeUndefined();
    expect(destinationNodeKey('kafka', 'orders x')).toBe('kafka orders x');
  });

  it('folds mqtt5 onto mqtt, by the same argument as the secure variants', () => {
    expect(brokerForProtocol('mqtt5')).toBe('mqtt');
  });

  it('rejects a protocol long enough to be a mistake', () => {
    // The broker is the THIRD string that reaches a graph identifier, and
    // `generateId` concatenates rather than hashes: a one-megabyte protocol in
    // an otherwise in-cap document was measured turning that document into a
    // gigabyte of resident identifier strings.
    expect(brokerForProtocol('k'.repeat(1_000_000))).toBeUndefined();
    expect(brokerForProtocol('googlepubsub')).toBe('googlepubsub');
  });
});

describe('brokerForBindingKey', () => {
  // A `servers[].protocol` is a field DECLARED to hold a protocol, so an
  // unrecognized value there is the document's claim and passes through. A
  // `bindings` MAP KEY is not: the specification puts `$ref` and `x-`
  // extensions in the same namespace, so a non-protocol key is the EXPECTED
  // case and only known names may answer.
  it('answers for AsyncAPI binding vocabulary', () => {
    expect(brokerForBindingKey('kafka')).toBe('kafka');
    expect(brokerForBindingKey('amqp')).toBe('rabbit');
    expect(brokerForBindingKey('kafka-secure')).toBe('kafka');
  });

  it('stays silent for a reference field and for vendor extensions', () => {
    expect(brokerForBindingKey('$ref')).toBeUndefined();
    expect(brokerForBindingKey('x-scs-function')).toBeUndefined();
    expect(brokerForBindingKey('x-internal-routing')).toBeUndefined();
  });

  it('stays silent for a protocol-shaped name that is not a binding', () => {
    // The asymmetry with `brokerForProtocol` is the point: pass-through is
    // right for a declared protocol field and wrong for a map key.
    expect(brokerForProtocol('somethingnew')).toBe('somethingnew');
    expect(brokerForBindingKey('somethingnew')).toBeUndefined();
  });
});

describe('normalizeAsyncApiDocument — direction', () => {
  it('keeps `send` as send', () => {
    const { operations } = normalizeAsyncApiDocument(singleOperation('send'), '/spec.yaml');
    expect(operations).toHaveLength(1);
    expect(operations[0].action).toBe('send');
    expect(operations[0].address).toBe(CHANNEL_ADDRESS);
    expect(operations[0].broker).toBe('kafka');
  });

  it('keeps `receive` as receive', () => {
    const { operations } = normalizeAsyncApiDocument(singleOperation('receive'), '/spec.yaml');
    expect(operations).toHaveLength(1);
    expect(operations[0].action).toBe('receive');
  });

  it('refuses an action that is neither', () => {
    const { operations, refusals } = normalizeAsyncApiDocument(
      singleOperation('publish'),
      '/spec.yaml',
    );
    expect(operations).toHaveLength(0);
    expect(refusals['unrecognized-action']).toBe(1);
  });
});

describe('normalizeAsyncApiDocument — version gating', () => {
  it('refuses a 2.x document under its own reason instead of mapping it', () => {
    // publish/subscribe are inverted relative to 3.x send/receive. Mapping them
    // naively reverses the async graph while leaving it connected.
    const two = {
      asyncapi: '2.6.0',
      channels: { orders: { publish: { operationId: 'onOrder' } } },
    };
    const { operations, refusals } = normalizeAsyncApiDocument(two, '/spec.yaml');
    expect(operations).toHaveLength(0);
    expect(refusals['asyncapi-2-unsupported']).toBe(1);
    // Not merely absent from the output — countable, so a corpus full of 2.x
    // documents is distinguishable from a corpus with no documents at all.
    expect(refusals['not-a-document']).toBeUndefined();
  });

  it('reads a 3.x minor version it has never seen', () => {
    const next = { ...singleOperation('send'), asyncapi: '3.1.0' };
    expect(normalizeAsyncApiDocument(next, '/spec.yaml').operations).toHaveLength(1);
  });

  it('refuses a major version it does not read', () => {
    const future = { ...singleOperation('send'), asyncapi: '4.0.0' };
    const { refusals } = normalizeAsyncApiDocument(future, '/spec.yaml');
    expect(refusals['unsupported-version']).toBe(1);
  });

  it('reports a file with no root key as not a document', () => {
    const { refusals } = normalizeAsyncApiDocument({ openapi: '3.0.0', paths: {} }, '/spec.yaml');
    expect(refusals['not-a-document']).toBe(1);
  });
});

describe('normalizeAsyncApiDocument — broker reading', () => {
  it('reads the broker from operation bindings alone', () => {
    const d = doc({
      channels: { orders: { address: CHANNEL_ADDRESS } },
      operations: {
        op: { action: 'send', channel: { $ref: '#/channels/orders' }, bindings: { jms: {} } },
      },
    });
    expect(normalizeAsyncApiDocument(d, '/spec.yaml').operations[0].broker).toBe('jms');
  });

  it('ignores a `$ref` bindings key instead of taking it as a broker', () => {
    const d = doc({
      servers: { s: { host: 'example', protocol: 'kafka' } },
      channels: { orders: { address: CHANNEL_ADDRESS, servers: [{ $ref: '#/servers/s' }] } },
      operations: {
        op: {
          action: 'send',
          channel: { $ref: '#/channels/orders' },
          bindings: { $ref: '#/components/operationBindings/kafka' },
        },
      },
    });
    const { operations } = normalizeAsyncApiDocument(d, '/spec.yaml');
    // The server's protocol decides it; `$ref` contributes nothing, and in
    // particular does NOT read as a disagreement with `kafka`.
    expect(operations).toHaveLength(1);
    expect(operations[0].broker).toBe('kafka');
  });

  it('reads the broker from the channel’s server alone', () => {
    const d = doc({
      servers: { s: { host: 'example', protocol: 'amqp' } },
      channels: { orders: { address: CHANNEL_ADDRESS, servers: [{ $ref: '#/servers/s' }] } },
      operations: { op: { action: 'receive', channel: { $ref: '#/channels/orders' } } },
    });
    expect(normalizeAsyncApiDocument(d, '/spec.yaml').operations[0].broker).toBe('rabbit');
  });

  it('treats a channel with no `servers` as available on all of them', () => {
    // The specification's own default. Reading an absent `servers` as silence
    // instead cost every single-server document its destinations whenever its
    // operations carried no bindings — an entirely ordinary hand-written shape.
    const d = doc({
      servers: { only: { host: 'example', protocol: 'kafka' } },
      channels: { orders: { address: CHANNEL_ADDRESS } },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/orders' } } },
    });
    const { operations } = normalizeAsyncApiDocument(d, '/spec.yaml');
    expect(operations).toHaveLength(1);
    expect(operations[0].broker).toBe('kafka');
  });

  it('refuses a channel with no `servers` when the document is multi-protocol', () => {
    // Filed under its OWN reason, not `protocol-disagreement`: this document
    // does not contradict itself, it is simply multi-protocol and this channel
    // did not choose. A tally that says "the document contradicts itself" here
    // sends an operator to fix something that is not broken.
    const d = doc({
      servers: {
        a: { host: 'example', protocol: 'kafka' },
        b: { host: 'example', protocol: 'jms' },
      },
      channels: { orders: { address: CHANNEL_ADDRESS } },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/orders' } } },
    });
    const { operations, refusals } = normalizeAsyncApiDocument(d, '/spec.yaml');
    expect(operations).toHaveLength(0);
    expect(refusals['ambiguous-server-default']).toBe(1);
    expect(refusals['protocol-disagreement']).toBeUndefined();
  });

  it('resolves a multi-protocol document when the operation names its own binding', () => {
    // The operation has already answered the question. Unioning every server
    // before consulting its bindings manufactured a contradiction and lost a
    // destination the document states plainly — a document declaring both a
    // REST server and a Kafka server is an ordinary shape.
    const d = doc({
      servers: {
        a: { host: 'example', protocol: 'kafka' },
        b: { host: 'example', protocol: 'mqtt' },
      },
      channels: { orders: { address: CHANNEL_ADDRESS } },
      operations: {
        op: { action: 'send', channel: { $ref: '#/channels/orders' }, bindings: { kafka: {} } },
      },
    });
    const { operations, refusals } = normalizeAsyncApiDocument(d, '/spec.yaml');
    expect(refusals).toEqual({});
    expect(operations[0].broker).toBe('kafka');
  });

  it('ignores a Specification Extension key in bindings', () => {
    // `x-` keys share the bindings namespace legitimately and generators emit
    // them. Read as a broker, one of them either becomes half of a join key
    // carrying no broker information, or reads as a second broker and destroys
    // the destination — which would make any document author a one-line
    // saboteur of their own cross-service links.
    const d = doc({
      servers: { s: { host: 'example', protocol: 'kafka' } },
      channels: { orders: { address: CHANNEL_ADDRESS, servers: [{ $ref: '#/servers/s' }] } },
      operations: {
        op: {
          action: 'send',
          channel: { $ref: '#/channels/orders' },
          bindings: { kafka: {}, 'x-internal-routing': { queue: 'x' } },
        },
      },
    });
    const { operations, refusals } = normalizeAsyncApiDocument(d, '/spec.yaml');
    expect(refusals).toEqual({});
    expect(operations[0].broker).toBe('kafka');
  });

  it('does not let a lone extension key become the broker', () => {
    const d = doc({
      servers: { s: { host: 'example', protocol: 'kafka' } },
      channels: { orders: { address: CHANNEL_ADDRESS, servers: [{ $ref: '#/servers/s' }] } },
      operations: {
        op: {
          action: 'send',
          channel: { $ref: '#/channels/orders' },
          bindings: { 'x-scs-function': { name: 'orders-out' } },
        },
      },
    });
    // Falls through to the channel's server rather than minting
    // `Destination(broker='x-scs-function')`.
    expect(normalizeAsyncApiDocument(d, '/spec.yaml').operations[0].broker).toBe('kafka');
  });

  it('refuses HTTP and WebSocket, where the host rather than the address names the place', () => {
    // For a broker the topic IS the namespace; for HTTP the host is, and the
    // address is only a path. Keying on the path alone would make every service
    // exposing `/events` — or `/health` — one node. An HTTP endpoint is a
    // `Route`, which the routes phase already models with its method.
    for (const protocol of ['http', 'https', 'ws', 'wss']) {
      const d = doc({
        servers: { s: { host: 'service-a.example', pathname: '/v1', protocol } },
        channels: { c: { address: '/events', servers: [{ $ref: '#/servers/s' }] } },
        operations: { op: { action: 'send', channel: { $ref: '#/channels/c' } } },
      });
      const { operations, refusals } = normalizeAsyncApiDocument(d, '/spec.yaml');
      expect(operations).toHaveLength(0);
      expect(refusals['not-a-destination-protocol']).toBe(1);
    }
  });

  it('refuses when bindings and server protocol name different brokers', () => {
    const d = doc({
      servers: { s: { host: 'example', protocol: 'jms' } },
      channels: { orders: { address: CHANNEL_ADDRESS, servers: [{ $ref: '#/servers/s' }] } },
      operations: {
        op: { action: 'send', channel: { $ref: '#/channels/orders' }, bindings: { kafka: {} } },
      },
    });
    const { operations, refusals } = normalizeAsyncApiDocument(d, '/spec.yaml');
    expect(operations).toHaveLength(0);
    expect(refusals['protocol-disagreement']).toBe(1);
  });

  it('accepts agreement across the AMQP alias boundary', () => {
    const d = doc({
      servers: { s: { host: 'example', protocol: 'amqp' } },
      channels: { orders: { address: CHANNEL_ADDRESS, servers: [{ $ref: '#/servers/s' }] } },
      operations: {
        op: { action: 'send', channel: { $ref: '#/channels/orders' }, bindings: { amqp1: {} } },
      },
    });
    expect(normalizeAsyncApiDocument(d, '/spec.yaml').operations[0].broker).toBe('rabbit');
  });

  it('accepts a secured server against a plain binding', () => {
    // The exact shape a secured Kafka cluster's generated document takes.
    // Without the alias this is refused as self-contradictory.
    const d = doc({
      servers: { s: { host: 'example:9093', protocol: 'kafka-secure' } },
      channels: { orders: { address: CHANNEL_ADDRESS, servers: [{ $ref: '#/servers/s' }] } },
      operations: {
        op: { action: 'send', channel: { $ref: '#/channels/orders' }, bindings: { kafka: {} } },
      },
    });
    const { operations, refusals } = normalizeAsyncApiDocument(d, '/spec.yaml');
    expect(refusals['protocol-disagreement']).toBeUndefined();
    expect(operations[0].broker).toBe('kafka');
  });

  it('refuses when no protocol is named anywhere', () => {
    const d = doc({
      channels: { orders: { address: CHANNEL_ADDRESS } },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/orders' } } },
    });
    const { operations, refusals } = normalizeAsyncApiDocument(d, '/spec.yaml');
    expect(operations).toHaveLength(0);
    expect(refusals['protocol-unknown']).toBe(1);
  });
});

describe('normalizeAsyncApiDocument — addressing', () => {
  const kafka = { s: { host: 'example', protocol: 'kafka' } };

  it('keys on `address`, not on the channel map key', () => {
    const d = doc({
      servers: kafka,
      channels: { someLocalKey: { address: 'orders.v1', servers: [{ $ref: '#/servers/s' }] } },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/someLocalKey' } } },
    });
    expect(normalizeAsyncApiDocument(d, '/spec.yaml').operations[0].address).toBe('orders.v1');
  });

  it('keeps an address exactly as written, whitespace included', () => {
    // The source cascade keeps `" orders "` as its own node rather than joining
    // it to `"orders"`, on the grounds that a missing connection beats a false
    // one. Two producers of one key must not hold opposite whitespace policies.
    const d = doc({
      servers: kafka,
      channels: { c: { address: '  orders  ', servers: [{ $ref: '#/servers/s' }] } },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/c' } } },
    });
    expect(normalizeAsyncApiDocument(d, '/spec.yaml').operations[0].address).toBe('  orders  ');
  });

  it('refuses a channel whose address is a template declared by `parameters`', () => {
    // Two services that both publish `{env}.orders` have named a pattern they
    // share, not a queue they share: one deploys with env=prod and the other
    // with env=staging. Keying on the template text merges them into one node
    // with a publisher on one side and a subscriber on the other — a false
    // connection assembled entirely from conformant AsyncAPI.
    const d = doc({
      servers: kafka,
      channels: {
        c: {
          address: '{env}.orders',
          parameters: { env: { description: 'deployment environment' } },
          servers: [{ $ref: '#/servers/s' }],
        },
      },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/c' } } },
    });
    const { operations, refusals } = normalizeAsyncApiDocument(d, '/spec.yaml');
    expect(operations).toHaveLength(0);
    expect(refusals['templated-address']).toBe(1);
  });

  it('accepts a literal address beside an EMPTY `parameters` map', () => {
    // An empty container states nothing, and generators emit them routinely.
    // Only a non-empty `parameters` is the specification declaring a template;
    // the `{` test covers documents that template without declaring.
    const d = doc({
      servers: kafka,
      channels: { c: { address: 'payments.v1', parameters: {}, servers: [{ $ref: '#/servers/s' }] } },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/c' } } },
    });
    const { operations, refusals } = normalizeAsyncApiDocument(d, '/spec.yaml');
    expect(refusals['templated-address']).toBeUndefined();
    expect(operations[0].address).toBe('payments.v1');
  });

  it('refuses a channel that is itself a Reference Object, under its own reason', () => {
    // Filing this under `no-address` told an operator their documents omit
    // addresses, when the real answer is that this reader stops one hop short.
    const d = doc({
      servers: kafka,
      channels: { c: { $ref: '#/components/channels/orders' } },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/c' } } },
    });
    const { operations, refusals } = normalizeAsyncApiDocument(d, '/spec.yaml');
    expect(operations).toHaveLength(0);
    expect(refusals['unresolved-channel-reference']).toBe(1);
    expect(refusals['no-address']).toBeUndefined();
  });

  it('marks the document truncated when the per-document cap stops it', () => {
    // `truncated` is documented as "a bound stopped the walk OR the operation
    // count", and this is a bound stopping the operation count. Reporting the
    // cap without the flag let a truncated read present as a complete one.
    const operations: Record<string, unknown> = {};
    for (let i = 0; i < 5_010; i += 1) {
      operations[`op${i}`] = { action: 'send', channel: { $ref: '#/channels/c' } };
    }
    const d = doc({
      servers: kafka,
      channels: { c: { address: CHANNEL_ADDRESS, servers: [{ $ref: '#/servers/s' }] } },
      operations,
    });
    const result = normalizeAsyncApiDocument(d, '/spec.yaml');
    expect(result.refusals['operation-cap']).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('spends the run budget on operations EXAMINED, not on those accepted', () => {
    // A cap that counts successes does not bound work: a run whose every
    // operation is refused never decrements the budget, so every document is
    // processed in full and the result still claims to be complete.
    const operations: Record<string, unknown> = {};
    for (let i = 0; i < 6; i += 1) {
      operations[`op${i}`] = { action: 'nope', channel: { $ref: '#/channels/c' } };
    }
    const d = doc({
      servers: kafka,
      channels: { c: { address: CHANNEL_ADDRESS, servers: [{ $ref: '#/servers/s' }] } },
      operations,
    });
    const result = normalizeAsyncApiDocument(d, '/spec.yaml', 100);
    expect(result.operations).toHaveLength(0);
    expect(result.examined).toBe(6);
  });

  it('refuses a channel that declares `parameters` even when the address has no braces', () => {
    // The two halves of this refusal are independent, and only the `{` half was
    // pinned: the test above supplies BOTH a declaration and a braced address,
    // so deleting the `parameters` clause changed no result. A generator that
    // declares parameters and substitutes them elsewhere would then mint a
    // joinable node on a template.
    const d = doc({
      servers: kafka,
      channels: {
        c: {
          address: 'orders',
          parameters: { env: { description: 'deployment environment' } },
          servers: [{ $ref: '#/servers/s' }],
        },
      },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/c' } } },
    });
    const { operations, refusals } = normalizeAsyncApiDocument(d, '/spec.yaml');
    expect(operations).toHaveLength(0);
    expect(refusals['templated-address']).toBe(1);
  });

  it('refuses a templated address even when `parameters` is omitted', () => {
    const d = doc({
      servers: kafka,
      channels: { c: { address: '{env}.orders', servers: [{ $ref: '#/servers/s' }] } },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/c' } } },
    });
    expect(
      normalizeAsyncApiDocument(d, '/spec.yaml').refusals['templated-address'],
    ).toBe(1);
  });

  it('refuses an address longer than the identifier bound', () => {
    // `generateId` concatenates rather than hashes, so an id is exactly as long
    // as the text behind it. One document under every other cap could otherwise
    // mint thousands of multi-megabyte edge ids.
    const d = doc({
      servers: kafka,
      channels: { c: { address: 'x'.repeat(4096), servers: [{ $ref: '#/servers/s' }] } },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/c' } } },
    });
    expect(normalizeAsyncApiDocument(d, '/spec.yaml').refusals['address-too-long']).toBe(1);
  });

  it('refuses an operation id longer than the identifier bound', () => {
    const d = doc({
      servers: kafka,
      channels: { c: { address: CHANNEL_ADDRESS, servers: [{ $ref: '#/servers/s' }] } },
      operations: { ['o'.repeat(600)]: { action: 'send', channel: { $ref: '#/channels/c' } } },
    });
    expect(normalizeAsyncApiDocument(d, '/spec.yaml').refusals['operation-id-too-long']).toBe(1);
  });

  it('refuses a channel with no address', () => {
    const d = doc({
      servers: kafka,
      channels: { orders: { servers: [{ $ref: '#/servers/s' }] } },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/orders' } } },
    });
    expect(normalizeAsyncApiDocument(d, '/spec.yaml').refusals['no-address']).toBe(1);
  });

  it('refuses a whitespace-only address', () => {
    const d = doc({
      servers: kafka,
      channels: { orders: { address: '   ', servers: [{ $ref: '#/servers/s' }] } },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/orders' } } },
    });
    expect(normalizeAsyncApiDocument(d, '/spec.yaml').refusals['no-address']).toBe(1);
  });

  it('stops examining a document at the per-document operation cap', () => {
    const operations: Record<string, unknown> = {};
    for (let i = 0; i < 5_010; i += 1) {
      operations[`op${i}`] = { action: 'send', channel: { $ref: '#/channels/c' } };
    }
    const d = doc({
      servers: kafka,
      channels: { c: { address: CHANNEL_ADDRESS, servers: [{ $ref: '#/servers/s' }] } },
      operations,
    });
    const result = normalizeAsyncApiDocument(d, '/spec.yaml');
    expect(result.refusals['operation-cap']).toBe(1);
    expect(result.operations.length).toBeLessThanOrEqual(5_000);
  });

  it('stops at the run-wide operation budget', () => {
    const operations: Record<string, unknown> = {};
    for (let i = 0; i < 5; i += 1) {
      operations[`op${i}`] = { action: 'send', channel: { $ref: '#/channels/c' } };
    }
    const d = doc({
      servers: kafka,
      channels: { c: { address: CHANNEL_ADDRESS, servers: [{ $ref: '#/servers/s' }] } },
      operations,
    });
    const result = normalizeAsyncApiDocument(d, '/spec.yaml', 2);
    expect(result.operations).toHaveLength(2);
    expect(result.refusals['total-operation-cap']).toBe(1);
  });
});

describe('normalizeAsyncApiDocument — reference resolution', () => {
  const kafka = { s: { host: 'example', protocol: 'kafka' } };

  it('resolves a JSON Pointer reference that escapes a slash', () => {
    const d = doc({
      servers: kafka,
      channels: { 'orders/v1': { address: 'orders.v1', servers: [{ $ref: '#/servers/s' }] } },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/orders~1v1' } } },
    });
    expect(normalizeAsyncApiDocument(d, '/spec.yaml').operations[0].address).toBe('orders.v1');
  });

  it('decodes `~01` to a literal `~1`, not to a slash', () => {
    // RFC 6901 fixes the order: `~1` before `~0`. Reversing it turns a channel
    // literally named `orders~1v1` into a reference to `orders/v1`.
    const d = doc({
      servers: kafka,
      channels: { 'orders~1v1': { address: 'tilde.one', servers: [{ $ref: '#/servers/s' }] } },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/orders~01v1' } } },
    });
    expect(normalizeAsyncApiDocument(d, '/spec.yaml').operations[0].address).toBe('tilde.one');
  });

  it('percent-decodes before applying pointer escapes', () => {
    const d = doc({
      servers: kafka,
      channels: { 'orders v1': { address: 'pct', servers: [{ $ref: '#/servers/s' }] } },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/orders%20v1' } } },
    });
    expect(normalizeAsyncApiDocument(d, '/spec.yaml').operations[0].address).toBe('pct');
  });

  it('refuses a reference to a channel that is not in the document', () => {
    const d = doc({
      servers: kafka,
      channels: { orders: { address: CHANNEL_ADDRESS } },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/missing' } } },
    });
    expect(normalizeAsyncApiDocument(d, '/spec.yaml').refusals['channel-not-found']).toBe(1);
  });

  it('does not answer a channel lookup with Object.prototype', () => {
    // `__proto__`, not `constructor`: a function is rejected by the type test
    // whatever the property guard does, but `Object.prototype` IS an object and
    // would sail through as an empty channel. This is the case that makes the
    // own-property guard load-bearing rather than decorative.
    const d = doc({
      servers: kafka,
      channels: { orders: { address: CHANNEL_ADDRESS } },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/__proto__' } } },
    });
    const { operations, refusals } = normalizeAsyncApiDocument(d, '/spec.yaml');
    expect(operations).toHaveLength(0);
    expect(refusals['channel-not-found']).toBe(1);
    expect(refusals['no-address']).toBeUndefined();
  });

  it('does not answer a channel lookup with a prototype function', () => {
    const d = doc({
      servers: kafka,
      channels: { orders: { address: CHANNEL_ADDRESS } },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/constructor' } } },
    });
    expect(normalizeAsyncApiDocument(d, '/spec.yaml').refusals['channel-not-found']).toBe(1);
  });
});

describe('readAsyncApiDocuments', () => {
  // Tracked and removed: an earlier version of this suite left 162 temporary
  // directories (and a named pipe) behind on one developer machine.
  const created: string[] = [];
  afterAll(async () => {
    for (const dir of created) await rm(dir, { recursive: true, force: true });
  });

  async function fixture(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-asyncapi-'));
    created.push(dir);
    for (const [rel, body] of Object.entries(files)) {
      const full = path.join(dir, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, body, 'utf-8');
    }
    return dir;
  }

  const VALID = `
asyncapi: 3.0.0
info: { title: Order Service, version: 1.0.0 }
servers:
  broker: { host: "example:9092", protocol: kafka }
channels:
  orders:
    address: orders
    servers: [{ $ref: "#/servers/broker" }]
operations:
  sendOrder:
    action: send
    channel: { $ref: "#/channels/orders" }
`;

  it('reads a directory, skipping unrelated files without parsing them', async () => {
    const dir = await fixture({
      'api/asyncapi.yaml': VALID,
      'api/values.yaml': 'replicaCount: 2\nimage: { tag: latest }\n',
      'api/notes.txt': 'ignored by extension',
    });
    const result = await readAsyncApiDocuments(dir, '.');
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].action).toBe('send');
    expect(result.documentsAccepted).toBe(1);
    expect(result.documentsScanned).toBe(2);
    expect(result.refusals['not-a-document']).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('reads a JSON document, which is a first-class supported form', async () => {
    const dir = await fixture({
      'asyncapi.json': JSON.stringify({
        asyncapi: '3.0.0',
        servers: { b: { host: 'example', protocol: 'kafka' } },
        channels: { c: { address: 'orders', servers: [{ $ref: '#/servers/b' }] } },
        operations: { sendOrder: { action: 'send', channel: { $ref: '#/channels/c' } } },
      }),
    });
    const result = await readAsyncApiDocuments(dir, '.');
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].broker).toBe('kafka');
  });

  it('accepts a single file and reports its provenance', async () => {
    const dir = await fixture({ 'asyncapi.yaml': VALID });
    const result = await readAsyncApiDocuments(dir, 'asyncapi.yaml');
    expect(result.operations).toHaveLength(1);
    expect(result.documentsScanned).toBe(1);
    expect(result.documentsAccepted).toBe(1);
    expect(result.operations[0].documentPath).toBe(path.join(dir, 'asyncapi.yaml'));
  });

  it('resolves an absolute configured path, so an out-of-band cache works', async () => {
    const dir = await fixture({ 'asyncapi.yaml': VALID });
    const result = await readAsyncApiDocuments('/nonexistent-repo-root', dir);
    expect(result.operations).toHaveLength(1);
  });

  it('reports a missing configured path instead of throwing', async () => {
    const result = await readAsyncApiDocuments('/nonexistent-repo-root', '/nowhere-at-all');
    expect(result.operations).toHaveLength(0);
    expect(result.refusals['unreadable']).toBe(1);
  });

  it('survives a malformed document', async () => {
    const dir = await fixture({ 'broken.yaml': 'asyncapi: 3.0.0\n  bad: [unclosed\n' });
    const result = await readAsyncApiDocuments(dir, '.');
    expect(result.operations).toHaveLength(0);
    expect(result.refusals['unparsable']).toBe(1);
  });

  it('refuses a file larger than the byte cap', async () => {
    // Padded inside a comment so the document stays syntactically valid: the
    // point is that the cap refuses it before the parser ever sees it.
    const dir = await fixture({ 'huge.yaml': `# ${'x'.repeat(9 * 1024 * 1024)}\n${VALID}` });
    const result = await readAsyncApiDocuments(dir, '.');
    expect(result.refusals['oversized']).toBe(1);
    expect(result.operations).toHaveLength(0);
  });

  it('refuses a non-regular file rather than blocking on it', async () => {
    // A FIFO passes a path-based size check with size 0 and then blocks the
    // read until a writer appears — for the whole analyze, holding its
    // repository lock. The shared handle's `isFile` test is what stops it.
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-asyncapi-fifo-'));
    created.push(dir);
    const fifo = path.join(dir, 'spec.yaml');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      return; // no mkfifo on this platform; the guard is still exercised above
    }
    const result = await readAsyncApiDocuments(dir, 'spec.yaml');
    expect(result.refusals['unreadable']).toBe(1);
    expect(result.operations).toHaveLength(0);
  });

  it('counts a symlinked entry instead of dropping it in silence', async () => {
    // A cache written by other tooling is very often a symlink farm, and an
    // operator whose whole cache was skipped would otherwise see a result
    // identical to a wrong path.
    const dir = await fixture({ 'real/asyncapi.yaml': VALID });
    await symlink(path.join(dir, 'real', 'asyncapi.yaml'), path.join(dir, 'linked.yaml'));
    const result = await readAsyncApiDocuments(dir, '.');
    expect(result.symlinksSkipped).toBe(1);
    // The real document under `real/` is still read; only the link is skipped.
    expect(result.operations).toHaveLength(1);
  });

  it('reads documents in an order fixed by the tree, not by the filesystem', async () => {
    // Asserts the CONTENT of the order, not merely that two identical runs
    // agree — a deterministic but unsorted walk passes the weaker check.
    const dir = await fixture({ 'b.yaml': VALID, 'a.yaml': VALID, 'c.yaml': VALID });
    const result = await readAsyncApiDocuments(dir, '.');
    expect(result.operations.map((o) => path.basename(o.documentPath))).toEqual([
      'a.yaml',
      'b.yaml',
      'c.yaml',
    ]);
  });

  it('does not let one over-deep subtree discard the rest of the walk', async () => {
    // A shared abort flag made depth exhaustion in ONE branch terminate the
    // whole traversal, so whether ten perfectly good documents survived was
    // decided by whether the deep subtree sorted before or after them. Both
    // orderings must now keep all ten.
    for (const deepName of ['aaa-deep', 'zzz-deep']) {
      const files: Record<string, string> = {};
      for (let i = 0; i < 10; i += 1) files[`doc${i}.yaml`] = VALID;
      files[`${deepName}/${'lvl/'.repeat(11)}leaf.txt`] = 'too deep to reach';
      const dir = await fixture(files);
      const result = await readAsyncApiDocuments(dir, '.');
      expect(result.documentsAccepted).toBe(10);
      // Still reported as a floor: a bound did stop part of the walk.
      expect(result.truncated).toBe(true);
    }
  });

  it('counts a subdirectory it could not list', async () => {
    // Under a mixed-permission cache half the documents can be invisible while
    // the run otherwise reports a clean, complete read.
    const dir = await fixture({ 'ok.yaml': VALID, 'secret/hidden.yaml': VALID });
    const secret = path.join(dir, 'secret');
    await chmod(secret, 0o000);
    try {
      const result = await readAsyncApiDocuments(dir, '.');
      expect(result.refusals['directory-unreadable']).toBe(1);
      expect(result.truncated).toBe(true);
    } finally {
      await chmod(secret, 0o755);
    }
  });

  it('reads a document whose root key sits behind a long header', async () => {
    // The sniff window is a parse gate, not a read gate — the content is
    // already in memory — so it can afford to be generous. Four kilobytes was
    // not: a licence header longer than that refused a perfectly good document.
    const dir = await fixture({ 'headed.yaml': `# ${'licence '.repeat(1500)}\n${VALID}` });
    const result = await readAsyncApiDocuments(dir, '.');
    expect(result.operations).toHaveLength(1);
  });

  it('reads a large document whole', async () => {
    // Exercises the read loop. A single `read` was never short across seven
    // hundred probes here, but POSIX permits it and the FUSE mounts this
    // option's out-of-band cache typically lives on do return short counts —
    // and a document truncated at a line boundary still parses, so operations
    // would vanish with no refusal and no truncation flag.
    const dir = await fixture({ 'big.yaml': `${VALID}\n# ${'x'.repeat(6 * 1024 * 1024)}\n` });
    const result = await readAsyncApiDocuments(dir, '.');
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].address).toBe('orders');
  });

  it('reads a `.yml` document, the other spelling of the same extension', async () => {
    const dir = await fixture({ 'asyncapi.yml': VALID });
    expect((await readAsyncApiDocuments(dir, '.')).operations).toHaveLength(1);
  });

  it('names the bound that stopped a walk', async () => {
    const files: Record<string, string> = { 'doc.yaml': VALID };
    files[`deep/${'lvl/'.repeat(11)}leaf.txt`] = 'too deep to reach';
    const dir = await fixture(files);
    const result = await readAsyncApiDocuments(dir, '.');
    expect(result.truncated).toBe(true);
    expect(result.refusals['walk-truncated']).toBe(1);
  });

  it('refuses a character device without streaming it', async () => {
    // The `isFile` test on the handle exists for this case, and the FIFO test
    // does not reach it — `O_NONBLOCK` makes the read fail there by a different
    // route. A device reports size 0 and would otherwise stream until Node
    // throws at two gigabytes.
    if (process.platform === 'win32') return;
    const result = await readAsyncApiDocuments('/', '/dev/zero');
    expect(result.refusals['unreadable']).toBe(1);
    expect(result.operations).toHaveLength(0);
  });

  it('counts every refusal reason it emits under a known member', async () => {
    const dir = await fixture({ 'two.yaml': 'asyncapi: 2.6.0\nchannels: {}\n' });
    const result = await readAsyncApiDocuments(dir, '.');
    const known: AsyncApiRefusal[] = ['asyncapi-2-unsupported'];
    expect(Object.keys(result.refusals)).toEqual(known);
  });
});
