import { describe, expect, it } from 'vitest';
import { getJavaParser } from '../../src/core/ingestion/languages/java/query.js';
import { captureJavaSpringDynamicLookupFacts } from '../../src/core/ingestion/languages/java/spring-dynamic-lookup.js';
import { getKotlinParser } from '../../src/core/ingestion/languages/kotlin/query.js';
import { captureKotlinSpringDynamicLookupFacts } from '../../src/core/ingestion/languages/kotlin/spring-dynamic-lookup.js';

function javaFacts(source: string) {
  return captureJavaSpringDynamicLookupFacts(
    getJavaParser().parse(source).rootNode,
    'src/Example.java',
  );
}

function kotlinFacts(source: string) {
  return captureKotlinSpringDynamicLookupFacts(
    getKotlinParser().parse(source).rootNode,
    'src/Example.kt',
  );
}

describe('Java Spring dynamic lookup capture', () => {
  it('captures collection and singular class-literal calls from known receivers', () => {
    const facts = javaFacts(`class Example {
      void load() {
        SpringContextUtil.getBeans(Port.class);
        ApplicationContext.getBeansOfType(com.example.Service.class);
        ctx.getBean(Concrete.class);
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
        receiverName: 'ApplicationContext',
        methodName: 'getBeansOfType',
        targetTypeName: 'com.example.Service',
      },
      { receiverName: 'ctx', methodName: 'getBean', targetTypeName: 'Concrete' },
    ]);
  });

  it('assigns adjacent one-line calls only to their actual callable', () => {
    const facts = javaFacts(`class Example {
      void hit(){ ctx.getBeans(Port.class); }
      void miss(){}
    }`);

    expect(facts).toHaveLength(1);
    expect(facts[0]?.ownerRange.startLine).toBe(2);
    expect(facts[0]?.ownerRange.endLine).toBe(2);
  });

  it('assigns an anonymous-class lookup only to the nested method', () => {
    const facts = javaFacts(`class Example {
      void outer() {
        Runnable task = new Runnable() {
          public void run() { ctx.getBeans(Port.class); }
        };
      }
    }`);

    expect(facts).toHaveLength(1);
    expect(facts[0]?.ownerRange.startLine).toBe(4);
    expect(facts[0]?.ownerRange.endLine).toBe(4);
  });

  it('captures constructor lookups using normal callable semantics', () => {
    const facts = javaFacts(`class Example {
      Example() { beanFactory.getBean(Concrete.class); }
    }`);

    expect(facts).toHaveLength(1);
    expect(facts[0]?.methodName).toBe('getBean');
  });

  it('ignores comments, Javadoc, strings, text blocks, and unsupported calls', () => {
    const facts = javaFacts(`class Example {
      /**
       * ctx.getBeans(Port.class)
       */
      void load() {
        // ctx.getBeans(Port.class);
        /* applicationContext.getBeansOfType(Port.class); */
        String normal = "ctx.getBean(Port.class)";
        String block = """
          ctx.getBeans(Port.class)
          """;
        unrelated.getBeans(Port.class);
        ctx.getBean("namedBean");
      }
    }`);

    expect(facts).toEqual([]);
  });
});

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
