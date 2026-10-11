import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { renameSymbol } from '../../src/mcp/local/rename/rename-plan.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(
  files: Record<string, string>,
  name = 'target',
  kind = 'Function',
  file = 'App.vue',
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-vue-'));
  roots.push(root);
  await Promise.all(
    Object.entries(files).map(([name, content]) => fs.writeFile(path.join(root, name), content)),
  );
  const result = await runPipelineFromRepo(root, () => undefined, {
    workerPoolSize: 1,
    skipGraphPhases: true,
  });
  const nodes = [...result.graph.iterNodes()];
  const target = nodes.find(
    (node) =>
      node.properties.name === name && node.label === kind && node.properties.filePath === file,
  );
  expect(target, JSON.stringify(nodes)).toBeDefined();
  const symbol = {
    uid: target!.id,
    name: target!.properties.name,
    filePath: file,
    kind,
    startLine: target!.properties.startLine! + 1,
    endLine: target!.properties.endLine! + 1,
  };
  return { root, nodes, symbol };
}

async function expectRename(
  files: Record<string, string>,
  expected: Record<string, string>,
  name = 'target',
  kind = 'Function',
  file = 'App.vue',
  newName = 'renamed',
) {
  const { root, nodes, symbol } = await fixture(files, name, kind, file);
  const preview = await renameSymbol(root, symbol, { new_name: newName, dry_run: true }, nodes);
  expect(preview, JSON.stringify(preview)).toMatchObject({ status: 'success', applied: false });
  for (const [name, content] of Object.entries(files))
    expect(await fs.readFile(path.join(root, name), 'utf8')).toBe(content);
  const applied = await renameSymbol(root, symbol, { new_name: newName, dry_run: false }, nodes);
  expect(applied, JSON.stringify(applied)).toMatchObject({
    status: 'success',
    applied: true,
    changes: preview.changes,
  });
  for (const [name, content] of Object.entries(expected))
    expect(await fs.readFile(path.join(root, name), 'utf8')).toBe(content);
}

describe('Vue semantic rename through the production graph pipeline', () => {
  it('keeps custom raw blocks opaque until their exact escaped closing tag', async () => {
    const raw =
      '<docs.data>\nLiteral </docs.data.extra> text.\n<template>{{ target() }}</template>\n</docs.data>\n';
    await expectRename(
      {
        'App.vue':
          '<script setup>\nfunction target() {}\n</script>\n<template>{{ target() }}</template>\n' +
          raw,
      },
      {
        'App.vue':
          '<script setup>\nfunction renamed() {}\n</script>\n<template>{{ renamed() }}</template>\n' +
          raw,
      },
    );
  }, 60_000);

  it.each(['target', "'target()'", '"target()"', 'target()'])(
    'renames executable CSS v-bind(%s) at original offsets',
    async (binding) => {
      const content = `<script setup>\nfunction target() { return "red"; }\n</script>\n<style scoped>.box { color: v-bind(${binding}); }</style>\n`;
      await expectRename(
        { 'App.vue': content },
        { 'App.vue': content.replaceAll('target', 'renamed') },
      );
    },
    60000,
  );

  it('resolves CSS bindings before setup while preserving CSS comments, strings, and template locals', async () => {
    const content = `<style module lang="css">\r\n/* 🎨 v-bind(target) */\r\n.box { content: "v-bind(target)"; color: v-bind( target ); }\r\n</style>\r\n<template><div v-for="target in [1]">{{ target }}</div></template>\r\n<script setup>\r\nconst target = "red";\r\n</script>\r\n`;
    await expectRename(
      { 'App.vue': content },
      {
        'App.vue': content
          .replace('v-bind( target )', 'v-bind( renamed )')
          .replace('const target', 'const renamed'),
      },
      'target',
      'Const',
    );
  }, 60000);

  it('preserves JavaScript string literals and nested parentheses inside quoted CSS expressions', async () => {
    const content = `<script setup>\nfunction target(value) { return value; }\n</script>\n<style>.box { color: v-bind('target("target )")'); }</style>\n`;
    await expectRename(
      { 'App.vue': content },
      {
        'App.vue': content
          .replace('function target', 'function renamed')
          .replace('target("target )")', 'renamed("target )")'),
      },
    );
  }, 60000);

  it('renames imported CSS calls across the semantic source cohort', async () => {
    const files = {
      'api.ts': 'export function target() { return "red"; }\n',
      'App.vue': `<script setup>\nimport { target } from "./api";\n</script>\n<style>.box { color: v-bind('target()'); }</style>\n`,
    };
    await expectRename(
      files,
      {
        'api.ts': files['api.ts'].replace('target', 'renamed'),
        'App.vue': files['App.vue'].replaceAll('target', 'renamed'),
      },
      'target',
      'Function',
      'api.ts',
    );
  }, 60000);

  it.each([
    ['unmapped dialect', '<style lang="scss">.box { color: v-bind(target); }</style>'],
    ['external source', '<style src="./theme.css" />'],
    ['escaped expression', String.raw`<style>.box { color: v-bind('tar\u0067et()'); }</style>`],
    ['unquoted template literal', '<style>.box { color: v-bind(`value ${target()}`); }</style>'],
    ['unclosed binding', '<style>.box { color: v-bind(target; }</style>'],
    ['invalid expression', "<style>.box { color: v-bind('target('); }</style>"],
    ['callback capture', "<style>.box { color: v-bind('(renamed) => target()'); }</style>"],
  ])(
    'refuses CSS %s before applying any edits',
    async (_label, style) => {
      const content = `<script setup>\nfunction target() { return "red"; }\n</script>\n${style}\n`;
      const { root, nodes, symbol } = await fixture({ 'App.vue': content });
      for (const dry_run of [true, false]) {
        const result = await renameSymbol(root, symbol, { new_name: 'renamed', dry_run }, nodes);
        expect(result, JSON.stringify(result)).toMatchObject({
          status: 'error',
          applied: false,
          total_edits: 0,
        });
        expect(await fs.readFile(path.join(root, 'App.vue'), 'utf8')).toBe(content);
      }
    },
    60000,
  );

  it('preserves opaque custom block content containing markup examples', async () => {
    const content =
      '<script setup>\nfunction target() { return 1; }\n</script>\n<docs><template>{{ target() }}</template></docs>\n<template>{{ target() }}</template>\n';
    await expectRename(
      { 'App.vue': content },
      {
        'App.vue': content
          .replace('function target()', 'function renamed()')
          .replace('</docs>\n<template>{{ target() }}', '</docs>\n<template>{{ renamed() }}'),
      },
    );
  }, 60000);

  it('blocks external template sources before applying edits', async () => {
    const content =
      '<script setup>\nfunction target() { return 1; }\n</script>\n<template src="./external.html"></template>\n';
    const { root, nodes, symbol } = await fixture({ 'App.vue': content });
    for (const dry_run of [true, false]) {
      const result = await renameSymbol(root, symbol, { new_name: 'renamed', dry_run }, nodes);
      expect(result, JSON.stringify(result)).toMatchObject({
        status: 'error',
        applied: false,
        total_edits: 0,
      });
      expect(await fs.readFile(path.join(root, 'App.vue'), 'utf8')).toBe(content);
    }
  }, 60000);

  it('renames script setup bindings and template expressions at original SFC offsets', async () => {
    const content =
      '<template>\n  <button title="target" @click="target">target {{ target() }}</button>\n</template>\n<script setup lang="ts">\nfunction target() { return 1; }\nfunction other(target: number) { return target; }\nconst value = target;\n</script>\n<style>.target { color: red; }</style>\n';
    const expected = content
      .replace('@click="target"', '@click="renamed"')
      .replace('{{ target() }}', '{{ renamed() }}')
      .replace('function target()', 'function renamed()')
      .replace('= target;', '= renamed;');
    await expectRename({ 'App.vue': content }, { 'App.vue': expected });
  }, 60000);

  it.each(['js', 'ts'])(
    'renames normal %s script declarations with unrelated markup',
    async (lang) => {
      const content = `<template><div>target</div></template>\n<script lang="${lang}">\nexport function target() { return 1; }\nconst value = target;\n</script>\n`;
      await expectRename(
        { 'App.vue': content },
        {
          'App.vue': content
            .replace('function target()', 'function renamed()')
            .replace('= target;', '= renamed;'),
        },
      );
    },
    60000,
  );

  it('renames an imported function across TypeScript and Vue template uses', async () => {
    const files = {
      'api.ts': 'export function target() { return 1; }\n',
      'App.vue':
        '<script setup lang="ts">\nimport { target } from "./api";\n</script>\n<template><button @click="target">{{ target() }}</button></template>\n',
    };
    await expectRename(
      files,
      {
        'api.ts': files['api.ts'].replace('target', 'renamed'),
        'App.vue': files['App.vue'].replaceAll('target', 'renamed'),
      },
      'target',
      'Function',
      'api.ts',
    );
  }, 60000);

  it('preserves imported local aliases in script and template', async () => {
    const files = {
      'api.ts': 'export function target() { return 1; }\n',
      'App.vue':
        '<script setup>\nimport { target as local } from "./api";\nlocal();\n</script>\n<template><button @click="local">{{ local() }}</button></template>\n',
    };
    await expectRename(
      files,
      {
        'api.ts': files['api.ts'].replace('target', 'renamed'),
        'App.vue': files['App.vue'].replace('target as local', 'renamed as local'),
      },
      'target',
      'Function',
      'api.ts',
    );
  }, 60000);

  it('renames imported component bindings in both opening and closing tags', async () => {
    const files = {
      'api.ts': 'export class Target {}\n',
      'App.vue':
        '<script setup>\nimport { Target } from "./api";\n</script>\n<template><Target title="Target">Target</Target></template>\n',
    };
    await expectRename(
      files,
      {
        'api.ts': 'export class Renamed {}\n',
        'App.vue': files['App.vue']
          .replace('{ Target }', '{ Renamed }')
          .replace('<Target ', '<Renamed ')
          .replace('</Target>', '</Renamed>'),
      },
      'Target',
      'Class',
      'api.ts',
      'Renamed',
    );
  }, 60000);

  it('preserves template loop bindings and renames the outside use', async () => {
    const content =
      '<script setup>\nfunction target() { return 1; }\nconst items = [1];\n</script>\n<template><div v-for="target in items">{{ target }}</div>{{ target() }}</template>\n';
    await expectRename(
      { 'App.vue': content },
      {
        'App.vue': content
          .replace('function target()', 'function renamed()')
          .replace('{{ target() }}', '{{ renamed() }}'),
      },
    );
  }, 60000);

  it('preserves template slot scope and static v-pre markup', async () => {
    const content =
      '<script setup>\nfunction target() { return 1; }\n</script>\n<template><section v-slot="target">{{ target }}</section><div v-pre>{{ target() }}</div>{{ target() }}</template>\n';
    await expectRename(
      { 'App.vue': content },
      {
        'App.vue': content
          .replace('function target()', 'function renamed()')
          .replace('</div>{{ target() }}', '</div>{{ renamed() }}'),
      },
    );
  }, 60000);

  it.each(['jsx', 'tsx'])(
    'selects the embedded %s grammar without changing source positions',
    async (lang) => {
      const content = `<template><div /></template>\n<script setup lang="${lang}">\nfunction target() { return 1; }\nfunction render() { return <button onClick={target} />; }\n</script>\n`;
      await expectRename(
        { 'App.vue': content },
        {
          'App.vue': content
            .replace('function target()', 'function renamed()')
            .replace('{target}', '{renamed}'),
        },
      );
    },
    60000,
  );

  it('retains original coordinates when script setup precedes the normal script', async () => {
    const content =
      '<script setup lang="ts">\nfunction target() { return 1; }\nconst value = target;\n</script>\n<template>{{ target() }}</template>\n<script lang="ts">\nexport function other() { return 2; }\n</script>\n';
    await expectRename(
      { 'App.vue': content },
      { 'App.vue': content.replaceAll('target', 'renamed') },
    );
  }, 60000);

  it('preserves a same-spelled member and renames the bare template function', async () => {
    const content =
      '<script setup>\nfunction target() { return 1; }\nclass Other { target() { return 2; } }\nconst other = new Other();\n</script>\n<template>{{ other.target() }} {{ target() }}</template>\n';
    await expectRename(
      { 'App.vue': content },
      {
        'App.vue': content
          .replace('function target()', 'function renamed()')
          .replace('{{ target() }}', '{{ renamed() }}'),
      },
    );
  }, 60000);

  it('resolves a setup variable from a template before the script', async () => {
    const content =
      '<template>{{ target }}<input :value="target" /></template>\n<script setup>\nconst target = 1;\n</script>\n';
    await expectRename(
      { 'App.vue': content },
      { 'App.vue': content.replaceAll('target', 'renamed') },
      'target',
      'Const',
    );
  }, 60000);

  it('blocks a collision with a template loop binding', async () => {
    const content =
      '<script setup>\nfunction target() { return 1; }\nconst items = [1];\n</script>\n<template><div v-for="renamed in items">{{ target() }}</div></template>\n';
    const { root, nodes, symbol } = await fixture({ 'App.vue': content });
    for (const dry_run of [true, false]) {
      const result = await renameSymbol(root, symbol, { new_name: 'renamed', dry_run }, nodes);
      expect(result, JSON.stringify(result)).toMatchObject({
        status: 'error',
        applied: false,
        total_edits: 0,
      });
      expect(await fs.readFile(path.join(root, 'App.vue'), 'utf8')).toBe(content);
    }
  }, 60000);

  it('preserves destructured template aliases while renaming outside uses', async () => {
    const content =
      '<script setup>\nfunction target() { return 1; }\nconst items = [{ target: 2 }];\n</script>\n<template><div v-for="({ target }, index) in items">{{ target }} {{ index }}</div><slot v-slot="{ target: local }">{{ local }}</slot>{{ target() }}</template>\n';
    await expectRename(
      { 'App.vue': content },
      {
        'App.vue': content
          .replace('function target()', 'function renamed()')
          .replace('{{ target() }}', '{{ renamed() }}'),
      },
    );
  }, 60000);

  it('renames inline event statements and custom directive expressions', async () => {
    const content =
      '<script setup>\nfunction target() { return 1; }\n</script>\n<template><button @click="target(); target()" v-custom="target" v-bind="{ value: target }" /></template>\n';
    await expectRename(
      { 'App.vue': content },
      { 'App.vue': content.replaceAll('target', 'renamed') },
    );
  }, 60000);

  it('expands same-name bound props and renames dynamic directive arguments', async () => {
    const content =
      '<script setup>\nconst target = "title";\n</script>\n<template><div :target :[target]="1" /></template>\n';
    await expectRename(
      { 'App.vue': content },
      {
        'App.vue': content
          .replace('const target', 'const renamed')
          .replace(':target ', ':target="renamed" ')
          .replace('[target]', '[renamed]'),
      },
      'target',
      'Const',
    );
  }, 60000);

  it('renames components accessed through namespace imports in template tags', async () => {
    const files = {
      'api.ts': 'export class Target {}\n',
      'App.vue':
        '<script setup>\nimport * as Icons from "./api";\n</script>\n<template><Icons.Target></Icons.Target></template>\n',
    };
    await expectRename(
      files,
      {
        'api.ts': 'export class Renamed {}\n',
        'App.vue': files['App.vue'].replaceAll('Icons.Target', 'Icons.Renamed'),
      },
      'Target',
      'Class',
      'api.ts',
      'Renamed',
    );
  }, 60000);

  it('rejects capture by the implicit event binding', async () => {
    const content =
      '<script setup>\nfunction target() { return 1; }\n</script>\n<template><button @click="target()" /></template>\n';
    const { root, nodes, symbol } = await fixture({ 'App.vue': content });
    for (const dry_run of [true, false]) {
      const result = await renameSymbol(root, symbol, { new_name: '$event', dry_run }, nodes);
      expect(result, JSON.stringify(result)).toMatchObject({
        status: 'error',
        applied: false,
        total_edits: 0,
      });
      expect(await fs.readFile(path.join(root, 'App.vue'), 'utf8')).toBe(content);
    }
  }, 60000);

  it('renames kebab-case component bindings while preserving their spelling convention', async () => {
    const files = {
      'api.ts': 'export class TargetPanel {}\n',
      'App.vue':
        '<script setup>\nimport { TargetPanel } from "./api";\n</script>\n<template><target-panel title="TargetPanel"></target-panel></template>\n',
    };
    await expectRename(
      files,
      {
        'api.ts': 'export class RenamedPanel {}\n',
        'App.vue': files['App.vue']
          .replace('{ TargetPanel }', '{ RenamedPanel }')
          .replaceAll('target-panel', 'renamed-panel'),
      },
      'TargetPanel',
      'Class',
      'api.ts',
      'RenamedPanel',
    );
  }, 60000);

  it('rejects a capture at a template callback without applying changes', async () => {
    const content =
      '<script setup>\nfunction target() { return 1; }\n</script>\n<template><button @click="(renamed) => target()" /></template>\n';
    const { root, nodes, symbol } = await fixture({ 'App.vue': content });
    for (const dry_run of [true, false]) {
      const result = await renameSymbol(root, symbol, { new_name: 'renamed', dry_run }, nodes);
      expect(result, JSON.stringify(result)).toMatchObject({
        status: 'error',
        applied: false,
        total_edits: 0,
      });
      expect(await fs.readFile(path.join(root, 'App.vue'), 'utf8')).toBe(content);
    }
  }, 60000);
});
