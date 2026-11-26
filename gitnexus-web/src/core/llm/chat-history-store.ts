/**
 * Per-repository chat history that survives page reloads (#432).
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

const getStorage = (): Storage | null => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // Some browsers throw on access when site data is blocked.
    return null;
  }
};

const isChatMessage = (value: unknown): value is ChatMessage => {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    typeof m.role === 'string' &&
    ROLES.has(m.role) &&
    typeof m.content === 'string' &&
    typeof m.timestamp === 'number'
  );
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
    return trimChatHistory(parsed.filter(isChatMessage));
  } catch {
    return [];
  }
};

/**
 * Store the newest messages for `repoKey`. An empty list removes the entry.
 * If the write is refused (usually the storage quota), the oldest half is
 * dropped and the write retried until it fits or nothing is left.
 */
export const saveChatHistory = (repoKey: string, messages: readonly ChatMessage[]): void => {
  const storage = getStorage();
  if (!storage || !repoKey) return;
  const key = storageKey(repoKey);
  let toStore = trimChatHistory(messages);
  while (toStore.length > 0) {
    try {
      storage.setItem(key, JSON.stringify(toStore));
      return;
    } catch {
      toStore = trimChatHistory(toStore, Math.floor(toStore.length / 2));
    }
  }
  try {
    storage.removeItem(key);
  } catch {
    // Storage unavailable: nothing was stored, so nothing is left behind.
  }
};
