import { describe, expect, it } from 'vitest';
import type { SpringNonHttpHandlerAnnotationFact } from '../../src/core/ingestion/frameworks/spring/non-http-handlers.js';
import { collectJavaCaptureSideChannel } from '../../src/core/ingestion/languages/java/capture-side-channel.js';
import { emitJavaScopeCaptures } from '../../src/core/ingestion/languages/java/captures.js';
import { collectKotlinCaptureSideChannel } from '../../src/core/ingestion/languages/kotlin/capture-side-channel.js';
import { emitKotlinScopeCaptures } from '../../src/core/ingestion/languages/kotlin/captures.js';

const JAVA_FILE = 'src/HandlerArguments.java';
const KOTLIN_FILE = 'src/HandlerArguments.kt';

/**
 * One `{ annotationName -> annotation }` view per captured callable, in capture
 * order. Handler facts are keyed by owner range, which is noisy to assert on;
 * the annotations themselves are what this suite is about.
 */
function javaHandlerAnnotations(code: string): SpringNonHttpHandlerAnnotationFact[][] {
  emitJavaScopeCaptures(code, JAVA_FILE);
  const facts = collectJavaCaptureSideChannel(JAVA_FILE)?.springNonHttpHandlerFacts ?? [];
  return facts.map((fact) => [...fact.annotations]);
}

function kotlinHandlerAnnotations(code: string): SpringNonHttpHandlerAnnotationFact[][] {
  emitKotlinScopeCaptures(code, KOTLIN_FILE);
  const facts = collectKotlinCaptureSideChannel(KOTLIN_FILE)?.springNonHttpHandlerFacts ?? [];
  return facts.map((fact) => [...fact.annotations]);
}

function only(annotations: SpringNonHttpHandlerAnnotationFact[][], name: string) {
  const matches = annotations.flat().filter((annotation) => annotation.name === name);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one @${name}, captured ${matches.length}`);
  }
  return matches[0]!;
}

describe('Java non-HTTP handler annotation arguments', () => {
  const annotations = javaHandlerAnnotations(`
    package com.example.handlers;

    import com.example.handlers.support.Destinations;
    import com.xxl.job.core.handler.annotation.XxlJob;
    import org.springframework.amqp.rabbit.annotation.RabbitListener;
    import org.springframework.jms.annotation.JmsListener;
    import org.springframework.kafka.annotation.KafkaListener;
    import org.springframework.scheduling.annotation.Scheduled;

    public class OrderHandlers {
        private static final String JOB_NAME = "constantJobHandler";

        @Scheduled
        public void marker() {}

        @Scheduled()
        public void emptyArgumentList() {}

        @KafkaListener(topics = "orders", groupId = "order-consumers")
        public void namedArguments(String payload) {}

        @KafkaListener(topics = {"orders", Destinations.SHIPMENTS})
        public void arrayArgument(String payload) {}

        @RabbitListener(queues = Destinations.PAYMENTS)
        public void constantArgument(String payload) {}

        @JmsListener(destination = "\${app.messaging.jms-destination}")
        public void configuredArgument(String payload) {}

        @XxlJob("literalJobHandler")
        public void positionalLiteral() {}

        @XxlJob(JOB_NAME)
        public void positionalConstant() {}

        @Scheduled(/* every minute */ cron = "0 * * * * *")
        public void commentedArgument() {}
    }
  `);

  it('omits the argument list for a marker annotation but keeps an empty one', () => {
    const marker = annotations[0]?.[0];
    const empty = annotations[1]?.[0];
    expect(marker?.name).toBe('Scheduled');
    expect(marker && 'args' in marker).toBe(false);
    expect(empty?.name).toBe('Scheduled');
    expect(empty?.args).toEqual([]);
  });

  it('keeps annotation argument names, so topics and queues stay distinguishable', () => {
    expect(annotations[2]?.[0]?.args).toEqual([
      { name: 'topics', text: '"orders"' },
      { name: 'groupId', text: '"order-consumers"' },
    ]);
    expect(only(annotations, 'RabbitListener').args).toEqual([
      { name: 'queues', text: 'Destinations.PAYMENTS' },
    ]);
    expect(only(annotations, 'JmsListener').args).toEqual([
      { name: 'destination', text: '"${app.messaging.jms-destination}"' },
    ]);
  });

  it('captures a single-element annotation argument positionally', () => {
    const positional = annotations.flat().filter((annotation) => annotation.name === 'XxlJob');
    expect(positional.map((annotation) => annotation.args)).toEqual([
      [{ text: '"literalJobHandler"' }],
      [{ text: 'JOB_NAME' }],
    ]);
  });

  it('resolves nothing: constants, placeholders, and arrays stay as written', () => {
    expect(annotations[3]?.[0]?.args).toEqual([
      { name: 'topics', text: '{"orders", Destinations.SHIPMENTS}' },
    ]);
    const texts = annotations.flat().flatMap((annotation) => annotation.args ?? []);
    expect(texts.some((argument) => argument.text === 'Destinations.PAYMENTS')).toBe(true);
    expect(texts.some((argument) => argument.text === 'JOB_NAME')).toBe(true);
    // A resolver would have turned these into "shipments" / "constantJobHandler".
    expect(texts.some((argument) => argument.text.includes('shipments'))).toBe(false);
    expect(texts.some((argument) => argument.text === '"constantJobHandler"')).toBe(false);
  });

  it('skips comments interleaved with annotation arguments', () => {
    const commented = annotations
      .flat()
      .filter((annotation) => annotation.name === 'Scheduled')
      .at(-1);
    expect(commented?.args).toEqual([{ name: 'cron', text: '"0 * * * * *"' }]);
  });
});

describe('Kotlin non-HTTP handler annotation arguments', () => {
  const annotations = kotlinHandlerAnnotations(`
    package com.example.handlers

    import com.example.handlers.support.Destinations
    import com.xxl.job.core.handler.annotation.XxlJob
    import org.springframework.context.event.EventListener
    import org.springframework.jms.annotation.JmsListener
    import org.springframework.kafka.annotation.KafkaListener
    import org.springframework.scheduling.annotation.Scheduled

    class OrderHandlers {
        @Scheduled
        fun marker() {}

        @Scheduled()
        fun emptyArgumentList() {}

        @KafkaListener(topics = ["orders", "shipments"], groupId = "order-consumers")
        fun collectionArgument(payload: String) {}

        @JmsListener(destination = "\\\${app.messaging.jms-destination}")
        fun configuredArgument(payload: String) {}

        @XxlJob(Destinations.JOB_NAME)
        fun positionalConstant() {}

        @get:Scheduled(cron = "0 * * * * *")
        fun targetedGetter(): String = "value"

        @[EventListener Scheduled(cron = "0 * * * * *")]
        fun multiAnnotated() {}

        @[Scheduled(cron = "0 0 * * * *") EventListener]
        fun multiAnnotatedReversed() {}
    }
  `);

  it('omits the argument list for a marker annotation but keeps an empty one', () => {
    const marker = annotations[0]?.[0];
    const empty = annotations[1]?.[0];
    expect(marker?.name).toBe('Scheduled');
    expect(marker && 'args' in marker).toBe(false);
    expect(empty?.args).toEqual([]);
  });

  it('keeps argument names and the collection literal as written', () => {
    expect(annotations[2]?.[0]?.args).toEqual([
      { name: 'topics', text: '["orders", "shipments"]' },
      { name: 'groupId', text: '"order-consumers"' },
    ]);
    expect(annotations[3]?.[0]?.args).toEqual([
      { name: 'destination', text: '"\\${app.messaging.jms-destination}"' },
    ]);
    expect(annotations[4]?.[0]?.args).toEqual([{ text: 'Destinations.JOB_NAME' }]);
  });

  it('keeps arguments alongside a use-site target', () => {
    const targeted = annotations[5]?.[0];
    expect(targeted?.useSiteTarget).toBe('get');
    expect(targeted?.args).toEqual([{ name: 'cron', text: '"0 * * * * *"' }]);
  });

  it('pairs multi-annotation arguments with the annotation that owns them', () => {
    // `@[EventListener Scheduled(cron = ...)]` names EventListener; handing it
    // Scheduled's cron would invent a schedule the source never wrote.
    expect(annotations[6]?.[0]?.name).toBe('EventListener');
    expect(annotations[6]?.[0] && 'args' in annotations[6][0]).toBe(false);
    expect(annotations[7]?.[0]?.name).toBe('Scheduled');
    expect(annotations[7]?.[0]?.args).toEqual([{ name: 'cron', text: '"0 0 * * * *"' }]);
  });
});

describe('non-HTTP handler capture regressions', () => {
  it('still captures every previously recognized Java handler annotation', () => {
    const annotations = javaHandlerAnnotations(`
      package com.example.handlers;

      import com.xxl.job.core.handler.annotation.XxlJob;
      import org.springframework.context.event.EventListener;
      import org.springframework.integration.annotation.ServiceActivator;
      import org.springframework.kafka.annotation.KafkaListener;
      import org.springframework.scheduling.annotation.Scheduled;

      public class MixedHandlers {
          @Override
          public String toString() { return "MixedHandlers"; }

          @Scheduled(fixedDelayString = "PT1M")
          public void scheduled() {}

          @EventListener
          public void event(Object payload) {}

          @KafkaListener(topics = "orders")
          public void message(String payload) {}

          @ServiceActivator(inputChannel = "orders")
          public void serviceActivator(String payload) {}

          @XxlJob("literalJobHandler")
          public void job() {}
      }
    `);
    expect(annotations.map((fact) => fact.map((annotation) => annotation.name))).toEqual([
      ['Scheduled'],
      ['EventListener'],
      ['KafkaListener'],
      ['ServiceActivator'],
      ['XxlJob'],
    ]);
  });

  it('still captures Kotlin aliases and use-site targets without a name prefilter', () => {
    const annotations = kotlinHandlerAnnotations(`
      package com.example.handlers

      import org.springframework.context.event.EventListener as SpringEvent
      import org.springframework.scheduling.annotation.Scheduled

      class AliasedHandlers {
          @SpringEvent
          fun aliasedEvent(event: Any) {}

          @setparam:Scheduled
          fun targetedReceiver(value: String) {}
      }
    `);
    expect(
      annotations.map((fact) =>
        fact.map((annotation) => [annotation.name, annotation.useSiteTarget]),
      ),
    ).toEqual([[['SpringEvent', undefined]], [['Scheduled', 'setparam']]]);
  });

  it('leaves Spring DI annotation facts free of argument text', () => {
    // Arguments are opt-in; DI captures every annotated member in a repository
    // and must not start shipping their argument text worker to main thread.
    emitJavaScopeCaptures(
      `
        package com.example.beans;

        import org.springframework.beans.factory.annotation.Autowired;
        import org.springframework.beans.factory.annotation.Qualifier;
        import org.springframework.stereotype.Service;

        @Service("orderService")
        public class OrderService {
            @Autowired
            @Qualifier("primaryRepository")
            private OrderRepository repository;
        }
      `,
      JAVA_FILE,
    );
    const diFacts = collectJavaCaptureSideChannel(JAVA_FILE)?.springDiFacts ?? [];
    const diAnnotations = diFacts.flatMap((fact) => [
      ...fact.classAnnotations,
      ...fact.injectionSites.flatMap((site) => [...site.annotations]),
    ]);
    expect(diAnnotations.length).toBeGreaterThan(0);
    expect(diAnnotations.every((annotation) => !('args' in annotation))).toBe(true);
  });
});

describe('Java annotation argument shapes', () => {
  const annotations = javaHandlerAnnotations(`
    package com.example.handlers;

    import org.springframework.amqp.rabbit.annotation.Exchange;
    import org.springframework.amqp.rabbit.annotation.Queue;
    import org.springframework.amqp.rabbit.annotation.QueueBinding;
    import org.springframework.amqp.rabbit.annotation.RabbitListener;
    import org.springframework.scheduling.annotation.Scheduled;
    import org.springframework.scheduling.annotation.Schedules;

    public class ArgumentShapes {
        @org.springframework.kafka.annotation.KafkaListener(topics = "orders")
        public void fullyQualifiedAnnotation(String payload) {}

        @Scheduled(cron = "0 * * * * *")
        @Scheduled(cron = "0 0 * * * *")
        public void repeatedAnnotations() {}

        @Scheduled(/* deliberately empty */)
        public void commentOnlyArgumentList() {}

        @Schedules({@Scheduled(cron = "0 * * * * *"), @Scheduled(cron = "0 0 * * * *")})
        public void containerAnnotation() {}

        @RabbitListener(bindings = @QueueBinding(value = @Queue("queue.orders"), exchange = @Exchange("orders.exchange")))
        public void nestedAnnotationArgument(String payload) {}

        @org.springframework.kafka.annotation.KafkaListener(topics = "#{'\${app.topics}'.split(',')}")
        public void expressionArgument(String payload) {}
    }
  `);

  it('reads arguments of an annotation written with its fully qualified name', () => {
    const fact = annotations[0]?.[0];
    expect(fact?.name).toBe('org.springframework.kafka.annotation.KafkaListener');
    expect(fact?.args).toEqual([{ name: 'topics', text: '"orders"' }]);
  });

  it('keeps each repeated annotation with its own arguments', () => {
    expect(annotations[1]?.map((annotation) => annotation.args)).toEqual([
      [{ name: 'cron', text: '"0 * * * * *"' }],
      [{ name: 'cron', text: '"0 0 * * * *"' }],
    ]);
  });

  it('treats a comment-only argument list as an empty list, not a missing one', () => {
    expect(annotations[2]?.[0]?.args).toEqual([]);
  });

  it('keeps a nested annotation tree as one unresolved argument', () => {
    expect(annotations[3]?.[0]?.args).toEqual([
      { text: '{@Scheduled(cron = "0 * * * * *"), @Scheduled(cron = "0 0 * * * *")}' },
    ]);
    expect(annotations[4]?.[0]?.args).toEqual([
      {
        name: 'bindings',
        text: '@QueueBinding(value = @Queue("queue.orders"), exchange = @Exchange("orders.exchange"))',
      },
    ]);
  });

  it('keeps a Spring expression as written rather than evaluating it', () => {
    expect(annotations[5]?.[0]?.args).toEqual([
      { name: 'topics', text: `"#{'\${app.topics}'.split(',')}"` },
    ]);
  });
});

describe('Kotlin annotation argument shapes', () => {
  const annotations = kotlinHandlerAnnotations(`
    package com.example.handlers

    import org.springframework.kafka.annotation.KafkaListener
    import org.springframework.kafka.annotation.KafkaListeners
    import org.springframework.scheduling.annotation.Scheduled

    class ArgumentShapes {
        @KafkaListeners(KafkaListener(topics = ["orders"]), KafkaListener(topics = ["shipments"]))
        fun containerAnnotation(payload: String) {}

        @Scheduled(/* deliberately empty */)
        fun commentOnlyArgumentList() {}

        @Scheduled(cron = """0 * * * * *""")
        fun rawStringArgument() {}

        @KafkaListener(topics = ["orders"], groupId = "order-consumers",)
        fun trailingComma(payload: String) {}
    }
  `);

  it('keeps each nested annotation of a container as its own raw argument', () => {
    expect(annotations[0]?.[0]?.args).toEqual([
      { text: 'KafkaListener(topics = ["orders"])' },
      { text: 'KafkaListener(topics = ["shipments"])' },
    ]);
  });

  it('treats a comment-only argument list as an empty list, not a missing one', () => {
    expect(annotations[1]?.[0]?.args).toEqual([]);
  });

  it('keeps a raw string argument with its delimiters', () => {
    expect(annotations[2]?.[0]?.args).toEqual([{ name: 'cron', text: '"""0 * * * * *"""' }]);
  });

  it('ignores a trailing comma in the argument list', () => {
    expect(annotations[3]?.[0]?.args).toEqual([
      { name: 'topics', text: '["orders"]' },
      { name: 'groupId', text: '"order-consumers"' },
    ]);
  });
});

/**
 * The destination-bearing annotations are only half the handler family. An
 * event listener names its address as an event TYPE and an integration
 * endpoint names it as a CHANNEL, so both carry an address in an argument just
 * as `topics` and `queues` do, and both must survive capture unresolved.
 */
describe('handler annotations that name an event type or an integration channel', () => {
  const javaAnnotations = javaHandlerAnnotations(`
    package com.example.handlers;

    import com.example.handlers.support.Channels;
    import org.springframework.context.event.EventListener;
    import org.springframework.integration.annotation.ServiceActivator;
    import org.springframework.transaction.event.TransactionalEventListener;

    public class OrderIntegration {
        @EventListener(OrderCreated.class)
        public void positionalEventType(OrderCreated event) {}

        @EventListener(classes = {OrderCreated.class, OrderShipped.class}, condition = "#event.urgent")
        public void namedEventTypes(Object event) {}

        @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
        public void afterCommit(Object event) {}

        @ServiceActivator(inputChannel = "orders.in", outputChannel = Channels.OUT)
        public void channels(Object message) {}

        @ServiceActivator(inputChannel = "\${app.integration.input-channel}")
        public void configuredChannel(Object message) {}
    }
  `).flat();

  it('still recognizes every event and integration handler it recognized before', () => {
    expect(javaAnnotations.map((annotation) => annotation.name)).toEqual([
      'EventListener',
      'EventListener',
      'TransactionalEventListener',
      'ServiceActivator',
      'ServiceActivator',
    ]);
  });

  it('captures a Java event type positionally and named event types by key', () => {
    expect(javaAnnotations[0]?.args).toEqual([{ text: 'OrderCreated.class' }]);
    expect(javaAnnotations[1]?.args).toEqual([
      { name: 'classes', text: '{OrderCreated.class, OrderShipped.class}' },
      { name: 'condition', text: '"#event.urgent"' },
    ]);
    expect(javaAnnotations[2]?.args).toEqual([
      { name: 'phase', text: 'TransactionPhase.AFTER_COMMIT' },
    ]);
  });

  it('keeps Java integration channels apart by name and leaves them unresolved', () => {
    expect(javaAnnotations[3]?.args).toEqual([
      { name: 'inputChannel', text: '"orders.in"' },
      { name: 'outputChannel', text: 'Channels.OUT' },
    ]);
    expect(javaAnnotations[4]?.args).toEqual([
      { name: 'inputChannel', text: '"${app.integration.input-channel}"' },
    ]);
  });

  const kotlinAnnotations = kotlinHandlerAnnotations(`
    package com.example.handlers

    import com.example.handlers.support.Channels
    import com.example.handlers.support.Destinations
    import org.springframework.amqp.rabbit.annotation.RabbitListener
    import org.springframework.context.event.EventListener
    import org.springframework.integration.annotation.ServiceActivator

    class OrderIntegration {
        @EventListener(OrderCreated::class)
        fun positionalEventType(event: OrderCreated) {}

        @EventListener(classes = [OrderCreated::class], condition = "#event.urgent")
        fun namedEventTypes(event: Any) {}

        @ServiceActivator(inputChannel = "orders.in", outputChannel = Channels.OUT)
        fun channels(message: Any) {}

        @RabbitListener(queues = ["orders"], containerFactory = "ordersFactory")
        fun literalQueue(payload: String) {}

        @RabbitListener(queues = [Destinations.PAYMENTS])
        fun constantQueue(payload: String) {}

        @RabbitListener(queues = ["\\\${app.messaging.queue}"])
        fun configuredQueue(payload: String) {}
    }
  `).flat();

  it('still recognizes the same Kotlin handlers once arguments are read', () => {
    expect(kotlinAnnotations.map((annotation) => annotation.name)).toEqual([
      'EventListener',
      'EventListener',
      'ServiceActivator',
      'RabbitListener',
      'RabbitListener',
      'RabbitListener',
    ]);
  });

  it('captures Kotlin event types and integration channels', () => {
    expect(kotlinAnnotations[0]?.args).toEqual([{ text: 'OrderCreated::class' }]);
    expect(kotlinAnnotations[1]?.args).toEqual([
      { name: 'classes', text: '[OrderCreated::class]' },
      { name: 'condition', text: '"#event.urgent"' },
    ]);
    expect(kotlinAnnotations[2]?.args).toEqual([
      { name: 'inputChannel', text: '"orders.in"' },
      { name: 'outputChannel', text: 'Channels.OUT' },
    ]);
  });

  it('captures a Kotlin queue written as a literal, a constant, or a placeholder', () => {
    expect(kotlinAnnotations.slice(3).map((annotation) => annotation.args)).toEqual([
      [
        { name: 'queues', text: '["orders"]' },
        { name: 'containerFactory', text: '"ordersFactory"' },
      ],
      [{ name: 'queues', text: '[Destinations.PAYMENTS]' }],
      [{ name: 'queues', text: '["\\${app.messaging.queue}"]' }],
    ]);
  });

  it('resolves neither an event type nor a channel at capture time', () => {
    const texts = [...javaAnnotations, ...kotlinAnnotations].flatMap(
      (annotation) => annotation.args ?? [],
    );
    // A resolver would have replaced these with a class, a channel, or a value.
    expect(texts.some((argument) => argument.text.includes('Channels.OUT'))).toBe(true);
    expect(texts.some((argument) => argument.text.includes('Destinations.PAYMENTS'))).toBe(true);
    expect(texts.some((argument) => argument.text === '"payments"')).toBe(false);
    expect(texts.some((argument) => argument.text.includes('com.example'))).toBe(false);
  });
});

describe('Spring handler annotation argument error recovery', () => {
  it('reports no Java arguments for an annotation that did not parse', () => {
    // Recovery fills the hole after `groupId =` with a node the author never
    // wrote — an empty `{}` array borrowed from the method body below — and the
    // resulting fact reads exactly like a real one. Reporting no arguments says
    // what is true: there is nothing here a resolver can use.
    const annotations = javaHandlerAnnotations(`
      package com.example.handlers;

      public class Unfinished {
          @KafkaListener(topics = "orders", groupId =
          public void handle(String payload) {}

          @KafkaListener(topics = "later")
          public void later(String payload) {}
      }
    `);
    const captured = annotations.flat().map((annotation) => annotation.args);
    expect(captured).toEqual([undefined, [{ name: 'topics', text: '"later"' }]]);
  });

  it('reports no Java arguments for an annotation with an empty assignment', () => {
    const annotations = javaHandlerAnnotations(`
      package com.example.handlers;

      public class Unfinished {
          @KafkaListener(topics = "orders", groupId = )
          public void handle(String payload) {}
      }
    `);
    expect(annotations.flat().map((annotation) => annotation.args)).toEqual([undefined]);
  });

  it('reports no Kotlin arguments for an annotation that did not parse', () => {
    const annotations = kotlinHandlerAnnotations(`
      package com.example.handlers

      class Unfinished {
          @KafkaListener(topics = ["orders"], groupId = )
          fun handle(payload: String) {}
      }
    `);
    expect(annotations.flat().map((annotation) => annotation.args)).toEqual([undefined]);
  });

  it('keeps the three argument states apart from the unreadable one', () => {
    // A recovered list collapses into the marker state deliberately, and the
    // two states that describe real source stay distinct from each other.
    const annotations = javaHandlerAnnotations(`
      package com.example.handlers;

      public class States {
          @Scheduled
          public void marker() {}

          @Scheduled()
          public void empty() {}

          @Scheduled(cron = "0 * * * * *")
          public void configured() {}
      }
    `);
    expect(annotations.flat().map((annotation) => annotation.args)).toEqual([
      undefined,
      [],
      [{ name: 'cron', text: '"0 * * * * *"' }],
    ]);
  });
});

describe('Spring handler annotation argument spellings', () => {
  it('gives one Java annotation argument one spelling however the source wrapped it', () => {
    const annotations = javaHandlerAnnotations(`
      package com.example.handlers;

      import com.example.handlers.support.Destinations;

      public class WrappedArguments {
          @KafkaListener(topics = Destinations.ORDERS)
          public void single(String payload) {}

          @KafkaListener(topics = Destinations
              .ORDERS)
          public void wrapped(String payload) {}
      }
    `);
    expect(annotations.flat().map((annotation) => annotation.args)).toEqual([
      [{ name: 'topics', text: 'Destinations.ORDERS' }],
      [{ name: 'topics', text: 'Destinations.ORDERS' }],
    ]);
  });

  it('gives one Kotlin annotation argument one spelling however the source wrapped it', () => {
    const annotations = kotlinHandlerAnnotations(`
      package com.example.handlers

      import com.example.handlers.support.Destinations

      class WrappedArguments {
          @KafkaListener(topics = [Destinations.ORDERS])
          fun single(payload: String) {}

          @KafkaListener(topics = [Destinations
              .ORDERS])
          fun wrapped(payload: String) {}

          @KafkaListener([Destinations
              .ORDERS])
          fun wrappedPositional(payload: String) {}
      }
    `);
    expect(annotations.flat().map((annotation) => annotation.args)).toEqual([
      [{ name: 'topics', text: '[Destinations.ORDERS]' }],
      [{ name: 'topics', text: '[Destinations.ORDERS]' }],
      [{ text: '[Destinations.ORDERS]' }],
    ]);
  });

  it('keeps the newlines inside a multi-line string literal argument', () => {
    const annotations = javaHandlerAnnotations(`
      package com.example.handlers;

      public class LiteralArguments {
          @KafkaListener(topics = """
line-a
.line-b""")
          public void handle(String payload) {}
      }
    `);
    expect(annotations.flat().map((annotation) => annotation.args)).toEqual([
      [{ name: 'topics', text: '"""\nline-a\n.line-b"""' }],
    ]);
  });
});

describe('Kotlin handler annotation argument scope', () => {
  it('reads arguments for a handler and leaves an unrelated annotation without them', () => {
    // Kotlin captures every annotated callable on purpose, but it does not have
    // to read every annotation's arguments to do that. Only annotations that a
    // handler callable carries pay for the structured copy.
    const annotations = kotlinHandlerAnnotations(`
      package com.example.handlers

      import org.springframework.kafka.annotation.KafkaListener
      import org.springframework.transaction.annotation.Transactional

      class Mixed {
          @Transactional("txManager")
          fun notAHandler(payload: String) {}

          @Transactional("txManager")
          @KafkaListener(topics = ["orders"])
          fun handler(payload: String) {}
      }
    `);
    expect(
      annotations.map((fact) => fact.map((annotation) => [annotation.name, annotation.args])),
    ).toEqual([
      [['Transactional', undefined]],
      [
        ['Transactional', [{ text: '"txManager"' }]],
        ['KafkaListener', [{ name: 'topics', text: '["orders"]' }]],
      ],
    ]);
  });

  it('reads arguments for a handler annotation reached only through an import alias', () => {
    // The alias is why Kotlin cannot prefilter callables by simple name. It is
    // not a reason to skip the argument pass: the import header states which FQN
    // the local name stands for, so the same relevance question can be answered
    // about the imported name and carried back to the alias.
    const annotations = kotlinHandlerAnnotations(`
      package com.example.handlers

      import org.springframework.context.event.EventListener as SpringEvent
      import org.springframework.transaction.annotation.Transactional as Tx

      class AliasedHandlers {
          @SpringEvent(condition = "#root.args[0] != null")
          fun aliasedEvent(event: Any) {}

          @Tx("txManager")
          fun notAHandler(payload: String) {}
      }
    `);
    expect(
      annotations.map((fact) => fact.map((annotation) => [annotation.name, annotation.args])),
    ).toEqual([
      [['SpringEvent', [{ name: 'condition', text: '"#root.args[0] != null"' }]]],
      [['Tx', undefined]],
    ]);
  });
});
