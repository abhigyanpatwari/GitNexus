import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { planGraphRename } from '../../src/mcp/local/rename/graph-rename.js';
import { renameSymbol } from '../../src/mcp/local/rename/rename-plan.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string>, qualifiedName: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-objc-'));
  roots.push(root);
  await Promise.all(
    Object.entries(files).map(([file, content]) => fs.writeFile(path.join(root, file), content)),
  );
  const result = await runPipelineFromRepo(root, () => undefined, {
    workerPoolSize: 1,
    skipGraphPhases: true,
  });
  const nodes = [...result.graph.iterNodes()];
  const target = nodes.find((node) => node.properties.qualifiedName === qualifiedName)!;
  expect(target).toBeDefined();
  const symbol = {
    uid: target.id,
    name: target.properties.name,
    filePath: target.properties.filePath,
    startLine: target.properties.startLine! + 1,
    endLine: target.properties.endLine! + 1,
    kind: target.label,
  };
  return { root, nodes, symbol };
}

describe('Objective-C semantic rename from the production parsing pipeline', () => {
  it('renames a class through forward declarations, categories, annotations and class receivers', async () => {
    const files = {
      'Worker.h':
        '@class Worker;\n@interface Worker\n+ (id)build;\n@end\n@interface Worker (Extra)\n- (void)run;\n@end\n',
      'Worker.m':
        '#import "Worker.h"\n// 😀 Worker\n@implementation Worker\n+ (id)build { return nil; }\n- (void)accept:(Worker *)worker { Worker *local = worker; [Worker build]; }\n@end\n@implementation Worker (Extra)\n- (void)run {}\n@end\n',
    };
    const { root, nodes, symbol } = await fixture(files, 'objc:class:Worker');
    const result = await renameSymbol(root, symbol, { new_name: 'Agent', dry_run: false }, nodes);
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true });
    expect(await fs.readFile(path.join(root, 'Worker.h'), 'utf8')).toBe(
      files['Worker.h'].replaceAll('Worker', 'Agent'),
    );
    expect(await fs.readFile(path.join(root, 'Worker.m'), 'utf8')).toBe(
      files['Worker.m']
        .replaceAll('Worker', 'Agent')
        .replace('"Agent.h"', '"Worker.h"')
        .replace('// 😀 Agent', '// 😀 Worker'),
    );
  }, 60000);

  it('renames a C helper and its uses while preserving a shadowing parameter', async () => {
    const content =
      'static int helper(int value) { return value; }\nint caller(void) { return helper(1); }\nint shadow(int helper) { return helper; }\nint indirect(int (*helper)(int)) { return helper(1); }\nint multiple(void) { int first = 1, helper = 2; return helper; }\nint ordered(void) { helper(1); int helper = 2; return helper; }\nint external(int helper);\n';
    const { root, nodes, symbol } = await fixture(
      { 'Helpers.m': content },
      'objc:function:static:Helpers.m:helper',
    );
    const result = await renameSymbol(
      root,
      symbol,
      { new_name: 'calculate', dry_run: false },
      nodes,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 3 });
    expect(await fs.readFile(path.join(root, 'Helpers.m'), 'utf8')).toBe(
      content
        .replace('int helper(', 'int calculate(')
        .replace('return helper(1)', 'return calculate(1)')
        .replace('{ helper(1); int helper', '{ calculate(1); int helper'),
    );
  }, 60000);

  it('renames a protocol selector together with conforming implementations and inherited overrides', async () => {
    const content =
      '@protocol Runnable\n- (void)run;\n@end\n@interface Worker <Runnable>\n- (void)run;\n@end\n@interface Child : Worker\n- (void)run;\n@end\n@implementation Worker\n- (void)run {}\n- (void)use:(id<Runnable>)worker { [worker run]; }\n@end\n@implementation Child\n- (void)run { [super run]; [self run]; }\n@end\n@interface Other\n- (void)run;\n@end\n';
    const { root, nodes, symbol } = await fixture(
      { 'Worker.m': content },
      'objc:method:objc:protocol:Runnable:-:run',
    );
    const result = await renameSymbol(root, symbol, { new_name: 'execute', dry_run: false }, nodes);
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true });
    expect(await fs.readFile(path.join(root, 'Worker.m'), 'utf8')).toBe(
      content
        .replaceAll('run', 'execute')
        .replace('@interface Other\n- (void)execute;', '@interface Other\n- (void)run;'),
    );
  }, 60000);

  it('blocks an unresolved dynamic send of the selected selector', async () => {
    const content =
      '@interface Worker\n- (void)run;\n@end\n@implementation Worker\n- (void)run {}\n- (void)use:(id)worker { [worker run]; }\n@end\n';
    const { root, nodes, symbol } = await fixture(
      { 'Worker.m': content },
      'objc:method:objc:class:Worker:-:run',
    );
    const result = await renameSymbol(root, symbol, { new_name: 'execute', dry_run: false }, nodes);
    expect(result, JSON.stringify(result)).toMatchObject({
      applied: false,
      code: 'ambiguous_reference',
    });
    expect(await fs.readFile(path.join(root, 'Worker.m'), 'utf8')).toBe(content);
  }, 60000);

  it('renames a property, ordinary accessors and its synthesized backing ivar on the owning class', async () => {
    const content =
      '@interface Worker\n@property int value;\n@end\n@interface Other\n@property int value;\n@end\n@implementation Worker\n@synthesize value = _value;\n- (int)value { return _value; }\n- (void)setValue:(int)value { _value = value; }\n- (void)run:(Worker *)worker other:(Other *)other { self.value = 1; worker.value = 2; other.value = 3; [self setValue:4]; [worker value]; }\n@end\n';
    const { root, nodes, symbol } = await fixture(
      { 'Worker.m': content },
      'objc:property:objc:class:Worker:value',
    );
    const result = await renameSymbol(root, symbol, { new_name: 'count', dry_run: false }, nodes);
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true });
    expect(await fs.readFile(path.join(root, 'Worker.m'), 'utf8')).toBe(
      '@interface Worker\n@property int count;\n@end\n@interface Other\n@property int value;\n@end\n@implementation Worker\n@synthesize count = _count;\n- (int)count { return _count; }\n- (void)setCount:(int)value { _count = value; }\n- (void)run:(Worker *)worker other:(Other *)other { self.count = 1; worker.count = 2; other.value = 3; [self setCount:4]; [worker count]; }\n@end\n',
    );
  }, 60000);

  it('renames an ivar and its accesses while preserving a local shadow', async () => {
    const content =
      '@interface Worker { int _value; }\n@end\n@implementation Worker\n- (int)read { return _value; }\n- (int)shadow:(int)_value { return _value; }\n- (int)multiple { int first = 1, _value = 2; return _value; }\n- (void)block { void (^block)(int) = ^(int _value) { (void)_value; }; }\n@end\n';
    const { root, nodes, symbol } = await fixture(
      { 'Worker.m': content },
      'objc:ivar:objc:class:Worker:_value',
    );
    const result = await renameSymbol(root, symbol, { new_name: '_count', dry_run: false }, nodes);
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 2 });
    expect(await fs.readFile(path.join(root, 'Worker.m'), 'utf8')).toBe(
      content.replace('int _value;', 'int _count;').replace('return _value;', 'return _count;'),
    );
  }, 60000);

  it('preserves a block parameter whose type owns an unrelated same-name selector', async () => {
    const content =
      '@interface Worker\n- (void)run;\n@end\n@interface Other\n- (void)run;\n@end\n@implementation Worker\n- (void)run {}\n- (void)use:(Worker *)worker { [worker run]; void (^block)(Other *) = ^(Other *worker) { [worker run]; }; }\n@end\n';
    const { root, nodes, symbol } = await fixture(
      { 'Worker.m': content },
      'objc:method:objc:class:Worker:-:run',
    );
    const result = await renameSymbol(root, symbol, { new_name: 'execute', dry_run: false }, nodes);
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 3 });
    expect(await fs.readFile(path.join(root, 'Worker.m'), 'utf8')).toBe(
      content
        .replace('- (void)run;', '- (void)execute;')
        .replace('- (void)run {}', '- (void)execute {}')
        .replace('[worker run]', '[worker execute]'),
    );
  }, 60000);

  it('renames category selector declarations and implementations through typed calls', async () => {
    const content =
      '@interface Worker\n@end\n@interface Worker (Extra)\n- (void)trace;\n@end\n@implementation Worker (Extra)\n- (void)trace {}\n- (void)run { [self trace]; }\n@end\n@interface Other\n- (void)trace;\n@end\n';
    const { root, nodes, symbol } = await fixture(
      { 'Worker.m': content },
      'objc:method:objc:category:Worker:Extra:-:trace',
    );
    const result = await renameSymbol(root, symbol, { new_name: 'record', dry_run: false }, nodes);
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 3 });
    expect(await fs.readFile(path.join(root, 'Worker.m'), 'utf8')).toBe(
      content
        .replaceAll('trace', 'record')
        .replace('@interface Other\n- (void)record;', '@interface Other\n- (void)trace;'),
    );
  }, 60000);

  it('renames a category name on its host while preserving another host category', async () => {
    const content =
      '@interface Worker\n@end\n@interface Worker (Extra)\n@end\n@implementation Worker (Extra)\n@end\n@interface Other\n@end\n@interface Other (Extra)\n@end\n';
    const { root, nodes, symbol } = await fixture(
      { 'Worker.m': content },
      'objc:category:Worker:Extra',
    );
    const result = await renameSymbol(root, symbol, { new_name: 'Tracing', dry_run: false }, nodes);
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 2 });
    expect(await fs.readFile(path.join(root, 'Worker.m'), 'utf8')).toBe(
      content.replaceAll('Worker (Extra)', 'Worker (Tracing)'),
    );
  }, 60000);

  it('renames a protocol name in conformance and qualified object annotations', async () => {
    const content =
      '@protocol Runnable\n- (void)run;\n@end\n@interface Worker <Runnable>\n- (void)use:(id<Runnable>)other;\n@end\n';
    const { root, nodes, symbol } = await fixture(
      { 'Worker.m': content },
      'objc:protocol:Runnable',
    );
    const result = await renameSymbol(
      root,
      symbol,
      { new_name: 'Executable', dry_run: false },
      nodes,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 3 });
    expect(await fs.readFile(path.join(root, 'Worker.m'), 'utf8')).toBe(
      content.replaceAll('Runnable', 'Executable'),
    );
  }, 60000);

  it('renames the entire static selector family when a category replaces a host method', async () => {
    const content =
      '@interface Worker\n- (void)run;\n@end\n@interface Worker (Extra)\n- (void)run;\n@end\n@implementation Worker\n- (void)run {}\n- (void)call { [self run]; }\n@end\n@implementation Worker (Extra)\n- (void)run {}\n@end\n';
    const { root, nodes, symbol } = await fixture(
      { 'Worker.m': content },
      'objc:method:objc:class:Worker:-:run',
    );
    const result = await renameSymbol(root, symbol, { new_name: 'execute', dry_run: false }, nodes);
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 5 });
    expect(await fs.readFile(path.join(root, 'Worker.m'), 'utf8')).toBe(
      content.replaceAll('run', 'execute'),
    );
  }, 60000);

  it('keeps protocol and inherited property contracts in the same rename family', async () => {
    const content =
      '@protocol HasValue\n@property int value;\n@end\n@interface Worker <HasValue>\n@property int value;\n@end\n@interface Child : Worker\n@property int value;\n@end\n@implementation Child\n- (void)run:(id<HasValue>)other { self.value = other.value; }\n@end\n';
    const { root, nodes, symbol } = await fixture(
      { 'Worker.m': content },
      'objc:property:objc:protocol:HasValue:value',
    );
    const result = await renameSymbol(root, symbol, { new_name: 'count', dry_run: false }, nodes);
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 5 });
    expect(await fs.readFile(path.join(root, 'Worker.m'), 'utf8')).toBe(
      content.replaceAll('int value;', 'int count;').replaceAll('.value', '.count'),
    );
  }, 60000);

  it('blocks a selector literal that has no statically bound owner', async () => {
    const content =
      '@interface Worker\n- (void)send:(int)value completion:(int)done;\n@end\n@implementation Worker\n- (void)send:(int)value completion:(int)done {}\n- (void)run { [self performSelector:@selector(send:completion:)]; }\n@end\n';
    const { root, nodes, symbol } = await fixture(
      { 'Worker.m': content },
      'objc:method:objc:class:Worker:-:send:completion:',
    );
    const result = await renameSymbol(
      root,
      symbol,
      { new_name: 'deliver:finished:', dry_run: false },
      nodes,
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      applied: false,
      code: 'unsupported_symbol_family',
    });
    expect(await fs.readFile(path.join(root, 'Worker.m'), 'utf8')).toBe(content);
  }, 60000);

  it('blocks custom accessor property contracts with an explicit reason', async () => {
    const content =
      '@interface Worker\n@property(getter=enabled, setter=assignFlag:) int flag;\n@end\n';
    const { root, nodes, symbol } = await fixture(
      { 'Worker.m': content },
      'objc:property:objc:class:Worker:flag',
    );
    const result = await renameSymbol(root, symbol, { new_name: 'active', dry_run: false }, nodes);
    expect(result, JSON.stringify(result)).toMatchObject({
      applied: false,
      code: 'unsupported_symbol_family',
    });
    expect(await fs.readFile(path.join(root, 'Worker.m'), 'utf8')).toBe(content);
  }, 60000);

  it('renames automatically synthesized accessors and backing storage', async () => {
    const content =
      '@interface Worker\n@property int value;\n@end\n@implementation Worker\n- (void)run { _value = 1; [self setValue:2]; self.value; }\n@end\n';
    const { root, nodes, symbol } = await fixture(
      { 'Worker.m': content },
      'objc:property:objc:class:Worker:value',
    );
    const result = await renameSymbol(root, symbol, { new_name: 'count', dry_run: false }, nodes);
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 4 });
    expect(await fs.readFile(path.join(root, 'Worker.m'), 'utf8')).toBe(
      content
        .replace('int value;', 'int count;')
        .replace('_value', '_count')
        .replace('setValue:', 'setCount:')
        .replace('self.value', 'self.count'),
    );
  }, 60000);

  it('renames the coupled property when the selected symbol is its ordinary setter', async () => {
    const content =
      '@interface Worker\n@property int value;\n- (void)setValue:(int)value;\n@end\n@implementation Worker\n- (void)run { _value = 1; [self setValue:2]; }\n@end\n';
    const { root, nodes, symbol } = await fixture(
      { 'Worker.m': content },
      'objc:method:objc:class:Worker:-:setValue:',
    );
    const result = await renameSymbol(
      root,
      symbol,
      { new_name: 'setCount:', dry_run: false },
      nodes,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 4 });
    expect(await fs.readFile(path.join(root, 'Worker.m'), 'utf8')).toBe(
      content
        .replace('int value;', 'int count;')
        .replaceAll('setValue:', 'setCount:')
        .replace('_value', '_count'),
    );
  }, 60000);

  it('preserves an explicitly named backing ivar when renaming its property', async () => {
    const content =
      '@interface Worker { int storage; }\n@property int value;\n@end\n@implementation Worker\n@synthesize value = storage;\n- (void)run { storage = 1; self.value = 2; }\n@end\n';
    const { root, nodes, symbol } = await fixture(
      { 'Worker.m': content },
      'objc:property:objc:class:Worker:value',
    );
    const result = await renameSymbol(root, symbol, { new_name: 'count', dry_run: false }, nodes);
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 3 });
    expect(await fs.readFile(path.join(root, 'Worker.m'), 'utf8')).toBe(
      content.replaceAll('value', 'count'),
    );
  }, 60000);

  it('renames a readonly public property together with its readwrite extension', async () => {
    const content =
      '@interface Worker\n@property(readonly) int value;\n@end\n@interface Worker ()\n@property(readwrite) int value;\n@end\n@implementation Worker\n- (void)run { [self setValue:1]; self.value; }\n@end\n';
    const { root, nodes, symbol } = await fixture(
      { 'Worker.m': content },
      'objc:property:objc:class:Worker:value',
    );
    const result = await renameSymbol(root, symbol, { new_name: 'count', dry_run: false }, nodes);
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 4 });
    expect(await fs.readFile(path.join(root, 'Worker.m'), 'utf8')).toBe(
      content
        .replaceAll('int value;', 'int count;')
        .replace('setValue:', 'setCount:')
        .replace('self.value', 'self.count'),
    );
  }, 60000);

  it('blocks a property whose accessors are supplied at runtime', async () => {
    const content =
      '@interface Worker\n@property int value;\n@end\n@implementation Worker\n@dynamic value;\n@end\n';
    const { root, nodes, symbol } = await fixture(
      { 'Worker.m': content },
      'objc:property:objc:class:Worker:value',
    );
    const result = await renameSymbol(root, symbol, { new_name: 'count', dry_run: false }, nodes);
    expect(result, JSON.stringify(result)).toMatchObject({
      applied: false,
      code: 'unsupported_symbol_family',
    });
    expect(await fs.readFile(path.join(root, 'Worker.m'), 'utf8')).toBe(content);
  }, 60000);

  it('rejects a property rename that would capture an existing setter', async () => {
    const content = '@interface Worker\n@property int value;\n- (void)setCount:(int)count;\n@end\n';
    const { root, nodes, symbol } = await fixture(
      { 'Worker.m': content },
      'objc:property:objc:class:Worker:value',
    );
    const result = await renameSymbol(root, symbol, { new_name: 'count', dry_run: false }, nodes);
    expect(result, JSON.stringify(result)).toMatchObject({
      applied: false,
      code: 'name_collision',
    });
    expect(await fs.readFile(path.join(root, 'Worker.m'), 'utf8')).toBe(content);
  }, 60000);

  it('applies multipart selector changes across header, implementation and typed sends, preserving other owners and method kinds', async () => {
    const files = {
      'Worker.h':
        '@interface Worker\n- (void)send:(int)value completion:(int)done;\n+ (void)send:(int)value completion:(int)done;\n@end\n@interface Other\n- (void)send:(int)value completion:(int)done;\n@end\n',
      'Worker.m':
        '#import "Worker.h"\n@implementation Worker\n- (void)send:(int)value completion:(int)done {}\n+ (void)send:(int)value completion:(int)done {}\n- (void)run:(Worker *)worker other:(Other *)other {\n  [self send:1 completion:2];\n  [worker send:1 completion:2];\n  [other send:1 completion:2];\n  [Worker send:1 completion:2];\n}\n@end\n',
    };
    const { root, nodes, symbol } = await fixture(
      files,
      'objc:method:objc:class:Worker:-:send:completion:',
    );
    const result = await renameSymbol(
      root,
      symbol,
      { new_name: 'deliver:finished:', dry_run: false },
      nodes,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, total_edits: 8 });
    expect(await fs.readFile(path.join(root, 'Worker.h'), 'utf8')).toBe(
      files['Worker.h'].replace(
        '- (void)send:(int)value completion:',
        '- (void)deliver:(int)value finished:',
      ),
    );
    expect(await fs.readFile(path.join(root, 'Worker.m'), 'utf8')).toBe(
      files['Worker.m']
        .replace('- (void)send:(int)value completion:', '- (void)deliver:(int)value finished:')
        .replace('[self send:1 completion:2]', '[self deliver:1 finished:2]')
        .replace('[worker send:1 completion:2]', '[worker deliver:1 finished:2]'),
    );
  }, 60000);

  it('rejects a selector arity change without modifying either file', async () => {
    const files = {
      'Worker.m': '@interface Worker\n- (void)send:(int)value completion:(int)done;\n@end\n',
    };
    const { root, nodes, symbol } = await fixture(
      files,
      'objc:method:objc:class:Worker:-:send:completion:',
    );
    await expect(
      planGraphRename(root, symbol, { new_name: 'deliver:' }, nodes),
    ).rejects.toMatchObject({ code: 'invalid_name' });
    expect(await fs.readFile(path.join(root, 'Worker.m'), 'utf8')).toBe(files['Worker.m']);
  }, 60000);

  it('blocks a selector with an unnamed piece instead of treating it as a shorter selector', async () => {
    const content = '@interface Worker\n- (void)send:(int)a :(int)b;\n@end\n';
    const { root, nodes, symbol } = await fixture(
      { 'Worker.m': content },
      'objc:method:objc:class:Worker:-:send:',
    );
    const result = await renameSymbol(
      root,
      symbol,
      { new_name: 'deliver:', dry_run: false },
      nodes,
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      applied: false,
      code: 'unsupported_symbol_family',
    });
    expect(await fs.readFile(path.join(root, 'Worker.m'), 'utf8')).toBe(content);
  }, 60000);
});
