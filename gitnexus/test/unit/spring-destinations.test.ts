import { describe, it, expect } from 'vitest';
import {
  hasUnescapedStringInterpolation,
  isAddressShaped,
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

  it('does not fold a concatenation of two raw strings into one literal', () => {
    // A greedy triple-quote body swallowed the operator and produced the single
    // address `a""" + """b`, which no source ever wrote.
    expect(parseSpringStringLiteral('"""a""" + """b"""')).toBeNull();
    expect(parseSpringStringLiteral('"""a"""+"""b"""')).toBeNull();
  });
});

describe('hasUnescapedStringInterpolation', () => {
  it('sees the two Kotlin template forms', () => {
    expect(hasUnescapedStringInterpolation('"orders-$env"')).toBe(true);
    expect(hasUnescapedStringInterpolation('"orders-${env}"')).toBe(true);
  });

  it('does not see an ESCAPED dollar, which is how a Spring placeholder is written', () => {
    expect(hasUnescapedStringInterpolation('"\\${app.topic}"')).toBe(false);
  });

  it('treats every dollar in a raw string as an interpolation', () => {
    // Kotlin raw strings have no backslash escapes at all.
    expect(hasUnescapedStringInterpolation('"""orders-$env"""')).toBe(true);
    expect(hasUnescapedStringInterpolation('"""orders"""')).toBe(false);
  });

  it('ignores a dollar that starts no template', () => {
    expect(hasUnescapedStringInterpolation('"price-$"')).toBe(false);
    expect(hasUnescapedStringInterpolation('"cost-$9"')).toBe(false);
  });
});

describe('resolveSpringPlaceholders', () => {
  it('passes a value with no placeholder through as plain', () => {
    expect(resolveSpringPlaceholders('orders')).toEqual({ plain: true });
  });

  it('reports a default without substituting it', () => {
    // The default is written in the source, so it is READ — but configuration
    // can override it and this graph never sees configuration values, so it is
    // provenance, not an address and not an identity.
    expect(resolveSpringPlaceholders('${app.orders.topic:orders}')).toEqual({
      plain: false,
      key: 'app.orders.topic',
      defaultValue: 'orders',
    });
  });

  it('splits on the first colon only', () => {
    expect(resolveSpringPlaceholders('${app.topic:a:b}')).toEqual({
      plain: false,
      key: 'app.topic',
      defaultValue: 'a:b',
    });
  });

  it('reads the first placeholder of a larger value', () => {
    expect(resolveSpringPlaceholders('prefix-${env:dev}-orders')).toEqual({
      plain: false,
      key: 'env',
      defaultValue: 'dev',
    });
  });

  it('reports the key, and no default, when there is none', () => {
    expect(resolveSpringPlaceholders('${app.orders.topic}')).toEqual({
      plain: false,
      key: 'app.orders.topic',
    });
  });

  it('reports a nested default as written, without expanding it', () => {
    expect(resolveSpringPlaceholders('${a:${b}}')).toEqual({
      plain: false,
      key: 'a',
      defaultValue: '${b}',
    });
  });

  it('reports an empty key for a placeholder that names none', () => {
    expect(resolveSpringPlaceholders('${}')).toEqual({ plain: false, key: '' });
  });

  it('refuses an unterminated placeholder rather than treating it as text', () => {
    expect(resolveSpringPlaceholders('${app.topic').key).toBe('app.topic');
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

  it('step 3 does NOT resolve a placeholder default, and keeps both key and default', () => {
    // A default holds only while the key is not overridden, and configuration
    // VALUES are deliberately absent from this graph, so the code cannot know
    // whether it holds. Keying on it merged every service that copy-pasted the
    // same fallback.
    expect(resolveSpringDestination(candidate('"${app.orders.topic:orders}"'))).toEqual({
      kind: 'unresolved',
      reason: 'overridable-config-default',
      configKey: 'app.orders.topic',
      configDefault: 'orders',
    });
  });

  it('does not merge two DIFFERENT keys that share a default', () => {
    // The reproduction: `${a.topic:events}` in one service and
    // `${b.topic:events}` in another collapsed onto one `Destination:events`
    // and reported a producer/consumer pair between two unrelated services.
    const a = resolveSpringDestination(candidate('"${a.topic:events}"'));
    const b = resolveSpringDestination(candidate('"${b.topic:events}"'));
    expect(a).not.toHaveProperty('address');
    expect(b).not.toHaveProperty('address');
    expect(a).toMatchObject({ configKey: 'a.topic', configDefault: 'events' });
    expect(b).toMatchObject({ configKey: 'b.topic', configDefault: 'events' });
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

  it('refuses an empty literal, and says which kind of empty it was', () => {
    // An empty address addresses nothing, and letting it through would give
    // every such site one shared `''` identity.
    expect(resolveSpringDestination(candidate('""'))).toEqual({
      kind: 'unresolved',
      reason: 'empty-literal-address',
    });
    expect(resolveSpringDestination(candidate('"   "'))).toEqual({
      kind: 'unresolved',
      reason: 'empty-literal-address',
    });
    expect(resolveSpringDestination(candidate('Topics.EMPTY'), { constant: () => '' })).toEqual({
      kind: 'unresolved',
      reason: 'empty-constant-address',
    });
  });

  it('files `${key:}` as an overridable default, keeping the key it used to drop', () => {
    // It used to land in `empty-address`, which threw the key away and merged
    // the case with three unrelated causes.
    expect(resolveSpringDestination(candidate('"${app.topic:}"'))).toEqual({
      kind: 'unresolved',
      reason: 'overridable-config-default',
      configKey: 'app.topic',
      configDefault: '',
    });
  });

  it('refuses `${}` without ever reporting an empty configuration key', () => {
    const resolution = resolveSpringDestination(candidate('"${}"'));
    expect(resolution).toEqual({ kind: 'unresolved', reason: 'empty-config-key' });
    expect(resolution).not.toHaveProperty('configKey');
  });

  it('keeps an address exactly as written, whitespace included', () => {
    // The emptiness test trims; the address does not. `" orders "` gets its own
    // node rather than joining `orders` — a missing connection, which is the
    // direction this module errs in everywhere.
    expect(resolveSpringDestination(candidate('" orders "'))).toEqual({
      kind: 'resolved',
      address: ' orders ',
      via: 'literal',
    });
  });

  // ── SpEL: a runtime bean expression is not an address ────────────────────

  it('refuses a SpEL expression instead of filing it as a literal address', () => {
    // Reproduced before the fix: two unrelated services that each wrote
    // `@KafkaListener(topics = "#{@kafkaProps.ordersTopic}")` produced ONE node
    // with `address = "#{@kafkaProps.ordersTopic}"` and a CONSUMES_FROM edge
    // from each.
    for (const spel of [
      '"#{@kafkaProps.ordersTopic}"',
      '"#{environment[\'app.topic\']}"',
      '"#{T(Topics).ORDERS}"',
      '"orders-#{@env.suffix}"',
    ]) {
      const resolution = resolveSpringDestination(candidate(spel));
      expect(resolution).toEqual({ kind: 'unresolved', reason: 'spel-expression' });
      expect(resolution).not.toHaveProperty('address');
    }
  });

  it('calls a SpEL expression that wraps a placeholder SpEL, not a config key', () => {
    // `"#{'${app.topics}'.split(',')}"` was caught only by accident, because it
    // happens to contain `${`. The diagnosis has to name what it really is.
    expect(resolveSpringDestination(candidate("\"#{'${app.topics}'.split(',')}\""))).toEqual({
      kind: 'unresolved',
      reason: 'spel-expression',
    });
  });

  // ── String templates in a language that interpolates ─────────────────────

  it('refuses an unescaped interpolation where literals interpolate', () => {
    for (const template of ['"orders-$env"', '"orders-${env}"', '"""orders-$env"""']) {
      const resolution = resolveSpringDestination(candidate(template), {
        interpolatesStringLiterals: true,
      });
      expect(resolution).toEqual({ kind: 'unresolved', reason: 'unescaped-interpolation' });
      expect(resolution).not.toHaveProperty('address');
      expect(resolution).not.toHaveProperty('configKey');
    }
  });

  it('still reads the ESCAPED form as a Spring placeholder where literals interpolate', () => {
    expect(
      resolveSpringDestination(candidate('"\\${app.topic}"'), {
        interpolatesStringLiterals: true,
      }),
    ).toEqual({ kind: 'unresolved', reason: 'unresolved-config-key', configKey: 'app.topic' });
  });

  it('leaves a non-interpolating language exactly as it was', () => {
    // In Java `$` is an ordinary character and `${...}` is a Spring placeholder.
    expect(resolveSpringDestination(candidate('"orders-$env"'))).toEqual({
      kind: 'resolved',
      address: 'orders-$env',
      via: 'literal',
    });
    expect(resolveSpringDestination(candidate('"${app.topic}"'))).toEqual({
      kind: 'unresolved',
      reason: 'unresolved-config-key',
      configKey: 'app.topic',
    });
  });

  it('does not invent a configKey from a Kotlin `${var}` template', () => {
    // The old reading produced `configKey: "env"` and the phase then emitted a
    // USES edge to any Property named `env` — provenance with no source.
    const resolution = resolveSpringDestination(candidate('"orders-${env}"'), {
      interpolatesStringLiterals: true,
    });
    expect(resolution).not.toHaveProperty('configKey');
  });

  it('refuses an interpolating constant rather than folding it to an address', () => {
    expect(
      resolveSpringDestination(candidate('Topics.TEMPLATE'), {
        constant: () => 'orders-$env',
        interpolatesStringLiterals: true,
      }),
    ).toEqual({ kind: 'unresolved', reason: 'unescaped-interpolation' });
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
    expect(
      selectConsumerDestinationArguments('SqsListener', [{ text: '"orders"' }])?.candidates,
    ).toHaveLength(1);
    expect(
      selectConsumerDestinationArguments('StreamListener', [{ text: '"orders"' }])?.candidates,
    ).toHaveLength(1);
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

  it('keeps unread arguments and an empty argument list apart', () => {
    // Absent = the capture never read the list. Empty = a list WAS read and it
    // was empty, which is a fact about the source. Filing a source-level gap
    // under a tooling gap corrupts the reason breakdown this feature is
    // measured on, and the producer side of this module already distinguishes
    // them.
    expect(
      selectConsumerDestinationArguments('KafkaListener', undefined)?.refusals.map((r) => r.reason),
    ).toEqual(['annotation-arguments-unavailable']);
    expect(
      selectConsumerDestinationArguments('KafkaListener', [])?.refusals.map((r) => r.reason),
    ).toEqual(['annotation-arguments-empty']);
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
    expect(
      selectConsumerDestinationArguments('MessageMapping', [{ text: '"/topic/prices"' }]),
    ).toBeNull();
    expect(
      selectConsumerDestinationArguments('SubscribeMapping', [{ text: '"/topic/prices"' }]),
    ).toBeNull();
  });

  it('records a repeated-listener container as a refusal, not as nothing', () => {
    // Capture does not descend into the nested annotations, so a repository
    // using these really does lose those destinations. Returning an empty
    // selection made that indistinguishable from a repository with no
    // listeners, and was observationally identical to returning `null` — the
    // caller skips both — so the stated reason for the branch did not hold.
    for (const [container, broker] of [
      ['KafkaListeners', 'kafka'],
      ['RabbitListeners', 'rabbit'],
      ['JmsListeners', 'jms'],
      ['PulsarListeners', 'pulsar'],
    ] as const) {
      const selection = selectConsumerDestinationArguments(container, [
        { text: '{@Listener(topics = "a")}' },
      ]);
      expect(selection?.candidates).toEqual([]);
      expect(selection?.refusals).toHaveLength(1);
      expect(selection?.refusals[0]).toMatchObject({
        reason: 'repeated-listener-container',
        broker,
        source: container,
      });
    }
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
        methodName:
          template === 'kafka' || template === 'stream-bridge' ? 'send' : 'convertAndSend',
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
      // Slot 1 is a CONSTANT, which is why this one is readable at all: a
      // literal there would be indistinguishable from a String payload under
      // the competing `(routingKey, message, correlationData)` overload, and
      // is refused instead (see the ambiguity test below).
      const selection = selectProducerDestinationArguments({
        template: 'rabbit',
        methodName: 'convertAndSend',
        args: args('"orders.exchange"', 'Topics.ORDERS_KEY', 'payload'),
      });
      expect(selection.candidates).toHaveLength(1);
      // The routing key is the address; the exchange rides along as provenance.
      expect(selection.candidates[0]).toMatchObject({
        argIndex: 1,
        rawText: 'Topics.ORDERS_KEY',
        exchange: 'orders.exchange',
      });
    });

    it('REFUSES at three arguments when slot 1 is not confidently an address', () => {
      // `convertAndSend(routingKey, message, postProcessor)` and
      // `convertAndSend(routingKey, message, correlationData)` are three
      // arguments with no exchange, and they are indistinguishable from
      // `convertAndSend(exchange, routingKey, message)` by arity. The former
      // code fell back to slot 0 here, which is what published an EXCHANGE as
      // an address; there is no fallback now.
      const selection = selectProducerDestinationArguments({
        template: 'rabbit',
        methodName: 'convertAndSend',
        args: args('"orders.created"', 'payload', 'postProcessor'),
      });
      expect(selection.candidates).toEqual([]);
      expect(selection.refusals.map((r) => r.reason)).toEqual([
        'producer-argument-not-address-shaped',
      ]);
      // The refusal names the slot that failed, not an arbitrary one.
      expect(selection.refusals[0]).toMatchObject({ argIndex: 1 });
    });

    it('never publishes the EXCHANGE as an address when the routing key is a variable', () => {
      // The reproduction, in the three spellings it was reproduced in. Each of
      // these is an ordinary Spring AMQP call whose routing key happens to be a
      // variable; the last two even fold to a real exchange name, so the graph
      // got a plausible-looking wrong address that can join a
      // @RabbitListener(queues = "orders").
      for (const exchange of ['"orders.exchange"', 'Exchanges.ORDERS', 'ORDERS_EXCHANGE']) {
        const selection = selectProducerDestinationArguments({
          template: 'rabbit',
          methodName: 'convertAndSend',
          args: args(exchange, 'routingKey', 'event'),
        });
        expect(selection.candidates).toEqual([]);
        expect(selection.refusals.map((r) => r.reason)).toEqual([
          'producer-argument-not-address-shaped',
        ]);
      }
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

    it('gates four arguments exactly like three', () => {
      // Arity does not fix the overload here either:
      // `(routingKey, message, postProcessor, correlationData)` also reaches
      // four, so the permissive gate that used to apply at this arity let a
      // payload through as an address.
      const permissiveOnly = selectProducerDestinationArguments({
        template: 'rabbit',
        methodName: 'convertAndSend',
        args: args('"orders.exchange"', 'routingKey', 'payload', 'postProcessor'),
      });
      expect(permissiveOnly.candidates).toEqual([]);
      expect(permissiveOnly.refusals.map((r) => r.reason)).toEqual([
        'producer-argument-not-address-shaped',
      ]);

      const confident = selectProducerDestinationArguments({
        template: 'rabbit',
        methodName: 'convertAndSend',
        args: args('"orders.exchange"', 'ORDERS_ROUTING_KEY', 'payload', 'postProcessor'),
      });
      expect(confident.candidates[0]).toMatchObject({
        argIndex: 1,
        rawText: 'ORDERS_ROUTING_KEY',
        exchange: 'orders.exchange',
      });

      // ...and the ambiguity rule reaches four arguments too, because
      // `(routingKey, message, postProcessor, correlationData)` also has four.
      const ambiguous = selectProducerDestinationArguments({
        template: 'rabbit',
        methodName: 'convertAndSend',
        args: args('"orders.exchange"', '"body"', 'payload', 'postProcessor'),
      });
      expect(ambiguous.candidates).toEqual([]);
      expect(ambiguous.refusals.map((r) => r.reason)).toEqual(['ambiguous-producer-overload']);
    });

    it('applies the same rule to the five-argument overload', () => {
      const selection = selectProducerDestinationArguments({
        template: 'rabbit',
        methodName: 'convertAndSend',
        args: args('"x"', '"orders.created"', 'payload', 'postProcessor', 'correlation'),
      });
      expect(selection.candidates[0]).toMatchObject({ argIndex: 1, exchange: 'x' });
    });

    it('reads two arguments as routingKey + message only on confident evidence', () => {
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

    it('REFUSES the one ambiguity it cannot settle, rather than choosing', () => {
      // `convertAndSend("orders.rk", "body", correlationData)` fits two real
      // overloads that disagree about which slot is the address:
      //
      //   (exchange, routingKey, message)        → the address is `"body"`
      //   (routingKey, message, correlationData) → the address is `"orders.rk"`
      //
      // Both are spelled (String, String, ref). This used to take the exchange
      // reading, which made the String PAYLOAD the address — and a
      // `@RabbitListener(queues = "body")` anywhere in the repository then
      // joined a publisher that has never written to it. A refusal is counted
      // and recoverable; that edge enters a report as a fact.
      const selection = selectProducerDestinationArguments({
        template: 'rabbit',
        methodName: 'convertAndSend',
        args: args('"orders.rk"', '"body"', 'correlationData'),
      });
      expect(selection.candidates).toEqual([]);
      expect(selection.refusals.map((r) => r.reason)).toEqual(['ambiguous-producer-overload']);
      // The refusal names the slot that could not be read, not an arbitrary one.
      expect(selection.refusals[0]).toMatchObject({ argIndex: 1, rawText: '"body"' });
    });

    // ── The refusal must not eat the cases that ARE decidable ──────────────
    //
    // The recurring way a suppression goes wrong here is by taking correct
    // results down with the wrong one, and the loss is silent: a destination
    // that stops being emitted looks exactly like a repository that never had
    // one. Each case below is a reading the syntax really does settle.

    it('still resolves a CONSTANT routing key at the ambiguous arities', () => {
      // The spelling is the evidence — the same premise `isConfidentAddressShape`
      // is built on. `ORDERS_ROUTING_KEY` and `Topics.ORDERS_KEY` are how a
      // configured NAME is written; a payload computed at the call site is not.
      for (const key of ['ORDERS_ROUTING_KEY', 'Topics.ORDERS_KEY']) {
        for (const trailing of [['payload'], ['payload', 'postProcessor']]) {
          const selection = selectProducerDestinationArguments({
            template: 'rabbit',
            methodName: 'convertAndSend',
            args: args('"orders.exchange"', key, ...trailing),
          });
          expect(selection.refusals).toEqual([]);
          expect(selection.candidates[0]).toMatchObject({
            argIndex: 1,
            rawText: key,
            exchange: 'orders.exchange',
          });
        }
      }
    });

    it('still resolves a string-literal routing key at FIVE arguments', () => {
      // `(exchange, routingKey, message, postProcessor, correlationData)` is
      // the only five-argument overload there is, so nothing competes for slot
      // 1 and the literal is not ambiguous. A refusal written on the shape of
      // the argument alone, without the arity, would have cut this.
      const selection = selectProducerDestinationArguments({
        template: 'rabbit',
        methodName: 'convertAndSend',
        args: args('"x"', '"orders.created"', 'payload', 'postProcessor', 'correlation'),
      });
      expect(selection.refusals).toEqual([]);
      expect(selection.candidates[0]).toMatchObject({
        argIndex: 1,
        rawText: '"orders.created"',
        exchange: 'x',
      });
    });

    it('still resolves a string-literal routing key at TWO arguments', () => {
      // `(routingKey, message)` competes only with `(message, postProcessor)`
      // and `(message, correlationData)`, and slot 0 is the routing key in the
      // only one of the three that carries an address at all.
      const selection = selectProducerDestinationArguments({
        template: 'rabbit',
        methodName: 'convertAndSend',
        args: args('"orders.created"', 'payload'),
      });
      expect(selection.refusals).toEqual([]);
      expect(selection.candidates[0]).toMatchObject({ argIndex: 0 });
    });

    it('still resolves a string-literal routing key passed BY NAME', () => {
      // A name settles which slot is which outright, so the ambiguity the
      // refusal exists for does not arise. Refusing on the literal alone would
      // have thrown away the one form that states the answer explicitly.
      const selection = selectProducerDestinationArguments({
        template: 'rabbit',
        methodName: 'convertAndSend',
        args: [
          { text: '"orders.exchange"' },
          { name: 'routingKey', text: '"orders.created"' },
          { text: 'payload' },
        ],
      });
      expect(selection.refusals).toEqual([]);
      expect(selection.candidates[0]).toMatchObject({
        argName: 'routingKey',
        rawText: '"orders.created"',
      });
    });

    it('does not apply the ambiguity rule to the other templates', () => {
      // Only Rabbit has an overload family in which slot 1 can be either the
      // routing key or the message. Kafka, JMS and StreamBridge put the
      // destination first in every multi-argument overload they have, so a
      // literal in slot 1 there is simply the payload and says nothing.
      for (const template of ['kafka', 'jms', 'stream-bridge'] as const) {
        const selection = selectProducerDestinationArguments({
          template,
          methodName:
            template === 'kafka' || template === 'stream-bridge' ? 'send' : 'convertAndSend',
          args: args('"orders.v1"', '"body"', 'extra'),
        });
        expect(selection.refusals).toEqual([]);
        expect(selection.candidates[0]).toMatchObject({ argIndex: 0, rawText: '"orders.v1"' });
      }
    });
  });

  describe('named arguments', () => {
    it('selects by NAME, not by position', () => {
      // Kotlin argument lists need not be in parameter order.
      // `kafkaTemplate.send(data = "payload", topic = "orders")` selected
      // args[0] and published the PAYLOAD as the address.
      const selection = selectProducerDestinationArguments({
        template: 'kafka',
        methodName: 'send',
        args: [
          { name: 'data', text: '"payload"' },
          { name: 'topic', text: '"orders"' },
        ],
      });
      expect(selection.candidates).toHaveLength(1);
      expect(selection.candidates[0]).toMatchObject({
        argIndex: 1,
        argName: 'topic',
        rawText: '"orders"',
      });
    });

    it('reads a rabbit exchange passed by name as provenance, not as the address', () => {
      const selection = selectProducerDestinationArguments({
        template: 'rabbit',
        methodName: 'convertAndSend',
        args: [
          { name: 'message', text: 'payload' },
          { name: 'exchange', text: '"orders.exchange"' },
          { name: 'routingKey', text: '"orders.created"' },
        ],
      });
      expect(selection.candidates[0]).toMatchObject({
        rawText: '"orders.created"',
        exchange: 'orders.exchange',
      });
    });

    it('knows the destination parameter of the other templates', () => {
      expect(
        selectProducerDestinationArguments({
          template: 'jms',
          methodName: 'convertAndSend',
          args: [
            { name: 'message', text: 'payload' },
            { name: 'destinationName', text: '"orders.jms"' },
          ],
        }).candidates[0],
      ).toMatchObject({ rawText: '"orders.jms"' });
      expect(
        selectProducerDestinationArguments({
          template: 'stream-bridge',
          methodName: 'send',
          args: [
            { name: 'data', text: 'payload' },
            { name: 'bindingName', text: '"orders-out-0"' },
          ],
        }).candidates[0],
      ).toMatchObject({ rawText: '"orders-out-0"' });
    });

    it('still reads a partially named list that puts the destination first', () => {
      // `send("orders", data = payload)` is legal — positional arguments
      // precede named ones — and slot 0 really is the topic. Refusing every
      // list that contains any name at all would have cost this.
      const selection = selectProducerDestinationArguments({
        template: 'kafka',
        methodName: 'send',
        args: [{ text: '"orders"' }, { name: 'data', text: 'payload' }],
      });
      expect(selection.candidates).toHaveLength(1);
      expect(selection.candidates[0]).toMatchObject({ argIndex: 0, rawText: '"orders"' });
    });

    it('refuses when the POSITIONAL slot is named after something else', () => {
      // The residual of the rule above: no name matched a destination
      // parameter, so the positional reading ran — and landed on an argument
      // whose own name contradicts it.
      const selection = selectProducerDestinationArguments({
        template: 'kafka',
        methodName: 'send',
        args: [
          { name: 'data', text: '"payload"' },
          { name: 'partition', text: '0' },
        ],
      });
      expect(selection.candidates).toEqual([]);
      expect(selection.refusals.map((r) => r.reason)).toEqual([
        'producer-named-argument-unrecognized',
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
    const [only] = selection.candidates;
    expect(
      resolveSpringDestination(only as SpringDestinationCandidate, { constant: () => null }),
    ).toEqual({ kind: 'unresolved', reason: 'unresolved-constant' });
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
    expect(resolveSpringDestination(candidate('topic'), { constant: () => null }).kind).toBe(
      'unresolved',
    );
  });
});
