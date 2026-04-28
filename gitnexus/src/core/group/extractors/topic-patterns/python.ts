import Python from 'tree-sitter-python';
import { compilePatterns, type LanguagePatterns } from '../tree-sitter-scanner.js';
import type { TopicMeta } from './types.js';

/**
 * Python topic extraction patterns.
 *
 * Detects kafka-python, pika (RabbitMQ), and nats-py producer/consumer APIs:
 *   - `KafkaConsumer('topic', ...)`
 *   - `producer.send('topic', ...)` / `producer.produce('topic', ...)`
 *   - `channel.basic_consume(queue='xxx', ...)`
 *   - `channel.basic_publish(exchange='xxx', ...)`
 *   - `await nc.subscribe('topic')`
 *   - `await nc.publish('topic', ...)`
 *
 * Every query MUST bind `@value` to the topic literal node.
 */
const PYTHON_TOPIC_SPEC: LanguagePatterns<TopicMeta> = {
  name: 'python-topic',
  language: Python,
  patterns: [
    {
      meta: {
        role: 'consumer',
        broker: 'kafka',
        confidence: 0.7,
        symbolName: 'KafkaConsumer',
      },
      query: `
        (call
          function: (identifier) @func (#eq? @func "KafkaConsumer")
          arguments: (argument_list . (string) @value))
      `,
    },
    {
      meta: {
        role: 'provider',
        broker: 'kafka',
        confidence: 0.7,
        symbolName: 'producer.send',
      },
      query: `
        (call
          function: (attribute
            object: (identifier) @obj (#eq? @obj "producer")
            attribute: (identifier) @method (#match? @method "^(send|produce)$"))
          arguments: (argument_list . (string) @value))
      `,
    },
    {
      meta: {
        role: 'consumer',
        broker: 'rabbitmq',
        confidence: 0.7,
        symbolName: 'basic_consume',
      },
      query: `
        (call
          function: (attribute
            object: (identifier) @obj (#eq? @obj "channel")
            attribute: (identifier) @method (#eq? @method "basic_consume"))
          arguments: (argument_list
            (keyword_argument
              name: (identifier) @kw (#eq? @kw "queue")
              value: (string) @value)))
      `,
    },
    {
      meta: {
        role: 'provider',
        broker: 'rabbitmq',
        confidence: 0.7,
        symbolName: 'basic_publish',
      },
      query: `
        (call
          function: (attribute
            object: (identifier) @obj (#eq? @obj "channel")
            attribute: (identifier) @method (#eq? @method "basic_publish"))
          arguments: (argument_list
            (keyword_argument
              name: (identifier) @kw (#eq? @kw "exchange")
              value: (string) @value)))
      `,
    },
    {
      meta: {
        role: 'consumer',
        broker: 'nats',
        confidence: 0.75,
        symbolName: 'nc.subscribe',
      },
      query: `
        (call
          function: (attribute
            object: (identifier) @obj (#eq? @obj "nc")
            attribute: (identifier) @method (#eq? @method "subscribe"))
          arguments: (argument_list . (string) @value))
      `,
    },
    {
      meta: {
        role: 'provider',
        broker: 'nats',
        confidence: 0.75,
        symbolName: 'nc.publish',
      },
      query: `
        (call
          function: (attribute
            object: (identifier) @obj (#eq? @obj "nc")
            attribute: (identifier) @method (#eq? @method "publish"))
          arguments: (argument_list . (string) @value))
      `,
    },
  ],
};

export const PYTHON_TOPIC_PROVIDER = compilePatterns(PYTHON_TOPIC_SPEC);
