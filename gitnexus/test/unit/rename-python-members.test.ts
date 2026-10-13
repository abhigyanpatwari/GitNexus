import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { renameSymbol } from '../../src/mcp/local/rename/rename-plan.js';
import { createRenameFixtureHelpers } from '../helpers/rename-provider-fixture.js';

const { expectRename, fixture } = createRenameFixtureHelpers();

async function expectRefusal(
  files: Record<string, string>,
  name: string,
  kind: string,
  newName: string,
  code: string,
  targetFile?: string,
) {
  const { root, nodes, symbol } = await fixture(files, name, kind, targetFile);
  for (const dry_run of [true, false]) {
    expect(
      await renameSymbol(root, symbol, { new_name: newName, dry_run }, nodes),
      `${name} -> ${newName} dry_run=${dry_run}`,
    ).toMatchObject({
      status: 'error',
      planning_status: 'unsupported',
      code,
      total_edits: 0,
      applied: false,
    });
    for (const [file, content] of Object.entries(files))
      expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content);
  }
}

// The shared helper selects the first declaration; this one picks by zero-based start line.
async function expectRefusalAtLine(
  files: Record<string, string>,
  name: string,
  startLine: number,
  newName: string,
  code: string,
) {
  const { root, nodes } = await fixture(files, name, 'Method');
  const target = nodes.find(
    (node) =>
      node.label === 'Method' &&
      node.properties.name === name &&
      node.properties.startLine === startLine,
  );
  expect(target, JSON.stringify(nodes.filter((node) => node.label === 'Method'))).toBeDefined();
  const symbol = {
    uid: target!.id,
    name,
    filePath: target!.properties.filePath,
    startLine: target!.properties.startLine! + 1,
    endLine: target!.properties.endLine! + 1,
    kind: 'Method',
  };
  for (const dry_run of [true, false]) {
    expect(await renameSymbol(root, symbol, { new_name: newName, dry_run }, nodes)).toMatchObject({
      status: 'error',
      planning_status: 'unsupported',
      code,
      total_edits: 0,
      applied: false,
    });
    for (const [file, content] of Object.entries(files))
      expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content);
  }
}

describe('Python special-method protocol names', () => {
  it.each([
    [
      '__len__ used through len()',
      'class Bag:\n    def __len__(self):\n        return 7\nprint(len(Bag()))\n',
      '__len__',
      'Method',
      'renamed',
    ],
    [
      '__iter__ used by iteration',
      'class Bag:\n    def __iter__(self):\n        return iter([1])\nfor item in Bag():\n    pass\n',
      '__iter__',
      'Method',
      'walk',
    ],
    [
      '__init__ used by construction',
      'class Bag:\n    def __init__(self):\n        self.size = 1\nBag()\n',
      '__init__',
      'Method',
      'build',
    ],
    [
      'an ordinary method moved into __len__',
      'class Bag:\n    def target(self):\n        return 7\nprint(len(Bag()))\nBag().target()\n',
      'target',
      'Method',
      '__len__',
    ],
    [
      'an ordinary method moved into __iter__',
      'class Bag:\n    def target(self):\n        return iter([1])\nfor item in Bag():\n    pass\nBag().target()\n',
      'target',
      'Method',
      '__iter__',
    ],
    [
      'an ordinary method moved into __init__',
      'class Bag:\n    def target(self):\n        return 7\nBag().target()\n',
      'target',
      'Method',
      '__init__',
    ],
    [
      'an ordinary method moved into a decomposed special name',
      'class Bag:\n    def target(self):\n        return 7\nBag().target()\n',
      'target',
      'Method',
      '__ｌen__',
    ],
    [
      'a class property moved into __class__',
      'class Bag:\n    size: int = 1\nBag().size\n',
      'size',
      'Property',
      '__class__',
    ],
  ])(
    'refuses %s without changing any source',
    async (_description, content, name, kind, newName) => {
      await expectRefusal(
        { 'model.py': content },
        name,
        kind,
        newName,
        'unsupported_symbol_family',
      );
    },
    60_000,
  );

  it('still renames an ordinary method beside an untouched special method', async () => {
    await expectRename(
      {
        'model.py':
          'class Bag:\n    def target(self):\n        return 7\n    def __len__(self):\n        return self.target()\nprint(len(Bag()))\nBag().target()\n',
      },
      {
        'model.py':
          'class Bag:\n    def renamed(self):\n        return 7\n    def __len__(self):\n        return self.renamed()\nprint(len(Bag()))\nBag().renamed()\n',
      },
      'target',
      'Method',
      'renamed',
    );
  }, 60_000);
});

describe('Python private-name mangling destinations', () => {
  it.each([
    ['a double-underscore name', '__secret'],
    ['a name with one trailing underscore', '__secret_'],
    ['a compatibility-equivalent spelling', '_＿secret'],
  ])(
    'refuses a public member renamed to %s',
    async (_description, newName) => {
      await expectRefusal(
        {
          'model.py':
            'class Worker:\n    def target(self):\n        return 7\nworker = Worker()\nworker.target()\n',
        },
        'target',
        'Method',
        newName,
        'unsupported_symbol_family',
      );
    },
    60_000,
  );

  it('refuses a public field renamed to a private name', async () => {
    await expectRefusal(
      { 'model.py': 'class Worker:\n    size: int = 1\nWorker().size\n' },
      'size',
      'Property',
      '__size',
      'unsupported_symbol_family',
    );
  }, 60_000);

  it('still renames a public member to a single-underscore name', async () => {
    await expectRename(
      {
        'model.py':
          'class Worker:\n    def target(self):\n        return 7\nworker = Worker()\nworker.target()\n',
      },
      {
        'model.py':
          'class Worker:\n    def _hidden(self):\n        return 7\nworker = Worker()\nworker._hidden()\n',
      },
      'target',
      'Method',
      '_hidden',
    );
  }, 60_000);
});

describe('Python reflective access through inherited members', () => {
  const classes =
    'class Base:\n    def target(self):\n        return 7\nclass Child(Base):\n    pass\nworker = Child()\n';
  it.each([
    ['getattr', 'getattr(worker, "target")()\n'],
    ['hasattr', 'hasattr(worker, "target")\n'],
    ['setattr', 'setattr(worker, "target", lambda: 8)\n'],
    ['delattr', 'delattr(worker, "target")\n'],
  ])(
    'refuses %s of the selected name on a receiver inheriting the member',
    async (_function, access) => {
      await expectRefusal(
        { 'model.py': classes + access },
        'target',
        'Method',
        'renamed',
        'unsupported_occurrence',
      );
    },
    60_000,
  );

  it.each([
    ['getattr', 'getattr(worker, "renamed", None)\n'],
    ['hasattr', 'hasattr(worker, "renamed")\n'],
    ['setattr', 'setattr(worker, "renamed", 8)\n'],
    ['delattr', 'delattr(worker, "renamed")\n'],
  ])(
    'refuses %s of the destination name on a receiver inheriting the member',
    async (_function, access) => {
      await expectRefusal(
        { 'model.py': classes + access },
        'target',
        'Method',
        'renamed',
        'unsupported_occurrence',
      );
    },
    60_000,
  );

  it('refuses an annotated subclass receiver that inherits the selected member', async () => {
    await expectRefusal(
      {
        'model.py':
          'class Base:\n    def target(self):\n        return 7\nclass Child(Base):\n    pass\n' +
          'def run(child: Child):\n    return getattr(child, "target")()\n',
      },
      'target',
      'Method',
      'renamed',
      'unsupported_occurrence',
    );
  }, 60_000);

  it('refuses a base-typed receiver that may hold an instance of the declaring subclass', async () => {
    await expectRefusal(
      {
        'model.py':
          'class Base:\n    pass\nclass Child(Base):\n    def target(self):\n        return 7\n' +
          'def run(base: Base):\n    return getattr(base, "target")()\n',
      },
      'target',
      'Method',
      'renamed',
      'unsupported_occurrence',
    );
  }, 60_000);

  it('refuses a sibling receiver that inherits the base member of the selected override family', async () => {
    await expectRefusalAtLine(
      {
        'model.py':
          'class Base:\n    def target(self):\n        return 7\n' +
          'class Child(Base):\n    def target(self):\n        return 8\n' +
          'class Sibling(Base):\n    pass\n' +
          'sibling = Sibling()\ngetattr(sibling, "target")()\n',
      },
      'target',
      4,
      'renamed',
      'unsupported_occurrence',
    );
  }, 60_000);

  it.each([
    ['getattr', 'getattr(other, "target")()\n', 'getattr(other, "target")()\n'],
    ['hasattr', 'hasattr(other, "target")\n', 'hasattr(other, "target")\n'],
    ['setattr', 'setattr(other, "target", 8)\n', 'setattr(other, "target", 8)\n'],
    ['delattr', 'delattr(other, "target")\n', 'delattr(other, "target")\n'],
    [
      'destination getattr',
      'getattr(other, "renamed", None)\n',
      'getattr(other, "renamed", None)\n',
    ],
    ['destination setattr', 'setattr(other, "renamed", 8)\n', 'setattr(other, "renamed", 8)\n'],
  ])(
    'renames a base member beside %s on a proven unrelated receiver',
    async (_function, access, preserved) => {
      const unrelated = 'class Other:\n    pass\nother = Other()\n';
      await expectRename(
        { 'model.py': classes + unrelated + access },
        {
          'model.py': classes.replace('def target', 'def renamed') + unrelated + preserved,
        },
        'target',
        'Method',
        'renamed',
      );
    },
    60_000,
  );
});

describe('Python keyword argument labels naming a field', () => {
  const dataclass = 'from dataclasses import dataclass\n@dataclass\nclass Point:\n    x: int\n';
  it.each([
    ['a synthesized dataclass constructor', dataclass + 'point = Point(x=1)\n', 'x', 'renamed'],
    [
      'a subclass inheriting the synthesized constructor',
      dataclass + 'class Child(Point):\n    pass\nchild = Child(x=1)\n',
      'x',
      'renamed',
    ],
    [
      'a dataclasses.replace() copy',
      'from dataclasses import dataclass, replace\n@dataclass\nclass Point:\n    x: int\n' +
        'def move(point: Point):\n    return replace(point, x=2)\n',
      'x',
      'renamed',
    ],
    [
      'a destination label of a synthesized constructor',
      dataclass.replace('x: int', 'size: int') + 'point = Point(x=1)\n',
      'size',
      'x',
    ],
    [
      'an unresolved callee',
      dataclass + 'import factory\npoint = factory.build(x=1)\n',
      'x',
      'renamed',
    ],
  ])(
    'refuses a label that may bind %s',
    async (_description, content, name, newName) => {
      await expectRefusal(
        { 'model.py': content },
        name,
        'Property',
        newName,
        'ambiguous_reference',
      );
    },
    60_000,
  );

  it('renames a field beside labels of calls proven to bind other parameters', async () => {
    const calls =
      'def configure(x):\n    return x\nconfigure(x=1)\n' +
      'class Runner:\n    def run(self, x):\n        return x\nRunner().run(x=3)\n' +
      'class Other:\n    def __init__(self, x):\n        self.value = x\nOther(x=2)\n';
    await expectRename(
      { 'model.py': dataclass + calls },
      { 'model.py': dataclass.replace('x: int', 'renamed: int') + calls },
      'x',
      'Property',
      'renamed',
    );
  }, 60_000);
});
