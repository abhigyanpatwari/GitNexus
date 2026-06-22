/**
 * Definitive end-to-end check: cross-repo trace with NAMED route handlers +
 * NAMED consumer functions (the common real-world case), so the graph-assisted
 * HTTP extraction can resolve contracts to real symbol UIDs and the trace can
 * stitch. Run from gitnexus/:  node bench/cross-repo-trace/verify-named.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO = path.resolve('.');
const NF = path.join(REPO, 'bench/cross-repo-trace/fixtures-named');
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-xrepo-named-'));
process.env.GITNEXUS_HOME = tmpHome;

const beDir = path.join(tmpHome, 'named-backend');
const feDir = path.join(tmpHome, 'named-frontend');
fs.cpSync(path.join(NF, 'be'), beDir, { recursive: true });
fs.cpSync(path.join(NF, 'fe'), feDir, { recursive: true });

const line = (s = '') => console.log(s);
const t = () => Date.now();

const { runFullAnalysis } = await import(path.join(REPO, 'dist/core/run-analyze.js'));
const cb = { onProgress: () => {}, onLog: () => {} };
const opts = { pdg: true, skipSkills: true, embeddings: false, force: true };

line('# Cross-repo trace — NAMED-handler end-to-end verification\n');
for (const [name, dir] of [
  ['backend', beDir],
  ['frontend', feDir],
]) {
  const t0 = t();
  const res = await runFullAnalysis(dir, opts, cb);
  line(`analyze ${name}: OK in ${t() - t0}ms (nodes=${res?.stats?.nodes ?? '?'})`);
}

const { getGroupDir } = await import(path.join(REPO, 'dist/core/group/storage.js'));
const { loadGroupConfig } = await import(path.join(REPO, 'dist/core/group/config-parser.js'));
const { syncGroup } = await import(path.join(REPO, 'dist/core/group/sync.js'));

const groupDir = getGroupDir(tmpHome, 'named-group');
fs.mkdirSync(groupDir, { recursive: true });
fs.copyFileSync(path.join(NF, 'group.yaml'), path.join(groupDir, 'group.yaml'));
const config = await loadGroupConfig(groupDir);
const tS0 = t();
const sync = await syncGroup(config, { groupDir });
line(
  `\nsync: ${t() - tS0}ms — contracts=${sync.contracts.length}, crossLinks=${sync.crossLinks.length}`,
);
line('\n## Contracts (note symbolUid — populated this time?)');
for (const c of sync.contracts) {
  line(
    `  [${c.role}] ${c.repo} ${c.contractId} sym=${c.symbolName} uid=${c.symbolUid || '∅'} strat=${c.meta?.extractionStrategy}`,
  );
}

const { LocalBackend } = await import(path.join(REPO, 'dist/mcp/local/local-backend.js'));
const backend = new LocalBackend();
await backend.init();

// Explicit ground-truth trace pairs (named both sides).
const pairs = [
  ['fetchUsers', 'listUsers', 'GET /api/users'],
  ['createUserReq', 'createUser', 'POST /api/users'],
];
line('\n## trace @named-group');
let okWithCrossing = 0;
for (const [from, to, label] of pairs) {
  const t0 = t();
  const r = await backend.callTool('trace', { repo: '@named-group', from, to, pdg: true });
  const ms = t() - t0;
  const cx = r.crossings?.length ?? 0;
  if (r.status === 'ok' && cx === 1) okWithCrossing++;
  line(
    `  ${label}: ${from} → ${to} => status=${r.status} ${ms}ms crossings=${cx}` +
      (r.dataFlow ? ` dataFlow=${r.dataFlow.length}` : '') +
      (r.notes?.length ? ` notes=[${r.notes.map((n) => n.slice(0, 36)).join(' | ')}]` : ''),
  );
  if (r.status === 'ok' && r.hops) {
    line(`      path: ${r.hops.map((h) => `${h.repo}:${h.name}`).join(' → ')}`);
    line(`      edges: ${(r.edges || []).map((e) => e.relType).join(' → ')}`);
    if (r.crossings?.[0])
      line(
        `      crossing: ${r.crossings[0].contractId} match=${r.crossings[0].matchType} conf=${r.crossings[0].confidence}`,
      );
  } else if (r.status !== 'ok') {
    line(`      (role=${r.role ?? '-'} suggestion=${(r.suggestion || '').slice(0, 80)})`);
  }
}

line('\n## destination trace (no `to`) — follow consumer to its HTTP endpoint');
{
  const r = await backend.callTool('trace', {
    repo: '@named-group',
    from: 'fetchUsers',
    pdg: true,
  });
  const ok = r.status === 'ok' && (r.crossings?.length ?? 0) === 1;
  line(
    `  fetchUsers → (destination) => status=${r.status}` +
      (ok ? `  lands at ${r.to?.repo}:${r.to?.name} via ${r.crossings[0].contractId}` : ''),
  );
}

line('\n## Verdict');
line(
  `  trace pairs: ${pairs.length}  |  ok WITH cross-repo crossing: ${okWithCrossing}/${pairs.length}`,
);
line(
  okWithCrossing === pairs.length
    ? '  ✅ Cross-repo trace WORKS end-to-end on named handlers (real analyze → real sync → real trace).'
    : '  ⚠️  Cross-repo trace did NOT fully stitch even with named handlers — see contracts/symbolUid above.',
);

fs.rmSync(tmpHome, { recursive: true, force: true });
process.exit(0);
