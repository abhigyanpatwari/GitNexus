/**
 * Java taint model (#2261) over real Java CFG and import capture output.
 */

import { createRequire } from 'node:module';
import type { ParsedImport } from 'gitnexus-shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createJavaCfgVisitor } from '../../../../../src/core/ingestion/cfg/visitors/java.js';
import { computeReachingDefs } from '../../../../../src/core/ingestion/cfg/reaching-defs.js';
import type { FunctionCfg } from '../../../../../src/core/ingestion/cfg/types.js';
import { emitJavaScopeCaptures } from '../../../../../src/core/ingestion/languages/java/captures.js';
import { interpretJavaImport } from '../../../../../src/core/ingestion/languages/java/interpret.js';
import { JAVA_TAINT_MODEL } from '../../../../../src/core/ingestion/taint/java-model.js';
import { hasTaintSafeSites } from '../../../../../src/core/ingestion/taint/site-safety.js';
import {
  buildTaintImportIndex,
  matchFunctionSites,
  type FunctionSiteMatches,
  type MatchedSinkCall,
  type MatchedSource,
} from '../../../../../src/core/ingestion/taint/match.js';
import { computeTaintFlows } from '../../../../../src/core/ingestion/taint/propagate.js';
import {
  makeCfgHarness,
  bindingIdx,
  type CfgHarness,
} from '../../../../../test/helpers/cfg-harness.js';

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
  assert.equal(hasTaintSafeSites(cfg), true);
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

function matchedSinkSite(cfg: FunctionCfg, matches: FunctionSiteMatches, sink: MatchedSinkCall) {
  const sinkSite = matches.statements
    .flatMap((stmt) => stmt.sinks.map((matched) => ({ stmt, matched })))
    .find(({ matched }) => matched === sink);
  assert(sinkSite !== undefined, 'expected matched sink site');
  const site =
    cfg.blocks[sinkSite.stmt.blockIndex].statements?.[sinkSite.stmt.statementIndex]?.sites?.[
      sink.siteIndex
    ];
  assert(site !== undefined, 'expected concrete sink site');
  return site;
}

const wrap = (body: string, imports = ''): string => `${imports}
class C {
  void f(javax.servlet.http.HttpServletRequest request, javax.servlet.http.HttpServletRequest req, Helper helper, String safe) {
    ${body}
  }
}`;

describe('Java taint model (#2261)', () => {
  it('matches assigned request call results as remote-input sources', () => {
    const { cfg, matches } = matchesOf(wrap(`String p = request.getParameter("id");`));
    const sources = allSources(matches);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].type, 'call-result');
    assert.equal(sources[0].entry.kind, 'remote-input');
    assert.deepEqual(sources[0].type === 'call-result' ? [...sources[0].resultDefs] : [], [
      bindingIdx(cfg, 'p'),
    ]);
    assert.equal(matches.hasSource, true);
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
    assert.equal(sink.entry.name, 'readString');
    const site = matchedSinkSite(cfg, matches, sink);
    assert.equal(site?.callee, 'readString');
    assert.ok(site?.args?.[0]?.some((actual) => actual[0] === p && typeof actual[1] === 'number'));
    assert.equal(flows.status, 'computed');
    assert.equal(flows.findings.length, 1);
    assert.equal(flows.findings[0].sinkKind, 'path-traversal');
    assert.equal(flows.findings[0].source.type, 'call-result');
  });

  it('propagates regular-import-proven Files.readString into a path-traversal finding', () => {
    const { cfg, matches, flows } = analyze(
      wrap(
        `
String p = request.getParameter("path");
Files.readString(Path.of(p));
`,
        `
import java.nio.file.Files;
import java.nio.file.Path;
`,
      ),
    );
    const p = bindingIdx(cfg, 'p');
    const sinks = allSinks(matches);
    assert.equal(sinks.length, 1);
    assert.equal(sinks[0].entry.kind, 'path-traversal');
    const site = matchedSinkSite(cfg, matches, sinks[0]);
    assert.equal(site.callee, 'Files.readString');
    assert.ok(site.args?.[0]?.some((actual) => actual[0] === p && typeof actual[1] === 'number'));
    assert.equal(flows.findings.length, 1);
    assert.equal(flows.findings[0].sinkKind, 'path-traversal');
  });

  it('supports getHeader call-result sources', () => {
    const { cfg, matches, flows } = analyze(
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
    const p = bindingIdx(cfg, 'p');
    const sources = allSources(matches);
    assert.equal(sources.length, 1);
    assert(sources[0].type === 'call-result', 'expected getHeader to be a call-result source');
    assert.equal(sources[0].entry.kind, 'remote-input');
    assert.deepEqual([...sources[0].resultDefs], [p]);
    const sinks = allSinks(matches);
    assert.equal(sinks.length, 1);
    assert.equal(sinks[0].entry.kind, 'path-traversal');
    assert.equal(flows.findings.length, 1);
    assert.equal(flows.findings[0].source.type, 'call-result');
  });

  it('supports the short req receiver for call-result sources', () => {
    const { cfg, matches, flows } = analyze(
      wrap(
        `
String p = req.getParameter("path");
readString(of(p));
`,
        `
import static java.nio.file.Files.readString;
import static java.nio.file.Path.of;
`,
      ),
    );
    const p = bindingIdx(cfg, 'p');
    const [source] = allSources(matches);
    assert(source?.type === 'call-result', 'expected req.getParameter source');
    assert.deepEqual([...source.resultDefs], [p]);
    assert.equal(flows.findings.length, 1);
  });

  it('does not seed an unassigned request call result', () => {
    const { matches, flows } = analyze(
      wrap(
        `readString(request.getParameter("path"));`,
        'import static java.nio.file.Files.readString;',
      ),
    );
    assert.equal(allSources(matches).length, 0);
    assert.equal(flows.findings.length, 0);
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
    assert.equal(allSources(matches).length, 0);
    assert.equal(flows.findings.length, 0);
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
    assert.equal(sink.entry.name, 'readString');
    const site = matchedSinkSite(cfg, matches, sink);
    assert.equal(site?.callee, 'readString');
    const sinkArgs = site?.args?.[0];
    assert.ok(sinkArgs, 'expected the sink to record its first argument');
    assert.ok(!sinkArgs.some((actual) => actual[0] === p && typeof actual[1] === 'number'));
    assert.ok(!sinkArgs.includes(p));
    assert.equal(flows.status, 'computed');
    assert.equal(flows.findings.length, 0);
  });

  it('does not match same-named readString calls without static import provenance', () => {
    const { matches, flows } = analyze(
      wrap(`
String p = request.getParameter("path");
readString(p);
helper.readString(p);
`),
    );
    assert.equal(allSinks(matches).length, 0);
    assert.equal(flows.findings.length, 0);
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
    assert.equal(allSinks(matches).length, 0);
    assert.equal(flows.findings.length, 0);
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
    assert.equal(allSinks(matches).length, 0);
    assert.equal(flows.findings.length, 0);
  });

  it('does not match unrelated regular imports named Files', () => {
    const { matches, flows } = analyze(
      wrap(
        `
String p = request.getParameter("path");
Files.readString(p);
`,
        'import com.example.Files;',
      ),
    );
    assert.equal(allSinks(matches).length, 0);
    assert.equal(flows.findings.length, 0);
  });

  it('does not let a local Files receiver inherit import provenance', () => {
    const { matches, flows } = analyze(
      wrap(
        `
String p = request.getParameter("path");
Helper Files = helper;
Files.readString(p);
`,
        'import java.nio.file.Files;',
      ),
    );
    assert.equal(allSinks(matches).length, 0);
    assert.equal(flows.findings.length, 0);
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
    assert.equal(allSinks(matches).length, 1);
    assert.equal(flows.findings.length, 0);
  });

  it('does not report regular-import path constructors without a file sink', () => {
    const { matches, flows } = analyze(
      wrap(
        `
String p = request.getParameter("path");
Path.of(p);
`,
        'import java.nio.file.Path;',
      ),
    );
    assert.equal(allSinks(matches).length, 0);
    assert.equal(flows.findings.length, 0);
  });
});
