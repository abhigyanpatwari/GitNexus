import { describe, expect, it } from 'vitest';
import type { SpringMessageProducerFact } from '../../src/core/ingestion/frameworks/spring/message-producers.js';
import { collectKotlinCaptureSideChannel } from '../../src/core/ingestion/languages/kotlin/capture-side-channel.js';
import { emitKotlinScopeCaptures } from '../../src/core/ingestion/languages/kotlin/captures.js';
const KOTLIN_FILE = 'src/OrderPublishers.kt';

function kotlinProducers(code: string): readonly SpringMessageProducerFact[] {
  emitKotlinScopeCaptures(code, KOTLIN_FILE);
  return collectKotlinCaptureSideChannel(KOTLIN_FILE)?.springMessageProducerFacts ?? [];
}

const signature = (fact: SpringMessageProducerFact) =>
  `${fact.template} ${fact.receiverName}.${fact.methodName}`;

const destination = (fact: SpringMessageProducerFact) => fact.args?.[0]?.text;

// Named arguments are illegal when the callee is a Java method — parameter
// names are not guaranteed in bytecode — so every named-argument example here
// publishes through a template DECLARED IN KOTLIN. `KotlinKafkaTemplate` is
// matched by the same receiver-name rule as the Spring class and keeps the
// examples compilable Kotlin rather than a shape no source could take.
describe('Kotlin Spring messaging producers', () => {
  const facts = kotlinProducers(`
    package com.example.messaging

    import com.example.messaging.support.Destinations
    import org.springframework.kafka.core.KafkaTemplate

    class KotlinKafkaTemplate {
        fun send(topic: String, data: String) {}
    }

    class OrderPublishers(private val kafkaTemplate: KafkaTemplate<String, String>) {
        private val kotlinKafkaTemplate = KotlinKafkaTemplate()
        private lateinit var ordersTopic: String

        fun literalDestination(payload: String) {
            kafkaTemplate.send("orders", payload)
        }

        fun constantDestination(payload: String) {
            this.kafkaTemplate.send(Destinations.ORDERS, payload)
        }

        fun configuredDestination(payload: String) {
            kafkaTemplate.send(ordersTopic, payload)
        }

        fun namedArguments(payload: String) {
            kotlinKafkaTemplate.send(topic = Destinations.ORDERS, data = payload)
        }

        fun safeCallReceiver(payload: String) {
            kafkaTemplate?.send("orders", payload)
        }

        fun rabbitDestination(exchange: String, routingKey: String, payload: String) {
            rabbitTemplate.convertAndSend(exchange, routingKey, payload)
        }

        fun jmsDestination(payload: String) {
            jmsTemplate.convertAndSend("queue.orders", payload)
        }

        fun spreadArgument(args: Array<String>) {
            streamBridge.send(*args)
        }
    }
  `);

  it('recognizes every supported template and method pair', () => {
    expect(facts.map(signature)).toEqual([
      'kafka kafkaTemplate.send',
      'kafka this.kafkaTemplate.send',
      'kafka kafkaTemplate.send',
      'kafka kotlinKafkaTemplate.send',
      'kafka kafkaTemplate.send',
      'rabbit rabbitTemplate.convertAndSend',
      'jms jmsTemplate.convertAndSend',
      'stream-bridge streamBridge.send',
    ]);
  });

  it('produces a fact for a literal, a constant, and a configuration-backed name alike', () => {
    expect(facts.slice(0, 3).map(destination)).toEqual([
      '"orders"',
      'Destinations.ORDERS',
      'ordersTopic',
    ]);
  });

  it('keeps Kotlin named call arguments and spreads as written', () => {
    expect(facts[3]?.args).toEqual([
      { name: 'topic', text: 'Destinations.ORDERS' },
      { name: 'data', text: 'payload' },
    ]);
    expect(facts[7]?.args).toEqual([{ text: '*args' }]);
  });

  it('reads the receiver structurally, so a safe call is still a publish', () => {
    expect(facts[4]?.receiverName).toBe('kafkaTemplate');
    expect(destination(facts[4]!)).toBe('"orders"');
  });
});

describe('Kotlin Spring messaging producer argument lists', () => {
  const facts = kotlinProducers(`
    package com.example.messaging

    class ArgumentLists {
        fun trailingLambdaOnly() {
            kafkaTemplate.send { }
        }

        fun emptyArgumentList() {
            kafkaTemplate.send()
        }
    }
  `);

  it('distinguishes a missing argument list from an empty one', () => {
    expect(facts).toHaveLength(2);
    expect('args' in facts[0]!).toBe(false);
    expect(facts[1]?.args).toEqual([]);
  });
});

describe('Kotlin Spring messaging producer owners', () => {
  it('attributes publishes in companions, objects, lambdas, and top-level functions', () => {
    const facts = kotlinProducers(`
      package com.example.messaging

      class Owners {
          private val warmup = kafkaTemplate.send("property-orders", "payload")

          init {
              kafkaTemplate.send("init-orders", "payload")
          }

          fun insideLambda(payloads: List<String>) {
              payloads.forEach { payload -> kafkaTemplate.send("lambda-orders", payload) }
          }

          companion object {
              fun companionPublish(payload: String) {
                  kafkaTemplate.send("companion-orders", payload)
              }
          }
      }

      object Singleton {
          fun objectPublish(payload: String) {
              kafkaTemplate.send("object-orders", payload)
          }
      }

      fun topLevelPublish(payload: String) {
          kafkaTemplate.send("top-level-orders", payload)
      }
    `);
    // The property initializer and the init block have no callable of their own.
    expect(facts.map(destination)).toEqual([
      '"lambda-orders"',
      '"companion-orders"',
      '"object-orders"',
      '"top-level-orders"',
    ]);
    expect(new Set(facts.map((fact) => fact.ownerScopeId)).size).toBe(4);
  });
});

describe('Kotlin Spring messaging producer null assertions', () => {
  const facts = kotlinProducers(`
    package com.example.messaging

    class Assertions {
        fun asserted(payload: String) {
            kafkaTemplate!!.send("asserted", payload)
        }

        fun doubleAsserted(payload: String) {
            kafkaTemplate!!!!.send("double-asserted", payload)
        }

        fun assertedInChain(payload: String) {
            holder.kafkaTemplate!!.send("chain-tail", payload)
        }

        fun assertionInsideChain(payload: String) {
            holder!!.kafkaTemplate.send("chain-middle", payload)
        }

        fun assertedThenSafeCall(payload: String) {
            kafkaTemplate!!?.send("asserted-safe", payload)
        }
    }
  `);

  it('reads through the null assertion to the receiver it asserts', () => {
    // `?.` hides its marker in the navigation suffix, but `!!` wraps the
    // receiver itself; without unwrapping, every asserted publish is lost.
    expect(facts.map((fact) => `${fact.receiverName} ${destination(fact)}`)).toEqual([
      'kafkaTemplate "asserted"',
      'kafkaTemplate "double-asserted"',
      'holder.kafkaTemplate "chain-tail"',
      'holder!!.kafkaTemplate "chain-middle"',
      'kafkaTemplate "asserted-safe"',
    ]);
  });

  it('does not unwrap a postfix operator that is not a null assertion', () => {
    const other = kotlinProducers(`
      package com.example.messaging

      class NotAssertions {
          fun incremented(payload: String) {
              counter++.send("orders", payload)
          }

          fun assertedUntyped(payload: String) {
              template!!.send("orders", payload)
          }

          fun assertedFactory(payload: String) {
              getTemplate()!!.send("orders", payload)
          }

          fun parenthesized(payload: String) {
              (kafkaTemplate!!).send("orders", payload)
          }
      }
    `);
    expect(other).toEqual([]);
  });
});

describe('Kotlin Spring messaging producer call shapes', () => {
  const facts = kotlinProducers(`
    package com.example.messaging

    class KotlinKafkaTemplate {
        fun send(topic: String, data: String) {}
    }

    class CallShapes {
        private val kotlinKafkaTemplate = KotlinKafkaTemplate()

        fun argumentsAndTrailingLambda(payload: String) {
            kafkaTemplate.send("orders", payload) { result -> println(result) }
        }

        fun namedArgumentHoldingComparison(payload: String, flag: Boolean) {
            kotlinKafkaTemplate.send(topic = if (flag == true) "a" else "b", data = payload)
        }

        fun trailingComma(payload: String) {
            kafkaTemplate.send(
                "orders",
                payload,
            )
        }
    }
  `);

  it('keeps the argument list of a call that also passes a trailing lambda', () => {
    expect(facts[0]?.args).toEqual([{ text: '"orders"' }, { text: 'payload' }]);
  });

  it('does not mistake a comparison inside a named argument for a second argument', () => {
    expect(facts[1]?.args).toEqual([
      { name: 'topic', text: 'if (flag == true) "a" else "b"' },
      { name: 'data', text: 'payload' },
    ]);
  });

  it('ignores a trailing comma in the argument list', () => {
    expect(facts[2]?.args).toEqual([{ text: '"orders"' }, { text: 'payload' }]);
  });
});

describe('Spring messaging producer side-channel transport', () => {
  it('leaves the Kotlin side channel free of producer facts for a quiet file', () => {
    emitKotlinScopeCaptures(
      `
        package com.example.messaging

        class Quiet {
            fun run() {
                logger.send("orders", "payload")
            }
        }
      `,
      KOTLIN_FILE,
    );
    const sideChannel = collectKotlinCaptureSideChannel(KOTLIN_FILE);
    expect(sideChannel === undefined || !('springMessageProducerFacts' in sideChannel)).toBe(true);
  });
});

/**
 * Kafka is the template whose destination shapes are covered above. The other
 * three carry the same burden: a destination is written as a literal, as a
 * constant that lives in another file, or as a name bound from configuration,
 * and capture must produce a fact for all three without preferring any.
 */
describe('Spring messaging producer destination kinds per template', () => {
  const KOTLIN_SOURCE = `
    package com.example.messaging

    import com.example.messaging.support.Destinations
    import org.springframework.amqp.rabbit.core.RabbitTemplate
    import org.springframework.cloud.stream.function.StreamBridge
    import org.springframework.jms.core.JmsTemplate

    class OrderPublishers(
        private val rabbitTemplate: RabbitTemplate,
        private val jmsTemplate: JmsTemplate,
        private val streamBridge: StreamBridge,
        @Value("\\\${app.messaging.orders-exchange}") private val ordersExchange: String,
    ) {
        fun rabbitLiteral(payload: String) {
            rabbitTemplate.convertAndSend("orders.exchange", "orders.key", payload)
        }

        fun rabbitConstant(payload: String) {
            rabbitTemplate.convertAndSend(Destinations.EXCHANGE, Destinations.ROUTING_KEY, payload)
        }

        fun rabbitConfigured(payload: String) {
            rabbitTemplate.convertAndSend(ordersExchange, "orders.key", payload)
        }

        fun jmsLiteral(payload: String) {
            jmsTemplate.convertAndSend("queue.orders", payload)
        }

        fun jmsConstant(payload: String) {
            jmsTemplate.convertAndSend(Destinations.QUEUE, payload)
        }

        fun jmsConfigured(payload: String) {
            jmsTemplate.convertAndSend(ordersQueue, payload)
        }

        fun bridgeLiteral(payload: String) {
            streamBridge.send("orders-out-0", payload)
        }

        fun bridgeConstant(payload: String) {
            streamBridge.send(Destinations.ORDERS_BINDING, payload)
        }

        fun bridgeConfigured(payload: String) {
            streamBridge.send(ordersBinding, payload)
        }

        fun notAPublish(payload: String) {
            rabbitTemplate.send("orders.exchange", payload)
            jmsTemplate.send("queue.orders", payload)
        }
    }
  `;

  const EXPECTED_SIGNATURES = [
    'rabbit rabbitTemplate.convertAndSend',
    'rabbit rabbitTemplate.convertAndSend',
    'rabbit rabbitTemplate.convertAndSend',
    'jms jmsTemplate.convertAndSend',
    'jms jmsTemplate.convertAndSend',
    'jms jmsTemplate.convertAndSend',
    'stream-bridge streamBridge.send',
    'stream-bridge streamBridge.send',
    'stream-bridge streamBridge.send',
  ];

  const EXPECTED_DESTINATIONS = [
    '"orders.exchange"',
    'Destinations.EXCHANGE',
    'ordersExchange',
    '"queue.orders"',
    'Destinations.QUEUE',
    'ordersQueue',
    '"orders-out-0"',
    'Destinations.ORDERS_BINDING',
    'ordersBinding',
  ];

  it('gives Kotlin rabbit, jms, and stream-bridge a fact for all three shapes', () => {
    const facts = kotlinProducers(KOTLIN_SOURCE);
    expect(facts.map(signature)).toEqual(EXPECTED_SIGNATURES);
    expect(facts.map(destination)).toEqual(EXPECTED_DESTINATIONS);
  });
});

describe('Spring messaging producer receiver decorations', () => {
  it('recognizes the same decorations in Kotlin', () => {
    const kotlin = kotlinProducers(`
      package com.example.messaging

      class DecoratedTemplates {
          fun suffixed(payload: String) { kafkaTemplateDlq.send("a", payload) }
          fun constantCase(payload: String) { KAFKA_TEMPLATE.send("b", payload) }
          fun indexedBridge(payload: String) { streamBridge2.send("c", payload) }
      }
    `);
    expect(kotlin.map(signature)).toEqual([
      'kafka kafkaTemplateDlq.send',
      'kafka KAFKA_TEMPLATE.send',
      'stream-bridge streamBridge2.send',
    ]);
  });
});

describe('Spring messaging producer error recovery', () => {
  it('produces no Kotlin fact when the argument list did not parse', () => {
    expect(
      kotlinProducers(`
        package com.example.messaging

        class Unfinished {
            fun publish(payload: String) {
                kafkaTemplate.send(ORDERS_TOPIC,
            }

            fun other(value: String) { println(value) }
        }
      `),
    ).toEqual([]);
  });
});

describe('Spring messaging producer argument spellings', () => {
  it('gives one Kotlin argument one spelling however the source wrapped it', () => {
    const facts = kotlinProducers(`
      package com.example.messaging

      class KotlinKafkaTemplate {
          fun send(topic: String, data: String) {}
      }

      class WrappedArguments {
          private val kotlinKafkaTemplate = KotlinKafkaTemplate()

          fun single(payload: String) {
              kafkaTemplate.send(Destinations.ORDERS, payload)
          }

          fun wrapped(payload: String) {
              kotlinKafkaTemplate.send(topic = Destinations
                  .ORDERS, data = payload)
          }
      }
    `);
    expect(facts.map(destination)).toEqual(['Destinations.ORDERS', 'Destinations.ORDERS']);
  });

  it('reads a Kotlin named argument through a comment between name and value', () => {
    const facts = kotlinProducers(`
      package com.example.messaging

      class KotlinKafkaTemplate {
          fun send(topic: String) {}
      }

      class CommentedArguments {
          private val kotlinKafkaTemplate = KotlinKafkaTemplate()

          fun publish(payload: String) {
              kotlinKafkaTemplate.send(topic /* which */ = "orders")
          }
      }
    `);
    expect(facts.map((fact) => fact.args)).toEqual([[{ name: 'topic', text: '"orders"' }]]);
  });

  it('does not read an annotated Kotlin positional argument as a named one', () => {
    // `@Suppress("x") "orders"` has the same two-child shape as `name = value`.
    // Only the `=` token tells them apart, and inventing a name here would
    // hand a consumer an argument key that does not exist.
    const facts = kotlinProducers(`
      package com.example.messaging

      class AnnotatedArguments {
          fun publish(payload: String) {
              kafkaTemplate.send(@Suppress("UNCHECKED_CAST") "orders", payload)
          }
      }
    `);
    expect(facts.map((fact) => fact.args)).toEqual([
      [{ text: '@Suppress("UNCHECKED_CAST") "orders"' }, { text: 'payload' }],
    ]);
  });
});

describe('Spring messaging producer owner boundaries', () => {
  it('does not attribute a Kotlin publish across a nested class body', () => {
    expect(
      kotlinProducers(`
        package com.example.messaging

        class Nested {
            fun outer(payload: String) {
                class Local {
                    val sent = kafkaTemplate.send("local-property", payload)
                }

                val task = object : Runnable {
                    val sent = kafkaTemplate.send("object-property", payload)
                    override fun run() {}
                }
            }
        }
      `),
    ).toEqual([]);
  });

  it('still attributes a Kotlin publish to a function of a nested class body', () => {
    const facts = kotlinProducers(`
      package com.example.messaging

      class Nested {
          fun outer(payload: String) {
              val task = object : Runnable {
                  override fun run() { kafkaTemplate.send("object-method", payload) }
              }
          }
      }
    `);
    expect(facts.map(destination)).toEqual(['"object-method"']);
  });

  it('does not unwrap a Kotlin postfix operator that only looks like an assertion', () => {
    // The existing coverage used `counter++`, which the name match rejects on
    // its own. Only a receiver that WOULD match makes the unwrap guard the
    // reason for the rejection.
    expect(
      kotlinProducers(`
        package com.example.messaging

        class Incremented {
            fun publish(payload: String) {
                kafkaTemplate++.send("orders", payload)
            }
        }
      `),
    ).toEqual([]);
  });
});
