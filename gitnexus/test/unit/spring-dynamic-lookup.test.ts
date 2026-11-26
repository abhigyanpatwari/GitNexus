import { describe, expect, it } from 'vitest';
import { getKotlinParser } from '../../src/core/ingestion/languages/kotlin/query.js';
import { captureKotlinSpringDynamicLookupFacts } from '../../src/core/ingestion/languages/kotlin/spring-dynamic-lookup.js';

function kotlinFacts(source: string) {
  return captureKotlinSpringDynamicLookupFacts(
    getKotlinParser().parse(source).rootNode,
    'src/Example.kt',
  );
}

describe('Kotlin Spring dynamic lookup capture', () => {
  it('captures Kotlin class literals with and without the Java bridge', () => {
    const facts = kotlinFacts(`class Example {
      fun load() {
        SpringContextUtil.getBeans(Port::class.java)
        applicationContext.getBeansOfType(com.example.Service::class.java)
        ctx.getBean(Concrete::class)
      }
    }`);

    expect(
      facts.map(({ receiverName, methodName, targetTypeName }) => ({
        receiverName,
        methodName,
        targetTypeName,
      })),
    ).toEqual([
      {
        receiverName: 'SpringContextUtil',
        methodName: 'getBeans',
        targetTypeName: 'Port',
      },
      {
        receiverName: 'applicationContext',
        methodName: 'getBeansOfType',
        targetTypeName: 'com.example.Service',
      },
      { receiverName: 'ctx', methodName: 'getBean', targetTypeName: 'Concrete' },
    ]);
  });

  it('assigns an object-expression lookup only to the nested method', () => {
    const facts = kotlinFacts(`class Example {
      fun outer() {
        val task = object : Runnable {
          override fun run() { ctx.getBeans(Port::class.java) }
        }
      }
    }`);

    expect(facts).toHaveLength(1);
    expect(facts[0]?.ownerRange.startLine).toBe(4);
    expect(facts[0]?.ownerRange.endLine).toBe(4);
  });

  it('captures secondary-constructor lookups and excludes init blocks without graph callables', () => {
    const facts = kotlinFacts(`class Example {
      init { ctx.getBeans(Ignored::class.java) }
      constructor(marker: String) { ctx.getBean(Concrete::class.java) }
    }`);

    expect(facts).toHaveLength(1);
    expect(facts[0]?.targetTypeName).toBe('Concrete');
  });

  it('ignores comments, KDoc, strings, raw strings, and unsupported calls', () => {
    const facts = kotlinFacts(`class Example {
      /**
       * ctx.getBeans(Port::class.java)
       */
      fun load() {
        // ctx.getBeans(Port::class.java)
        /* applicationContext.getBeansOfType(Port::class.java) */
        val normal = "ctx.getBean(Port::class.java)"
        val raw = ${'"""'}ctx.getBeans(Port::class.java)${'"""'}
        unrelated.getBeans(Port::class.java)
        ctx.getBean("namedBean")
      }
    }`);

    expect(facts).toEqual([]);
  });
});
