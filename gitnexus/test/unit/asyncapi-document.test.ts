import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  normalizeAsyncApiDocument,
  readAsyncApiDocuments,
  type AsyncApiRefusal,
} from '../../src/core/ingestion/asyncapi/document.js';
import { brokerForProtocol } from '../../src/core/ingestion/asyncapi/protocol.js';
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

  it('rejects a JSON Pointer field name, which is not a protocol', () => {
    // AsyncAPI allows `bindings` to be a Reference Object, so the map key can
    // be `$ref`. Passed through it becomes half of a join key carrying no
    // broker information at all, and two services that both reference shared
    // bindings on one address would merge.
    expect(brokerForProtocol('$ref')).toBeUndefined();
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

  it('refuses when a channel with no `servers` could mean two different brokers', () => {
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
    expect(refusals['protocol-disagreement']).toBe(1);
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
  async function fixture(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-asyncapi-'));
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

  it('counts every refusal reason it emits under a known member', async () => {
    const dir = await fixture({ 'two.yaml': 'asyncapi: 2.6.0\nchannels: {}\n' });
    const result = await readAsyncApiDocuments(dir, '.');
    const known: AsyncApiRefusal[] = ['asyncapi-2-unsupported'];
    expect(Object.keys(result.refusals)).toEqual(known);
  });
});
