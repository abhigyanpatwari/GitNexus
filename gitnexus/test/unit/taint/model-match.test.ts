/**
 * U2 (#2083 M3) — built-in TS/JS taint model + import-aware site matcher.
 *
 * Fixtures parse REAL source: CFGs (and therefore SiteRecords) come from the
 * worker-side TS CFG visitor (the harvest.test.ts harness pattern), and
 * ParsedImports come from the real scope-capture + interpretTsImport path
 * (the typescript-imports.test.ts harness pattern) — matches run against the
 * exact structures U4 will feed the matcher, never hand-built mocks.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { cfgOf, importsFor } from '../../helpers/ts-cfg-harness.js';
import { hasTaintSafeSites } from '../../../src/core/ingestion/taint/site-safety.js';
import type { SourceSinkSanitizerSpec } from '../../../src/core/ingestion/taint/source-sink-config.js';
import {
  BUILTIN_TAINT_MODELS,
  TS_JS_TAINT_MODEL,
  computeTaintModelVersion,
  registerBuiltinTaintModels,
  taintModelVersion,
} from '../../../src/core/ingestion/taint/typescript-model.js';
import {
  buildTaintImportIndex,
  matchFunctionSites,
  type FunctionSiteMatches,
  type MatchedSanitizerCall,
  type MatchedSinkCall,
  type MatchedSource,
} from '../../../src/core/ingestion/taint/match.js';
import {
  getSourceSinkConfig,
  clearSourceSinkRegistry,
  registeredTaintLanguages,
} from '../../../src/core/ingestion/taint/source-sink-registry.js';

/** Match function #`fnIndex` of `code` against the built-in model (or `spec`). */
function matchesOf(
  code: string,
  fnIndex = 0,
  spec: SourceSinkSanitizerSpec = TS_JS_TAINT_MODEL,
): FunctionSiteMatches {
  const cfg = cfgOf(code, fnIndex);
  // The matcher's documented precondition — real harvests must always pass.
  expect(hasTaintSafeSites(cfg)).toBe(true);
  return matchFunctionSites(cfg, spec, buildTaintImportIndex(importsFor(code)));
}

const allSinks = (m: FunctionSiteMatches): MatchedSinkCall[] =>
  m.statements.flatMap((s) => [...s.sinks]);
const allSources = (m: FunctionSiteMatches): MatchedSource[] =>
  m.statements.flatMap((s) => [...s.sources]);
const allSanitizers = (m: FunctionSiteMatches): MatchedSanitizerCall[] =>
  m.statements.flatMap((s) => [...s.sanitizers]);

describe('sink resolution — ESM import joins', () => {
  it('named import: `import { exec } from "child_process"; exec(c)` matches command-injection', () => {
    const m = matchesOf(`import { exec } from 'child_process';
function f(c) { exec(c); }`);
    const sinks = allSinks(m);
    expect(sinks).toHaveLength(1);
    expect(sinks[0].entry.kind).toBe('command-injection');
    expect(sinks[0].entry.name).toBe('exec');
    expect([...sinks[0].argPositions]).toEqual([0]);
    expect(m.hasSink).toBe(true);
  });

  it('alias import: `import { exec as run }` — run(c) resolves to child_process.exec', () => {
    const m = matchesOf(`import { exec as run } from 'child_process';
function f(c) { run(c); }`);
    const sinks = allSinks(m);
    expect(sinks).toHaveLength(1);
    expect(sinks[0].entry.name).toBe('exec');
  });

  it('namespace import: `import * as cp` — cp.exec(c) resolves via the receiver binding', () => {
    const m = matchesOf(`import * as cp from 'child_process';
function f(c) { cp.exec(c); }`);
    expect(allSinks(m).map((s) => s.entry.name)).toEqual(['exec']);
  });

  it('named import from a same-tail module is not canonicalized as a namespace handle', () => {
    const spec: SourceSinkSanitizerSpec = {
      sources: [],
      sinks: [{ name: 'readString', kind: 'path-traversal', args: [0], module: 'pkg.Files' }],
      sanitizers: [],
    };
    const m = matchesOf(
      `import { Files } from 'pkg.Files';
function f(p) { Files.readString(p); }`,
      0,
      spec,
    );
    expect(allSinks(m)).toHaveLength(0);
  });

  it('node: scheme prefix is normalized — `from "node:child_process"` matches too', () => {
    const m = matchesOf(`import { execSync } from 'node:child_process';
function f(c) { execSync(c); }`);
    expect(allSinks(m).map((s) => s.entry.name)).toEqual(['execSync']);
  });

  it('argv-form child_process sinks match command injection on arg 0', () => {
    const m = matchesOf(`import { execFile, execFileSync, spawnSync } from 'node:child_process';
function f(cmd, arg) {
  execFile(cmd, [arg]);
  execFileSync(cmd, [arg]);
  spawnSync(cmd, [arg]);
}`);
    expect(allSinks(m).map((s) => s.entry.name)).toEqual(['execFile', 'execFileSync', 'spawnSync']);
    expect(allSinks(m).map((s) => [...s.argPositions])).toEqual([
      [0, 1],
      [0, 1],
      [0, 1],
    ]);
    expect(allSinks(m).every((s) => s.entry.kind === 'command-injection')).toBe(true);
  });

  it('an in-FUNCTION local `exec` shadows the import — no match', () => {
    const m = matchesOf(`import { exec } from 'child_process';
function f(c) { function exec(x) { return x; } exec(c); }`);
    expect(allSinks(m)).toHaveLength(0);
    expect(m.hasSink).toBe(false);
  });

  it('a module-level local `exec` (no import) does NOT match — synthetic binding, no import entry', () => {
    const m = matchesOf(
      `function exec(x) { return x; }
function g(c) { exec(c); }`,
      1, // g — index 0 is the local exec itself
    );
    expect(allSinks(m)).toHaveLength(0);
  });
});

describe('sink resolution — globals and require joins', () => {
  it('eval(x) matches code-injection via the synthetic-global fallback', () => {
    const m = matchesOf(`function f(x) { eval(x); }`);
    const sinks = allSinks(m);
    expect(sinks).toHaveLength(1);
    expect(sinks[0].entry.kind).toBe('code-injection');
  });

  it('`new Function(x)` matches; a bare `Function(x)` CALL does not (newOnly)', () => {
    const withNew = matchesOf(`function f(x) { const fn = new Function(x); }`);
    expect(allSinks(withNew).map((s) => s.entry.name)).toEqual(['Function']);
    const bareCall = matchesOf(`function f(x) { const fn = Function(x); }`);
    expect(allSinks(bareCall)).toHaveLength(0);
  });

  it('require literal join: `const cp = require("child_process"); cp.exec(c)` matches', () => {
    const m = matchesOf(`function f(c) { const cp = require('child_process'); cp.exec(c); }`);
    const sinks = allSinks(m);
    expect(sinks).toHaveLength(1);
    expect(sinks[0].entry.name).toBe('exec');
    expect(sinks[0].entry.kind).toBe('command-injection');
  });

  it('a require’d local utility named exec does NOT match (no bare-name fallback for non-globals)', () => {
    const m = matchesOf(`function f(c) { const exec = require('./my-utils'); exec(c); }`);
    expect(allSinks(m)).toHaveLength(0);
  });

  it('non-renamed destructured require resolves via the dual interpretation', () => {
    const m = matchesOf(`function f(c) { const { exec } = require('child_process'); exec(c); }`);
    expect(allSinks(m).map((s) => s.entry.name)).toEqual(['exec']);
  });
});

describe('sources — conventional member reads', () => {
  it('req.body matches remote-input; request.body matches; myObj.body does not', () => {
    const m = matchesOf(`function f(req, request, myObj) {
      const a = req.body;
      const b = request.body;
      const c = myObj.body;
    }`);
    const sources = allSources(m);
    expect(sources).toHaveLength(2);
    expect(sources.every((s) => s.entry.kind === 'remote-input')).toBe(true);
    expect(m.hasSource).toBe(true);
  });

  it('all five conventional properties match; an unlisted property does not', () => {
    const m = matchesOf(`function f(req) {
      const a = req.body, b = req.query, c = req.params, d = req.headers, e = req.cookies;
      const z = req.socket;
    }`);
    expect(allSources(m)).toHaveLength(5);
  });
});

describe('sink argument-position discipline', () => {
  it('exec(safe, tainted): only the registered position 0 is a sink position', () => {
    const m = matchesOf(`import { exec } from 'child_process';
function f(safe, tainted) { exec(safe, tainted); }`);
    const [sink] = allSinks(m);
    expect([...sink.argPositions]).toEqual([0]); // position 1 carries an occurrence but is not registered
  });

  it('spread: exec(...args) matches — recorded position ≥ spread index degrades soundly', () => {
    const m = matchesOf(`import { exec } from 'child_process';
function f(args) { exec(...args); }`);
    const [sink] = allSinks(m);
    expect([...sink.argPositions]).toEqual([0]);
  });

  it('spread precision: a pre-spread position stays exact; post-spread matches any q ≥ spread', () => {
    // Custom spec: sink position 1 only. `s2(a, ...rest)` — recorded 0 is
    // BEFORE the spread (exact: no match); recorded 1 is the spread (match).
    const spec: SourceSinkSanitizerSpec = {
      sources: [],
      sinks: [{ name: 's2', kind: 'command-injection', args: [1], global: true }],
      sanitizers: [],
    };
    const m = matchesOf(`function f(a, rest) { s2(a, ...rest); }`, 0, spec);
    const [sink] = allSinks(m);
    expect([...sink.argPositions]).toEqual([1]);
  });

  it('tagged template: substitutions aggregate at position 0 and match any registered position', () => {
    const spec: SourceSinkSanitizerSpec = {
      sources: [],
      sinks: [{ name: 'sql', kind: 'sql-injection', args: [1], global: true }],
      sanitizers: [],
    };
    const m = matchesOf(`function f(id) { sql\`select \${id}\`; }`, 0, spec);
    const [sink] = allSinks(m);
    expect([...sink.argPositions]).toEqual([0]);
  });

  it('a sink whose dangerous positions carry no occurrences is not reported', () => {
    const m = matchesOf(`import { exec } from 'child_process';
function f(t) { exec('ls -la', t); }`);
    expect(allSinks(m)).toHaveLength(0);
  });
});

describe('receiver-conventional sinks', () => {
  it('res.send / res.write match xss; out.send does not', () => {
    const m = matchesOf(`function f(res, out, x) { res.send(x); res.write(x); out.send(x); }`);
    expect(allSinks(m).map((s) => s.entry.name)).toEqual(['send', 'write']);
    expect(allSinks(m).every((s) => s.entry.kind === 'xss')).toBe(true);
  });

  it('res.render matches template and data args; out.render does not', () => {
    const m = matchesOf(`function f(res, out, template, data) {
      res.render(template, data);
      out.render(template, data);
    }`);
    const sinks = allSinks(m);
    expect(sinks.map((s) => s.entry.name)).toEqual(['render']);
    expect(sinks.map((s) => [...s.argPositions])).toEqual([[0, 1]]);
    expect(sinks[0].entry.kind).toBe('xss');
  });

  it('.query/.execute match sql-injection on ANY receiver', () => {
    const m = matchesOf(`function f(db, pool, x) { db.query(x); pool.execute(x); }`);
    expect(allSinks(m).map((s) => s.entry.kind)).toEqual(['sql-injection', 'sql-injection']);
  });

  it('modern DB method sinks match only conventional DB receivers', () => {
    const m = matchesOf(`function f(db, stmt, knex, map, task, x) {
      db.run(x);
      db.all(x);
      stmt.get(x);
      knex.raw(x);
      db.values(x);
      map.get(x);
      task.run(x);
    }`);
    expect(allSinks(m).map((s) => s.entry.name)).toEqual(['run', 'all', 'get', 'raw', 'values']);
    expect(allSinks(m).every((s) => s.entry.kind === 'sql-injection')).toBe(true);
  });
});

describe('sanitizers — import-aware only, kind-scoped', () => {
  it('path.basename matches and neutralizes path-traversal, NOT command-injection', () => {
    const m = matchesOf(`import path from 'path';
function f(p) { const safe = path.basename(p); }`);
    const sans = allSanitizers(m);
    expect(sans).toHaveLength(1);
    expect(sans[0].entry.neutralizes).toContain('path-traversal');
    expect(sans[0].entry.neutralizes).not.toContain('command-injection');
    // resultDefs carries the kill target (KTD4b)
    expect(sans[0].resultDefs).toHaveLength(1);
  });

  it('validator.escape via named import matches xss', () => {
    const m = matchesOf(`import { escape } from 'validator';
function f(x) { const safe = escape(x); }`);
    const sans = allSanitizers(m);
    expect(sans).toHaveLength(1);
    expect([...sans[0].entry.neutralizes]).toEqual(['xss']);
  });

  it('default-imported escape-html matches via the default pseudo-name', () => {
    const m = matchesOf(`import escapeHtml from 'escape-html';
function f(x) { const safe = escapeHtml(x); }`);
    expect(allSanitizers(m)).toHaveLength(1);
  });

  it('encodeURIComponent matches as a true global (xss + path-traversal)', () => {
    const m = matchesOf(`function f(x) { const safe = encodeURIComponent(x); }`);
    const sans = allSanitizers(m);
    expect(sans).toHaveLength(1);
    expect([...sans[0].entry.neutralizes]).toEqual(['xss', 'path-traversal']);
  });

  it('a user-defined in-file `escape` is NEVER a sanitizer (no bare-name resolution)', () => {
    const m = matchesOf(
      `function escape(s) { return s; }
function f(x) { const safe = escape(x); }`,
      1, // f
    );
    expect(allSanitizers(m)).toHaveLength(0);
  });

  it('value-position sanitizer (exec(escape(x))) matches with EMPTY resultDefs — interposition substrate', () => {
    const m = matchesOf(`import { exec } from 'child_process';
import { escape } from 'validator';
function f(x) { exec(escape(x)); }`);
    const sans = allSanitizers(m);
    expect(sans).toHaveLength(1);
    expect(sans[0].resultDefs).toHaveLength(0);
    // The sink still matches — interposition is U3's call, not the matcher's.
    expect(allSinks(m)).toHaveLength(1);
  });
});

describe('registry + model identity', () => {
  beforeEach(() => clearSourceSinkRegistry());

  it('registerBuiltinTaintModels registers TS, JS, and Python (idempotent); others stay undefined', () => {
    registerBuiltinTaintModels();
    registerBuiltinTaintModels(); // idempotent — last-write-wins on the same ids
    expect(registeredTaintLanguages().sort()).toEqual([
      'java',
      'javascript',
      'python',
      'typescript',
    ]);
    expect(getSourceSinkConfig('java')).toBe(BUILTIN_TAINT_MODELS.java);
    expect(getSourceSinkConfig('typescript')).toBe(TS_JS_TAINT_MODEL);
    expect(getSourceSinkConfig('javascript')).toBe(TS_JS_TAINT_MODEL);
    expect(getSourceSinkConfig('python')).toBe(BUILTIN_TAINT_MODELS.python);
    expect(getSourceSinkConfig('ruby')).toBeUndefined();
  });

  it('taintModelVersion covers the full built-in model registry', () => {
    expect(taintModelVersion).toMatch(/^[0-9a-f]{12}$/);
    expect(taintModelVersion).not.toBe(computeTaintModelVersion(TS_JS_TAINT_MODEL));
  });

  it('adding an entry changes the version', () => {
    const added: SourceSinkSanitizerSpec = {
      ...TS_JS_TAINT_MODEL,
      sinks: [...TS_JS_TAINT_MODEL.sinks, { name: 'load', kind: 'code-injection', module: 'vm' }],
    };
    expect(computeTaintModelVersion(added)).not.toBe(computeTaintModelVersion(TS_JS_TAINT_MODEL));
  });

  it('changing only a kind label changes the version', () => {
    const relabeled: SourceSinkSanitizerSpec = {
      ...TS_JS_TAINT_MODEL,
      sinks: TS_JS_TAINT_MODEL.sinks.map((s) =>
        s.name === 'exec' ? { ...s, kind: 'xss' as const } : s,
      ),
    };
    expect(computeTaintModelVersion(relabeled)).not.toBe(
      computeTaintModelVersion(TS_JS_TAINT_MODEL),
    );
  });

  it('the version is content-derived: key order does not matter, entry order does', () => {
    const reordered: SourceSinkSanitizerSpec = {
      sanitizers: TS_JS_TAINT_MODEL.sanitizers,
      sinks: TS_JS_TAINT_MODEL.sinks,
      sources: TS_JS_TAINT_MODEL.sources,
    };
    expect(computeTaintModelVersion(reordered)).toBe(computeTaintModelVersion(TS_JS_TAINT_MODEL));
  });
});
