import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { createRequire, SourceMap } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';

// The dedicated runtime fixtures exercise calls with no compiler-selected declaration.
export function runtimeCalls(root, evidence, entryPoint) {
  assert.match(entryPoint, /^[A-Za-z_$][\w$]*$/, 'Expected a fixture entry point identifier');
  const scratch = mkdtempSync(path.join(tmpdir(), 'gitnexus-ts-dispatch-'));
  try {
    const input = path.join(scratch, 'input');
    const out = path.join(scratch, 'out');
    cpSync(path.join(root, 'src'), path.join(input, 'src'), { recursive: true });
    writeFileSync(path.join(scratch, 'package.json'), '{"type":"commonjs"}');
    const config = path.join(scratch, 'tsconfig.json');
    writeFileSync(
      config,
      JSON.stringify({
        files: [path.join(input, 'src/app.ts')],
        compilerOptions: {
          target: 'ES2022',
          module: 'Node16',
          types: [],
          noCheck: true,
          rootDir: input,
          outDir: out,
          sourceMap: true,
        },
      }),
    );
    const cli = fileURLToPath(new URL('bin/tsc', import.meta.resolve('typescript/package.json')));
    execFileSync(process.execPath, [cli, '--project', config], { timeout: 30_000 });
    appendFileSync(path.join(out, 'src/app.js'), '\n' + entryPoint + '();\n');
    const trace = execFileSync(process.execPath, [fileURLToPath(import.meta.url), out, input], {
      input: JSON.stringify(evidence),
      encoding: 'utf8',
      timeout: 30_000,
    });
    return JSON.parse(trace);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function comparePosition(left, right) {
  return left[0] - right[0] || left[1] - right[1];
}

async function traceCalls(out, root, { methods, unchecked }) {
  const session = new Session();
  session.connect();
  const post = (method, args = {}) =>
    new Promise((resolve, reject) =>
      session.post(method, args, (error, result) => (error ? reject(error) : resolve(result))),
    );
  const scripts = new Map();
  const breakpoints = new Map();
  const hits = [];
  try {
    session.on('Debugger.scriptParsed', ({ params }) => scripts.set(params.scriptId, params.url));
    session.on('Debugger.paused', ({ params }) => {
      const caller = params.callFrames[1]?.location;
      if (caller) hits.push({ caller, breakpoint: params.hitBreakpoints[0] });
      session.post('Debugger.resume');
    });
    await post('Debugger.enable');
    for (const file of new Set(methods.map((method) => method.file))) {
      const js = path.join(out, file.replace(/\.ts$/, '.js'));
      const program = parse(readFileSync(js, 'utf8'), { sourceType: 'script' }).program;
      for (const declaration of program.body.filter((node) => node.type === 'ClassDeclaration')) {
        for (const member of declaration.body.body) {
          const method = methods.find(
            (candidate) =>
              candidate.file === file &&
              candidate.owner === declaration.id.name &&
              candidate.name === member.key?.name,
          );
          if (!method) continue;
          const statement = member.body?.body[0];
          assert.ok(statement, 'Expected an executable method body in ' + file);
          const { line, column } = statement.loc.start;
          const { breakpointId } = await post('Debugger.setBreakpointByUrl', {
            url: pathToFileURL(js).href,
            lineNumber: line - 1,
            columnNumber: column,
          });
          breakpoints.set(breakpointId, method);
        }
      }
    }
    assert.equal(breakpoints.size, methods.length, 'Could not observe every candidate method');
    createRequire(import.meta.url)(path.join(out, 'src/app.js'));
    const sites = [],
      edges = [],
      exercised = new Set();
    for (const { caller, breakpoint } of hits) {
      const js = fileURLToPath(scripts.get(caller.scriptId));
      const mapping = new SourceMap(JSON.parse(readFileSync(js + '.map', 'utf8'))).findEntry(
        caller.lineNumber,
        caller.columnNumber,
      );
      const file = path
        .relative(root, path.resolve(path.dirname(js), mapping.originalSource))
        .split(path.sep)
        .join('/');
      const position = [mapping.originalLine, mapping.originalColumn];
      const matches = unchecked.filter(
        (site) =>
          site.file === file &&
          comparePosition(site.start, position) <= 0 &&
          comparePosition(position, site.end) < 0,
      );
      if (!matches.length) continue; // Calls with a selected declaration use the compiler.
      assert.equal(matches.length, 1, 'Runtime call falls in multiple unchecked ranges');
      const [site] = matches;
      const method = breakpoints.get(breakpoint);
      const display = ([line, column]) => line + 1 + ':' + column;
      sites.push({
        file,
        start: display(site.start),
        end: display(site.end),
        status: 'resolved',
        target: method.target,
      });
      edges.push({ from: site.caller, to: method.edgeTarget });
      exercised.add(site);
    }
    assert.ok(unchecked.length > 0, 'The fixture has no calls requiring runtime evidence');
    assert.equal(exercised.size, unchecked.length, 'Some unchecked calls were never exercised');
    return { sites, edges };
  } finally {
    session.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const trace = await traceCalls(
    process.argv[2],
    process.argv[3],
    JSON.parse(readFileSync(0, 'utf8')),
  );
  process.stdout.write(JSON.stringify(trace));
}
