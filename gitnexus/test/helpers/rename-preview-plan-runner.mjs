// Public rename calls against a real persisted index, including an untracked source.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runFullAnalysis } from '../../dist/core/run-analyze.js';
import { LocalBackend } from '../../dist/mcp/local/local-backend.js';
import * as adapter from '../../dist/core/lbug/lbug-adapter.js';

const [temporary, reportPath, mode, coldUid, coldToken] = process.argv.slice(2);
const root = path.join(temporary, 'repo');
const repo = 'rename-preview-plan';
const physicalTargets = mode.startsWith('physical-target');
if (mode === 'cold-apply') {
  const cold = new LocalBackend();
  try {
    assert.equal(await cold.init(), true);
    const result = await cold.callTool('rename', {
      repo,
      symbol_uid: coldUid,
      new_name: 'renamed',
      dry_run: false,
      plan_token: coldToken,
    });
    await fs.writeFile(reportPath, JSON.stringify(result));
  } finally {
    await cold.dispose();
  }
  process.exit();
}
const sources = {
  'a.ts': 'export function target() { return 1; }\n',
  'b.ts':
    "import { target } from './a';\nexport function tracked() { return target() + target(); }\n",
  'c.ts':
    "import { target } from './a';\nexport function untracked() { return target() + target(); }\n",
};
const configs = {
  'tsconfig.json': '{"extends":"./base.config.json"}',
  'base.config.json': '{"compilerOptions":{"baseUrl":".","paths":{"@entry":["./a.ts"]}}}',
  'package.json': '{"name":"original-package","private":true}',
};
if (mode === 'resolution-config') {
  sources['other.ts'] = 'export function target() { return 2; }\n';
  for (const file of ['b.ts', 'c.ts']) sources[file] = sources[file].replace("'./a'", "'@entry'");
}
if (mode === 'rust-config') {
  for (const file of Object.keys(sources)) delete sources[file];
  sources['lib.rs'] = 'pub fn target() -> i32 { 1 }\npub fn caller() -> i32 { target() }\n';
}
if (mode === 'large-evidence') {
  process.env.GITNEXUS_MAX_FILE_SIZE = '32768';
  sources['evidence1.ts'] = 'export const unrelated1 = 1;\n';
  sources['evidence2.ts'] = 'export const unrelated2 = 2;\n';
}
let backend;
try {
  await fs.mkdir(root);
  for (const [file, text] of Object.entries(sources))
    await fs.writeFile(path.join(root, file), text);
  if (mode === 'resolution-config')
    for (const [file, text] of Object.entries(configs))
      await fs.writeFile(path.join(root, file), text);
  if (mode === 'rust-config')
    await fs.writeFile(
      path.join(root, 'Cargo.toml'),
      '[package]\nname = "rename-config"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "lib.rs"\n',
    );
  if (physicalTargets) {
    await fs.rename(path.join(root, 'a.ts'), path.join(root, 'first.data'));
    await fs.writeFile(path.join(root, 'second.data'), sources['a.ts']);
    await fs.symlink(path.join(root, 'first.data'), path.join(root, 'a.ts'), 'file');
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync(
    'git',
    ['add', ...(mode === 'rust-config' ? ['lib.rs', 'Cargo.toml'] : ['a.ts', 'b.ts'])],
    { cwd: root },
  );
  const indexed = await runFullAnalysis(
    root,
    {
      force: true,
      useParseCache: false,
      skipFts: true,
      skipSkills: true,
      skipAgentsMd: true,
      embeddings: false,
      workerPoolSize: 1,
      registryName: repo,
    },
    { onProgress() {} },
  );
  if (mode === 'unindexed-evidence') {
    // These supported files exist before preview, but were never indexed.
    // Exercise both Git states without substituting a fake graph or planner.
    sources['existing-tracked.ts'] = 'export const trackedUnrelated = 1;\n';
    sources['existing-untracked.ts'] = 'export const untrackedUnrelated = 2;\n';
    for (const file of ['existing-tracked.ts', 'existing-untracked.ts'])
      await fs.writeFile(path.join(root, file), sources[file]);
    execFileSync('git', ['add', 'existing-tracked.ts'], { cwd: root });
  }
  if (physicalTargets) {
    sources['z-evidence.ts'] = 'export const evidence = 1;\n';
    await fs.writeFile(path.join(root, 'z-evidence.ts'), sources['z-evidence.ts']);
  }
  await adapter.initLbug(path.join(indexed.storagePath, 'lbug'), { skipFts: true });
  const targets = await adapter.executeQuery(
    "MATCH (n:Function) WHERE n.name = 'target' AND n.filePath = '" +
      (mode === 'rust-config' ? 'lib.rs' : 'a.ts') +
      "' RETURN n.id AS id",
  );
  assert.equal(targets.length, 1);
  const calls = await adapter.executeQuery(
    "MATCH (a)-[r:CodeRelation]->(b) WHERE r.type = 'CALLS' AND b.id = '" +
      targets[0].id +
      "' RETURN DISTINCT a.name AS name",
  );
  assert.deepEqual(
    calls.map((x) => x.name).sort(),
    mode === 'rust-config' ? ['caller'] : ['tracked', 'untracked'],
  );
  if (mode === 'large-evidence') {
    const evidence = await adapter.executeQuery(
      "MATCH (n) WHERE n.filePath IN ['evidence1.ts', 'evidence2.ts'] RETURN labels(n) AS kind, n.name AS name, n.filePath AS file",
    );
    for (let index = 1; index <= 2; index++) {
      const file = `evidence${index}.ts`;
      assert.ok(evidence.some((node) => node.file === file && node.kind === 'File'));
      assert.ok(evidence.some((node) => node.file === file && node.name === `unrelated${index}`));
      // Grow existing indexed sources before preview, as a normal local edit.
      // Rename plans against >64 MiB of semantic input without a large native COPY.
      sources[file] += '/*' + 'x'.repeat(20 * 1024 * 1024) + '*/\n';
      await fs.writeFile(path.join(root, file), sources[file]);
    }
  }
  if (mode === 'unindexed-evidence') {
    const unindexed = await adapter.executeQuery(
      "MATCH (n:File) WHERE n.filePath IN ['existing-tracked.ts', 'existing-untracked.ts'] RETURN n.filePath AS path",
    );
    assert.deepEqual(unindexed, []);
  }
  await adapter.closeLbug();
  backend = new LocalBackend();
  assert.equal(await backend.init(), true);
  const request = { repo, symbol_uid: targets[0].id, new_name: 'renamed' };
  const preview = () => backend.callTool('rename', { ...request, dry_run: true });
  const apply = (plan, extra = {}) =>
    backend.callTool('rename', {
      ...request,
      dry_run: false,
      plan_token: plan.plan_token,
      ...extra,
    });
  const unchanged = async () => {
    for (const [file, text] of Object.entries(sources))
      assert.equal(await fs.readFile(path.join(root, file), 'utf8'), text);
  };

  let plan;
  if (mode === 'rust-config') {
    plan = await preview();
    assert.equal(plan.status, 'success', JSON.stringify(plan));
    assert.equal(plan.total_edits, 2);
    const applied = await apply(plan);
    assert.equal(applied.status, 'success', JSON.stringify(applied));
    assert.deepEqual(applied.changes, plan.changes);
    assert.equal(
      await fs.readFile(path.join(root, 'lib.rs'), 'utf8'),
      sources['lib.rs'].replaceAll('target', 'renamed'),
    );
    await fs.writeFile(
      reportPath,
      JSON.stringify({ status: 'passed', nodes: indexed.stats.nodes }),
    );
    process.exit();
  }
  if (mode === 'resolution-config') {
    const cases = [
      [
        'direct paths',
        'tsconfig.json',
        '{"compilerOptions":{"baseUrl":".","paths":{"@entry":["./other.ts"]}}}',
      ],
      [
        'arbitrary inherited config',
        'base.config.json',
        '{"compilerOptions":{"baseUrl":".","paths":{"@entry":["./other.ts"]}}}',
      ],
      ['removed governing config', 'tsconfig.json', null],
      ['new nested config', 'nested/tsconfig.json', '{"compilerOptions":{"baseUrl":".."}}'],
      ['memoized workspace package', 'package.json', '{"name":"changed-package","private":true}'],
    ];
    for (const [label, file, text] of cases) {
      plan = await preview();
      assert.equal(plan.status, 'success', JSON.stringify({ label, plan }));
      assert.equal(plan.total_edits, 7);
      const absolute = path.join(root, file);
      if (text === null) await fs.unlink(absolute);
      else {
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, text);
      }
      const rejected = await apply(plan);
      assert.equal(rejected.code, 'resolution_changed', JSON.stringify({ label, rejected }));
      assert.equal(rejected.applied, false);
      await unchanged();
      if (Object.hasOwn(configs, file)) await fs.writeFile(absolute, configs[file]);
      else await fs.rm(path.dirname(absolute), { recursive: true });
    }
    plan = await preview();
    // Configuration semantics, rather than irrelevant formatting, bind the plan.
    await fs.appendFile(path.join(root, 'base.config.json'), '\n// comment-only change\n');
    const applied = await apply(plan);
    assert.equal(applied.status, 'success', JSON.stringify(applied));
    assert.deepEqual(applied.changes, plan.changes);
    for (const change of plan.changes) {
      let expected = sources[change.file_path];
      for (const edit of [...change.edits].sort((a, b) => b.start - a.start))
        expected =
          expected.slice(0, edit.start) + edit.new_text + expected.slice(edit.start + edit.length);
      assert.equal(await fs.readFile(path.join(root, change.file_path), 'utf8'), expected);
    }
    assert.equal(await fs.readFile(path.join(root, 'other.ts'), 'utf8'), sources['other.ts']);
    await fs.writeFile(
      reportPath,
      JSON.stringify({ status: 'passed', nodes: indexed.stats.nodes }),
    );
    process.exit();
  }
  if (physicalTargets) {
    // The graph and semantic planner remain real; an extra source path aliases
    // a reviewed destination and must be rejected before any capability is issued.
    if (mode === 'physical-targets') {
      const alias = path.join(root, 'alias.ts');
      await fs.symlink(path.join(root, 'a.ts'), alias, 'file');
      const ambiguous = await preview();
      assert.equal(ambiguous.code, 'duplicate_file', JSON.stringify(ambiguous));
      assert.equal(ambiguous.plan_token, undefined);
      await unchanged();
      await fs.unlink(alias);
    }
    plan = await preview();
    assert.equal(plan.status, 'success', JSON.stringify(plan));
    // Controlled filesystem race after take() has validated the edited a.ts,
    // while it reads a later evidence path. Identical bytes hide target drift
    // unless execution retains the preview's approved canonical destination.
    const originalRealpath = fs.realpath.bind(fs);
    let retargeted = false;
    fs.realpath = async (...args) => {
      if (!retargeted && String(args[0]) === path.join(root, 'z-evidence.ts')) {
        retargeted = true;
        await fs.unlink(path.join(root, 'a.ts'));
        await fs.symlink(path.join(root, 'second.data'), path.join(root, 'a.ts'), 'file');
      }
      return originalRealpath(...args);
    };
    let rejected;
    try {
      rejected = await apply(plan);
    } finally {
      fs.realpath = originalRealpath;
    }
    assert.equal(retargeted, true);
    assert.equal(rejected.code, 'source_changed', JSON.stringify(rejected));
    assert.equal(rejected.applied, false);
    await unchanged();
    for (const file of ['first.data', 'second.data'])
      assert.equal(await fs.readFile(path.join(root, file), 'utf8'), sources['a.ts']);
    await fs.unlink(path.join(root, 'a.ts'));
    await fs.symlink(path.join(root, 'first.data'), path.join(root, 'a.ts'), 'file');
    plan = await preview();
    const applied = await apply(plan);
    assert.equal(applied.status, 'success', JSON.stringify(applied));
    assert.deepEqual(applied.changes, plan.changes);
    for (const change of plan.changes) {
      let expected = sources[change.file_path];
      for (const edit of [...change.edits].sort((a, b) => b.start - a.start))
        expected =
          expected.slice(0, edit.start) + edit.new_text + expected.slice(edit.start + edit.length);
      assert.equal(await fs.readFile(path.join(root, change.file_path), 'utf8'), expected);
      if (change.file_path === 'a.ts')
        assert.equal(await fs.readFile(path.join(root, 'first.data'), 'utf8'), expected);
    }
    assert.equal(await fs.readFile(path.join(root, 'second.data'), 'utf8'), sources['a.ts']);
    await fs.writeFile(
      reportPath,
      JSON.stringify({ status: 'passed', nodes: indexed.stats.nodes }),
    );
    process.exit();
  }
  plan = await preview();
  assert.equal(plan.status, 'success', JSON.stringify(plan));
  assert.equal(
    typeof plan.plan_token,
    'string',
    'preview must bind later apply to an immutable plan',
  );
  assert.ok(plan.plan_token.length >= 32);
  if (mode === 'unindexed-evidence') {
    for (const file of ['existing-tracked.ts', 'existing-untracked.ts']) {
      plan = await preview();
      assert.equal(plan.status, 'success', JSON.stringify(plan));
      const reference = "import { target } from './a';\nexport const added = target();\n";
      await fs.writeFile(path.join(root, file), reference);
      const rejected = await apply(plan);
      assert.equal(rejected.code, 'source_changed', JSON.stringify(rejected));
      assert.equal(rejected.applied, false);
      assert.equal(await fs.readFile(path.join(root, file), 'utf8'), reference);
      for (const indexedFile of ['a.ts', 'b.ts', 'c.ts'])
        assert.equal(await fs.readFile(path.join(root, indexedFile), 'utf8'), sources[indexedFile]);
      await fs.writeFile(path.join(root, file), sources[file]);
    }
    plan = await preview();
    const applied = await apply(plan);
    assert.equal(applied.status, 'success', JSON.stringify(applied));
    assert.deepEqual(applied.changes, plan.changes);
    for (const change of plan.changes) {
      let expected = sources[change.file_path];
      for (const edit of [...change.edits].sort((a, b) => b.start - a.start))
        expected =
          expected.slice(0, edit.start) + edit.new_text + expected.slice(edit.start + edit.length);
      assert.equal(await fs.readFile(path.join(root, change.file_path), 'utf8'), expected);
    }
    for (const file of ['existing-tracked.ts', 'existing-untracked.ts'])
      assert.equal(await fs.readFile(path.join(root, file), 'utf8'), sources[file]);
    await backend.dispose();
    backend = undefined;
    await fs.writeFile(
      reportPath,
      JSON.stringify({ status: 'passed', nodes: indexed.stats.nodes }),
    );
    process.exit();
  }
  if (mode === 'large-evidence') {
    assert.equal(plan.coverage.source_file_count, 5);
    const originalTextBytes = Object.values(sources).reduce(
      (sum, source) => sum + source.length * 2,
      0,
    );
    assert.ok(originalTextBytes > 64 * 1024 * 1024);
    const evidenceFile = path.join(root, 'evidence1.ts');
    await fs.appendFile(evidenceFile, '// evidence changed after preview\n');
    const changed = await apply(plan);
    assert.equal(changed.code, 'source_changed', JSON.stringify(changed));
    assert.equal(changed.applied, false);
    await fs.writeFile(evidenceFile, sources['evidence1.ts']);
    plan = await preview();
    assert.equal(plan.status, 'success', JSON.stringify(plan));
    const applied = await apply(plan);
    assert.equal(applied.status, 'success', JSON.stringify(applied));
    assert.deepEqual(applied.changes, plan.changes);
    for (const file of ['evidence1.ts', 'evidence2.ts'])
      assert.equal(await fs.readFile(path.join(root, file), 'utf8'), sources[file]);
    for (const change of plan.changes) {
      let expected = sources[change.file_path];
      for (const edit of [...change.edits].sort((a, b) => b.start - a.start))
        expected =
          expected.slice(0, edit.start) + edit.new_text + expected.slice(edit.start + edit.length);
      assert.equal(await fs.readFile(path.join(root, change.file_path), 'utf8'), expected);
    }
    await backend.dispose();
    backend = undefined;
    await fs.writeFile(
      reportPath,
      JSON.stringify({ status: 'passed', nodes: indexed.stats.nodes, originalTextBytes }),
    );
    process.exit();
  }
  const coldReport = path.join(temporary, 'cold.json');
  execFileSync(
    process.execPath,
    [process.argv[1], temporary, coldReport, 'cold-apply', targets[0].id, plan.plan_token],
    { env: process.env },
  );
  assert.equal(JSON.parse(await fs.readFile(coldReport, 'utf8')).code, 'invalid_plan');
  assert.equal(plan.total_edits, 7, JSON.stringify(plan));
  assert.equal(plan.changes.find((c) => c.file_path === 'b.ts').edits.length, 3);
  assert.equal(plan.changes.find((c) => c.file_path === 'c.ts').edits.length, 3);
  await unchanged();
  assert.equal(
    (await backend.callTool('rename', { ...request, dry_run: false })).code,
    'plan_required',
  );
  assert.equal((await apply(plan, { new_name: 'unreviewed' })).code, 'plan_mismatch');
  await unchanged();

  for (const file of ['b.ts', 'c.ts']) {
    plan = await preview();
    await fs.appendFile(path.join(root, file), '// changed after preview\n');
    const rejected = await apply(plan);
    assert.equal(rejected.code, 'source_changed', JSON.stringify(rejected));
    assert.equal(rejected.applied, false);
    assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), sources['a.ts']);
    await fs.writeFile(path.join(root, file), sources[file]);
  }
  plan = await preview();
  await fs.writeFile(path.join(root, 'new.ts'), "import { target } from './a';\ntarget();\n");
  const added = await apply(plan);
  assert.equal(added.code, 'source_set_changed', JSON.stringify(added));
  await unchanged();
  await fs.unlink(path.join(root, 'new.ts'));
  plan = await preview();
  await fs.writeFile(path.join(root, 'Rakefile'), 'task :build do\nend\n');
  assert.equal((await apply(plan)).code, 'source_set_changed');
  await unchanged();
  await fs.unlink(path.join(root, 'Rakefile'));

  plan = await preview();
  // A symlink can change the write target without changing its source bytes.
  const alternate = path.join(temporary, 'alternate');
  await fs.rename(root, alternate);
  await fs.cp(alternate, root, { recursive: true });
  const copied = path.join(temporary, 'copy');
  await fs.rename(root, copied);
  await fs.symlink(alternate, root, process.platform === 'win32' ? 'junction' : 'dir');
  const retargeted = await apply(plan);
  assert.equal(retargeted.applied, false, JSON.stringify(retargeted));
  assert.ok(['source_set_changed', 'source_changed', 'plan_mismatch'].includes(retargeted.code));
  await fs.unlink(root);
  await fs.rename(copied, root);
  await fs.rm(alternate, { recursive: true });

  plan = await preview();
  const expected = new Map();
  for (const change of plan.changes) {
    let output = sources[change.file_path];
    for (const edit of [...change.edits].sort((a, b) => b.start - a.start))
      output = output.slice(0, edit.start) + edit.new_text + output.slice(edit.start + edit.length);
    expected.set(change.file_path, output);
  }
  const applied = await apply(plan);
  assert.equal(applied.status, 'success', JSON.stringify(applied));
  assert.deepEqual(applied.changes, plan.changes);
  for (const [file, output] of expected)
    assert.equal(await fs.readFile(path.join(root, file), 'utf8'), output);
  assert.equal(
    execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    'c.ts',
  );
  assert.equal((await apply(plan)).code, 'invalid_plan');
  // Controlled write interruption: native indexing/planning/persistence remain real.
  for (const [file, text] of Object.entries(sources))
    await fs.writeFile(path.join(root, file), text);
  plan = await preview();
  const originalWrite = fs.writeFile.bind(fs);
  let writes = 0;
  fs.writeFile = async (...args) => {
    if (String(args[0]).includes('.gitnexus-rename-') && writes++ === 1) {
      await originalWrite(args[0], 'interrupted replacement');
      throw new Error('injected interrupted rename staging write');
    }
    return originalWrite(...args);
  };
  let interrupted;
  try {
    interrupted = await apply(plan);
  } finally {
    fs.writeFile = originalWrite;
  }
  assert.equal(interrupted.status, 'partial', JSON.stringify(interrupted));
  assert.equal(interrupted.code, 'write_failed');
  assert.deepEqual(
    interrupted.changes.map((c) => c.file_path),
    ['a.ts'],
  );
  assert.deepEqual(interrupted.failed_files, ['b.ts']);
  assert.deepEqual(interrupted.unattempted_files, ['c.ts']);
  assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), expected.get('a.ts'));
  assert.equal(await fs.readFile(path.join(root, 'b.ts'), 'utf8'), sources['b.ts']);
  assert.equal(await fs.readFile(path.join(root, 'c.ts'), 'utf8'), sources['c.ts']);
  assert.equal((await apply(plan)).code, 'invalid_plan');
  // Reconcile explicitly; the next accepted preview can recover without replaying partial edits.
  for (const [file, text] of Object.entries(sources))
    await fs.writeFile(path.join(root, file), text);
  plan = await preview();
  assert.equal((await apply(plan)).status, 'success');
  await fs.writeFile(reportPath, JSON.stringify({ status: 'passed', nodes: indexed.stats.nodes }));
} catch (error) {
  await fs.writeFile(
    reportPath,
    JSON.stringify({ status: 'failed', error: error.stack ?? String(error) }),
  );
  process.exitCode = 1;
} finally {
  await backend?.dispose();
  await adapter.closeLbug();
}
