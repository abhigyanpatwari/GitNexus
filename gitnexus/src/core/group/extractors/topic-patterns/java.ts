import Java from 'tree-sitter-java';
import { compilePatterns, type LanguagePatterns } from '../tree-sitter-scanner.js';
import type { TopicMeta } from './types.js';

/**
 * Java topic extraction patterns.
 *
 * Detects Kafka, RabbitMQ (Spring conventions) and SOFAMQ (OpenMessaging API)
 * producer/consumer APIs:
 *   - `@KafkaListener(topics = "xxx")`
 *   - `@RabbitListener(queues = "xxx")`
 *   - `kafkaTemplate.send("xxx", ...)`
 *   - `rabbitTemplate.convertAndSend("xxx", ...)`
 *   - `consumer.subscribe("topic", "tag", listener)`     (SOFAMQ consumer)
 *   - `new Message("topic", "tag", body)`                (SOFAMQ producer)
 *
 * Every query MUST bind `@value` to the topic literal node.
 */
const JAVA_TOPIC_SPEC: LanguagePatterns<TopicMeta> = {
  name: 'java-topic',
  language: Java,
  patterns: [
    {
      meta: {
        role: 'consumer',
        broker: 'kafka',
        confidence: 0.8,
        symbolName: 'kafkaListener',
      },
      query: `
        (annotation
          name: (identifier) @name (#eq? @name "KafkaListener")
          arguments: (annotation_argument_list
            (element_value_pair
              key: (identifier) @key (#eq? @key "topics")
              value: (string_literal) @value)))
      `,
    },
    {
      meta: {
        role: 'consumer',
        broker: 'rabbitmq',
        confidence: 0.8,
        symbolName: 'rabbitListener',
      },
      query: `
        (annotation
          name: (identifier) @name (#eq? @name "RabbitListener")
          arguments: (annotation_argument_list
            (element_value_pair
              key: (identifier) @key (#eq? @key "queues")
              value: (string_literal) @value)))
      `,
    },
    {
      meta: {
        role: 'provider',
        broker: 'kafka',
        confidence: 0.8,
        symbolName: 'kafkaTemplate.send',
      },
      query: `
        (method_invocation
          object: (identifier) @obj (#eq? @obj "kafkaTemplate")
          name: (identifier) @method (#eq? @method "send")
          arguments: (argument_list . (string_literal) @value))
      `,
    },
    {
      meta: {
        role: 'provider',
        broker: 'rabbitmq',
        confidence: 0.8,
        symbolName: 'rabbitTemplate.convertAndSend',
      },
      query: `
        (method_invocation
          object: (identifier) @obj (#eq? @obj "rabbitTemplate")
          name: (identifier) @method (#eq? @method "convertAndSend")
          arguments: (argument_list . (string_literal) @value))
      `,
    },
    {
      meta: {
        role: 'consumer',
        broker: 'sofamq',
        confidence: 0.7,
        symbolName: 'openMessaging.Consumer.subscribe',
      },
      query: `
        (method_invocation
          object: (identifier) @obj (#eq? @obj "consumer")
          name: (identifier) @method (#eq? @method "subscribe")
          arguments: (argument_list . (string_literal) @value))
      `,
    },
    {
      meta: {
        role: 'provider',
        broker: 'sofamq',
        confidence: 0.7,
        symbolName: 'openMessaging.Message.constructor',
      },
      query: `
        (object_creation_expression
          type: (type_identifier) @cls (#eq? @cls "Message")
          arguments: (argument_list . (string_literal) @value))
      `,
    },
  ],
};

export const JAVA_TOPIC_PROVIDER = compilePatterns(JAVA_TOPIC_SPEC);
