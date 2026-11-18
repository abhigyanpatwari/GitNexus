/**
 * The supported source-visible Lombok constructor inventory for Java DI.
 * This describes dependency facts only; it does not manufacture Constructor
 * graph nodes or resolve arbitrary lombok.config / onConstructor options.
 */
import type Parser from 'tree-sitter';
import { hasRecoveredSyntax } from '../../utils/ast-helpers.js';
import {
  collectLombokImports,
  isProvenJavaAnnotation,
  javaMemberTypeDeclarations,
  lombokAnnotationProof,
  mayBeLombokBuilderDefault,
  readLombokFieldDefaultsMakeFinal,
  type LombokImportIndex,
} from './lombok-synthesizer.js';
import { JAVA_IDENTIFIER_PART_CHARS } from './type-spelling.js';

const LEADING_NAME = new RegExp(`^[${JAVA_IDENTIFIER_PART_CHARS}]+`, 'u');

interface GeneratedDependency {
  readonly name: string;
  readonly rawType: string;
  readonly annotations: readonly never[];
}

interface GeneratedConstructor {
  readonly parameterTypes: readonly string[];
  readonly dependencies: readonly GeneratedDependency[];
}

export interface JavaLombokConstructorInventory {
  readonly generated: readonly GeneratedConstructor[];
  /** Unsupported options can add constructors even when we cannot describe them. */
  readonly complete: boolean;
  readonly hasSignatureConflict: boolean;
}

const CONSTRUCTOR_ANNOTATIONS = new Set([
  'RequiredArgsConstructor',
  'AllArgsConstructor',
  'NoArgsConstructor',
]);
const CONSTRUCTOR_RELATED = new Set([
  ...CONSTRUCTOR_ANNOTATIONS,
  'Data',
  'Value',
  'Builder',
  'SuperBuilder',
  'FieldDefaults',
]);

function annotationsOf(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  return (
    node.namedChildren
      .find((child) => child.type === 'modifiers')
      ?.namedChildren.filter(
        (child) => child.type === 'annotation' || child.type === 'marker_annotation',
      ) ?? []
  );
}

function annotationName(node: Parser.SyntaxNode): string {
  return node.childForFieldName('name')?.text ?? '';
}

function simpleAnnotationName(node: Parser.SyntaxNode): string {
  return annotationName(node).split('.').pop() ?? '';
}

function hasDefaultOptions(node: Parser.SyntaxNode): boolean {
  const argumentsNode = node.childForFieldName('arguments');
  return (
    !hasRecoveredSyntax(node) &&
    (argumentsNode === null ||
      argumentsNode.namedChildren.every(
        (child) => child.type === 'line_comment' || child.type === 'block_comment',
      ))
  );
}

function hasUncertainSpringFieldAnnotation(
  field: Parser.SyntaxNode,
  imports: LombokImportIndex,
): boolean {
  return annotationsOf(field).some((annotation) =>
    [
      'org.springframework.beans.factory.annotation.Qualifier',
      'org.springframework.beans.factory.annotation.Value',
    ].some((qualifiedName) => {
      const name = annotationName(annotation);
      if (isProvenJavaAnnotation(name, qualifiedName, imports, field)) return true;
      const simple = qualifiedName.split('.').pop()!;
      // Ambiguous annotation provenance is not permission to emit an
      // unqualified bean dependency. A known custom import/FQN is independent.
      return (
        name === simple &&
        !imports.bySimple.has(simple) &&
        !imports.shadowedSimpleNames.has(simple) &&
        imports.starPackages.has('org.springframework.beans.factory.annotation')
      );
    }),
  );
}

/** Signature comparison is bounded to written erasures in this compilation unit. */
function signatureOf(
  types: readonly string[],
  imports: LombokImportIndex,
  shadowedTypes: ReadonlySet<string>,
): string {
  return JSON.stringify(
    types.map((type) => {
      let depth = 0;
      let erased = '';
      for (const char of type) {
        if (char === '<') depth += 1;
        else if (char === '>') depth -= 1;
        else if (depth === 0 && !/\s/.test(char)) erased += char;
      }
      const head = LEADING_NAME.exec(erased)?.[0];
      const imported = head === undefined ? undefined : imports.bySimple.get(head);
      // Import identity expands only its leading type name. Never compare by
      // simple-name suffix: a.User and b.User remain different constructors.
      return imported !== undefined &&
        head !== undefined &&
        !shadowedTypes.has(head) &&
        !imports.shadowedSimpleNames.has(head)
        ? imported + erased.slice(head.length)
        : erased;
    }),
  );
}

function constructorTypeShadows(node: Parser.SyntaxNode): Set<string> {
  const names = new Set<string>();
  for (let owner: Parser.SyntaxNode | null = node; owner !== null; owner = owner.parent) {
    const parameters = owner.childForFieldName('type_parameters');
    for (const parameter of parameters?.namedChildren ?? []) {
      const name =
        parameter.childForFieldName('name') ??
        parameter.namedChildren.find((child) => child.type === 'type_identifier');
      if (name !== undefined && name !== null) names.add(name.text);
    }
    const members =
      owner.type === 'block'
        ? owner.namedChildren.filter((member) => member.startIndex <= node.startIndex)
        : [
              'class_declaration',
              'interface_declaration',
              'enum_declaration',
              'record_declaration',
              'annotation_type_declaration',
            ].includes(owner.type)
          ? javaMemberTypeDeclarations(owner.childForFieldName('body'))
          : [];
    for (const member of members) {
      if (
        ![
          'class_declaration',
          'interface_declaration',
          'enum_declaration',
          'record_declaration',
          'annotation_type_declaration',
        ].includes(member.type)
      )
        continue;
      const name = member.childForFieldName('name');
      if (name !== null) names.add(name.text);
    }
  }
  return names;
}

export function collectJavaLombokConstructors(
  classNode: Parser.SyntaxNode,
  compilationUnitImports?: LombokImportIndex,
): JavaLombokConstructorInventory {
  const empty: JavaLombokConstructorInventory = {
    generated: [],
    complete: true,
    hasSignatureConflict: false,
  };
  const classAnnotations = annotationsOf(classNode);
  // Most Java classes do not use Lombok. Avoid scanning imports for every type.
  if (
    !classAnnotations.some((annotation) =>
      CONSTRUCTOR_RELATED.has(simpleAnnotationName(annotation)),
    )
  ) {
    return empty;
  }
  let imports = compilationUnitImports;
  if (imports === undefined) {
    let root = classNode;
    while (root.parent !== null) root = root.parent;
    imports = collectLombokImports(root);
  }
  // Every Lombok-named annotation, with its proof at its own position. An
  // uncertain one may change generation in a way we cannot describe.
  let complete = true;
  const provenAt = (annotations: readonly Parser.SyntaxNode[], context: Parser.SyntaxNode) =>
    annotations.filter((annotation) => {
      const proof = lombokAnnotationProof(annotationName(annotation), imports, context);
      if (proof === 'uncertain') complete = false;
      return proof === true;
    });
  const proven = provenAt(classAnnotations, classNode);
  const body = classNode.childForFieldName('body');
  if (body === null) return empty;
  const explicit = body.namedChildren.filter((child) => child.type === 'constructor_declaration');
  const generators = proven.filter((annotation) =>
    CONSTRUCTOR_ANNOTATIONS.has(simpleAnnotationName(annotation)),
  );
  const value = proven.some((annotation) => simpleAnnotationName(annotation) === 'Value');
  const implied = proven.filter((annotation) =>
    ['Data', 'Value'].includes(simpleAnnotationName(annotation)),
  );
  const builder = proven.find((annotation) => simpleAnnotationName(annotation) === 'Builder');
  // SuperBuilder always adds a constructor taking its builder type.
  if (proven.some((annotation) => simpleAnnotationName(annotation) === 'SuperBuilder'))
    complete = false;
  // FieldDefaults(makeFinal=true) adds `final` like Value; unreadable options
  // might, so they leave the generated parameter list unknown.
  let makeFinal = false;
  for (const annotation of proven) {
    if (simpleAnnotationName(annotation) !== 'FieldDefaults') continue;
    const written = readLombokFieldDefaultsMakeFinal(annotation);
    if (written === undefined) complete = false;
    else makeFinal ||= written;
  }

  // Tolerate hides a constructor from Lombok, but not from Spring's inventory.
  // Do not infer a sole constructor when that generation policy is uncertain.
  if (
    explicit.some((constructor) =>
      provenAt(annotationsOf(constructor), constructor).some(
        (annotation) => simpleAnnotationName(annotation) === 'Tolerate',
      ),
    )
  )
    complete = false;
  let builderGenerates = false;
  if (generators.length === 0 && explicit.length === 0) {
    if (builder !== undefined) {
      // Class-level Builder writes its all-args constructor only when no
      // constructor is written and no XArgsConstructor is present; it then
      // also suppresses the Data/Value constructor.
      builderGenerates = true;
      generators.push(builder);
    } else {
      if (implied.length > 1) complete = false;
      generators.push(...implied);
    }
  }

  const fields: Array<{
    name: string;
    rawType: string;
    final: boolean;
    initialized: boolean;
    nonNull: boolean;
    uncertainAnnotation: boolean;
  }> = [];
  for (const field of body.namedChildren) {
    if (field.type !== 'field_declaration') continue;
    const modifiers = field.namedChildren.find((child) => child.type === 'modifiers');
    if (modifiers?.children.some((modifier) => modifier.text === 'static')) continue;
    const annotations = annotationsOf(field);
    const fieldLombok = provenAt(annotations, field);
    // Builder.Default moves the initializer into the builder; the generated
    // constructor then takes that field even when it is final.
    if (
      builderGenerates &&
      annotations.some((annotation) => mayBeLombokBuilderDefault(annotation, imports))
    )
      complete = false;
    const nonFinal = fieldLombok.some(
      (annotation) => simpleAnnotationName(annotation) === 'NonFinal',
    );
    const final =
      modifiers?.children.some((modifier) => modifier.text === 'final') === true ||
      ((value || makeFinal) && !nonFinal);
    const nonNull = fieldLombok.some(
      (annotation) => simpleAnnotationName(annotation) === 'NonNull',
    );
    const type = field.childForFieldName('type');
    if (type === null || hasRecoveredSyntax(field)) {
      complete = false;
      continue;
    }
    for (const declarator of field.namedChildren) {
      if (declarator.type !== 'variable_declarator') continue;
      const name = declarator.childForFieldName('name');
      if (name === null) {
        complete = false;
        continue;
      }
      if (name.text.startsWith('$')) continue;
      fields.push({
        name: name.text,
        rawType: type.text + (declarator.childForFieldName('dimensions')?.text ?? ''),
        final,
        initialized: declarator.childForFieldName('value') !== null,
        nonNull,
        uncertainAnnotation: hasUncertainSpringFieldAnnotation(field, imports),
      });
    }
  }

  const generated: GeneratedConstructor[] = [];
  for (const annotation of generators) {
    const kind = simpleAnnotationName(annotation);
    // Builder options configure the builder, never its all-args constructor.
    if (kind === 'Builder' ? hasRecoveredSyntax(annotation) : !hasDefaultOptions(annotation))
      complete = false;
    const allArgs = kind === 'AllArgsConstructor' || kind === 'Value' || kind === 'Builder';
    const noArgs = kind === 'NoArgsConstructor';
    if (noArgs && fields.some((field) => field.final && !field.initialized)) complete = false;
    const selected = noArgs
      ? []
      : fields.filter((field) =>
          allArgs
            ? !(field.final && field.initialized)
            : !field.initialized && (field.final || field.nonNull),
        );
    generated.push({
      parameterTypes: selected.map((field) => field.rawType),
      // Qualifier/Value copying requires effective lombok.config proof. Omit
      // these uncertain dependencies, rather than emit an unqualified fanout.
      dependencies: selected
        .filter((field) => !field.uncertainAnnotation)
        .map((field) => ({ name: field.name, rawType: field.rawType, annotations: [] as const })),
    });
  }

  const signatures = new Set(
    explicit.map((constructor) =>
      signatureOf(
        constructor
          .childForFieldName('parameters')
          ?.namedChildren.filter((parameter) =>
            ['formal_parameter', 'spread_parameter'].includes(parameter.type),
          )
          .map(
            (parameter) =>
              (parameter.childForFieldName('type')?.text ?? '?') +
              (parameter.type === 'spread_parameter'
                ? '[]'
                : (parameter.childForFieldName('dimensions')?.text ?? '')),
          ) ?? [],
        imports,
        constructorTypeShadows(constructor),
      ),
    ),
  );
  const generatedShadows = constructorTypeShadows(classNode);
  let hasSignatureConflict = false;
  for (const constructor of generated) {
    const signature = signatureOf(constructor.parameterTypes, imports, generatedShadows);
    if (signatures.has(signature)) hasSignatureConflict = true;
    signatures.add(signature);
  }
  return { generated, complete, hasSignatureConflict };
}
