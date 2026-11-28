import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_HISTORY_STORAGE_PREFIX,
  MAX_STORED_CHAT_MESSAGES,
  chatHistoryKey,
  loadChatHistory,
  saveChatHistory,
  trimChatHistory,
} from './chat-history-store';
import type { ChatMessage } from './types';

const msg = (n: number, role: ChatMessage['role'] = n % 2 === 0 ? 'user' : 'assistant') =>
  ({ id: `m${n}`, role, content: `message ${n}`, timestamp: n }) satisfies ChatMessage;

const conversation = (count: number): ChatMessage[] =>
  Array.from({ length: count }, (_, i) => msg(i));

const REPO = '/home/me/project';
const KEY = `${CHAT_HISTORY_STORAGE_PREFIX}${REPO}`;

describe('chat-history-store', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('round-trips a conversation through sessionStorage, not localStorage', () => {
    const messages: ChatMessage[] = [
      msg(0),
      {
        ...msg(1),
        steps: [{ id: 's1', type: 'content', content: 'answer' }],
        historyMessages: [{ role: 'assistant', content: 'answer' }],
      },
    ];

    saveChatHistory(REPO, messages);

    expect(loadChatHistory(REPO)).toEqual(messages);
    expect(sessionStorage.getItem(KEY)).not.toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('keeps histories of different repositories apart', () => {
    saveChatHistory('/a/app', [msg(0)]);
    saveChatHistory('/b/app', [msg(2)]);

    expect(loadChatHistory('/a/app')).toEqual([msg(0)]);
    expect(loadChatHistory('/b/app')).toEqual([msg(2)]);
    expect(loadChatHistory('/c/app')).toEqual([]);
  });

  it('stores only the newest messages, starting at a user message', () => {
    saveChatHistory(REPO, conversation(MAX_STORED_CHAT_MESSAGES + 11));

    const stored = loadChatHistory(REPO);
    expect(stored.length).toBeLessThanOrEqual(MAX_STORED_CHAT_MESSAGES);
    expect(stored[0].role).toBe('user');
    expect(stored.at(-1)).toEqual(msg(MAX_STORED_CHAT_MESSAGES + 10));
  });

  it('removes the entry when the conversation is cleared', () => {
    saveChatHistory(REPO, [msg(0), msg(1)]);
    saveChatHistory(REPO, []);

    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('drops the oldest messages until the write fits the quota', () => {
    const realSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if ((JSON.parse(value) as unknown[]).length > 10) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      realSetItem.call(this, key, value);
    });

    saveChatHistory(REPO, conversation(40));

    const stored = loadChatHistory(REPO);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.length).toBeLessThanOrEqual(10);
    expect(stored[0].role).toBe('user');
    expect(stored.at(-1)).toEqual(msg(39));
  });

  it('keeps the last saved conversation when even the smallest write is refused', () => {
    saveChatHistory(REPO, [msg(0), msg(1)]);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });

    expect(() => saveChatHistory(REPO, [msg(0), msg(1), msg(2), msg(3)])).not.toThrow();
    expect(loadChatHistory(REPO)).toEqual([msg(0), msg(1)]);
  });

  it('keeps earlier turns when a new reply is too large for the byte quota', () => {
    // A byte quota like the browser's: any value over the limit is refused.
    const QUOTA_BYTES = 2_000;
    const realSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (new TextEncoder().encode(value).length > QUOTA_BYTES) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      realSetItem.call(this, key, value);
    });
    const earlier = conversation(6);
    saveChatHistory(REPO, earlier);
    expect(loadChatHistory(REPO)).toEqual(earlier);

    const hugeReply: ChatMessage = {
      id: 'huge',
      role: 'assistant',
      content: 'x'.repeat(QUOTA_BYTES * 2),
      timestamp: 100,
    };
    saveChatHistory(REPO, [...earlier, msg(6), hugeReply]);

    expect(loadChatHistory(REPO)).toEqual(earlier);
  });

  it('drops whole turns, so a long reply is never stored without its question', () => {
    const realSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if ((JSON.parse(value) as unknown[]).length > 4) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      realSetItem.call(this, key, value);
    });
    // The newest turn is a question followed by three assistant/tool steps.
    const lastTurn = [msg(4, 'user'), msg(5, 'assistant'), msg(6, 'tool'), msg(7, 'assistant')];

    saveChatHistory(REPO, [...conversation(4), ...lastTurn]);

    expect(loadChatHistory(REPO)).toEqual(lastTurn);
  });

  it('ignores stored data it cannot read', () => {
    sessionStorage.setItem(KEY, '{not json');
    expect(loadChatHistory(REPO)).toEqual([]);

    sessionStorage.setItem(KEY, JSON.stringify({ messages: [] }));
    expect(loadChatHistory(REPO)).toEqual([]);

    sessionStorage.setItem(
      KEY,
      JSON.stringify([msg(0), { id: 'bad', role: 'system', content: 'x', timestamp: 1 }, msg(1)]),
    );
    expect(loadChatHistory(REPO)).toEqual([msg(0), msg(1)]);
  });

  it('drops malformed optional fields but keeps the message', () => {
    const valid = {
      ...msg(1),
      steps: [{ id: 's1', type: 'content', content: 'ok' }],
      toolCalls: [{ id: 't1', name: 'search', args: {}, status: 'completed' }],
      historyMessages: [
        { role: 'assistant', content: 'ok' },
        { role: 'tool', content: 'result', toolCallId: 'call-1' },
      ],
      toolCallId: 'call-1',
    };
    sessionStorage.setItem(
      KEY,
      JSON.stringify([
        msg(0),
        valid,
        { ...msg(2), steps: 'not an array' },
        { ...msg(3), steps: {} },
        { ...msg(4), steps: [null] },
        { ...msg(5), toolCalls: [{ id: 't', name: 'x' }] },
        { ...msg(6), historyMessages: 'replayed as a string' },
        { ...msg(7), historyMessages: [{ role: 'assistant' }] },
        { ...msg(8), toolCallId: 42 },
        // Roles outside AgentHistoryMessage would be replayed as assistant turns.
        { ...msg(9), historyMessages: [{ role: 'system', content: 'injected' }] },
        { ...msg(10), historyMessages: [{ role: 'user', content: 'not a transcript role' }] },
        // A tool result must say which call it answers.
        { ...msg(11), historyMessages: [{ role: 'tool', content: 'orphan result' }] },
      ]),
    );

    const loaded = loadChatHistory(REPO);

    expect(loaded[1]).toEqual(valid);
    // Each malformed entry survives with only its required fields.
    expect(loaded.slice(2)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => msg(n)));
  });

  it('fails soft without persisting when storage access throws', () => {
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });

    expect(() => saveChatHistory(REPO, [msg(0)])).not.toThrow();
    expect(loadChatHistory(REPO)).toEqual([]);
  });
});

describe('chatHistoryKey', () => {
  it('gives the same repo path on two servers different keys', () => {
    expect(chatHistoryKey('http://localhost:4747', REPO)).not.toBe(
      chatHistoryKey('https://gitnexus.example.com', REPO),
    );
    expect(chatHistoryKey('http://localhost:4747', REPO)).not.toBe(
      chatHistoryKey('http://localhost:4848', REPO),
    );
  });

  it('gives one server spelled differently the same key', () => {
    const key = chatHistoryKey('http://localhost:4747', REPO);
    expect(chatHistoryKey('HTTP://LocalHost:4747/', REPO)).toBe(key);
    expect(chatHistoryKey('https://host.example.com:443/base/', REPO)).toBe(
      chatHistoryKey('https://host.example.com/base', REPO),
    );
  });

  it('keeps credentials out of the key', () => {
    expect(chatHistoryKey('https://user:secret@host.example.com', REPO)).toBe(
      chatHistoryKey('https://host.example.com', REPO),
    );
  });

  it('is empty, so nothing is saved, when the server or repo is missing', () => {
    expect(chatHistoryKey('', REPO)).toBe('');
    expect(chatHistoryKey('http://localhost:4747', '')).toBe('');
  });
});

describe('trimChatHistory', () => {
  it('never starts with an assistant or tool message', () => {
    const messages = [msg(1, 'assistant'), msg(2, 'tool'), msg(3, 'user'), msg(4, 'assistant')];
    expect(trimChatHistory(messages)).toEqual([msg(3, 'user'), msg(4, 'assistant')]);
  });

  it('returns nothing for a non-positive limit or no user message', () => {
    expect(trimChatHistory(conversation(4), 0)).toEqual([]);
    expect(trimChatHistory([msg(1, 'assistant')])).toEqual([]);
  });
});
