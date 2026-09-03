import { describe, it, expect } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';

/**
 * Grammars that ship as an npm `optionalDependency` or a vendored prebuild are
 * absent on platforms without a build for them, so the suites that need them
 * skip by contract. That contract has a hole: a language whose grammar never
 * installs *anywhere in CI* merges with every one of its suites reported
 * green-by-skip, and its native parser path is never executed once.
 *
 * `GITNEXUS_REQUIRE_<LANG>=1` closes it. A job that sets it declares "this
 * platform has a prebuild, so the grammar MUST be here" and a missing grammar
 * becomes a hard failure instead of a skip — the same contract
 * `GITNEXUS_REQUIRE_FTS` gives the FTS suites (test/helpers/fts-availability.ts).
 * Local and prebuild-less runs leave the variable unset and keep skipping.
 *
 * Add a language here only once at least one *required* CI job runs on a
 * platform its grammar publishes a prebuild for; otherwise the gate would fail
 * a job it cannot satisfy.
 */
export const OPTIONAL_GRAMMAR_ENV: Readonly<Partial<Record<string, string>>> = {
  // @tree-sitter-grammars/tree-sitter-zig@1.1.2 publishes prebuilds for
  // {darwin,linux,win32}-{x64,arm64} — every OS in the CI matrix.
  [SupportedLanguages.Zig]: 'GITNEXUS_REQUIRE_ZIG',
} satisfies Partial<Record<SupportedLanguages, string>>;

/**
 * True when CI declared this grammar mandatory on the current runner.
 *
 * Keyed by GRAMMAR key, not by `SupportedLanguages`: the registry the ABI
 * load-smoke walks (`listGrammarSources()`) yields one row per `SOURCES` entry,
 * which includes variants such as `typescript:tsx` that are not enum members.
 * Widening the parameter is what keeps that call honest — narrowing the key
 * with a cast would claim every grammar row is a language, which is false.
 * `satisfies` above still pins every key WE write to a real language.
 */
export const isOptionalGrammarRequired = (grammarKey: string): boolean => {
  const envVar = OPTIONAL_GRAMMAR_ENV[grammarKey];
  return envVar !== undefined && process.env[envVar] === '1';
};

export interface OptionalGrammarGate {
  readonly language: SupportedLanguages;
  /** The grammar loaded on this machine. */
  readonly available: boolean;
  /** CI declared it mandatory here (see {@link OPTIONAL_GRAMMAR_ENV}). */
  readonly required: boolean;
  /** Pass to `describe.skipIf` — suites still skip when the grammar is absent. */
  readonly skip: boolean;
}

export const optionalGrammarGate = (language: SupportedLanguages): OptionalGrammarGate => {
  const available = isLanguageAvailable(language);
  return { language, available, required: isOptionalGrammarRequired(language), skip: !available };
};

/**
 * Register the presence assertion for `gate`. Call it once per language, from
 * the suite file that owns that language's coverage.
 *
 * Deliberately a separate assertion rather than flipping the suites themselves
 * from skip to fail: a skipped suite reports success, so the only thing that
 * can turn "Zig never ran" into a red job is a test that *fails* when the
 * grammar is missing. It is inert (skipped) wherever the grammar is genuinely
 * optional, which is what keeps local runs on a prebuild-less platform usable.
 */
export const describeGrammarPresence = (gate: OptionalGrammarGate): void => {
  const envVar = OPTIONAL_GRAMMAR_ENV[gate.language] ?? '<unregistered>';
  describe.skipIf(!gate.required)(`${gate.language} grammar presence (${envVar}=1)`, () => {
    it('the optional grammar is installed, so no suite below is green-by-skip', () => {
      expect(
        gate.available,
        `${envVar}=1 declares the ${gate.language} grammar mandatory on this runner, but it did ` +
          `not load — every ${gate.language} suite would have skipped and the job would still be ` +
          `green. Install the grammar on this platform or drop ${envVar} from the job.`,
      ).toBe(true);
    });
  });
};
