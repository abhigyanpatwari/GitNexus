import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import {
  compilePatterns,
  type LanguagePatterns,
  type PatternSpec,
} from '../tree-sitter-scanner.js';
import type { TopicMeta } from './types.js';

/**
 * Node.js / TypeScript topic extraction patterns.
 *
 * Detects kafkajs, amqplib (RabbitMQ), and nats.js producer/consumer APIs:
 *   - `producer.send({ topic: 'xxx', ... })` (kafkajs)
 *   - `consumer.subscribe({ topic: 'xxx', ... })` (kafkajs)
 *   - `channel.consume("queue", ...)` / `channel.publish(...)` / `channel.sendToQueue(...)`
 *   - `nc.subscribe("topic")` / `js.subscribe("topic")`
 *   - `nc.publish("topic", ...)` / `js.publish("topic", ...)`
 *
 * The JavaScript and TypeScript tree-sitter grammars share node type
 * names for every construct we query here, so the pattern sources are
 * defined once and compiled against each grammar variant. We export three
 * providers because Parser.Query objects are NOT portable across grammar
 * instances — `.js` files use the JavaScript grammar, `.ts` uses
 * TypeScript.typescript, and `.tsx` uses TypeScript.tsx.
 *
 * Every query MUST bind `@value` to the topic literal node.
 */
const NODE_TOPIC_PATTERNS: PatternSpec<TopicMeta>[] = [
  {
    meta: {
      role: 'provider',
      broker: 'kafka',
      confidence: 0.8,
      symbolName: 'producer.send',
    },
    query: `
      (call_expression
        function: (member_expression
          object: (identifier) @obj (#eq? @obj "producer")
          property: (property_identifier) @prop (#eq? @prop "send"))
        arguments: (arguments
          (object
            (pair
              key: (property_identifier) @key (#eq? @key "topic")
              value: [(string) (template_string)] @value))))
    `,
  },
  {
    meta: {
      role: 'consumer',
      broker: 'kafka',
      confidence: 0.8,
      symbolName: 'consumer.subscribe',
    },
    query: `
      (call_expression
        function: (member_expression
          object: (identifier) @obj (#eq? @obj "consumer")
          property: (property_identifier) @prop (#eq? @prop "subscribe"))
        arguments: (arguments
          (object
            (pair
              key: (property_identifier) @key (#eq? @key "topic")
              value: [(string) (template_string)] @value))))
    `,
  },
  {
    meta: {
      role: 'consumer',
      broker: 'rabbitmq',
      confidence: 0.8,
      symbolName: 'channel.consume',
    },
    query: `
      (call_expression
        function: (member_expression
          object: (identifier) @obj (#eq? @obj "channel")
          property: (property_identifier) @prop (#eq? @prop "consume"))
        arguments: (arguments . [(string) (template_string)] @value))
    `,
  },
  {
    meta: {
      role: 'provider',
      broker: 'rabbitmq',
      confidence: 0.8,
      symbolName: 'channel.publish',
    },
    query: `
      (call_expression
        function: (member_expression
          object: (identifier) @obj (#eq? @obj "channel")
          property: (property_identifier) @prop (#eq? @prop "publish"))
        arguments: (arguments . [(string) (template_string)] @value))
    `,
  },
  {
    meta: {
      role: 'provider',
      broker: 'rabbitmq',
      confidence: 0.8,
      symbolName: 'channel.sendToQueue',
    },
    query: `
      (call_expression
        function: (member_expression
          object: (identifier) @obj (#eq? @obj "channel")
          property: (property_identifier) @prop (#eq? @prop "sendToQueue"))
        arguments: (arguments . [(string) (template_string)] @value))
    `,
  },
  {
    meta: {
      role: 'consumer',
      broker: 'nats',
      confidence: 0.8,
      symbolName: 'nc.subscribe',
    },
    query: `
      (call_expression
        function: (member_expression
          object: (identifier) @obj (#match? @obj "^(nc|js)$")
          property: (property_identifier) @prop (#match? @prop "^[Ss]ubscribe$"))
        arguments: (arguments . [(string) (template_string)] @value))
    `,
  },
  {
    meta: {
      role: 'provider',
      broker: 'nats',
      confidence: 0.8,
      symbolName: 'nc.publish',
    },
    query: `
      (call_expression
        function: (member_expression
          object: (identifier) @obj (#match? @obj "^(nc|js)$")
          property: (property_identifier) @prop (#match? @prop "^[Pp]ublish$"))
        arguments: (arguments . [(string) (template_string)] @value))
    `,
  },
];

const JAVASCRIPT_TOPIC_SPEC: LanguagePatterns<TopicMeta> = {
  name: 'javascript-topic',
  language: JavaScript,
  patterns: NODE_TOPIC_PATTERNS,
};

const TYPESCRIPT_TOPIC_SPEC: LanguagePatterns<TopicMeta> = {
  name: 'typescript-topic',
  language: TypeScript.typescript,
  patterns: NODE_TOPIC_PATTERNS,
};

const TSX_TOPIC_SPEC: LanguagePatterns<TopicMeta> = {
  name: 'tsx-topic',
  language: TypeScript.tsx,
  patterns: NODE_TOPIC_PATTERNS,
};

export const JAVASCRIPT_TOPIC_PROVIDER = compilePatterns(JAVASCRIPT_TOPIC_SPEC);
export const TYPESCRIPT_TOPIC_PROVIDER = compilePatterns(TYPESCRIPT_TOPIC_SPEC);
export const TSX_TOPIC_PROVIDER = compilePatterns(TSX_TOPIC_SPEC);
