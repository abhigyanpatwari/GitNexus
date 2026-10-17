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
if (mode === 'large-evidence') {
  process.env.GITNEXUS_MAX_FILE_SIZE = '32768';
  const padding = 'x'.repeat(20 * 1024 * 1024);
  sources['evidence1.ts'] = 'export const unrelated1 = 1;\n/*' + padding + '*/\n';
  sources['evidence2.ts'] = 'export const unrelated2 = 2;\n/*' + padding + '*/\n';
}
let backend;
try {
  await fs.mkdir(root);
  for (const [file, text] of Object.entries(sources))
    await fs.writeFile(path.join(root, file), text);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'a.ts', 'b.ts'], { cwd: root });
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
  await adapter.initLbug(path.join(indexed.storagePath, 'lbug'), { skipFts: true });
  const targets = await adapter.executeQuery(
    "MATCH (n:Function) WHERE n.name = 'target' RETURN n.id AS id",
  );
  assert.equal(targets.length, 1);
  const calls = await adapter.executeQuery(
    "MATCH (a)-[r:CodeRelation]->(b) WHERE r.type = 'CALLS' AND b.id = '" +
      targets[0].id +
      "' RETURN DISTINCT a.name AS name",
  );
  assert.deepEqual(calls.map((x) => x.name).sort(), ['tracked', 'untracked']);
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

  let plan = await preview();
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
