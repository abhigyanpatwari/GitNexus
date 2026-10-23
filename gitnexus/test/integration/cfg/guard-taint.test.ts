import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import { createTempDirPool } from '../../helpers/temp-dir-pool.js';

const repos = createTempDirPool('gn-guard-taint-');

describe('guard-aware command taint (#3490)', () => {
  it('retains findings for bypasses, mutation, uncertain types and unsupported sink uses', async () => {
    const cases: Record<string, string> = {
      bypass:
        'const value: string = req.query.ref; if (flag) { if (!/^[0-9a-f]{7,40}$/.test(value)) return; } execSync("git show " + value);',
      reassigned:
        'let value: string = req.query.ref; if (!/^[0-9a-f]{7,40}$/.test(value)) return; value = req.query.other; execSync("git show " + value);',
      wrongValue:
        'const value: string = req.query.ref; const other: string = "abcdef0"; if (!/^[0-9a-f]{7,40}$/.test(other)) return; execSync("git show " + value);',
      lateGuard:
        'const value: string = req.query.ref; execSync("git show " + value); if (!/^[0-9a-f]{7,40}$/.test(value)) return;',
      partialPattern:
        'const value: string = req.query.ref; if (!/^[0-9a-f]{7,40}/.test(value)) return; execSync("git show " + value);',
      multiline:
        'const value: string = req.query.ref; if (!/^[0-9a-f]{7,40}$/m.test(value)) return; execSync("git show " + value);',
      customShell:
        'const value: string = req.query.ref; if (!/^[0-9a-f]{7,40}$/.test(value)) return; execSync("git show " + value, {shell: "custom-shell"});',
      interpreter:
        'const value: string = req.query.ref; if (!/^[0-9a-f]{7,40}$/.test(value)) return; execSync("bash -c " + value);',
      executable:
        'const value: string = req.query.ref; if (!/^[0-9a-f]{7,40}$/.test(value)) return; spawn(value, []);',
      extraInput:
        'const value: string = req.query.ref; if (!/^[0-9a-f]{7,40}$/.test(value)) return; execSync("git show " + value + req.query.other);',
      caught:
        'const value: string = req.query.ref; try { if (!/^[0-9a-f]{7,40}$/.test(value)) throw new Error(); } catch {} execSync("git show " + value);',
      unknownObject:
        'const value: any = req.query.ref; if (!/^[0-9a-f]{7,40}$/.test(value)) return; execSync("git show " + value);',
      suspended:
        'const value: string = req.query.ref; if (!/^[0-9a-f]{7,40}$/.test(value)) return; await pending(); execSync("git show " + value);',
    };
    const repo = repos.dir();
    fs.writeFileSync(
      path.join(repo, 'unsafe.ts'),
      'import {execSync, spawn} from "node:child_process";\n' +
        Object.entries(cases)
          .map(
            ([name, body]) =>
              `export ${name === 'suspended' ? 'async ' : ''}function ${name}(req: any, flag: boolean) { ${body} }`,
          )
          .join('\n') +
        String.raw`
function escapedValue(value: string, req: any) {
  if (!/^[0-9a-f]{7,40}$/.test(value)) return;
  \u0076alue = req.query.other;
  execSync('git show ' + value);
}
export function handleEscaped(req: any) { escapedValue(req.query.ref, req); }
`,
    );
    const result = await runPipelineFromRepo(repo, () => {}, { pdg: true, workerPoolSize: 1 });
    const crossSources = [...result.graph.iterRelationships()]
      .filter((edge) => edge.type === 'TAINT_PATH')
      .map((edge) => result.graph.getNode(edge.sourceId)?.properties.name);
    expect(crossSources).toContain('handleEscaped');
    const sourceLines = [...result.graph.iterRelationships()]
      .filter((edge) => edge.type === 'TAINTED')
      .map((edge) => Number(result.graph.getNode(edge.sourceId)?.properties.startLine));
    for (const [index, name] of Object.keys(cases).entries()) {
      expect(sourceLines, `missing conservative finding for ${name}`).toContain(index + 2);
    }
  }, 120_000);

  it('preserves a validated value across command construction without hiding unsafe siblings', async () => {
    const repo = repos.dir();
    fs.writeFileSync(
      path.join(repo, 'commands.ts'),
      `import { execSync } from 'node:child_process';
const SHA_RE = /^[0-9a-f]{7,40}$/;
function runGit(args: string) { return execSync('git ' + args); }
function commitSubject(ref: string) {
  if (!SHA_RE.test(ref)) throw new Error('invalid sha');
  return runGit('log -1 --format=%s ' + ref).trim();
}
function showRevision(ref: string) {
  if (!/^[0-9a-f]{7,40}$/.test(ref)) return;
  return runGit('show ' + ref);
}
export function handleGuarded(req: any) { return commitSubject(req.query.ref as string); }
export function handleShow(req: any) { return showRevision(req.query.ref as string); }
export function handleUnsafe(req: any) { return runGit('blame ' + req.query.ref); }
export function handleInterpreter(req: any) {
  const value: string = req.query.ref;
  if (!SHA_RE.test(value)) return;
  execSync('bash -c ' + value);
}
export function handleLocal(req: any) {
  const ref: string = req.query.ref;
  if (!SHA_RE.test(ref)) return;
  execSync('git log -1 ' + ref);
}
export function handleWrongBranch(req: any) {
  const ref: string = req.query.ref;
  if (SHA_RE.test(ref)) return;
  execSync('git log -1 ' + ref);
}
export function handleLiteral(req: any) {
  const ref = req.query.ref;
  if (ref !== 'abcdef0') return;
  execSync('git show ' + ref);
}
`,
    );
    const result = await runPipelineFromRepo(repo, () => {}, { pdg: true, workerPoolSize: 1 });
    const edges = [...result.graph.iterRelationships()];
    const crossFunctionSources = edges
      .filter((edge) => edge.type === 'TAINT_PATH')
      .map((edge) => result.graph.getNode(edge.sourceId)?.properties.name);
    expect(crossFunctionSources).toContain('handleUnsafe');
    expect(crossFunctionSources).not.toContain('handleGuarded');
    expect(crossFunctionSources).not.toContain('handleShow');
    const localFindings = edges.filter((edge) => edge.type === 'TAINTED');
    const localSourceLines = localFindings.map(
      (edge) => result.graph.getNode(edge.sourceId)?.properties.startLine,
    );
    expect([...new Set(localSourceLines)].sort((a, b) => Number(a) - Number(b))).toEqual([16, 26]);
  }, 120_000);
});
