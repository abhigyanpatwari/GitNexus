import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compareReports } from '../compare.mjs';
import { gitNexusCallReport } from '../gitnexus-report.mjs';
import { javacReports, qualifiedJavacReport } from './javac-report.mjs';
import { compareJavaStructure, javaTypeIdentity } from './structure.mjs';
import { writeFixtureRepo } from './spring-support.mjs';

/** javac needs signatures for external annotations and the fixture's missing DTO.
 * Keep these compile-time inputs outside the project observed by GitNexus. */
const web = 'org.springframework.web.bind.annotation.';
const signatures = {
  [web + 'RestController']: '@interface RestController {}',
  [web + 'RequestMethod']: 'enum RequestMethod { GET, HEAD, POST }',
  [web + 'RequestMapping']:
    '@interface RequestMapping { String[] value() default {}; String[] path() default {}; RequestMethod[] method() default {}; }',
  ...Object.fromEntries(
    ['Get', 'Post', 'Put', 'Delete', 'Patch'].map((verb) => [
      web + verb + 'Mapping',
      `@interface ${verb}Mapping { String[] value() default {}; String[] path() default {}; }`,
    ]),
  ),
  'org.springframework.beans.factory.annotation.Autowired': '@interface Autowired {}',
  'com.example.controller.User': 'class User {}',
  'org.springframework.context.annotation.Bean': '@interface Bean {}',
  'org.springframework.context.annotation.Configuration': '@interface Configuration {}',
  'org.springframework.stereotype.Service': '@interface Service {}',
  'org.springframework.boot.autoconfigure.condition.ConditionalOnProperty':
    '@interface ConditionalOnProperty { String prefix(); String[] name(); }',
  'org.springframework.boot.context.properties.ConfigurationProperties':
    '@interface ConfigurationProperties { String prefix(); }',
};

export function compareSpringJava(root, result) {
  const compilation = mkdtempSync(path.join(tmpdir(), 'spring-javac-'));
  try {
    cpSync(root, compilation, { recursive: true });
    const deps = Object.entries(signatures).map(([fqn, declaration]) => [
      fqn.replaceAll('.', '/') + '.java',
      `package ${fqn.slice(0, fqn.lastIndexOf('.'))};\npublic ${declaration}\n`,
    ]);
    writeFixtureRepo(path.join(compilation, 'dependencies'), Object.fromEntries(deps));
    const ref = qualifiedJavacReport(javacReports([{ dir: compilation }])[0]);
    ref.declarations = ref.declarations.filter(({ file }) => !file.startsWith('dependencies/'));
    ref.heritage = ref.heritage.filter(
      ({ from, to }) => !from.startsWith('dependencies/') && !to.startsWith('dependencies/'),
    );
    assert.deepEqual(compareJavaStructure(ref, result, javaTypeIdentity, true), []);
    const report = gitNexusCallReport(result, {
      names: ref.declarations.filter(({ kind }) => kind === 'Method').map(({ name }) => name),
      typeCaller: javaTypeIdentity,
      excludeEdgeReasons: ['interface-dispatch'],
    });
    if (ref.sites.length || ref.edges.length) compareReports(ref, report);
    else {
      assert.deepEqual(report.sites, []);
      assert.deepEqual(report.edges, []);
    }
    return ref;
  } finally {
    rmSync(compilation, { recursive: true, force: true });
  }
}
