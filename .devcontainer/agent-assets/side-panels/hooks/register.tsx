import { atom, read, update } from 'claude-code';
import type { EngineInterface, McpToolResult, Register } from 'claude-code';

import type { Call } from '../types';
import { briefOf, clip, isIndependent, isLive, nameOf, post } from './bus';
import type { Host, PaneId } from './host';
import { refresh } from './read';
import { activityView, agentsView, workView, worktreesView } from './views';

const MEM = 'plugin:claude-mem:mcp-search';
const PANES = [
  { id: 'worktrees', title: 'Worktrees' },
  { id: 'work', title: 'Work state' },
  { id: 'agents', title: 'Agents' },
  { id: 'activity', title: 'Activity' },
] as const;

const worktrees = atom({ plugin: 'side-panels', key: 'worktrees' } as const, [], {
  shape: 'worktrees-1',
});
const work = atom({ plugin: 'side-panels', key: 'work' } as const, [], { shape: 'work-1' });
const calls = atom({ plugin: 'side-panels', key: 'calls' } as const, [], { shape: 'calls-1' });
const agents = atom({ plugin: 'side-panels', key: 'agents' } as const, [], { shape: 'agents-1' });
const changed = atom({ plugin: 'side-panels', key: 'changed' } as const, [], {
  shape: 'changed-1',
});
const bus = atom({ plugin: 'side-panels', key: 'bus' } as const, [], { shape: 'bus-1' });
const run = atom({ plugin: 'side-panels', key: 'run' } as const, null, { shape: 'run-1' });
const relayed = atom({ plugin: 'side-panels', key: 'relayed' } as const, false, {
  shape: 'relayed-1',
});
const target = atom({ plugin: 'side-panels', key: 'target' } as const, '', { shape: 'target-1' });
const notes = atom({ plugin: 'side-panels', key: 'notes' } as const, {}, { shape: 'notes-1' });

/** A pane's note: when it was last read, or why that failed. */
const noteOf = (all: Record<string, string>, pane: PaneId) => all[pane] ?? 'not read yet';

const textOf = (answer: McpToolResult) => {
  const text = answer.content.map((block) => block.text ?? '').join('\n');
  if (answer.isError) throw new Error(text.slice(0, 160));

  return text;
};

/**
 * Binds a Host from `$`. Declared in this file, each member spelled
 * `$.noun.event(...)`, so the engine reads what the module calls off its source.
 */
function hostOf($: EngineInterface): Host {
  return {
    git: async (args, cwd) => {
      const ran = await $.process
        .run(['git', ...args], { ...(cwd === undefined ? {} : { cwd }), timeoutMs: 20_000 })
        .catch(() => undefined);

      return ran?.exitCode === 0 ? ran.stdout : undefined;
    },
    mem: async (tool, args) => textOf(await $.mcp.call(MEM, tool, args)),
    agents: async () =>
      (await $.agent.list()).map((one) => ({
        id: one.id,
        type: one.type,
        description: one.description,
        status: one.status,
      })),
    placed: async () =>
      new Set((await $.ui.panes()).filter((pane) => pane.isPlaced).map((pane) => pane.id)),
    // SIDE_PANELS_BOARD=off in a process's environment keeps the board off there,
    // whatever the stored switch says: how a skill launches an independent leg.
    isBoardOn: async () =>
      (await $.env.get('SIDE_PANELS_BOARD')) !== 'off' && (await $.store.get('board')) === true,
    boardList: async () => `board-${(await $.session.id()).slice(0, 8)}`,
    bus: () => read($, bus),
    relayed: () => read($, relayed),
    run: () => read($, run),
    ls: (path) => $.fs.list(path).catch(() => []),
    cat: (path) => $.fs.read(path).catch(() => ''),
    put: {
      worktrees: (list) => update($, worktrees, () => list),
      work: (lists) => update($, work, () => lists),
      agents: (list) => update($, agents, () => list),
      changed: (lines) => update($, changed, () => lines),
      bus: async (entry) => {
        // Decided inside the write, so two reports of one event racing each other add one entry.
        let isNew = false;
        await update($, bus, (list) => {
          isNew = entry.key === undefined || !list.some((one) => one.key === entry.key);

          return isNew ? [...list, entry].slice(-100) : list;
        });

        return isNew;
      },
      relayed: () => update($, relayed, () => true),
      run: (next) => update($, run, () => next),
      note: (pane, text) => update($, notes, (all) => ({ ...all, [pane]: text })),
    },
  };
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'panels',
      description: 'Show or hide the side panels: worktrees, work state, agents, activity',
      argumentHint: '[refresh | board on | board off]',
    });
    // A headless session (`-p`, the SDK) has no surface to open a pane on.
    if (e.isInteractive && (await $.store.get('auto')) === true) {
      await Promise.all(PANES.map((pane) => $.ui.open(pane)));
      void refresh(hostOf($), []);
    }
    // A Codex leg ends no turn of this session, so the Agents pane reads on a clock too.
    if (e.isInteractive) $.clock.every(30_000, () => void refresh(hostOf($), ['agents']));

    return next(e);
  });

  on('command.run', { command: 'panels' }, async ($, e) => {
    const host = hostOf($);
    const args = e.args.trim();
    if (args === 'board on' || args === 'board off') {
      await $.store.set('board', args === 'board on');
      void $.ui.invalidate('ui.render');

      return {
        text:
          args === 'board on'
            ? `Agent board on: agents' results and messages are relayed to the claude-mem list ${await host.boardList()} and handed to new workers, review lanes excepted.`
            : 'Agent board off: results and messages stay in the Agents pane.',
      };
    }
    if (args !== '' && args !== 'refresh') {
      return { text: 'Usage: /panels [refresh | board on | board off]' };
    }
    // Only this mod's panes: `/panels` must never close a pane another plugin opened.
    const open = (await $.ui.panes()).filter((pane) => PANES.some((own) => own.id === pane.id));
    if (args === '' && open.length > 0) {
      for (const pane of open) await $.ui.close({ id: pane.id });
      await $.store.set('auto', false);

      return { text: 'Side panels closed.' };
    }
    const placed = await Promise.all(PANES.map((pane) => $.ui.open(pane)));
    await $.store.set('auto', e.presentation.isFullscreen);
    void refresh(host, []);
    const waiting = placed.find((one) => !one.isPlaced);
    if (waiting !== undefined && !waiting.isPlaced)
      return { text: `Side panels wait: ${waiting.reason}` };

    return {
      text: e.presentation.isFullscreen
        ? 'Side panels docked beside the transcript.'
        : 'Side panels opened above the prompt: the dock needs the fullscreen layout.',
    };
  });

  on('tool.call', async ($, e, next) => {
    const call: Call = {
      id: e.tool_use_id,
      tool: String(e.tool),
      isAgent: e.agentId !== undefined,
      isDone: false,
    };
    await update($, calls, (list) => [...list, call].slice(-40));
    try {
      return await next(e);
    } finally {
      await update($, calls, (list) =>
        list.map((one) => (one.id === call.id ? { ...one, isDone: true } : one)),
      );
    }
  });

  // A worker starts knowing what the others reported; a review lane never does.
  on('agent.spawn', async ($, e, next) => {
    const host = hostOf($);
    if (!(await host.isBoardOn()) || isIndependent(e)) return next(e);

    return next({ ...e, prompt: e.prompt + briefOf(await host.bus()) });
  });

  // A subagent's final answer goes on the bus for it: no agent needs a tool to be heard.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e);
    const host = hostOf($);
    if (e.agentId !== undefined && !e.isAborted && e.answer.trim() !== '') {
      await post(host, {
        at: Date.now(),
        kind: 'result',
        from: nameOf(await host.agents(), e.agentId),
        to: 'main',
        text: clip(e.answer, 600),
        key: `result:${e.agentId}:${e.turnId}`,
      });
    }
    void refresh(host, e.agentId === undefined ? [] : ['agents', 'activity']);

    return done;
  });

  // Every message one agent sends another (the SendMessage tool) is logged as it goes.
  on('session.send', async ($, e, next) => {
    const sent = await next(e);
    // What did not arrive is no message on the bus, and is not relayed.
    if (!sent.isDelivered) return sent;
    const host = hostOf($);
    const known = await host.agents();
    // The pane's own send arrives here too, as this plugin's: that one is the person's.
    const isPersons = e.origin.kind === 'plugin' && e.origin.name === $.plugin.name;
    await post(host, {
      at: Date.now(),
      kind: 'message',
      from: isPersons ? 'you' : nameOf(known, e.agentId),
      to: known.some((one) => one.id === e.to) ? nameOf(known, e.to) : e.to,
      text: clip(e.text, 600),
    });

    return sent;
  });

  on('session.end', async ($, e, next) => {
    // An open list is shown at every later session's start: close the board this
    // session relayed to, also when the board was switched off afterwards.
    const host = hostOf($);
    if (await host.relayed()) {
      await host
        .mem('work_state_write', { list: await host.boardList(), fields: { status: 'done' } })
        .catch(() => undefined);
    }

    return next(e);
  });

  on('ui.render', { component: 'Pane', requestId: 'worktrees' }, async ($, e) => {
    const host = hostOf($);
    const [list, all] = await Promise.all([read($, worktrees), read($, notes)]);

    return worktreesView(
      $.ui.resolve(e),
      { list, note: noteOf(all, 'worktrees') },
      { refresh: () => refresh(host, ['worktrees']) },
    );
  });

  on('ui.render', { component: 'Pane', requestId: 'work' }, async ($, e) => {
    const host = hostOf($);
    const [lists, all] = await Promise.all([read($, work), read($, notes)]);

    return workView(
      $.ui.resolve(e),
      { lists, note: noteOf(all, 'work') },
      { refresh: () => refresh(host, ['work']) },
    );
  });

  on('ui.render', { component: 'Pane', requestId: 'agents' }, async ($, e) => {
    const host = hostOf($);
    const [list, isBoardOn, picked, entries, shownRun, all] = await Promise.all([
      read($, agents),
      host.isBoardOn(),
      read($, target),
      read($, bus),
      read($, run),
      read($, notes),
    ]);
    const running = list.filter(isLive);
    // The agent a message goes to: the one picked while it still runs, else the first running.
    const chosen = running.some((one) => one.id === picked) ? picked : (running[0]?.id ?? '');

    return agentsView(
      $.ui.resolve(e),
      {
        agents: list,
        entries,
        target: chosen,
        run: shownRun,
        isBoardOn,
        note: noteOf(all, 'agents'),
      },
      {
        refresh: () => refresh(host, ['agents']),
        toggleBoard: async () => {
          await $.store.set('board', !isBoardOn);
          await $.ui.invalidate('ui.render');
        },
        view: (agentId) => $.ui.view(agentId === undefined ? {} : { agentId }),
        pick: (agentId) => update($, target, () => agentId),
        say: async (text) => {
          if (chosen === '' || text.trim() === '') return;
          // A delivered message is logged by the `session.send` hook above as it goes.
          const sent = await $.session.send({ to: { agentId: chosen }, text });
          if (!sent.isDelivered) $.ui.toast(`Not delivered: ${sent.reason}`);
        },
      },
    );
  });

  on('ui.render', { component: 'Pane', requestId: 'activity' }, async ($, e) => {
    const host = hostOf($);
    const [recent, files, all] = await Promise.all([
      read($, calls),
      read($, changed),
      read($, notes),
    ]);

    return activityView(
      $.ui.resolve(e),
      { calls: recent, changed: files, note: noteOf(all, 'activity') },
      { refresh: () => refresh(host, ['activity']) },
    );
  });
};
