import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseSpringAnnotationArguments,
  parseStaticClassLiteral,
  parseStaticStringValues,
} from '../../../../../src/core/ingestion/frameworks/spring/annotation-arguments.js';
import { springBeanNames } from '../../../../../src/core/ingestion/frameworks/spring/bean-factories.js';
import { springResourceInjectionMatch } from '../../../../../src/core/ingestion/frameworks/spring/resource-injection.js';
import {
  intersectSpringHttpMethods,
  springAnnotationHttpMethods,
} from '../../../../../src/core/ingestion/route-extractors/spring-shared.js';

describe('Spring annotation static arguments', () => {
  it('parses Java and Kotlin named arrays without splitting nested values', () => {
    assert.deepEqual(
      parseSpringAnnotationArguments('@Bean(name = {"one", "two"}, value = ["three"])'),
      [
        { name: 'name', value: '{"one", "two"}' },
        { name: 'value', value: '["three"]' },
      ],
    );
    assert.deepEqual(parseStaticStringValues('["one", "two"]'), ['one', 'two']);
    assert.equal(parseStaticStringValues('NAMES'), null);
  });

  it('rejects Kotlin templates and accepts Java/Kotlin class literals', () => {
    assert.equal(parseStaticStringValues('"bean-${suffix}"'), null);
    assert.equal(parseStaticClassLiteral('Concrete.class'), 'Concrete');
    assert.equal(parseStaticClassLiteral('Concrete::class'), 'Concrete');
    assert.equal(parseStaticClassLiteral('Object.class'), '');
  });
});

describe('Spring request mapping methods', () => {
  it('resolves shortcut, wildcard, scalar, and array method declarations', () => {
    assert.deepEqual(springAnnotationHttpMethods('GetMapping', '@GetMapping("/x")'), ['GET']);
    assert.deepEqual(springAnnotationHttpMethods('RequestMapping', '@RequestMapping("/x")'), ['*']);
    assert.deepEqual(
      springAnnotationHttpMethods(
        'RequestMapping',
        '@RequestMapping(path = "/x", method = RequestMethod.POST)',
      ),
      ['POST'],
    );
    assert.deepEqual(
      springAnnotationHttpMethods(
        'RequestMapping',
        '@RequestMapping(path = "/x", method = {RequestMethod.GET, RequestMethod.HEAD})',
      ),
      ['GET', 'HEAD'],
    );
    assert.deepEqual(
      springAnnotationHttpMethods('RequestMapping', '@RequestMapping(path = "/x", method = {})'),
      ['*'],
    );
  });

  it('accepts a terminal array comma and intersects class/method constraints', () => {
    assert.deepEqual(
      springAnnotationHttpMethods(
        'RequestMapping',
        '@RequestMapping(method = {RequestMethod.GET, RequestMethod.HEAD,})',
      ),
      ['GET', 'HEAD'],
    );
    assert.deepEqual(intersectSpringHttpMethods(['GET'], ['*']), ['GET']);
    assert.deepEqual(intersectSpringHttpMethods(['*'], ['POST']), ['POST']);
    assert.deepEqual(intersectSpringHttpMethods(['GET', 'HEAD'], ['HEAD', 'POST']), ['HEAD']);
    assert.deepEqual(intersectSpringHttpMethods(['GET'], ['POST']), []);
  });

  it('accepts Java whitespace and comments around static RequestMethod values', () => {
    assert.deepEqual(
      springAnnotationHttpMethods(
        'RequestMapping',
        '@RequestMapping(path = "/x", method = RequestMethod . GET)',
      ),
      ['GET'],
    );
    assert.deepEqual(
      springAnnotationHttpMethods(
        'RequestMapping',
        `@RequestMapping(method = {
          RequestMethod.GET, // read
          /* write */ RequestMethod.POST,
        })`,
      ),
      ['GET', 'POST'],
    );
  });

  it('fails closed for runtime, malformed, and duplicate method members', () => {
    assert.deepEqual(
      springAnnotationHttpMethods('RequestMapping', '@RequestMapping(path = "/x", method = VERB)'),
      [],
    );
    assert.deepEqual(
      springAnnotationHttpMethods(
        'RequestMapping',
        '@RequestMapping(path = "/x", method = RequestMethod.GET, method = RequestMethod.POST)',
      ),
      [],
    );
    assert.deepEqual(
      springAnnotationHttpMethods(
        'RequestMapping',
        '@RequestMapping(path = "/x", method = RequestMethod./* unterminated)',
      ),
      [],
    );
  });
});

describe('Spring Bean factory metadata', () => {
  it('uses the method default and recognizes Java/Kotlin aliases', () => {
    assert.deepEqual(springBeanNames('@Bean', 'gateway'), {
      names: ['gateway'],
      namesKnown: true,
    });
    assert.deepEqual(springBeanNames('@Bean({"primary", "alias"})', 'gateway'), {
      names: ['primary', 'alias'],
      namesKnown: true,
    });
    assert.deepEqual(springBeanNames('@Bean(name = ["primary", "alias"])', 'gateway'), {
      names: ['primary', 'alias'],
      namesKnown: true,
    });
    assert.deepEqual(springBeanNames('@Bean(name = "")', 'gateway'), {
      names: ['gateway'],
      namesKnown: true,
    });
    assert.deepEqual(springBeanNames('@Bean(name = NAMES)', 'gateway'), {
      names: [],
      namesKnown: false,
    });
  });
});

describe('Spring Resource semantics', () => {
  it('keeps explicit names strict and default names type-fallback capable', () => {
    const explicit = springResourceInjectionMatch(
      '@Resource(name = "slowGateway")',
      'gateway',
      'Gateway',
      'gateway',
    );
    assert.partialDeepStrictEqual(explicit, {
      targetTypeName: 'Gateway',
      cardinality: 'single',
      namedSelection: { name: 'slowGateway' },
    });
    assert.ok(!Object.hasOwn(explicit?.namedSelection, 'fallbackToType'));
    assert.partialDeepStrictEqual(
      springResourceInjectionMatch('@Resource', 'gateway', 'Gateway', 'gateway'),
      {
        namedSelection: { name: 'gateway', fallbackToType: true },
      },
    );
  });

  it('does not type-fallback an implicit-name generic Resource site', () => {
    const generic = springResourceInjectionMatch(
      '@Resource',
      'handlers',
      'List<Handler>',
      'handlers',
    );
    assert.partialDeepStrictEqual(generic, {
      targetTypeName: 'List',
      namedSelection: { name: 'handlers' },
    });
    assert.ok(!Object.hasOwn(generic?.namedSelection, 'fallbackToType'));
  });

  it('honors static type overrides and rejects runtime-only metadata', () => {
    assert.partialDeepStrictEqual(
      springResourceInjectionMatch('@Resource(type = Concrete::class)', 'repo', 'Any', 'repo'),
      { targetTypeName: 'Concrete' },
    );
    assert.equal(
      springResourceInjectionMatch(
        '@Resource(lookup = "java:global/repo")',
        'repo',
        'Concrete',
        'repo',
      ),
      null,
    );
    assert.equal(
      springResourceInjectionMatch(
        '@Resource(mappedName = MAPPED_NAME)',
        'repo',
        'Concrete',
        'repo',
      ),
      null,
    );
  });
});
