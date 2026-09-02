import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  normalizeAsyncApiDocument,
  readAsyncApiDocuments,
  type AsyncApiRefusal,
} from '../../src/core/ingestion/asyncapi/document.js';
import { brokerForProtocol } from '../../src/core/ingestion/asyncapi/protocol.js';

/**
 * The pure half of AsyncAPI reading: version gating, the two-source broker
 * reading, and the refusal taxonomy.
 *
 * DIRECTION IS PINNED HARDEST, because it is the one error this module can
 * make that leaves everything looking healthy. A reversed `send`/`receive`
 * mapping still emits both roles, still emits every edge, and still produces a
 * connected graph — only with every arrow backwards. An assertion that a node
 * or an operation EXISTS passes identically under both readings, so every
 * direction test below asserts the action itself.
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

  it('reads the broker from the channel’s server alone', () => {
    const d = doc({
      servers: { s: { host: 'example', protocol: 'amqp' } },
      channels: { orders: { address: CHANNEL_ADDRESS, servers: [{ $ref: '#/servers/s' }] } },
      operations: { op: { action: 'receive', channel: { $ref: '#/channels/orders' } } },
    });
    expect(normalizeAsyncApiDocument(d, '/spec.yaml').operations[0].broker).toBe('rabbit');
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
    // `amqp` from a server and `amqp1` from bindings are one broker family,
    // so the two readings agree and the operation survives.
    const d = doc({
      servers: { s: { host: 'example', protocol: 'amqp' } },
      channels: { orders: { address: CHANNEL_ADDRESS, servers: [{ $ref: '#/servers/s' }] } },
      operations: {
        op: { action: 'send', channel: { $ref: '#/channels/orders' }, bindings: { amqp1: {} } },
      },
    });
    expect(normalizeAsyncApiDocument(d, '/spec.yaml').operations[0].broker).toBe('rabbit');
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
  it('keys on `address`, not on the channel map key', () => {
    // A generator may key a channel by anything unique. Keying a node on that
    // would join two services that merely organized their documents alike.
    const d = doc({
      channels: {
        someLocalKey: { address: 'orders.v1', servers: [{ $ref: '#/servers/s' }] },
      },
      servers: { s: { host: 'example', protocol: 'kafka' } },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/someLocalKey' } } },
    });
    expect(normalizeAsyncApiDocument(d, '/spec.yaml').operations[0].address).toBe('orders.v1');
  });

  it('refuses a channel with no address', () => {
    const d = doc({
      servers: { s: { host: 'example', protocol: 'kafka' } },
      channels: { orders: { servers: [{ $ref: '#/servers/s' }] } },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/orders' } } },
    });
    const { refusals } = normalizeAsyncApiDocument(d, '/spec.yaml');
    expect(refusals['no-address']).toBe(1);
  });

  it('resolves a JSON Pointer reference that escapes a slash', () => {
    const d = doc({
      servers: { s: { host: 'example', protocol: 'kafka' } },
      channels: {
        'orders/v1': { address: 'orders.v1', servers: [{ $ref: '#/servers/s' }] },
      },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/orders~1v1' } } },
    });
    expect(normalizeAsyncApiDocument(d, '/spec.yaml').operations[0].address).toBe('orders.v1');
  });

  it('refuses a reference to a channel that is not in the document', () => {
    const d = doc({
      channels: { orders: { address: CHANNEL_ADDRESS } },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/missing' } } },
    });
    const { refusals } = normalizeAsyncApiDocument(d, '/spec.yaml');
    expect(refusals['channel-not-found']).toBe(1);
  });

  it('does not answer a channel lookup from the prototype chain', () => {
    const d = doc({
      channels: { orders: { address: CHANNEL_ADDRESS } },
      operations: { op: { action: 'send', channel: { $ref: '#/channels/constructor' } } },
    });
    const { operations, refusals } = normalizeAsyncApiDocument(d, '/spec.yaml');
    expect(operations).toHaveLength(0);
    expect(refusals['channel-not-found']).toBe(1);
  });

  it('carries message names as provenance without keying on them', () => {
    const d = doc({
      servers: { s: { host: 'example', protocol: 'kafka' } },
      channels: {
        orders: {
          address: CHANNEL_ADDRESS,
          servers: [{ $ref: '#/servers/s' }],
          messages: { 'com.example.OrderCreated': {} },
        },
      },
      operations: {
        op: {
          action: 'send',
          channel: { $ref: '#/channels/orders' },
          messages: [{ $ref: '#/channels/orders/messages/com.example.OrderCreated' }],
        },
      },
    });
    expect(normalizeAsyncApiDocument(d, '/spec.yaml').operations[0].messageNames).toEqual([
      'com.example.OrderCreated',
    ]);
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
    // The unrelated YAML is counted as scanned and refused, not silently
    // dropped: a mistyped directory should be visible in the tally.
    expect(result.documentsScanned).toBe(2);
    expect(result.refusals['not-a-document']).toBe(1);
  });

  it('accepts a single file as well as a directory', async () => {
    const dir = await fixture({ 'asyncapi.yaml': VALID });
    const result = await readAsyncApiDocuments(dir, 'asyncapi.yaml');
    expect(result.operations).toHaveLength(1);
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

  it('produces a document-order-independent result', async () => {
    // The walk sorts entries, so two documents contribute in a fixed order
    // regardless of how the filesystem enumerates them.
    const dir = await fixture({ 'b.yaml': VALID, 'a.yaml': VALID });
    const first = await readAsyncApiDocuments(dir, '.');
    const second = await readAsyncApiDocuments(dir, '.');
    expect(first.operations.map((o) => o.documentPath)).toEqual(
      second.operations.map((o) => o.documentPath),
    );
    expect(first.operations).toHaveLength(2);
  });

  it('counts every refusal reason it emits under a known member', async () => {
    const dir = await fixture({ 'two.yaml': 'asyncapi: 2.6.0\nchannels: {}\n' });
    const result = await readAsyncApiDocuments(dir, '.');
    const known: AsyncApiRefusal[] = ['asyncapi-2-unsupported'];
    expect(Object.keys(result.refusals)).toEqual(known);
  });
});
