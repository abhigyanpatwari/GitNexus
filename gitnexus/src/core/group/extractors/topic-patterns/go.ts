import Go from 'tree-sitter-go';
import { compilePatterns, type LanguagePatterns } from '../tree-sitter-scanner.js';
import type { TopicMeta } from './types.js';

/**
 * Go topic extraction patterns.
 *
 * Detects Sarama, segmentio/kafka-go and nats.go producer/consumer APIs:
 *   - `X.ConsumePartition("topic", ...)`
 *   - `sarama.ProducerMessage{Topic: "xxx"}`
 *   - `kafka.Writer{Topic: "xxx"}` / `kafka.WriterConfig{Topic: ...}`
 *   - `kafka.Reader{Topic: "xxx"}` / `kafka.ReaderConfig{Topic: ...}`
 *   - `nc.Subscribe("topic", ...)` / `js.Subscribe("topic", ...)`
 *   - `nc.Publish("topic", ...)` / `js.Publish("topic", ...)`
 *
 * Every query MUST bind `@value` to the topic literal node.
 */
const GO_TOPIC_SPEC: LanguagePatterns<TopicMeta> = {
  name: 'go-topic',
  language: Go,
  patterns: [
    {
      meta: {
        role: 'consumer',
        broker: 'kafka',
        confidence: 0.7,
        symbolName: 'ConsumePartition',
      },
      query: `
        (call_expression
          function: (selector_expression
            field: (field_identifier) @method (#eq? @method "ConsumePartition"))
          arguments: (argument_list . (interpreted_string_literal) @value))
      `,
    },
    {
      meta: {
        role: 'provider',
        broker: 'kafka',
        confidence: 0.75,
        symbolName: 'sarama.ProducerMessage',
      },
      query: `
        (composite_literal
          type: (qualified_type
            package: (package_identifier) @pkg (#eq? @pkg "sarama")
            name: (type_identifier) @ty (#eq? @ty "ProducerMessage"))
          body: (literal_value
            (keyed_element
              (literal_element (identifier) @field (#eq? @field "Topic"))
              (literal_element (interpreted_string_literal) @value))))
      `,
    },
    {
      meta: {
        role: 'provider',
        broker: 'kafka',
        confidence: 0.75,
        symbolName: 'kafka.Writer',
      },
      query: `
        (composite_literal
          type: (qualified_type
            package: (package_identifier) @pkg (#eq? @pkg "kafka")
            name: (type_identifier) @ty (#match? @ty "^(Writer|WriterConfig)$"))
          body: (literal_value
            (keyed_element
              (literal_element (identifier) @field (#eq? @field "Topic"))
              (literal_element (interpreted_string_literal) @value))))
      `,
    },
    {
      meta: {
        role: 'consumer',
        broker: 'kafka',
        confidence: 0.75,
        symbolName: 'kafka.Reader',
      },
      query: `
        (composite_literal
          type: (qualified_type
            package: (package_identifier) @pkg (#eq? @pkg "kafka")
            name: (type_identifier) @ty (#match? @ty "^(Reader|ReaderConfig)$"))
          body: (literal_value
            (keyed_element
              (literal_element (identifier) @field (#eq? @field "Topic"))
              (literal_element (interpreted_string_literal) @value))))
      `,
    },
    {
      meta: {
        role: 'consumer',
        broker: 'nats',
        confidence: 0.8,
        symbolName: 'nc.Subscribe',
      },
      query: `
        (call_expression
          function: (selector_expression
            operand: (identifier) @obj (#match? @obj "^(nc|js)$")
            field: (field_identifier) @method (#match? @method "^[Ss]ubscribe$"))
          arguments: (argument_list . (interpreted_string_literal) @value))
      `,
    },
    {
      meta: {
        role: 'provider',
        broker: 'nats',
        confidence: 0.8,
        symbolName: 'nc.Publish',
      },
      query: `
        (call_expression
          function: (selector_expression
            operand: (identifier) @obj (#match? @obj "^(nc|js)$")
            field: (field_identifier) @method (#match? @method "^[Pp]ublish$"))
          arguments: (argument_list . (interpreted_string_literal) @value))
      `,
    },
  ],
};

export const GO_TOPIC_PROVIDER = compilePatterns(GO_TOPIC_SPEC);
