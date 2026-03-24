import type { SymbolTable, SymbolDefinition } from './symbol-table.js';
import type { NamedImportMap } from './import-processor.js';
import type { NamedBinding } from './import-resolution.js';
import type { SyntaxNode } from './utils.js';
import { findChild } from './resolvers/utils.js';

/**
 * Walk a named-binding re-export chain through NamedImportMap.
 *
 * When file A imports { User } from B, and B re-exports { User } from C,
 * the NamedImportMap for A points to B, but B has no User definition.
 * This function follows the chain: A→B→C until a definition is found.
 *
 * Returns the definitions found at the end of the chain, or null if the
 * chain breaks (missing binding, circular reference, or depth exceeded).
 * Max depth 5 to prevent infinite loops.
 *
 * @param allDefs Pre-computed `symbolTable.lookupFuzzy(name)` result — must be the
 *               complete unfiltered result. Passing a file-filtered subset will cause
 *               silent misses at depth=0 for non-aliased bindings.
 */
export function walkBindingChain(
  name: string,
  currentFilePath: string,
  symbolTable: SymbolTable,
  namedImportMap: NamedImportMap,
  allDefs: SymbolDefinition[],
): SymbolDefinition[] | null {
  let lookupFile = currentFilePath;
  let lookupName = name;
  const visited = new Set<string>();

  for (let depth = 0; depth < 5; depth++) {
    const bindings = namedImportMap.get(lookupFile);
    if (!bindings) return null;

    const binding = bindings.get(lookupName);
    if (!binding) return null;

    const key = `${binding.sourcePath}:${binding.exportedName}`;
    if (visited.has(key)) return null; // circular
    visited.add(key);

    const targetName = binding.exportedName;
    const resolvedDefs = targetName !== lookupName || depth > 0
      ? symbolTable.lookupFuzzy(targetName).filter(def => def.filePath === binding.sourcePath)
      : allDefs.filter(def => def.filePath === binding.sourcePath);

    if (resolvedDefs.length > 0) return resolvedDefs;

    // No definition in source file → follow re-export chain
    lookupFile = binding.sourcePath;
    lookupName = targetName;
  }

  return null;
}

export function extractTsNamedBindings(importNode: SyntaxNode): NamedBinding[] | undefined {
  // import_statement > import_clause > named_imports > import_specifier*
  const importClause = findChild(importNode, 'import_clause');
  if (importClause) {
    const namedImports = findChild(importClause, 'named_imports');
    if (!namedImports) return undefined; // default import, namespace import, or side-effect

    const bindings: NamedBinding[] = [];
    for (let i = 0; i < namedImports.namedChildCount; i++) {
      const specifier = namedImports.namedChild(i);
      if (specifier?.type !== 'import_specifier') continue;

      const identifiers: string[] = [];
      for (let j = 0; j < specifier.namedChildCount; j++) {
        const child = specifier.namedChild(j);
        if (child?.type === 'identifier') identifiers.push(child.text);
      }

      if (identifiers.length === 1) {
        bindings.push({ local: identifiers[0], exported: identifiers[0] });
      } else if (identifiers.length === 2) {
        // import { Foo as Bar } → exported='Foo', local='Bar'
        bindings.push({ local: identifiers[1], exported: identifiers[0] });
      }
    }
    return bindings.length > 0 ? bindings : undefined;
  }

  // Re-export: export { X } from './y' → export_statement > export_clause > export_specifier
  const exportClause = findChild(importNode, 'export_clause');
  if (exportClause) {
    const bindings: NamedBinding[] = [];
    for (let i = 0; i < exportClause.namedChildCount; i++) {
      const specifier = exportClause.namedChild(i);
      if (specifier?.type !== 'export_specifier') continue;

      const identifiers: string[] = [];
      for (let j = 0; j < specifier.namedChildCount; j++) {
        const child = specifier.namedChild(j);
        if (child?.type === 'identifier') identifiers.push(child.text);
      }

      if (identifiers.length === 1) {
        // export { User } from './base' → re-exports User as User
        bindings.push({ local: identifiers[0], exported: identifiers[0] });
      } else if (identifiers.length === 2) {
        // export { Repo as Repository } from './models' → name=Repo, alias=Repository
        // For re-exports, the first id is the source name, second is what's exported
        // When another file imports { Repository }, they get Repo from the source
        bindings.push({ local: identifiers[1], exported: identifiers[0] });
      }
    }
    return bindings.length > 0 ? bindings : undefined;
  }

  return undefined;
}

export function extractPythonNamedBindings(importNode: SyntaxNode): NamedBinding[] | undefined {
  // Handle: from x import User, Repo as R
  if (importNode.type === 'import_from_statement') {
    const bindings: NamedBinding[] = [];
    for (let i = 0; i < importNode.namedChildCount; i++) {
      const child = importNode.namedChild(i);
      if (!child) continue;

      if (child.type === 'dotted_name') {
        // Skip the module_name (first dotted_name is the source module)
        const fieldName = importNode.childForFieldName?.('module_name');
        if (fieldName && child.startIndex === fieldName.startIndex) continue;

        // This is an imported name: from x import User
        const name = child.text;
        if (name) bindings.push({ local: name, exported: name });
      }

      if (child.type === 'aliased_import') {
        // from x import Repo as R
        const dottedName = findChild(child, 'dotted_name');
        const aliasIdent = findChild(child, 'identifier');
        if (dottedName && aliasIdent) {
          bindings.push({ local: aliasIdent.text, exported: dottedName.text });
        }
      }
    }

    return bindings.length > 0 ? bindings : undefined;
  }

  // Handle: import numpy as np  (import_statement with aliased_import child)
  // Tagged with isModuleAlias so applyImportResult routes these directly to
  // moduleAliasMap (e.g. "np" → "numpy.py") instead of namedImportMap.
  if (importNode.type === 'import_statement') {
    const bindings: NamedBinding[] = [];
    for (let i = 0; i < importNode.namedChildCount; i++) {
      const child = importNode.namedChild(i);
      if (!child || child.type !== 'aliased_import') continue;

      const dottedName = findChild(child, 'dotted_name');
      const aliasIdent = findChild(child, 'identifier');
      if (dottedName && aliasIdent) {
        bindings.push({ local: aliasIdent.text, exported: dottedName.text, isModuleAlias: true });
      }
    }

    return bindings.length > 0 ? bindings : undefined;
  }

  return undefined;
}

export function extractKotlinNamedBindings(importNode: SyntaxNode): NamedBinding[] | undefined {
  // import_header > identifier + import_alias > simple_identifier
  if (importNode.type !== 'import_header') return undefined;

  const fullIdent = findChild(importNode, 'identifier');
  if (!fullIdent) return undefined;

  const fullText = fullIdent.text;
  const exportedName = fullText.includes('.') ? fullText.split('.').pop()! : fullText;

  const importAlias = findChild(importNode, 'import_alias');
  if (importAlias) {
    // Aliased: import com.example.User as U
    const aliasIdent = findChild(importAlias, 'simple_identifier');
    if (!aliasIdent) return undefined;
    return [{ local: aliasIdent.text, exported: exportedName }];
  }

  // Non-aliased: import com.example.User → local="User", exported="User"
  // Also handles top-level function imports: import models.getUser → local="getUser"
  // Skip wildcard imports (ending in *)
  if (fullText.endsWith('.*') || fullText.endsWith('*')) return undefined;
  // Skip class-member imports (e.g., import util.OneArg.writeAudit) where the
  // second-to-last segment is PascalCase (a class name). Multiple member imports
  // with the same function name would collide in NamedImportMap, breaking
  // arity-based disambiguation. Top-level function imports (import models.getUser)
  // and class imports (import models.User) have package-only prefixes.
  const segments = fullText.split('.');
  if (segments.length >= 3) {
    const parentSegment = segments[segments.length - 2];
    if (parentSegment[0] && parentSegment[0] === parentSegment[0].toUpperCase()) return undefined;
  }
  return [{ local: exportedName, exported: exportedName }];
}

export function extractRustNamedBindings(importNode: SyntaxNode): NamedBinding[] | undefined {
  // use_declaration may contain use_as_clause at any depth
  if (importNode.type !== 'use_declaration') return undefined;

  const bindings: NamedBinding[] = [];
  collectRustBindings(importNode, bindings);
  return bindings.length > 0 ? bindings : undefined;
}

function collectRustBindings(node: SyntaxNode, bindings: NamedBinding[]): void {
  if (node.type === 'use_as_clause') {
    // First identifier = exported name, second identifier = local alias
    const idents: string[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'identifier') idents.push(child.text);
      // For scoped_identifier, extract the last segment
      if (child?.type === 'scoped_identifier') {
        const nameNode = child.childForFieldName?.('name');
        if (nameNode) idents.push(nameNode.text);
      }
    }
    if (idents.length === 2) {
      bindings.push({ local: idents[1], exported: idents[0] });
    }
    return;
  }

  // Terminal identifier in a use_list: use crate::models::{User, Repo}
  if (node.type === 'identifier' && node.parent?.type === 'use_list') {
    bindings.push({ local: node.text, exported: node.text });
    return;
  }

  // Skip scoped_identifier that serves as path prefix in scoped_use_list
  // e.g. use crate::models::{User, Repo} — the path node "crate::models" is not an importable symbol
  if (node.type === 'scoped_identifier' && node.parent?.type === 'scoped_use_list') {
    return; // path prefix — the use_list sibling handles the actual symbols
  }

  // Terminal scoped_identifier: use crate::models::User;
  // Only extract if this is a leaf (no deeper use_list/use_as_clause/scoped_use_list)
  if (node.type === 'scoped_identifier') {
    let hasDeeper = false;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'use_list' || child?.type === 'use_as_clause' || child?.type === 'scoped_use_list') {
        hasDeeper = true;
        break;
      }
    }
    if (!hasDeeper) {
      const nameNode = node.childForFieldName?.('name');
      if (nameNode) {
        bindings.push({ local: nameNode.text, exported: nameNode.text });
      }
      return;
    }
  }

  // Recurse into children
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) collectRustBindings(child, bindings);
  }
}

export function extractPhpNamedBindings(importNode: SyntaxNode): NamedBinding[] | undefined {
  // namespace_use_declaration > namespace_use_clause* (flat)
  // namespace_use_declaration > namespace_use_group > namespace_use_clause* (grouped)
  if (importNode.type !== 'namespace_use_declaration') return undefined;

  // Skip 'use function' and 'use const' declarations — these import callables/constants,
  // not class types, and should not be added to namedImportMap as type bindings.
  const useTypeNode = importNode.childForFieldName?.('type');
  if (useTypeNode && (useTypeNode.text === 'function' || useTypeNode.text === 'const')) {
    return undefined;
  }

  const bindings: NamedBinding[] = [];

  // Collect all clauses — from direct children AND from namespace_use_group
  const clauses: SyntaxNode[] = [];
  for (let i = 0; i < importNode.namedChildCount; i++) {
    const child = importNode.namedChild(i);
    if (child?.type === 'namespace_use_clause') {
      clauses.push(child);
    } else if (child?.type === 'namespace_use_group') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const groupChild = child.namedChild(j);
        if (groupChild?.type === 'namespace_use_clause') clauses.push(groupChild);
      }
    }
  }

  for (const clause of clauses) {
    // Flat imports: qualified_name + name (alias)
    let qualifiedName: SyntaxNode | null = null;
    const names: SyntaxNode[] = [];
    for (let j = 0; j < clause.namedChildCount; j++) {
      const child = clause.namedChild(j);
      if (child?.type === 'qualified_name') qualifiedName = child;
      else if (child?.type === 'name') names.push(child);
    }

    if (qualifiedName && names.length > 0) {
      // Flat aliased import: use App\Models\Repo as R;
      const fullText = qualifiedName.text;
      const exportedName = fullText.includes('\\') ? fullText.split('\\').pop()! : fullText;
      bindings.push({ local: names[0].text, exported: exportedName });
    } else if (qualifiedName && names.length === 0) {
      // Flat non-aliased import: use App\Models\User;
      const fullText = qualifiedName.text;
      const lastSegment = fullText.includes('\\') ? fullText.split('\\').pop()! : fullText;
      bindings.push({ local: lastSegment, exported: lastSegment });
    } else if (!qualifiedName && names.length >= 2) {
      // Grouped aliased import: {Repo as R} — first name = exported, second = alias
      bindings.push({ local: names[1].text, exported: names[0].text });
    } else if (!qualifiedName && names.length === 1) {
      // Grouped non-aliased import: {User} in use App\Models\{User, Repo as R}
      bindings.push({ local: names[0].text, exported: names[0].text });
    }
  }
  return bindings.length > 0 ? bindings : undefined;
}

export function extractCsharpNamedBindings(importNode: SyntaxNode): NamedBinding[] | undefined {
  // using_directive — three forms:
  //   using Alias = NS.Type;          → aliasIdent + qualifiedName
  //   using static NS.Type;           → static + qualifiedName (no alias)
  //   using NS;                       → qualifiedName only (namespace, not capturable)
  if (importNode.type !== 'using_directive') return undefined;

  let aliasIdent: SyntaxNode | null = null;
  let qualifiedName: SyntaxNode | null = null;
  let isStatic = false;
  for (let i = 0; i < importNode.childCount; i++) {
    const child = importNode.child(i);
    if (child?.text === 'static') isStatic = true;
  }
  for (let i = 0; i < importNode.namedChildCount; i++) {
    const child = importNode.namedChild(i);
    if (child?.type === 'identifier' && !aliasIdent) aliasIdent = child;
    else if (child?.type === 'qualified_name') qualifiedName = child;
  }

  // Form 1: using Alias = NS.Type;
  if (aliasIdent && qualifiedName) {
    const fullText = qualifiedName.text;
    const exportedName = fullText.includes('.') ? fullText.split('.').pop()! : fullText;
    return [{ local: aliasIdent.text, exported: exportedName }];
  }

  // Form 2: using static NS.Type; — last segment is the class name
  if (isStatic && qualifiedName) {
    const fullText = qualifiedName.text;
    const lastSegment = fullText.includes('.') ? fullText.split('.').pop()! : fullText;
    return [{ local: lastSegment, exported: lastSegment }];
  }

  // Form 3: using NS; — namespace import, can't resolve to per-symbol bindings
  return undefined;
}

export function extractJavaNamedBindings(importNode: SyntaxNode): NamedBinding[] | undefined {
  // import_declaration > scoped_identifier "com.example.models.User"
  // Wildcard imports (.*) don't produce named bindings
  if (importNode.type !== 'import_declaration') return undefined;

  // Check for asterisk (wildcard import) and static modifier
  let isStatic = false;
  for (let i = 0; i < importNode.childCount; i++) {
    const child = importNode.child(i);
    if (child?.type === 'asterisk') return undefined;
    if (child?.text === 'static') isStatic = true;
  }

  const scopedId = findChild(importNode, 'scoped_identifier');
  if (!scopedId) return undefined;

  const fullText = scopedId.text;
  const lastDot = fullText.lastIndexOf('.');
  if (lastDot === -1) return undefined;

  const name = fullText.slice(lastDot + 1);
  // Non-static: skip lowercase names — those are package imports, not class imports.
  // Static: allow lowercase — `import static models.UserFactory.getUser` imports a method.
  if (!isStatic && name[0] && name[0] === name[0].toLowerCase()) return undefined;

  return [{ local: name, exported: name }];
}

