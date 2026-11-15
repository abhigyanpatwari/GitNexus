import { atom, read, update } from 'claude-code';
import type { EngineInterface, McpToolResult, Register } from 'claude-code';

import type { Call } from '../types';
import { briefOf, clip, isIndependent, nameOf, post } from './bus';
import type { Host } from './host';
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
const target = atom({ plugin: 'side-panels', key: 'target' } as const, '', { shape: 'target-1' });
const notes = atom({ plugin: 'side-panels', key: 'notes' } as const, {}, { shape: 'notes-1' });

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

      return ran?.exitCode === 0 ? ran.stdout : '';
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
    run: () => read($, run),
    ls: (path) => $.fs.list(path).catch(() => []),
    cat: (path) => $.fs.read(path).catch(() => ''),
    put: {
      worktrees: (list) => update($, worktrees, () => list),
      work: (lists) => update($, work, () => lists),
      agents: (list) => update($, agents, () => list),
      changed: (lines) => update($, changed, () => lines),
      bus: (entry) => update($, bus, (list) => [...list, entry].slice(-100)),
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
    const open = await $.ui.panes();
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
      });
    }
    void refresh(host, e.agentId === undefined ? [] : ['agents', 'activity']);

    return done;
  });

  // Every message one agent sends another (the SendMessage tool) is logged as it goes.
  on('session.send', async ($, e, next) => {
    const sent = await next(e);
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
    // An open list is shown at every later session's start: close a used board.
    const host = hostOf($);
    if ((await host.isBoardOn()) && (await host.bus()).length > 0) {
      await host
        .mem('work_state_write', { list: await host.boardList(), fields: { status: 'done' } })
        .catch(() => undefined);
    }

    return next(e);
  });

  on('ui.render', { component: 'Pane', requestId: 'worktrees' }, async ($, e) => {
    const host = hostOf($);
    const note = (await read($, notes))['worktrees'] ?? 'not read yet';

    return worktreesView(
      $.ui.resolve(e),
      { list: await read($, worktrees), note },
      { refresh: () => refresh(host, ['worktrees']) },
    );
  });

  on('ui.render', { component: 'Pane', requestId: 'work' }, async ($, e) => {
    const host = hostOf($);
    const note = (await read($, notes))['work'] ?? 'not read yet';

    return workView(
      $.ui.resolve(e),
      { lists: await read($, work), note },
      { refresh: () => refresh(host, ['work']) },
    );
  });

  on('ui.render', { component: 'Pane', requestId: 'agents' }, async ($, e) => {
    const host = hostOf($);
    const list = await read($, agents);
    const isBoardOn = await host.isBoardOn();
    const running = list.filter((one) => one.status === 'running' || one.status === 'idle');
    const picked = await read($, target);
    // The agent a message goes to: the one picked while it still runs, else the first running.
    const chosen = running.some((one) => one.id === picked) ? picked : (running[0]?.id ?? '');

    return agentsView(
      $.ui.resolve(e),
      {
        agents: list,
        entries: await read($, bus),
        target: chosen,
        run: await read($, run),
        isBoardOn,
        note: (await read($, notes))['agents'] ?? 'not read yet',
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

    return activityView(
      $.ui.resolve(e),
      {
        calls: await read($, calls),
        changed: await read($, changed),
        note: (await read($, notes))['activity'] ?? 'not read yet',
      },
      { refresh: () => refresh(host, ['activity']) },
    );
  });
};
