import { describe, it, beforeEach, afterEach } from 'node:test';
import { expect } from 'expect';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TopicExtractor } from '../../../../src/core/group/extractors/topic-extractor.js';
import type { RepoHandle } from '../../../../src/core/group/types.js';

describe('TopicExtractor', () => {
  let tmpDir: string;
  let extractor: TopicExtractor;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `gitnexus-topic-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    extractor = new TopicExtractor();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(relPath: string, content: string): void {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  const makeRepo = (repoPath: string): RepoHandle => ({
    id: 'test-repo',
    path: 'test/app',
    repoPath,
    storagePath: path.join(repoPath, '.gitnexus'),
  });

  describe('Kafka — Node', () => {
    it('test_extract_kafkajs_subscribe_returns_consumer', async () => {
      writeFile(
        'src/consumer.ts',
        `await consumer.subscribe({ topic: 'order.placed', fromBeginning: true });`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('topic::order.placed');
      expect(consumers[0].meta.broker).toBe('kafka');
    });

    it('test_extract_kafkajs_producer_send_returns_producer', async () => {
      writeFile(
        'src/producer.ts',
        `await producer.send({ topic: 'order.placed', messages: [{ value: JSON.stringify(order) }] });`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const producers = contracts.filter((c) => c.role === 'provider');

      expect(producers).toHaveLength(1);
      expect(producers[0].contractId).toBe('topic::order.placed');
    });
  });

  describe('KafkaJS consumer run', () => {
    it('test_extract_kafkajs_consumer_run_eachmessage_returns_consumer', async () => {
      writeFile(
        'src/consumer.ts',
        `await consumer.subscribe({ topic: 'user.logged-in' });
await consumer.run({ eachMessage: async () => {} });`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('topic::user.logged-in');
      expect(consumers[0].meta.broker).toBe('kafka');
    });
  });

  describe('RabbitMQ — Node', () => {
    it('test_extract_amqplib_consume_returns_consumer', async () => {
      writeFile(
        'src/worker.ts',
        `channel.consume("task-queue", (msg) => {
  console.log(msg.content.toString());
});`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('topic::task-queue');
      expect(consumers[0].meta.broker).toBe('rabbitmq');
    });

    it('test_extract_amqplib_publish_returns_producer', async () => {
      writeFile(
        'src/publisher.ts',
        `channel.publish("events", "user.signup", Buffer.from(JSON.stringify(data)));`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const producers = contracts.filter((c) => c.role === 'provider');

      expect(producers).toHaveLength(1);
      expect(producers[0].contractId).toBe('topic::events');
      expect(producers[0].meta.broker).toBe('rabbitmq');
    });

    it('test_extract_amqplib_sendToQueue_returns_producer', async () => {
      writeFile('src/sender.ts', `channel.sendToQueue("job-queue", Buffer.from(msg));`);

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const producers = contracts.filter((c) => c.role === 'provider');

      expect(producers).toHaveLength(1);
      expect(producers[0].contractId).toBe('topic::job-queue');
    });
  });

  describe('NATS', () => {
    it('test_extract_nats_subscribe_node_returns_consumer', async () => {
      writeFile(
        'src/sub.ts',
        `const sub = nc.subscribe("events.order");
for await (const msg of sub) { process(msg); }`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('topic::events.order');
    });

    it('test_extract_nats_publish_node_returns_producer', async () => {
      writeFile('src/pub.ts', `nc.publish("events.order", sc.encode(JSON.stringify(order)));`);

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const producers = contracts.filter((c) => c.role === 'provider');

      expect(producers).toHaveLength(1);
      expect(producers[0].contractId).toBe('topic::events.order');
    });
  });

  describe('edge cases', () => {
    it('test_extract_repo_without_queues_returns_empty', async () => {
      writeFile('src/index.ts', 'console.log("hello")');
      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      expect(contracts).toHaveLength(0);
    });

    it('test_extract_multiple_topics_in_one_file', async () => {
      writeFile(
        'src/events.ts',
        `await producer.send({ topic: 'user.created', messages: [] });
await producer.send({ topic: 'user.deleted', messages: [] });
await consumer.subscribe({ topic: 'order.placed' });`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      expect(contracts).toHaveLength(3);
      const producers = contracts.filter((c) => c.role === 'provider');
      const consumers = contracts.filter((c) => c.role === 'consumer');
      expect(producers).toHaveLength(2);
      expect(consumers).toHaveLength(1);
    });
  });
});
