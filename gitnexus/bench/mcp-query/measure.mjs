import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { summarize, formatReport } from './statistics.mjs';

const { values } = parseArgs({
  options: {
    'baseline-root': { type: 'string' },
    'candidate-root': { type: 'string' },
    out: { type: 'string' },
    sessions: { type: 'string', default: '8' },
    rounds: { type: 'string', default: '5' },
    check: { type: 'boolean', default: false },
  },
});
assert.equal(process.platform, 'linux', 'This benchmark measures Linux /proc server resources');
assert(
  values['baseline-root'] && values.out,
  'Required: --baseline-root <gitnexus directory> --out <new directory>',
);
const sessions = Number(values.sessions),
  rounds = Number(values.rounds);
assert(
  [sessions, rounds].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 100),
  'Invalid sample count',
);
assert(
  !values.check || (sessions >= 8 && rounds >= 5),
  '--check requires at least 8 sessions and 5 rounds',
);
const out = path.resolve(values.out);
fs.mkdirSync(out); // Exclusive creation also rejects existing directories and symlinks.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const runtimes = Object.fromEntries(
  ['baseline', 'candidate'].map((variant) => {
    const directory = fs.realpathSync(path.resolve(values[`${variant}-root`] ?? root));
    const cli = path.join(directory, 'dist/cli/index.js');
    assert(fs.existsSync(cli), `Build ${directory} first`);
    return [
      variant,
      {
        directory,
        cli,
        sha: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: directory,
          encoding: 'utf8',
        }).trim(),
        lockSha256: hash(fs.readFileSync(path.join(directory, 'package-lock.json'))),
      },
    ];
  }),
);
const repo = path.join(out, 'repo');
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  LANG: 'C.UTF-8',
  TZ: 'UTC',
  ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}),
  GITNEXUS_SHARED_STORE: 'off',
  GITNEXUS_MEMORY: 'off',
  GITNEXUS_CONTENT_RETENTION: 'full',
  GITNEXUS_MCP_DEFAULT_REPO: repo,
  GITNEXUS_MCP_READ_ONLY: '1',
  GITNEXUS_LBUG_EXTENSION_INSTALL: 'load-only',
};
const runtimeEnvs = Object.fromEntries(
  ['baseline', 'candidate'].map((variant) => [
    variant,
    {
      ...env,
      GITNEXUS_HOME: path.join(out, 'home', variant),
      GITNEXUS_STORAGE_PATH: path.join(out, 'index', variant),
    },
  ]),
);
const queries = [
  { name: 'small_source', symbol: 'lookupSmallSource', source: true },
  { name: 'small_metadata', symbol: 'lookupSmallSource', source: false },
  { name: 'large_source', symbol: 'lookupOversizedSource', source: true },
  { name: 'large_metadata', symbol: 'lookupOversizedSource', source: false },
  { name: 'empty', symbol: 'zqxvnoBenchmarkMatch9172', source: true },
].map((q) => ({
  ...q,
  tool: 'query',
  args: { search_query: q.symbol, include_content: q.source },
}));
const cases = [
  ...queries,
  {
    name: 'context',
    tool: 'context',
    args: { uid: 'Function:large/0.ts:lookupOversizedSource', include_content: true },
  },
  { name: 'tools_list', tool: 'tools/list' },
];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((k) => !['timing', 'next', 'content', 'content_truncated'].includes(k))
      .map((k) => [k, canonical(value[k])]),
  );
}

function inspect(response, entry, variant) {
  if (response.isError)
    assert.fail(`MCP error in ${variant}/${entry.name}: ${JSON.stringify(response)}`);
  if (entry.tool === 'tools/list') {
    for (const name of ['query', 'context'])
      assert(
        response.tools.some((t) => t.name === name),
        `Missing ${name} tool`,
      );
    return { bytes: Buffer.byteLength(JSON.stringify(response)) };
  }
  const text = response.content
    .filter((r) => r.type === 'text')
    .map((r) => r.text)
    .join('\n');
  const trailer = text.indexOf('\n\n---\n');
  const body = JSON.parse(trailer < 0 ? text : text.slice(0, trailer));
  assert(
    !body.error && !body.partial,
    `Incomplete ${variant}/${entry.name} response: ${JSON.stringify({ error: body.error, partial: body.partial, warning: body.warning })}`,
  );
  // Separate builds have different receipt timestamps. Validate each against its
  // own index before excluding that timestamp from cross-runtime parity.
  if (body.staleness) {
    assert.equal(body.staleness.indexedAt, report.indexes[variant].indexedAt);
    delete body.staleness.indexedAt;
  }
  const rows = entry.tool === 'query' ? [...body.process_symbols, ...body.definitions] : [];
  if (entry.tool === 'query') {
    if (entry.name === 'empty') assert.equal(rows.length, 0);
    else
      assert(
        rows.filter((r) => r.name === entry.symbol).length >= 10,
        `Missing expected ${entry.symbol} matches`,
      );
  }
  const sourceChars = rows.reduce((n, row) => n + [...(row.content ?? '')].length, 0);
  if (entry.tool === 'query' && variant === 'candidate') {
    assert(sourceChars <= 16000, 'Query source exceeds the reviewed 16,000-character allowance');
    if (entry.source && entry.name !== 'empty') assert(sourceChars > 0, 'Query dropped all source');
    if (!entry.source) assert.equal(sourceChars, 0);
    if (entry.name === 'large_source')
      assert(
        rows.some((r) => r.content_truncated),
        'Missing incomplete-preview marker',
      );
  }
  if (entry.tool === 'context') {
    assert(body.symbol?.content?.length > 4096, 'Context must preserve the indexed source snippet');
  }
  return {
    bytes: Buffer.byteLength(text),
    rows: rows.length,
    sourceChars,
    timing: body.timing,
    digest: hash(
      JSON.stringify(
        entry.tool === 'context'
          ? { ...canonical(body), content: body.symbol.content }
          : canonical(body),
      ),
    ),
  };
}

function resources(pid) {
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const peakRssKiB = Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1]);
  const ticks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
  const cpuMs = ((Number(fields[11]) + Number(fields[12])) * 1000) / ticks;
  assert(
    [peakRssKiB, cpuMs].every((n) => Number.isFinite(n) && n > 0),
    'Missing server resources',
  );
  return { peakRssKiB, cpuMs };
}

async function open(variant, clients) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [runtimes[variant].cli, 'mcp'],
    cwd: repo,
    env: runtimeEnvs[variant],
    stderr: 'pipe',
  });
  const stderr = fs.createWriteStream(path.join(out, `${variant}.log`), { flags: 'a' });
  transport.stderr.pipe(stderr, { end: false });
  const client = new Client({ name: 'mcp-query-benchmark', version: '1.0.0' });
  let pending = 0,
    timedOut = false;
  const connection = {
    invoke: async (entry) => {
      pending++;
      const start = performance.now();
      try {
        const response = await (entry.tool === 'tools/list'
          ? client.listTools(undefined, { timeout: 600000 })
          : client.callTool({ name: entry.tool, arguments: { repo, ...entry.args } }, undefined, {
              timeout: 600000,
            }));
        return { ms: performance.now() - start, response };
      } catch (error) {
        if (error.code === -32001) timedOut = true;
        throw error;
      } finally {
        pending--;
      }
    },
    resources: () => resources(transport.pid),
    close: async () => {
      // Never terminate a server with outstanding native work after an RPC timeout.
      if (pending === 0 && !timedOut) await client.close();
      stderr.end();
    },
  };
  clients[variant] = connection;
  const start = performance.now();
  await client.connect(transport);
  connection.startup = { ms: performance.now() - start };
  const first = await connection.invoke(cases[0]);
  connection.first_query = {
    ...inspect(first.response, cases[0], variant),
    ms: connection.startup.ms + first.ms,
  };
  return connection;
}

const records = [],
  finalResources = [];
const report = {
  version: 1,
  harnessSha256: hash(
    ['measure.mjs', 'statistics.mjs']
      .map((file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8'))
      .join('\n'),
  ),
  runtimes,
  sessions,
  rounds,
  cases,
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0].model,
    cpuCount: os.cpus().length,
    totalMemory: os.totalmem(),
  },
  thresholds: { relative: 0.05, absoluteMs: 5 },
  records,
  finalResources,
};
try {
  fs.mkdirSync(repo);
  const source = [];
  for (const [kind, symbol, length] of [
    ['small', 'lookupSmallSource', 128],
    ['large', 'lookupOversizedSource', 32768],
  ]) {
    fs.mkdirSync(path.join(repo, kind));
    for (let i = 0; i < 32; i++) {
      const file = `${kind}/${i}.ts`;
      const text = `export function ${symbol}() {\n  return ${JSON.stringify('x'.repeat(length) + i)};\n}\n`;
      fs.writeFileSync(path.join(repo, file), text);
      source.push([file, hash(text)]);
    }
  }
  fs.writeFileSync(path.join(repo, '.gitignore'), '.gitnexus/\n');
  const gitEnv = {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'benchmark',
    GIT_AUTHOR_EMAIL: 'benchmark@example.com',
    GIT_COMMITTER_NAME: 'benchmark',
    GIT_COMMITTER_EMAIL: 'benchmark@example.com',
  };
  for (const args of [
    ['init', '-b', 'main'],
    ['add', '.'],
    ['-c', 'commit.gpgsign=false', 'commit', '-m', 'benchmark fixture'],
  ]) {
    execFileSync('git', args, { cwd: repo, env: gitEnv, stdio: 'pipe' });
  }
  report.fixtureSha256 = hash(JSON.stringify(source));
  report.indexes = {};
  const log = fs.openSync(path.join(out, 'index.log'), 'wx');
  try {
    // Native storage formats can differ across engine upgrades. Each runtime
    // builds its own index from the same fixture; response parity is checked below.
    for (const variant of ['baseline', 'candidate']) {
      const runtimeEnv = runtimeEnvs[variant];
      fs.writeSync(log, `\n${variant} index (${runtimes[variant].sha})\n`);
      execFileSync(process.execPath, [runtimes[variant].cli, 'analyze', repo, '--index-only'], {
        cwd: repo,
        env: runtimeEnv,
        stdio: ['ignore', log, log],
      });
      const metadata = JSON.parse(
        fs.readFileSync(path.join(runtimeEnv.GITNEXUS_STORAGE_PATH, 'gitnexus.json'), 'utf8'),
      );
      report.indexes[variant] = metadata;
      assert(
        metadata.stats.nodes >= 128 && metadata.stats.files === 64,
        `Incomplete ${variant} fixture index`,
      );
      assert.equal(metadata.stats.embeddings ?? 0, 0, 'Benchmark must not generate embeddings');
    }
  } finally {
    fs.closeSync(log);
  }
  report.index = report.indexes.candidate; // Preserve the existing report field.
  for (let session = 0; session < sessions; session++) {
    const clients = {};
    try {
      for (const variant of session % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'])
        await open(variant, clients);
      for (const [i, entry] of cases.entries()) {
        const warmup = {};
        for (const variant of (session + i) % 2
          ? ['candidate', 'baseline']
          : ['baseline', 'candidate']) {
          warmup[variant] = inspect(
            (await clients[variant].invoke(entry)).response,
            entry,
            variant,
          );
        }
        assert.equal(
          warmup.baseline.digest,
          warmup.candidate.digest,
          `Warmup parity: ${entry.name}`,
        );
      }
      for (let round = 0; round < rounds; round++) {
        const row = { session, round, baseline: {}, candidate: {} };
        if (round === 0)
          for (const variant of ['baseline', 'candidate']) {
            row[variant].startup = clients[variant].startup;
            row[variant].first_query = clients[variant].first_query;
          }
        for (let i = 0; i < cases.length; i++) {
          const entry = cases[(i + round) % cases.length];
          const order =
            (session + round + i) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
          for (const variant of order) {
            const result = await clients[variant].invoke(entry);
            row[variant][entry.name] = {
              ms: result.ms,
              ...inspect(result.response, entry, variant),
            };
          }
          assert.equal(
            row.baseline[entry.name].digest,
            row.candidate[entry.name].digest,
            `Result parity: ${entry.name}`,
          );
        }
        for (const variant of (session + round) % 2
          ? ['candidate', 'baseline']
          : ['baseline', 'candidate']) {
          const start = performance.now();
          const batch = await Promise.allSettled(
            Array.from({ length: 4 }, () => clients[variant].invoke(cases[2])),
          );
          const ms = performance.now() - start;
          for (const item of batch) {
            assert.equal(item.status, 'fulfilled', 'Concurrent request failed');
            assert.equal(
              inspect(item.value.response, cases[2], variant).digest,
              row[variant].large_source.digest,
              'Concurrent parity',
            );
          }
          row[variant].concurrent4 = { ms, requestsPerSecond: 4000 / ms };
        }
        records.push(row);
        fs.appendFileSync(path.join(out, 'raw.jsonl'), JSON.stringify(row) + '\n');
      }
      finalResources.push({
        session,
        baseline: clients.baseline.resources(),
        candidate: clients.candidate.resources(),
      });
      console.log(`Completed process pair ${session + 1}/${sessions}`);
    } finally {
      for (const client of Object.values(clients)) await client.close();
    }
  }
  report.metrics = summarize(records, sessions, rounds, [
    ...cases.map((c) => c.name),
    'concurrent4',
  ]);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'report.md'), formatReport(report));
  if (values.check && report.metrics.some((r) => r.verdict === 'regression')) process.exitCode = 1;
  console.log(`Measurements: ${path.join(out, 'report.md')}`);
} catch (error) {
  report.error = error.message;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(
    path.join(out, 'report.md'),
    `## MCP query performance\n\nFAILED: ${error.message}\n\nNo complete performance verdict. ${records.length}/${sessions * rounds} paired rounds retained.\n`,
  );
  console.error(error);
  process.exitCode = 1;
}
