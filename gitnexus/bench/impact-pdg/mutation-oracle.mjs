/**
 * U2 — SOUND mutation/dynamic ground-truth ORACLE for the impact-PDG forward
 * slice. An INDEPENDENT check on the hand-annotated `intra_AIS`: the PR's #1
 * declared validity threat is annotation circularity, so this module derives a
 * REAL DYNAMIC FORWARD SLICE by VALUE-DIFF (Infection + Propagation — NOT mere
 * coverage), and the harness cross-checks it against both the static PDG slice
 * (recall) and the manual annotation (circularity).
 *
 * Research grounding (the design this implements):
 *  - Agrawal & Horgan, "Dynamic Program Slicing", PLDI'90 — a dynamic slice is
 *    the set of statements that actually affected the criterion on an execution.
 *  - Tip, "A Survey of Program Slicing Techniques" (1995) — static ⊇ dynamic for
 *    a sound static slicer on the executed paths.
 *  - Voas, "PIE / propagation-infection-execution", TSE'92 — a fault is observed
 *    only when it is executed (E), infects state (I), and PROPAGATES (P) to an
 *    observable point. Coverage alone is only E; dependence needs I+P = an actual
 *    VALUE CHANGE. So `behavioral_AIS` is computed from value diffs, not coverage.
 *
 * ── What it does, per fixture ───────────────────────────────────────────────
 *  1. MUTATE the criterion line ONLY (≤4 mutants, line-scoped regex operators:
 *     AOR, ROR, LCR, CRP, UOI). Discard EQUIVALENT mutants (empty behavioral_AIS).
 *  2. Derive inputs via a tiny TYPE-DRIVEN generator from the criterion fn's
 *     params (number, number[], boolean, string). Multi-input covers both arms.
 *  3. INSTRUMENT the ORIGINAL TS AST with a value-transparent `__trace` wrapper on
 *     VariableDeclarator.init / AssignmentExpression RHS / ReturnStatement.arg /
 *     CallExpression — recording `(filePath:line, occ) -> serialized value` and
 *     returning the expression unchanged. loc lines are 1-based filePath:line in
 *     the SAME space as the static slice (no source-map needed).
 *  4. behavioral_AIS = { filePath:line where serialize(orig) != serialize(mut)
 *     for some input/occurrence }, EXCLUDING the criterion line, unioned over
 *     inputs then over non-equivalent mutants.
 *
 * NO production/src import. Pure ESM + Babel + tsx dynamic-import. All generated/
 * instrumented artifacts live under an os.tmpdir() dir (gn-impact-pdg-mut-*),
 * NEVER inside fixtures/. The only persisted file is the per-fixture
 * `mutation-ground-truth.json` SIDECAR (data, separate from the manual
 * `ground-truth.json`, never overwriting it).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';

const traverse = _traverse.default ?? _traverse;
const generate = _generate.default ?? _generate;

// ── deterministic value serializer ───────────────────────────────────────────
// undefined -> '#u', NaN/Infinity handled, stable key order for plain objects.
// A value change / appearance / disappearance is what makes a line "behavioral".
export function serializeValue(v) {
  if (v === undefined) return '#u';
  if (v === null) return '#n';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return '#NaN';
    if (v === Infinity) return '#+Inf';
    if (v === -Infinity) return '#-Inf';
    return 'n:' + String(v);
  }
  if (typeof v === 'boolean') return 'b:' + (v ? '1' : '0');
  if (typeof v === 'string') return 's:' + v;
  if (typeof v === 'bigint') return 'B:' + v.toString();
  if (typeof v === 'function') return 'fn';
  if (Array.isArray(v)) return '[' + v.map(serializeValue).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => k + '=' + serializeValue(v[k])).join(',') + '}';
  }
  return String(v);
}

// ── type-driven input generator ───────────────────────────────────────────────
// number -> [5, -3, 0]; number[] -> [[1,2,3], [-1,-2], []]; boolean -> [true,false];
// string -> ['a','b','z']. Multi-input is REQUIRED to cover both branch arms.
const TYPE_VALUES = {
  number: [5, -3, 0],
  'number[]': [[1, 2, 3], [-1, -2], []],
  boolean: [true, false],
  string: ['a', 'b', 'z'],
  unknown: [0],
};

function normalizeTypeAnnotation(node) {
  if (!node) return 'unknown';
  // node is a TSTypeAnnotation wrapper; unwrap to the inner type.
  const ty = node.typeAnnotation ?? node;
  if (t.isTSNumberKeyword(ty)) return 'number';
  if (t.isTSBooleanKeyword(ty)) return 'boolean';
  if (t.isTSStringKeyword(ty)) return 'string';
  if (t.isTSArrayType(ty)) {
    if (t.isTSNumberKeyword(ty.elementType)) return 'number[]';
    return 'unknown';
  }
  return 'unknown';
}

/**
 * Cartesian product of per-parameter candidate value lists, capped so the run
 * stays cheap. Returns an array of argument tuples.
 */
function inputTuplesFor(paramTypes, cap = 6) {
  let tuples = [[]];
  for (const ty of paramTypes) {
    const vals = TYPE_VALUES[ty] ?? TYPE_VALUES.unknown;
    const next = [];
    for (const partial of tuples) {
      for (const v of vals) {
        next.push([...partial, v]);
        if (next.length >= cap * 4) break;
      }
    }
    tuples = next;
  }
  // Deduplicate by serialized tuple, then cap.
  const seen = new Set();
  const out = [];
  for (const tup of tuples) {
    const key = tup.map(serializeValue).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tup);
    if (out.length >= cap) break;
  }
  return out;
}

// ── line-scoped mutation operators (regex on the criterion line text) ─────────
// AOR arithmetic, ROR relational, LCR logical, CRP numeric-literal, UOI negate.
// Each yields ≤1 replacement per applicable token; we cap the total at 4.
function lineMutants(rawLine) {
  // Split off a trailing line-comment so operators never mutate inside it (a `-`
  // injected into a comment string is harmless but a non-greedy UOI wrap would
  // otherwise swallow the comment and produce invalid syntax). The comment is
  // re-appended verbatim to every mutant so loc lines are preserved.
  const cm = rawLine.match(/^(.*?)(\s*\/\/.*)$/);
  const line = cm ? cm[1] : rawLine;
  const comment = cm ? cm[2] : '';
  const mutants = [];
  const push = (text, op) => {
    const full = text + comment;
    if (full !== rawLine && !mutants.some((m) => m.text === full)) mutants.push({ text: full, op });
  };

  // AOR: swap the FIRST binary arithmetic operator. Order matters — try + then -
  // etc. so a line with `a + 1` mutates `+`.
  const aor = [
    [/(?<=[\w)\]\s])\+(?=[\s\w(])/, '-'],
    [/(?<=[\w)\]\s])-(?=[\s\w(])/, '+'],
    [/(?<=[\w)\]\s])\*(?=[\s\w(])/, '/'],
    [/(?<=[\w)\]\s])\/(?=[\s\w(])/, '*'],
    [/(?<=[\w)\]\s])%(?=[\s\w(])/, '*'],
  ];
  for (const [re, rep] of aor) {
    if (re.test(line)) {
      push(line.replace(re, rep), 'AOR');
      break;
    }
  }

  // ROR: relational/equality. Longer operators first so `<=` is not split.
  const ror = [
    [/===/, '!=='],
    [/!==/, '==='],
    [/<=/, '>'],
    [/>=/, '<'],
    [/(?<![<>=!])<(?![<=])/, '>='],
    [/(?<![<>=!])>(?![>=])/, '<='],
  ];
  for (const [re, rep] of ror) {
    if (re.test(line)) {
      push(line.replace(re, rep), 'ROR');
      break;
    }
  }

  // LCR: logical connector / negation. Connectors first; then unary `!` flip on a
  // guard predicate (`if (!ok)` ⇒ `if (ok)`, a real control-flow change).
  const lcr = [
    [/\|\|/, '&&'],
    [/&&/, '||'],
  ];
  let lcrApplied = false;
  for (const [re, rep] of lcr) {
    if (re.test(line)) {
      push(line.replace(re, rep), 'LCR');
      lcrApplied = true;
      break;
    }
  }
  if (!lcrApplied) {
    const neg = line.match(/(?<=[(\s])!(?=[\w(])/);
    if (neg) push(line.replace(/(?<=[(\s])!(?=[\w(])/, ''), 'LCR');
  }

  // CRP: first standalone numeric literal -> k+1 (and 0 if not already 0).
  const numMatch = line.match(/(?<![\w.])(\d+)(?![\w.])/);
  if (numMatch) {
    const k = Number(numMatch[1]);
    push(line.replace(numMatch[0], String(k + 1)), 'CRP');
  }

  // UOI: when no operator was flippable on the line, negate the RHS of an
  // assignment/declarator/return by wrapping it — but only if the line carries a
  // value-bearing `=` or `return`. Keep it value-transparent-but-different.
  if (mutants.length === 0) {
    const eq = line.match(
      /^(\s*(?:const|let|var)\s+\w+\s*=\s*|.*?\breturn\s+|\s*\w+\s*=\s*)(.+?)(;?\s*)$/,
    );
    if (eq) {
      const [, head, rhs, tail] = eq;
      push(`${head}-(${rhs})${tail}`, 'UOI');
    }
  }

  return mutants.slice(0, 4);
}

// ── value-transparent instrumentation of the ORIGINAL TS AST ─────────────────
/**
 * Wrap value-bearing expressions with __trace(EXPR, line, filePath, occ). occ is
 * a per-line occurrence counter so a line evaluated multiple times (a loop body)
 * records each occurrence. Returns the instrumented source string (TS preserved;
 * tsx strips the types on import).
 */
function instrument(src, filePath) {
  const ast = parse(src, { sourceType: 'module', plugins: ['typescript'] });
  const occ = new Map();
  const wrap = (nodePath) => {
    const node = nodePath.node;
    if (!node || !node.loc) return;
    // never re-wrap our own trace call
    if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: '__trace' })) return;
    const line = node.loc.start.line;
    const o = (occ.get(line) ?? 0) + 1;
    occ.set(line, o);
    nodePath.replaceWith(
      t.callExpression(t.identifier('__trace'), [
        node,
        t.numericLiteral(line),
        t.stringLiteral(filePath),
        t.numericLiteral(o),
      ]),
    );
    nodePath.skip();
  };
  traverse(ast, {
    VariableDeclarator(p) {
      if (p.node.init) wrap(p.get('init'));
    },
    AssignmentExpression(p) {
      // wrap the RHS; the assignment value itself is observed at its own line via
      // the declarator/return sites, so wrapping the RHS captures the new value.
      if (p.node.right) wrap(p.get('right'));
    },
    ReturnStatement(p) {
      if (p.node.argument) wrap(p.get('argument'));
    },
    CallExpression(p) {
      // a bare call statement (effectful) — wrap so its return value/occurrence is
      // observed. Skips our own __trace / __tick instrumentation calls.
      if (
        t.isIdentifier(p.node.callee, { name: '__trace' }) ||
        t.isIdentifier(p.node.callee, { name: '__tick' })
      )
        return;
      wrap(p);
    },
  });
  // Bound every loop with a back-edge step budget: prepend `__tick()` to each loop
  // body so a NON-TERMINATING mutant (e.g. a flipped operator that makes a loop
  // never exit) throws `__GN_NONTERM` instead of hanging the in-process run.
  // Recursion self-terminates via stack overflow, so only loops need this guard.
  traverse(ast, {
    'ForStatement|ForInStatement|ForOfStatement|WhileStatement|DoWhileStatement'(p) {
      p.ensureBlock();
      p.get('body').unshiftContainer(
        'body',
        t.expressionStatement(t.callExpression(t.identifier('__tick'), [])),
      );
    },
  });
  const body = generate(ast, { retainLines: true }).code;
  const preamble =
    'const __traceLog=[];\n' +
    'let __ticks=0;\n' +
    'function __tick(){ if(++__ticks>50000){ throw new Error("__GN_NONTERM"); } }\n' +
    'function __trace(v,line,file,occ){__traceLog.push({line,file,occ,v});return v;}\n' +
    'export {__traceLog as __GN_TRACE_LOG};\n';
  return preamble + body;
}

// ── run one instrumented module on a tuple, collect (line:occ -> serialized) ──
async function runTraced(moduleFile, fnName, args) {
  // bust the import cache so the original and each mutant are distinct modules.
  const url = pathToFileURL(moduleFile).href + `?v=${Math.random().toString(36).slice(2)}`;
  const mod = await import(url);
  const log = mod.__GN_TRACE_LOG;
  log.length = 0;
  const fn = mod[fnName];
  if (typeof fn !== 'function') {
    throw new Error(`instrumented module has no exported function ${fnName}`);
  }
  let threw = null;
  let nonTerminating = false;
  try {
    fn(...args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('__GN_NONTERM')) nonTerminating = true;
    threw = msg;
  }
  // A non-terminating mutant yields no finite value trace — return empty so the
  // diff SKIPS it (logged, excluded from behavioral_AIS) rather than letting its
  // partial loop trace fabricate spurious per-iteration diffs.
  if (nonTerminating) return { observed: new Map(), threw, nonTerminating: true };
  // (filePath:line, occ) -> serialized value. A line may appear multiple times;
  // key on occurrence so a per-iteration value change is observed.
  const observed = new Map();
  for (const rec of log) {
    observed.set(`${rec.file}:${rec.line}#${rec.occ}`, serializeValue(rec.v));
  }
  return { observed, threw, nonTerminating: false };
}

/** parse `function name(params)` signatures to get the criterion's param types. */
function criterionParamTypes(src, fnName) {
  const ast = parse(src, { sourceType: 'module', plugins: ['typescript'] });
  let types = [];
  traverse(ast, {
    'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression'(p) {
      const id = p.node.id;
      const isMatch =
        (id && id.name === fnName) ||
        (t.isVariableDeclarator(p.parent) &&
          t.isIdentifier(p.parent.id) &&
          p.parent.id.name === fnName);
      if (!isMatch) return;
      types = p.node.params.map((param) => {
        const ann = t.isIdentifier(param) ? param.typeAnnotation : param.typeAnnotation;
        return normalizeTypeAnnotation(ann);
      });
      p.stop();
    },
  });
  return types;
}

/**
 * Derive the behavioral (dynamic) AIS for a fixture.
 *
 * @param {{name:string, dir:string, gt:object}} fx — fixture record (gt is the
 *   manual ground-truth.json).
 * @param {string} workDir — the SAME temp working copy the analyze step used
 *   (so `workDir/src/<file>` line numbers align with the static slice keys).
 * @returns {Promise<{
 *   behavioralAis: string[],            // sorted `<filePath>:<line>` keys (criterion excluded)
 *   criterionLine: number,
 *   criterionKey: string,
 *   filePath: string,
 *   inputs: unknown[][],                // the tuples used
 *   paramTypes: string[],
 *   mutants: {op:string, text:string, equivalent:boolean, diffLines:string[]}[],
 *   skipped: null|string,               // a reason if the oracle could not run
 * }>}
 */
export async function deriveBehavioralAis(fx, workDir) {
  const filePath = fx.gt.criterion.filePath; // repo-relative `src/...`
  const fnName = fx.gt.criterion.name;
  const criterionLine = fx.gt.criterion.line;
  const criterionKey = `${filePath}:${criterionLine}`;
  const absSrc = path.join(workDir, filePath);

  const empty = {
    behavioralAis: [],
    criterionLine: criterionLine ?? null,
    criterionKey,
    filePath,
    inputs: [],
    paramTypes: [],
    mutants: [],
    skipped: null,
  };

  if (!criterionLine || !fs.existsSync(absSrc)) {
    return { ...empty, skipped: `criterion file/line missing (${absSrc}:${criterionLine})` };
  }

  const src = fs.readFileSync(absSrc, 'utf8');
  const srcLines = src.split('\n');
  const lineText = srcLines[criterionLine - 1];
  if (lineText === undefined) {
    return { ...empty, skipped: `criterion line ${criterionLine} out of range` };
  }

  const paramTypes = criterionParamTypes(src, fnName);
  const inputs = inputTuplesFor(paramTypes);
  if (inputs.length === 0) {
    return { ...empty, paramTypes, skipped: 'no inputs derivable' };
  }

  const mutantSpecs = lineMutants(lineText);
  if (mutantSpecs.length === 0) {
    return { ...empty, paramTypes, inputs, skipped: 'no applicable mutation operator on line' };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-impact-pdg-mut-'));
  const mutants = [];
  const aisLines = new Set();
  try {
    // Instrument the ORIGINAL once; copy the whole src tree so cross-file imports
    // (if any) still resolve, then overwrite the criterion file.
    fs.cpSync(path.join(workDir, 'src'), path.join(tmp, 'src'), { recursive: true });
    const instrumentedOriginal = instrument(src, filePath);
    const origFile = path.join(tmp, filePath);
    fs.writeFileSync(origFile, instrumentedOriginal);

    // Baseline traces (one per input tuple).
    const baseline = [];
    for (const args of inputs) baseline.push(await runTraced(origFile, fnName, args));

    let mi = 0;
    for (const spec of mutantSpecs) {
      mi += 1;
      const mutLines = srcLines.slice();
      mutLines[criterionLine - 1] = spec.text;
      const mutSrc = mutLines.join('\n');
      // Instrument the MUTANT source (same loc space — the mutated line keeps its
      // line number; retainLines preserves all other lines). A regex operator can
      // occasionally produce syntactically invalid TS (e.g. a `-` injected where a
      // unary context makes it ambiguous); such a mutant is not a valid program, so
      // it is SKIPPED (recorded as invalid, never crashes the pass).
      let instrumentedMutant;
      try {
        instrumentedMutant = instrument(mutSrc, filePath);
      } catch {
        mutants.push({
          op: spec.op,
          text: spec.text,
          equivalent: true,
          invalid: true,
          diffLines: [],
        });
        continue;
      }
      const mutFile = path.join(tmp, `mut${mi}__${path.basename(filePath)}`);
      fs.writeFileSync(mutFile, instrumentedMutant);

      const diffLines = new Set();
      let nonTerminating = false;
      for (let i = 0; i < inputs.length; i++) {
        const mutRun = await runTraced(mutFile, fnName, inputs[i]);
        if (mutRun.nonTerminating) {
          nonTerminating = true;
          break;
        }
        const base = baseline[i];
        // union of keys observed in either run (a value can appear/disappear).
        const keys = new Set([...base.observed.keys(), ...mutRun.observed.keys()]);
        for (const k of keys) {
          const bv = base.observed.get(k);
          const mv = mutRun.observed.get(k);
          if (bv !== mv) {
            // strip the occurrence suffix back to a `<filePath>:<line>` key.
            const lineOnly = k.slice(0, k.lastIndexOf('#'));
            diffLines.add(lineOnly);
          }
        }
        // A divergence in throw-behaviour is itself propagation to the return
        // point: attribute it to the criterion line's continuation. We DON'T add
        // the criterion line (excluded below), but a differing throw with no value
        // diff still implies the function-result line changed — captured via the
        // return-line value diff already (return not reached => key disappears).
      }
      if (nonTerminating) {
        // The criterion mutation made a downstream loop non-terminating. This proves
        // divergence but yields no observable per-statement value trace, so it is
        // LOGGED and EXCLUDED from behavioral_AIS — excluding it keeps recall sound
        // (behavioral_AIS stays a subset of the true dynamic forward slice).
        mutants.push({
          op: spec.op,
          text: spec.text,
          equivalent: false,
          nonTerminating: true,
          diffLines: [],
        });
        continue;
      }
      // EXCLUDE the criterion line itself.
      diffLines.delete(criterionKey);
      const diffArr = [...diffLines].sort();
      const equivalent = diffArr.length === 0;
      mutants.push({ op: spec.op, text: spec.text, equivalent, diffLines: diffArr });
      // EQUIVALENT mutants (empty behavioral set) are DISCARDED from the union.
      if (!equivalent) for (const l of diffArr) aisLines.add(l);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return {
    behavioralAis: [...aisLines].sort(),
    criterionLine,
    criterionKey,
    filePath,
    inputs,
    paramTypes,
    mutants,
    skipped: null,
  };
}

/**
 * Write/refresh the per-fixture audit sidecar (provenance:'mutation'). SEPARATE
 * from the manual ground-truth.json — never overwrites it. Returns the path.
 */
export function writeMutationSidecar(fx, derived) {
  const out = {
    schemaVersion: 1,
    provenance: 'mutation',
    criterion: {
      name: fx.gt.criterion.name,
      filePath: derived.filePath,
      line: derived.criterionLine,
    },
    paramTypes: derived.paramTypes,
    inputs: derived.inputs,
    behavioral_AIS: derived.behavioralAis,
    mutants: derived.mutants,
    skipped: derived.skipped,
    note:
      'AUTO-GENERATED dynamic forward-slice oracle (U2). VALUE-DIFF behavioral AIS ' +
      '(Infection+Propagation, not coverage). Regenerated by `measure.mjs --mutation`. ' +
      'Independent cross-check of the manual ground-truth.json — NOT a hand annotation.',
  };
  const sidecarPath = path.join(fx.dir, 'mutation-ground-truth.json');
  fs.writeFileSync(sidecarPath, JSON.stringify(out, null, 2) + '\n');
  return sidecarPath;
}
