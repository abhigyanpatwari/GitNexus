/**
 * PL/SQL `ScopeResolver` registered in `SCOPE_RESOLVERS`.
 *
 * Structural CONTAINS / CALLS / ACCESSES / IMPORTS edges are owned by
 * `plsql-processor.ts` (`callable-flow-only` edge mode, COBOL precedent).
 * This resolver contributes the declaration model and, when a consumer such
 * as rename asks for it, the exact source binding of every written name —
 * decided by the same `PlSqlNameIndex` the processor uses for CALLS.
 *
 * Reference: `languages/cobol/scope-resolver.ts`.
 */

import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { plsqlProvider } from '../plsql.js';
import {
  PlSqlNameIndex,
  PlSqlPackageInstances,
  inWrittenSchema,
  nearestGroups,
  rootPackageOf,
  type PlSqlIndexEntry,
} from '../../plsql/resolve.js';
import { resolvePlSqlScriptInclude } from '../../plsql/script-include.js';
import type { PlSqlCallSite, PlSqlDefinition } from '../../plsql/extract.js';
import { plsqlFactsFor, plsqlNameRange, plsqlRangeKey, plsqlTokenRange } from './captures.js';

interface BoundEntry extends PlSqlIndexEntry {
  readonly symbol: SymbolDefinition;
}

type SiteMeaning =
  | { kind: 'callee'; call: PlSqlCallSite }
  | { kind: 'qualifier'; call: PlSqlCallSite; part: number }
  | { kind: 'end-label'; def: PlSqlDefinition };

const plsqlScopeResolver: ScopeResolver = {
  language: SupportedLanguages.PlSql,
  languageProvider: plsqlProvider,
  importEdgeReason: 'plsql-scope: script-include',

  resolveImportTarget: (targetRaw, fromFile, allFilePaths) =>
    resolvePlSqlScriptInclude(targetRaw, fromFile, allFilePaths),

  mergeBindings: (existing) => [...existing],

  // Defaulted parameters make arity a range, not a single count.
  arityCompatibility: (callsite, def) => {
    if (callsite.arity === undefined || def.parameterCount === undefined) return 'unknown';
    const required = def.requiredParameterCount ?? def.parameterCount;
    return callsite.arity >= required && callsite.arity <= def.parameterCount
      ? 'compatible'
      : 'incompatible';
  },

  scopeResolutionEdgeMode: 'callable-flow-only',

  // Object-type inheritance (UNDER) is not modelled yet.
  buildMro: () => new Map(),

  populateOwners: (_parsed: ParsedFile) => {},

  emitPostResolutionEdges(_graph, parsedFiles, _nodeLookup, _indexes, context) {
    if (!context?.recordSourceBinding) return;
    const record = context.recordSourceBinding;

    const index = new PlSqlNameIndex<BoundEntry>();
    const entries: Array<{ entry: BoundEntry; fileDefs: readonly PlSqlDefinition[] }> = [];
    const symbolOf = new Map<PlSqlDefinition, SymbolDefinition>();
    const files = parsedFiles.map((parsed) => {
      const facts = plsqlFactsFor(context.fileContents.get(parsed.filePath) ?? '', parsed.filePath);
      const byNameRange = new Map(
        parsed.localDefs.filter((d) => d.nameRange).map((d) => [plsqlRangeKey(d.nameRange!), d]),
      );
      for (const def of facts.definitions) {
        const symbol = byNameRange.get(plsqlRangeKey(plsqlNameRange(def)));
        if (!symbol) continue;
        symbolOf.set(def, symbol);
        const entry: BoundEntry = {
          def,
          filePath: parsed.filePath,
          symbol,
          packageSchema:
            def.kind === 'package' ? undefined : rootPackageOf(def, facts.definitions)?.schema,
        };
        entries.push({ entry, fileDefs: facts.definitions });
        index.add(entry);
      }
      return { parsed, facts };
    });

    // Same package instances as the processor, so a declaration and its body
    // are weighed as one entity (see `PlSqlNameIndex.resolve`).
    const instances = new PlSqlPackageInstances(
      entries
        .filter(({ entry }) => entry.def.kind === 'package')
        .map(({ entry }) => ({
          name: entry.def.name,
          schema: entry.def.schema,
          filePath: entry.filePath,
          isSpec: entry.def.isSpec,
        })),
    );
    for (const { entry, fileDefs } of entries) {
      const pkg = rootPackageOf(entry.def, fileDefs);
      if (pkg) entry.instance = instances.instanceOf(pkg.name, pkg.schema, entry.filePath);
    }

    // A package name denotes the package instance nearest the reference (as
    // near as its nearest spec or body file); its spec when indexed.
    const packageSymbols = new Map<
      string,
      Array<{
        filePath: string;
        symbol: SymbolDefinition;
        isSpec: boolean;
        schema?: string;
        instance: string;
      }>
    >();
    for (const [def, symbol] of symbolOf) {
      if (def.kind !== 'package') continue;
      const list = packageSymbols.get(def.name) ?? [];
      list.push({
        filePath: symbol.filePath,
        symbol,
        isSpec: def.isSpec,
        schema: def.schema,
        instance: instances.instanceOf(def.name, def.schema, symbol.filePath),
      });
      packageSymbols.set(def.name, list);
    }
    /** In `S.A.N` the written schema `S` narrows same-named packages first. */
    const packageSymbol = (
      name: string,
      fromFile: string,
      schema: string | undefined,
    ): SymbolDefinition | undefined => {
      const all = packageSymbols.get(name) ?? [];
      const nearest = nearestGroups(
        inWrittenSchema(all, schema, (p) => p.schema),
        fromFile,
        (p) => p.instance,
      );
      return (nearest.find((p) => p.isSpec) ?? nearest[0])?.symbol;
    };

    for (const { parsed, facts } of files) {
      const meaning = new Map<string, SiteMeaning>();
      for (const call of facts.calls) {
        call.nameTokens.forEach((token, part) => {
          meaning.set(
            plsqlRangeKey(plsqlTokenRange(token)),
            part === call.nameTokens.length - 1
              ? { kind: 'callee', call }
              : { kind: 'qualifier', call, part },
          );
        });
      }
      for (const def of facts.definitions) {
        for (const label of def.endLabels)
          meaning.set(plsqlRangeKey(plsqlTokenRange(label)), { kind: 'end-label', def });
      }

      for (const site of parsed.referenceSites) {
        const m = site.nameRange && meaning.get(plsqlRangeKey(site.nameRange));
        if (!m) continue;
        if (m.kind === 'end-label') {
          const symbol = symbolOf.get(m.def);
          record(
            site,
            symbol
              ? { status: 'resolved', targetDefIds: [symbol.nodeId], basis: 'plsql-end-label' }
              : { status: 'unresolved', targetDefIds: [], basis: 'plsql-end-label' },
          );
          continue;
        }
        if (m.kind === 'qualifier') {
          // In `S.A.N` only `A` (the part before the callee) can name a package.
          const symbol =
            m.part === m.call.nameParts.length - 2
              ? packageSymbol(
                  m.call.nameParts[m.part]!,
                  parsed.filePath,
                  m.part > 0 ? m.call.nameParts[m.part - 1] : undefined,
                )
              : undefined;
          record(
            site,
            symbol
              ? {
                  status: 'resolved',
                  targetDefIds: [symbol.nodeId],
                  basis: 'plsql-package-qualifier',
                }
              : { status: 'unresolved', targetDefIds: [], basis: 'plsql-qualifier' },
          );
          continue;
        }
        const targets = m.call.dbLink ? [] : index.resolve(m.call, parsed.filePath);
        const ids = targets.map((t) => t.symbol.nodeId);
        record(
          site,
          ids.length === 1
            ? { status: 'resolved', targetDefIds: ids, basis: 'plsql-call' }
            : ids.length > 1
              ? {
                  status: 'ambiguous',
                  targetDefIds: ids,
                  candidatesComplete: true,
                  basis: 'plsql-overload',
                }
              : { status: 'unresolved', targetDefIds: [], basis: 'plsql-call' },
        );
      }
    }
  },

  isSuperReceiver: () => false,

  fieldFallbackOnMethodLookup: false,
  propagatesReturnTypesAcrossImports: false,
};

export { plsqlScopeResolver };
