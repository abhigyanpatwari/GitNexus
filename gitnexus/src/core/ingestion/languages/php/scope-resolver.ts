import { SupportedLanguages, type ParsedFile } from 'gitnexus-shared';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import { phpProvider } from '../php.js';

export const phpScopeResolver: ScopeResolver = {
  language: SupportedLanguages.PHP,
  languageProvider: phpProvider,
  importEdgeReason: 'php-scope: import',

  resolveImportTarget: (targetRaw, fromFile, allFilePaths) => {
    // Basic PSR-4 PSR-0 heuristic for finding the file target
    // "App\Models\User" -> "App/Models/User.php" or "app/models/User.php"
    const asPath = targetRaw.replace(/\\/g, '/');
    const exact = asPath + '.php';
    const lower = asPath.toLowerCase() + '.php';
    
    for (const path of allFilePaths) {
      if (path.endsWith(exact) || path.endsWith(lower)) {
        return path;
      }
    }
    return null;
  },

  mergeBindings: (existing, incoming) => [...existing, ...incoming],
  arityCompatibility: (callsite, def) => {
    const min = def.requiredParameterCount;
    if (min === undefined) return 'unknown';
    
    const argCount = callsite.arity;
    if (!Number.isFinite(argCount) || argCount < 0) return 'unknown';

    if (argCount < min) return 'incompatible';
    return 'compatible';
  },


  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  isSuperReceiver: (text) => text === 'parent',

  fieldFallbackOnMethodLookup: true,
  propagatesReturnTypesAcrossImports: true,
};
