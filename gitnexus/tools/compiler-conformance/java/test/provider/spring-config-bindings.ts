import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractJavaSpringConfigConsumers } from '../../../../../src/core/ingestion/languages/java/spring-config-bindings.js';

describe('Java Spring configuration consumers', () => {
  it('resolves official imports and ignores shadowed annotation names', () => {
    const consumers = extractJavaSpringConfigConsumers(`
      import org.springframework.beans.factory.annotation.Value;
      import org.springframework.boot.context.properties.ConfigurationProperties;

      @ConfigurationProperties(prefix = "service")
      class ServiceProperties {
        @Value("\${service.timeout:30}") private int timeout;
      }
    `);
    assert.equal(consumers.length, 2);
    assert.partialDeepStrictEqual(consumers, [
      { kind: 'value', fieldName: 'timeout', keys: ['service.timeout'] },
      {
        kind: 'configuration-properties',
        className: 'ServiceProperties',
        prefix: 'service',
      },
    ]);

    assert.deepEqual(
      extractJavaSpringConfigConsumers(`
        @interface Value { String value(); }
        class Local { @Value("\${fake.key}") String field; }
      `),
      [],
    );
  });

  it('supports wildcard/FQN annotations and every declarator in a field', () => {
    const consumers = extractJavaSpringConfigConsumers(`
      import org.springframework.beans.factory.annotation.*;

      class DirectValues {
        @Value("\${shared.key}") String first, second;
      }

      @org.springframework.boot.context.properties.ConfigurationProperties("service")
      record ServiceProperties(String endpoint) {}
    `);

    assert.equal(consumers.length, 3);
    assert.partialDeepStrictEqual(consumers, [
      { kind: 'value', fieldName: 'first', keys: ['shared.key'] },
      { kind: 'value', fieldName: 'second', keys: ['shared.key'] },
      {
        kind: 'configuration-properties',
        className: 'ServiceProperties',
        prefix: 'service',
      },
    ]);
  });

  it('reads only string-literal AST nodes and ignores placeholders inside comments', () => {
    const consumers = extractJavaSpringConfigConsumers(`
      import org.springframework.beans.factory.annotation.Value;
      import org.springframework.boot.context.properties.ConfigurationProperties;

      @ConfigurationProperties(
        // legacy prefix: "old.unsafe"
        value = "service"
      )
      class ServiceProperties {
        @Value(
          /* legacy: "\${old.unsafe.key}" */
          "\${service.timeout:30}"
        )
        private int timeout;
      }
    `);

    assert.equal(consumers.length, 2);
    assert.partialDeepStrictEqual(consumers, [
      { kind: 'value', keys: ['service.timeout'] },
      { kind: 'configuration-properties', prefix: 'service' },
    ]);
  });
});
