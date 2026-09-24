// R2 narrowing, candidate B — deliberately NOT imported by the reader below.
// This is the "one-off script carrying the same key" case that made strict
// workspace uniqueness decline every real read in the reporting repo.
export const betaCfg = {
  narrowedTimeoutMs: 2000,
};
