import type { ParsedFile } from 'gitnexus-shared';

export interface ElixirImportExceptFact {
  readonly target: string;
  readonly excluded: readonly { readonly name: string; readonly arity: number }[];
  readonly startLine: number;
  readonly startCol: number;
}

export interface ElixirImportOnlyFact {
  readonly target: string;
  readonly allowed: readonly { readonly name: string; readonly arity: number }[];
  readonly startLine: number;
  readonly startCol: number;
}

export interface ElixirCaptureSideChannel {
  readonly kind: 'elixir';
  readonly importExcepts: readonly ElixirImportExceptFact[];
  readonly importOnly: readonly ElixirImportOnlyFact[];
  readonly frameworkFacts: readonly ElixirFrameworkFact[];
}

/** Plain worker-safe facts; resolution deliberately happens after every file is present. */
export type ElixirFrameworkFact =
  | {
      readonly kind: 'route';
      readonly path: string;
      readonly method: string;
      readonly handler: string;
      readonly action?: string;
      readonly line: number;
      readonly pipelines: readonly string[];
    }
  | {
      readonly kind: 'schema';
      readonly model: string;
      readonly table?: string;
      readonly line: number;
    }
  | {
      readonly kind: 'property';
      readonly model: string;
      readonly name: string;
      readonly propertyKind: string;
      readonly target?: string;
      readonly line: number;
    }
  | {
      readonly kind: 'query';
      readonly model: string;
      readonly method: string;
      readonly line: number;
    };

const importExceptsByFile = new Map<string, ElixirImportExceptFact[]>();
const importOnlyByFile = new Map<string, ElixirImportOnlyFact[]>();
const frameworkFactsByFile = new Map<string, ElixirFrameworkFact[]>();

export function clearElixirImportExcepts(filePath: string): void {
  importExceptsByFile.delete(filePath);
  importOnlyByFile.delete(filePath);
  frameworkFactsByFile.delete(filePath);
}

export function recordElixirImportOnly(filePath: string, fact: ElixirImportOnlyFact): void {
  const facts = importOnlyByFile.get(filePath) ?? [];
  facts.push(fact);
  importOnlyByFile.set(filePath, facts);
}

export function recordElixirImportExcept(filePath: string, fact: ElixirImportExceptFact): void {
  const facts = importExceptsByFile.get(filePath) ?? [];
  facts.push(fact);
  importExceptsByFile.set(filePath, facts);
}

export function recordElixirFrameworkFacts(
  filePath: string,
  facts: readonly ElixirFrameworkFact[],
): void {
  if (facts.length) frameworkFactsByFile.set(filePath, [...facts]);
}

export function collectElixirCaptureSideChannel(
  filePath: string,
): ElixirCaptureSideChannel | undefined {
  const importExcepts = importExceptsByFile.get(filePath);
  const importOnly = importOnlyByFile.get(filePath);
  const frameworkFacts = frameworkFactsByFile.get(filePath);
  return importExcepts?.length || importOnly?.length || frameworkFacts?.length
    ? {
        kind: 'elixir',
        importExcepts: importExcepts ?? [],
        importOnly: importOnly ?? [],
        frameworkFacts: frameworkFacts ?? [],
      }
    : undefined;
}

export function elixirImportOnlyFacts(parsed: ParsedFile): readonly ElixirImportOnlyFact[] {
  const payload = parsed.captureSideChannel as ElixirCaptureSideChannel | undefined;
  return payload?.kind === 'elixir' && Array.isArray(payload.importOnly) ? payload.importOnly : [];
}

export function elixirFrameworkFacts(parsed: ParsedFile): readonly ElixirFrameworkFact[] {
  const payload = parsed.captureSideChannel as ElixirCaptureSideChannel | undefined;
  return payload?.kind === 'elixir' && Array.isArray(payload.frameworkFacts)
    ? payload.frameworkFacts
    : [];
}

export function elixirImportExceptFacts(parsed: ParsedFile): readonly ElixirImportExceptFact[] {
  const payload = parsed.captureSideChannel as ElixirCaptureSideChannel | undefined;
  return payload?.kind === 'elixir' && Array.isArray(payload.importExcepts)
    ? payload.importExcepts
    : [];
}
