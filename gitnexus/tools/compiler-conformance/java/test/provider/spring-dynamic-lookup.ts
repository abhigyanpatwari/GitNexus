import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getJavaParser } from '../../../../../src/core/ingestion/languages/java/query.js';
import { captureJavaSpringDynamicLookupFacts } from '../../../../../src/core/ingestion/languages/java/spring-dynamic-lookup.js';

function javaFacts(source: string) {
  return captureJavaSpringDynamicLookupFacts(
    getJavaParser().parse(source).rootNode,
    'src/Example.java',
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

    assert.deepEqual(
      facts.map(({ receiverName, methodName, targetTypeName }) => ({
        receiverName,
        methodName,
        targetTypeName,
      })),
      [
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
      ],
    );
  });

  it('assigns adjacent one-line calls only to their actual callable', () => {
    const facts = javaFacts(`class Example {
      void hit(){ ctx.getBeans(Port.class); }
      void miss(){}
    }`);

    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.ownerRange.startLine, 2);
    assert.equal(facts[0]?.ownerRange.endLine, 2);
  });

  it('assigns an anonymous-class lookup only to the nested method', () => {
    const facts = javaFacts(`class Example {
      void outer() {
        Runnable task = new Runnable() {
          public void run() { ctx.getBeans(Port.class); }
        };
      }
    }`);

    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.ownerRange.startLine, 4);
    assert.equal(facts[0]?.ownerRange.endLine, 4);
  });

  it('captures constructor lookups using normal callable semantics', () => {
    const facts = javaFacts(`class Example {
      Example() { beanFactory.getBean(Concrete.class); }
    }`);

    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.methodName, 'getBean');
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

    assert.deepEqual(facts, []);
  });
});
