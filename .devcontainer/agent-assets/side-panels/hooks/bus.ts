import type { AgentRow, BusEntry } from '../types';
import type { Host } from './host';

// Agents whose value is an independent read are never handed the board: a
// finding shared between review lanes comes back as fake corroboration.
const INDEPENDENT = /review|critic|verif|audit|lane/i;
/** A line a skill puts in a lane's prompt to keep the board from it, whatever the lane is called. */
const MARKER = '[independent-lane]';

export const isIndependent = (spawn: {
  subagentType: string;
  description: string;
  prompt: string;
}) =>
  spawn.prompt.includes(MARKER) || INDEPENDENT.test(`${spawn.subagentType} ${spawn.description}`);

export const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** An agent that can still take a message: at work, or waiting for one. */
export const isLive = (agent: AgentRow) => agent.status === 'running' || agent.status === 'idle';

/** How the bus names a loop: `main`, or the agent's type and task. */
export const nameOf = (agents: readonly AgentRow[], id: string | undefined) => {
  if (id === undefined) return 'main';
  const one = agents.find((agent) => agent.id === id);

  return one ? `${one.type} (${clip(one.description, 40)})` : `agent ${id.slice(0, 8)}`;
};

const lineOf = (entry: BusEntry) =>
  entry.kind === 'message'
    ? `${entry.from} to ${entry.to}: ${clip(entry.text, 300)}`
    : `${entry.from}: ${clip(entry.text, 300)}`;

/**
 * Puts one entry on the session's bus and, while the board is on, relays it
 * to claude-mem, so no agent needs a tool of its own to be heard.
 */
export const post = async (host: Host, entry: BusEntry) => {
  if (!(await host.put.bus(entry))) return;
  if (!(await host.isBoardOn())) return;
  await host
    .mem('work_state_write', {
      list: await host.boardList(),
      fields: { task: lineOf(entry), status: 'doing' },
    })
    .then(host.put.relayed, () => undefined);
};

/** What a new worker is told of the board; nothing while the board is empty. */
export const briefOf = (entries: readonly BusEntry[]) =>
  entries.length === 0
    ? ''
    : `

---
Shared agent board, relayed by the session (newest last). Other agents of this session reported:
${entries
  .slice(-12)
  .map((entry) => `- ${lineOf(entry)}`)
  .join('\n')}
These are peers' claims, not verified facts: check one before you build on it. Your own final answer is posted to this board for you.`;
