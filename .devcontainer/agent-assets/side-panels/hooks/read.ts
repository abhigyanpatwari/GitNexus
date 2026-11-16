import type { WorkList, Worktree } from '../types';
import { post } from './bus';
import type { Host, PaneId } from './host';
import { finishedSince, readRun, sizeOf, statusOf } from './review';

const field = (fields: string, key: string) =>
  new RegExp(`(?:^|, )${key}=(.*?)(?=, \\w+=|$)`).exec(fields)?.[1] ?? '';

// ponytail: reads claude-mem's folded text, not its export. A value holding
// ", word=" cuts early and a list line claude-mem shortened is skipped; fold
// GET /api/work-state/export instead if either starts to matter.
export const parseWork = (text: string): WorkList[] => {
  const lists: WorkList[] = [];
  for (const line of text.split('\n')) {
    const item = /^ {2}- \[(\w+)\] (.*?)(?: \((\w+=.*)\))?, updated (.*)$/.exec(line);
    if (item) {
      lists.at(-1)?.items.push({
        status: item[1] ?? '',
        task: item[2] ?? '',
        next: field(item[3] ?? '', 'next'),
        updated: item[4] ?? '',
      });
      continue;
    }
    const head = /^- (\S+?)(?:: (.*), updated (.*))?$/.exec(line);
    if (!head) continue;
    const state = head[2];
    lists.push({
      name: head[1] ?? '',
      items:
        state === undefined
          ? []
          : [
              {
                status: 'state',
                task: field(state, 'phase') || state.slice(0, 80),
                next: field(state, 'next') || field(state, 'next_steps'),
                updated: head[3] ?? '',
              },
            ],
    });
  }

  return lists;
};

const linesOf = (text: string) => text.split('\n').filter(Boolean);

/** How much a worktree wants a look: gone folder, then dirty or unreadable, then unpushed. */
export const rank = (one: Worktree) =>
  (one.isPrunable ? 4 : 0) + (one.dirty !== 0 ? 2 : 0) + ((one.ahead ?? 0) > 0 ? 1 : 0);

const inspect = async (host: Host, block: string): Promise<Worktree> => {
  const path = /^worktree (.*)$/m.exec(block)?.[1] ?? '';
  const branch = /^branch refs\/heads\/(.*)$/m.exec(block)?.[1] ?? 'detached';
  if (/^prunable/m.test(block)) return { path, branch, dirty: 0, ahead: null, isPrunable: true };
  // Reading must not take the index lock from a git command the person is running.
  const status = await host.git(['--no-optional-locks', 'status', '--porcelain'], path);
  // No count comes back for a branch with no upstream: its push state is unknown, not clean.
  const ahead = (await host.git(['rev-list', '--count', '@{upstream}..HEAD'], path))?.trim();

  return {
    path,
    branch,
    dirty: status === undefined ? null : linesOf(status).length,
    ahead: ahead === undefined || ahead === '' ? null : Number(ahead),
    isPrunable: false,
  };
};

const readWorktrees = async (host: Host) => {
  const listed = await host.git(['worktree', 'list', '--porcelain']);
  if (listed === undefined) throw new Error('git worktree list failed');
  const blocks = listed.split('\n\n').filter(Boolean);
  const list: Worktree[] = [];
  // ponytail: two git calls a worktree, 8 worktrees at a time, every refresh.
  // Cache by HEAD and index mtime if a hundred worktrees start to feel slow.
  for (let at = 0; at < blocks.length; at += 8) {
    list.push(
      ...(await Promise.all(blocks.slice(at, at + 8).map((block) => inspect(host, block)))),
    );
  }

  return list.sort((a, b) => rank(b) - rank(a) || a.path.localeCompare(b.path));
};

const READ: Record<PaneId, (host: Host) => Promise<unknown>> = {
  worktrees: async (host) => host.put.worktrees(await readWorktrees(host)),
  work: async (host) => host.put.work(parseWork(await host.mem('work_state_read', {}))),
  agents: async (host) => {
    await host.put.agents(await host.agents());
    const before = await host.run();
    const after = await readRun(host, Date.now());
    await host.put.run(after);
    const dir = after?.dir ?? '';
    // A Codex leg is no subagent: its finish reaches the bus from its exit marker.
    for (const lane of finishedSince(before, after)) {
      await post(host, {
        at: Date.now(),
        kind: 'result',
        from: `${lane.name} (review run)`,
        to: 'main',
        text: `${statusOf(lane)}, ${sizeOf(lane.bytes)}, in ${dir}`,
        key: `lane:${dir}/${lane.name}`,
      });
    }
  },
  activity: async (host) => {
    const status = await host.git(['--no-optional-locks', 'status', '--short']);
    if (status === undefined) throw new Error('git status failed');
    await host.put.changed(linesOf(status));
  },
};

/**
 * Reads the panes asked for (none named: all of them) that a surface draws
 * now, and leaves each one's note: when it was read, or why it failed. A
 * closed or unplaced pane costs nothing.
 */
export const refresh = async (host: Host, asked: readonly PaneId[]) => {
  const placed = await host.placed();
  const due = (Object.keys(READ) as PaneId[]).filter(
    (pane) => placed.has(pane) && (asked.length === 0 || asked.includes(pane)),
  );
  await Promise.all(
    due.map((pane) =>
      READ[pane](host).then(
        () => host.put.note(pane, `at ${new Date().toISOString().slice(11, 16)} UTC`),
        (error: unknown) => host.put.note(pane, `failed: ${String(error).slice(0, 120)}`),
      ),
    ),
  );
};
