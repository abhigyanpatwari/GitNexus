import { describe, expect, it } from 'vitest';
import { emitKotlinScopeCaptures } from '../../src/core/ingestion/languages/kotlin/captures.js';

function captureTexts(source: string): Array<Record<string, string>> {
  return emitKotlinScopeCaptures(source, 'fixture.kt').map((match) =>
    Object.fromEntries(Object.entries(match).map(([tag, capture]) => [tag, capture.text])),
  );
}

describe('Kotlin scope captures', () => {
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
