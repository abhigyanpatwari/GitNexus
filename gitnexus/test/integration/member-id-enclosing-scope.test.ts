import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

/**
 * #2874: C++ and Ruby member ids were qualified by the immediate class name only,
 * so two members whose owners differ solely by an enclosing namespace / module
 * minted ONE id and the second write was dropped.
 */
describe('member ids keep the enclosing namespace / module (#2874)', () => {
  let root: string;
  let result: Awaited<ReturnType<typeof runPipelineFromRepo>>;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'member-id-scope-'));
    await fs.writeFile(
      path.join(root, 'box.cpp'),
      `
namespace N { template <class T> struct Box { void save(); }; }
template <class T> struct Box { void save(); };
`,
    );
    // Explicit specializations of one namespaced template are distinct owners.
    await fs.writeFile(
      path.join(root, 'spec.cpp'),
      `
namespace N {
template <class T> struct Box { void save(); };
template <> struct Box<bool> { void save(); };
template <> struct Box<int> { void save(); };
}
`,
    );
    // Same anonymous namespace, shifted down by unrelated leading lines.
    await fs.writeFile(
      path.join(root, 'anon_a.cpp'),
      `namespace { struct Cell { void run(); }; }
`,
    );
    await fs.writeFile(
      path.join(root, 'anon_b.cpp'),
      `// unrelated edit above
// and another line
namespace { struct Cell { void run(); }; }
`,
    );
    await fs.writeFile(
      path.join(root, 'compact.rb'),
      `
module A
  class B
    def x; end
  end
end
class A::B
  def y; end
end
`,
    );
    await fs.writeFile(
      path.join(root, 'box.rb'),
      `
module N
  class Box
    def save; end
  end
end
class Box
  def save; end
end
`,
    );
    result = await runPipelineFromRepo(root, () => {}, {});
  }, 120000);

  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  const membersNamed = (name: string, file: string) =>
    [...result.graph.iterNodes()].filter(
      (n) => n.properties.name === name && String(n.properties.filePath).endsWith(file),
    );

  it('C++: N::Box<T>::save and ::Box<T>::save are two nodes', () => {
    const ids = new Set(membersNamed('save', 'box.cpp').map((n) => n.id));
    expect(ids.size).toBe(2);
  });

  it('Ruby: module N / class Box#save and top-level Box#save are two nodes', () => {
    const ids = new Set(membersNamed('save', 'box.rb').map((n) => n.id));
    expect(ids.size).toBe(2);
  });

  it('C++: specializations of one namespaced template keep distinct member ids', () => {
    const ids = new Set(membersNamed('save', 'spec.cpp').map((n) => n.id));
    expect(ids.size).toBe(3);
  });

  it('C++: a member id carries its namespace chain, not just the class name', () => {
    const ids = membersNamed('save', 'box.cpp').map((n) => n.id);
    expect(ids.some((id) => id.includes(':N.Box.save'))).toBe(true);
  });

  it('C++: member ids inside an anonymous namespace do not depend on byte offsets', () => {
    const idOf = (file: string) => membersNamed('run', file).map((n) => n.id.split(':').slice(2));
    expect(idOf('anon_a.cpp')).toEqual(idOf('anon_b.cpp'));
    expect(idOf('anon_a.cpp')).toHaveLength(1);
  });

  it('Ruby: compact `class A::B` members share the owner of the nested spelling', () => {
    const ids = membersNamed('x', 'compact.rb').concat(membersNamed('y', 'compact.rb'));
    expect(ids).toHaveLength(2);
    const owners = new Set(ids.map((n) => n.id.split(':')[2]?.split('.').slice(0, -1).join('.')));
    expect(owners.size).toBe(1);
  });

  it('each member is owned by exactly its own class (HAS_METHOD edges agree)', () => {
    const edges = [...result.graph.iterRelationships()].filter((e) => e.type === 'HAS_METHOD');
    for (const file of ['box.cpp', 'box.rb']) {
      for (const member of membersNamed('save', file)) {
        const owners = edges.filter((e) => e.targetId === member.id);
        expect(owners.length).toBe(1);
      }
    }
  });
});
