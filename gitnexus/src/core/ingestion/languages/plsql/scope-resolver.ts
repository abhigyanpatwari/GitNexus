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

    // The symbol a package instance is known by: its spec when indexed.
    const packageOfInstance = new Map<string, { symbol: SymbolDefinition; isSpec: boolean }>();
    for (const [def, symbol] of symbolOf) {
      if (def.kind !== 'package') continue;
      const instance = instances.instanceOf(def.name, def.schema, symbol.filePath);
      const known = packageOfInstance.get(instance);
      if (!known || (def.isSpec && !known.isSpec))
        packageOfInstance.set(instance, { symbol, isSpec: def.isSpec });
    }

    const resolved = new Map<PlSqlCallSite, BoundEntry[]>();
    const resolveCall = (call: PlSqlCallSite, fromFile: string): BoundEntry[] => {
      let targets = resolved.get(call);
      if (!targets) {
        targets = call.dbLink ? [] : index.resolve(call, fromFile);
        resolved.set(call, targets);
      }
      return targets;
    };
    /**
     * The package a qualifier names, read off the resolved callee: `A` in
     * `A.N` / `S.A.N` denotes a package only when `N` resolves to members of
     * exactly one instance of package `A`. A schema (`S.N` reaching a
     * standalone subprogram), a database link, an unresolved callee or members
     * of several instances leave the qualifier unproven.
     */
    const qualifierPackage = (
      call: PlSqlCallSite,
      qualifier: string,
      fromFile: string,
    ): SymbolDefinition | undefined => {
      const owners = new Set<string | undefined>(
        resolveCall(call, fromFile).map((t) =>
          t.def.ownerPath.length === 1 && t.def.ownerPath[0] === qualifier ? t.instance : undefined,
        ),
      );
      if (owners.size !== 1) return undefined;
      const [instance] = owners;
      return instance === undefined ? undefined : packageOfInstance.get(instance)?.symbol;
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
              ? qualifierPackage(m.call, m.call.nameParts[m.part]!, parsed.filePath)
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
        const ids = resolveCall(m.call, parsed.filePath).map((t) => t.symbol.nodeId);
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
