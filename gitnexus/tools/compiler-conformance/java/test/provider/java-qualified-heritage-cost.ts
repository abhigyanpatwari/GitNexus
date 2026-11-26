import assert from 'node:assert/strict';
import test from 'node:test';
import { javaProvider } from '../../../../../src/core/ingestion/languages/java.js';
import { getJavaOverloadFacts } from '../../../../../src/core/ingestion/languages/java/overload-argument-facts.js';
import { reconcileJavaWorkspaceReferences } from '../../../../../src/core/ingestion/languages/java/lombok-workspace-proof.js';
import { getJavaParser } from '../../../../../src/core/ingestion/languages/java/query.js';
import { extractParsedFile } from '../../../../../src/core/ingestion/scope-extractor-bridge.js';

test('resolving distinct qualified members indexes sibling names once per owner', () => {
  const names = Array.from({ length: 128 }, (_, i) => 'T' + i);
  const sources = new Map([
    [
      'api/Host.java',
      'package api; public class Host {' +
        names.map((name) => 'public static class ' + name + ' {}').join('\n') +
        '}',
    ],
    [
      'client/Leaves.java',
      'package client;\n' +
        names.map((name) => 'class Leaf' + name + ' extends api.Host.' + name + ' {}').join('\n'),
    ],
  ]);
  const files = [...sources].map(([file, source]) => {
    const parsed = extractParsedFile(
      javaProvider,
      source,
      file,
      undefined,
      getJavaParser().parse(source),
    );
    assert.ok(parsed);
    return parsed;
  });
  let reads = 0;
  const facts = getJavaOverloadFacts('api/Host.java');
  assert.ok(facts);
  const members = facts.types.filter((fact) => fact.simpleName !== 'Host');
  assert.equal(members.length, names.length);
  for (const member of members) {
    const name = member.simpleName;
    Object.defineProperty(member, 'simpleName', {
      get() {
        reads++;
        return name;
      },
    });
  }
  reconcileJavaWorkspaceReferences(files, { fileContents: sources });
  const sites = files[1].referenceSites.filter((site) => site.kind === 'inherits');
  assert.equal(sites.length, names.length);
  assert.ok(sites.every((site) => site.lookupScope && !site.unresolvedInheritanceBase));
  assert.ok(reads > 0 && reads <= names.length * 16, 'Sibling name reads: ' + reads);
});
