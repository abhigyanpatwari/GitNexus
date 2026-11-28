/**
 * Chat history per server and repository that survives page reloads (#432).
 *
 * Stored in sessionStorage, like the LLM provider settings
 * (`settings-service.ts`) and the deploy token (`AUTH_TOKEN_STORAGE_KEY`): a
 * reload restores the conversation, but closing the tab does not leave code
 * excerpts from it on disk. It also keeps the history's lifetime in step with
 * the API key the agent needs to continue it.
 *
 * Every function here fails soft: if storage is unavailable, full or holds
 * something unreadable, chat keeps working in memory exactly as before.
 */
import type { ChatMessage } from './types';

export const CHAT_HISTORY_STORAGE_PREFIX = 'gitnexus-chat-history:v1:';
export const MAX_STORED_CHAT_MESSAGES = 50;

const ROLES: ReadonlySet<string> = new Set(['user', 'assistant', 'tool']);

const storageKey = (repoKey: string): string => `${CHAT_HISTORY_STORAGE_PREFIX}${repoKey}`;

/**
 * `serverUrl` reduced to origin plus base path, so spellings of one server
 * (`HTTP://Host:80/`, `http://host`) share a key and credentials never enter
 * it. A relative same-origin base resolves against the page.
 */
const serverIdentity = (serverUrl: string): string => {
  const trimmed = serverUrl.trim();
  try {
    const base = typeof location === 'undefined' ? undefined : location.href;
    const url = new URL(trimmed, base);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
};

/**
 * The key a conversation is saved under: the server it came from plus the
 * repo's identity on that server (its path, or its name when the server
 * reports no path). Two servers can each report a repo at the same path, so
 * the repo alone is not enough: one server's code excerpts would show up in,
 * and be replayed to the agent of, the other's chat. Empty when either part
 * is missing, which loads and saves nothing.
 */
export const chatHistoryKey = (serverUrl: string, repoIdentity: string): string =>
  serverUrl && repoIdentity ? JSON.stringify([serverIdentity(serverUrl), repoIdentity]) : '';

const getStorage = (): Storage | null => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // Some browsers throw on access when site data is blocked.
    return null;
  }
};

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `value` if it is an array whose every item passes `isItem`, else undefined. */
const arrayOf = (value: unknown, isItem: (item: Fields) => boolean): unknown[] | undefined =>
  Array.isArray(value) && value.every((item) => isObject(item) && isItem(item)) ? value : undefined;

const isStep = (s: Fields) => typeof s.id === 'string' && typeof s.type === 'string';
const isToolCall = (t: Fields) =>
  typeof t.id === 'string' && typeof t.name === 'string' && typeof t.status === 'string';
// Matches AgentHistoryMessage: only assistant turns and tool results, and a
// tool result must name the call it answers. The agent replays any other role
// as an assistant message, so anything else is rejected rather than replayed.
const isHistoryMessage = (h: Fields) =>
  typeof h.content === 'string' &&
  (h.role === 'assistant' || (h.role === 'tool' && typeof h.toolCallId === 'string'));

/**
 * A stored entry as a ChatMessage, or null if its required fields are
 * missing. The optional `steps`, `toolCalls` and `historyMessages` are kept
 * only when they are arrays of the right shape: the chat panel maps over them
 * and the agent replays `historyMessages`, so a malformed one is dropped
 * rather than allowed to break rendering or the next turn.
 */
const toChatMessage = (value: unknown): ChatMessage | null => {
  if (!isObject(value)) return null;
  const { id, role, content, timestamp } = value;
  if (
    typeof id !== 'string' ||
    typeof role !== 'string' ||
    !ROLES.has(role) ||
    typeof content !== 'string' ||
    typeof timestamp !== 'number'
  ) {
    return null;
  }
  const message: ChatMessage = {
    id,
    role: role as ChatMessage['role'],
    content,
    timestamp,
  };
  const steps = arrayOf(value.steps, isStep);
  if (steps) message.steps = steps as ChatMessage['steps'];
  const toolCalls = arrayOf(value.toolCalls, isToolCall);
  if (toolCalls) message.toolCalls = toolCalls as ChatMessage['toolCalls'];
  const historyMessages = arrayOf(value.historyMessages, isHistoryMessage);
  if (historyMessages) message.historyMessages = historyMessages as ChatMessage['historyMessages'];
  if (typeof value.toolCallId === 'string') message.toolCallId = value.toolCallId;
  return message;
};

/**
 * The newest `limit` messages, starting at a user message, so a trimmed
 * transcript never opens with an assistant reply or tool result whose
 * question was cut away.
 */
export const trimChatHistory = (
  messages: readonly ChatMessage[],
  limit: number = MAX_STORED_CHAT_MESSAGES,
): ChatMessage[] => {
  if (limit <= 0) return [];
  const tail = messages.slice(-limit);
  const firstUser = tail.findIndex((m) => m.role === 'user');
  return firstUser === -1 ? [] : tail.slice(firstUser);
};

export const loadChatHistory = (repoKey: string): ChatMessage[] => {
  const storage = getStorage();
  if (!storage || !repoKey) return [];
  try {
    const raw = storage.getItem(storageKey(repoKey));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const messages = parsed.map(toChatMessage).filter((m): m is ChatMessage => m !== null);
    return trimChatHistory(messages);
  } catch {
    return [];
  }
};

/**
 * Store the newest messages for `repoKey`. An empty list removes the entry.
 *
 * If the write is refused (usually the storage quota), the oldest whole turns
 * are dropped one at a time until it fits. If not even the newest turn fits,
 * the entry saved last time is left as it is: a reload then shows the
 * conversation up to that point rather than losing all of it.
 */
export const saveChatHistory = (repoKey: string, messages: readonly ChatMessage[]): void => {
  const storage = getStorage();
  if (!storage || !repoKey) return;
  const key = storageKey(repoKey);
  const toStore = trimChatHistory(messages);
  if (toStore.length === 0) {
    try {
      storage.removeItem(key);
    } catch {
      // Storage unavailable: nothing was stored, so nothing is left behind.
    }
    return;
  }
  // trimChatHistory starts at a user message, so each turn starts at one.
  const turnStarts = toStore.flatMap((m, i) => (m.role === 'user' ? [i] : []));
  for (const start of turnStarts) {
    try {
      storage.setItem(key, JSON.stringify(start === 0 ? toStore : toStore.slice(start)));
      return;
    } catch {
      // Too big (or storage refused it): try again without the oldest turn.
    }
  }
};
