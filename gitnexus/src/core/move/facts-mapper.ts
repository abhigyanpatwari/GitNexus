/**
 * Thin facts → graph mapper.
 *
 * Consumes the move-flow `facts` query response (the compiler's full-fidelity,
 * per-module structured facts) and produces standard GraphNode / GraphRelationship
 * objects. This is the heart of the compiler-first Move ingestion: there is
 * **no raw-source scanning** — every fact (visibility, entry/view, attributes,
 * acquires, resource reads/writes, enum variants, friends, locations) comes
 * straight from move-flow.
 */

import type {
  GraphNode,
  GraphRelationship,
  NodeLabel,
  NodeProperties,
  RelationshipType,
} from 'gitnexus-shared';
import type {
  MoveFactsAttribute,
  MoveFactsFunction,
  MoveFactsMap,
  MoveFactsTypeParam,
} from './compiler-facts.js';
import {
  moveModuleNodeId,
  moveFunctionNodeId,
  moveStructNodeId,
  moveEnumNodeId,
  moveConstNodeId,
  moveEnumVariantNodeId,
  moveFieldNodeId,
  moveRelId,
  parseMoveLambdaHostName,
  parseMoveModuleQualifiedName,
} from './symbol-id.js';
import {
  ERROR_CODE_PATTERN,
  MOVE_ABILITY,
  MOVE_ATTR,
  MOVE_EDGE_REASON,
  MOVE_LANGUAGE,
  moveRepoRelativePath,
} from './constants.js';
import { extractTypeNames } from './type-parser.js';
import { toZeroBasedLine } from '../ingestion/utils/line-base.js';
import type { PendingRef } from './refs.js';

const spanLine = (span: [number, number] | undefined, idx: 0 | 1): number | undefined =>
  span ? toZeroBasedLine(span[idx]) : undefined;

function functionLocationFidelity(
  fn: MoveFactsFunction,
  moduleFile: string | undefined,
): NodeProperties['locationFidelity'] {
  if (fn.isLambdaLifted) return moduleFile ? 'module' : 'package';
  return fn.file ? 'precise' : 'package';
}

export interface MoveFactsMapResult {
  nodes: GraphNode[];
  edges: GraphRelationship[];
  /** Module qualified name → source file path. */
  moduleFileMap: Map<string, string>;
  /** Function qualified name → graph node ID. */
  functionNodeMap: Map<string, string>;
  /** Struct/enum qualified name → graph node ID. */
  structNodeMap: Map<string, string>;
  /** Cross-package references resolved in the linker's Pass B. */
  pendingRefs: PendingRef[];
}

/** Strip generic type arguments: `CoinStore<CoinType>` → `CoinStore`. */
function stripTypeArgs(typeName: string): string {
  const idx = typeName.indexOf('<');
  return (idx === -1 ? typeName : typeName.slice(0, idx)).trim();
}

/** Defensive: move-flow omits optional array fields for some symbols. */
function arr<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function typeParamsJson(typeParams: MoveFactsTypeParam[] | null | undefined): string {
  const list = arr(typeParams).map((tp) => ({
    name: tp.name,
    constraints: arr(tp.abilities),
    isPhantom: tp.isPhantom,
  }));
  return JSON.stringify(list);
}

function attributeNames(attributes: { name: string }[] | null | undefined): string[] {
  return arr(attributes).map((a) => a.name);
}

/** Full attribute payload (nested `args` / assignment `value`s) as JSON;
 *  undefined (not `"[]"`) when the symbol carries no attributes. */
function attributesJson(attributes: MoveFactsAttribute[] | null | undefined): string | undefined {
  const list = arr(attributes);
  return list.length > 0 ? JSON.stringify(list) : undefined;
}

/** `#[resource_group_member(group = <qualified struct>)]` -> the group struct ref. */
function resourceGroupOf(attributes: MoveFactsAttribute[] | null | undefined): string | undefined {
  for (const a of arr(attributes)) {
    if (a.name !== MOVE_ATTR.RESOURCE_GROUP_MEMBER) continue;
    for (const groupArg of arr(a.args)) {
      if (groupArg.name === 'group' && typeof groupArg.value === 'string') {
        return groupArg.value;
      }
    }
  }
  return undefined;
}

/**
 * Scalar projection of `returnTypes` for the lbug `returnType` STRING column:
 * `[]` -> undefined, single -> the element, tuple -> `'(a, b)'`.
 */
function returnTypeProjection(returnTypes: string[]): string | undefined {
  if (returnTypes.length === 0) return undefined;
  return returnTypes.length === 1 ? returnTypes[0] : `(${returnTypes.join(', ')})`;
}

/**
 * Boundary shape sentinel: reject the legacy scalar `returnType` shape. The
 * mapper requires `returnTypes: string[]`; silently mapping the old scalar
 * `returnType` would drop every return-type fact, so hard-fail with an
 * operator-actionable upgrade message. The shape is uniform across a payload,
 * so the first function encountered decides for all of them.
 */
function assertFactsShape(facts: MoveFactsMap): void {
  for (const mod of Object.values(facts)) {
    for (const fn of arr(mod.functions)) {
      if (!Array.isArray(fn.returnTypes) && 'returnType' in fn) {
        throw Object.assign(
          new Error(
            'move-flow returned the legacy scalar `returnType` facts shape - upgrade ' +
              'move-flow to a build that emits `returnTypes: string[]` (>=2.0.0).',
          ),
          { userActionable: true },
        );
      }
      return;
    }
  }
}

/**
 * Map a full `facts` response (covering every module in a package) to graph
 * nodes + edges. `packageRoot` is used only as a location fallback when the
 * compiler omits a per-symbol file (it never does today, but the field is
 * optional in the schema). When `repoPath` is given, absolute file paths from
 * the compiler are made repo-relative so node IDs align with `File:` nodes.
 */
export function mapFactsToGraph(
  facts: MoveFactsMap,
  packageRoot: string,
  repoPath?: string,
): MoveFactsMapResult {
  assertFactsShape(facts);
  const nodes: GraphNode[] = [];
  const edges: GraphRelationship[] = [];
  const moduleFileMap = new Map<string, string>();
  const functionNodeMap = new Map<string, string>();
  const structNodeMap = new Map<string, string>();

  const edge = (
    sourceId: string,
    targetId: string,
    type: RelationshipType,
    confidence: number,
    reason: string,
  ): void => {
    edges.push({
      id: moveRelId(sourceId, type, targetId, reason),
      sourceId,
      targetId,
      type,
      confidence,
      reason,
    });
  };

  // Deferred work that needs the full struct/module index (pass B).
  const pendingRefs: PendingRef[] = [];

  // ── Pass A: nodes (modules, functions, types, constants) ─────────────────
  for (const [moduleQualified, mod] of Object.entries(facts)) {
    const moduleFileAbs = mod.file ?? packageRoot;
    const file = moveRepoRelativePath(moduleFileAbs, repoPath);
    const { address, moduleName } = parseMoveModuleQualifiedName(moduleQualified);
    moduleFileMap.set(moduleQualified, file);

    const moduleNodeId = moveModuleNodeId(moduleQualified, file);
    nodes.push({
      id: moduleNodeId,
      label: 'Module',
      properties: {
        name: moduleName,
        filePath: file,
        language: MOVE_LANGUAGE,
        qualifiedName: moduleQualified,
        moduleQualifiedName: moduleQualified,
        moduleAddress: address,
        startLine: spanLine(mod.span, 0),
        endLine: spanLine(mod.span, 1),
        attributes: attributeNames(mod.attributes),
        attributesJson: attributesJson(mod.attributes),
        locationFidelity: mod.file ? 'precise' : 'package',
      },
    });

    for (const friend of arr(mod.friends)) {
      pendingRefs.push({
        kind: 'friend',
        knownNodeId: moduleNodeId,
        target: friend.module,
        moduleQualified: '',
        edgeType: 'FRIEND_OF',
        reason: MOVE_EDGE_REASON.friend,
      });
    }

    // Functions
    for (const fn of arr(mod.functions)) {
      const fnQualified = `${moduleQualified}::${fn.name}`;
      // move-flow may report the callee/dependency span that caused a lifted
      // lambda to be instantiated. The synthesized function still belongs to
      // its declaring module, so anchoring it to that external dependency
      // creates phantom source ownership (observed with Aptos big_ordered_map).
      const fnSourceFile = fn.isLambdaLifted ? moduleFileAbs : (fn.file ?? moduleFileAbs);
      const fnFile = moveRepoRelativePath(fnSourceFile, repoPath);
      const fnSpan = fn.isLambdaLifted ? undefined : fn.span;
      const fnNodeId = moveFunctionNodeId(fnQualified, fnFile);
      functionNodeMap.set(fnQualified, fnNodeId);
      const attrs = attributeNames(fn.attributes);
      const seenTypeRefs = new Set<string>();
      // Skip the function's own type parameters (e.g. `CoinType`): they are not
      // nominal types and would create spurious USES_TYPE edges.
      const fnTypeParamNames = new Set(arr(fn.typeParams).map((tp) => tp.name));
      const addSignatureTypes = (typeExpr: string | null | undefined, reason: string): void => {
        if (!typeExpr) return;
        for (const typeName of extractTypeNames(typeExpr)) {
          if (fnTypeParamNames.has(typeName)) continue;
          const key = `${reason}\0${typeName}`;
          if (seenTypeRefs.has(key)) continue;
          seenTypeRefs.add(key);
          pendingRefs.push({
            kind: 'type',
            knownNodeId: fnNodeId,
            moduleQualified,
            target: typeName,
            edgeType: 'USES_TYPE',
            reason,
          });
        }
      };
      for (const p of arr(fn.params)) {
        addSignatureTypes(p.type, MOVE_EDGE_REASON.fnParamType);
      }
      for (const rt of arr(fn.returnTypes)) {
        addSignatureTypes(rt, MOVE_EDGE_REASON.fnReturnType);
      }
      const fnProps: NodeProperties = {
        name: fn.name,
        filePath: fnFile,
        language: MOVE_LANGUAGE,
        qualifiedName: fnQualified,
        moduleQualifiedName: moduleQualified,
        // Compiler-marked entry/view functions are runtime-facing even when
        // their source visibility is internal.
        isExported: fn.visibility === 'public' || fn.isEntry === true || fn.isView === true,
        startLine: spanLine(fnSpan, 0),
        endLine: spanLine(fnSpan, 1),
        visibility: fn.visibility === 'internal' ? 'private' : fn.visibility,
        visibilityModifier: fn.visibility,
        isEntry: fn.isEntry,
        isView: fn.isView,
        isInline: fn.isInline,
        isNative: fn.isNative,
        attributes: attrs,
        attributesJson: attributesJson(fn.attributes),
        typeParamsJson: typeParamsJson(fn.typeParams),
        acquires: arr(fn.acquiresInferred),
        usedTypes: [],
        returnType: returnTypeProjection(arr(fn.returnTypes)),
        parameterCount: arr(fn.params).length,
        locationFidelity: functionLocationFidelity(fn, mod.file),
      };
      // Lambda → host link queued for Pass 2 (host fn node may not yet exist
      // when this lambda is mapped). The canonical Cypher path for "is this a
      // lambda?" is the inbound CALLS edge with reason 'move-lambda-of-host';
      // we do not project an `isLambda` boolean property because the lbug
      // Function table does not carry it. move-flow reports the host explicitly
      // via `definedIn` (resolved through nested closures); the
      // `__lambda__N__<host>` name parse remains as fallback.
      const lambdaHostLocal =
        (fn.isLambdaLifted ? fn.definedIn : undefined) ?? parseMoveLambdaHostName(fn.name);
      if (lambdaHostLocal) {
        pendingRefs.push({
          kind: 'lambda-host',
          knownNodeId: fnNodeId,
          target: `${moduleQualified}::${lambdaHostLocal}`,
          moduleQualified: '',
          edgeType: 'CALLS',
          reason: MOVE_EDGE_REASON.lambdaHost,
        });
      }
      nodes.push({
        id: fnNodeId,
        label: 'Function',
        properties: fnProps,
      });
      edge(moduleNodeId, fnNodeId, 'DEFINES', 1.0, MOVE_EDGE_REASON.definesFunction);

      for (const r of arr(fn.resourceAccess?.reads)) {
        pendingRefs.push({
          kind: 'resource',
          knownNodeId: fnNodeId,
          moduleQualified,
          target: stripTypeArgs(r),
          edgeType: 'READS_RESOURCE',
          reason: MOVE_EDGE_REASON.readsResource,
        });
      }
      for (const w of arr(fn.resourceAccess?.writes)) {
        pendingRefs.push({
          kind: 'resource',
          knownNodeId: fnNodeId,
          moduleQualified,
          target: stripTypeArgs(w),
          edgeType: 'WRITES_RESOURCE',
          reason: MOVE_EDGE_REASON.writesResource,
        });
      }
      for (const a of arr(fn.acquiresInferred)) {
        pendingRefs.push({
          kind: 'resource',
          knownNodeId: fnNodeId,
          moduleQualified,
          target: a,
          edgeType: 'ACQUIRES',
          reason: MOVE_EDGE_REASON.acquires,
        });
      }
    }

    // Types (structs + enums)
    for (const ty of arr(mod.structs)) {
      const tyQualified = `${moduleQualified}::${ty.name}`;
      const tyFile = moveRepoRelativePath(ty.file ?? moduleFileAbs, repoPath);
      const attrs = attributeNames(ty.attributes);
      const typeParamNames = new Set(arr(ty.typeParams).map((tp) => tp.name));
      const addFieldTypeRefs = (sourceNodeId: string, typeExpr: string, reason: string): void => {
        for (const target of new Set(extractTypeNames(typeExpr))) {
          if (typeParamNames.has(target)) continue;
          pendingRefs.push({
            kind: 'type',
            knownNodeId: sourceNodeId,
            moduleQualified,
            target,
            edgeType: 'USES_TYPE',
            reason,
          });
        }
      };
      if (ty.kind === 'struct') {
        const structNodeId = moveStructNodeId(tyQualified, tyFile);
        structNodeMap.set(tyQualified, structNodeId);
        nodes.push({
          id: structNodeId,
          label: 'Struct',
          properties: {
            name: ty.name,
            filePath: tyFile,
            language: MOVE_LANGUAGE,
            qualifiedName: tyQualified,
            moduleQualifiedName: moduleQualified,
            moduleAddress: address,
            startLine: spanLine(ty.span, 0),
            endLine: spanLine(ty.span, 1),
            abilities: arr(ty.abilities),
            isResource: arr(ty.abilities).includes(MOVE_ABILITY.KEY),
            isEvent: attrs.includes(MOVE_ATTR.EVENT),
            attributes: attrs,
            attributesJson: attributesJson(ty.attributes),
            typeParamsJson: typeParamsJson(ty.typeParams),
            fields: (ty.fields ?? []).map((f) => ({
              name: f.name,
              type: f.type,
              positional: f.positional,
            })),
            // STRING[] projection persisted to lbug (`fieldList` column).
            fieldList: (ty.fields ?? []).map((f) => `${f.name}: ${f.type}`),
            moveDeclarationKind: 'struct',
            locationFidelity: ty.file ? 'precise' : 'package',
          },
        });
        edge(moduleNodeId, structNodeId, 'DEFINES', 1.0, MOVE_EDGE_REASON.definesStruct);
        // `#[resource_group_member(group = ...)]` carries an exact qualified
        // struct ref (e.g. '0xa::vault::Group') - queue a membership USES_TYPE
        // edge resolved against the cross-package type index in Pass B.
        const resourceGroup = resourceGroupOf(ty.attributes);
        if (resourceGroup) {
          pendingRefs.push({
            kind: 'type',
            knownNodeId: structNodeId,
            moduleQualified,
            target: resourceGroup,
            edgeType: 'USES_TYPE',
            reason: MOVE_EDGE_REASON.resourceGroupMember,
          });
        }
        // Per-field Property nodes + HAS_PROPERTY edges so ACCESSES queries and
        // field-level taint can target individual fields. The composite name +
        // type live on the Struct as a `fields` array projection, but only the
        // per-field nodes let Cypher join on `(:Struct)-[:HAS_PROPERTY]->(:Property)`.
        for (const field of arr(ty.fields)) {
          const propId = moveFieldNodeId(tyQualified, field.name, tyFile);
          nodes.push({
            id: propId,
            label: 'Property',
            properties: {
              name: field.name,
              filePath: tyFile,
              language: MOVE_LANGUAGE,
              qualifiedName: `${tyQualified}.${field.name}`,
              parentStruct: tyQualified,
              moduleQualifiedName: moduleQualified,
              declaredType: field.type,
              positional: field.positional,
              startLine: spanLine(ty.span, 0),
            },
          });
          edge(structNodeId, propId, 'HAS_PROPERTY', 1.0, MOVE_EDGE_REASON.hasField);
          addFieldTypeRefs(propId, field.type, MOVE_EDGE_REASON.structFieldType);
        }
      } else {
        const eId = moveEnumNodeId(tyQualified, tyFile);
        structNodeMap.set(tyQualified, eId);
        nodes.push({
          id: eId,
          label: 'Enum',
          properties: {
            name: ty.name,
            filePath: tyFile,
            language: MOVE_LANGUAGE,
            qualifiedName: tyQualified,
            moduleQualifiedName: moduleQualified,
            moduleAddress: address,
            startLine: spanLine(ty.span, 0),
            endLine: spanLine(ty.span, 1),
            abilities: arr(ty.abilities),
            isResource: arr(ty.abilities).includes(MOVE_ABILITY.KEY),
            isEvent: attrs.includes(MOVE_ATTR.EVENT),
            attributes: attrs,
            attributesJson: attributesJson(ty.attributes),
            typeParamsJson: typeParamsJson(ty.typeParams),
            moveDeclarationKind: 'enum',
            locationFidelity: ty.file ? 'precise' : 'package',
          },
        });
        edge(moduleNodeId, eId, 'DEFINES', 1.0, MOVE_EDGE_REASON.definesEnum);
        for (const variant of arr(ty.variants)) {
          const vId = moveEnumVariantNodeId(tyQualified, variant.name, tyFile);
          nodes.push({
            id: vId,
            label: 'EnumVariant',
            properties: {
              name: variant.name,
              filePath: tyFile,
              language: MOVE_LANGUAGE,
              qualifiedName: `${tyQualified}::${variant.name}`,
              parentEnum: tyQualified,
              moduleQualifiedName: moduleQualified,
              variantKind: variant.kind,
              fieldsJson: JSON.stringify(
                arr(variant.fields).map((f) => ({
                  name: f.name,
                  type: f.type,
                  positional: f.positional,
                })),
              ),
              attributes: attributeNames(variant.attributes),
              attributesJson: attributesJson(variant.attributes),
              locationFidelity: ty.file ? 'module' : 'package',
            },
          });
          edge(eId, vId, 'CONTAINS', 1.0, MOVE_EDGE_REASON.containsVariant);
          for (const field of arr(variant.fields)) {
            const variantQualified = `${tyQualified}::${variant.name}`;
            const propId = moveFieldNodeId(variantQualified, field.name, tyFile);
            nodes.push({
              id: propId,
              label: 'Property',
              properties: {
                name: field.name,
                filePath: tyFile,
                language: MOVE_LANGUAGE,
                qualifiedName: `${variantQualified}.${field.name}`,
                moduleQualifiedName: moduleQualified,
                declaredType: field.type,
                startLine: spanLine(ty.span, 0),
              },
            });
            edge(vId, propId, 'HAS_PROPERTY', 1.0, MOVE_EDGE_REASON.hasVariantField);
            addFieldTypeRefs(propId, field.type, MOVE_EDGE_REASON.enumVariantFieldType);
          }
        }
      }
    }

    // Constants
    for (const c of arr(mod.constants)) {
      const cQualified = `${moduleQualified}::${c.name}`;
      const cNodeId = moveConstNodeId(cQualified, file);
      nodes.push({
        id: cNodeId,
        label: 'Const',
        properties: {
          name: c.name,
          filePath: file,
          language: MOVE_LANGUAGE,
          qualifiedName: cQualified,
          moduleQualifiedName: moduleQualified,
          constType: c.type,
          constValue: c.value,
          isErrorCode: ERROR_CODE_PATTERN.test(c.name),
          locationFidelity: mod.file ? 'module' : 'package',
        },
      });
      edge(moduleNodeId, cNodeId, 'DEFINES', 1.0, MOVE_EDGE_REASON.definesConst);
    }
  }

  return {
    nodes,
    edges,
    moduleFileMap,
    functionNodeMap,
    structNodeMap,
    pendingRefs,
  };
}

// Re-export for callers that prefer the label type.
export type { NodeLabel };
