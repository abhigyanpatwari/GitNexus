// gitnexus/src/core/ingestion/workers/go-relationships.ts
/**
 * Go-specific relationship extraction helpers (issue #20 + #26).
 *
 * Issue #20 — Go IMPLEMENTS detection (duck-typed):
 *   Go interfaces are satisfied implicitly. A struct S implements interface I
 *   iff S's method set is a superset of I's method set. S's method set
 *   includes its own pointer/value-receiver methods plus methods promoted
 *   from any embedded interface types.
 *
 *   The tree-sitter query `definition.method` captures method_declaration
 *   nodes uniformly; their owning class is resolved by findEnclosingClassId
 *   (struct via receiver, interface via enclosing interface_type). This pass
 *   reads the in-progress symbol table + walks interface_type bodies to build
 *   per-file method sets and emits IMPLEMENTS heritage items.
 *
 * Issue #26 — Go anonymous field COMPOSITION edge:
 *   When a struct has an anonymous field (`type X struct { Y }` or
 *   `type X struct { *Y }`), we emit a COMPOSITION edge from X to the
 *   embedded type Y. This is structurally distinct from EXTENDS/IMPLEMENTS:
 *   the embedded type's methods are *promoted* to X's method set, not
 *   inherited. Anonymous fields are NOT emitted as Property nodes (the
 *   existing Go queries already enforce this via the `name:` constraint).
 *
 * The COMPOSITION type is added in src/core/graph/types.ts.
 */
import type Parser from 'tree-sitter';
import { generateId } from '../../../lib/utils.js';
import { isVerboseIngestionEnabled } from '../utils/verbose.js';

/**
 * Minimal symbol shape used by the IMPLEMENTS detector. Lighter than
 * SymbolDefinition so both the worker-side ParsedSymbol and the
 * AST-built SymbolDefinition can satisfy it.
 */
export interface MethodSymbol {
  nodeId: string;
  filePath: string;
  type: string;
  ownerId?: string;
}

/** Recursively walk an AST node. */
const walk = (node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void => {
  visit(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) walk(child, visit);
  }
};

/**
 * Collect method names declared directly inside an `interface_type` AST node.
 * Go interface methods are `method_elem` nodes with a `field_identifier` name
 * (no receiver parameter_list, unlike method_declaration).
 */
const collectInterfaceMethodNames = (interfaceTypeNode: Parser.SyntaxNode): Set<string> => {
  const names = new Set<string>();
  walk(interfaceTypeNode, (n) => {
    if (n.type === 'method_elem' || n.type === 'method_declaration') {
      const nameNode = n.childForFieldName('name') ?? n.children.find((c) => c.type === 'field_identifier');
      if (nameNode) names.add(nameNode.text);
    }
  });
  return names;
};

/**
 * Collect method names declared inside an `interface_type` AST node, plus
 * methods of any embedded interfaces in the same file (interfaces use the
 * same anonymous-field embedding mechanism: `type ReadCloser interface { Reader; Closer }`).
 */
const collectInterfaceMethodNamesWithEmbeds = (
  interfaceTypeNode: Parser.SyntaxNode,
  interfaceMethods: ReadonlyMap<string, Set<string>>,
): Set<string> => {
  const names = collectInterfaceMethodNames(interfaceTypeNode);
  // Embedded interface fields inside an interface_type are either
  //   - `type_elem` nodes (e.g. `type ReadCloser interface { Reader; Closer }`),
  //   - or anonymous `field_declaration` nodes (some grammar versions).
  // For each, the leaf type_identifier is the embedded interface name.
  // Add that interface's methods to the set.
  walk(interfaceTypeNode, (n) => {
    if (
      (n.type === 'type_elem' || (n.type === 'field_declaration' && !n.childForFieldName('name')))
    ) {
      const typeNode = n.childForFieldName('type') ?? (n.type === 'type_elem' ? n.firstNamedChild : null);
      if (typeNode) {
        const embeddedName = extractTypeName(typeNode);
        if (embeddedName) {
          const embedded = interfaceMethods.get(embeddedName);
          if (embedded) {
            for (const m of embedded) names.add(m);
          }
        }
      }
    }
  });
  return names;
};

/** Extract a simple type name from a Go type AST node. */
const extractTypeName = (typeNode: Parser.SyntaxNode): string | null => {
  if (typeNode.type === 'type_identifier' || typeNode.type === 'identifier') {
    return typeNode.text;
  }
  if (typeNode.type === 'pointer_type') {
    const inner = typeNode.firstNamedChild;
    if (inner && (inner.type === 'type_identifier' || inner.type === 'identifier')) {
      return inner.text;
    }
  }
  return null;
};

/**
 * Walk the file's type_declarations to build:
 *   - interfaces: Map<interfaceName, Set<methodName>>  (method set of each interface)
 *   - structAnonymousFields: Map<structName, Array<{ fieldType, isInterface, embeddedTypeKind: 'struct' | 'interface' }>>
 *
 * For now we only need the interface method sets for #20; the struct
 * anonymous field scan is reused for #26 to know what fields are
 * embedded.
 */
interface FileTypeInfo {
  interfaces: Map<string, Set<string>>;          // interface name -> method names
  structInterfaceEmbeds: Map<string, Set<string>>; // struct name -> set of embedded interface names
}

const collectFileTypeInfo = (rootNode: Parser.SyntaxNode): FileTypeInfo => {
  const interfaces = new Map<string, Set<string>>();
  const structInterfaceEmbeds = new Map<string, Set<string>>();

  walk(rootNode, (n) => {
    if (n.type !== 'type_declaration') return;
    // type_declaration > type_spec
    let typeSpec: Parser.SyntaxNode | null = null;
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c?.type === 'type_spec') { typeSpec = c; break; }
    }
    if (!typeSpec) return;
    const nameNode = typeSpec.childForFieldName('name');
    const typeNode = typeSpec.childForFieldName('type');
    if (!nameNode || !typeNode) return;
    const name = nameNode.text;

    if (typeNode.type === 'interface_type') {
      // First pass: register this interface with its own methods
      const methods = collectInterfaceMethodNames(typeNode);
      interfaces.set(name, methods);
      return;
    }
    if (typeNode.type === 'struct_type') {
      // Find anonymous interface embeds in this struct
      const embeds = new Set<string>();
      walk(typeNode, (nn) => {
        if (nn.type === 'field_declaration' && !nn.childForFieldName('name')) {
          const tn = nn.childForFieldName('type');
          if (tn) {
            const typeName = extractTypeName(tn);
            if (typeName) embeds.add(typeName);
          }
        }
      });
      if (embeds.size > 0) structInterfaceEmbeds.set(name, embeds);
    }
  });

  // Second pass: enrich interface method sets with methods of embedded interfaces
  for (const [name] of interfaces) {
    // Find this interface's AST node
    let astNode: Parser.SyntaxNode | null = null;
    walk(rootNode, (n) => {
      if (astNode) return;
      if (n.type !== 'type_declaration') return;
      let typeSpec: Parser.SyntaxNode | null = null;
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (c?.type === 'type_spec') { typeSpec = c; break; }
      }
      if (!typeSpec) return;
      const n2 = typeSpec.childForFieldName('name');
      const t2 = typeSpec.childForFieldName('type');
      if (n2?.text === name && t2?.type === 'interface_type') {
        astNode = t2;
      }
    });
    if (astNode) {
      const enriched = collectInterfaceMethodNamesWithEmbeds(astNode, interfaces);
      interfaces.set(name, enriched);
    }
  }

  return { interfaces, structInterfaceEmbeds };
};

/**
 * Compute a struct's effective method set: own methods + methods promoted
 * from any embedded interface types.
 *
 * own methods come from the symbol table (filtered by ownerId).
 */
const computeStructMethodSet = (
  structName: string,
  ownMethods: Set<string>,
  structInterfaceEmbeds: ReadonlyMap<string, Set<string>>,
  interfaceMethods: ReadonlyMap<string, Set<string>>,
): Set<string> => {
  const set = new Set(ownMethods);
  const embeds = structInterfaceEmbeds.get(structName);
  if (!embeds) return set;
  for (const embedName of embeds) {
    const im = interfaceMethods.get(embedName);
    if (im) {
      for (const m of im) set.add(m);
    }
  }
  return set;
};

export interface GoImplementsHeritageItem {
  filePath: string;
  className: string;
  parentName: string;
  kind: 'implements';
}

export interface GoCompositionHeritageItem {
  filePath: string;
  className: string;
  parentName: string;
  kind: 'composition';
}

/**
 * Walk the file's type_declarations to collect anonymous-field COMPOSITION items.
 * For struct X with anonymous field Y, emit {className: X, parentName: Y, kind: 'composition'}.
 * Y may be a struct (promotion) or an interface (interface embedding).
 */
export const collectGoCompositionHeritage = (
  filePath: string,
  rootNode: Parser.SyntaxNode,
): GoCompositionHeritageItem[] => {
  const items: GoCompositionHeritageItem[] = [];
  walk(rootNode, (n) => {
    if (n.type !== 'type_declaration') return;
    let typeSpec: Parser.SyntaxNode | null = null;
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c?.type === 'type_spec') { typeSpec = c; break; }
    }
    if (!typeSpec) return;
    const nameNode = typeSpec.childForFieldName('name');
    const typeNode = typeSpec.childForFieldName('type');
    if (!nameNode || !typeNode) return;
    if (typeNode.type !== 'struct_type') return;
    const structName = nameNode.text;
    // Find anonymous fields inside this struct
    walk(typeNode, (nn) => {
      if (nn.type !== 'field_declaration') return;
      // Anonymous = no `name` field
      if (nn.childForFieldName('name')) return;
      const tn = nn.childForFieldName('type');
      if (!tn) return;
      const typeName = extractTypeName(tn);
      if (typeName) {
        items.push({
          filePath,
          className: structName,
          parentName: typeName,
          kind: 'composition',
        });
      }
    });
  });
  return items;
};

/**
 * Detect Go structs whose method set is a superset of an interface's method set
 * and emit IMPLEMENTS heritage items.
 *
 * Two sources of method-set construction:
 *   1. Own methods — from the symbol table (SymbolDefinition with type=Method and ownerId=Struct)
 *   2. Promoted methods — from interfaces embedded as anonymous struct fields
 *
 * Only same-file structs and interfaces are considered. Cross-file IMPLEMENTS
 * detection is deferred (would require symbol-table-wide scan, not in scope here).
 */
export const collectGoImplementsHeritage = (
  filePath: string,
  rootNode: Parser.SyntaxNode,
  fileSymbols: ReadonlyArray<MethodSymbol>,
): GoImplementsHeritageItem[] => {
  const { interfaces, structInterfaceEmbeds } = collectFileTypeInfo(rootNode);
  if (interfaces.size === 0) return [];

  // Build struct name -> own method set (from file symbols)
  // We need to know the struct's nodeId. The struct nodeId format is:
  //   Struct:filePath:structName
  const structOwnMethods = new Map<string, Set<string>>();  // structName -> methods
  for (const s of fileSymbols) {
    if (s.type !== 'Method') continue;
    if (!s.ownerId) continue;
    if (s.filePath !== filePath) continue;
    // ownerId is Struct:filePath:structName — extract struct name
    const prefix = `Struct:${filePath}:`;
    if (!s.ownerId.startsWith(prefix)) continue;
    const structName = s.ownerId.slice(prefix.length);
    let set = structOwnMethods.get(structName);
    if (!set) { set = new Set(); structOwnMethods.set(structName, set); }
    // Extract method name: strip the known 'Method:filePath:' prefix
    // instead of taking the last colon-delimited segment (which would
    // return the overload suffix ':1' for Method:filePath:name:1).
    const methodPrefix = `Method:${filePath}:`;
    const rawName = s.nodeId.startsWith(methodPrefix)
      ? s.nodeId.slice(methodPrefix.length)
      : s.nodeId;
    // Also strip any trailing ':N' overload suffix.
    const methodName = rawName.split(':')[0] ?? rawName;
    set.add(methodName);
  }

  // For each struct in the file, compute its method set and check against interfaces
  const items: GoImplementsHeritageItem[] = [];
  const allStructNames = new Set<string>();
  // Collect struct names from the type_declarations in this file
  walk(rootNode, (n) => {
    if (n.type !== 'type_declaration') return;
    let typeSpec: Parser.SyntaxNode | null = null;
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c?.type === 'type_spec') { typeSpec = c; break; }
    }
    if (!typeSpec) return;
    const nameNode = typeSpec.childForFieldName('name');
    const typeNode = typeSpec.childForFieldName('type');
    if (nameNode && typeNode?.type === 'struct_type') {
      allStructNames.add(nameNode.text);
    }
  });

  for (const structName of allStructNames) {
    const ownMethods = structOwnMethods.get(structName) ?? new Set<string>();
    const structMethodSet = computeStructMethodSet(structName, ownMethods, structInterfaceEmbeds, interfaces);
    if (structMethodSet.size === 0) continue;

    for (const [ifaceName, ifaceMethods] of interfaces) {
      if (ifaceMethods.size === 0) continue;
      if (ifaceMethods.size > structMethodSet.size) continue;  // can't be a subset
      let isSuperset = true;
      for (const m of ifaceMethods) {
        if (!structMethodSet.has(m)) { isSuperset = false; break; }
      }
      if (isSuperset) {
        items.push({
          filePath,
          className: structName,
          parentName: ifaceName,
          kind: 'implements',
        });
      }
    }
  }

  if (isVerboseIngestionEnabled() && items.length > 0) {
    console.debug(`[go-relationships] ${filePath}: ${items.length} IMPLEMENTS edges derived from method-set analysis`);
  }
  return items;
};

/**
 * Convenience wrapper: collect IMPLEMENTS + COMPOSITION heritage items in
 * one pass. Returns the combined list.
 */
export const collectGoHeritage = (
  filePath: string,
  rootNode: Parser.SyntaxNode,
  fileSymbols: ReadonlyArray<MethodSymbol>,
): Array<GoImplementsHeritageItem | GoCompositionHeritageItem> => {
  const implementsItems = collectGoImplementsHeritage(filePath, rootNode, fileSymbols);
  const compositionItems = collectGoCompositionHeritage(filePath, rootNode);
  return [...implementsItems, ...compositionItems];
};

// Re-export for tests
export { collectFileTypeInfo, extractTypeName, collectInterfaceMethodNames };
// generateId is re-exported so tests can construct expected node IDs.
export { generateId };

/**
 * Walk the AST and collect MethodSymbol entries for the method_elems
 * that live directly inside a Go interface body.
 *
 * WI-H88 / Issue #88: Go interface body methods parse as `method_elem`
 * (a different node type from `method_declaration`) and have NO
 * receiver parameter_list. The only way to attribute them is by walking
 * up to the enclosing `type_declaration > type_spec > interface_type`
 * and reading the type_spec's `name` field. This helper isolates that
 * structurally different walker so `collectGoMethodsFromAST` can stay
 * focused on the receiver-bearing `method_declaration` path.
 */
export const collectGoInterfaceMethodSymbols = (
  rootNode: Parser.SyntaxNode,
  filePath: string,
): MethodSymbol[] => {
  const defs: MethodSymbol[] = [];
  walk(rootNode, (n) => {
    if (n.type !== 'method_elem') return;
    const nameNode = n.childForFieldName('name') ?? n.children.find((c) => c.type === 'field_identifier');
    if (!nameNode) return;
    let cur: Parser.SyntaxNode | null = n.parent;
    let ownerId: string | undefined;
    while (cur) {
      if (cur.type === 'type_declaration') {
        let typeSpec: Parser.SyntaxNode | null = null;
        for (let i = 0; i < cur.namedChildCount; i++) {
          const c = cur.namedChild(i);
          if (c?.type === 'type_spec') { typeSpec = c; break; }
        }
        if (typeSpec) {
          const tn = typeSpec.childForFieldName('type');
          const nm = typeSpec.childForFieldName('name');
          if (nm && tn?.type === 'interface_type') {
            ownerId = generateId('Interface', `${filePath}:${nm.text}`);
            break;
          }
        }
      }
      cur = cur.parent;
    }
    if (ownerId) {
      defs.push({
        nodeId: generateId('Method', `${filePath}:${nameNode.text}`),
        filePath,
        type: 'Method',
        ownerId,
      });
    }
  });
  return defs;
};

/**
 * Build a per-file SymbolDefinition list by walking the AST for method
 * declarations and resolving their owning struct/interface.
 *
 * Used by the AST-based heritage-processor fallback (the worker-based
 * path already has a populated SymbolTable). The output shape matches
 * the SymbolDefinition contract expected by collectGoImplementsHeritage.
 *
 * Compositionally, this function delegates to two focused walkers:
 *   - `collectGoInterfaceMethodSymbols` for `method_elem` (interface body)
 *   - the inline `method_declaration` walker (struct methods + same-file
 *     interface methods rendered as `method_declaration` with no receiver)
 */
export const collectGoMethodsFromAST = (
  rootNode: Parser.SyntaxNode,
  filePath: string,
): MethodSymbol[] => {
  const defs: MethodSymbol[] = [
    ...collectGoInterfaceMethodSymbols(rootNode, filePath),
  ];

  walk(rootNode, (n) => {
    if (n.type !== 'method_declaration') return;
    const nameNode = n.childForFieldName('name') ?? n.children.find((c) => c.type === 'field_identifier');
    if (!nameNode) return;

    // Find owning struct/interface. The method_declaration itself carries
    // the receiver parameter_list (for value/pointer methods) — check that
    // FIRST. Interface methods have no receiver; if absent, walk up to find
    // an enclosing type_declaration's interface_type.
    let ownerId: string | undefined;

    const receiver = n.childForFieldName?.('receiver');
    const paramDecl = receiver?.namedChildren?.find?.((c: any) => c.type === 'parameter_declaration');
    const typeNode = paramDecl?.childForFieldName?.('type');
    if (typeNode) {
      const inner = typeNode.type === 'pointer_type' ? typeNode.firstNamedChild : typeNode;
      if (inner && (inner.type === 'type_identifier' || inner.type === 'identifier')) {
        ownerId = generateId('Struct', `${filePath}:${inner.text}`);
      }
    }

    if (!ownerId) {
      // Interface method — walk up to find enclosing type_declaration > interface_type
      let cur: Parser.SyntaxNode | null = n.parent;
      while (cur) {
        if (cur.type === 'type_declaration') {
          let typeSpec: Parser.SyntaxNode | null = null;
          for (let i = 0; i < cur.namedChildCount; i++) {
            const c = cur.namedChild(i);
            if (c?.type === 'type_spec') { typeSpec = c; break; }
          }
          if (typeSpec) {
            const tn = typeSpec.childForFieldName('type');
            const nm = typeSpec.childForFieldName('name');
            if (nm && tn?.type === 'interface_type') {
              ownerId = generateId('Interface', `${filePath}:${nm.text}`);
              break;
            }
          }
        }
        cur = cur.parent;
      }
    }

    if (ownerId) {
      defs.push({
        nodeId: generateId('Method', `${filePath}:${nameNode.text}`),
        filePath,
        type: 'Method',
        ownerId,
      });
    }
  });
  return defs;
};

// ============================================================================
// WI-H85 / Issue #85 — cross-file Go IMPLEMENTS detection (two-pass)
// ============================================================================

/**
 * One interface entry in the cross-file registry. The set of method
 * names is the interface's effective method set (own methods + methods
 * promoted from any embedded interfaces, mirroring `collectFileTypeInfo`).
 */
export interface GoInterfaceMethodEntry {
  readonly name: string;
  readonly filePath: string;
  readonly methods: ReadonlySet<string>;
}

/**
 * Build a global registry of {interface name -> method set} for ALL
 * .go files in a batch. The registry is used by
 * `collectGoImplementsCrossFile` to match struct method sets against
 * interfaces defined in OTHER files.
 *
 * This is the pre-pass of the two-pass IMPLEMENTS detector. The per-file
 * `collectGoImplementsHeritage` pass remains authoritative for same-file
 * pairs; this pre-pass is additive.
 */
export const collectGoInterfaceMethods = (
  files: ReadonlyArray<{ path: string; rootNode: Parser.SyntaxNode }>,
): GoInterfaceMethodEntry[] => {
  const entries: GoInterfaceMethodEntry[] = [];
  for (const { path, rootNode } of files) {
    const { interfaces } = collectFileTypeInfo(rootNode);
    for (const [name, methods] of interfaces) {
      entries.push({ name, filePath: path, methods });
    }
  }
  return entries;
};

/**
 * Cross-file IMPLEMENTS item. Distinct from `GoImplementsHeritageItem`
 * so the heritage-processor / parse-worker can apply the cross-file
 * confidence (0.7) directly and tag the reason as
 * 'cross-file-structural-match'.
 */
export interface GoCrossFileImplementsHeritageItem {
  readonly filePath: string;
  readonly className: string;
  readonly parentName: string;
  readonly parentFilePath: string;
  readonly kind: 'cross-file-implements';
  /** Confidence 0.7 — lower than same-file (0.95) to flag as less certain */
  readonly confidence: number;
}

/**
 * Cross-file Go IMPLEMENTS detector (WI-H85 / issue #85). For each
 * struct in the file, compare its method set against EVERY interface
 * in the global registry. Pairs that share the same file are skipped
 * (invariant 1 — the same-file pass is authoritative).
 *
 * Algorithm:
 *   1. Compute the file's struct method set (own + promoted).
 *   2. For each interface in the registry whose filePath !== this
 *      file's path, check if the struct's method set is a superset.
 *   3. Emit one item per match.
 *
 * Guards (matching the same-file pass):
 *   - Empty struct method set → no emit (EdgeCase #3)
 *   - Empty interface method set → no emit (EdgeCase #4)
 *   - Interface in same file as struct → skip (invariant 1)
 *   - Diamond interface inheritance → not handled in v1 (EdgeCase #5)
 *   - Signature matching → v1 uses name-only (AD-10, documented limitation)
 *
 * v1 uses name-only method comparison. Confidence 0.7 reflects the
 * structural-typing intent being clear but signature-level proof being
 * absent.
 */
export const collectGoImplementsCrossFile = (
  filePath: string,
  rootNode: Parser.SyntaxNode,
  fileSymbols: ReadonlyArray<MethodSymbol>,
  globalRegistry: ReadonlyArray<GoInterfaceMethodEntry>,
  sameFilePairs: ReadonlySet<string> = new Set(),
): GoCrossFileImplementsHeritageItem[] => {
  if (globalRegistry.length === 0) return [];

  // 1. Build per-file struct method set (mirrors collectGoImplementsHeritage)
  const { interfaces: localInterfaces, structInterfaceEmbeds } = collectFileTypeInfo(rootNode);
  const structOwnMethods = new Map<string, Set<string>>();
  for (const s of fileSymbols) {
    if (s.type !== 'Method') continue;
    if (!s.ownerId) continue;
    if (s.filePath !== filePath) continue;
    const prefix = `Struct:${filePath}:`;
    if (!s.ownerId.startsWith(prefix)) continue;
    const structName = s.ownerId.slice(prefix.length);
    let set = structOwnMethods.get(structName);
    if (!set) { set = new Set(); structOwnMethods.set(structName, set); }
    const methodPrefix = `Method:${filePath}:`;
    const rawName = s.nodeId.startsWith(methodPrefix)
      ? s.nodeId.slice(methodPrefix.length)
      : s.nodeId;
    const methodName = rawName.split(':')[0] ?? rawName;
    set.add(methodName);
  }

  // 2. Collect struct names declared in this file
  const allStructNames = new Set<string>();
  walk(rootNode, (n) => {
    if (n.type !== 'type_declaration') return;
    let typeSpec: Parser.SyntaxNode | null = null;
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c?.type === 'type_spec') { typeSpec = c; break; }
    }
    if (!typeSpec) return;
    const nameNode = typeSpec.childForFieldName('name');
    const typeNode = typeSpec.childForFieldName('type');
    if (nameNode && typeNode?.type === 'struct_type') {
      allStructNames.add(nameNode.text);
    }
  });

  if (allStructNames.size === 0) return [];

  const items: GoCrossFileImplementsHeritageItem[] = [];

  for (const structName of allStructNames) {
    const ownMethods = structOwnMethods.get(structName) ?? new Set<string>();
    const structMethodSet = computeStructMethodSet(
      structName, ownMethods, structInterfaceEmbeds, localInterfaces,
    );
    if (structMethodSet.size === 0) continue;  // EdgeCase #3

    for (const iface of globalRegistry) {
      if (iface.methods.size === 0) continue;  // EdgeCase #4
      if (iface.filePath === filePath) continue; // invariant 1: same-file handled by first pass
      if (iface.methods.size > structMethodSet.size) continue;
      // Dedup against same-file pair (invariant 7)
      if (sameFilePairs.has(`${structName}->${iface.name}`)) continue;

      let isSuperset = true;
      for (const m of iface.methods) {
        if (!structMethodSet.has(m)) { isSuperset = false; break; }
      }
      if (isSuperset) {
        items.push({
          filePath,
          className: structName,
          parentName: iface.name,
          parentFilePath: iface.filePath,
          kind: 'cross-file-implements',
          confidence: 0.7,
        });
      }
    }
  }

  if (isVerboseIngestionEnabled() && items.length > 0) {
    console.debug(`[go-relationships] ${filePath}: ${items.length} cross-file IMPLEMENTS edges derived from global method-set registry`);
  }
  return items;
};
