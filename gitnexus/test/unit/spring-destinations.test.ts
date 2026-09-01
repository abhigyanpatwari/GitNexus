import { describe, it, expect } from 'vitest';
import {
  isAddressShaped,
  isSpringDestinationAnnotation,
  parseSpringStringLiteral,
  resolveSpringDestination,
  resolveSpringPlaceholders,
  selectConsumerDestinationArguments,
  selectProducerDestinationArguments,
  splitSpringDestinationList,
  type SpringDestinationCandidate,
} from '../../src/core/ingestion/frameworks/spring/destinations.js';

/**
 * The pure half of Spring destination resolution: argument selection, the
 * four-step cascade, and the refusal taxonomy.
 *
 * The NEGATIVE cases are pinned as hard as the positive ones on purpose. The
 * recurring failure mode in this area is a suppression that also eats correct
 * results, and the single most important assertion in the whole feature is that
 * an UNRESOLVED address never yields something two services could join on — so
 * every path that declines is asserted to decline for a NAMED reason, not
 * merely to produce nothing.
 */

const candidate = (
  rawText: string,
  overrides: Partial<SpringDestinationCandidate> = {},
): SpringDestinationCandidate => ({
  role: 'consumer',
  source: 'KafkaListener',
  broker: 'kafka',
  argIndex: 0,
  elementIndex: 0,
  rawText,
  ...overrides,
});

describe('splitSpringDestinationList', () => {
  it('splits the Java brace form', () => {
    expect(splitSpringDestinationList('{"orders", "shipments"}')).toEqual([
      '"orders"',
      '"shipments"',
    ]);
  });

  it('splits the Kotlin bracket form', () => {
    expect(splitSpringDestinationList('["orders", "shipments"]')).toEqual([
      '"orders"',
      '"shipments"',
    ]);
  });

  it('splits the Kotlin arrayOf form', () => {
    expect(splitSpringDestinationList('arrayOf("orders", "shipments")')).toEqual([
      '"orders"',
      '"shipments"',
    ]);
  });

  it('leaves a scalar argument as one element', () => {
    expect(splitSpringDestinationList('"orders"')).toEqual(['"orders"']);
    expect(splitSpringDestinationList('Topics.ORDERS')).toEqual(['Topics.ORDERS']);
  });

  it('does not split on a comma inside a string literal', () => {
    expect(splitSpringDestinationList('{"a,b", "c"}')).toEqual(['"a,b"', '"c"']);
  });

  it('does not split on a comma inside a nested call', () => {
    expect(splitSpringDestinationList('{join("a", "b"), "c"}')).toEqual(['join("a", "b")', '"c"']);
  });

  it('reports an empty list as empty, which is different from one element', () => {
    expect(splitSpringDestinationList('{}')).toEqual([]);
    expect(splitSpringDestinationList('[]')).toEqual([]);
    expect(splitSpringDestinationList('arrayOf()')).toEqual([]);
  });
});

describe('parseSpringStringLiteral', () => {
  it('unquotes the ordinary form', () => {
    expect(parseSpringStringLiteral('"orders.v1"')).toBe('orders.v1');
  });

  it('unquotes a Kotlin raw string', () => {
    expect(parseSpringStringLiteral('"""orders.v1"""')).toBe('orders.v1');
  });

  it('undoes the Kotlin dollar escape so a placeholder is still recognizable', () => {
    // Kotlin requires `\$` or the compiler reads `${...}` as a string template.
    // Without this the placeholder would be misfiled as a literal address.
    expect(parseSpringStringLiteral('"\\${app.orders.topic}"')).toBe('${app.orders.topic}');
  });

  it('returns null for anything that is not a single literal', () => {
    expect(parseSpringStringLiteral('Topics.ORDERS')).toBeNull();
    expect(parseSpringStringLiteral('"a" + "b"')).toBeNull();
    expect(parseSpringStringLiteral('{"a"}')).toBeNull();
  });
});

describe('resolveSpringPlaceholders', () => {
  it('passes a value with no placeholder through as plain', () => {
    expect(resolveSpringPlaceholders('orders')).toEqual({ plain: true });
  });

  it('resolves a default, because the default is written in the source', () => {
    expect(resolveSpringPlaceholders('${app.orders.topic:orders}')).toEqual({
      plain: false,
      value: 'orders',
    });
  });

  it('splits on the first colon only', () => {
    expect(resolveSpringPlaceholders('${app.topic:a:b}')).toEqual({ plain: false, value: 'a:b' });
  });

  it('substitutes a placeholder embedded in a larger value', () => {
    expect(resolveSpringPlaceholders('prefix-${env:dev}-orders')).toEqual({
      plain: false,
      value: 'prefix-dev-orders',
    });
  });

  it('reports the key, and no value, when there is no default', () => {
    expect(resolveSpringPlaceholders('${app.orders.topic}')).toEqual({
      plain: false,
      unresolvedKey: 'app.orders.topic',
    });
  });

  it('refuses to half-expand a nested placeholder', () => {
    expect(resolveSpringPlaceholders('${a:${b}}')).toEqual({ plain: false, unresolvedKey: 'a' });
  });

  it('refuses an unterminated placeholder rather than treating it as text', () => {
    expect(resolveSpringPlaceholders('${app.topic').unresolvedKey).toBe('app.topic');
  });
});

describe('the resolution cascade', () => {
  it('step 1 resolves a literal', () => {
    expect(resolveSpringDestination(candidate('"orders"'))).toEqual({
      kind: 'resolved',
      address: 'orders',
      via: 'literal',
    });
  });

  it('step 2 resolves a constant through the supplied resolver', () => {
    const resolution = resolveSpringDestination(candidate('Topics.ORDERS'), {
      constant: (name) => (name === 'Topics.ORDERS' ? 'orders.v1' : null),
    });
    expect(resolution).toEqual({ kind: 'resolved', address: 'orders.v1', via: 'constant' });
  });

  it('step 2 refuses, by name, when the constant cannot be folded', () => {
    expect(resolveSpringDestination(candidate('Topics.ORDERS'), { constant: () => null })).toEqual({
      kind: 'unresolved',
      reason: 'unresolved-constant',
    });
  });

  it('step 3 resolves a placeholder default to that default', () => {
    expect(resolveSpringDestination(candidate('"${app.orders.topic:orders}"'))).toEqual({
      kind: 'resolved',
      address: 'orders',
      via: 'config-default',
    });
  });

  it('step 3 does NOT resolve a placeholder without a default, and records the key', () => {
    expect(resolveSpringDestination(candidate('"${app.orders.topic}"'))).toEqual({
      kind: 'unresolved',
      reason: 'unresolved-config-key',
      configKey: 'app.orders.topic',
    });
  });

  it('runs step 3 on the value a constant folded to', () => {
    // `static final String TOPIC = "${app.orders.topic}"` is an ordinary way to
    // write a placeholder. Stopping after step 2 would publish the placeholder
    // text as a resolved address — a shared identity for unrelated services.
    const resolution = resolveSpringDestination(candidate('Topics.ORDERS'), {
      constant: () => '${app.orders.topic}',
    });
    expect(resolution).toEqual({
      kind: 'unresolved',
      reason: 'unresolved-config-key',
      configKey: 'app.orders.topic',
    });
  });

  it('never returns the placeholder text as an address', () => {
    const resolution = resolveSpringDestination(candidate('"${app.topic}"'));
    expect(resolution.kind).toBe('unresolved');
    expect(resolution).not.toHaveProperty('address');
  });

  it('refuses an expression that is neither a literal nor a constant reference', () => {
    expect(resolveSpringDestination(candidate('"a" + suffix()'))).toEqual({
      kind: 'unresolved',
      reason: 'not-a-literal-or-constant',
    });
  });

  it('refuses an address that folds to the empty string', () => {
    // `${key:}` means "default to empty". An empty address addresses nothing,
    // and letting it through would give every such site one shared identity.
    expect(resolveSpringDestination(candidate('"${app.topic:}"'))).toEqual({
      kind: 'unresolved',
      reason: 'empty-address',
    });
  });

  it('leaves step 4 unimplemented, and consults it only when supplied', () => {
    // The seam is deliberately not wired in production; this pins its contract.
    expect(resolveSpringDestination(candidate('"${app.topic}"')).kind).toBe('unresolved');
    expect(
      resolveSpringDestination(candidate('"${app.topic}"'), {
        specification: () => 'orders.from.spec',
      }),
    ).toEqual({ kind: 'resolved', address: 'orders.from.spec', via: 'specification' });
  });
});

describe('consumer argument selection', () => {
  it('reads @KafkaListener(topics = …)', () => {
    const selection = selectConsumerDestinationArguments(
      'org.springframework.kafka.annotation.KafkaListener',
      [{ name: 'topics', text: '"orders"' }],
    );
    expect(selection?.candidates).toHaveLength(1);
    expect(selection?.candidates[0]).toMatchObject({ broker: 'kafka', argName: 'topics' });
    expect(selection?.refusals).toEqual([]);
  });

  it('reads @RabbitListener(queues = …) and @JmsListener(destination = …)', () => {
    expect(
      selectConsumerDestinationArguments('RabbitListener', [{ name: 'queues', text: '"orders"' }])
        ?.candidates[0],
    ).toMatchObject({ broker: 'rabbit' });
    expect(
      selectConsumerDestinationArguments('JmsListener', [{ name: 'destination', text: '"orders"' }])
        ?.candidates[0],
    ).toMatchObject({ broker: 'jms' });
  });

  it('reads @ServiceActivator(inputChannel = …)', () => {
    expect(
      selectConsumerDestinationArguments('ServiceActivator', [
        { name: 'inputChannel', text: '"orders"' },
      ])?.candidates[0],
    ).toMatchObject({ broker: 'integration', argName: 'inputChannel' });
  });

  it('reads a positional argument only where `value` really is the destination', () => {
    expect(selectConsumerDestinationArguments('SqsListener', [{ text: '"orders"' }])?.candidates)
      .toHaveLength(1);
    expect(selectConsumerDestinationArguments('StreamListener', [{ text: '"orders"' }])?.candidates)
      .toHaveLength(1);
    // @KafkaListener declares no `value` alias for its topics, so a positional
    // argument there is a different element and must not be guessed at.
    const kafka = selectConsumerDestinationArguments('KafkaListener', [{ text: '"orders"' }]);
    expect(kafka?.candidates).toEqual([]);
    expect(kafka?.refusals.map((r) => r.reason)).toEqual(['no-destination-argument']);
  });

  it('yields one candidate per element for an array, not a group', () => {
    const selection = selectConsumerDestinationArguments('KafkaListener', [
      { name: 'topics', text: '{"orders", "shipments"}' },
    ]);
    expect(selection?.candidates.map((c) => c.rawText)).toEqual(['"orders"', '"shipments"']);
    expect(selection?.candidates.map((c) => c.elementIndex)).toEqual([0, 1]);
  });

  it('refuses topicPattern as a pattern, not an address', () => {
    const selection = selectConsumerDestinationArguments('KafkaListener', [
      { name: 'topicPattern', text: '"orders.*"' },
    ]);
    expect(selection?.candidates).toEqual([]);
    expect(selection?.refusals.map((r) => r.reason)).toEqual(['topic-pattern']);
  });

  it('refuses argument shapes it will not read, by name', () => {
    expect(
      selectConsumerDestinationArguments('RabbitListener', [
        { name: 'bindings', text: '@QueueBinding(value = @Queue("orders"))' },
      ])?.refusals.map((r) => r.reason),
    ).toEqual(['unsupported-annotation-argument']);
    expect(
      selectConsumerDestinationArguments('KafkaListener', [
        { name: 'topicPartitions', text: '@TopicPartition(topic = "orders", partitions = "0")' },
      ])?.refusals.map((r) => r.reason),
    ).toEqual(['unsupported-annotation-argument']);
  });

  it('refuses an empty destination list rather than passing silently', () => {
    const selection = selectConsumerDestinationArguments('KafkaListener', [
      { name: 'topics', text: '{}' },
    ]);
    expect(selection?.candidates).toEqual([]);
    expect(selection?.refusals.map((r) => r.reason)).toEqual(['empty-destination-list']);
  });

  it('records absent arguments as their own refusal', () => {
    expect(
      selectConsumerDestinationArguments('KafkaListener', undefined)?.refusals.map((r) => r.reason),
    ).toEqual(['annotation-arguments-unavailable']);
    expect(
      selectConsumerDestinationArguments('KafkaListener', [])?.refusals.map((r) => r.reason),
    ).toEqual(['annotation-arguments-unavailable']);
  });

  it('records a listener whose arguments name no destination', () => {
    const selection = selectConsumerDestinationArguments('KafkaListener', [
      { name: 'groupId', text: '"orders-group"' },
    ]);
    expect(selection?.refusals.map((r) => r.reason)).toEqual(['no-destination-argument']);
  });

  it('excludes WebSocket/STOMP mappings entirely', () => {
    // @MessageMapping and @SubscribeMapping are session-scoped application
    // routes, not broker addresses. Modelling them as destinations would put a
    // STOMP path in the same namespace as a Kafka topic.
    expect(selectConsumerDestinationArguments('MessageMapping', [{ text: '"/topic/prices"' }])).toBeNull();
    expect(
      selectConsumerDestinationArguments('SubscribeMapping', [{ text: '"/topic/prices"' }]),
    ).toBeNull();
    expect(isSpringDestinationAnnotation('MessageMapping')).toBe(false);
    expect(isSpringDestinationAnnotation('KafkaListener')).toBe(true);
  });

  it('recognizes repeated-listener containers without reporting them as unknown', () => {
    const selection = selectConsumerDestinationArguments('KafkaListeners', [
      { text: '{@KafkaListener(topics = "a")}' },
    ]);
    expect(selection).toEqual({ candidates: [], refusals: [] });
  });
});

describe('producer argument selection', () => {
  const args = (...texts: string[]) => texts.map((text) => ({ text }));

  it('takes argument 0 for kafka send', () => {
    const selection = selectProducerDestinationArguments({
      template: 'kafka',
      methodName: 'send',
      args: args('"orders"', 'payload'),
    });
    expect(selection.candidates).toHaveLength(1);
    expect(selection.candidates[0]).toMatchObject({ broker: 'kafka', argIndex: 0 });
  });

  it('takes argument 0 for a stream-bridge binding and reports the broker as stream', () => {
    expect(
      selectProducerDestinationArguments({
        template: 'stream-bridge',
        methodName: 'send',
        args: args('"orders-out-0"', 'payload'),
      }).candidates[0],
    ).toMatchObject({ broker: 'stream', argIndex: 0 });
  });

  it('takes argument 0 for jms convertAndSend', () => {
    expect(
      selectProducerDestinationArguments({
        template: 'jms',
        methodName: 'convertAndSend',
        args: args('"orders"', 'payload'),
      }).candidates[0],
    ).toMatchObject({ broker: 'jms', argIndex: 0 });
  });

  it('refuses a single-argument send: the destination is inside an object', () => {
    // send(ProducerRecord) / send(Message<?>) / convertAndSend(Object).
    for (const template of ['kafka', 'jms', 'stream-bridge'] as const) {
      const selection = selectProducerDestinationArguments({
        template,
        methodName: template === 'kafka' || template === 'stream-bridge' ? 'send' : 'convertAndSend',
        args: args('record'),
      });
      expect(selection.candidates).toEqual([]);
      expect(selection.refusals.map((r) => r.reason)).toEqual(['producer-arity-unrecognized']);
    }
  });

  it('refuses a two-argument jms convertAndSend whose slot 0 is not confidently an address', () => {
    // `convertAndSend(message, postProcessor)` has the same arity as
    // `convertAndSend(destination, message)`. Shape, not arity, is what tells
    // them apart, so a payload in slot 0 must refuse rather than be published.
    const selection = selectProducerDestinationArguments({
      template: 'jms',
      methodName: 'convertAndSend',
      args: args('message', 'postProcessor'),
    });
    expect(selection.candidates).toEqual([]);
    expect(selection.refusals.map((r) => r.reason)).toEqual([
      'producer-argument-not-address-shaped',
    ]);
  });

  it('relaxes the jms gate at three arguments, where slot 0 is always the destination', () => {
    const selection = selectProducerDestinationArguments({
      template: 'jms',
      methodName: 'convertAndSend',
      args: args('destination', 'message', 'postProcessor'),
    });
    expect(selection.candidates).toHaveLength(1);
    expect(selection.candidates[0]).toMatchObject({ argIndex: 0, rawText: 'destination' });
  });

  it('records a Kotlin trailing-lambda call as arguments-unavailable', () => {
    const selection = selectProducerDestinationArguments({
      template: 'kafka',
      methodName: 'send',
    });
    expect(selection.refusals.map((r) => r.reason)).toEqual(['producer-arguments-unavailable']);
  });

  describe('rabbit convertAndSend arity rules', () => {
    it('refuses one argument: the default exchange has no address in the source', () => {
      const selection = selectProducerDestinationArguments({
        template: 'rabbit',
        methodName: 'convertAndSend',
        args: args('payload'),
      });
      expect(selection.candidates).toEqual([]);
      expect(selection.refusals.map((r) => r.reason)).toEqual(['rabbit-default-exchange']);
    });

    it('reads two arguments as routingKey + message', () => {
      const selection = selectProducerDestinationArguments({
        template: 'rabbit',
        methodName: 'convertAndSend',
        args: args('"orders.created"', 'payload'),
      });
      expect(selection.candidates).toHaveLength(1);
      expect(selection.candidates[0]).toMatchObject({ argIndex: 0, rawText: '"orders.created"' });
      expect(selection.candidates[0]?.exchange).toBeUndefined();
    });

    it('reads three arguments as exchange + routingKey + message', () => {
      const selection = selectProducerDestinationArguments({
        template: 'rabbit',
        methodName: 'convertAndSend',
        args: args('"orders.exchange"', '"orders.created"', 'payload'),
      });
      expect(selection.candidates).toHaveLength(1);
      // The routing key is the address; the exchange rides along as provenance.
      expect(selection.candidates[0]).toMatchObject({
        argIndex: 1,
        rawText: '"orders.created"',
        exchange: 'orders.exchange',
      });
    });

    it('is not decided by arity alone: a trailing MessagePostProcessor keeps arg 0', () => {
      // `convertAndSend(routingKey, message, postProcessor)` is three arguments
      // but has no exchange. Reading it positionally would publish the ROUTING
      // KEY as an exchange and the payload expression as an address. `payload`
      // is a lowercase bare identifier, which is NOT confident evidence of an
      // address, so slot 1 is rejected and slot 0 stays the routing key.
      const selection = selectProducerDestinationArguments({
        template: 'rabbit',
        methodName: 'convertAndSend',
        args: args('"orders.created"', 'payload', 'postProcessor'),
      });
      expect(selection.candidates).toHaveLength(1);
      expect(selection.candidates[0]).toMatchObject({ argIndex: 0, rawText: '"orders.created"' });
      expect(selection.candidates[0]?.exchange).toBeUndefined();
    });

    it('accepts a screaming-snake constant as confident evidence at three arguments', () => {
      const selection = selectProducerDestinationArguments({
        template: 'rabbit',
        methodName: 'convertAndSend',
        args: args('ORDERS_EXCHANGE', 'ORDERS_ROUTING_KEY', 'payload'),
      });
      expect(selection.candidates[0]).toMatchObject({
        argIndex: 1,
        rawText: 'ORDERS_ROUTING_KEY',
        exchange: 'ORDERS_EXCHANGE',
      });
    });

    it('reads four arguments as unambiguously exchange + routingKey', () => {
      // Only the exchange overload reaches four arguments, so slot 1 needs no
      // confident spelling and a lowercase constant reference is let through.
      const selection = selectProducerDestinationArguments({
        template: 'rabbit',
        methodName: 'convertAndSend',
        args: args('"orders.exchange"', 'routingKey', 'payload', 'postProcessor'),
      });
      expect(selection.candidates[0]).toMatchObject({
        argIndex: 1,
        rawText: 'routingKey',
        exchange: 'orders.exchange',
      });
    });

    it('refuses when neither leading argument is confidently an address', () => {
      const selection = selectProducerDestinationArguments({
        template: 'rabbit',
        methodName: 'convertAndSend',
        args: args('message', 'postProcessor'),
      });
      expect(selection.candidates).toEqual([]);
      expect(selection.refusals.map((r) => r.reason)).toEqual([
        'producer-argument-not-address-shaped',
      ]);
    });
  });

  it('keeps the permissive gate where arity already fixes the slot', () => {
    // kafka `send` puts the topic first in every multi-argument overload, so a
    // bare identifier is passed to the cascade rather than refused on shape —
    // and the cascade then refuses it by the name of what it actually tried.
    const selection = selectProducerDestinationArguments({
      template: 'kafka',
      methodName: 'send',
      args: args('topic', 'payload'),
    });
    expect(selection.candidates).toHaveLength(1);
    expect(resolveSpringDestination(selection.candidates[0]!, { constant: () => null })).toEqual({
      kind: 'unresolved',
      reason: 'unresolved-constant',
    });
  });
});

describe('isAddressShaped', () => {
  it('accepts literals and constant references', () => {
    expect(isAddressShaped('"orders"')).toBe(true);
    expect(isAddressShaped('ORDERS')).toBe(true);
    expect(isAddressShaped('Topics.ORDERS')).toBe(true);
    expect(isAddressShaped('com.example.Topics.ORDERS')).toBe(true);
  });

  it('rejects payload-shaped expressions', () => {
    expect(isAddressShaped('new ProducerRecord<>("a", b)')).toBe(false);
    expect(isAddressShaped('buildMessage()')).toBe(false);
    expect(isAddressShaped('"a" + b')).toBe(false);
  });

  it('accepts a bare identifier, which a resolver may still refuse', () => {
    // The shape gate says "this could be an address", never "this resolves".
    expect(isAddressShaped('topic')).toBe(true);
    expect(
      resolveSpringDestination(candidate('topic'), { constant: () => null }).kind,
    ).toBe('unresolved');
  });
});
