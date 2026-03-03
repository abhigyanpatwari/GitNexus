/**
 * Chat Session Service
 * 
 * Manages conversation history sessions with server-side persistence.
 * Provides save, load, delete, and list operations for chat sessions.
 */

import type { ChatSession, ChatMessage } from './types';
import { 
  fetchAllSessions, 
  fetchSession, 
  saveSessionToServer, 
  deleteSessionFromServer, 
  clearAllSessionsFromServer 
} from '../../services/backend.js';

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Get all sessions from server
 */
export async function getAllSessions(): Promise<ChatSession[]> {
  try {
    return await fetchAllSessions();
  } catch (error) {
    console.error('Failed to load chat sessions:', error);
    return [];
  }
}

/**
 * Create a new session from current messages
 */
export async function createSession(
  messages: ChatMessage[],
  repoName?: string,
  customName?: string
): Promise<ChatSession> {
  const now = Date.now();
  const session: ChatSession = {
    id: generateSessionId(),
    name: customName || generateSessionName(messages),
    repoName,
    createdAt: now,
    updatedAt: now,
    messages,
  };
  
  try {
    return await saveSessionToServer(session);
  } catch (error) {
    console.error('Failed to create session:', error);
    throw error;
  }
}

/**
 * Generate a session name from messages
 */
function generateSessionName(messages: ChatMessage[]): string {
  // Use first user message as session name, truncated
  const firstUserMessage = messages.find(m => m.role === 'user');
  if (firstUserMessage) {
    const content = firstUserMessage.content.trim();
    return content.length > 50 ? content.substring(0, 47) + '...' : content;
  }
  return `Session ${new Date().toLocaleString()}`;
}

/**
 * Update an existing session
 */
export async function updateSession(sessionId: string, messages: ChatMessage[]): Promise<ChatSession | null> {
  try {
    const sessions = await getAllSessions();
    const existing = sessions.find(s => s.id === sessionId);
    
    if (!existing) {
      // Session not found, create new one
      return await createSession(messages);
    }
    
    const updated: ChatSession = {
      ...existing,
      messages,
      updatedAt: Date.now(),
    };
    
    return await saveSessionToServer(updated);
  } catch (error) {
    console.error('Failed to update session:', error);
    return null;
  }
}

/**
 * Save or update a session (upsert)
 */
export async function saveSession(
  sessionId: string | null,
  messages: ChatMessage[],
  repoName?: string
): Promise<ChatSession> {
  if (sessionId) {
    const updated = await updateSession(sessionId, messages);
    if (updated) return updated;
  }
  return await createSession(messages, repoName);
}

/**
 * Load a specific session by ID
 */
export async function loadSession(sessionId: string): Promise<ChatSession | null> {
  try {
    return await fetchSession(sessionId);
  } catch (error) {
    console.error('Failed to load session:', error);
    return null;
  }
}

/**
 * Delete a session
 */
export async function deleteSession(sessionId: string): Promise<boolean> {
  try {
    await deleteSessionFromServer(sessionId);
    return true;
  } catch (error) {
    console.error('Failed to delete session:', error);
    return false;
  }
}

/**
 * Clear all sessions
 */
export async function clearAllSessions(): Promise<void> {
  try {
    await clearAllSessionsFromServer();
  } catch (error) {
    console.error('Failed to clear sessions:', error);
    throw error;
  }
}

/**
 * Get sessions for a specific repository
 */
export async function getSessionsByRepo(repoName: string): Promise<ChatSession[]> {
  const sessions = await getAllSessions();
  return sessions.filter(s => s.repoName === repoName);
}

/**
 * Format timestamp for display
 */
export function formatSessionDate(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  
  return new Date(timestamp).toLocaleDateString();
}
