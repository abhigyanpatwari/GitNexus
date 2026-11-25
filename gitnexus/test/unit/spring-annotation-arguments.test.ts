import { describe, expect, it } from 'vitest';
import {
  normalizeSpringBeanType,
  parseSpringAnnotationArguments,
  parseStaticStringLiteral,
  parseStaticStringValues,
} from '../../src/core/ingestion/frameworks/spring/annotation-arguments.js';
import {
  decodeSpringBeanFactoryReason,
  encodeSpringBeanFactoryReason,
} from '../../src/core/ingestion/frameworks/spring/bean-factories.js';
import { springResourceDefaultName } from '../../src/core/ingestion/frameworks/spring/resource-injection.js';
import { springAnnotationHttpMethods } from '../../src/core/ingestion/route-extractors/spring-shared.js';

describe('Spring annotation static arguments', () => {
  it('tolerates a trailing comma in the top-level argument list', () => {
    expect(parseSpringAnnotationArguments('@RequestMapping("/api",)')).toEqual([
      { value: '"/api"' },
    ]);
    expect(parseSpringAnnotationArguments('@RequestMapping(path = "/api",)')).toEqual([
      { name: 'path', value: '"/api"' },
    ]);
    expect(springAnnotationHttpMethods('RequestMapping', '@RequestMapping("/api",)')).toEqual([
      '*',
    ]);
    expect(parseSpringAnnotationArguments('@RequestMapping("/api",,)')).toEqual([
      { value: '"/api"' },
    ]);
    expect(parseSpringAnnotationArguments('@RequestMapping("/api", , method = GET)')).toBeNull();
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

  it('parses static Kotlin raw strings and rejects raw string templates', () => {
    expect(parseStaticStringLiteral('"""within(com.example.service.KotlinOrderService)"""')).toBe(
      'within(com.example.service.KotlinOrderService)',
    );
    expect(parseStaticStringValues('["one", """two, three"""]')).toEqual(['one', 'two, three']);

    expect(parseStaticStringLiteral('"""bean-$name"""')).toBeNull();
    expect(parseStaticStringLiteral('"""bean-${expression}"""')).toBeNull();
    expect(parseStaticStringValues('["""static""", """$name"""]')).toBeNull();
  });

  it('keeps commas, assignments, and ordinary quotes inside Kotlin raw arguments', () => {
    expect(
      parseSpringAnnotationArguments(
        '@AfterReturning(pointcut = """execution(* com.example.Service.run(*,*)) && args("quoted=value")""", returning = "result")',
      ),
    ).toEqual([
      {
        name: 'pointcut',
        value: '"""execution(* com.example.Service.run(*,*)) && args("quoted=value")"""',
      },
      { name: 'returning', value: '"result"' },
    ]);
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
});
