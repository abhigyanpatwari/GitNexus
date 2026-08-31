import { describe, expect, it } from 'vitest';
import type { SpringMessageProducerFact } from '../../src/core/ingestion/frameworks/spring/message-producers.js';
import { collectJavaCaptureSideChannel } from '../../src/core/ingestion/languages/java/capture-side-channel.js';
import { emitJavaScopeCaptures } from '../../src/core/ingestion/languages/java/captures.js';
import { collectKotlinCaptureSideChannel } from '../../src/core/ingestion/languages/kotlin/capture-side-channel.js';
import { emitKotlinScopeCaptures } from '../../src/core/ingestion/languages/kotlin/captures.js';

const JAVA_FILE = 'src/OrderPublishers.java';
const KOTLIN_FILE = 'src/OrderPublishers.kt';

function javaProducers(code: string): readonly SpringMessageProducerFact[] {
  emitJavaScopeCaptures(code, JAVA_FILE);
  return collectJavaCaptureSideChannel(JAVA_FILE)?.springMessageProducerFacts ?? [];
}

function kotlinProducers(code: string): readonly SpringMessageProducerFact[] {
  emitKotlinScopeCaptures(code, KOTLIN_FILE);
  return collectKotlinCaptureSideChannel(KOTLIN_FILE)?.springMessageProducerFacts ?? [];
}

const signature = (fact: SpringMessageProducerFact) =>
  `${fact.template} ${fact.receiverName}.${fact.methodName}`;

const destination = (fact: SpringMessageProducerFact) => fact.args?.[0]?.text;

describe('Java Spring messaging producers', () => {
  const facts = javaProducers(`
    package com.example.messaging;

    import com.example.messaging.support.Destinations;
    import org.springframework.beans.factory.annotation.Value;
    import org.springframework.core.env.Environment;
    import org.springframework.kafka.core.KafkaTemplate;

    public class OrderPublishers {
        private final KafkaTemplate<String, String> kafkaTemplate;

        @Value("\${app.messaging.orders-topic}")
        private String ordersTopic;

        public void literalDestination(String payload) {
            kafkaTemplate.send("orders", payload);
        }

        public void constantDestination(String payload) {
            this.kafkaTemplate.send(Destinations.ORDERS, payload);
        }

        public void configuredDestination(String payload) {
            kafkaTemplate.send(ordersTopic, payload);
        }

        public void configuredDestinationInline(String payload, Environment environment) {
            kafkaTemplate.send(environment.getProperty("app.messaging.orders-topic"), payload);
        }

        public void rabbitDestination(String exchange, String routingKey, String payload) {
            rabbitTemplate.convertAndSend(exchange, routingKey, payload);
        }

        public void jmsDestination(String payload) {
            jmsTemplate.convertAndSend("queue.orders", payload);
        }

        public void streamBridgeDestination(String payload) {
            streamBridge.send(Destinations.SHIPMENTS_BINDING, payload);
        }
    }
  `);

  it('recognizes every supported template and method pair', () => {
    expect(facts.map(signature)).toEqual([
      'kafka kafkaTemplate.send',
      'kafka this.kafkaTemplate.send',
      'kafka kafkaTemplate.send',
      'kafka kafkaTemplate.send',
      'rabbit rabbitTemplate.convertAndSend',
      'jms jmsTemplate.convertAndSend',
      'stream-bridge streamBridge.send',
    ]);
  });

  it('produces a fact for a literal, a constant, and a configuration key alike', () => {
    expect(facts.slice(0, 4).map(destination)).toEqual([
      '"orders"',
      'Destinations.ORDERS',
      'ordersTopic',
      'environment.getProperty("app.messaging.orders-topic")',
    ]);
  });

  it('captures every call argument positionally, since Java has no named ones', () => {
    expect(facts[4]?.args).toEqual([
      { text: 'exchange' },
      { text: 'routingKey' },
      { text: 'payload' },
    ]);
    expect(facts.flatMap((fact) => fact.args ?? []).every((arg) => !('name' in arg))).toBe(true);
  });
});

describe('Java Spring messaging producer receivers', () => {
  const facts = javaProducers(`
    package com.example.messaging;

    public class ReceiverShapes {
        public void prefixedReceiver(String payload) {
            orderKafkaTemplate.send("orders", payload);
        }

        public void deepReceiver(String payload) {
            outer.inner.kafkaTemplate.send("orders", payload);
        }

        public void untypedReceiver(String payload) {
            template.send("orders", payload);
        }

        public void mapReceiver(String payload) {
            templates.get("orders").send("orders", payload);
        }

        public void factoryReceiver(String payload) {
            getTemplate().send("orders", payload);
        }

        public void wrongMethodForKafka(String payload) {
            kafkaTemplate.convertAndSend("orders", payload);
        }

        public void wrongMethodForRabbit(String payload) {
            rabbitTemplate.send("orders", payload);
        }
    }
  `);

  it('matches a receiver whose simple name ends with the template type name', () => {
    expect(facts.map((fact) => fact.receiverName)).toEqual([
      'orderKafkaTemplate',
      'outer.inner.kafkaTemplate',
    ]);
  });

  it('does not guess a broker for an untyped, indexed, or returned receiver', () => {
    const receivers = facts.map((fact) => fact.receiverName);
    expect(receivers).not.toContain('template');
    expect(receivers.some((name) => name.includes('templates.get'))).toBe(false);
    expect(receivers.some((name) => name.includes('getTemplate'))).toBe(false);
  });

  it('requires the method that belongs to the template, not any send-like name', () => {
    expect(facts.map((fact) => fact.methodName)).toEqual(['send', 'send']);
  });
});

describe('Java Spring messaging producer owners', () => {
  it('attributes a publish to its nearest enclosing callable exactly once', () => {
    const facts = javaProducers(`
      package com.example.messaging;

      import java.util.List;

      public class Owners {
          public Owners(String payload) {
              kafkaTemplate.send("constructor-orders", payload);
          }

          public void insideLambda(List<String> payloads) {
              payloads.forEach(payload -> kafkaTemplate.send("lambda-orders", payload));
          }

          public void insideAnonymousClass() {
              Runnable task = new Runnable() {
                  @Override
                  public void run() {
                      kafkaTemplate.send("anonymous-orders", "payload");
                  }
              };
              task.run();
          }

          static class Nested {
              void nestedPublish(String payload) {
                  kafkaTemplate.send("nested-orders", payload);
              }
          }
      }
    `);
    expect(facts.map(destination)).toEqual([
      '"constructor-orders"',
      '"lambda-orders"',
      '"anonymous-orders"',
      '"nested-orders"',
    ]);
    expect(new Set(facts.map((fact) => fact.ownerScopeId)).size).toBe(4);
    // A lambda body belongs to the method that declares it, while an anonymous
    // class body belongs to its own `run` method (line 17 starts at @Override).
    expect(facts[1]?.ownerRange.startLine).toBe(11);
    expect(facts[2]?.ownerRange.startLine).toBe(17);
  });

  it('drops a publish that has no callable owner', () => {
    const facts = javaProducers(`
      package com.example.messaging;

      public class NoCallableOwner {
          private static final Object WARMUP = kafkaTemplate.send("field-orders", "payload");

          static {
              kafkaTemplate.send("static-initializer-orders", "payload");
          }
      }
    `);
    expect(facts).toEqual([]);
  });
});

describe('Kotlin Spring messaging producers', () => {
  const facts = kotlinProducers(`
    package com.example.messaging

    import com.example.messaging.support.Destinations
    import org.springframework.kafka.core.KafkaTemplate

    class OrderPublishers(private val kafkaTemplate: KafkaTemplate<String, String>) {
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
            kafkaTemplate.send(topic = Destinations.ORDERS, data = payload)
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
      'kafka kafkaTemplate.send',
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

describe('Spring messaging producer capture regressions', () => {
  it('leaves the side channel untouched for a file that publishes nothing', () => {
    const sideChannel = (() => {
      emitJavaScopeCaptures(
        `
          package com.example.messaging;

          public class Quiet {
              public void run() {
                  logger.send("orders", "payload");
              }
          }
        `,
        JAVA_FILE,
      );
      return collectJavaCaptureSideChannel(JAVA_FILE);
    })();
    expect(sideChannel === undefined || !('springMessageProducerFacts' in sideChannel)).toBe(true);
  });

  it('still captures programmatic bean lookups from the same member-call visit', () => {
    emitJavaScopeCaptures(
      `
        package com.example.messaging;

        public class Lookups {
            public void run() {
                kafkaTemplate.send("orders", "payload");
                OrderService service = SpringContextUtil.getBean(OrderService.class);
                service.handle();
            }
        }
      `,
      JAVA_FILE,
    );
    const sideChannel = collectJavaCaptureSideChannel(JAVA_FILE);
    expect(sideChannel?.springMessageProducerFacts).toHaveLength(1);
    expect(sideChannel?.springDynamicLookupFacts?.map((fact) => fact.targetTypeName)).toEqual([
      'OrderService',
    ]);
  });
});

describe('Spring messaging producer receiver spellings', () => {
  it('captures the inner call of the synchronous send idiom', () => {
    const facts = javaProducers(`
      package com.example.messaging;

      public class Chained {
          public void awaited(String payload) throws Exception {
              kafkaTemplate.send("orders", payload).get();
          }

          public void withCallback(String payload) {
              kafkaTemplate.send("orders", payload).addCallback(ok -> {}, error -> {});
          }
      }
    `);
    expect(facts.map(destination)).toEqual(['"orders"', '"orders"']);
  });

  it('joins a receiver chain that the source wrapped across lines', () => {
    const java = javaProducers(`
      package com.example.messaging;

      public class Wrapped {
          public void publish(String payload) {
              outer
                  .inner
                  .kafkaTemplate.send("orders", payload);
          }
      }
    `);
    const kotlin = kotlinProducers(`
      package com.example.messaging

      class Wrapped {
          fun publish(payload: String) {
              outer
                  .inner
                  .kafkaTemplate.send("orders", payload)
          }
      }
    `);
    expect(java.map((fact) => fact.receiverName)).toEqual(['outer.inner.kafkaTemplate']);
    expect(kotlin.map((fact) => fact.receiverName)).toEqual(['outer.inner.kafkaTemplate']);
  });

  it('leaves single-line spacing and nested literals in the receiver as written', () => {
    // Joining a wrapped chain must not reach inside a string literal that the
    // receiver expression happens to contain.
    const facts = javaProducers(`
      package com.example.messaging;

      public class Literals {
          public void publish(String payload) {
              registry.lookup("a . b").kafkaTemplate.send("orders . v1", payload);
          }
      }
    `);
    expect(facts.map((fact) => fact.receiverName)).toEqual([
      'registry.lookup("a . b").kafkaTemplate',
    ]);
    expect(facts.map(destination)).toEqual(['"orders . v1"']);
  });

  it('does not attribute a call that names no receiver', () => {
    const java = javaProducers(`
      package com.example.messaging;

      public class Bare {
          public void publish(String payload) {
              send("orders", payload);
          }
      }
    `);
    const kotlin = kotlinProducers(`
      package com.example.messaging

      class Bare {
          fun publish(payload: String) {
              send("orders", payload)
          }

          fun scoped(payload: String) {
              with(kafkaTemplate) {
                  send("orders", payload)
              }
          }
      }
    `);
    expect(java).toEqual([]);
    expect(kotlin).toEqual([]);
  });

  it('does not attribute a cast or parenthesized receiver', () => {
    const facts = javaProducers(`
      package com.example.messaging;

      public class Casts {
          public void publish(Object raw, String payload) {
              ((org.springframework.kafka.core.KafkaTemplate<String, String>) raw)
                  .send("orders", payload);
          }
      }
    `);
    expect(facts).toEqual([]);
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

    class CallShapes {
        fun argumentsAndTrailingLambda(payload: String) {
            kafkaTemplate.send("orders", payload) { result -> println(result) }
        }

        fun namedArgumentHoldingComparison(payload: String, flag: Boolean) {
            kafkaTemplate.send(topic = if (flag == true) "a" else "b", data = payload)
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

  it('carries producer facts and handler arguments through a JSON round trip', () => {
    // The worker ships the side channel to the main thread as JSON; a fact
    // shape that does not survive that trip is invisible to every later phase.
    emitJavaScopeCaptures(
      `
        package com.example.messaging;

        import org.springframework.kafka.annotation.KafkaListener;

        public class RoundTrip {
            @KafkaListener(topics = "orders")
            public void consume(String payload) {}

            public void publish(String payload) {
                kafkaTemplate.send("orders", payload);
            }
        }
      `,
      JAVA_FILE,
    );
    const collected = collectJavaCaptureSideChannel(JAVA_FILE);
    const restored = JSON.parse(JSON.stringify(collected)) as typeof collected;
    expect(restored?.springMessageProducerFacts).toEqual(collected?.springMessageProducerFacts);
    expect(restored?.springMessageProducerFacts?.[0]?.args).toEqual([
      { text: '"orders"' },
      { text: 'payload' },
    ]);
    expect(restored?.springNonHttpHandlerFacts?.[0]?.annotations[0]?.args).toEqual([
      { name: 'topics', text: '"orders"' },
    ]);
  });
});

/**
 * Kafka is the template whose destination shapes are covered above. The other
 * three carry the same burden: a destination is written as a literal, as a
 * constant that lives in another file, or as a name bound from configuration,
 * and capture must produce a fact for all three without preferring any.
 */
describe('Spring messaging producer destination kinds per template', () => {
  const JAVA_SOURCE = `
    package com.example.messaging;

    import com.example.messaging.support.Destinations;
    import org.springframework.amqp.rabbit.core.RabbitTemplate;
    import org.springframework.cloud.stream.function.StreamBridge;
    import org.springframework.jms.core.JmsTemplate;

    public class OrderPublishers {
        private final RabbitTemplate rabbitTemplate;
        private final JmsTemplate jmsTemplate;
        private final StreamBridge streamBridge;

        @Value("\${app.messaging.orders-exchange}")
        private String ordersExchange;

        public void rabbitLiteral(String payload) {
            rabbitTemplate.convertAndSend("orders.exchange", "orders.key", payload);
        }

        public void rabbitConstant(String payload) {
            rabbitTemplate.convertAndSend(Destinations.EXCHANGE, Destinations.ROUTING_KEY, payload);
        }

        public void rabbitConfigured(String payload) {
            rabbitTemplate.convertAndSend(ordersExchange, "orders.key", payload);
        }

        public void jmsLiteral(String payload) {
            jmsTemplate.convertAndSend("queue.orders", payload);
        }

        public void jmsConstant(String payload) {
            jmsTemplate.convertAndSend(Destinations.QUEUE, payload);
        }

        public void jmsConfigured(String payload) {
            jmsTemplate.convertAndSend(ordersQueue, payload);
        }

        public void bridgeLiteral(String payload) {
            streamBridge.send("orders-out-0", payload);
        }

        public void bridgeConstant(String payload) {
            streamBridge.send(Destinations.ORDERS_BINDING, payload);
        }

        public void bridgeConfigured(String payload) {
            streamBridge.send(ordersBinding, payload);
        }

        public void notAPublish(String payload) {
            rabbitTemplate.send("orders.exchange", payload);
            jmsTemplate.send("queue.orders", payload);
        }
    }
  `;

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

  it('gives Java rabbit, jms, and stream-bridge a fact for all three shapes', () => {
    const facts = javaProducers(JAVA_SOURCE);
    expect(facts.map(signature)).toEqual(EXPECTED_SIGNATURES);
    expect(facts.map(destination)).toEqual(EXPECTED_DESTINATIONS);
  });

  it('gives Kotlin rabbit, jms, and stream-bridge a fact for all three shapes', () => {
    const facts = kotlinProducers(KOTLIN_SOURCE);
    expect(facts.map(signature)).toEqual(EXPECTED_SIGNATURES);
    expect(facts.map(destination)).toEqual(EXPECTED_DESTINATIONS);
  });

  it('leaves a send that does not belong to its template unrecognized', () => {
    // `notAPublish` is the last method in both fixtures; the signature lists
    // above end at the stream bridge, so `RabbitTemplate.send` and
    // `JmsTemplate.send` produced nothing.
    const receivers = [...javaProducers(JAVA_SOURCE), ...kotlinProducers(KOTLIN_SOURCE)].map(
      (fact) => `${fact.receiverName}.${fact.methodName}`,
    );
    expect(receivers).not.toContain('rabbitTemplate.send');
    expect(receivers).not.toContain('jmsTemplate.send');
  });

  it('resolves no destination while capturing it', () => {
    const texts = [...javaProducers(JAVA_SOURCE), ...kotlinProducers(KOTLIN_SOURCE)].flatMap(
      (fact) => fact.args ?? [],
    );
    // A resolver would have turned the constants and the injected name into
    // addresses; capture must still be looking at the source spelling.
    expect(texts.some((argument) => argument.text === 'Destinations.QUEUE')).toBe(true);
    expect(texts.some((argument) => argument.text === 'ordersExchange')).toBe(true);
    expect(texts.some((argument) => argument.text.includes('${app.messaging'))).toBe(false);
  });
});
