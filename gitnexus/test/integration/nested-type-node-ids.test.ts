import { describe, expect, it } from 'vitest';
import { parseFilesWithWorkers } from '../helpers/worker-parse.js';

type Graph = Awaited<ReturnType<typeof parseFilesWithWorkers>>['graph'];

const CLASS_LIKE = new Set(['Class', 'Struct', 'Interface', 'Enum', 'Record']);

function nodesNamed(graph: Graph, filePath: string, name: string, classLike: boolean) {
  const ids: string[] = [];
  graph.forEachNode((node) => {
    if (node.properties.filePath !== filePath || node.properties.name !== name) return;
    if (CLASS_LIKE.has(node.label) !== classLike) return;
    ids.push(node.id);
  });
  return ids.sort();
}

function memberOwners(graph: Graph, memberIds: readonly string[]) {
  const targets = new Set(memberIds);
  return graph.relationships
    .filter((edge) => edge.type === 'HAS_METHOD' && targets.has(edge.targetId))
    .map((edge) => edge.sourceId)
    .sort();
}

const CASES = [
  {
    language: 'TypeScript (control)',
    path: 'forms.ts',
    inner: 'Meta',
    member: 'clean',
    content:
      'class UserForm { make() { class Meta { clean() { return 1; } } return Meta; } }\n' +
      'class PostForm { make() { class Meta { clean() { return 2; } } return Meta; } }\n',
  },
  {
    language: 'Python',
    path: 'forms.py',
    inner: 'Meta',
    member: 'clean',
    content:
      'class UserForm:\n' +
      '    class Meta:\n' +
      '        def clean(self):\n' +
      '            return 1\n' +
      '\n' +
      'class PostForm:\n' +
      '    class Meta:\n' +
      '        def clean(self):\n' +
      '            return 2\n',
  },
  {
    language: 'Swift',
    path: 'S.swift',
    inner: 'Inner',
    member: 'foo',
    content:
      'struct A {\n  struct Inner {\n    func foo() -> Int { return 1 }\n  }\n}\n' +
      'struct B {\n  struct Inner {\n    func foo() -> Int { return 2 }\n  }\n}\n',
  },
] as const;

describe('same-tail nested types keep distinct node ids (#4188)', () => {
  for (const testCase of CASES) {
    it(`${testCase.language}: two nested ${testCase.inner} types and their ${testCase.member} members stay distinct`, async () => {
      const { graph } = await parseFilesWithWorkers([
        { path: testCase.path, content: testCase.content },
      ]);

      const innerIds = nodesNamed(graph, testCase.path, testCase.inner, true);
      expect(innerIds, `nested ${testCase.inner} nodes`).toHaveLength(2);

      const memberIds = nodesNamed(graph, testCase.path, testCase.member, false);
      expect(memberIds, `${testCase.member} member nodes`).toHaveLength(2);

      const owners = memberOwners(graph, memberIds);
      expect(owners).toEqual(innerIds);
      for (const owner of owners) expect(graph.getNode(owner)).toBeDefined();
    });
  }

  it('Python and Swift: top-level types keep their simple ids', async () => {
    const { graph } = await parseFilesWithWorkers([
      { path: 'solo.py', content: 'class Solo:\n    def run(self):\n        pass\n' },
      { path: 'Solo.swift', content: 'class Solo {\n  func run() {}\n}\n' },
    ]);
    expect(graph.getNode('Class:solo.py:Solo')).toBeDefined();
    expect(graph.getNode('Class:Solo.swift:Solo')).toBeDefined();
  });
});
