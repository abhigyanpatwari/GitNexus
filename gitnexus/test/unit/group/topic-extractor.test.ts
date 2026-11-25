import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TopicExtractor } from '../../../src/core/group/extractors/topic-extractor.js';
import type { RepoHandle } from '../../../src/core/group/types.js';

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

  describe('JetStream', () => {
    it('test_extract_jetstream_publish_returns_provider', async () => {
      writeFile('src/stream.go', `js.Publish("orders.created", payload)`);

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const producers = contracts.filter((c) => c.role === 'provider');

      expect(producers).toHaveLength(1);
      expect(producers[0].contractId).toBe('topic::orders.created');
      expect(producers[0].meta.broker).toBe('nats');
    });

    it('test_extract_jetstream_subscribe_returns_consumer', async () => {
      writeFile('src/stream.go', `js.Subscribe("orders.created", handler)`);

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('topic::orders.created');
      expect(consumers[0].meta.broker).toBe('nats');
    });
  });

  describe('Python NATS', () => {
    it('test_extract_python_nats_subscribe_returns_consumer', async () => {
      writeFile(
        'src/subscriber.py',
        `nc = await nats.connect()
await nc.subscribe("orders.created", cb=handler)`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('topic::orders.created');
      expect(consumers[0].meta.broker).toBe('nats');
    });

    it('test_extract_python_nats_publish_returns_provider', async () => {
      writeFile(
        'src/publisher.py',
        `nc = await nats.connect()
await nc.publish("orders.created", payload)`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const producers = contracts.filter((c) => c.role === 'provider');

      expect(producers).toHaveLength(1);
      expect(producers[0].contractId).toBe('topic::orders.created');
      expect(producers[0].meta.broker).toBe('nats');
    });
  });

  describe('NATS', () => {
    it('test_extract_nats_subscribe_go_returns_consumer', async () => {
      writeFile(
        'cmd/sub.go',
        `package main
nc, _ := nats.Connect(nats.DefaultURL)
nc.Subscribe("updates.weather", func(m *nats.Msg) {
    fmt.Println(string(m.Data))
})`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('topic::updates.weather');
      expect(consumers[0].meta.broker).toBe('nats');
    });

    it('test_extract_nats_publish_go_returns_producer', async () => {
      writeFile(
        'cmd/pub.go',
        `package main
nc, _ := nats.Connect(nats.DefaultURL)
nc.Publish("updates.weather", []byte("sunny"))`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const producers = contracts.filter((c) => c.role === 'provider');

      expect(producers).toHaveLength(1);
      expect(producers[0].contractId).toBe('topic::updates.weather');
    });
  });

  describe('Kafka — Go', () => {
    it('test_extract_sarama_consume_returns_consumer', async () => {
      writeFile(
        'internal/consumer.go',
        `package consumer
partConsumer, _ := consumer.ConsumePartition("inventory.update", 0, sarama.OffsetNewest)`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('topic::inventory.update');
      expect(consumers[0].meta.broker).toBe('kafka');
    });

    it('test_extract_sarama_sync_producer_returns_provider', async () => {
      writeFile(
        'internal/publisher.go',
        `package publisher
producer, _ := sarama.NewSyncProducer(brokers, cfg)
producer.SendMessage(&sarama.ProducerMessage{Topic: "inventory.update"})`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const producers = contracts.filter((c) => c.role === 'provider');

      expect(producers).toHaveLength(1);
      expect(producers[0].contractId).toBe('topic::inventory.update');
      expect(producers[0].meta.broker).toBe('kafka');
    });

    it('test_extract_sarama_async_producer_returns_provider', async () => {
      writeFile(
        'internal/publisher.go',
        `package publisher
producer, _ := sarama.NewAsyncProducer(brokers, cfg)
producer.Input() <- &sarama.ProducerMessage{Topic: "inventory.update"}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const producers = contracts.filter((c) => c.role === 'provider');

      expect(producers).toHaveLength(1);
      expect(producers[0].contractId).toBe('topic::inventory.update');
      expect(producers[0].meta.broker).toBe('kafka');
    });

    it('test_extract_sarama_producer_in_loop_captures_all_topics', async () => {
      // Regression: a for loop that constructs multiple ProducerMessage
      // literals inside a single NewSyncProducer scope. The previous
      // regex anchored on NewSyncProducer and captured only the first
      // Topic within 300 chars, silently dropping the rest.
      writeFile(
        'internal/multi-publisher.go',
        `package publisher

func publishAll(producer sarama.SyncProducer, items []Item) error {
  _, _ = sarama.NewSyncProducer(brokers, cfg)
  for _, item := range items {
    msg1 := &sarama.ProducerMessage{Topic: "order.created"}
    msg2 := &sarama.ProducerMessage{Topic: "order.shipped"}
    _ = msg1
    _ = msg2
  }
  return nil
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const producers = contracts.filter((c) => c.role === 'provider');
      const topics = producers.map((c) => c.contractId).sort();
      // Both topics must appear (exact set match to catch any duplicates).
      expect(topics).toEqual(['topic::order.created', 'topic::order.shipped']);
    });

    it('test_extract_kafka_go_writer_returns_provider', async () => {
      writeFile(
        'internal/writer.go',
        `package publisher
writer := &kafka.Writer{Topic: "inventory.update"}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const producers = contracts.filter((c) => c.role === 'provider');

      expect(producers).toHaveLength(1);
      expect(producers[0].contractId).toBe('topic::inventory.update');
      expect(producers[0].meta.broker).toBe('kafka');
    });

    it('test_extract_kafka_go_reader_returns_consumer', async () => {
      writeFile(
        'internal/reader.go',
        `package consumer
reader := kafka.NewReader(kafka.ReaderConfig{Topic: "inventory.update"})`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('topic::inventory.update');
      expect(consumers[0].meta.broker).toBe('kafka');
    });
  });

  describe('Kafka — Python', () => {
    it('test_extract_kafka_python_subscribe_returns_consumer', async () => {
      writeFile(
        'app/consumer.py',
        `from kafka import KafkaConsumer
consumer = KafkaConsumer('payment.processed', bootstrap_servers=['localhost:9092'])`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('topic::payment.processed');
    });

    it('test_extract_kafka_python_producer_send_returns_producer', async () => {
      writeFile(
        'app/producer.py',
        `from kafka import KafkaProducer
producer = KafkaProducer(bootstrap_servers=['localhost:9092'])
producer.send('payment.processed', value=msg)`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const producers = contracts.filter((c) => c.role === 'provider');

      expect(producers).toHaveLength(1);
      expect(producers[0].contractId).toBe('topic::payment.processed');
    });
  });

  describe('edge cases', () => {
    it('test_extract_empty_repo_returns_empty', async () => {
      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      expect(contracts).toHaveLength(0);
    });

    it('test_extract_ignores_go_test_files', async () => {
      writeFile(
        'src/orders_test.go',
        `consumer.ConsumePartition("fake-topic", 0, sarama.OffsetNewest)`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      expect(contracts).toEqual([]);
    });
  });

  // ─── #1185: topic extractor must honour .gitnexusignore ─────────────
  //
  // The source-scan glob used to use a hardcoded ignore array; it now
  // consumes the shared `IgnoreService` (mirrors `filesystem-walker.ts`)
  // so any `.gitnexusignore` pattern excludes those files from contract
  // extraction. Special case for this extractor: the Go-specific
  // `_test.go` filter is preserved via a small wrapper around the base
  // filter (so glob-level pruning still applies); the second test below
  // pins that behaviour against accidental regressions.
  describe('respects .gitnexusignore (#1185)', () => {
    it('still prunes `*_test.go` even when .gitnexusignore is empty (wrapper preserves glob-level filter)', async () => {
      // Regression guard: replacing the hardcoded `**/*_test.go` glob
      // entry with a wrapper around `createIgnoreFilter` must keep this
      // file out of the scan. Without the wrapper, the previous test
      // ('skips Go test files (`*_test.go`)') would still pass because
      // the test scenario set up no detections, but here we WRITE a
      // valid Sarama consumer call inside `_test.go` and assert the
      // extractor never sees it.
      writeFile(
        'src/orders_test.go',
        `package orders
import "github.com/IBM/sarama"
func TestSomething() {
    consumer.ConsumePartition("real-topic-from-test", 0, sarama.OffsetNewest)
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      expect(contracts.find((c) => c.contractId === 'topic::real-topic-from-test')).toBeUndefined();
      expect(contracts).toEqual([]);
    });
  });
});
