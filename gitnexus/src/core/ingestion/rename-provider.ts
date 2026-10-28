import type { RenameSpan, RenameIssue, RenameReplacement } from 'gitnexus-shared';
export type { RenameSpan, RenameIssue, RenameReplacement } from 'gitnexus-shared';
import type Parser from 'tree-sitter';
import type {
  GraphNode,
  ParsedFile,
  Range,
  ReferenceSite,
  SymbolDefinition,
} from 'gitnexus-shared';
import type { KnowledgeGraph } from '../graph/types.js';
import type { LanguageProvider } from './language-provider.js';
import type { SemanticModel } from './model/semantic-model.js';
import type { ScopeResolutionIndexes } from './model/scope-resolution-indexes.js';
import type { ScopeResolver } from './scope-resolution/contract/scope-resolver.js';
import type { SourceBindingResolution } from './scope-resolution/source-binding-resolution.js';

/** One written name may have several spans (for example a multipart selector). */
export interface RenameOccurrence {
  readonly name: string;
  readonly range: Range;
  readonly spans: readonly RenameSpan[];
  /** Optional syntax evidence owned and interpreted only by the provider. */
  readonly node?: Parser.SyntaxNode;
  readonly role?: 'name' | 'unrelated' | 'binding' | 'imported' | 'alias';
  readonly definitionId?: string;
  readonly referenceSite?: ReferenceSite;
}

/** Providers return real semantic captures; standalone sources need no fake AST. */
export interface RenameSource {
  readonly path: string;
  readonly content: string;
  readonly parsed: ParsedFile;
  readonly tree?: Parser.Tree;
  readonly occurrences: readonly RenameOccurrence[];
}

export interface RenameParseInput {
  readonly filePath: string;
  readonly content: string;
  readonly languageProvider: LanguageProvider;
  readonly scopeResolver: ScopeResolver;
  /** A provider may delegate using its already selected embedded grammar. */
  readonly tree?: Parser.Tree;
}

export interface RenameSemanticContext {
  readonly target: SymbolDefinition;
  readonly definitions: readonly SymbolDefinition[];
  readonly files: ReadonlyMap<string, RenameSource>;
  readonly indexes: ScopeResolutionIndexes;
  readonly referenceBindings: ReadonlyMap<ReferenceSite, SourceBindingResolution>;
  readonly model: SemanticModel;
  readonly graph: KnowledgeGraph;
  readonly newName: string;
}

export interface RenameOccurrenceContext extends RenameSemanticContext {
  readonly source: RenameSource;
  readonly occurrence: RenameOccurrence;
  readonly site?: ReferenceSite;
  readonly targetDefIds: readonly string[];
  readonly selected: boolean;
}

/**
 * Source spelling, syntax, coupled declarations and rewrites belong to the
 * language. The rename engine owns graph identity, semantic proof, and the
 * filesystem transaction; it never classifies a language's syntax.
 */
export interface RenameProvider {
  /** Related source providers that share this provider's resolution workspace. */
  readonly acceptsSourceProvider?: (provider: LanguageProvider, filePath: string) => boolean;
  /**
   * Providers whose indexed sources can refer to this language but whose bindings
   * are not yet proven by the rename workspace. Their name inventory is refusal
   * evidence only; it must never supply edits or inferred reference identities.
   */
  readonly interoperatesWithSourceProvider?: (
    provider: LanguageProvider,
    filePath: string,
  ) => boolean;
  /**
   * Additional spellings, such as generated accessor names, under which an interoperating
   * source in `peer` can write one of this language's names, for refusal checks.
   */
  readonly interopNames?: (name: string, peer: LanguageProvider) => readonly string[];
  /**
   * The inverse bridge, applied to this language's own written names when `peer` is the
   * renamed language: a written name (for example a full selector) that denotes an entity
   * `peer` declares under a different spelling (its base name) returns that spelling, so the
   * inventory of this interoperating source meets the selected names. Refusal evidence only;
   * return nothing for a peer without a known bridge.
   */
  readonly boundaryNames?: (name: string, peer: LanguageProvider) => readonly string[];
  /** Opaque source names unavailable as semantic occurrences; refusal evidence only. */
  readonly additionalInteropNames?: (source: RenameSource) => readonly string[];
  /** Validate provider qualification after the graph bridge and source range agree. */
  readonly matchesGraphIdentity?: (context: {
    readonly definition: SymbolDefinition;
    readonly node: GraphNode;
    readonly definitions: readonly SymbolDefinition[];
    readonly graph: KnowledgeGraph;
    readonly files: ReadonlyMap<string, RenameSource>;
  }) => boolean;
  readonly parseSource: (input: RenameParseInput) => RenameSource | Promise<RenameSource>;
  readonly canonicalName?: (
    name: string,
    context?: {
      readonly definition?: SymbolDefinition;
      readonly site?: ReferenceSite;
      readonly occurrence?: RenameOccurrence;
    },
  ) => string;
  readonly validateName?: (name: string) => RenameIssue | void;
  readonly symbolFamily?: (
    context: RenameSemanticContext,
  ) => readonly SymbolDefinition[] | RenameIssue;
  readonly checkSafety?: (context: RenameSemanticContext) => RenameIssue | void;
  readonly checkOccurrence?: (context: RenameOccurrenceContext) => RenameIssue | void;
  readonly rewrite?: (
    context: RenameSemanticContext & {
      readonly source: RenameSource;
      readonly occurrence: RenameOccurrence;
      readonly newName: string;
    },
  ) => readonly RenameReplacement[] | RenameIssue;
  readonly validateRewrite?: (
    context: RenameSemanticContext & {
      readonly source: RenameSource;
      readonly updated: RenameSource;
      readonly edits: readonly RenameReplacement[];
    },
  ) => RenameIssue | void;
}
