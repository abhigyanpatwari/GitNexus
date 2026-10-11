import { describe, expect, it } from 'vitest';
import { emitKotlinScopeCaptures } from '../../src/core/ingestion/languages/kotlin/captures.js';

function captureTexts(source: string): Array<Record<string, string>> {
  return emitKotlinScopeCaptures(source, 'fixture.kt').map((match) =>
    Object.fromEntries(Object.entries(match).map(([tag, capture]) => [tag, capture.text])),
  );
}

describe('Kotlin scope captures', () => {
  it('uses an explicit function type to constrain a free callable reference', () => {
    const captures = captureTexts('fun use() { val callback: () -> String = ::encode }');
    const reference = captures.find((match) => match['@reference.call.free'] === '::encode');
    expect(reference?.['@reference.arity']).toBe('0');
  });

  it('does not treat the receiver parameter of an unbound reference as method arity', () => {
    const captures = captureTexts('fun use() { val callback: (Worker) -> Unit = Worker::run }');
    const reference = captures.find((match) => match['@reference.call.member'] === 'Worker::run');
    expect(reference).toBeDefined();
    expect(reference?.['@reference.arity']).toBeUndefined();
  });

  it('does not infer a free callable arity from an extension function type', () => {
    const captures = captureTexts('fun use() { val callback: Worker.() -> Unit = ::run }');
    const reference = captures.find((match) => match['@reference.call.free'] === '::run');
    expect(reference).toBeDefined();
    expect(reference?.['@reference.arity']).toBeUndefined();
  });

  it('reads assignment receiver prefixes and writes only the terminal property', () => {
    const captures = captureTexts(
      'fun update(session: Session, badge: String) { session.account.profile.badge = badge }',
    );
    const members = captures.filter(
      (match) =>
        match['@reference.read.member'] !== undefined ||
        match['@reference.write.member'] !== undefined,
    );
    expect(
      members.map((match) => ({
        kind: match['@reference.write.member'] === undefined ? 'read' : 'write',
        name: match['@reference.name'],
        receiver: match['@reference.receiver'],
      })),
    ).toEqual([
      { kind: 'read', name: 'account', receiver: 'session' },
      { kind: 'read', name: 'profile', receiver: 'session.account' },
      { kind: 'write', name: 'badge', receiver: 'session.account.profile' },
    ]);
  });

  it('emits required arity equal to total arity when no parameters have defaults', () => {
    const captures = captureTexts(`
      fun greet(name: String, greeting: String) {}
    `);
    const declaration = captures.find((match) => match['@declaration.function'] !== undefined);

    expect(declaration?.['@declaration.parameter-count']).toBe('2');
    expect(declaration?.['@declaration.required-parameter-count']).toBe('2');
  });

  it('emits required arity excluding default parameters', () => {
    const captures = captureTexts(`
      fun greet(name: String, greeting: String = "Hello", punctuation: String = "!") {}
    `);
    const declaration = captures.find((match) => match['@declaration.function'] !== undefined);

    expect(declaration?.['@declaration.parameter-count']).toBe('3');
    expect(declaration?.['@declaration.required-parameter-count']).toBe('1');
  });

  it('counts trailing lambda call suffixes as call arguments', () => {
    const captures = captureTexts(`
      fun run(items: List<String>) {
        items.forEach { println(it) }
      }
    `);

    const forEach = captures.find(
      (match) =>
        match['@reference.call.member'] === 'items.forEach { println(it) }' &&
        match['@reference.name'] === 'forEach',
    );

    expect(forEach?.['@reference.arity']).toBe('1');
  });

  it('does not synthesize extension free-call fallback for chained regular member calls', () => {
    const captures = captureTexts(`
      class Service {
        fun current(): Service = this
        fun save() {}
      }

      fun run(service: Service) {
        service.current().save()
      }
    `);

    const syntheticSaveFreeCalls = captures.filter(
      (match) =>
        match['@reference.call.free'] === 'service.current().save()' &&
        match['@reference.name'] === 'save',
    );

    expect(syntheticSaveFreeCalls).toHaveLength(0);
  });

  it('keeps literal-receiver extension fallback for extension-call candidates', () => {
    const captures = captureTexts(`
      fun String.slug(): String = this

      fun run() {
        "hello".slug()
      }
    `);

    const slugFreeCall = captures.find(
      (match) =>
        match['@reference.call.free'] === '"hello".slug()' && match['@reference.name'] === 'slug',
    );

    expect(slugFreeCall).toBeDefined();
  });

  it('does not emit a self type binding keyed by the extension function name', () => {
    const captures = captureTexts(`
      fun String.slug(): String = this
    `);

    const spuriousSelfBinding = captures.find(
      (match) =>
        match['@type-binding.self'] !== undefined &&
        match['@type-binding.name'] === 'slug' &&
        match['@type-binding.type'] === 'String',
    );

    expect(spuriousSelfBinding).toBeUndefined();
  });
});
