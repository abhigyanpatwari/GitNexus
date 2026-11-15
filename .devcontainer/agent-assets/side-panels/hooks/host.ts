import type { AgentRow, BusEntry, ReviewRun, WorkList, Worktree } from '../types';

export type FileEntry = {
  name: string;
  kind: 'file' | 'dir' | 'other';
  size: number;
  mtimeMs: number;
};

export type PaneId = 'worktrees' | 'work' | 'agents' | 'activity';

/**
 * Everything the mod asks of the engine, bound from `$` by `hostOf` in
 * register.tsx. The other modules take a Host and never see `$`.
 */
export type Host = {
  /** Runs git; resolves its stdout, or undefined when it fails. */
  git: (args: string[], cwd?: string) => Promise<string | undefined>;
  /** Calls a claude-mem MCP tool; resolves its text, rejects on an error result. */
  mem: (tool: string, args: Record<string, unknown>) => Promise<string>;
  agents: () => Promise<AgentRow[]>;
  /** The ids of this mod's panes a surface draws now. */
  placed: () => Promise<ReadonlySet<string>>;
  isBoardOn: () => Promise<boolean>;
  /** The claude-mem work-state list this session's board is relayed to. */
  boardList: () => Promise<string>;
  bus: () => Promise<readonly BusEntry[]>;
  /** Whether this session has relayed anything to the claude-mem board list. */
  relayed: () => Promise<boolean>;
  /** The review run as last read, for telling which legs finished since. */
  run: () => Promise<ReviewRun | null>;
  /** A folder's entries; none when it is missing. */
  ls: (path: string) => Promise<FileEntry[]>;
  /** A file's text; '' when it is missing. */
  cat: (path: string) => Promise<string>;
  put: {
    worktrees: (list: Worktree[]) => Promise<unknown>;
    work: (lists: WorkList[]) => Promise<unknown>;
    agents: (list: AgentRow[]) => Promise<unknown>;
    changed: (lines: string[]) => Promise<unknown>;
    /** Adds the entry unless one with its key is already there; resolves whether it was added. */
    bus: (entry: BusEntry) => Promise<boolean>;
    relayed: () => Promise<unknown>;
    run: (run: ReviewRun | null) => Promise<unknown>;
    note: (pane: PaneId, text: string) => Promise<unknown>;
  };
};
