/**
 * Cross-repo trace — comprehensive end-to-end verification.
 *
 * Drives the REAL pipeline (runFullAnalysis --pdg -> real syncGroup -> trace /
 * impact via a LocalBackend) over inline fixtures, one scenario per implemented
 * case, and reports PASS/FAIL per assertion. Run from gitnexus/ (needs a current
 * build for the parse worker):
 *
 *   node scripts/build.js
 *   node bench/cross-repo-trace/verify.mjs
 *
 * Cases covered: symbolUid containment resolution (named, same-file + nested),
 * symbol-precise crossing selection, the destination trace (named + anonymous
 * endpoint), cross-repo impact fan-out, and multi-language (Python) resolution.
 * (Ambiguous-destination and degraded-member paths need synthetic inputs the
 * real analyzer can't produce; those are covered in the unit suite.)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO = path.resolve('.');
const { runFullAnalysis } = await import(path.join(REPO, 'dist/core/run-analyze.js'));
const { getGroupDir } = await import(path.join(REPO, 'dist/core/group/storage.js'));
const { loadGroupConfig } = await import(path.join(REPO, 'dist/core/group/config-parser.js'));
const { syncGroup } = await import(path.join(REPO, 'dist/core/group/sync.js'));
const { LocalBackend } = await import(path.join(REPO, 'dist/mcp/local/local-backend.js'));

const cb = { onProgress: () => {}, onLog: () => {} };
const ANALYZE = { pdg: true, skipSkills: true, embeddings: false, force: true };
const line = (s = '') => console.log(s);

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label });
  line(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
};

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

function groupYaml(name, repos) {
  const lines = Object.entries(repos)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');
  return `version: 1
name: ${name}
description: ""
repos:
${lines}
links: []
packages: {}
detect:
  http: true
matching:
  bm25_threshold: 0.7
  embedding_threshold: 0.65
  max_candidates_per_step: 3
`;
}

/** Analyze each repo, sync the group, return a ready LocalBackend + sync result. */
async function setup(tag, repos, groupName, groupRepos) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `gn-bench-${tag}-`));
  process.env.GITNEXUS_HOME = home;
  for (const [reg, files] of Object.entries(repos)) {
    const dir = path.join(home, reg);
    writeFiles(dir, files);
    await runFullAnalysis(dir, ANALYZE, cb);
  }
  const gd = getGroupDir(home, groupName);
  fs.mkdirSync(gd, { recursive: true });
  fs.writeFileSync(path.join(gd, 'group.yaml'), groupYaml(groupName, groupRepos));
  const sync = await syncGroup(await loadGroupConfig(gd), { groupDir: gd });
  const backend = new LocalBackend();
  await backend.init();
  return { home, sync, backend };
}

const hasNote = (r, frag) => (r.notes ?? []).some((n) => n.includes(frag));
const crossingId = (r) => r.crossings?.[0]?.contractId;

// ── Scenario 1+3: named handlers (precise trace, destination, impact fan-out) ──
line('## Scenario: named handlers (same-file) — symbolUid precise');
{
  const { sync, backend, home } = await setup(
    'named',
    {
      'named-backend': {
        'src/routes.ts': `import { Router } from 'express';
const router = Router();
export function listUsers(req: { body: unknown }, res: { json: (v: unknown) => void }) { res.json([]); }
export function createUser(req: { body: unknown }, res: { json: (v: unknown) => void }) { res.json({}); }
router.get('/api/users', listUsers);
router.post('/api/users', createUser);
export default router;
`,
        'package.json': '{ "name": "named-backend", "version": "1.0.0" }',
      },
      'named-frontend': {
        'src/api.ts': `export async function fetchUsers() {
  const r = await fetch('/api/users');
  return r.json();
}
export async function createUserReq(data: { name: string }) {
  const r = await fetch('/api/users', { method: 'POST', body: JSON.stringify(data) });
  return r.json();
}
`,
        'package.json': '{ "name": "named-frontend", "version": "1.0.0" }',
      },
    },
    'named-group',
    { 'app/backend': 'named-backend', 'app/frontend': 'named-frontend' },
  );

  const resolved = sync.contracts.filter((c) => c.symbolUid).length;
  check(resolved >= 4, `all 4 contracts resolve a symbolUid (got ${resolved}/4)`);

  const get = await backend.callTool('trace', {
    repo: '@named-group',
    from: 'fetchUsers',
    to: 'listUsers',
    pdg: true,
  });
  check(
    get.status === 'ok' && crossingId(get) === 'http::GET::/api/users' && !hasNote(get, 'file'),
    'GET trace is symbol-precise (fetchUsers -> listUsers over http::GET::/api/users, no file fallback)',
    `status=${get.status} crossing=${crossingId(get)}`,
  );

  const post = await backend.callTool('trace', {
    repo: '@named-group',
    from: 'createUserReq',
    to: 'createUser',
    pdg: true,
  });
  check(
    post.status === 'ok' && crossingId(post) === 'http::POST::/api/users',
    'POST trace selects the POST crossing (no GET/POST confusion)',
    `crossing=${crossingId(post)}`,
  );

  const dest = await backend.callTool('trace', { repo: '@named-group', from: 'fetchUsers' });
  check(
    dest.status === 'ok' &&
      dest.to?.name === 'listUsers' &&
      crossingId(dest) === 'http::GET::/api/users',
    'destination trace (no `to`) lands at the named handler listUsers',
    `to=${dest.to?.name}`,
  );

  const imp = await backend.callTool('impact', {
    repo: '@named-group/app/frontend',
    target: 'fetchUsers',
    direction: 'downstream',
  });
  const hits = imp.summary?.cross_repo_hits ?? (Array.isArray(imp.cross) ? imp.cross.length : 0);
  check(hits >= 1, `impact @group fans out across the boundary (cross_repo_hits=${hits})`);

  fs.rmSync(home, { recursive: true, force: true });
}

// ── Scenario 2: anonymous handler — destination reports endpoint by route ──
line('\n## Scenario: anonymous handler — destination trace');
{
  const { sync, backend, home } = await setup(
    'anon',
    {
      'anon-backend': {
        'src/routes.ts': `import { Router } from 'express';
const router = Router();
router.get('/api/ping', (req: unknown, res: { json: (v: unknown) => void }) => { res.json({ ok: true }); });
export default router;
`,
        'package.json': '{ "name": "anon-backend", "version": "1.0.0" }',
      },
      'anon-frontend': {
        'src/ping.ts': `export async function ping() {
  const r = await fetch('/api/ping');
  return r.json();
}
`,
        'package.json': '{ "name": "anon-frontend", "version": "1.0.0" }',
      },
    },
    'anon-group',
    { 'app/backend': 'anon-backend', 'app/frontend': 'anon-frontend' },
  );

  const provider = sync.contracts.find((c) => c.role === 'provider');
  check(
    provider !== undefined && !provider.symbolUid,
    'anonymous provider has an empty symbolUid (no named symbol to resolve)',
    `uid=${provider?.symbolUid || 'empty'}`,
  );

  const dest = await backend.callTool('trace', { repo: '@anon-group', from: 'ping' });
  check(
    dest.status === 'ok' &&
      dest.to?.name === '<http::GET::/api/ping handler>' &&
      hasNote(dest, 'anonymous'),
    'destination trace reaches the anonymous handler, reported by route + anonymous note',
    `to=${dest.to?.name}`,
  );

  fs.rmSync(home, { recursive: true, force: true });
}

// ── Scenario 4: multi-language (Python) — symbolUid resolution beyond TS ──
line('\n## Scenario: multi-language (Python) — line wiring + resolution');
{
  const { sync, backend, home } = await setup(
    'py',
    {
      'py-backend': {
        'app.py': `from flask import Flask
app = Flask(__name__)

@app.route('/api/items')
def list_items():
    return []
`,
      },
      'py-frontend': {
        'client.py': `import requests

def fetch_items():
    return requests.get('/api/items').json()
`,
      },
    },
    'py-group',
    { 'app/backend': 'py-backend', 'app/frontend': 'py-frontend' },
  );

  line(
    `  (py contracts: ${sync.contracts
      .map((c) => `${c.role}:${c.symbolName}:${c.symbolUid ? 'uid' : 'empty'}`)
      .join(' ')} | crossLinks=${sync.crossLinks.length})`,
  );
  check(
    sync.crossLinks.length >= 1,
    `Python HTTP link built (crossLinks=${sync.crossLinks.length})`,
  );

  const tr = await backend.callTool('trace', {
    repo: '@py-group',
    from: 'fetch_items',
    to: 'list_items',
  });
  check(
    tr.status === 'ok' && crossingId(tr) === 'http::GET::/api/items',
    'Python cross-repo trace stitches fetch_items -> list_items',
    `status=${tr.status} crossing=${crossingId(tr) ?? tr.role}`,
  );
  // The Flask provider resolves no symbol here, so the provider boundary is
  // anchored by the contract FILE (to=list_items lives in the provider file).
  // This exercises the file-level fallback path end-to-end.
  check(
    hasNote(tr, 'FILE'),
    'provider boundary uses the file-level fallback when the provider has no uid',
    `notes=${(tr.notes ?? []).length}`,
  );

  fs.rmSync(home, { recursive: true, force: true });
}

// ── Scenario: Python Flask add_url_rule with an ALIASED relative import —
//    import-pinned resolution across Python's dotted module syntax. ───────────
line('\n## Scenario: Python aliased import (Flask add_url_rule) — import-pinned');
{
  const { sync, backend, home } = await setup(
    'pyalias',
    {
      'pyalias-backend': {
        'app/handlers/users.py': `def list_users():
    return []
`,
        'app/routes.py': `from flask import Flask
from .handlers.users import list_users as handle_users
app = Flask(__name__)
app.add_url_rule('/api/users', view_func=handle_users)
`,
      },
      'pyalias-frontend': {
        'client.py': `import requests

def fetch_users():
    return requests.get('/api/users').json()
`,
      },
    },
    'pyalias-group',
    { 'app/backend': 'pyalias-backend', 'app/frontend': 'pyalias-frontend' },
  );

  const provider = sync.contracts.find(
    (c) => c.role === 'provider' && c.contractId === 'http::GET::/api/users',
  );
  check(
    provider?.symbolName === 'list_users',
    'Python Flask aliased view resolves through the relative import to list_users',
    `sym=${provider?.symbolName} uid=${provider?.symbolUid ? 'set' : 'empty'}`,
  );

  const tr = await backend.callTool('trace', {
    repo: '@pyalias-group',
    from: 'fetch_users',
    to: 'list_users',
  });
  check(
    tr.status === 'ok' && crossingId(tr) === 'http::GET::/api/users' && !hasNote(tr, 'FILE'),
    'Python aliased-import trace is symbol-precise (no file-level fallback)',
    `status=${tr.status} crossing=${crossingId(tr)}`,
  );

  fs.rmSync(home, { recursive: true, force: true });
}

// ── Scenario: cross-file named handler (#2275) — repo-wide unique resolution ──
line('\n## Scenario: cross-file named handler — repo-wide unique resolution');
{
  const { sync, backend, home } = await setup(
    'xfile',
    {
      'xfile-backend': {
        'src/handlers/users.ts': `export function listUsers(req: { body: unknown }, res: { json: (v: unknown) => void }) {
  res.json([]);
}
`,
        'src/routes.ts': `import { Router } from 'express';
import { listUsers } from './handlers/users';
const router = Router();
router.get('/api/users', listUsers);
export default router;
`,
        'package.json': '{ "name": "xfile-backend", "version": "1.0.0" }',
      },
      'xfile-frontend': {
        'src/api.ts': `export async function fetchUsers() {
  const r = await fetch('/api/users');
  return r.json();
}
`,
        'package.json': '{ "name": "xfile-frontend", "version": "1.0.0" }',
      },
    },
    'xfile-group',
    { 'app/backend': 'xfile-backend', 'app/frontend': 'xfile-frontend' },
  );

  const provider = sync.contracts.find(
    (c) => c.role === 'provider' && c.contractId === 'http::GET::/api/users',
  );
  check(
    Boolean(provider?.symbolUid) && provider?.symbolName === 'listUsers',
    'cross-file provider resolves to the handler defined in another file (repo-wide unique)',
    `sym=${provider?.symbolName} uid=${provider?.symbolUid ? 'set' : 'empty'}`,
  );

  const tr = await backend.callTool('trace', {
    repo: '@xfile-group',
    from: 'fetchUsers',
    to: 'listUsers',
    pdg: true,
  });
  check(
    tr.status === 'ok' && crossingId(tr) === 'http::GET::/api/users' && !hasNote(tr, 'FILE'),
    'cross-file trace is symbol-precise (no file-level fallback)',
    `status=${tr.status} crossing=${crossingId(tr)}`,
  );

  fs.rmSync(home, { recursive: true, force: true });
}

// ── Scenario: ALIASED cross-file import — resolved through the import to the
//    declared symbol, not the local alias (and not a same-named decoy). ───────
line('\n## Scenario: aliased cross-file import — import-pinned resolution');
{
  const { sync, backend, home } = await setup(
    'alias',
    {
      'alias-backend': {
        'src/handlers/users.ts': `export function listUsers(req: { body: unknown }, res: { json: (v: unknown) => void }) {
  res.json([]);
}
`,
        // Decoy: a DIFFERENT, unrelated symbol named handleUsers. Name-only
        // resolution of the local alias would wrongly pick this one.
        'src/util.ts': `export function handleUsers() {
  return 1;
}
`,
        'src/routes.ts': `import { Router } from 'express';
import { listUsers as handleUsers } from './handlers/users';
const router = Router();
router.get('/api/users', handleUsers);
export default router;
`,
        'package.json': '{ "name": "alias-backend", "version": "1.0.0" }',
      },
      'alias-frontend': {
        'src/api.ts': `export async function fetchUsers() {
  const r = await fetch('/api/users');
  return r.json();
}
`,
        'package.json': '{ "name": "alias-frontend", "version": "1.0.0" }',
      },
    },
    'alias-group',
    { 'app/backend': 'alias-backend', 'app/frontend': 'alias-frontend' },
  );

  const provider = sync.contracts.find(
    (c) => c.role === 'provider' && c.contractId === 'http::GET::/api/users',
  );
  check(
    provider?.symbolName === 'listUsers',
    'aliased handler resolves through the import to the declared symbol (not the alias/decoy)',
    `sym=${provider?.symbolName} uid=${provider?.symbolUid ? 'set' : 'empty'}`,
  );

  const tr = await backend.callTool('trace', {
    repo: '@alias-group',
    from: 'fetchUsers',
    to: 'listUsers',
    pdg: true,
  });
  check(
    tr.status === 'ok' && crossingId(tr) === 'http::GET::/api/users' && !hasNote(tr, 'FILE'),
    'aliased-import trace is symbol-precise (no file-level fallback)',
    `status=${tr.status} crossing=${crossingId(tr)}`,
  );

  fs.rmSync(home, { recursive: true, force: true });
}

// ── Summary ────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.pass).length;
line(`\n## Verdict: ${passed}/${results.length} checks passed`);
if (passed !== results.length) {
  line('  FAILED:');
  for (const r of results.filter((x) => !x.pass)) line(`   - ${r.label}`);
}
process.exit(passed === results.length ? 0 : 1);
