/**
 * #2874 — C++ and Ruby member ids keep every enclosing scope.
 *
 * A collapse is worse than a miss: two members that share an id make every
 * CALLS edge land on whichever node was written last. These cases pin the
 * shapes the first attempt got wrong:
 *
 *   - nested namespaces and nested classes
 *   - an out-of-line definition, including one written inside the namespace
 *     whose qualifier already names that namespace (no `N.N.Box`)
 *   - two template specializations in one file
 *   - anonymous namespaces whose ids do not contain a byte offset
 *   - Ruby `module` nesting and compact `class A::B`
 *
 * Every CALLS assertion names both ends. The source id is built by caller
 * attribution and the target id by the definition phase; the edge exists only
 * when those two strings are the same.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { DIST_WORKER_URL, distWorkerExists } from '../helpers/worker-parse.js';

vi.setConfig({ testTimeout: 90_000 });

const describeIfWorkerBuilt = distWorkerExists() ? describe : describe.skip;

const analyze = async (
  files: Readonly<Record<string, string>>,
): Promise<{ readonly calls: readonly string[]; readonly ids: readonly string[] }> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-member-scope-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      const filePath = path.join(dir, name);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, source, 'utf-8');
    }
    const result = await runPipelineFromRepo(dir, () => {}, {
      workerPoolSize: 1,
      workerUrlForTest: DIST_WORKER_URL,
    });
    return {
      calls: result.graph.relationships
        .filter((rel) => rel.type === 'CALLS')
        .map((rel) => `${rel.sourceId} -> ${rel.targetId}`)
        .sort(),
      ids: result.graph.nodes.map((node) => node.id).sort(),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const memberIds = (ids: readonly string[], label: string): readonly string[] =>
  ids.filter((id) => id.startsWith(`${label}:`));

describeIfWorkerBuilt('C++ and Ruby member ids keep enclosing scope (#2874)', () => {
  it('keeps nested C++ namespaces, nested classes, and out-of-line definitions distinct', async () => {
    const { calls, ids } = await analyze({
      'nested.cpp': `
        namespace N {
          struct Box { void save() { } void run() { save(); } };
          namespace M { struct Box { void save() { } void run() { save(); } }; }
          struct Outer { struct Inner { void save() { } void run() { save(); } }; };
        }
        struct Box { void save() { } void run() { save(); } };
        struct Inner { void save() {} };

        namespace N { void Box::save() {} }
        void N::M::Box::save() {}
        namespace N { void N::Outer::Inner::save() {} }
        void ::Box::save() {}
      `,
    });

    const methods = memberIds(ids, 'Method').filter((id) => id.includes('nested.cpp'));
    expect(methods).toEqual(
      expect.arrayContaining([
        'Method:nested.cpp:N.Box.save#0',
        'Method:nested.cpp:N.Box.run#0',
        'Method:nested.cpp:N.M.Box.save#0',
        'Method:nested.cpp:N.M.Box.run#0',
        'Method:nested.cpp:N.Outer.Inner.save#0',
        'Method:nested.cpp:N.Outer.Inner.run#0',
        'Method:nested.cpp:Box.save#0',
        'Method:nested.cpp:Box.run#0',
        'Method:nested.cpp:Inner.save#0',
      ]),
    );
    expect(methods.filter((id) => id.includes('N.N.'))).toEqual([]);
    expect(calls).toEqual(
      expect.arrayContaining([
        'Method:nested.cpp:N.Box.run#0 -> Method:nested.cpp:N.Box.save#0',
        'Method:nested.cpp:N.M.Box.run#0 -> Method:nested.cpp:N.M.Box.save#0',
        'Method:nested.cpp:N.Outer.Inner.run#0 -> Method:nested.cpp:N.Outer.Inner.save#0',
        'Method:nested.cpp:Box.run#0 -> Method:nested.cpp:Box.save#0',
      ]),
    );
  });

  it('gives same-file template specializations distinct ids and matches the out-of-line body', async () => {
    const { ids } = await analyze({
      'spec.cpp': `
        namespace N {
          template <class T> struct Box { void save() {} };
          template <> struct Box<bool> { void save(); };
        }
        template <> struct Box<bool> { void save(); };
        template <> void N::Box<bool>::save() {}
        template <> void Box<bool>::save() {}
        template <class T> void N::Box<T>::save() {}
        namespace A {
          template <class T> struct Box { void save(); };
          template <> struct Box<std::string> { void save(); };
        }
        template <> void A::Box<std::string>::save() {}
      `,
    });
    const methods = memberIds(ids, 'Method').filter((id) => id.includes('spec.cpp'));
    expect(methods).toEqual(
      expect.arrayContaining([
        'Method:spec.cpp:N.Box.save#0~c:16619u1',
        'Method:spec.cpp:N.Box<bool>.save#0',
        'Method:spec.cpp:Box<bool>.save#0',
        'Method:spec.cpp:A.Box<std::string>.save#0',
      ]),
    );
    expect(methods.filter((id) => id === 'Method:spec.cpp:Box<bool>.save#0')).toHaveLength(1);
    expect(methods.filter((id) => id === 'Method:spec.cpp:N.Box<bool>.save#0')).toHaveLength(1);
    expect(methods.filter((id) => id === 'Method:spec.cpp:A.Box<std::string>.save#0')).toHaveLength(
      1,
    );
    expect(methods.some((id) => id.includes('N.N.') || id.includes('Box<std.'))).toBe(false);
  });

  it('keeps anonymous-namespace member ids stable when bytes above them move', async () => {
    const body = `
      namespace { struct Item { void save() {} int value; }; }
      namespace N {
        namespace { struct Item { void save() {} }; }
        namespace { struct Item { void save() {} }; }
      }
    `;
    const shifted = await analyze({ 'anon.cpp': `/* ${'x'.repeat(400)} */\n${body}` });
    const original = await analyze({ 'anon.cpp': body });
    const member = (ids: readonly string[]) =>
      ids.filter(
        (id) =>
          id.includes('anon.cpp') &&
          (id.startsWith('Method:') || id.startsWith('Property:') || id.startsWith('Struct:')),
      );
    expect(member(shifted.ids)).toEqual(member(original.ids));
    const anonIds = member(original.ids).filter((id) => id.includes('@anon'));
    expect(anonIds).toEqual(
      expect.arrayContaining([
        'Struct:anon.cpp:@anon1.Item',
        'Method:anon.cpp:@anon1.Item.save#0',
        'Property:anon.cpp:@anon1.Item.value',
        'Struct:anon.cpp:N.@anon1.Item',
        'Method:anon.cpp:N.@anon1.Item.save#0',
        'Struct:anon.cpp:N.@anon2.Item',
        'Method:anon.cpp:N.@anon2.Item.save#0',
      ]),
    );
    expect(anonIds.some((id) => /@anon\d{2,}/.test(id))).toBe(false);
  });

  it('keeps Ruby module nesting and compact class paths distinct', async () => {
    const { calls, ids } = await analyze({
      'nested.rb': `
        module N
          class Box
            def save; end
            def run; save; end
          end
        end
        class Box
          def save; end
          def run; save; end
        end
        module Outer
          module Inner
            class Box
              def save; end
            end
          end
        end
        class A::B
          def save; end
          def run; save; end
        end
        module A
          class B
            def other; end
          end
        end
      `,
    });
    const methods = memberIds(ids, 'Method').filter((id) => id.includes('nested.rb'));
    expect(methods).toEqual(
      expect.arrayContaining([
        'Method:nested.rb:N.Box.save#0',
        'Method:nested.rb:N.Box.run#0',
        'Method:nested.rb:Box.save#0',
        'Method:nested.rb:Box.run#0',
        'Method:nested.rb:Outer.Inner.Box.save#0',
        'Method:nested.rb:A.B.save#0',
        'Method:nested.rb:A.B.run#0',
        'Method:nested.rb:A.B.other#0',
      ]),
    );
    expect(methods.filter((id) => id.endsWith(':B.save#0') || id.endsWith(':B.save'))).toEqual([]);
    expect(calls).toEqual(
      expect.arrayContaining([
        'Method:nested.rb:N.Box.run#0 -> Method:nested.rb:N.Box.save#0',
        'Method:nested.rb:Box.run#0 -> Method:nested.rb:Box.save#0',
        'Method:nested.rb:A.B.run#0 -> Method:nested.rb:A.B.save#0',
      ]),
    );
  });
});
