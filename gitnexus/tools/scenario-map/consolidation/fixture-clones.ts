import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FixtureProfile } from '../facet/fixture-profile.js';
import { compareFixtureProfiles } from '../facet/fixture-profile.js';
import { sortedUnique } from '../util.js';
import type { FixtureSources } from './fixture-sources.js';

const execute = promisify(execFile);
export interface CloneSpan {
  source: string;
  file: string;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}
export interface FixtureClone {
  a: CloneSpan;
  b: CloneSpan;
  kind: string;
  similarity: number;
  tokens: number;
}
export interface CloneRun {
  tool: string;
  version: string;
  sourceCount: number;
  capturedFiles?: number;
  scannedFiles?: number;
  formats?: string[];
  sourceRoot?: string;
  verifiedPairs?: number;
  clones: FixtureClone[];
}
export interface FixtureOverlap {
  kind: 'content' | 'clone' | 'cross-language-structure';
  coverageA: number;
  coverageB: number;
  sharedBytesA: number;
  sharedBytesB: number;
  totalBytesA: number;
  totalBytesB: number;
  crossLanguage: boolean;
  matches: FixtureClone[];
  unmatchedA: CloneSpan[];
  unmatchedB: CloneSpan[];
}

/** External clone detection is local, pinned, and receives only captured fixture files. */
export async function runFixtureClones(
  sources: FixtureSources,
  outDir: string,
  cli?: string,
): Promise<CloneRun> {
  if (Object.keys(sources).length === 0)
    return {
      tool: 'jscpd',
      version: '5.4.2 (not run: no captured sources)',
      sourceCount: 0,
      clones: [],
    };
  mkdirSync(outDir, { recursive: true });
  const root = mkdtempSync(path.join(outDir, 'sources-'));
  for (const [key, files] of Object.entries(sources)) {
    if (!/^[a-f0-9]{40}$/.test(key)) throw new Error('invalid fixture source key');
    for (const [file, content] of files) {
      if (
        path.isAbsolute(file) ||
        file.split(/[\\/]/).some((part) => part === '..') ||
        file.includes('\0')
      )
        throw new Error(`invalid captured fixture path: ${file}`);
      const target = path.join(root, key, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
  const executable =
    cli ??
    process.env.GITNEXUS_SCENARIO_JSCPD ??
    createRequire(import.meta.url).resolve('jscpd/run-jscpd.js');
  const version = (
    await execute(process.execPath, [executable, '--version'], { maxBuffer: 1_000_000 })
  ).stdout.trim();
  return scanFixtureClones(sources, root, [root], outDir, executable, version);
}

async function scanFixtureClones(
  sources: FixtureSources,
  root: string,
  inputs: string[],
  outDir: string,
  executable: string,
  version: string,
): Promise<CloneRun> {
  mkdirSync(outDir, { recursive: true });
  const config = path.join(outDir, 'jscpd-config.json');
  writeFileSync(config, '{}');
  const args = [
    executable,
    ...inputs,
    '--config',
    config,
    '--min-tokens',
    '12',
    '--min-lines',
    '0',
    '--mode',
    'weak',
    '--ignore-identifiers=consistent',
    '--similarity=0.8',
    '--min-nodes',
    '8',
    '--max-gap-lines',
    '2',
    '--cross-formats',
    'js-ts',
    '--workers',
    '2',
    '--reporters',
    'json',
    '--output',
    outDir,
    '--no-gitignore',
    '--absolute',
    '--silent',
  ];
  const result = await execute(process.execPath, args, { cwd: outDir, maxBuffer: 2_000_000 });
  writeFileSync(path.join(outDir, 'jscpd.log'), result.stdout + result.stderr);
  const report = JSON.parse(readFileSync(path.join(outDir, 'jscpd-report.json'), 'utf8')) as {
    duplicates?: unknown[];
    statistics?: { total?: { sources?: number }; formats?: Record<string, unknown> };
  };
  if (!Array.isArray(report.duplicates)) throw new Error('jscpd did not return a clone report');
  const span = (value: unknown): CloneSpan => {
    const item = value as {
      name: string;
      start: number;
      end: number;
      startLoc: { position: number };
      endLoc: { position: number };
    };
    const relative = path.relative(root, item.name).replace(/\\/g, '/');
    const [source, ...parts] = relative.split('/');
    const file = parts.join('/');
    const content = sources[source]?.find(([name]) => name === file)?.[1];
    if (
      content === undefined ||
      !Number.isInteger(item.startLoc?.position) ||
      !Number.isInteger(item.endLoc?.position) ||
      item.startLoc.position < 0 ||
      item.endLoc.position < item.startLoc.position ||
      item.endLoc.position > Buffer.byteLength(content)
    )
      throw new Error('invalid jscpd source span');
    return {
      source,
      file,
      start: item.startLoc.position,
      end: item.endLoc.position,
      startLine: item.start,
      endLine: item.end,
    };
  };
  const clones = report.duplicates
    .map((value): FixtureClone => {
      const item = value as {
        firstFile: unknown;
        secondFile: unknown;
        kind: string;
        similarity?: number;
        tokens: number;
      };
      return {
        a: span(item.firstFile),
        b: span(item.secondFile),
        kind: item.kind,
        similarity: Math.max(0, Math.min(1, item.similarity ?? 1)),
        tokens: item.tokens,
      };
    })
    .filter((clone) => clone.a.source !== clone.b.source);
  clones.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    tool: 'jscpd',
    version,
    sourceRoot: root,
    sourceCount: Object.keys(sources).length,
    capturedFiles: Object.values(sources).reduce((n, files) => n + files.length, 0),
    scannedFiles: report.statistics?.total?.sources ?? 0,
    formats: Object.keys(report.statistics?.formats ?? {}).sort(),
    clones,
  };
}

/** A large corpus may suppress contained clones behind a longer representative.
 * Verify those candidates in isolation; never project byte offsets or transitively
 * equate near misses. Reuse the immutable export and retain each raw pair report.
 */
export async function verifyFixtureClonePairs(
  sources: FixtureSources,
  run: CloneRun,
  pairs: readonly [string, string][],
  outDir: string,
  cli?: string,
): Promise<CloneRun> {
  if (!pairs.length) return run;
  const root = run.sourceRoot;
  if (!root) throw new Error('fixture verification requires exported source inputs');
  const executable =
    cli ??
    process.env.GITNEXUS_SCENARIO_JSCPD ??
    createRequire(import.meta.url).resolve('jscpd/run-jscpd.js');
  const unique = [
    ...new Map(
      pairs.map(([a, b]) => {
        if (!sources[a] || !sources[b] || !/^[a-f0-9]{40}$/.test(a) || !/^[a-f0-9]{40}$/.test(b))
          throw new Error('unknown fixture verification source');
        const pair = [a, b].sort();
        return [pair.join(':'), pair];
      }),
    ).values(),
  ];
  const found: FixtureClone[][] = Array.from({ length: unique.length }, () => []);
  let next = 0;
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (next < unique.length) {
        const index = next++,
          [a, b] = unique[index];
        const result = await scanFixtureClones(
          { [a]: sources[a], [b]: sources[b] },
          root,
          [path.join(root, a), path.join(root, b)],
          path.join(outDir, `${a}-${b}`),
          executable,
          run.version,
        );
        found[index] = result.clones;
      }
    }),
  );
  return { ...run, verifiedPairs: unique.length, clones: run.clones.concat(...found) };
}

/** Retrieve candidates from overlapping representative spans, without claiming a match. */
export class FixtureCloneCandidates {
  private readonly anchors = new Map<string, Map<string, CloneSpan[]>>();
  private readonly requested = new Map<string, [string, string]>();
  private readonly checked = new Set<string>();
  constructor(run: CloneRun) {
    const add = (from: CloneSpan, to: CloneSpan) => {
      const sources = this.anchors.get(from.source) ?? new Map<string, CloneSpan[]>();
      const key = `${to.source}/${to.file}`,
        spans = sources.get(key) ?? [];
      spans.push(to);
      sources.set(key, spans);
      this.anchors.set(from.source, sources);
    };
    for (const clone of run.clones) {
      if (clone.similarity !== 1 || !['exact', 'renamed'].includes(clone.kind)) continue;
      add(clone.a, clone.b);
      add(clone.b, clone.a);
    }
  }
  consider(a: FixtureProfile, b: FixtureProfile): void {
    for (const left of a.sourceKeys ?? [])
      for (const right of b.sourceKeys ?? []) {
        if (left === right) continue;
        const pair: [string, string] = left < right ? [left, right] : [right, left];
        const key = pair.join(':');
        if (this.checked.has(key)) continue;
        this.checked.add(key);
        for (const [file, x] of this.anchors.get(left) ?? []) {
          const y = this.anchors.get(right)?.get(file);
          if (y && x.some((s) => y.some((t) => s.start < t.end && t.start < s.end))) {
            this.requested.set(key, pair);
            break;
          }
        }
      }
  }
  pairs(): [string, string][] {
    return [...this.requested.values()].sort();
  }
}

type Interval = { start: number; end: number; weight: number };
/** Weighted union, so overlapping clone fragments and near-miss gaps cannot inflate coverage. */
function covered(prefix: Uint32Array, intervals: Interval[]): number {
  const points = [...new Set(intervals.flatMap((i) => [i.start, i.end]))].sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1],
      end = points[i];
    const weight = Math.max(
      0,
      ...intervals.filter((v) => v.start <= start && v.end >= end).map((v) => v.weight),
    );
    total += (prefix[end] - prefix[start]) * weight;
  }
  return total;
}

export class FixtureCloneIndex {
  private readonly pairs = new Map<string, FixtureClone[]>();
  private readonly sizes = new Map<string, Uint32Array>();
  private readonly families = new Map<string, Map<string, { span: CloneSpan; tokens: number }[]>>();
  constructor(
    readonly sources: FixtureSources,
    readonly run: CloneRun,
  ) {
    // jscpd reports representatives, not every pair in a clone family. Join only exact
    // or consistent-renaming spans with identical boundaries and token counts. Near
    // matches are not transitive. Keep families compact; expand only queried pairs.
    const parent = new Map<string, string>();
    const members = new Map<string, { span: CloneSpan; tokens: number }>();
    const find = (key: string): string => {
      let root = key;
      while (true) {
        const next = parent.get(root);
        if (next === undefined || next === root) break;
        root = next;
      }
      while (key !== root) {
        const next = parent.get(key);
        if (next === undefined) break;
        parent.set(key, root);
        key = next;
      }
      return root;
    };
    for (const clone of run.clones) {
      const key = [clone.a.source, clone.b.source].sort().join(':');
      const bucket = this.pairs.get(key) ?? [];
      bucket.push(clone);
      this.pairs.set(key, bucket);
      if (clone.similarity === 1 && ['exact', 'renamed'].includes(clone.kind)) {
        const keys = [clone.a, clone.b].map((span) => {
          const id = JSON.stringify([span.source, span.file, span.start, span.end, clone.tokens]);
          if (!parent.has(id)) parent.set(id, id);
          members.set(id, { span, tokens: clone.tokens });
          return id;
        });
        parent.set(find(keys[1]), find(keys[0]));
      }
    }
    for (const [key, member] of members) {
      const source = this.families.get(member.span.source) ?? new Map();
      const family = find(key),
        bucket = source.get(family) ?? [];
      bucket.push(member);
      source.set(family, bucket);
      this.families.set(member.span.source, source);
    }
    for (const [source, files] of Object.entries(sources))
      for (const [file, text] of files) {
        const bytes = Buffer.from(text),
          prefix = new Uint32Array(bytes.length + 1);
        for (let i = 0; i < bytes.length; i++) prefix[i + 1] = prefix[i] + (bytes[i] > 32 ? 1 : 0);
        this.sizes.set(`${source}/${file}`, prefix);
      }
  }

  compare(a: FixtureProfile, b: FixtureProfile): FixtureOverlap | null {
    if (a.unresolved.length || b.unresolved.length) return null;
    const ka = sortedUnique(a.sourceKeys ?? []),
      kb = sortedUnique(b.sourceKeys ?? []);
    const crossLanguage = a.languages.join() !== b.languages.join();
    const matches: FixtureClone[] = [];
    const ia = new Map<string, Interval[]>(),
      ib = new Map<string, Interval[]>();
    const add = (into: Map<string, Interval[]>, span: CloneSpan, weight: number) => {
      const key = `${span.source}/${span.file}`,
        bucket = into.get(key) ?? [];
      bucket.push({ start: span.start, end: span.end, weight });
      into.set(key, bucket);
    };
    for (const left of ka)
      for (const right of kb) {
        if (left === right) {
          for (const [file, text] of this.sources[left] ?? []) {
            const span = {
              source: left,
              file,
              start: 0,
              end: Buffer.byteLength(text),
              startLine: 1,
              endLine: text.split('\n').length,
            };
            add(ia, span, 1);
            add(ib, span, 1);
          }
        } else
          for (const clone of this.pairs.get([left, right].sort().join(':')) ?? []) {
            const aligned = clone.a.source === left ? clone : { ...clone, a: clone.b, b: clone.a };
            add(ia, aligned.a, aligned.similarity);
            add(ib, aligned.b, aligned.similarity);
            matches.push(aligned);
          }
        if (left !== right)
          for (const [family, leftSpans] of this.families.get(left) ?? []) {
            for (const a of leftSpans)
              for (const b of this.families.get(right)?.get(family) ?? []) {
                if (
                  matches.some(
                    (m) =>
                      m.a.source === left &&
                      m.a.file === a.span.file &&
                      m.a.start === a.span.start &&
                      m.a.end === a.span.end &&
                      m.b.source === right &&
                      m.b.file === b.span.file &&
                      m.b.start === b.span.start &&
                      m.b.end === b.span.end,
                  )
                )
                  continue;
                const clone = {
                  a: a.span,
                  b: b.span,
                  kind: 'clone-family',
                  similarity: 1,
                  tokens: a.tokens,
                };
                add(ia, clone.a, 1);
                add(ib, clone.b, 1);
                matches.push(clone);
              }
          }
      }
    const measure = (keys: string[], intervals: Map<string, Interval[]>) => {
      let total = 0,
        shared = 0;
      for (const key of keys)
        for (const [file] of this.sources[key] ?? []) {
          const name = `${key}/${file}`,
            prefix = this.sizes.get(name);
          if (!prefix) continue;
          total += prefix[prefix.length - 1];
          shared += covered(prefix, intervals.get(name) ?? []);
        }
      return { total, shared };
    };
    const x = measure(ka, ia),
      y = measure(kb, ib);
    // Near-miss fragments remain reviewable in full: their score does not locate the edits.
    const unmatched = (keys: string[], intervals: Map<string, Interval[]>): CloneSpan[] => {
      const spans: CloneSpan[] = [];
      for (const source of keys)
        for (const [file, text] of this.sources[source] ?? []) {
          const bytes = Buffer.from(text);
          const known = (intervals.get(`${source}/${file}`) ?? [])
            .filter((i) => i.weight === 1)
            .sort((a, b) => a.start - b.start);
          let start = 0;
          const addGap = (end: number) => {
            if (bytes.subarray(start, end).toString().trim())
              spans.push({
                source,
                file,
                start,
                end,
                startLine: bytes.subarray(0, start).toString().split('\n').length,
                endLine: bytes.subarray(0, end).toString().split('\n').length,
              });
          };
          for (const interval of known) {
            if (interval.start > start) addGap(interval.start);
            start = Math.max(start, interval.end);
          }
          if (start < bytes.length) addGap(bytes.length);
        }
      return spans;
    };
    if (x.total && y.total && x.shared && y.shared)
      return {
        kind: a.contentKey !== null && a.contentKey === b.contentKey ? 'content' : 'clone',
        coverageA: x.shared / x.total,
        coverageB: y.shared / y.total,
        sharedBytesA: x.shared,
        sharedBytesB: y.shared,
        totalBytesA: x.total,
        totalBytesB: y.total,
        crossLanguage,
        matches: matches.slice(0, 12),
        unmatchedA: unmatched(ka, ia),
        unmatchedB: unmatched(kb, ib),
      };
    // Different language providers may describe the same scenario without sharing tokens.
    // Keep this a separate, weaker template suggestion, never a source-clone claim.
    const structural = crossLanguage ? compareFixtureProfiles(a, b) : null;
    // A larger multilingual fixture may contain the smaller scenario plus extra
    // functions. Require a shared CFG topology and >=90% feature containment;
    // declaration counts alone cannot establish a partial scenario match.
    let shared = 0,
      totalA = 0,
      totalB = 0,
      sharedCfg = false;
    if (crossLanguage && structural === null) {
      const right = new Map(b.features);
      for (const [feature, count] of a.features) {
        const weight = feature.startsWith('cfg:') ? 4 : 1;
        const common = Math.min(count, right.get(feature) ?? 0);
        totalA += count * weight;
        shared += common * weight;
        if (weight === 4 && common > 0) sharedCfg = true;
      }
      for (const [feature, count] of b.features)
        totalB += count * (feature.startsWith('cfg:') ? 4 : 1);
    }
    const partial =
      sharedCfg && totalA > 0 && totalB > 0 && Math.max(shared / totalA, shared / totalB) >= 0.9;
    if (structural || partial)
      return {
        kind: 'cross-language-structure',
        coverageA: structural?.score ?? shared / totalA,
        coverageB: structural?.score ?? shared / totalB,
        sharedBytesA: 0,
        sharedBytesB: 0,
        totalBytesA: x.total,
        totalBytesB: y.total,
        crossLanguage,
        matches: [],
        unmatchedA: unmatched(ka, ia),
        unmatchedB: unmatched(kb, ib),
      };
    return null;
  }
}
