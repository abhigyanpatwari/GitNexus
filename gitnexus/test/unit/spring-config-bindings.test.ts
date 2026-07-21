import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { bindSpringConfigConsumers } from '../../src/core/ingestion/frameworks/spring/config-bindings.js';
import {
  classifySpringConfigFile,
  parseSpringProperties,
  parseSpringYaml,
} from '../../src/core/ingestion/pipeline-phases/spring-config.js';
import { extractJavaSpringConfigConsumers } from '../../src/core/ingestion/languages/java/spring-config-bindings.js';

describe('Spring configuration parsing', () => {
  it('recognizes base and profile-specific application config files', () => {
    const base = classifySpringConfigFile('src/main/resources/application.properties');
    expect(base).toMatchObject({ format: 'properties' });
    expect(base).not.toHaveProperty('profile');
    expect(classifySpringConfigFile('src/main/resources/application-local.yml')).toMatchObject({
      format: 'yaml',
      profile: 'local',
    });
    expect(classifySpringConfigFile('src/main/resources/bootstrap.yml')).toBeNull();
  });

  it('extracts properties keys, continuations, and escaped separators without values', () => {
    const keys = parseSpringProperties(
      '# comment\nserver.port=8080\nservice\\:name: demo\nlong.\\\n  key = secret\n',
      'application.properties',
    );
    expect(keys.map((entry) => [entry.key, entry.line])).toEqual([
      ['server.port', 2],
      ['service:name', 3],
      ['long.key', 4],
    ]);
    expect(JSON.stringify(keys)).not.toContain('8080');
    expect(JSON.stringify(keys)).not.toContain('secret');
  });

  it('flattens YAML maps and arrays while retaining profile identity', () => {
    const keys = parseSpringYaml(
      'service:\n  endpoint: https://example.test\n  retries:\n    - delay: 10\n',
      'application-dev.yml',
      'dev',
    );
    expect(keys).toEqual([
      expect.objectContaining({
        key: 'service.endpoint',
        line: 2,
        profile: 'dev',
        format: 'yaml',
      }),
      expect.objectContaining({
        key: 'service.retries[0].delay',
        line: 4,
        profile: 'dev',
        format: 'yaml',
      }),
    ]);
    expect(JSON.stringify(keys)).not.toContain('example.test');
  });

  it('expands YAML merge keys and retains the declaration line for merged values', () => {
    const keys = parseSpringYaml(
      [
        'defaults: &defaults',
        '  endpoint: https://base.example.test',
        '  timeout: 30',
        'service:',
        '  <<: *defaults',
        '  endpoint: https://override.example.test',
      ].join('\n'),
      'application.yml',
    );

    expect(keys).toEqual([
      expect.objectContaining({ key: 'defaults.endpoint', line: 2 }),
      expect.objectContaining({ key: 'defaults.timeout', line: 3 }),
      expect.objectContaining({ key: 'service.endpoint', line: 6 }),
      expect.objectContaining({ key: 'service.timeout', line: 3 }),
    ]);
    expect(keys.some((entry) => entry.key.includes('<<'))).toBe(false);
  });

  it('terminates cyclic YAML aliases and bounds deeply nested expansion', () => {
    expect(
      parseSpringYaml('cycle: &cycle { self: *cycle }\nhealthy: true\n', 'application.yml'),
    ).toEqual([expect.objectContaining({ key: 'healthy', line: 2 })]);

    const aliasChain = ['level0: &level0 { leaf: true }'];
    for (let index = 1; index <= 130; index++) {
      aliasChain.push(`level${index}: &level${index} { next: *level${index - 1} }`);
    }
    expect(() => parseSpringYaml(aliasChain.join('\n'), 'application.yml')).toThrow(
      'Spring YAML traversal depth',
    );
  });
});

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
    expect(consumers).toEqual([
      expect.objectContaining({ kind: 'value', fieldName: 'timeout', keys: ['service.timeout'] }),
      expect.objectContaining({
        kind: 'configuration-properties',
        className: 'ServiceProperties',
        prefix: 'service',
      }),
    ]);

    expect(
      extractJavaSpringConfigConsumers(`
        @interface Value { String value(); }
        class Local { @Value("\${fake.key}") String field; }
      `),
    ).toEqual([]);
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

    expect(consumers).toEqual([
      expect.objectContaining({ kind: 'value', fieldName: 'first', keys: ['shared.key'] }),
      expect.objectContaining({ kind: 'value', fieldName: 'second', keys: ['shared.key'] }),
      expect.objectContaining({
        kind: 'configuration-properties',
        className: 'ServiceProperties',
        prefix: 'service',
      }),
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

    expect(consumers).toEqual([
      expect.objectContaining({ kind: 'value', keys: ['service.timeout'] }),
      expect.objectContaining({ kind: 'configuration-properties', prefix: 'service' }),
    ]);
  });
});

describe('Spring configuration graph binding', () => {
  it('indexes the graph once for all consumer files and skips empty work', () => {
    const graph = createKnowledgeGraph();
    const iterNodes = vi.spyOn(graph, 'iterNodes');

    bindSpringConfigConsumers(graph, []);
    expect(iterNodes).not.toHaveBeenCalled();

    bindSpringConfigConsumers(graph, [
      {
        filePath: 'First.java',
        consumers: [{ kind: 'value', fieldName: 'first', line: 1, keys: ['first.key'] }],
      },
      {
        filePath: 'Second.java',
        consumers: [{ kind: 'value', fieldName: 'second', line: 1, keys: ['second.key'] }],
      },
    ]);
    expect(iterNodes).toHaveBeenCalledTimes(1);
  });
});
