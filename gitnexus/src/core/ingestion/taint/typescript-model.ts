/**
 * Built-in TS/JS taint model (#2083 M3 U2, plan KTD7).
 *
 * The canonical Express/Node source/sink/sanitizer set plus the Java and
 * Python models, registered for their language ids via the EXPLICIT
 * {@link registerBuiltinTaintModels} seam — deliberately not an import
 * side-effect, so the U4 emit path controls WHEN registration happens (call
 * it once before the pdg window runs; it is idempotent — the registry is
 * last-write-wins on the same language id).
 *
 * `taintModelVersion` is a deterministic digest of the FULL model content
 * (entries, kinds, args, modules). It joins the RepoMeta `pdg` stamp in U5 so
 * that ANY model change — adding an entry, relabeling a kind — trips full
 * writeback on an existing `--pdg` index (R7): persisted findings must never
 * outlive the model that produced them.
 */

import { createHash } from 'node:crypto';
import { SupportedLanguages } from 'gitnexus-shared';
import type { SourceSinkSanitizerSpec } from './source-sink-config.js';
import { JAVA_TAINT_MODEL } from './java-model.js';
import { PYTHON_TAINT_MODEL } from './python-model.js';
import { registerSourceSinkConfig } from './source-sink-registry.js';

/**
 * The built-in TS/JS model. Module provenance uses bare specifier names —
 * the matcher normalizes the `node:` scheme prefix, so `import { exec } from
 * 'node:child_process'` resolves identically.
 */
export const TS_JS_TAINT_MODEL: SourceSinkSanitizerSpec = {
  sources: [
    // Express-convention request member reads, matched name-based on the
    // receiver (`req`/`request`) — the plan's accepted Semgrep-style trade.
    {
      kind: 'remote-input',
      objects: ['req', 'request'],
      properties: ['body', 'query', 'params', 'headers', 'cookies'],
    },
  ],
  sinks: [
    // Command execution — the command string is argument 0.
    { name: 'exec', kind: 'command-injection', args: [0], module: 'child_process' },
    { name: 'execSync', kind: 'command-injection', args: [0], module: 'child_process' },
    { name: 'spawn', kind: 'command-injection', args: [0], module: 'child_process' },
    // Code evaluation. `eval` takes code at 0; `new Function(...)` treats
    // EVERY argument as source text (params + body), so `args` is omitted
    // (= all positions) rather than pinned to 0.
    { name: 'eval', kind: 'code-injection', args: [0], global: true },
    { name: 'Function', kind: 'code-injection', global: true, newOnly: true },
    // Filesystem path consumption — path argument 0.
    { name: 'readFile', kind: 'path-traversal', args: [0], module: 'fs' },
    { name: 'readFileSync', kind: 'path-traversal', args: [0], module: 'fs' },
    { name: 'writeFile', kind: 'path-traversal', args: [0], module: 'fs' },
    { name: 'writeFileSync', kind: 'path-traversal', args: [0], module: 'fs' },
    // SQL — `.query(sql)` / `.execute(sql)` member calls on ANY receiver
    // (mysql2/pg/knex handles go by many names; receiver-conventional).
    { name: 'query', kind: 'sql-injection', args: [0], anyReceiver: true },
    { name: 'execute', kind: 'sql-injection', args: [0], anyReceiver: true },
    // Reflected XSS — Express response writes, conventional receiver `res`.
    { name: 'send', kind: 'xss', args: [0], receivers: ['res'] },
    { name: 'write', kind: 'xss', args: [0], receivers: ['res'] },
  ],
  sanitizers: [
    // URL-encoding: neutralizes markup injection AND path separators
    // (`%2F` is not a separator inside a path component).
    { name: 'encodeURIComponent', neutralizes: ['xss', 'path-traversal'], global: true },
    // `escape-html` exports its function as the module default — the
    // `'default'` pseudo-name matches the default-imported / require'd
    // module handle being invoked directly.
    { name: 'default', neutralizes: ['xss'], module: 'escape-html' },
    { name: 'encode', neutralizes: ['xss'], module: 'he' },
    { name: 'basename', neutralizes: ['path-traversal'], module: 'path' },
    { name: 'escape', neutralizes: ['xss'], module: 'validator' },
  ],
};

/**
 * Deterministic digest of a spec's full content. Key order is canonicalized
 * (recursively sorted) so the version reflects CONTENT, not literal layout;
 * array order is semantic (entry identity) and intentionally preserved.
 */
export function computeTaintModelVersion(spec: SourceSinkSanitizerSpec): string {
  return computeModelDigest(spec);
}

function computeModelDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 12);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export const BUILTIN_TAINT_MODELS = {
  [SupportedLanguages.Java]: JAVA_TAINT_MODEL,
  [SupportedLanguages.JavaScript]: TS_JS_TAINT_MODEL,
  [SupportedLanguages.Python]: PYTHON_TAINT_MODEL,
  [SupportedLanguages.TypeScript]: TS_JS_TAINT_MODEL,
} as const satisfies Record<string, SourceSinkSanitizerSpec>;

/**
 * Version stamp of every built-in model (joins the RepoMeta pdg key in U5).
 * Adding a language model must invalidate existing persisted taint findings.
 */
export const taintModelVersion: string = computeModelDigest(BUILTIN_TAINT_MODELS);

/**
 * Register the built-in models for Java, TypeScript, JavaScript, and Python.
 * Explicit init seam for the U4 emit path (call before the pdg window
 * consumes the registry); idempotent. Other language ids remain unregistered
 * until they have a dedicated model.
 */
export function registerBuiltinTaintModels(): void {
  registerSourceSinkConfig(SupportedLanguages.Java, JAVA_TAINT_MODEL);
  registerSourceSinkConfig(SupportedLanguages.TypeScript, TS_JS_TAINT_MODEL);
  registerSourceSinkConfig(SupportedLanguages.JavaScript, TS_JS_TAINT_MODEL);
  registerSourceSinkConfig(SupportedLanguages.Python, PYTHON_TAINT_MODEL);
}
