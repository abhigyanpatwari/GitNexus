/**
 * The drift guard for the twin build-output ignore lists (#3007 follow-up).
 *
 * TWO lists spell "do not index this directory", in two packages:
 *
 *   - `DEFAULT_IGNORE_LIST` — gitnexus `src/config/ignore-service.ts`. The
 *     analyzer's own list, consulted for every path during the repository walk.
 *   - `EXCLUDED_DIRS` — gitnexus-web `src/lib/upload-filter.ts`. A client-side
 *     pre-filter that decides what a browser folder upload sends at all.
 *
 * `_next` was added to both in the same PR, one commit apart. Before it, neither
 * carried the name — so #3007 was a shared omission rather than drift between
 * them. What this test guards is the divergence that becomes possible now that
 * the same name lives in two places with nothing tying them together.
 *
 * The containment runs web -> CLI only, and that direction is the load-bearing
 * one: the browser filter decides what the server ever sees, so a name it drops
 * that the analyzer would have indexed is silent source loss with no recovery —
 * this pre-filter reads no `.gitnexusignore`, so a negation cannot bring the
 * files back. The reverse direction is not an error: roughly sixty CLI-only
 * names exist because the analyzer prunes far more aggressively than an upload
 * needs to, and the walker's own `dot: false` already hides dot-directories from
 * it. That asymmetry is why equality is not the assertion.
 *
 * `.gitnexus` is the one deliberate exception, and it has a mechanism rather
 * than being an oversight: the CLI walker passes `dot: false` to glob
 * (`src/core/ingestion/filesystem-walker.ts`), so it never enumerates
 * dot-directories and does not need the name in its list. The browser filter has
 * no equivalent and must name it. That exemption is asserted explicitly in both
 * directions, so re-adding `.gitnexus` to the CLI list or dropping it from the
 * web list both fail loudly.
 *
 * Both sides are read from source rather than imported. `DEFAULT_IGNORE_LIST` is
 * module-private. `EXCLUDED_DIRS` is exported, but `upload-filter.ts` types its
 * inputs with the DOM `File` interface, which does not resolve under this
 * package's `lib: ["ES2022"] / types: ["node"]` — so importing it here would not
 * typecheck.
 */
import { describe, it, expect } from 'vitest';
import {
  IGNORE_SERVICE_PATH,
  UPLOAD_FILTER_PATH,
  readSource,
  setEntries,
} from '../helpers/ignore-set-source.js';

const cliNames = () => setEntries(readSource(IGNORE_SERVICE_PATH), 'DEFAULT_IGNORE_LIST');
const webNames = () => setEntries(readSource(UPLOAD_FILTER_PATH), 'EXCLUDED_DIRS');

/**
 * Names the browser filter may drop that the analyzer does not list.
 *
 * Only `.gitnexus`, and only because the CLI walker's `dot: false` makes the
 * entry unnecessary there. A name added here must cite a comparable structural
 * reason in the walker — this list is not a place to park a failing assertion.
 */
const WEB_ONLY_ALLOWLIST = ['.gitnexus'];

describe('build-output ignore lists stay in agreement across packages', () => {
  it('parses both lists — neither is silently empty', () => {
    // Guards the guard: a parser that read nothing would make every containment
    // assertion below vacuously true.
    expect(cliNames().length).toBeGreaterThan(20);
    expect(webNames().length).toBeGreaterThan(5);
  });

  it('every name the browser filter drops is one the analyzer also ignores', () => {
    const cli = new Set(cliNames());
    const unmatched = webNames().filter(
      (name) => !cli.has(name) && !WEB_ONLY_ALLOWLIST.includes(name),
    );
    expect(unmatched).toEqual([]);
  });

  it('carries the documented web-only exemption, and only that one', () => {
    // Asserted separately from the containment above so the intent survives if
    // that assertion is ever relaxed.
    expect(webNames()).toContain('.gitnexus');
    expect(cliNames()).not.toContain('.gitnexus');
  });

  it('shares the build-output names the reported bug was about', () => {
    const cli = new Set(cliNames());
    const web = new Set(webNames());
    for (const name of ['_next', '.next', 'dist', 'build', 'out']) {
      expect(web.has(name), `${name} missing from the browser upload filter`).toBe(true);
      expect(cli.has(name), `${name} missing from the analyzer ignore list`).toBe(true);
    }
  });
});
