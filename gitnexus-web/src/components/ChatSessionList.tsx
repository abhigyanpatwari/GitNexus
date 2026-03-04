/**
 * Chat Session List Component
 * 
 * Displays a list of saved chat sessions with options to:
 * - Load a session (restore messages to chat panel)
 * - Delete a session
 * - Shows session name, repo, and timestamp
 */

import { useMemo } from 'react';
import { MessageSquare, Trash2, Clock } from 'lucide-react';
import { useAppState } from '../hooks/useAppState';
import type { ChatSession } from '../core/llm/types';
import { formatSessionDate } from '../core/llm/chat-session-service';

interface ChatSessionListProps {
  onSessionSelect?: () => void;
}

export const ChatSessionList = ({ onSessionSelect }: ChatSessionListProps) => {
  const { chatSessions, currentSessionId, loadSession, deleteSession, currentRepoName } = useAppState();

  // Sort sessions by updatedAt (newest first)
  const sortedSessions = useMemo(() => {
    return [...chatSessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [chatSessions]);

  const handleLoadSession = (sessionId: string) => {
    loadSession(sessionId);
    onSessionSelect?.();
  };

  const handleDeleteSession = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (confirm('Are you sure you want to delete this session?')) {
      deleteSession(sessionId);
    }
  };

  if (chatSessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <MessageSquare className="w-10 h-10 text-text-muted mb-3 opacity-50" />
        <p className="text-sm text-text-secondary">No saved sessions yet</p>
        <p className="text-xs text-text-muted mt-1">
          Sessions are auto-saved when tasks complete
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-surface border-b border-border-subtle">
        <h3 className="text-sm font-medium text-text-primary">Chat History</h3>
        <span className="text-xs text-text-muted">{chatSessions.length} sessions</span>
      </div>

      {/* Session List */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {sortedSessions.map((session) => (
          <div
            key={session.id}
            onClick={() => handleLoadSession(session.id)}
            className={`group flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors hover:bg-hover border-b border-border-subtle last:border-0 ${
              currentSessionId === session.id ? 'bg-accent/10 border-l-2 border-accent' : 'border-l-2 border-transparent'
            }`}
          >
            {/* Icon */}
            <div className={`mt-0.5 p-1.5 rounded-md ${
              currentSessionId === session.id
                ? 'bg-accent/20 text-accent'
                : 'bg-surface text-text-muted group-hover:text-text-primary'
            }`}>
              <MessageSquare className="w-4 h-4" />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <h4 className="text-sm font-medium text-text-primary truncate">
                {session.name}
              </h4>
              <div className="flex items-center gap-2 mt-1">
                <Clock className="w-3 h-3 text-text-muted" />
                <span className="text-xs text-text-muted">
                  {formatSessionDate(session.updatedAt)}
                </span>
              </div>
              {session.modelProvider && session.modelName && (
                <div className="mt-1">
                  <span className="text-xs text-text-muted bg-surface px-1.5 py-0.5 rounded">
                    {session.modelProvider}/{session.modelName}
                  </span>
                </div>
              )}
            </div>

            {/* Delete Button */}
            <button
              onClick={(e) => handleDeleteSession(e, session.id)}
              className="opacity-0 group-hover:opacity-100 p-1.5 text-text-muted hover:text-rose-400 hover:bg-rose-500/10 rounded transition-all"
              title="Delete session"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
