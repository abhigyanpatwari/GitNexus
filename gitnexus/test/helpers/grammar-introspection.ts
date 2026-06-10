/**
 * Grammar introspection helper for the tree-sitter node-type / field-name
 * validation gate (issue #1920).
 *
 * Two oracles, layered (see the plan's KTD1):
 *   1. A fast **membership set** built from each grammar's static
 *      `node-types.json` — the union of every top-level `type`, every
 *      `subtypes[].type`, and every children/per-field `types[].type`,
 *      retaining anonymous (`named:false`) tokens and supertype names.
 *   2. A `probeNodeType` **authoritative fallback** that compiles a probe
 *      query against the *live* grammar — used for any literal the static
 *      JSON under-reports (regex / `token(...)` tokens, aliased nodes).
 *
 * This file lives under `test/` and is therefore allowed to name languages
 * (the AGENTS.md "shared pipeline code must not name languages" rule applies
 * to `src/core/ingestion/`, not to test helpers). The live-grammar access and
 * the tsx/php_only variant handling are delegated to the production
 * `parser-loader.ts` so the gate validates against exactly the grammar the
 * runtime uses.
 */
import Parser from 'tree-sitter';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import {
  getLanguageGrammar,
  isLanguageAvailable,
  resolveLanguageKey,
} from '../../src/core/tree-sitter/parser-loader.js';
import {
  VENDORED_GRAMMAR_PACKAGES,
  vendoredGrammarDir,
} from '../../src/core/tree-sitter/vendored-grammars.js';

const _require = createRequire(import.meta.url);

/**
 * Per-language grammar package + the `node-types.json` subpath(s) to union.
 * COBOL is intentionally absent (regex preprocessor, no grammar). Vue has no
 * grammar of its own and reuses tree-sitter-typescript, so its literals are
 * validated against the typescript ∪ tsx node set (JSX/TSX-only nodes
 * included). The package names mirror `parser-loader.ts` `SOURCES`.
 */
const GRAMMAR_PACKAGES: Partial<Record<SupportedLanguages, { pkg: string; subpaths: string[] }>> = {
  [SupportedLanguages.JavaScript]: {
    pkg: 'tree-sitter-javascript',
    subpaths: ['src/node-types.json'],
  },
  [SupportedLanguages.TypeScript]: {
    pkg: 'tree-sitter-typescript',
    subpaths: ['typescript/src/node-types.json', 'tsx/src/node-types.json'],
  },
  [SupportedLanguages.Python]: { pkg: 'tree-sitter-python', subpaths: ['src/node-types.json'] },
  [SupportedLanguages.Java]: { pkg: 'tree-sitter-java', subpaths: ['src/node-types.json'] },
  [SupportedLanguages.C]: { pkg: 'tree-sitter-c', subpaths: ['src/node-types.json'] },
  [SupportedLanguages.CPlusPlus]: { pkg: 'tree-sitter-cpp', subpaths: ['src/node-types.json'] },
  [SupportedLanguages.CSharp]: { pkg: 'tree-sitter-c-sharp', subpaths: ['src/node-types.json'] },
  [SupportedLanguages.Go]: { pkg: 'tree-sitter-go', subpaths: ['src/node-types.json'] },
  [SupportedLanguages.Ruby]: { pkg: 'tree-sitter-ruby', subpaths: ['src/node-types.json'] },
  [SupportedLanguages.Rust]: { pkg: 'tree-sitter-rust', subpaths: ['src/node-types.json'] },
  // tree-sitter-php's runtime export is `php_only` (see parser-loader), so the
  // gate must validate against that variant's node set, not the embedded-HTML
  // `php` grammar.
  [SupportedLanguages.PHP]: { pkg: 'tree-sitter-php', subpaths: ['php_only/src/node-types.json'] },
  [SupportedLanguages.Kotlin]: { pkg: 'tree-sitter-kotlin', subpaths: ['src/node-types.json'] },
  [SupportedLanguages.Swift]: { pkg: 'tree-sitter-swift', subpaths: ['src/node-types.json'] },
  [SupportedLanguages.Dart]: { pkg: 'tree-sitter-dart', subpaths: ['src/node-types.json'] },
  [SupportedLanguages.Vue]: {
    pkg: 'tree-sitter-typescript',
    subpaths: ['typescript/src/node-types.json', 'tsx/src/node-types.json'],
  },
};

/** Languages the gate validates (everything with a grammar package). */
export const GATED_LANGUAGES: readonly SupportedLanguages[] = Object.keys(
  GRAMMAR_PACKAGES,
) as SupportedLanguages[];

export interface GrammarModel {
  language: SupportedLanguages;
  /** Every node-type string the grammar can surface (named + anonymous + supertypes). */
  nodeTypes: ReadonlySet<string>;
  /** Valid field names per node type. */
  fieldsByNode: ReadonlyMap<string, ReadonlySet<string>>;
  /** Union of every field name across all node types (sound global existence check). */
  allFields: ReadonlySet<string>;
}

// ---- node-types.json shape (only the parts we read) ----
interface ChildType {
  type: string;
  named: boolean;
}
interface FieldInfo {
  types?: ChildType[];
}
interface NodeTypeEntry {
  type: string;
  named?: boolean;
  fields?: Record<string, FieldInfo>;
  children?: { types?: ChildType[] };
  subtypes?: ChildType[];
}

/** Resolve the on-disk directory of an installed package, or null if absent. */
function resolvePackageDir(pkg: string): string | null {
  // Vendored grammars (c/dart/proto/swift/kotlin) are NOT in node_modules — they
  // load from vendor/ by absolute path (vendored-grammars.ts / #2111), so resolve
  // their node-types.json from there rather than via _require.resolve.
  if (VENDORED_GRAMMAR_PACKAGES.has(pkg)) {
    const dir = vendoredGrammarDir(pkg);
    return existsSync(dir) ? dir : null;
  }
  try {
    return dirname(_require.resolve(`${pkg}/package.json`));
  } catch {
    /* package.json may be blocked by an `exports` map — fall back to main */
  }
  try {
    let dir = dirname(_require.resolve(pkg));
    for (let i = 0; i < 10; i++) {
      if (existsSync(join(dir, 'package.json'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* not installed (optional grammar) */
  }
  return null;
}

function addChildTypes(into: Set<string>, types: ChildType[] | undefined): void {
  if (!types) return;
  for (const t of types) into.add(t.type);
}

/**
 * Build the membership model for one language by unioning its node-types.json
 * file(s). Returns null when no node-types.json can be resolved (e.g. an
 * optional grammar is not installed) so callers can skip rather than fail.
 */
export function loadGrammarModel(language: SupportedLanguages): GrammarModel | null {
  const entry = GRAMMAR_PACKAGES[language];
  if (!entry) return null;
  const dir = resolvePackageDir(entry.pkg);
  if (!dir) return null;

  const nodeTypes = new Set<string>();
  const fieldsByNode = new Map<string, Set<string>>();
  const allFields = new Set<string>();
  let read = 0;

  for (const subpath of entry.subpaths) {
    const file = join(dir, subpath);
    if (!existsSync(file)) continue;
    let parsed: NodeTypeEntry[];
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as NodeTypeEntry[];
    } catch {
      continue;
    }
    read += 1;
    for (const node of parsed) {
      if (typeof node.type === 'string') nodeTypes.add(node.type);
      addChildTypes(nodeTypes, node.subtypes);
      addChildTypes(nodeTypes, node.children?.types);
      if (node.fields) {
        const fieldSet = fieldsByNode.get(node.type) ?? new Set<string>();
        for (const [fieldName, info] of Object.entries(node.fields)) {
          fieldSet.add(fieldName);
          allFields.add(fieldName);
          addChildTypes(nodeTypes, info.types);
        }
        fieldsByNode.set(node.type, fieldSet);
      }
    }
  }

  if (read === 0) return null;
  return { language, nodeTypes, fieldsByNode, allFields };
}

/** True when the thrown object is tree-sitter's "invalid node type" query error. */
export function isNodeTypeError(err: unknown): boolean {
  return err instanceof Error && /TSQueryErrorNodeType/.test(err.message);
}

/**
 * True when the thrown object is tree-sitter's "field invalid for this node"
 * query error. `TSQueryErrorStructure` is thrown when a field exists on other
 * nodes but not on the queried one (the common dead-field case, e.g.
 * `(parameter pattern: (_))`); `TSQueryErrorField` is thrown for a field name
 * unknown to the grammar entirely. Both mean the field is dead on that node.
 * `TSQueryErrorNodeType` is deliberately NOT a field error — it means the node
 * type is absent in this grammar, which `probeField` reports as `unavailable`
 * (abstain), never `dead`.
 */
export function isFieldError(err: unknown): boolean {
  return err instanceof Error && /TSQueryError(Structure|Field)/.test(err.message);
}

/** Escape a string so it is safe inside a `"..."` anonymous-node query literal. */
function escapeAnonymous(literal: string): string {
  return literal.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** The live grammar object(s) a language's literals should be probed against. */
function grammarsFor(language: SupportedLanguages): unknown[] {
  if (!isLanguageAvailable(language)) return [];
  const grammars: unknown[] = [getLanguageGrammar(language)];
  // TypeScript and Vue (which reuses the TS grammar) also have a tsx grammar
  // with JSX-only node types; probe both.
  if (language === SupportedLanguages.TypeScript || language === SupportedLanguages.Vue) {
    try {
      // resolveLanguageKey only switches TypeScript -> tsx on a .tsx path.
      const tsx = getLanguageGrammar(SupportedLanguages.TypeScript, 'x.tsx');
      if (resolveLanguageKey(SupportedLanguages.TypeScript, 'x.tsx').endsWith(':tsx')) {
        grammars.push(tsx);
      }
    } catch {
      /* tsx unavailable — base grammar still probed */
    }
  }
  return grammars;
}

/**
 * Authoritative fallback: ask the live grammar whether `literal` can be a node
 * type. A literal is `valid` if it compiles in ANY of the named `(x)`,
 * anonymous `"x"`, or supertype `(_x)` forms against ANY of the language's
 * grammars; `dead` only if every form is rejected; `unavailable` if no grammar
 * loads (so the caller skips rather than fails). See KTD1.
 */
export function probeNodeType(
  language: SupportedLanguages,
  literal: string,
): 'valid' | 'dead' | 'unavailable' {
  const grammars = grammarsFor(language);
  if (grammars.length === 0) return 'unavailable';

  const forms = [`(${literal}) @_`, `"${escapeAnonymous(literal)}" @_`, `(_${literal}) @_`];
  for (const grammar of grammars) {
    for (const form of forms) {
      try {
        // Constructing the Query is the validation: it throws
        // TSQueryErrorNodeType iff the node type cannot exist.
        new Parser.Query(grammar as ConstructorParameters<typeof Parser.Query>[0], form);
        return 'valid';
      } catch {
        /* this (form, grammar) rejected — try the next */
      }
    }
  }
  return 'dead';
}

/**
 * Field-existence oracle — the node-scoped analogue of `probeNodeType`. Compiles
 * a field-bearing probe query `(<nodeType> <field>: (_)) @_` against the live
 * grammar(s) for `language`:
 *   - compiles on ANY grammar → `valid`
 *   - rejected as a field/structure error on a grammar that HAS the node, and
 *     never accepted → `dead`
 *   - the node type is absent in every probed grammar (only `TSQueryErrorNodeType`),
 *     or no grammar loads → `unavailable` (abstain — never `dead`, so multi-language
 *     valid-if-any can defer to the grammar that actually emits the node)
 *
 * Conservative-toward-valid: supertype-typed fields make some structurally-wrong
 * field queries compile, so the probe can return `valid` for a semantically wrong
 * field. That is the sound direction — false negatives only, never a false
 * positive that would block CI on correct code.
 */
export function probeField(
  language: SupportedLanguages,
  nodeType: string,
  field: string,
): 'valid' | 'dead' | 'unavailable' {
  const grammars = grammarsFor(language);
  if (grammars.length === 0) return 'unavailable';

  const form = `(${nodeType} ${field}: (_)) @_`;
  let sawFieldDead = false;
  for (const grammar of grammars) {
    try {
      new Parser.Query(grammar as ConstructorParameters<typeof Parser.Query>[0], form);
      return 'valid';
    } catch (err) {
      if (isFieldError(err)) sawFieldDead = true;
      // TSQueryErrorNodeType (node absent here) or any other error → abstain
    }
  }
  return sawFieldDead ? 'dead' : 'unavailable';
}

/**
 * Combined check used by the gate: fast membership first, authoritative live
 * probe only for literals the static JSON does not list. Returns `valid`,
 * `dead`, or `unavailable`.
 */
export function validateNodeType(
  language: SupportedLanguages,
  model: GrammarModel | null,
  literal: string,
): 'valid' | 'dead' | 'unavailable' {
  if (model && model.nodeTypes.has(literal)) return 'valid';
  return probeNodeType(language, literal);
}

/**
 * Field-name validation. Node-scoped when `receiverNodeType` is given:
 * membership hit is authoritative, and a miss falls through to the live
 * `probeField` rather than declaring `dead` — node-types.json is not a sound
 * negative oracle for fields (it can under-report). Without a receiver it is a
 * sound global existence check. Returns `unavailable` when the model could not
 * be loaded. See KTD1.
 */
export function validateField(
  model: GrammarModel | null,
  field: string,
  receiverNodeType?: string,
): 'valid' | 'dead' | 'unavailable' {
  if (!model) return 'unavailable';
  if (receiverNodeType) {
    const scoped = model.fieldsByNode.get(receiverNodeType);
    if (scoped && scoped.has(field)) return 'valid';
    return probeField(model.language, receiverNodeType, field);
  }
  return model.allFields.has(field) ? 'valid' : 'dead';
}
