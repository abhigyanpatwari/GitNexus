import { SupportedLanguages } from '../../config/supported-languages.js';

/**
 * Extract named bindings from an import AST node.
 * Returns undefined if the import is not a named import (e.g., import * or default).
 *
 * TS: import { User, Repo as R } from './models'
 *   → [{local:'User', exported:'User'}, {local:'R', exported:'Repo'}]
 *
 * Python: from models import User, Repo as R
 *   → [{local:'User', exported:'User'}, {local:'R', exported:'Repo'}]
 */
export function extractNamedBindings(
  importNode: any,
  language: SupportedLanguages,
): { local: string; exported: string }[] | undefined {
  if (language === SupportedLanguages.TypeScript || language === SupportedLanguages.JavaScript) {
    return extractTsNamedBindings(importNode);
  }
  if (language === SupportedLanguages.Python) {
    return extractPythonNamedBindings(importNode);
  }
  if (language === SupportedLanguages.Kotlin) {
    return extractKotlinNamedBindings(importNode);
  }
  if (language === SupportedLanguages.Rust) {
    return extractRustNamedBindings(importNode);
  }
  if (language === SupportedLanguages.PHP) {
    return extractPhpNamedBindings(importNode);
  }
  if (language === SupportedLanguages.CSharp) {
    return extractCsharpNamedBindings(importNode);
  }
  if (language === SupportedLanguages.Java) {
    return extractJavaNamedBindings(importNode);
  }
  return undefined;
}

export function extractTsNamedBindings(importNode: any): { local: string; exported: string }[] | undefined {
  // import_statement > import_clause > named_imports > import_specifier*
  const importClause = findChild(importNode, 'import_clause');
  if (importClause) {
    const namedImports = findChild(importClause, 'named_imports');
    if (!namedImports) return undefined; // default import, namespace import, or side-effect

    const bindings: { local: string; exported: string }[] = [];
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
    const bindings: { local: string; exported: string }[] = [];
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

export function extractPythonNamedBindings(importNode: any): { local: string; exported: string }[] | undefined {
  // Only from import_from_statement, not plain import_statement
  if (importNode.type !== 'import_from_statement') return undefined;

  const bindings: { local: string; exported: string }[] = [];
  for (let i = 0; i < importNode.namedChildCount; i++) {
    const child = importNode.namedChild(i);
    if (!child) continue;

    if (child.type === 'dotted_name') {
      // Skip the module_name (first dotted_name is the source module)
      const fieldName = importNode.childForFieldName?.('module_name');
      if (fieldName && child.id === fieldName.id) continue;

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

export function extractKotlinNamedBindings(importNode: any): { local: string; exported: string }[] | undefined {
  // import_header > identifier + import_alias > simple_identifier
  if (importNode.type !== 'import_header') return undefined;

  const importAlias = findChild(importNode, 'import_alias');
  if (!importAlias) return undefined; // no alias → plain import, skip

  const aliasIdent = findChild(importAlias, 'simple_identifier');
  if (!aliasIdent) return undefined;

  // The imported name is the full identifier; extract the last segment
  const fullIdent = findChild(importNode, 'identifier');
  if (!fullIdent) return undefined;

  const fullText = fullIdent.text;
  const exportedName = fullText.includes('.') ? fullText.split('.').pop()! : fullText;

  return [{ local: aliasIdent.text, exported: exportedName }];
}

export function extractRustNamedBindings(importNode: any): { local: string; exported: string }[] | undefined {
  // use_declaration may contain use_as_clause at any depth
  if (importNode.type !== 'use_declaration') return undefined;

  const bindings: { local: string; exported: string }[] = [];
  collectUseAsClauses(importNode, bindings);
  return bindings.length > 0 ? bindings : undefined;
}

function collectUseAsClauses(node: any, bindings: { local: string; exported: string }[]): void {
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
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) collectUseAsClauses(child, bindings);
  }
}

export function extractPhpNamedBindings(importNode: any): { local: string; exported: string }[] | undefined {
  // namespace_use_declaration > namespace_use_clause* (flat)
  // namespace_use_declaration > namespace_use_group > namespace_use_clause* (grouped)
  if (importNode.type !== 'namespace_use_declaration') return undefined;

  const bindings: { local: string; exported: string }[] = [];

  // Collect all clauses — from direct children AND from namespace_use_group
  const clauses: any[] = [];
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
    let qualifiedName: any = null;
    const names: any[] = [];
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
    } else if (!qualifiedName && names.length >= 2) {
      // Grouped aliased import: {Repo as R} — first name = exported, second = alias
      bindings.push({ local: names[1].text, exported: names[0].text });
    }
  }
  return bindings.length > 0 ? bindings : undefined;
}

export function extractCsharpNamedBindings(importNode: any): { local: string; exported: string }[] | undefined {
  // using_directive with identifier (alias) + qualified_name (target)
  if (importNode.type !== 'using_directive') return undefined;

  let aliasIdent: any = null;
  let qualifiedName: any = null;
  for (let i = 0; i < importNode.namedChildCount; i++) {
    const child = importNode.namedChild(i);
    if (child?.type === 'identifier' && !aliasIdent) aliasIdent = child;
    else if (child?.type === 'qualified_name') qualifiedName = child;
  }

  if (!aliasIdent || !qualifiedName) return undefined;

  const fullText = qualifiedName.text;
  const exportedName = fullText.includes('.') ? fullText.split('.').pop()! : fullText;

  return [{ local: aliasIdent.text, exported: exportedName }];
}

export function extractJavaNamedBindings(importNode: any): { local: string; exported: string }[] | undefined {
  // import_declaration > scoped_identifier "com.example.models.User"
  // Wildcard imports (.*) don't produce named bindings
  if (importNode.type !== 'import_declaration') return undefined;

  // Check for asterisk (wildcard import) — skip those
  for (let i = 0; i < importNode.childCount; i++) {
    const child = importNode.child(i);
    if (child?.type === 'asterisk') return undefined;
  }

  const scopedId = findChild(importNode, 'scoped_identifier');
  if (!scopedId) return undefined;

  const fullText = scopedId.text;
  const lastDot = fullText.lastIndexOf('.');
  if (lastDot === -1) return undefined;

  const className = fullText.slice(lastDot + 1);
  // Skip lowercase names — those are package imports, not class imports
  if (className[0] && className[0] === className[0].toLowerCase()) return undefined;

  return [{ local: className, exported: className }];
}

function findChild(node: any, type: string): any {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === type) return child;
  }
  return null;
}
