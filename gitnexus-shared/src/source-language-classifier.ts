import { getLanguageCandidateFromFilename } from './language-detection.js';
import { SupportedLanguages } from './languages.js';

export const SOURCE_LANGUAGE_CLASSIFIER_VERSION = 1 as const;

export interface SourceLanguageProjectContext {
  readonly hasXcodeProject: boolean;
}

export type SourceLanguageClassificationReason =
  | 'fixed-extension'
  | 'objective-c-syntax'
  | 'xcode-context'
  | 'c-family-header-fallback'
  | 'matlab-syntax'
  | 'ambiguous-m'
  | 'unsupported-objective-cpp';

export interface SourceLanguageClassification {
  readonly language: SupportedLanguages | null;
  readonly confidence: number;
  readonly reason: SourceLanguageClassificationReason;
  readonly classifierVersion: typeof SOURCE_LANGUAGE_CLASSIFIER_VERSION;
}

export interface ClassifySourceLanguageInput {
  readonly filePath: string;
  readonly content: string;
  readonly projectContext: SourceLanguageProjectContext;
}

const blank = (characters: string[], index: number): void => {
  if (characters[index] !== '\n' && characters[index] !== '\r') characters[index] = ' ';
};

const isMatlabTransposeQuote = (characters: readonly string[], index: number): boolean => {
  for (let previous = index - 1; previous >= 0; previous--) {
    const value = characters[previous];
    if (value === ' ' || value === '\t' || value === '\r' || value === '\n') continue;
    return /[\w\])}.]/.test(value);
  }
  return false;
};

/** Replace C-family comments and literals with equal-length whitespace. */
const maskCommentsAndLiterals = (content: string): string => {
  const characters = content.split('');
  let index = 0;

  while (index < characters.length) {
    const current = characters[index];
    const next = characters[index + 1];

    if (current === '/' && next === '/') {
      blank(characters, index++);
      blank(characters, index++);
      while (index < characters.length && characters[index] !== '\n') {
        blank(characters, index++);
      }
      continue;
    }

    if (current === '/' && next === '*') {
      blank(characters, index++);
      blank(characters, index++);
      while (index < characters.length) {
        if (characters[index] === '*' && characters[index + 1] === '/') {
          blank(characters, index++);
          blank(characters, index++);
          break;
        }
        blank(characters, index++);
      }
      continue;
    }

    const objectiveCString = current === '@' && next === '"';
    const quote = objectiveCString ? '"' : current;
    const matlabTranspose = quote === "'" && isMatlabTransposeQuote(characters, index);
    if (objectiveCString || quote === '"' || (quote === "'" && !matlabTranspose)) {
      if (objectiveCString) blank(characters, index++);
      blank(characters, index++);
      while (index < characters.length) {
        const value = characters[index];
        if (value === '\\') {
          blank(characters, index++);
          if (index < characters.length) blank(characters, index++);
          continue;
        }
        blank(characters, index++);
        if (value === quote) break;
      }
      continue;
    }

    index++;
  }

  return characters.join('');
};

const hasObjectiveCPrimarySignal = (masked: string): boolean =>
  /@(?:interface|implementation|protocol|class|property|selector|encode|autoreleasepool|synchronized|try|catch|import)\b/.test(
    masked,
  ) ||
  /^[\t ]*[+-][\t ]*\(/m.test(masked) ||
  /^[\t ]*#[\t ]*import\b/m.test(masked);

const hasMatlabPrimarySignal = (masked: string): boolean =>
  /^[\t ]*(?:function|classdef)\b/m.test(masked);

const countMatlabSecondarySignalCategories = (masked: string): number => {
  let count = 0;
  if (/^[\t ]*%|%\{/m.test(masked)) count++;
  if (/\.\.\.[\t ]*(?:\r?\n|$)/m.test(masked)) count++;
  if (/[\w\])}.]'/.test(masked)) count++;

  const hasControl = /^[\t ]*(?:if|for|while|switch|try|parfor|spmd)\b/m.test(masked);
  const hasEnd = /^[\t ]*end\b/m.test(masked);
  if (hasControl && hasEnd) count++;

  const hasMatrix = /\[[^\]\r\n]*(?:[,;]|[\t ]+)[^\]\r\n]*\]/.test(masked);
  const hasElementwiseOperator = /\.\*|\.\/|\.\^/.test(masked);
  if (hasMatrix && hasElementwiseOperator) count++;
  return count;
};

const result = (
  language: SupportedLanguages | null,
  confidence: number,
  reason: SourceLanguageClassificationReason,
): SourceLanguageClassification => ({
  language,
  confidence,
  reason,
  classifierVersion: SOURCE_LANGUAGE_CLASSIFIER_VERSION,
});

/**
 * Determine the authoritative source language once per full source file.
 * Ambiguous inputs fail closed instead of being routed to a guessed grammar.
 */
export const classifySourceLanguage = ({
  filePath,
  content,
  projectContext,
}: ClassifySourceLanguageInput): SourceLanguageClassification => {
  const candidate = getLanguageCandidateFromFilename(filePath);
  if (candidate === null) {
    throw new Error(`Cannot classify unsupported source filename: ${filePath}`);
  }
  if (candidate.kind === 'unsupported') {
    return result(null, 1, 'unsupported-objective-cpp');
  }
  if (!candidate.requiresContentClassification) {
    return result(candidate.language, 1, 'fixed-extension');
  }

  const extension = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  const masked = maskCommentsAndLiterals(content);
  if (hasObjectiveCPrimarySignal(masked)) {
    return result(SupportedLanguages.ObjectiveC, 0.99, 'objective-c-syntax');
  }
  if (extension === '.h') {
    return result(SupportedLanguages.CPlusPlus, 0.8, 'c-family-header-fallback');
  }
  if (hasMatlabPrimarySignal(masked) || countMatlabSecondarySignalCategories(masked) >= 2) {
    return result(null, 0.99, 'matlab-syntax');
  }
  if (projectContext.hasXcodeProject) {
    return result(SupportedLanguages.ObjectiveC, 0.9, 'xcode-context');
  }
  return result(null, 0.5, 'ambiguous-m');
};
