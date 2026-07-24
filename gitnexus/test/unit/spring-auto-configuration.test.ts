import { describe, expect, it } from 'vitest';
import {
  classifySpringAutoConfigurationMetadata,
  parseSpringAutoConfigurationImports,
  parseSpringFactoriesAutoConfigurations,
} from '../../src/core/ingestion/pipeline-phases/spring-auto-configuration.js';

describe('Spring Boot auto-configuration metadata parsing', () => {
  it('classifies modern imports and legacy spring.factories paths', () => {
    expect(
      classifySpringAutoConfigurationMetadata(
        'src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports',
      ),
    ).toMatchObject({ kind: 'imports' });
    expect(
      classifySpringAutoConfigurationMetadata('src/main/resources/META-INF/spring.factories'),
    ).toMatchObject({ kind: 'spring-factories' });
    expect(classifySpringAutoConfigurationMetadata('application.properties')).toBeNull();
  });

  it('parses, validates, and de-duplicates AutoConfiguration.imports entries', () => {
    expect(
      parseSpringAutoConfigurationImports(`
# comment
com.example.FirstAutoConfiguration
com.example.SecondAutoConfiguration # trailing comment
not a class
com.example.FirstAutoConfiguration
`),
    ).toEqual([
      { className: 'com.example.FirstAutoConfiguration', line: 3 },
      { className: 'com.example.SecondAutoConfiguration', line: 4 },
    ]);
  });

  it('parses only EnableAutoConfiguration with properties continuations', () => {
    expect(
      parseSpringFactoriesAutoConfigurations(`
org.example.OtherFactory=com.example.Ignored
org.springframework.boot.autoconfigure.EnableAutoConfiguration=\\
  com.example.LegacyOne,\\
  com.example.LegacyTwo
`),
    ).toEqual([
      { className: 'com.example.LegacyOne', line: 3 },
      { className: 'com.example.LegacyTwo', line: 3 },
    ]);
  });
});
