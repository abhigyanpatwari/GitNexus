import { describe, expect, it } from 'vitest';
import type { SpringNonHttpHandlerAnnotationFact } from '../../src/core/ingestion/frameworks/spring/non-http-handlers.js';
import { collectKotlinCaptureSideChannel } from '../../src/core/ingestion/languages/kotlin/capture-side-channel.js';
import { emitKotlinScopeCaptures } from '../../src/core/ingestion/languages/kotlin/captures.js';
const KOTLIN_FILE = 'src/HandlerArguments.kt';

function kotlinHandlerAnnotations(code: string): SpringNonHttpHandlerAnnotationFact[][] {
  emitKotlinScopeCaptures(code, KOTLIN_FILE);
  const facts = collectKotlinCaptureSideChannel(KOTLIN_FILE)?.springNonHttpHandlerFacts ?? [];
  return facts.map((fact) => [...fact.annotations]);
}

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
});

describe('Spring handler annotation argument error recovery', () => {
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
});

describe('Spring handler annotation argument spellings', () => {
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
