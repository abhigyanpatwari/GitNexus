export type Worktree = {
  path: string
  branch: string
  /** Changed files; null when `git status` could not be read there. */
  dirty: number | null
  ahead: number | null
  isPrunable: boolean
}
export type WorkItem = { status: string; task: string; next: string; updated: string }
export type WorkList = { name: string; items: WorkItem[] }
export type Call = { id: string; tool: string; isAgent: boolean; isDone: boolean }
export type AgentRow = { id: string; type: string; description: string; status: string }
/** One line of the agent bus: a subagent's final answer, or a message between agents. */
export type BusEntry = {
  at: number
  kind: 'result' | 'message'
  from: string
  to: string
  text: string
  /**
   * Names the one event an entry records, where it has one, so a second report
   * of it is not a second entry. A message has none: the same words sent twice
   * are two messages.
   */
  key?: string
}

/** One lane artifact of a review run: a Claude lane's file, or a Codex leg's growing log. */
export type Lane = {
  name: string
  bytes: number
  ageMs: number
  /** The leg's exit code from its `.exit` marker; null while none is written. */
  exit: number | null
  /** A running Codex leg's last status line. */
  last: string
}
export type ReviewRun = { dir: string; lanes: Lane[] }

declare module 'claude-code' {
  interface PluginState {
    'side-panels': {
      worktrees: Shaped<Worktree[]>
      work: Shaped<WorkList[]>
      calls: Shaped<Call[]>
      agents: Shaped<AgentRow[]>
      changed: Shaped<string[]>
      bus: Shaped<BusEntry[]>
      target: Shaped<string>
      relayed: Shaped<boolean>
      run: Shaped<ReviewRun | null>
      notes: Shaped<Record<string, string>>
    }
  }
}
