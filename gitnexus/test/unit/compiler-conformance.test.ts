import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { compareReports } from '../../tools/compiler-conformance/compare.mjs';
import { gitNexusCallReport } from '../../tools/compiler-conformance/gitnexus-report.mjs';

const first = {
  file: 'main.py',
  start: '5:8',
  end: '5:14',
  status: 'resolved',
  target: 'pkg.first',
};
const second = { ...first, start: '5:19', end: '5:27', target: 'pkg.second' };
const ambiguous = { file: 'lib.rs', start: '9:2', end: '9:10', status: 'ambiguous' };

it('uses exact graph spans, preserves guesses, and leaves aggregated edges without an invented site', () => {
  const node = (name: string, line: number) => ({
    id: name,
    label: 'Function',
    properties: { filePath: 'main.py', name, startLine: line, startColumn: 0 },
  });
  const caller = node('entry', 3);
  const callee = node('greet', 0);
  const targets = [':5:2:5:9', ':6:2:6:9', ''].map((span) => ({
    sourceId: caller.id,
    targetId: callee.id,
    id: `rel:CALLS:entry->greet${span}`,
  }));
  const result = {
    graph: {
      nodes: [caller, callee],
      getNode: (id: string) => [caller, callee].find((n) => n.id === id),
      iterRelationshipsByType: () => targets,
    },
    resolutionOutcomes: [
      {
        kind: 'fallback-guessed',
        filePath: 'main.py',
        name: 'greet',
        targetId: callee.id,
        range: { startLine: 6, startCol: 2, endLine: 6, endCol: 9 },
      },
    ],
  };
  const actual = gitNexusCallReport(result, { names: ['greet'] });
  const exact = {
    file: 'main.py',
    start: '5:2',
    end: '5:9',
    status: 'resolved',
    target: 'main.py#1:0',
  };
  compareReports(
    {
      sites: [exact, { ...exact, start: '6:2', end: '6:9', status: 'fallback-guessed' }],
      edges: [{ from: 'main.py#4:0', to: 'main.py#1:0' }],
    },
    actual,
  );
});

it('accepts independent report order, repeated facts and multiple observed targets at one site', () => {
  const alternative = { ...first, target: 'pkg.alternate' };
  const reference = { sites: [first, second, alternative, ambiguous] };
  expect(() =>
    compareReports(reference, {
      sites: [ambiguous, alternative, second, first, { ...first, description: 'qualified name' }],
    }),
  ).not.toThrow();
});

it('reports swapped same-line targets even when caller-to-callee pairs agree', () => {
  const edges = [
    { from: 'pkg.main', to: first.target },
    { from: 'pkg.main', to: second.target },
  ];
  expect(() =>
    compareReports(
      { sites: [first, second], edges },
      {
        sites: [
          { ...first, target: second.target },
          { ...second, target: first.target },
        ],
        edges,
      },
    ),
  ).toThrow(/main\.py:5:8\.\.5:14 resolved pkg\.first/);
});

it('distinguishes a missing site, an extra site, and an ambiguity with a fabricated edge', () => {
  expect(() => compareReports({ sites: [ambiguous] }, { sites: [] })).toThrow(/Missing.*ambiguous/);
  expect(() => compareReports({ sites: [first] }, { sites: [first, ambiguous] })).toThrow(
    /Unexpected.*ambiguous/,
  );
  expect(() =>
    compareReports(
      { sites: [ambiguous], edges: [] },
      {
        sites: [ambiguous],
        edges: [{ from: 'caller', to: 'spurious' }],
      },
    ),
  ).toThrow(/Unexpected.*caller -> spurious/);
  expect(() => compareReports({ sites: [first], edges: [] }, { sites: [first] })).toThrow(
    /both reports/,
  );
});

it('rejects empty references, malformed ranges, and resolved calls missing a declaration', () => {
  expect(() => compareReports({ sites: [] }, { sites: [] })).toThrow(/no call sites/);
  expect(() => compareReports({ sites: [{ ...first, end: first.start }] }, { sites: [] })).toThrow(
    /Invalid range/,
  );
  expect(() =>
    compareReports({ sites: [first] }, { sites: [{ ...first, target: undefined }] }),
  ).toThrow(/target/);
});

it('compares JSON files from an external working directory and returns a failing exit code for a mismatch', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'compiler-conformance-'));
  const cli = fileURLToPath(
    new URL('../../tools/compiler-conformance/compare.mjs', import.meta.url),
  );
  const run = () =>
    spawnSync(process.execPath, [cli, 'expected.json', 'actual.json'], {
      cwd: dir,
      encoding: 'utf8',
    });
  try {
    writeFileSync(path.join(dir, 'expected.json'), JSON.stringify({ sites: [first] }));
    writeFileSync(path.join(dir, 'actual.json'), JSON.stringify({ sites: [first] }));
    expect(run().status).toBe(0);
    writeFileSync(
      path.join(dir, 'actual.json'),
      JSON.stringify({ producer: 'external tool', sites: [second] }),
    );
    const mismatch = run();
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain('Unexpected in external tool');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
