import type { Lane, ReviewRun } from '../types';
import type { Host } from './host';

// ponytail: pr-tri-review's fixed artifact root and file names, and only the
// newest run is shown. Make the root a userConfig option when another skill
// writes its lanes elsewhere; list every live run when two reviews overlap.
const ROOT = '/tmp/pr-tri-review';
const RUN = /^\d{8}-\d{6}-[0-9a-f]+$/;
const LANE = /^(claude-.+|codex-.+|digest-draft|critic)\.md$/;
const MINUTE = 60_000;

const lastStatus = (text: string) =>
  (
    text
      .trimEnd()
      .split('\n')
      .findLast((line) => line.startsWith('[codex] '))
      ?.slice(8) ?? ''
  ).slice(0, 120);

/**
 * The newest review run under the artifact root with a lane written in the
 * last six hours, each lane with its size, age and exit marker; null with none.
 */
export const readRun = async (host: Host, now: number): Promise<ReviewRun | null> => {
  const prs = (await host.ls(ROOT)).filter(
    (one) => one.kind === 'dir' && now - one.mtimeMs < 24 * 60 * MINUTE,
  );
  const runs = (
    await Promise.all(
      prs.map(async (pr) =>
        (await host.ls(`${ROOT}/${pr.name}`))
          .filter((one) => one.kind === 'dir' && RUN.test(one.name))
          .map((one) => ({
            id: one.name,
            dir: `${ROOT}/${pr.name}/${one.name}`,
            mtimeMs: one.mtimeMs,
          })),
      ),
    )
  ).flat();
  // A run id is its start time to the second and then a random suffix: the
  // latest start is the newest run, and runs of one second go by folder time.
  const startOf = (id: string) => id.slice(0, 15);
  const newest = runs.sort(
    (a, b) => startOf(b.id).localeCompare(startOf(a.id)) || b.mtimeMs - a.mtimeMs,
  )[0];
  if (newest === undefined) return null;
  const files = await host.ls(newest.dir);
  const lanes = await Promise.all(
    files
      .filter((one) => LANE.test(one.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (file): Promise<Lane> => {
        const name = file.name.replace(/\.md$/, '');
        const ageMs = Math.max(0, now - file.mtimeMs);
        const exit = files.some((one) => one.name === `${name}.exit`)
          ? Number.parseInt(await host.cat(`${newest.dir}/${name}.exit`), 10)
          : Number.NaN;
        const isLive = name.startsWith('codex-') && Number.isNaN(exit) && ageMs < 5 * MINUTE;

        return {
          name,
          bytes: file.size,
          ageMs,
          exit: Number.isNaN(exit) ? null : exit,
          last: isLive ? lastStatus(await host.cat(`${newest.dir}/${file.name}`)) : '',
        };
      }),
  );
  if (lanes.every((lane) => lane.ageMs > 6 * 60 * MINUTE)) return null;

  return { dir: newest.dir.slice(ROOT.length + 1), lanes };
};

export const sizeOf = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;

/** A lane's state in words; a finished leg that wrote almost nothing is said so. */
export const statusOf = (lane: Lane) => {
  if (lane.exit !== null) {
    if (lane.exit !== 0) return `failed, exit ${lane.exit}`;

    return lane.bytes < 400 ? 'done, but nearly empty' : 'done';
  }
  // A leg whose output is a redirect is an empty file until its command ends.
  if (lane.bytes === 0) return lane.ageMs < 60 * MINUTE ? 'running, no output yet' : 'empty';
  if (!lane.name.startsWith('codex-')) return 'written';

  return lane.ageMs < 2 * MINUTE ? 'running' : `quiet ${Math.round(lane.ageMs / MINUTE)}m`;
};

/** The lanes this read saw finish: no exit code at the last read of the same run, one now. */
export const finishedSince = (before: ReviewRun | null, after: ReviewRun | null): Lane[] =>
  before === null || after === null || before.dir !== after.dir
    ? []
    : after.lanes.filter(
        (lane) =>
          lane.exit !== null &&
          before.lanes.some((was) => was.name === lane.name && was.exit === null),
      );
