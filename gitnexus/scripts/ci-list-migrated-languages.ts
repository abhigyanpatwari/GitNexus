/**
 * CI helper — emits the `MIGRATED_LANGUAGES` set as a JSON matrix array for
 * GitHub Actions (`.github/workflows/ci-scope-parity.yml`).
 *
 * Consumed by the `discover` job in that workflow. Each entry has:
 *   - `slug`: lowercase language id, matching `test/integration/resolvers/<slug>.test.ts`.
 *   - `envvar`: uppercase suffix used to build the `REGISTRY_PRIMARY_<envvar>` toggle.
 *
 * Run with `npx tsx scripts/ci-list-migrated-languages.ts`. The script
 * writes a single JSON array to stdout (no wrapper object) so the
 * workflow can pipe it straight into `$GITHUB_OUTPUT`.
 */

import { MIGRATED_LANGUAGES } from '../src/core/ingestion/registry-primary-flag.js';

const entries = [...MIGRATED_LANGUAGES].map((slug) => {
  const s = String(slug);
  return {
    slug: s,
    envvar: s.toUpperCase().replace(/-/g, '_'),
  };
});

process.stdout.write(JSON.stringify(entries));
