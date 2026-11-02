import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { renameSymbol } from '../../src/mcp/local/rename/rename-plan.js';
import { SCOPE_RESOLVERS } from '../../src/core/ingestion/scope-resolution/pipeline/registry.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { phpRenameProvider } from '../../src/core/ingestion/languages/php/rename.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string>, name: string, kind: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-php-ruby-'));
  roots.push(root);
  await Promise.all(
    Object.entries(files).map(async ([file, content]) => {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), content);
    }),
  );
  const result = await runPipelineFromRepo(root, () => undefined, {
    workerPoolSize: 1,
    skipGraphPhases: true,
  });
  const nodes = [...result.graph.iterNodes()];
  const target = nodes.find((node) => node.properties.name === name && node.label === kind);
  expect(target, JSON.stringify(nodes.filter((node) => node.label !== 'File'))).toBeDefined();
  return {
    root,
    nodes,
    symbol: {
      uid: target!.id,
      name: target!.properties.name,
      filePath: target!.properties.filePath,
      startLine: target!.properties.startLine! + 1,
      endLine: target!.properties.endLine! + 1,
      kind: target!.label,
    },
  };
}

async function expectRename(
  files: Record<string, string>,
  expected: Record<string, string>,
  name: string,
  kind: string,
  newName: string,
) {
  const { root, nodes, symbol } = await fixture(files, name, kind);
  const preview = await renameSymbol(root, symbol, { new_name: newName, dry_run: true }, nodes);
  expect(preview, JSON.stringify(preview)).toMatchObject({ status: 'success', applied: false });
  for (const [file, content] of Object.entries(files))
    expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content);
  const applied = await renameSymbol(root, symbol, { new_name: newName, dry_run: false }, nodes);
  expect(applied, JSON.stringify(applied)).toMatchObject({
    status: 'success',
    applied: true,
    changes: preview.changes,
  });
  for (const [file, content] of Object.entries(expected))
    expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content);
}

describe('PHP and Ruby rename through the production parsing pipeline', () => {
  it.each([
    [
      'model.php',
      '<?php\nfunction target() {}\nfunction call() { $target = 1; return $target; }\ntarget();\n',
      'Function',
    ],
    ['model.rb', 'def target\nend\ndef call\n target = 1\n puts target\nend\ntarget()\n', 'Method'],
  ])(
    'preserves local binding shadows in %s',
    async (file, content, kind) => {
      await expectRename(
        { [file]: content },
        {
          [file]: content
            .replace('function target()', 'function renamed()')
            .replace('def target', 'def renamed')
            .replace('\ntarget()', '\nrenamed()'),
        },
        'target',
        kind,
        'renamed',
      );
    },
    60000,
  );

  it('refuses PHP class imports that require an autoload filename change', async () => {
    const files = {
      'composer.json': '{"autoload":{"psr-4":{"Source\\\\":"Source/"}}}',
      'Source/Target.php': '<?php\nnamespace Source;\nclass Target {}\n',
      'caller.php': '<?php\nuse Source\\Target as Local;\n$value = new local();\n',
    };
    const { root, nodes, symbol } = await fixture(files, 'Target', 'Class');
    const result = await renameSymbol(root, symbol, { new_name: 'Renamed', dry_run: false }, nodes);
    expect(result).toMatchObject({
      status: 'error',
      applied: false,
      code: 'unsupported_occurrence',
    });
    for (const [file, content] of Object.entries(files))
      expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content);
  }, 60000);

  it.each([
    [
      'function',
      'Function',
      'Target',
      'tARGET',
      'function Target() {}',
      'function other() {}',
      'local();',
    ],
    ['const', 'Const', 'target', 'target', 'const target = 1;', 'const Target = 2;', 'echo local;'],
  ])(
    'resolves PHP %s imports with role-sensitive case',
    async (importKind, kind, name, importedName, declaration, other, call) => {
      const files = {
        'composer.json': '{"autoload":{"psr-4":{"Source\\\\":"Source/"}}}',
        'Source/first.php': `<?php\nnamespace Source;\n${declaration}\n`,
        'Source/second.php': `<?php\nnamespace Source;\n${other}\n`,
        'caller.php': `<?php\nuse ${importKind} Source\\${importedName} as local;\n${call}\n`,
      };
      await expectRename(
        files,
        {
          'Source/first.php': files['Source/first.php'].replace(name, 'renamed'),
          'Source/second.php': files['Source/second.php'],
          'caller.php': files['caller.php'].replace(importedName, 'renamed'),
        },
        name,
        kind,
        'renamed',
      );
    },
    60000,
  );

  it('keeps PHP constant spellings case-sensitive', async () => {
    const content = '<?php\nconst target = 1;\nconst Target = 2;\necho target + Target;\n';
    await expectRename(
      { 'model.php': content },
      { 'model.php': content.replaceAll('target', 'renamed') },
      'target',
      'Const',
      'renamed',
    );
  }, 60000);

  it.each([
    [
      'model.php',
      '<?php\nfunction target() {}\ntarget();\n// target\n$text = "target";\n',
      'Function',
    ],
    ['model.rb', 'def target\nend\ntarget()\n# target\ntext = "target"\n', 'Method'],
  ])(
    'previews and applies free calls in %s',
    async (file, content, kind) => {
      await expectRename(
        { [file]: content },
        {
          [file]: content
            .replace('target()', 'renamed()')
            .replace('target();', 'renamed();')
            .replace('def target', 'def renamed')
            .replace('\ntarget()', '\nrenamed()'),
        },
        'target',
        kind,
        'renamed',
      );
    },
    60000,
  );

  it.each([
    [
      'model.php',
      '<?php\nclass Target { public function __construct() {} }\n$value = new Target();\n',
      'Target',
      'Class',
    ],
    [
      'model.rb',
      'class Target\n def initialize\n end\nend\nvalue = Target.new\n',
      'Target',
      'Class',
    ],
  ])(
    'renames classes while retaining constructor names in %s',
    async (file, content, name, kind) => {
      await expectRename(
        { [file]: content },
        { [file]: content.replaceAll('Target', 'Renamed') },
        name,
        kind,
        'Renamed',
      );
    },
    60000,
  );

  it.each([
    [
      'model.php',
      '<?php\nclass Worker { public function target() {} public function call() { $this->target(); } }\n$value = new Worker();\n$value->target();\n',
    ],
    [
      'model.rb',
      'class Worker\n def target\n end\n def call\n  self.target()\n end\nend\nvalue = Worker.new\nvalue.target()\n',
    ],
  ])(
    'renames members on this/self and constructed receivers in %s',
    async (file, content) => {
      await expectRename(
        { [file]: content },
        { [file]: content.replaceAll('target', 'renamed') },
        'target',
        'Method',
        'renamed',
      );
    },
    60000,
  );

  it('keeps PHP explicit function aliases stable', async () => {
    const files = {
      'composer.json': '{"autoload":{"psr-4":{"Source\\\\":"Source/"}}}',
      'Source/functions.php': '<?php\nnamespace Source;\nfunction target() {}\n',
      'caller.php': '<?php\nuse function Source\\target as local;\nlocal();\n',
    };
    await expectRename(
      files,
      {
        'Source/functions.php': files['Source/functions.php'].replace('target', 'renamed'),
        'caller.php': files['caller.php'].replace('target', 'renamed'),
      },
      'target',
      'Function',
      'renamed',
    );
  }, 60000);

  it('renames Ruby required constants', async () => {
    const files = {
      'source.rb': 'class Target\nend\n',
      'caller.rb': 'require_relative "source"\nvalue = Target.new\n',
    };
    await expectRename(
      files,
      Object.fromEntries(
        Object.entries(files).map(([file, content]) => [
          file,
          content.replaceAll('Target', 'Renamed'),
        ]),
      ),
      'Target',
      'Class',
      'Renamed',
    );
  }, 60000);

  it('uses PHP case-insensitive callable names without folding variables', async () => {
    const content =
      '<?php\nfunction Target() {}\nTARGET();\ntarget();\n$Target = 1;\n$target = 2;\n';
    await expectRename(
      { 'model.php': content },
      {
        'model.php':
          '<?php\nfunction renamed() {}\nrenamed();\nrenamed();\n$Target = 1;\n$target = 2;\n',
      },
      'Target',
      'Function',
      'renamed',
    );
  }, 60000);

  it('uses PHP case-insensitive member names without folding properties', async () => {
    const content =
      '<?php\nclass Worker { public int $Target; public int $target; public function Target() {} public function call() { $this->TARGET(); $this->target; $this->Target; } }\n';
    await expectRename(
      { 'model.php': content },
      {
        'model.php': content
          .replace('function Target()', 'function renamed()')
          .replace('->TARGET()', '->renamed()'),
      },
      'Target',
      'Method',
      'renamed',
    );
  }, 60000);

  it('keeps PHP properties case-sensitive', async () => {
    const content =
      '<?php\nclass Worker { public int $target; public int $Target; public function call() { $this->target = 1; return $this->Target + $this->target; } }\n';
    await expectRename(
      { 'model.php': content },
      {
        'model.php': content.replaceAll('$target', '$renamed').replaceAll('->target', '->renamed'),
      },
      'target',
      'Property',
      'renamed',
    );
  }, 60000);

  it('keeps grouped PHP aliases stable', async () => {
    const files = {
      'composer.json': '{"autoload":{"psr-4":{"Source\\\\":"Source/"}}}',
      'Source/functions.php':
        '<?php\nnamespace Source;\nfunction target() {}\nfunction other() {}\n',
      'caller.php': '<?php\nuse function Source\\{target as local, other};\nlocal(); other();\n',
    };
    await expectRename(
      files,
      Object.fromEntries(
        Object.entries(files).map(([file, content]) => [
          file,
          content.replace('target', 'renamed'),
        ]),
      ),
      'target',
      'Function',
      'renamed',
    );
  }, 60000);

  it.each([
    ['target?', 'renamed!'],
    ['target!', 'renamed?'],
  ])(
    'renames Ruby punctuation method %s',
    async (name, newName) => {
      const content = `class Worker\n def ${name}\n end\nend\nvalue = Worker.new\nvalue.${name}()\n`;
      await expectRename(
        { 'model.rb': content },
        { 'model.rb': content.replaceAll(name, newName) },
        name,
        'Method',
        newName,
      );
    },
    60000,
  );

  it('preserves Ruby block parameter shadows and unrelated indexed reads', async () => {
    const content =
      'def target\nend\n[1].each { |target| puts target }\ntarget()\nvalues = [1]\nvalues[0]\n';
    await expectRename(
      { 'model.rb': content },
      { 'model.rb': content.replace('def target', 'def renamed').replace('target()', 'renamed()') },
      'target',
      'Method',
      'renamed',
    );
  }, 60000);

  it.each([
    [
      'model.php',
      '<?php\ninterface Contract { public function target(); }\nclass Worker implements Contract { public function target() {} }\nfunction call(Contract $value) { $value->target(); }\n',
    ],
    [
      'model.rb',
      'module Contract\n def target\n end\nend\nclass Worker\n include Contract\n def target\n end\nend\nvalue = Worker.new\nvalue.target()\n',
    ],
  ])(
    'renames graph-proven method families in %s',
    async (file, content) => {
      await expectRename(
        { [file]: content },
        { [file]: content.replaceAll('target', 'renamed') },
        'target',
        'Method',
        'renamed',
      );
    },
    60000,
  );

  it.each([
    ['model.php', '<?php\nfunction target() {}\nfunction renamed() {}\ntarget();\n', 'Function'],
    ['model.rb', 'def target\nend\ndef renamed\nend\ntarget()\n', 'Method'],
  ])(
    'rejects declaration capture without writing %s',
    async (file, content, kind) => {
      const { root, nodes, symbol } = await fixture({ [file]: content }, 'target', kind);
      const result = await renameSymbol(
        root,
        symbol,
        { new_name: 'renamed', dry_run: false },
        nodes,
      );
      expect(result).toMatchObject({ status: 'error', applied: false, code: 'name_collision' });
      expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content);
    },
    60000,
  );

  it('preserves Ruby relative and load-path import distinctions', async () => {
    const resolver = SCOPE_RESOLVERS.get(SupportedLanguages.Ruby)!;
    const source = await resolver.languageProvider.rename!.parseSource({
      filePath: 'caller.rb',
      content: 'require_relative "source"\nrequire "source"\n',
      languageProvider: resolver.languageProvider,
      scopeResolver: resolver,
    });
    expect(source.parsed.parsedImports.map((entry) => entry.targetRaw)).toEqual([
      './source',
      'source',
    ]);
  });

  it('renames PHP class spellings case-insensitively', async () => {
    const content =
      '<?php\nclass Target { public function __construct() {} }\n$value = new TARGET();\nfunction call(target $value): Target { return $value; }\n';
    await expectRename(
      { 'model.php': content },
      {
        'model.php': content
          .replaceAll('Target', 'Renamed')
          .replace('TARGET', 'Renamed')
          .replace('call(target ', 'call(Renamed '),
      },
      'Target',
      'Class',
      'Renamed',
    );
  }, 60000);

  it('renames Ruby qualified constants without changing unrelated owners', async () => {
    const content =
      'module Outer\n class Target\n end\nend\nmodule Other\n class Target\n end\nend\nfirst = Outer::Target.new\nsecond = Other::Target.new\n';
    await expectRename(
      { 'model.rb': content },
      {
        'model.rb': content
          .replace('class Target', 'class Renamed')
          .replace('Outer::Target', 'Outer::Renamed'),
      },
      'Target',
      'Class',
      'Renamed',
    );
  }, 60000);

  it('renames Ruby setters through assignment syntax', async () => {
    const content =
      'class Worker\n def target=(value)\n end\nend\nworker = Worker.new\nworker.target = 1\n';
    await expectRename(
      { 'model.rb': content },
      { 'model.rb': content.replaceAll('target', 'renamed') },
      'target=',
      'Method',
      'renamed=',
    );
  }, 60000);

  it('distinguishes Ruby singleton and instance methods', async () => {
    const content =
      'class Worker\n def target\n end\n def self.target\n end\nend\nworker = Worker.new\nworker.target()\nWorker.target()\n';
    await expectRename(
      { 'model.rb': content },
      {
        'model.rb': content
          .replace('def target', 'def renamed')
          .replace('worker.target()', 'worker.renamed()'),
      },
      'target',
      'Method',
      'renamed',
    );
  }, 60000);

  it('renames Ruby extended module methods through singleton receivers', async () => {
    const content =
      'module Contract\n def target\n end\nend\nclass Worker\n extend Contract\nend\nWorker.target()\n';
    await expectRename(
      { 'model.rb': content },
      { 'model.rb': content.replaceAll('target', 'renamed') },
      'target',
      'Method',
      'renamed',
    );
  }, 60000);

  it.each([
    [
      'model.php',
      '<?php\nclass Worker { public function target() {} }\n$value = new Worker();\n$name = "target";\n$value->$name();\n',
    ],
    ['model.rb', 'class Worker\n def target\n end\nend\nvalue = Worker.new\nvalue.send(:target)\n'],
  ])(
    'refuses dynamic member references to the selected owner in %s',
    async (file, content) => {
      const { root, nodes, symbol } = await fixture({ [file]: content }, 'target', 'Method');
      const result = await renameSymbol(
        root,
        symbol,
        { new_name: 'renamed', dry_run: false },
        nodes,
      );
      expect(result).toMatchObject({
        status: 'error',
        applied: false,
        code: 'unsupported_occurrence',
      });
      expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content);
    },
    60000,
  );

  it.each([
    ['model.php', '<?php\nfunction target() {}\n$fn = "target";\n$fn();\n', 'Function'],
    ['model.rb', 'def target\nend\nsend(:target)\n', 'Method'],
  ])(
    'refuses dynamic free calls to the selected declaration in %s',
    async (file, content, kind) => {
      const { root, nodes, symbol } = await fixture({ [file]: content }, 'target', kind);
      const result = await renameSymbol(
        root,
        symbol,
        { new_name: 'renamed', dry_run: false },
        nodes,
      );
      expect(result).toMatchObject({
        status: 'error',
        applied: false,
        code: 'unsupported_occurrence',
      });
      expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content);
    },
    60000,
  );

  it.each([
    [
      'model.php',
      '<?php\nclass Worker { public function target() {} }\nclass Other { public function target() {} }\n$value = new Worker();\n$value->target();\n$other = new Other();\n$name = "target";\n$other->$name();\n',
    ],
    [
      'model.rb',
      'class Worker\n def target\n end\nend\nclass Other\n def target\n end\nend\nvalue = Worker.new\nvalue.target()\nother = Other.new\nother.send(:target)\n',
    ],
  ])(
    'allows dynamic references proven to belong to unrelated owners in %s',
    async (file, content) => {
      await expectRename(
        { [file]: content },
        {
          [file]: content
            .replace('function target()', 'function renamed()')
            .replace('def target', 'def renamed')
            .replace('value->target()', 'value->renamed()')
            .replace('value.target()', 'value.renamed()'),
        },
        'target',
        'Method',
        'renamed',
      );
    },
    60000,
  );
});

describe('PHP replacement identifier validation', () => {
  const validateName = phpRenameProvider.validateName;
  if (!validateName) throw new Error('Missing PHP identifier validator');

  // PHP labels accept every non-ASCII code point, so the guard targets only names that
  // render invisibly or reorder neighbouring source. Names are written with escapes so
  // this file carries no hidden characters itself.
  it.each([
    ['a right-to-left override', 'user\u202Eadmin'],
    ['a left-to-right embedding', 'user\u202Aadmin'],
    ['a bidirectional isolate', 'user\u2066admin'],
    ['a left-to-right mark', 'user\u200Eadmin'],
    ['a zero-width space', 'a\u200Bb'],
    ['a zero-width non-joiner', 'a\u200Cb'],
    ['a zero-width joiner', 'a\u200Db'],
    ['a word joiner', 'a\u2060b'],
    ['a leading byte order mark', '\uFEFFname'],
    ['a trailing byte order mark', 'name\uFEFF'],
    ['a C1 control character', 'a\u0085b'],
    ['a no-break space', 'a\u00A0b'],
    ['a line separator', 'a\u2028b'],
    ['a paragraph separator', 'a\u2029b'],
    ['a lone surrogate', 'a\uD800'],
    ['a private-use code point', 'a\uE000b'],
    ['a noncharacter', 'a\uFFFEb'],
  ])('rejects %s in a replacement name', (_label, name) => {
    expect(validateName(name)).toMatchObject({ code: 'invalid_name' });
  });

  it.each([
    ['a Latin letter with a diacritic', '\u00E9'],
    ['CJK letters', '\u65E5\u672C\u8A9E'],
    ['a leading underscore with a digit', '_x1'],
    ['a decomposed accent', 'e\u0301'],
    ['an astral letter', '\u{1D4B3}name'],
    ['mixed ASCII and non-ASCII letters', 'caf\u00E9_\u540D\u524D2'],
  ])('accepts %s in a replacement name', (_label, name) => {
    expect(validateName(name)).toBeUndefined();
  });

  it.each([
    ['a reserved word', 'class'],
    ['a reserved word in another case', 'CLASS'],
    ['a leading digit', '1name'],
    ['an empty name', ''],
    ['a hyphen', 'a-b'],
    ['a leading dollar sign', '$name'],
  ])('keeps rejecting %s in a replacement name', (_label, name) => {
    expect(validateName(name)).toMatchObject({ code: 'invalid_name' });
  });

  it('refuses a bidirectional override before preview or apply', async () => {
    const content = '<?php\nfunction target() {}\ntarget();\n';
    const { root, nodes, symbol } = await fixture({ 'model.php': content }, 'target', 'Function');
    for (const dry_run of [true, false]) {
      const result = await renameSymbol(
        root,
        symbol,
        { new_name: 'safe\u202Eevil', dry_run },
        nodes,
      );
      expect(result).toMatchObject({
        status: 'error',
        code: 'invalid_name',
        applied: false,
        total_edits: 0,
      });
      expect(await fs.readFile(path.join(root, 'model.php'), 'utf8')).toBe(content);
    }
  }, 60000);
});
