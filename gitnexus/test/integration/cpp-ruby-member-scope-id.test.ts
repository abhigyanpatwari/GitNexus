/**
 * Regression suite for #2874: C++ and Ruby member node IDs must preserve their
 * enclosing namespace/module/outer-type scope instead of collapsing to the
 * unqualified tail type name.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import CPP from 'tree-sitter-cpp';
import { cppProvider } from '../../src/core/ingestion/languages/c-cpp.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { writeFixtureRepo } from '../helpers/resolution-graph.js';
import { findDanglingEdges, getRelationships } from './resolvers/helpers.js';

const tempDirs: string[] = [];

function createTempRepo(prefix: string, files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gitnexus-${prefix}-`));
  tempDirs.push(dir);
  writeFixtureRepo(dir, files);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('C++ and Ruby member scope IDs (#2874)', () => {
  it('keeps C++ namespaced and global template specialization members distinct', async () => {
    const repo = createTempRepo('cpp-ns-member-id', {
      'main.cpp': `
namespace N {
  template <class T>
  struct Box {};

  template <>
  struct Box<bool> {
    int count;
    void save() {}
    void run() { save(); }
  };
}

template <class T>
struct Box {};

template <>
struct Box<bool> {
  int count;
  void save() {}
};
`,
    });

    const result = await runPipelineFromRepo(repo, () => {}, { skipGraphPhases: true });
    const methodIds = new Set<string>();
    const propertyIds = new Set<string>();
    result.graph.forEachNode((node) => {
      if (node.label === 'Method') methodIds.add(node.id);
      if (node.label === 'Property') propertyIds.add(node.id);
    });

    expect(methodIds.has('Method:main.cpp:N.Box<bool>.save#0')).toBe(true);
    expect(methodIds.has('Method:main.cpp:N.Box<bool>.run#0')).toBe(true);
    expect(methodIds.has('Method:main.cpp:Box<bool>.save#0')).toBe(true);

    expect(propertyIds.has('Property:main.cpp:N.Box<bool>.count')).toBe(true);
    expect(propertyIds.has('Property:main.cpp:Box<bool>.count')).toBe(true);

    expect(findDanglingEdges(result, ['HAS_METHOD', 'HAS_PROPERTY'])).toEqual([]);

    const callsFromRun = getRelationships(result, 'CALLS').filter(
      (c) => c.rel.sourceId === 'Method:main.cpp:N.Box<bool>.run#0',
    );
    expect(callsFromRun.some((c) => c.rel.targetId === 'Method:main.cpp:N.Box<bool>.save#0')).toBe(
      true,
    );
  }, 60000);

  it('preserves trailing template arguments when an enclosing C++ scope is also templated', async () => {
    const repo = createTempRepo('cpp-nested-template-member-id', {
      'main.cpp': `
template <>
struct Outer<int> {
  template <class U>
  struct Box {};

  template <>
  struct Box<bool> {
    void save() {}
  };

  template <>
  struct Box<double> {
    void save() {}
  };
};
`,
    });

    const result = await runPipelineFromRepo(repo, () => {}, { skipGraphPhases: true });
    const methodIds = new Set<string>();
    result.graph.forEachNode((node) => {
      if (node.label === 'Method') methodIds.add(node.id);
    });

    expect(methodIds.has('Method:main.cpp:Outer<int>.Box<bool>.save#0')).toBe(true);
    expect(methodIds.has('Method:main.cpp:Outer<int>.Box<double>.save#0')).toBe(true);
  }, 60000);

  it('qualifies C++ out-of-line method definitions without dropping or doubling namespaces', async () => {
    const repo = createTempRepo('cpp-out-of-line-member-id', {
      'main.cpp': `
namespace N {
  struct Box {
    void save();
  };
  struct InNs {
    void run();
  };
  struct Redundant {
    void go();
  };
  void InNs::run() {}
  void N::Redundant::go() {}
}

void N::Box::save() {}

struct GlobalBox {
  void ping();
};

namespace Outer {
  void ::GlobalBox::ping() {}
}

namespace PtrNs {
  struct Box {
    int* get();
    Box& ref();
  };
  struct NestedHost {
    struct Inner {
      void act() {}
    };
  };
}

int* PtrNs::Box::get() { return nullptr; }
PtrNs::Box& PtrNs::Box::ref() { return *this; }
`,
    });

    const result = await runPipelineFromRepo(repo, () => {}, { skipGraphPhases: true });
    const methodIds = new Set<string>();
    result.graph.forEachNode((node) => {
      if (node.label === 'Method') methodIds.add(node.id);
    });

    expect(methodIds.has('Method:main.cpp:N.Box.save#0')).toBe(true);
    expect(methodIds.has('Method:main.cpp:N.InNs.run#0')).toBe(true);
    expect(methodIds.has('Method:main.cpp:N.Redundant.go#0')).toBe(true);
    expect(methodIds.has('Method:main.cpp:N.N.Redundant.go#0')).toBe(false);
    expect(methodIds.has('Method:main.cpp:GlobalBox.ping#0')).toBe(true);
    expect(methodIds.has('Method:main.cpp:Outer.GlobalBox.ping#0')).toBe(false);
    expect(methodIds.has('Method:main.cpp:PtrNs.Box.get#0')).toBe(true);
    expect(methodIds.has('Method:main.cpp:PtrNs.Box.ref#0')).toBe(true);
    expect(methodIds.has('Method:main.cpp:PtrNs.NestedHost.Inner.act#0')).toBe(true);
    expect(methodIds.has('Method:main.cpp:save#0')).toBe(false);
    expect(methodIds.has('Method:main.cpp:run#0')).toBe(false);

    expect(findDanglingEdges(result, ['HAS_METHOD'])).toEqual([]);
  }, 60000);

  it('preserves :: inside template arguments on C++ out-of-line definitions (#4141)', async () => {
    const repo = createTempRepo('cpp-template-arg-scope', {
      'box.hpp': `
namespace std {
  struct string {};
}
namespace A {
  template <class T>
  struct Box {};

  template <>
  struct Box<std::string> {
    void save();
  };
}
`,
      'main.cpp': `
#include "box.hpp"

namespace A {
  void Box<std::string>::save() {}
}
`,
    });

    const result = await runPipelineFromRepo(repo, () => {}, { skipGraphPhases: true });
    const methodIds = new Set<string>();
    result.graph.forEachNode((node) => {
      if (node.label === 'Method') methodIds.add(node.id);
    });

    expect(methodIds.has('Method:box.hpp:A.Box<std::string>.save#0')).toBe(true);
    expect(methodIds.has('Method:main.cpp:A.Box<std::string>.save#0')).toBe(true);
    expect(methodIds.has('Method:main.cpp:A.Box<std.string>.save#0')).toBe(false);
    expect(findDanglingEdges(result, ['HAS_METHOD'])).toEqual([]);

    const parser = new Parser();
    parser.setLanguage(CPP);
    const tree = parser.parse('void A::Box<std::string>::save() {}\n');
    const fnDef = tree.rootNode.namedChild(0);
    expect(fnDef?.type).toBe('function_definition');
    expect(fnDef ? cppProvider.resolveDetachedOwnerName?.(fnDef) : undefined).toBe(
      'A.Box<std::string>',
    );
  }, 60000);

  it('keeps C++ anonymous namespace member IDs distinct and invariant to edits above', async () => {
    const body = `
namespace {
  struct Item {
    int val;
    void go() {}
  };
}

namespace {
  struct Item {
    int val;
    void go() {}
  };
}
`;
    const repoBefore = createTempRepo('cpp-anon-before', { 'anon.cpp': body });
    const repoAfter = createTempRepo('cpp-anon-after', {
      'anon.cpp': `// Leading comment shifts every byte offset down.\n// Another header line.\n\n${body}`,
    });

    const before = await runPipelineFromRepo(repoBefore, () => {}, { skipGraphPhases: true });
    const after = await runPipelineFromRepo(repoAfter, () => {}, { skipGraphPhases: true });

    const collectIds = (res: Awaited<ReturnType<typeof runPipelineFromRepo>>) => {
      const classes: string[] = [];
      const methods: string[] = [];
      const props: string[] = [];
      res.graph.forEachNode((n) => {
        if (n.label === 'Struct' || n.label === 'Class') classes.push(n.id);
        if (n.label === 'Method') methods.push(n.id);
        if (n.label === 'Property') props.push(n.id);
      });
      return {
        classes: classes.sort(),
        methods: methods.sort(),
        props: props.sort(),
      };
    };

    const beforeIds = collectIds(before);
    const afterIds = collectIds(after);

    expect(beforeIds.classes).toHaveLength(2);
    expect(beforeIds.methods).toHaveLength(2);
    expect(beforeIds.props).toHaveLength(2);
    expect(beforeIds.methods[0]).toContain('@anon');
    expect(beforeIds.methods[0]).not.toBe(beforeIds.methods[1]);
    expect(afterIds).toEqual(beforeIds);
    expect(findDanglingEdges(before, ['HAS_METHOD', 'HAS_PROPERTY'])).toEqual([]);
  }, 60000);

  it('keeps Ruby module, top-level, compact A::B, and attr_accessor members distinct', async () => {
    const repo = createTempRepo('ruby-member-id', {
      'box.rb': `
module N
  class Box
    attr_accessor :val
    def save
      helper
    end

    def helper
    end
  end
end

class Box
  attr_accessor :val
  def save
  end
end

class N::Compact
  attr_accessor :flag
  def run
  end
end
`,
    });

    const result = await runPipelineFromRepo(repo, () => {}, { skipGraphPhases: true });
    const methodIds = new Set<string>();
    const propertyIds = new Set<string>();
    result.graph.forEachNode((node) => {
      if (node.label === 'Method') methodIds.add(node.id);
      if (node.label === 'Property') propertyIds.add(node.id);
    });

    expect(methodIds.has('Method:box.rb:N.Box.save#0')).toBe(true);
    expect(methodIds.has('Method:box.rb:N.Box.helper#0')).toBe(true);
    expect(methodIds.has('Method:box.rb:Box.save#0')).toBe(true);
    expect(methodIds.has('Method:box.rb:N.Compact.run#0')).toBe(true);

    expect(propertyIds.has('Property:box.rb:N.Box.val')).toBe(true);
    expect(propertyIds.has('Property:box.rb:Box.val')).toBe(true);
    expect(propertyIds.has('Property:box.rb:N.Compact.flag')).toBe(true);

    expect(findDanglingEdges(result, ['HAS_METHOD', 'HAS_PROPERTY'])).toEqual([]);

    const callsFromSave = getRelationships(result, 'CALLS').filter(
      (c) => c.rel.sourceId === 'Method:box.rb:N.Box.save#0',
    );
    expect(callsFromSave.some((c) => c.rel.targetId === 'Method:box.rb:N.Box.helper#0')).toBe(true);
  }, 60000);
});
