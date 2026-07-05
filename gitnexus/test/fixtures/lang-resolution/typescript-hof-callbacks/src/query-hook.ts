import { fetchData } from './helpers';

// Stand-in for TanStack Query's `useQuery` — accepts a config object.
// Defined in-fixture (rather than imported from an external lib) so the
// `useQuery` reference resolves to a real graph node and we can also
// assert the `useFeature → useQuery` edge.
export const useQuery = <T>(opts: { queryFn: () => T; queryKey: readonly string[] }): T => {
  return opts.queryFn();
};

// Pattern: call inside `queryFn` callback passed to a HOF.
// Mirrors `clients/*/src/hooks/use-gateway-queries.ts` from the bug
// report (4% capture rate). `useFeature → fetchData` should be reachable.
export const useFeature = (): string =>
  useQuery({
    queryFn: () => fetchData(),
    queryKey: ['feature'],
  });
