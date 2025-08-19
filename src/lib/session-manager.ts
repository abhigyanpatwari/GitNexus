import { LocalStorageChatHistory, ChatSession, ChatSessionManager } from './chat-history.ts';

export interface SessionInfo {
  id: string;
  name: string;
  projectName?: string;
  createdAt: number;
  lastAccessed: number;
  messageCount: number;
  isActive: boolean;
}

export interface SessionManagerOptions {
  maxSessions?: number;
  autoCleanupDays?: number;
  storagePrefix?: string;
}

/**
 * Enhanced session manager with additional functionality
 */
export class EnhancedSessionManager {
  private options: Required<SessionManagerOptions>;

  constructor(options: SessionManagerOptions = {}) {
    this.options = {
      maxSessions: options.maxSessions || 50,
      autoCleanupDays: options.autoCleanupDays || 30,
      storagePrefix: options.storagePrefix || 'gitnexus_chat'
    };
  }

  /**
   * Get all sessions with enhanced information
   */
  getAllSessions(): SessionInfo[] {
    const sessions = ChatSessionManager.getAllSessions();
    const currentSessionId = ChatSessionManager.getCurrentSession();
    
    return sessions.map(session => ({
      id: session.id,
      name: session.name,
      projectName: session.projectName,
      createdAt: session.createdAt,
      lastAccessed: session.lastAccessed,
      messageCount: session.messages.length,
      isActive: session.id === currentSessionId
    }));
  }

  /**
   * Create a new session with enhanced options
   */
  createSession(options: {
    name?: string;
    projectName?: string;
    switchToSession?: boolean;
  } = {}): string {
    const sessionId = ChatSessionManager.createSession(options.projectName);
    
    // Update session name if provided
    if (options.name) {
      const history = new LocalStorageChatHistory(sessionId);
      history.updateSessionName(options.name);
    }
    
    // Switch to the new session if requested (default: true)
    if (options.switchToSession !== false) {
      ChatSessionManager.setCurrentSession(sessionId);
    }
    
    // Cleanup old sessions if we exceed the limit
    this.cleanupOldSessions();
    
    return sessionId;
  }

  /**
   * Switch to a specific session
   */
  switchToSession(sessionId: string): boolean {
    const sessions = ChatSessionManager.getAllSessions();
    const sessionExists = sessions.some(session => session.id === sessionId);
    
    if (sessionExists) {
      ChatSessionManager.setCurrentSession(sessionId);
      
      // Update last accessed time
      const history = new LocalStorageChatHistory(sessionId);
      const session = history.getSessionInfo();
      if (session) {
        session.lastAccessed = Date.now();
        history.importSession(session);
      }
      
      return true;
    }
    
    return false;
  }

  /**
   * Delete a session with confirmation
   */
  deleteSession(sessionId: string, options: { force?: boolean } = {}): boolean {
    const sessions = ChatSessionManager.getAllSessions();
    const session = sessions.find(s => s.id === sessionId);
    
    if (!session) {
      return false;
    }
    
    // Don't delete if it's the only session and force is not set
    if (sessions.length === 1 && !options.force) {
      return false;
    }
    
    ChatSessionManager.deleteSession(sessionId);
    return true;
  }

  /**
   * Rename a session
   */
  renameSession(sessionId: string, newName: string): boolean {
    try {
      const history = new LocalStorageChatHistory(sessionId);
      const session = history.getSessionInfo();
      
      if (session) {
        history.updateSessionName(newName);
        return true;
      }
      
      return false;
    } catch (error) {
      console.error('Failed to rename session:', error);
      return false;
    }
  }

  /**
   * Duplicate a session
   */
  duplicateSession(sessionId: string, newName?: string): string | null {
    try {
      const history = new LocalStorageChatHistory(sessionId);
      const session = history.getSessionInfo();
      
      if (!session) {
        return null;
      }
      
      // Create new session
      const newSessionId = this.createSession({
        name: newName || `${session.name} (Copy)`,
        projectName: session.projectName,
        switchToSession: false
      });
      
      // Copy messages to new session
      const newHistory = new LocalStorageChatHistory(newSessionId);
      const newSession = {
        ...session,
        id: newSessionId,
        name: newName || `${session.name} (Copy)`,
        createdAt: Date.now(),
        lastAccessed: Date.now()
      };
      
      newHistory.importSession(newSession);
      
      return newSessionId;
    } catch (error) {
      console.error('Failed to duplicate session:', error);
      return null;
    }
  }

  /**
   * Export session data
   */
  exportSession(sessionId: string): ChatSession | null {
    try {
      const history = new LocalStorageChatHistory(sessionId);
      return history.exportSession();
    } catch (error) {
      console.error('Failed to export session:', error);
      return null;
    }
  }

  /**
   * Import session data
   */
  importSession(sessionData: ChatSession, options: { 
    generateNewId?: boolean;
    switchToSession?: boolean;
  } = {}): string | null {
    try {
      let sessionId = sessionData.id;
      
      // Generate new ID if requested or if session already exists
      if (options.generateNewId || this.sessionExists(sessionId)) {
        sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      }
      
      const updatedSessionData = {
        ...sessionData,
        id: sessionId,
        createdAt: Date.now(),
        lastAccessed: Date.now()
      };
      
      const history = new LocalStorageChatHistory(sessionId);
      history.importSession(updatedSessionData);
      
      if (options.switchToSession !== false) {
        ChatSessionManager.setCurrentSession(sessionId);
      }
      
      return sessionId;
    } catch (error) {
      console.error('Failed to import session:', error);
      return null;
    }
  }

  /**
   * Search across all sessions
   */
  async searchAllSessions(query: string, options: {
    maxResultsPerSession?: number;
    includeMetadata?: boolean;
  } = {}): Promise<Array<{
    sessionId: string;
    sessionName: string;
    messages: any[];
  }>> {
    const sessions = ChatSessionManager.getAllSessions();
    const results: Array<{
      sessionId: string;
      sessionName: string;
      messages: any[];
    }> = [];
    
    for (const session of sessions) {
      try {
        const history = new LocalStorageChatHistory(session.id);
        const messages = await history.searchMessages(query, {
          maxResults: options.maxResultsPerSession || 5,
          includeMetadata: options.includeMetadata || false
        });
        
        if (messages.length > 0) {
          results.push({
            sessionId: session.id,
            sessionName: session.name,
            messages: messages.map(msg => ({
              content: msg.content,
              type: msg.constructor.name,
              timestamp: msg.additional_kwargs?.metadata?.timestamp || Date.now()
            }))
          });
        }
      } catch (error) {
        console.warn(`Failed to search session ${session.id}:`, error);
      }
    }
    
    return results;
  }

  /**
   * Get session statistics
   */
  getSessionStats(sessionId: string): {
    messageCount: number;
    cypherQueryCount: number;
    averageResponseTime: number;
    totalConversationTime: number;
    firstMessage?: Date;
    lastMessage?: Date;
  } | null {
    try {
      const history = new LocalStorageChatHistory(sessionId);
      const session = history.getSessionInfo();
      
      if (!session) {
        return null;
      }
      
      const messages = session.messages;
      let cypherQueryCount = 0;
      let totalResponseTime = 0;
      let responseTimeCount = 0;
      
      for (const message of messages) {
        if (message.metadata?.cypherQuery) {
          cypherQueryCount++;
        }
        if (message.metadata?.executionTime) {
          totalResponseTime += message.metadata.executionTime;
          responseTimeCount++;
        }
      }
      
      const firstMessage = messages.length > 0 ? new Date(messages[0].timestamp) : undefined;
      const lastMessage = messages.length > 0 ? new Date(messages[messages.length - 1].timestamp) : undefined;
      const totalConversationTime = firstMessage && lastMessage 
        ? lastMessage.getTime() - firstMessage.getTime()
        : 0;
      
      return {
        messageCount: messages.length,
        cypherQueryCount,
        averageResponseTime: responseTimeCount > 0 ? totalResponseTime / responseTimeCount : 0,
        totalConversationTime,
        firstMessage,
        lastMessage
      };
    } catch (error) {
      console.error('Failed to get session stats:', error);
      return null;
    }
  }

  /**
   * Cleanup old sessions based on age and usage
   */
  cleanupOldSessions(): void {
    try {
      const sessions = ChatSessionManager.getAllSessions();
      const currentTime = Date.now();
      const maxAge = this.options.autoCleanupDays * 24 * 60 * 60 * 1000;
      
      // Remove sessions that are too old and haven't been accessed recently
      const sessionsToRemove = sessions.filter(session => {
        const age = currentTime - session.createdAt;
        const lastAccessed = currentTime - session.lastAccessed;
        
        return age > maxAge && lastAccessed > maxAge;
      });
      
      // Also remove excess sessions if we have too many
      const sortedSessions = sessions.sort((a, b) => b.lastAccessed - a.lastAccessed);
      if (sortedSessions.length > this.options.maxSessions) {
        const excessSessions = sortedSessions.slice(this.options.maxSessions);
        sessionsToRemove.push(...excessSessions);
      }
      
      // Remove duplicate sessions from the removal list
      const uniqueSessionsToRemove = Array.from(
        new Set(sessionsToRemove.map(s => s.id))
      ).map(id => sessionsToRemove.find(s => s.id === id)!);
      
      for (const session of uniqueSessionsToRemove) {
        // Don't remove the current session unless we have others
        const currentSessionId = ChatSessionManager.getCurrentSession();
        if (session.id === currentSessionId && sessions.length > uniqueSessionsToRemove.length) {
          continue;
        }
        
        ChatSessionManager.deleteSession(session.id);
      }
      
      // Ensure we always have at least one session
      const remainingSessions = ChatSessionManager.getAllSessions();
      if (remainingSessions.length === 0) {
        ChatSessionManager.createSession();
      }
    } catch (error) {
      console.error('Failed to cleanup old sessions:', error);
    }
  }

  /**
   * Get storage usage statistics
   */
  getStorageStats(): {
    totalSessions: number;
    totalMessages: number;
    estimatedStorageSize: number;
    oldestSession?: Date;
    newestSession?: Date;
  } {
    const sessions = ChatSessionManager.getAllSessions();
    let totalMessages = 0;
    let estimatedStorageSize = 0;
    
    for (const session of sessions) {
      totalMessages += session.messages.length;
      estimatedStorageSize += JSON.stringify(session).length;
    }
    
    const timestamps = sessions.map(s => s.createdAt);
    const oldestSession = timestamps.length > 0 ? new Date(Math.min(...timestamps)) : undefined;
    const newestSession = timestamps.length > 0 ? new Date(Math.max(...timestamps)) : undefined;
    
    return {
      totalSessions: sessions.length,
      totalMessages,
      estimatedStorageSize,
      oldestSession,
      newestSession
    };
  }

  /**
   * Clear all sessions with confirmation
   */
  clearAllSessions(options: { keepCurrent?: boolean } = {}): boolean {
    try {
      const currentSessionId = ChatSessionManager.getCurrentSession();
      
      if (options.keepCurrent && currentSessionId) {
        // Delete all sessions except current
        const sessions = ChatSessionManager.getAllSessions();
        for (const session of sessions) {
          if (session.id !== currentSessionId) {
            ChatSessionManager.deleteSession(session.id);
          }
        }
      } else {
        // Delete all sessions
        ChatSessionManager.clearAllSessions();
      }
      
      return true;
    } catch (error) {
      console.error('Failed to clear all sessions:', error);
      return false;
    }
  }

  // Private helper methods

  private sessionExists(sessionId: string): boolean {
    const sessions = ChatSessionManager.getAllSessions();
    return sessions.some(session => session.id === sessionId);
  }
}

/**
 * Default session manager instance
 */
export const sessionManager = new EnhancedSessionManager();
