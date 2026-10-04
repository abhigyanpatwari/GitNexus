import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const tsc = path.join(packageRoot, 'node_modules/typescript/lib/tsc.js');

// Keep messages stable across checkout locations and operating systems. Line
// numbers are deliberately not identities: adding a test must not rebaseline
// every diagnostic below it. Occurrence counts still catch repeated errors.
function normalizeMessage(message, cwd) {
  return message.replace(/import\("([^"\n]*)"\)/g, (_match, modulePath) => {
    const normalized = modulePath
      .replaceAll('\\', '/')
      .replace(/^.*\/node_modules\//, '<node_modules>/')
      .replace(cwd.replaceAll('\\', '/') + '/', '');
    return `import("${normalized}")`;
  });
}

export function parseDiagnostics(output, cwd) {
  const diagnostics = [];
  for (const line of output.replaceAll('\r\n', '\n').split('\n')) {
    if (!line.trim()) continue;
    const match = /^(.+)\((\d+),(\d+)\): error TS(\d+): (.*)$/.exec(line);
    if (match) {
      const file = path.relative(cwd, path.resolve(cwd, match[1])).replaceAll('\\', '/');
      diagnostics.push({
        file,
        line: Number(match[2]),
        column: Number(match[3]),
        code: Number(match[4]),
        message: normalizeMessage(match[5], cwd),
      });
    } else if (/^\s/.test(line) && diagnostics.length) {
      diagnostics.at(-1).message += '\n' + normalizeMessage(line, cwd);
    } else {
      // Config errors, compiler crashes and unexpected output must never become
      // baseline entries or silently turn a failed compiler invocation green.
      throw new Error(`Unrecognized TypeScript diagnostic: ${line}`);
    }
  }
  return diagnostics;
}

function key({ file, code, message }) {
  return JSON.stringify([file, code, message]);
}

export function summarize(diagnostics) {
  const entries = new Map();
  for (const { file, code, message } of diagnostics) {
    const id = key({ file, code, message });
    const entry = entries.get(id) ?? { file, code, message, count: 0 };
    entry.count++;
    entries.set(id, entry);
  }
  return [...entries.values()].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

function readBaseline(baselinePath) {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  if (baseline.version !== 1 || !Array.isArray(baseline.diagnostics)) {
    throw new Error('Invalid test typecheck baseline');
  }
  const seen = new Set();
  for (const entry of baseline.diagnostics) {
    if (
      typeof entry.file !== 'string' ||
      !entry.file.startsWith('test/') ||
      entry.file.split('/').includes('..') ||
      !Number.isInteger(entry.code) ||
      typeof entry.message !== 'string' ||
      !Number.isInteger(entry.count) ||
      entry.count < 1 ||
      seen.has(key(entry))
    ) {
      throw new Error('Invalid or duplicate test typecheck baseline entry');
    }
    seen.add(key(entry));
  }
  return baseline.diagnostics;
}

export function collectDiagnostics(projectPath) {
  const cwd = path.dirname(projectPath);
  const result = spawnSync(process.execPath, [tsc, '-p', projectPath, '--pretty', 'false'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.signal || ![0, 1, 2].includes(result.status) || result.stderr.trim()) {
    throw new Error(
      `TypeScript failed: ${result.error ?? result.signal ?? result.stderr ?? result.status}`,
    );
  }
  const diagnostics = parseDiagnostics(result.stdout, cwd);
  if ((result.status === 0) !== (diagnostics.length === 0)) {
    throw new Error('TypeScript exit status does not match its diagnostics');
  }
  return diagnostics;
}

export function checkTypes({ projectPath, baselinePath, updateBaseline = false }) {
  const baseline = readBaseline(baselinePath);
  const diagnostics = collectDiagnostics(projectPath);
  const remaining = new Map(baseline.map((entry) => [key(entry), entry.count]));
  const added = diagnostics.filter((diagnostic) => {
    const count = remaining.get(key(diagnostic)) ?? 0;
    if (count === 0 || !diagnostic.file.startsWith('test/')) return true;
    remaining.set(key(diagnostic), count - 1);
    return false;
  });
  if (added.length) {
    for (const d of added) {
      console.error(`${d.file}(${d.line},${d.column}): error TS${d.code}: ${d.message}`);
    }
    console.error(
      `${added.length} new type error(s). Fix them; the baseline cannot be expanded by this command.`,
    );
    return 1;
  }
  const removed = [...remaining.values()].reduce((sum, count) => sum + count, 0);
  if (updateBaseline) {
    writeFileSync(
      baselinePath,
      JSON.stringify({ version: 1, diagnostics: summarize(diagnostics) }, null, 2) + '\n',
    );
    console.log(`Removed ${removed} resolved diagnostic(s) from the test typecheck baseline.`);
  } else if (removed) {
    console.error(
      `${removed} baseline diagnostic(s) no longer occur. Run npm run typecheck:tests:update and commit the reduced baseline.`,
    );
    return 1;
  }
  console.log(
    `Test typecheck passed: no new errors (${diagnostics.length} existing diagnostics tracked).`,
  );
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--update-baseline')) {
      throw new Error('Usage: node scripts/typecheck-tests.mjs [--update-baseline]');
    }
    process.exitCode = checkTypes({
      projectPath: path.join(packageRoot, 'tsconfig.test.json'),
      baselinePath: path.join(packageRoot, 'test/typecheck-baseline.json'),
      updateBaseline: args.includes('--update-baseline'),
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
