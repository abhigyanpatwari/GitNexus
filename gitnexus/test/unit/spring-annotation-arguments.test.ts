import { describe, expect, it } from 'vitest';
import {
  normalizeSpringBeanType,
  parseSpringAnnotationArguments,
  parseStaticClassLiteral,
  parseStaticStringValues,
} from '../../src/core/ingestion/frameworks/spring/annotation-arguments.js';
import {
  decodeSpringBeanFactoryReason,
  encodeSpringBeanFactoryReason,
  springBeanNames,
} from '../../src/core/ingestion/frameworks/spring/bean-factories.js';
import {
  springResourceDefaultName,
  springResourceInjectionMatch,
} from '../../src/core/ingestion/frameworks/spring/resource-injection.js';

describe('Spring annotation static arguments', () => {
  it('parses Java and Kotlin named arrays without splitting nested values', () => {
    expect(
      parseSpringAnnotationArguments('@Bean(name = {"one", "two"}, value = ["three"])'),
    ).toEqual([
      { name: 'name', value: '{"one", "two"}' },
      { name: 'value', value: '["three"]' },
    ]);
    expect(parseStaticStringValues('["one", "two"]')).toEqual(['one', 'two']);
    expect(parseStaticStringValues('NAMES')).toBeNull();
  });

  it('keeps generic call expressions intact while splitting top-level arguments', () => {
    expect(
      parseSpringAnnotationArguments(
        '@Bean(factory = helper<Map<String, Int>>(left, right), name = ["one", "two"])',
      ),
    ).toEqual([
      { name: 'factory', value: 'helper<Map<String, Int>>(left, right)' },
      { name: 'name', value: '["one", "two"]' },
    ]);
  });

  it('rejects Kotlin templates and accepts Java/Kotlin class literals', () => {
    expect(parseStaticStringValues('"bean-${suffix}"')).toBeNull();
    expect(parseStaticClassLiteral('Concrete.class')).toBe('Concrete');
    expect(parseStaticClassLiteral('Concrete::class')).toBe('Concrete');
    expect(parseStaticClassLiteral('Object.class')).toBe('');
  });

  it('normalizes Kotlin nullability, mutable collections, projections, and bean generics', () => {
    expect(normalizeSpringBeanType('MutableList<out Gateway?>?')).toBe('List');
    expect(normalizeSpringBeanType('com.example.Gateway')).toBe('com.example.Gateway');
    expect(normalizeSpringBeanType('outputStream')).toBe('outputStream');
    expect(normalizeSpringBeanType('inside.Type')).toBe('inside.Type');
    expect(normalizeSpringBeanType('Unit')).toBeNull();
  });
});

describe('Spring Bean factory metadata', () => {
  it('uses the method default and recognizes Java/Kotlin aliases', () => {
    expect(springBeanNames('@Bean', 'gateway')).toEqual({
      names: ['gateway'],
      namesKnown: true,
    });
    expect(springBeanNames('@Bean({"primary", "alias"})', 'gateway')).toEqual({
      names: ['primary', 'alias'],
      namesKnown: true,
    });
    expect(springBeanNames('@Bean(name = ["primary", "alias"])', 'gateway')).toEqual({
      names: ['primary', 'alias'],
      namesKnown: true,
    });
    expect(springBeanNames('@Bean(name = "")', 'gateway')).toEqual({
      names: ['gateway'],
      namesKnown: true,
    });
    expect(springBeanNames('@Bean(name = NAMES)', 'gateway')).toEqual({
      names: [],
      namesKnown: false,
    });
  });

  it('round-trips the persisted DECLARES reason', () => {
    const reason = encodeSpringBeanFactoryReason({
      names: ['gateway', 'alias'],
      namesKnown: true,
      providedType: 'Gateway',
    });
    expect(decodeSpringBeanFactoryReason(reason)).toEqual({
      framework: 'spring',
      role: 'factory-method',
      annotation: 'org.springframework.context.annotation.Bean',
      names: ['gateway', 'alias'],
      providedType: 'Gateway',
    });
  });
});

describe('Spring Resource semantics', () => {
  it('derives field/property and JavaBeans setter names', () => {
    expect(springResourceDefaultName('field', 'gateway', 1)).toBe('gateway');
    expect(springResourceDefaultName('method', 'setGateway', 1)).toBe('gateway');
    expect(springResourceDefaultName('method', 'setURL', 1)).toBe('URL');
    expect(springResourceDefaultName('method', 'configure', 1)).toBeNull();
    expect(springResourceDefaultName('method', 'setGateway', 2)).toBeNull();
  });

  it('keeps explicit names strict and default names type-fallback capable', () => {
    const explicit = springResourceInjectionMatch(
      '@Resource(name = "slowGateway")',
      'gateway',
      'Gateway',
      'gateway',
    );
    expect(explicit).toMatchObject({
      targetTypeName: 'Gateway',
      cardinality: 'single',
      namedSelection: { name: 'slowGateway' },
    });
    expect(explicit?.namedSelection).not.toHaveProperty('fallbackToType');
    expect(
      springResourceInjectionMatch('@Resource', 'gateway', 'Gateway', 'gateway'),
    ).toMatchObject({
      namedSelection: { name: 'gateway', fallbackToType: true },
    });
  });

  it('honors static type overrides and rejects runtime-only metadata', () => {
    expect(
      springResourceInjectionMatch('@Resource(type = Concrete::class)', 'repo', 'Any', 'repo'),
    ).toMatchObject({ targetTypeName: 'Concrete' });
    expect(
      springResourceInjectionMatch(
        '@Resource(lookup = "java:global/repo")',
        'repo',
        'Concrete',
        'repo',
      ),
    ).toBeNull();
    expect(
      springResourceInjectionMatch(
        '@Resource(mappedName = MAPPED_NAME)',
        'repo',
        'Concrete',
        'repo',
      ),
    ).toBeNull();
  });
});
