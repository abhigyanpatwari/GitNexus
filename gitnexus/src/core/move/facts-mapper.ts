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
  MoveFactsModule,
  MoveFactsType,
  MoveFactsTypeParam,
  MoveFlowConstant,
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

/** Shared mutable accumulators threaded through every emitter. */
interface EmitContext {
  nodes: GraphNode[];
  edges: GraphRelationship[];
  moduleFileMap: Map<string, string>;
  functionNodeMap: Map<string, string>;
  structNodeMap: Map<string, string>;
  pendingRefs: PendingRef[];
  packageRoot: string;
  repoPath?: string;
}

/** Values derived once per module and read by the function/type/const emitters. */
interface ModuleEmitContext {
  moduleQualified: string;
  moduleNodeId: string;
  /** Absolute module file (or packageRoot fallback) — the per-symbol file fallback. */
  moduleFileAbs: string;
  /** Repo-relative module file — used for module-level and const nodes. */
  file: string;
  address: string;
  /** Raw `mod.file`; drives locationFidelity ('precise'/'module' vs 'package'). */
  modFile?: string;
}

function pushEdge(
  edges: GraphRelationship[],
  sourceId: string,
  targetId: string,
  type: RelationshipType,
  confidence: number,
  reason: string,
): void {
  edges.push({
    id: moveRelId(sourceId, type, targetId, reason),
    sourceId,
    targetId,
    type,
    confidence,
    reason,
  });
}

/** Emit the Module node + friend PendingRefs; return the per-module context. */
function emitModule(
  ctx: EmitContext,
  moduleQualified: string,
  mod: MoveFactsModule,
): ModuleEmitContext {
  const moduleFileAbs = mod.file ?? ctx.packageRoot;
  const file = moveRepoRelativePath(moduleFileAbs, ctx.repoPath);
  const { address, moduleName } = parseMoveModuleQualifiedName(moduleQualified);
  ctx.moduleFileMap.set(moduleQualified, file);

  const moduleNodeId = moveModuleNodeId(moduleQualified, file);
  ctx.nodes.push({
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
    ctx.pendingRefs.push({
      kind: 'friend',
      knownNodeId: moduleNodeId,
      target: friend.module,
      moduleQualified: '',
      edgeType: 'FRIEND_OF',
      reason: MOVE_EDGE_REASON.friend,
    });
  }

  return { moduleQualified, moduleNodeId, moduleFileAbs, file, address, modFile: mod.file };
}

/** Emit a Function node + DEFINES and its signature/resource/lambda PendingRefs. */
function emitFunction(ctx: EmitContext, mctx: ModuleEmitContext, fn: MoveFactsFunction): void {
  const fnQualified = `${mctx.moduleQualified}::${fn.name}`;
  // move-flow may report the callee/dependency span that caused a lifted lambda
  // to be instantiated. The synthesized function still belongs to its declaring
  // module, so anchoring it to that external dependency creates phantom source
  // ownership (observed with Aptos big_ordered_map).
  const fnSourceFile = fn.isLambdaLifted ? mctx.moduleFileAbs : (fn.file ?? mctx.moduleFileAbs);
  const fnFile = moveRepoRelativePath(fnSourceFile, ctx.repoPath);
  const fnSpan = fn.isLambdaLifted ? undefined : fn.span;
  const fnNodeId = moveFunctionNodeId(fnQualified, fnFile);
  ctx.functionNodeMap.set(fnQualified, fnNodeId);
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
      ctx.pendingRefs.push({
        kind: 'type',
        knownNodeId: fnNodeId,
        moduleQualified: mctx.moduleQualified,
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
    moduleQualifiedName: mctx.moduleQualified,
    // Compiler-marked entry/view functions are runtime-facing even when their
    // source visibility is internal.
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
    locationFidelity: functionLocationFidelity(fn, mctx.modFile),
  };
  // Lambda → host link queued for Pass B (host fn node may not yet exist when
  // this lambda is mapped). The canonical Cypher path for "is this a lambda?"
  // is the inbound CALLS edge with reason 'move-lambda-of-host'; we do not
  // project an `isLambda` boolean property because the lbug Function table does
  // not carry it. move-flow reports the host explicitly via `definedIn`
  // (resolved through nested closures); the `__lambda__N__<host>` name parse
  // remains as fallback.
  const lambdaHostLocal =
    (fn.isLambdaLifted ? fn.definedIn : undefined) ?? parseMoveLambdaHostName(fn.name);
  if (lambdaHostLocal) {
    ctx.pendingRefs.push({
      kind: 'lambda-host',
      knownNodeId: fnNodeId,
      target: `${mctx.moduleQualified}::${lambdaHostLocal}`,
      moduleQualified: '',
      edgeType: 'CALLS',
      reason: MOVE_EDGE_REASON.lambdaHost,
    });
  }
  ctx.nodes.push({ id: fnNodeId, label: 'Function', properties: fnProps });
  pushEdge(
    ctx.edges,
    mctx.moduleNodeId,
    fnNodeId,
    'DEFINES',
    1.0,
    MOVE_EDGE_REASON.definesFunction,
  );

  for (const r of arr(fn.resourceAccess?.reads)) {
    ctx.pendingRefs.push({
      kind: 'resource',
      knownNodeId: fnNodeId,
      moduleQualified: mctx.moduleQualified,
      target: stripTypeArgs(r),
      edgeType: 'READS_RESOURCE',
      reason: MOVE_EDGE_REASON.readsResource,
    });
  }
  for (const w of arr(fn.resourceAccess?.writes)) {
    ctx.pendingRefs.push({
      kind: 'resource',
      knownNodeId: fnNodeId,
      moduleQualified: mctx.moduleQualified,
      target: stripTypeArgs(w),
      edgeType: 'WRITES_RESOURCE',
      reason: MOVE_EDGE_REASON.writesResource,
    });
  }
  for (const a of arr(fn.acquiresInferred)) {
    ctx.pendingRefs.push({
      kind: 'resource',
      knownNodeId: fnNodeId,
      moduleQualified: mctx.moduleQualified,
      target: a,
      edgeType: 'ACQUIRES',
      reason: MOVE_EDGE_REASON.acquires,
    });
  }
}

/** Shared field-type ref emitter; skips the type's own type-parameter names. */
function addFieldTypeRefs(
  ctx: EmitContext,
  moduleQualified: string,
  typeParamNames: Set<string>,
  sourceNodeId: string,
  typeExpr: string,
  reason: string,
): void {
  for (const target of new Set(extractTypeNames(typeExpr))) {
    if (typeParamNames.has(target)) continue;
    ctx.pendingRefs.push({
      kind: 'type',
      knownNodeId: sourceNodeId,
      moduleQualified,
      target,
      edgeType: 'USES_TYPE',
      reason,
    });
  }
}

function emitStruct(
  ctx: EmitContext,
  mctx: ModuleEmitContext,
  ty: MoveFactsType,
  tyFile: string,
  attrs: string[],
  typeParamNames: Set<string>,
): void {
  const tyQualified = `${mctx.moduleQualified}::${ty.name}`;
  const structNodeId = moveStructNodeId(tyQualified, tyFile);
  ctx.structNodeMap.set(tyQualified, structNodeId);
  ctx.nodes.push({
    id: structNodeId,
    label: 'Struct',
    properties: {
      name: ty.name,
      filePath: tyFile,
      language: MOVE_LANGUAGE,
      qualifiedName: tyQualified,
      moduleQualifiedName: mctx.moduleQualified,
      moduleAddress: mctx.address,
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
      fieldList: (ty.fields ?? []).map((f) => `${f.name}: ${f.type}`),
      moveDeclarationKind: 'struct',
      locationFidelity: ty.file ? 'precise' : 'package',
    },
  });
  pushEdge(
    ctx.edges,
    mctx.moduleNodeId,
    structNodeId,
    'DEFINES',
    1.0,
    MOVE_EDGE_REASON.definesStruct,
  );
  // `#[resource_group_member(group = ...)]` carries an exact qualified struct ref;
  // queue a membership USES_TYPE edge resolved in Pass B.
  const resourceGroup = resourceGroupOf(ty.attributes);
  if (resourceGroup) {
    ctx.pendingRefs.push({
      kind: 'type',
      knownNodeId: structNodeId,
      moduleQualified: mctx.moduleQualified,
      target: resourceGroup,
      edgeType: 'USES_TYPE',
      reason: MOVE_EDGE_REASON.resourceGroupMember,
    });
  }
  // Per-field Property nodes + HAS_PROPERTY edges so ACCESSES queries and
  // field-level taint can target individual fields. The composite name + type
  // live on the Struct as a `fields` array projection, but only the per-field
  // nodes let Cypher join on `(:Struct)-[:HAS_PROPERTY]->(:Property)`.
  for (const field of arr(ty.fields)) {
    const propId = moveFieldNodeId(tyQualified, field.name, tyFile);
    ctx.nodes.push({
      id: propId,
      label: 'Property',
      properties: {
        name: field.name,
        filePath: tyFile,
        language: MOVE_LANGUAGE,
        qualifiedName: `${tyQualified}.${field.name}`,
        parentStruct: tyQualified,
        moduleQualifiedName: mctx.moduleQualified,
        declaredType: field.type,
        positional: field.positional,
        startLine: spanLine(ty.span, 0),
      },
    });
    pushEdge(ctx.edges, structNodeId, propId, 'HAS_PROPERTY', 1.0, MOVE_EDGE_REASON.hasField);
    addFieldTypeRefs(
      ctx,
      mctx.moduleQualified,
      typeParamNames,
      propId,
      field.type,
      MOVE_EDGE_REASON.structFieldType,
    );
  }
}

function emitEnum(
  ctx: EmitContext,
  mctx: ModuleEmitContext,
  ty: MoveFactsType,
  tyFile: string,
  attrs: string[],
  typeParamNames: Set<string>,
): void {
  const tyQualified = `${mctx.moduleQualified}::${ty.name}`;
  const eId = moveEnumNodeId(tyQualified, tyFile);
  ctx.structNodeMap.set(tyQualified, eId);
  ctx.nodes.push({
    id: eId,
    label: 'Enum',
    properties: {
      name: ty.name,
      filePath: tyFile,
      language: MOVE_LANGUAGE,
      qualifiedName: tyQualified,
      moduleQualifiedName: mctx.moduleQualified,
      moduleAddress: mctx.address,
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
  pushEdge(ctx.edges, mctx.moduleNodeId, eId, 'DEFINES', 1.0, MOVE_EDGE_REASON.definesEnum);
  for (const variant of arr(ty.variants)) {
    const vId = moveEnumVariantNodeId(tyQualified, variant.name, tyFile);
    ctx.nodes.push({
      id: vId,
      label: 'EnumVariant',
      properties: {
        name: variant.name,
        filePath: tyFile,
        language: MOVE_LANGUAGE,
        qualifiedName: `${tyQualified}::${variant.name}`,
        parentEnum: tyQualified,
        moduleQualifiedName: mctx.moduleQualified,
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
    pushEdge(ctx.edges, eId, vId, 'CONTAINS', 1.0, MOVE_EDGE_REASON.containsVariant);
    for (const field of arr(variant.fields)) {
      const variantQualified = `${tyQualified}::${variant.name}`;
      const propId = moveFieldNodeId(variantQualified, field.name, tyFile);
      ctx.nodes.push({
        id: propId,
        label: 'Property',
        properties: {
          name: field.name,
          filePath: tyFile,
          language: MOVE_LANGUAGE,
          qualifiedName: `${variantQualified}.${field.name}`,
          moduleQualifiedName: mctx.moduleQualified,
          declaredType: field.type,
          startLine: spanLine(ty.span, 0),
        },
      });
      pushEdge(ctx.edges, vId, propId, 'HAS_PROPERTY', 1.0, MOVE_EDGE_REASON.hasVariantField);
      addFieldTypeRefs(
        ctx,
        mctx.moduleQualified,
        typeParamNames,
        propId,
        field.type,
        MOVE_EDGE_REASON.enumVariantFieldType,
      );
    }
  }
}

/** Emit a struct or enum (move-flow groups both under the module's `structs`). */
function emitType(ctx: EmitContext, mctx: ModuleEmitContext, ty: MoveFactsType): void {
  const tyFile = moveRepoRelativePath(ty.file ?? mctx.moduleFileAbs, ctx.repoPath);
  const attrs = attributeNames(ty.attributes);
  const typeParamNames = new Set(arr(ty.typeParams).map((tp) => tp.name));
  switch (ty.kind) {
    case 'struct':
      emitStruct(ctx, mctx, ty, tyFile, attrs, typeParamNames);
      break;
    case 'enum':
      emitEnum(ctx, mctx, ty, tyFile, attrs, typeParamNames);
      break;
    default: {
      const _exhaustive: never = ty.kind;
      throw new Error(`Unhandled Move type kind: ${String(_exhaustive)}`);
    }
  }
}

/** Emit a Const node + DEFINES. */
function emitConst(ctx: EmitContext, mctx: ModuleEmitContext, c: MoveFlowConstant): void {
  const cQualified = `${mctx.moduleQualified}::${c.name}`;
  const cNodeId = moveConstNodeId(cQualified, mctx.file);
  ctx.nodes.push({
    id: cNodeId,
    label: 'Const',
    properties: {
      name: c.name,
      filePath: mctx.file,
      language: MOVE_LANGUAGE,
      qualifiedName: cQualified,
      moduleQualifiedName: mctx.moduleQualified,
      constType: c.type,
      constValue: c.value,
      isErrorCode: ERROR_CODE_PATTERN.test(c.name),
      locationFidelity: mctx.modFile ? 'module' : 'package',
    },
  });
  pushEdge(ctx.edges, mctx.moduleNodeId, cNodeId, 'DEFINES', 1.0, MOVE_EDGE_REASON.definesConst);
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
  const ctx: EmitContext = {
    nodes: [],
    edges: [],
    moduleFileMap: new Map(),
    functionNodeMap: new Map(),
    structNodeMap: new Map(),
    pendingRefs: [],
    packageRoot,
    repoPath,
  };

  for (const [moduleQualified, mod] of Object.entries(facts)) {
    const mctx = emitModule(ctx, moduleQualified, mod);
    for (const fn of arr(mod.functions)) emitFunction(ctx, mctx, fn);
    for (const ty of arr(mod.structs)) emitType(ctx, mctx, ty);
    for (const c of arr(mod.constants)) emitConst(ctx, mctx, c);
  }

  return {
    nodes: ctx.nodes,
    edges: ctx.edges,
    moduleFileMap: ctx.moduleFileMap,
    functionNodeMap: ctx.functionNodeMap,
    structNodeMap: ctx.structNodeMap,
    pendingRefs: ctx.pendingRefs,
  };
}

// Re-export for callers that prefer the label type.
export type { NodeLabel };
