import type { Lane, ReviewRun } from '../types';
import type { Host } from './host';

// ponytail: pr-tri-review's fixed artifact root and file names, and only the
// newest run is shown. Make the root a userConfig option when another skill
// writes its lanes elsewhere; list every live run when two reviews overlap.
const ROOT = '/tmp/pr-tri-review';
const RUN = /^\d{8}-\d{6}-[0-9a-f]+$/;
const LANE = /^(claude-.+|codex-.+|digest-draft|critic)\.md$/;
const MINUTE = 60_000;
// A PR folder is looked into while a run was started in it this recently.
const PR_FOLDER_WINDOW = 24 * 60 * MINUTE;
// A run is shown while one of its lanes was written this recently.
const ACTIVE_WINDOW = 6 * 60 * MINUTE;
// A Codex log written this recently has its last status line read.
const STATUS_LINE_WINDOW = 5 * MINUTE;
// A leg with no exit marker counts as running for this long after its last write,
// or after its empty file was created.
const RUNNING_WINDOW = 2 * MINUTE;
const EMPTY_RUNNING_WINDOW = 60 * MINUTE;

const lastStatus = (text: string) =>
  (
    text
      .trimEnd()
      .split('\n')
      .findLast((line) => line.startsWith('[codex] '))
      ?.slice(8) ?? ''
  ).slice(0, 120);

/**
 * The newest review run under the artifact root with a lane written inside
 * ACTIVE_WINDOW, each lane with its size, age and exit marker; null with none.
 */
export const readRun = async (host: Host, now: number): Promise<ReviewRun | null> => {
  const prs = (await host.ls(ROOT)).filter(
    (one) => one.kind === 'dir' && now - one.mtimeMs < PR_FOLDER_WINDOW,
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
  runs.sort((a, b) => startOf(b.id).localeCompare(startOf(a.id)) || b.mtimeMs - a.mtimeMs);
  // ponytail: looks at the five newest runs. An active run older than five later ones is not shown.
  for (const run of runs.slice(0, 5)) {
    const lanes = await lanesOf(host, run.dir, now);
    if (lanes.some((lane) => lane.ageMs <= ACTIVE_WINDOW)) {
      return { dir: run.dir.slice(ROOT.length + 1), lanes };
    }
  }

  return null;
};

/** A run folder's lane artifacts, each with its size, age, exit marker and last status line. */
async function lanesOf(host: Host, dir: string, now: number): Promise<Lane[]> {
  const files = await host.ls(dir);

  return Promise.all(
    files
      .filter((one) => LANE.test(one.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (file): Promise<Lane> => {
        const name = file.name.replace(/\.md$/, '');
        const ageMs = Math.max(0, now - file.mtimeMs);
        const exit = files.some((one) => one.name === `${name}.exit`)
          ? Number.parseInt(await host.cat(`${dir}/${name}.exit`), 10)
          : Number.NaN;
        const isLive =
          name.startsWith('codex-') && Number.isNaN(exit) && ageMs < STATUS_LINE_WINDOW;

        return {
          name,
          bytes: file.size,
          ageMs,
          exit: Number.isNaN(exit) ? null : exit,
          last: isLive ? lastStatus(await host.cat(`${dir}/${file.name}`)) : '',
        };
      }),
  );
}

export const sizeOf = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;

/** A lane's state in words; a finished leg that wrote almost nothing is said so. */
export const statusOf = (lane: Lane) => {
  if (lane.exit !== null) {
    if (lane.exit !== 0) return `failed, exit ${lane.exit}`;

    return lane.bytes < 400 ? 'done, but nearly empty' : 'done';
  }
  // A leg whose output is a redirect is an empty file until its command ends.
  if (lane.bytes === 0)
    return lane.ageMs < EMPTY_RUNNING_WINDOW ? 'running, no output yet' : 'empty';
  if (!lane.name.startsWith('codex-')) return 'written';

  return lane.ageMs < RUNNING_WINDOW ? 'running' : `quiet ${Math.round(lane.ageMs / MINUTE)}m`;
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
