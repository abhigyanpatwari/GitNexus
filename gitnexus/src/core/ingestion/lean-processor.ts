/**
 * Lean ETL processor: precomputed LeanGraph (ndjson + statements +
 * leandex informalization) → KnowledgeGraph (Function nodes + CALLS
 * edges + description/content upgrades).
 *
 * Consumed by the `leanETL` pipeline phase (env-gated, zero impact on
 * the default phase list). Pure + synchronous; all inputs are local
 * files. Progress via console (analyze log) every 50k nodes / 200k edges.
 *
 * Join key: module → repo-relative file (dotted → slashes); declaration
 * short name matched against per-file regex-tagged decl lines for
 * startLine/endLine backfill (ndjson carries no line numbers).
 */

import fs from 'node:fs';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import type { KnowledgeGraph } from '../graph/types.js';
import { generateId } from '../../lib/utils.js';
import { toZeroBasedLine } from './utils/line-base.js';
import { SupportedLanguages } from 'gitnexus-shared';

export interface LeanEtlInput {
  repoPath: string;
  ndjsonPath: string;
  statementsPath: string;
  informalDbPath?: string;
  /** restricts to these modules; empty = all */
  modules?: ReadonlySet<string>;
  /** edge kinds to emit (default proof+def; sig/extends/field/docref deferred) */
  edgeKinds?: ReadonlySet<string>;
}

export interface LeanEtlResult {
  nodes: number;
  classNodes: number;
  edges: number;
  dangling: number;
  lined: number;
  modules: number;
}

interface Stmt {
  signature: string;
  docstring: string;
  module: string;
  declType: string;
}

const SHORT = (n: string): string => n.split('.').pop()!;
const MOD_PATH = (m: string): string => `${m.replace(/\./g, '/')}.lean`;
const DECL_LINE =
  /^(?:private\s+|protected\s+|noncomputable\s+|unsafe\s+)*(?:@\[[^\]]*\]\s*)*(theorem|lemma|def|abbrev|instance|opaque|axiom|inductive|structure|class)\s+(«[^»]+»|[A-Za-z_][\w.']*)/;
const CLASS_TYPES = new Set(['structure', 'class', 'inductive']);

export async function processLeanEtl(
  graph: KnowledgeGraph,
  input: LeanEtlInput,
): Promise<LeanEtlResult> {
  const edgeKinds = input.edgeKinds ?? new Set(['proof', 'def']);

  // --- statements ---
  const stmts = new Map<string, Stmt>();
  for (const line of fs.readFileSync(input.statementsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (input.modules && input.modules.size > 0 && !input.modules.has(o.module)) continue;
    stmts.set(o.name, {
      signature: o.signature ?? '',
      docstring: o.docstring ?? '',
      module: o.module,
      declType: o.decl_type ?? '',
    });
  }

  // --- informalization (optional) ---
  const informal = new Map<string, string>();
  if (input.informalDbPath) {
    const db = new DatabaseSync(input.informalDbPath, { readOnly: true });
    const rows = db
      .prepare('SELECT name, informalization FROM declarations WHERE informalization IS NOT NULL')
      .all() as { name: string; informalization: string }[];
    for (const r of rows) informal.set(r.name, r.informalization);
    db.close();
  }

  // --- ndjson nodes (streaming) ---
  const res: LeanEtlResult = { nodes: 0, classNodes: 0, edges: 0, dangling: 0, lined: 0, modules: 0 };
  const known = new Set<string>();
  const pendingEdges: { s: string; t: string; kind: string }[] = [];
  const perModule = new Map<string, { fqn: string; short: string }[]>();
  const nodeMeta = new Map<string, { module: string; description: string; isClass: boolean }>();

  const rl = readline.createInterface({
    input: fs.createReadStream(input.ndjsonPath),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (input.modules && input.modules.size > 0 && !input.modules.has(o.module)) continue;
    const fqn: string = o.name;
    known.add(fqn);
    const st = stmts.get(fqn);
    const inf = informal.get(fqn) ?? '';
    const desc = [st?.docstring ?? o.docstring ?? '', inf].filter(Boolean).join('\n\n');
    nodeMeta.set(fqn, {
      module: o.module,
      description: desc.slice(0, 2000),
      isClass: CLASS_TYPES.has(o.decl_type),
    });
    if (!perModule.has(o.module)) perModule.set(o.module, []);
    perModule.get(o.module)!.push({ fqn, short: SHORT(fqn) });
    for (const e of o.edges ?? []) {
      if (edgeKinds.has(e.kind)) pendingEdges.push({ s: fqn, t: e.target, kind: e.kind });
    }
    if (known.size % 50000 === 0) console.log(`  leanETL: parsed ${known.size} decls...`);
  }
  res.modules = perModule.size;

  // --- line backfill: one pass per module file ---
  const lineOf = new Map<string, { start: number; end: number }>();
  for (const [mod, decls] of perModule) {
    const fp = `${input.repoPath}/${MOD_PATH(mod)}`;
    let text: string;
    try {
      text = fs.readFileSync(fp, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    const starts: { name: string; line: number }[] = [];
    lines.forEach((ln, i) => {
      const m = ln.match(DECL_LINE);
      if (!m) return;
      let nm: string = m[2]!;
      if (nm.startsWith('_root_.')) nm = nm.slice(7);
      // match by short segment: tagger sees `sum` for `Finset.sum`
      starts.push({ name: nm.split('.').pop()!, line: i + 1 });
    });
    for (const d of decls) {
      const hit = starts.find((s) => s.name === d.short);
      if (!hit) continue;
      const nx = starts.find((s) => s.line > hit.line);
      lineOf.set(d.fqn, { start: hit.line, end: nx ? nx.line - 1 : lines.length });
      res.lined++;
    }
  }

  // --- emit nodes ---
  for (const [fqn, meta] of nodeMeta) {
    const lr = lineOf.get(fqn);
    const id = generateId('Function', `lean:${fqn}`);
    graph.addNode({
      id,
      label: meta.isClass ? 'Class' : 'Function',
      properties: {
        name: SHORT(fqn),
        filePath: MOD_PATH(meta.module),
        startLine: toZeroBasedLine(lr ? lr.start : 1),
        endLine: toZeroBasedLine(lr ? lr.end : 1),
        language: SupportedLanguages.Lean,
        isExported: true,
        // NOTE: no `content` — Function.content is lazy-sliced from the
        // source file by startLine/endLine at load time, hence the backfill above.
        description: meta.description || undefined,
      },
    });
    res.nodes++;
    if (meta.isClass) res.classNodes++;
    if (res.nodes % 50000 === 0) console.log(`  leanETL: nodes ${res.nodes}...`);
  }

  // --- emit CALLS edges (targets restricted to ingested set) ---
  for (const e of pendingEdges) {
    if (!known.has(e.t)) {
      res.dangling++;
      continue;
    }
    graph.addRelationship({
      id: generateId('CALLS', `lean:${e.s}->${e.t}:${e.kind}`),
      type: 'CALLS',
      sourceId: generateId('Function', `lean:${e.s}`),
      targetId: generateId('Function', `lean:${e.t}`),
      confidence: 1.0,
      reason: `lean-etl-${e.kind}`,
    });
    res.edges++;
    if (res.edges % 200000 === 0) console.log(`  leanETL: edges ${res.edges}...`);
  }

  return res;
}
