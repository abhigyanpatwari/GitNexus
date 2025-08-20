import { BaseChatMessageHistory } from '@langchain/core/chat_history';
import { BaseMessage, HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';

export interface ChatHistoryMetadata {
  cypherQuery?: string;
  queryResult?: unknown;
  executionTime?: number;
  timestamp: number;
  similarity?: number;
  confidence?: number;
  sources?: string[];
}

export interface StoredMessage {
  id: string;
  type: 'human' | 'ai' | 'system';
  content: string;
  metadata?: ChatHistoryMetadata;
  timestamp: number;
}

export interface ChatSession {
  id: string;
  name: string;
  messages: StoredMessage[];
  createdAt: number;
  lastAccessed: number;
  projectName?: string;
}

/**
 * LocalStorage-based chat history implementation for client-side persistence
 */
export class LocalStorageChatHistory extends BaseChatMessageHistory {
  lc_namespace = ['gitnexus', 'chat_history'];
  private sessionId: string;
  private storageKey: string;
  private maxMessages: number;
  private maxSessions: number;

  constructor(
    sessionId: string,
    options: {
      storagePrefix?: string;
      maxMessages?: number;
      maxSessions?: number;
    } = {}
  ) {
    super();
    this.sessionId = sessionId;
    this.storageKey = `${options.storagePrefix || 'gitnexus_chat'}_${sessionId}`;
    this.maxMessages = options.maxMessages || 1000;
    this.maxSessions = options.maxSessions || 50;
  }

  /**
   * Get all messages for the current session
   */
  async getMessages(): Promise<BaseMessage[]> {
    try {
      const session = this.loadSession();
      if (!session) {
        return [];
      }

      // Update last accessed time
      session.lastAccessed = Date.now();
      this.saveSession(session);

      // Convert stored messages to BaseMessage instances
      return session.messages.map(msg => this.storedMessageToBaseMessage(msg));
    } catch (error) {
      console.error('Failed to load chat history:', error);
      return [];
    }
  }

  /**
   * Add a message to the chat history
   */
  async addMessage(message: BaseMessage): Promise<void> {
    try {
      let session = this.loadSession();
      if (!session) {
        session = this.createNewSession();
      }

      const storedMessage = this.baseMessageToStoredMessage(message);
      session.messages.push(storedMessage);
      session.lastAccessed = Date.now();

      // Trim messages if we exceed the limit
      if (session.messages.length > this.maxMessages) {
        session.messages = session.messages.slice(-this.maxMessages);
      }

      this.saveSession(session);
      this.cleanupOldSessions();
    } catch (error) {
      console.error('Failed to add message to chat history:', error);
      throw new Error(`Failed to save message: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Add multiple messages at once
   */
  async addMessages(messages: BaseMessage[]): Promise<void> {
    for (const message of messages) {
      await this.addMessage(message);
    }
  }

  /**
   * Add user message (required by BaseChatMessageHistory)
   */
  async addUserMessage(message: string): Promise<void> {
    await this.addMessage(new HumanMessage(message));
  }

  /**
   * Add AI chat message (required by BaseChatMessageHistory)
   */
  async addAIChatMessage(message: string): Promise<void> {
    await this.addMessage(new AIMessage(message));
  }

  /**
   * Clear all messages for the current session
   */
  async clear(): Promise<void> {
    try {
      localStorage.removeItem(this.storageKey);
    } catch (error) {
      console.error('Failed to clear chat history:', error);
      throw new Error(`Failed to clear history: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Add message with metadata (for Cypher queries, results, etc.)
   */
  async addMessageWithMetadata(
    message: BaseMessage,
    metadata: Partial<ChatHistoryMetadata>
  ): Promise<void> {
    const messageWithMetadata = message instanceof AIMessage
      ? new AIMessage({
          content: message.content,
          additional_kwargs: {
            ...message.additional_kwargs,
            metadata: {
              ...metadata,
              timestamp: Date.now()
            }
          }
        })
      : message;

    await this.addMessage(messageWithMetadata);
  }

  /**
   * Search messages by content or metadata
   */
  async searchMessages(query: string, options: {
    includeMetadata?: boolean;
    maxResults?: number;
  } = {}): Promise<BaseMessage[]> {
    const { includeMetadata = true, maxResults = 20 } = options;
    
    try {
      const messages = await this.getMessages();
      const lowerQuery = query.toLowerCase();
      
      const matches = messages.filter(message => {
        const contentMatch = message.content.toString().toLowerCase().includes(lowerQuery);
        
        if (includeMetadata && message.additional_kwargs?.metadata) {
          const metadata = message.additional_kwargs.metadata as ChatHistoryMetadata;
          const metadataMatch = 
            metadata.cypherQuery?.toLowerCase().includes(lowerQuery) ||
            JSON.stringify(metadata.queryResult || {}).toLowerCase().includes(lowerQuery);
          return contentMatch || metadataMatch;
        }
        
        return contentMatch;
      });

      return matches.slice(0, maxResults);
    } catch (error) {
      console.error('Failed to search messages:', error);
      return [];
    }
  }

  /**
   * Get session information
   */
  getSessionInfo(): ChatSession | null {
    return this.loadSession();
  }

  /**
   * Update session name
   */
  updateSessionName(name: string): void {
    const session = this.loadSession();
    if (session) {
      session.name = name;
      this.saveSession(session);
    }
  }

  /**
   * Export session data
   */
  exportSession(): ChatSession | null {
    return this.loadSession();
  }

  /**
   * Import session data
   */
  importSession(sessionData: ChatSession): void {
    this.saveSession(sessionData);
  }

  /**
   * Get all available sessions
   */
  static getAllSessions(): ChatSession[] {
    const sessions: ChatSession[] = [];
    
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith('gitnexus_chat_')) {
          const data = localStorage.getItem(key);
          if (data) {
            const session = JSON.parse(data) as ChatSession;
            sessions.push(session);
          }
        }
      }
      
      // Sort by last accessed time
      return sessions.sort((a, b) => b.lastAccessed - a.lastAccessed);
    } catch (error) {
      console.error('Failed to load sessions:', error);
      return [];
    }
  }

  /**
   * Delete a specific session
   */
  static deleteSession(sessionId: string): void {
    const key = `gitnexus_chat_${sessionId}`;
    localStorage.removeItem(key);
  }

  // Private helper methods

  private loadSession(): ChatSession | null {
    try {
      const data = localStorage.getItem(this.storageKey);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Failed to parse session data:', error);
      return null;
    }
  }

  private saveSession(session: ChatSession): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(session));
    } catch (error) {
      if (error instanceof Error && error.name === 'QuotaExceededError') {
        // Try to free up space by removing old sessions
        this.cleanupOldSessions();
        try {
          localStorage.setItem(this.storageKey, JSON.stringify(session));
        } catch (retryError) {
          throw new Error('localStorage quota exceeded. Please clear some chat history.');
        }
      } else {
        throw error;
      }
    }
  }

  private createNewSession(): ChatSession {
    return {
      id: this.sessionId,
      name: `Chat ${new Date().toLocaleString()}`,
      messages: [],
      createdAt: Date.now(),
      lastAccessed: Date.now()
    };
  }

  private baseMessageToStoredMessage(message: BaseMessage): StoredMessage {
    let type: 'human' | 'ai' | 'system';
    
    if (message instanceof HumanMessage) {
      type = 'human';
    } else if (message instanceof AIMessage) {
      type = 'ai';
    } else if (message instanceof SystemMessage) {
      type = 'system';
    } else {
      type = 'ai'; // Default fallback
    }

    return {
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type,
      content: message.content.toString(),
      metadata: message.additional_kwargs?.metadata as ChatHistoryMetadata,
      timestamp: Date.now()
    };
  }

  private storedMessageToBaseMessage(stored: StoredMessage): BaseMessage {
    const content = stored.content;
    const additional_kwargs = stored.metadata ? { metadata: stored.metadata } : {};

    switch (stored.type) {
      case 'human':
        return new HumanMessage({ content, additional_kwargs });
      case 'ai':
        return new AIMessage({ content, additional_kwargs });
      case 'system':
        return new SystemMessage({ content, additional_kwargs });
      default:
        return new AIMessage({ content, additional_kwargs });
    }
  }

  private cleanupOldSessions(): void {
    try {
      const sessions = LocalStorageChatHistory.getAllSessions();
      
      if (sessions.length > this.maxSessions) {
        // Remove the oldest sessions
        const sessionsToRemove = sessions.slice(this.maxSessions);
        sessionsToRemove.forEach(session => {
          LocalStorageChatHistory.deleteSession(session.id);
        });
      }
    } catch (error) {
      console.error('Failed to cleanup old sessions:', error);
    }
  }
}

/**
 * Session manager for handling multiple chat sessions
 */
export class ChatSessionManager {
  private static readonly CURRENT_SESSION_KEY = 'gitnexus_current_session';

  /**
   * Create a new chat session
   */
  static createSession(projectName?: string): string {
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const history = new LocalStorageChatHistory(sessionId);
    
    // Initialize with empty session
    const session = {
      id: sessionId,
      name: `Chat ${new Date().toLocaleString()}`,
      messages: [],
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      projectName
    };
    
    history.importSession(session);
    this.setCurrentSession(sessionId);
    
    return sessionId;
  }

  /**
   * Get the current active session ID
   */
  static getCurrentSession(): string | null {
    return localStorage.getItem(this.CURRENT_SESSION_KEY);
  }

  /**
   * Set the current active session
   */
  static setCurrentSession(sessionId: string): void {
    localStorage.setItem(this.CURRENT_SESSION_KEY, sessionId);
  }

  /**
   * Get or create a chat history instance for the current session
   */
  static getCurrentChatHistory(): LocalStorageChatHistory {
    let sessionId = this.getCurrentSession();
    
    if (!sessionId) {
      sessionId = this.createSession();
    }
    
    return new LocalStorageChatHistory(sessionId);
  }

  /**
   * Switch to a different session
   */
  static switchToSession(sessionId: string): LocalStorageChatHistory {
    this.setCurrentSession(sessionId);
    return new LocalStorageChatHistory(sessionId);
  }

  /**
   * Get all available sessions
   */
  static getAllSessions(): ChatSession[] {
    return LocalStorageChatHistory.getAllSessions();
  }

  /**
   * Delete a session
   */
  static deleteSession(sessionId: string): void {
    LocalStorageChatHistory.deleteSession(sessionId);
    
    // If we deleted the current session, create a new one
    if (this.getCurrentSession() === sessionId) {
      this.createSession();
    }
  }

  /**
   * Clear all sessions
   */
  static clearAllSessions(): void {
    const sessions = this.getAllSessions();
    sessions.forEach(session => {
      LocalStorageChatHistory.deleteSession(session.id);
    });
    
    // Create a new default session
    this.createSession();
  }
}
