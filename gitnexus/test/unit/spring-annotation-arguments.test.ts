import { describe, expect, it } from 'vitest';
import {
  normalizeSpringBeanType,
  parseSpringAnnotationArguments,
  parseStaticClassLiteral,
  parseStaticStringLiteral,
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
import {
  intersectSpringHttpMethods,
  springAnnotationHttpMethods,
} from '../../src/core/ingestion/route-extractors/spring-shared.js';

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

  it('rejects Kotlin templates and accepts Java/Kotlin class literals', () => {
    expect(parseStaticStringValues('"bean-${suffix}"')).toBeNull();
    expect(parseStaticClassLiteral('Concrete.class')).toBe('Concrete');
    expect(parseStaticClassLiteral('Concrete::class')).toBe('Concrete');
    expect(parseStaticClassLiteral('Object.class')).toBe('');
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

describe('Spring request mapping methods', () => {
  it('resolves shortcut, wildcard, scalar, and array method declarations', () => {
    expect(springAnnotationHttpMethods('GetMapping', '@GetMapping("/x")')).toEqual(['GET']);
    expect(springAnnotationHttpMethods('RequestMapping', '@RequestMapping("/x")')).toEqual(['*']);
    expect(
      springAnnotationHttpMethods(
        'RequestMapping',
        '@RequestMapping(path = "/x", method = RequestMethod.POST)',
      ),
    ).toEqual(['POST']);
    expect(
      springAnnotationHttpMethods(
        'RequestMapping',
        '@RequestMapping(path = "/x", method = {RequestMethod.GET, RequestMethod.HEAD})',
      ),
    ).toEqual(['GET', 'HEAD']);
    expect(
      springAnnotationHttpMethods('RequestMapping', '@RequestMapping(path = "/x", method = {})'),
    ).toEqual(['*']);
  });

  it('accepts a terminal array comma and intersects class/method constraints', () => {
    expect(
      springAnnotationHttpMethods(
        'RequestMapping',
        '@RequestMapping(method = {RequestMethod.GET, RequestMethod.HEAD,})',
      ),
    ).toEqual(['GET', 'HEAD']);
    expect(intersectSpringHttpMethods(['GET'], ['*'])).toEqual(['GET']);
    expect(intersectSpringHttpMethods(['*'], ['POST'])).toEqual(['POST']);
    expect(intersectSpringHttpMethods(['GET', 'HEAD'], ['HEAD', 'POST'])).toEqual(['HEAD']);
    expect(intersectSpringHttpMethods(['GET'], ['POST'])).toEqual([]);
  });

  it('accepts Java whitespace and comments around static RequestMethod values', () => {
    expect(
      springAnnotationHttpMethods(
        'RequestMapping',
        '@RequestMapping(path = "/x", method = RequestMethod . GET)',
      ),
    ).toEqual(['GET']);
    expect(
      springAnnotationHttpMethods(
        'RequestMapping',
        `@RequestMapping(method = {
          RequestMethod.GET, // read
          /* write */ RequestMethod.POST,
        })`,
      ),
    ).toEqual(['GET', 'POST']);
  });

  it('fails closed for runtime, malformed, and duplicate method members', () => {
    expect(
      springAnnotationHttpMethods('RequestMapping', '@RequestMapping(path = "/x", method = VERB)'),
    ).toEqual([]);
    expect(
      springAnnotationHttpMethods(
        'RequestMapping',
        '@RequestMapping(path = "/x", method = RequestMethod.GET, method = RequestMethod.POST)',
      ),
    ).toEqual([]);
    expect(
      springAnnotationHttpMethods(
        'RequestMapping',
        '@RequestMapping(path = "/x", method = RequestMethod./* unterminated)',
      ),
    ).toEqual([]);
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

  it('does not type-fallback an implicit-name generic Resource site', () => {
    const generic = springResourceInjectionMatch(
      '@Resource',
      'handlers',
      'List<Handler>',
      'handlers',
    );
    expect(generic).toMatchObject({
      targetTypeName: 'List',
      namedSelection: { name: 'handlers' },
    });
    expect(generic?.namedSelection).not.toHaveProperty('fallbackToType');
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
