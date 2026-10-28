import { FixtureProfiler, type FixtureProfile } from './fixture-profile.js';
import type { RawCoverageRecord, RawTestCoverage } from '../path-coverage/records.js';
import { sha1, sortedUnique } from '../util.js';

export type RuntimeFixtureProfiles = ReadonlyMap<
  RawCoverageRecord,
  ReadonlyMap<string, FixtureProfile>
>;

/** Parse immutable captures in the planner process, once per distinct input across test files. */
export async function profileRuntimeFixtures(
  records: readonly RawCoverageRecord[],
): Promise<RuntimeFixtureProfiles> {
  const contents = new Map<string, string>();
  const listings = new Map<string, string[]>();
  const profiler = new FixtureProfiler({
    read: (file) => contents.get(file) ?? null,
    list: (root) => listings.get(root) ?? [],
  });
  const profiles = new Map<RawCoverageRecord, Map<string, FixtureProfile>>();
  for (const record of records) {
    const perFile = new Map<string, FixtureProfile>();
    profiles.set(record, perFile);
    for (const [id, snapshot] of Object.entries(record.fixtureSnapshots ?? {})) {
      const root = `runtime-fixtures/${sha1(JSON.stringify(snapshot.files))}`;
      if (!listings.has(root)) {
        listings.set(
          root,
          snapshot.files.map(([file, text]) => {
            const key = `${root}/${file}`;
            contents.set(key, text);
            return key;
          }),
        );
      }
      const profile = await profiler.profile([root]);
      const unresolved = sortedUnique([...profile.unresolved, ...snapshot.unresolved]);
      perFile.set(id, {
        ...profile,
        sourceKeys: [sha1(JSON.stringify(snapshot.files))],
        roots: [snapshot.root],
        files: snapshot.files.map(([file]) =>
          snapshot.kind === 'read' ? snapshot.root : `${snapshot.root}/${file}`,
        ),
        contentKey: snapshot.unresolved.length ? null : profile.contentKey,
        unresolved,
      });
    }
  }
  return profiles;
}

/** Warm test inputs plus suite setup. Ambiguous windows remain explicit gaps. */
export function runtimeFixtureFor(
  raw: RawCoverageRecord,
  test: RawTestCoverage,
  profiles: ReadonlyMap<string, FixtureProfile> | undefined,
  concurrent: boolean,
): FixtureProfile | null {
  if (raw.fixtureSnapshots === undefined) return null;
  const chain = new Set(test.suiteChain);
  const suites = raw.suiteWindows.filter(({ suites }) => chain.has(suites[0]));
  const own = test.warm.fixtures ?? [];
  const applies = (id: string): boolean => {
    const suite = raw.fixtureSnapshots?.[id]?.suite;
    return suite === undefined || chain.has(suite);
  };
  const ids = [...suites.flatMap(({ window }) => window.fixtures ?? []).filter(applies), ...own];
  // Collection-time reads can supply inputs, but their ownership cannot be proved.
  ids.push(...(raw.unattributed.fixtures ?? []));
  if (ids.length === 0) return null;
  const unresolved: string[] = [];
  if (concurrent) unresolved.push('runtime fixture attribution: concurrent tests');
  if (
    suites.some(
      ({ suites, window }) =>
        suites.length > 1 &&
        (window.fixtures ?? []).some((id) => raw.fixtureSnapshots?.[id]?.suite === undefined),
    )
  )
    unresolved.push('runtime fixture attribution: combined suite setup');
  if ((raw.unattributed.fixtures?.length ?? 0) > 0)
    unresolved.push('runtime fixture attribution: outside test/setup windows');
  const warmKeys = new Set(
    own.map((id) => profiles?.get(id)?.contentKey).filter((key) => key != null),
  );
  if (
    (test.all.fixtures ?? []).some(
      (id) => !own.includes(id) && !warmKeys.has(profiles?.get(id)?.contentKey ?? ''),
    )
  )
    unresolved.push('runtime fixture inputs changed between attempts');
  const parts: FixtureProfile[] = [];
  for (const id of ids) {
    const profile = profiles?.get(id);
    if (profile === undefined) unresolved.push(`runtime fixture snapshot missing: ${id}`);
    else parts.push(profile);
  }
  const counts = new Map<string, number>();
  for (const part of parts)
    for (const [key, count] of part.features) counts.set(key, (counts.get(key) ?? 0) + count);
  return {
    sourceKeys: sortedUnique(parts.flatMap((part) => part.sourceKeys ?? [])),
    roots: sortedUnique(parts.flatMap((part) => part.roots)),
    files: sortedUnique(parts.flatMap((part) => part.files)),
    languages: sortedUnique(parts.flatMap((part) => part.languages)),
    contentKey:
      unresolved.length === 0 && parts.every((part) => part.contentKey !== null)
        ? parts.length === 1
          ? parts[0].contentKey
          : sha1(JSON.stringify(parts.map((part) => part.contentKey)))
        : null,
    features: [...counts].sort(([a], [b]) => a.localeCompare(b)),
    unresolved: sortedUnique([...unresolved, ...parts.flatMap((part) => part.unresolved)]),
  };
}
