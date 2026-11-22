import type { Elements } from 'claude-code';

import type { AgentRow, BusEntry, Call, ReviewRun, WorkList, Worktree } from '../types';
import { clip, isLive } from './bus';
import { rank } from './read';
import { sizeOf, statusOf } from './review';

/** The elements every surface's table has in common that the panes draw with. */
export type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Input' | 'Select'>;

const short = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path;

function head(kit: Kit, summary: string, onRefresh: () => unknown) {
  const { Box, Button, Text } = kit;

  return (
    <Box gap={1}>
      <Button key="refresh" plain hotkey="r" label="refresh" onPress={() => void onRefresh()} />
      <Text dimColor wrap="truncate-end">
        {summary}
      </Text>
    </Box>
  );
}

export function worktreesView(
  kit: Kit,
  data: { list: readonly Worktree[]; note: string },
  actions: { refresh: () => unknown },
) {
  const { Box, Text } = kit;
  const busy = data.list.filter((one) => rank(one) > 0);
  const quiet = data.list.filter((one) => rank(one) === 0);
  const clean = quiet.filter((one) => one.ahead !== null);
  // No upstream to compare with: nothing dirty, but whether it is pushed is not known.
  const untracked = quiet.filter((one) => one.ahead === null);
  // One dim line naming the first thirty worktrees of a group, and how many more there are.
  const named = (label: string, group: readonly Worktree[]) =>
    group.length > 0 && (
      <Text dimColor wrap="wrap">
        {label}:{' '}
        {group
          .slice(0, 30)
          .map((one) => short(one.path))
          .join(', ')}
        {group.length > 30 ? `, and ${group.length - 30} more` : ''}
      </Text>
    );

  return (
    <Box flexDirection="column">
      {head(
        kit,
        `${data.list.length} total, ${busy.length} need a look, ${data.note}`,
        actions.refresh,
      )}
      {busy.map((one) => (
        <Box flexDirection="column" marginTop={1}>
          <Text bold wrap="truncate-end">
            {short(one.path)}
          </Text>
          <Text dimColor wrap="truncate-end">
            {one.isPrunable
              ? 'prunable: its folder is gone'
              : [
                  one.branch,
                  one.dirty === null ? 'status unreadable' : '',
                  (one.dirty ?? 0) > 0 ? `${one.dirty} dirty` : '',
                  (one.ahead ?? 0) > 0 ? `${one.ahead} unpushed` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </Text>
        </Box>
      ))}
      {named('clean', clean)}
      {named('no upstream, push state unknown', untracked)}
    </Box>
  );
}

export function workView(
  kit: Kit,
  data: { lists: readonly WorkList[]; note: string },
  actions: { refresh: () => unknown },
) {
  const { Box, Text } = kit;

  return (
    <Box flexDirection="column">
      {head(kit, `${data.lists.length} open lists, ${data.note}`, actions.refresh)}
      {data.lists.slice(0, 40).map((list) => (
        <Box flexDirection="column" marginTop={1}>
          <Text bold wrap="truncate-end">
            {list.name}
          </Text>
          {list.items.map((item) => (
            <Box flexDirection="column">
              <Text wrap="wrap">
                [{item.status}] {item.task.slice(0, 120)}
              </Text>
              {item.next !== '' && (
                <Text dimColor wrap="wrap">
                  next: {item.next.slice(0, 160)}
                </Text>
              )}
              <Text dimColor wrap="truncate-end">
                {item.updated}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

export type AgentsActions = {
  refresh: () => unknown;
  toggleBoard: () => unknown;
  /** Shows an agent's transcript in the main view; no id goes back to the main conversation. */
  view: (agentId?: string) => unknown;
  pick: (agentId: string) => unknown;
  say: (text: string) => unknown;
};

export function agentsView(
  kit: Kit,
  data: {
    agents: readonly AgentRow[];
    entries: readonly BusEntry[];
    target: string;
    run: ReviewRun | null;
    isBoardOn: boolean;
    note: string;
  },
  actions: AgentsActions,
) {
  const { Box, Button, Input, Select, Text } = kit;
  const running = data.agents.filter(isLive);

  return (
    <Box flexDirection="column">
      {head(
        kit,
        `${running.length} running of ${data.agents.length}, ${data.note}`,
        actions.refresh,
      )}
      <Box gap={1}>
        <Button key="board" plain hotkey="b" onPress={() => void actions.toggleBoard()}>
          board {data.isBoardOn ? 'on' : 'off'}
        </Button>
        <Text dimColor wrap="truncate-end">
          {data.isBoardOn ? 'relayed to claude-mem and to new workers' : 'this pane only'}
        </Text>
      </Box>
      <Box marginTop={1} gap={1}>
        <Text bold>Agents</Text>
        <Button key="view-main" plain onPress={() => void actions.view()}>
          back to main
        </Button>
      </Box>
      {data.agents.length === 0 && <Text dimColor>none yet</Text>}
      {data.agents.slice(-14).map((one) => (
        <Button
          key={`view-${one.id}`}
          plain
          dimColor={!isLive(one)}
          onPress={() => void actions.view(one.id)}
        >
          {clip(`${one.status} ${one.type}: ${one.description}`, 90)}
        </Button>
      ))}
      {running.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Select
            key="target"
            label="message to"
            value={data.target}
            options={running.map((one) => ({
              value: one.id,
              label: clip(`${one.type}: ${one.description}`, 50),
            }))}
            onSelect={(value) => void actions.pick(value)}
          />
          <Input
            key="say"
            placeholder="type a message, Enter sends"
            submitLabel="send"
            onSubmit={(text) => void actions.say(text)}
          />
        </Box>
      )}
      {data.run !== null && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold wrap="truncate-end">
            Review run {data.run.dir}
          </Text>
          {data.run.lanes.map((lane) => (
            <Box flexDirection="column">
              <Text dimColor={statusOf(lane) === 'done'} wrap="truncate-end">
                {lane.name}: {statusOf(lane)}, {sizeOf(lane.bytes)}
              </Text>
              {lane.last !== '' && (
                <Text dimColor wrap="truncate-end">
                  {lane.last}
                </Text>
              )}
            </Box>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text bold>Bus ({data.entries.length})</Text>
      </Box>
      {data.entries.length === 0 && <Text dimColor>no result or message yet</Text>}
      {data.entries.slice(-12).map((entry) => (
        <Box flexDirection="column">
          <Text dimColor wrap="truncate-end">
            {entry.kind === 'message' ? `${entry.from} → ${entry.to}` : `${entry.from} finished`}
          </Text>
          <Text wrap="wrap">{clip(entry.text, 240)}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function activityView(
  kit: Kit,
  data: { calls: readonly Call[]; changed: readonly string[]; note: string },
  actions: { refresh: () => unknown },
) {
  const { Box, Text } = kit;
  const recent = data.calls.slice(-10);

  return (
    <Box flexDirection="column">
      {head(kit, data.note, actions.refresh)}
      <Text bold>Tool calls</Text>
      {recent.length === 0 && <Text dimColor>none yet</Text>}
      {recent.map((one) => (
        <Text dimColor={one.isDone} wrap="truncate-end">
          {one.isDone ? 'done' : 'runs'} {one.tool}
          {one.isAgent ? ' (subagent)' : ''}
        </Text>
      ))}
      <Box marginTop={1}>
        <Text bold>Changed files ({data.changed.length})</Text>
      </Box>
      {data.changed.slice(0, 20).map((line) => (
        <Text wrap="truncate-start">{line}</Text>
      ))}
    </Box>
  );
}
