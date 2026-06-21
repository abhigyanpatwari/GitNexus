/**
 * Java taint model (#2261) over real Java CFG and import capture output.
 */

import { createRequire } from 'node:module';
import type { ParsedImport } from 'gitnexus-shared';
import { describe, expect, it } from 'vitest';
import { createJavaCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/java.js';
import { computeReachingDefs } from '../../../src/core/ingestion/cfg/reaching-defs.js';
import type { FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';
import { emitJavaScopeCaptures } from '../../../src/core/ingestion/languages/java/captures.js';
import { interpretJavaImport } from '../../../src/core/ingestion/languages/java/interpret.js';
import { JAVA_TAINT_MODEL } from '../../../src/core/ingestion/taint/java-model.js';
import { hasTaintSafeSites } from '../../../src/core/ingestion/taint/site-safety.js';
import {
  buildTaintImportIndex,
  matchFunctionSites,
  type FunctionSiteMatches,
  type MatchedSinkCall,
  type MatchedSource,
} from '../../../src/core/ingestion/taint/match.js';
import { computeTaintFlows } from '../../../src/core/ingestion/taint/propagate.js';
import { makeCfgHarness, bindingIdx, type CfgHarness } from '../../helpers/cfg-harness.js';

const javaGrammar = createRequire(import.meta.url)('tree-sitter-java') as Parameters<
  typeof makeCfgHarness
>[0];

const java: CfgHarness = makeCfgHarness(javaGrammar, createJavaCfgVisitor(), 'fixture.java');

function importsFor(src: string): ParsedImport[] {
  return emitJavaScopeCaptures(src, 'fixture.java')
    .filter((m) => m['@import.statement'] !== undefined)
    .map((m) => interpretJavaImport(m))
    .filter((p): p is ParsedImport => p !== null);
}

function cfgOf(code: string, fnIndex = 0): FunctionCfg {
  const cfg = java.cfgOf(code, fnIndex);
  expect(hasTaintSafeSites(cfg)).toBe(true);
  return cfg;
}

function matchesOf(code: string, fnIndex = 0): { cfg: FunctionCfg; matches: FunctionSiteMatches } {
  const cfg = cfgOf(code, fnIndex);
  return {
    cfg,
    matches: matchFunctionSites(cfg, JAVA_TAINT_MODEL, buildTaintImportIndex(importsFor(code))),
  };
}

function analyze(code: string, fnIndex = 0) {
  const { cfg, matches } = matchesOf(code, fnIndex);
  const defUse = computeReachingDefs(cfg);
  return { cfg, matches, flows: computeTaintFlows(cfg, defUse, matches) };
}

const allSources = (m: FunctionSiteMatches): MatchedSource[] =>
  m.statements.flatMap((s) => [...s.sources]);
const allSinks = (m: FunctionSiteMatches): MatchedSinkCall[] =>
  m.statements.flatMap((s) => [...s.sinks]);

const wrap = (body: string, imports = ''): string => `${imports}
class C {
  void f(javax.servlet.http.HttpServletRequest request, Helper helper, String safe) {
    ${body}
  }
}`;

describe('Java taint model (#2261)', () => {
  it('matches assigned request call results as remote-input sources', () => {
    const { cfg, matches } = matchesOf(wrap(`String p = request.getParameter("id");`));
    const sources = allSources(matches);
    expect(sources).toHaveLength(1);
    expect(sources[0].type).toBe('call-result');
    expect(sources[0].entry.kind).toBe('remote-input');
    expect(sources[0].type === 'call-result' ? [...sources[0].resultDefs] : []).toEqual([
      bindingIdx(cfg, 'p'),
    ]);
    expect(matches.hasSource).toBe(true);
  });

  it('propagates an assigned request source into a static-import-proven file read sink', () => {
    const { cfg, matches, flows } = analyze(
      wrap(
        `
String p = request.getParameter("path");
readString(of(p));
`,
        `
import static java.nio.file.Files.readString;
import static java.nio.file.Path.of;
`,
      ),
    );
    const p = bindingIdx(cfg, 'p');
    const sink = allSinks(matches)[0];
    expect(sink.entry.name).toBe('readString');
    const sinkSite = matches.statements
      .flatMap((stmt) => stmt.sinks.map((matched) => ({ stmt, matched })))
      .find(({ matched }) => matched === sink);
    if (sinkSite === undefined) throw new Error('expected readString sink site');
    const site =
      cfg.blocks[sinkSite.stmt.blockIndex].statements?.[sinkSite.stmt.statementIndex]?.sites?.[
        sink.siteIndex
      ];
    expect(site?.callee).toBe('readString');
    expect(site?.args?.[0]).toContainEqual([p, expect.any(Number)]);
    expect(flows.status).toBe('computed');
    expect(flows.findings).toHaveLength(1);
    expect(flows.findings[0].sinkKind).toBe('path-traversal');
    expect(flows.findings[0].source.type).toBe('call-result');
  });

  it('supports getHeader call-result sources', () => {
    const { flows } = analyze(
      wrap(
        `
String p = request.getHeader("X-Path");
readString(of(p));
`,
        `
import static java.nio.file.Files.readString;
import static java.nio.file.Path.of;
`,
      ),
    );
    expect(flows.findings).toHaveLength(1);
  });

  it('does not seed an unassigned request call result', () => {
    const { matches, flows } = analyze(
      wrap(
        `readString(request.getParameter("path"));`,
        'import static java.nio.file.Files.readString;',
      ),
    );
    expect(allSources(matches)).toHaveLength(0);
    expect(flows.findings).toHaveLength(0);
  });

  it('does not treat unrelated same-named receivers as servlet sources', () => {
    const { matches, flows } = analyze(
      wrap(
        `
String p = helper.getParameter("path");
readString(p);
`,
        'import static java.nio.file.Files.readString;',
      ),
    );
    expect(allSources(matches)).toHaveLength(0);
    expect(flows.findings).toHaveLength(0);
  });

  it('does not report a sink when the tainted value is not in the dangerous argument', () => {
    const { cfg, matches, flows } = analyze(
      wrap(
        `
String p = request.getParameter("path");
String unused = p;
readString(of(safe));
`,
        `
import static java.nio.file.Files.readString;
import static java.nio.file.Path.of;
`,
      ),
    );
    const p = bindingIdx(cfg, 'p');
    const sink = allSinks(matches)[0];
    expect(sink.entry.name).toBe('readString');
    const sinkSite = matches.statements
      .flatMap((stmt) => stmt.sinks.map((matched) => ({ stmt, matched })))
      .find(({ matched }) => matched === sink);
    if (sinkSite === undefined) throw new Error('expected readString sink site');
    const site =
      cfg.blocks[sinkSite.stmt.blockIndex].statements?.[sinkSite.stmt.statementIndex]?.sites?.[
        sink.siteIndex
      ];
    expect(site?.callee).toBe('readString');
    expect(site?.args?.[0]).not.toContainEqual([p, expect.any(Number)]);
    expect(site?.args?.[0]).not.toContain(p);
    expect(flows.status).toBe('computed');
    expect(flows.findings).toHaveLength(0);
  });

  it('does not match same-named readString calls without static import provenance', () => {
    const { matches, flows } = analyze(
      wrap(`
String p = request.getParameter("path");
readString(p);
helper.readString(p);
`),
    );
    expect(allSinks(matches)).toHaveLength(0);
    expect(flows.findings).toHaveLength(0);
  });

  it('does not report Paths.get or Path.of constructors as sinks', () => {
    const { matches, flows } = analyze(
      wrap(
        `
String p = request.getParameter("path");
get(p);
of(p);
`,
        `
import static java.nio.file.Paths.get;
import static java.nio.file.Path.of;
`,
      ),
    );
    expect(allSinks(matches)).toHaveLength(0);
    expect(flows.findings).toHaveLength(0);
  });

  it('does not match unrelated static imports named readString', () => {
    const { matches, flows } = analyze(
      wrap(
        `
String p = request.getParameter("path");
readString(p);
`,
        'import static com.example.Files.readString;',
      ),
    );
    expect(allSinks(matches)).toHaveLength(0);
    expect(flows.findings).toHaveLength(0);
  });

  it('does not report untainted input reaching the file read sink', () => {
    const { matches, flows } = analyze(
      wrap(
        `readString(of(safe));`,
        `
import static java.nio.file.Files.readString;
import static java.nio.file.Path.of;
`,
      ),
    );
    expect(allSinks(matches)).toHaveLength(1);
    expect(flows.findings).toHaveLength(0);
  });
});
