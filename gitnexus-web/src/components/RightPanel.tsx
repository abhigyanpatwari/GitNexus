import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Send,
  Square,
  Sparkles,
  User,
  PanelRightClose,
  Loader2,
  AlertTriangle,
  GitBranch,
} from '@/lib/lucide-icons';
import { useAppState } from '../hooks/useAppState';
import { ToolCallCard } from './ToolCallCard';
import { isProviderConfigured } from '../core/llm/settings-service';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ProcessesPanel } from './ProcessesPanel';
export const RightPanel = () => {
  const {
    isRightPanelOpen,
    setRightPanelOpen,
    graph,
    addCodeReference,
    // LLM / chat state
    chatMessages,
    isChatLoading,
    currentToolCalls,
    agentError,
    isAgentReady,
    isAgentInitializing,
    sendChatMessage,
    stopChatResponse,
    clearChat,
  } = useAppState();

  const [chatInput, setChatInput] = useState('');
  const [activeTab, setActiveTab] = useState<'chat' | 'processes'>('chat');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages update or while streaming
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, isChatLoading]);

  const resolveFilePathForUI = useCallback((_requestedPath: string): string | null => {
    return null;
  }, []);

  const findFileNodeIdForUI = useCallback(
    (filePath: string): string | undefined => {
      if (!graph) return undefined;
      const target = filePath.replace(/\\/g, '/').replace(/^\.?\//, '');
      const node = graph.nodes.find(
        (n) =>
          n.label === 'File' &&
          n.properties.filePath.replace(/\\/g, '/').replace(/^\.?\//, '') === target,
      );
      return node?.id;
    },
    [graph],
  );

  const handleGroundingClick = useCallback(
    (inner: string) => {
      const raw = inner.trim();
      if (!raw) return;

      let rawPath = raw;
      let startLine1: number | undefined;
      let endLine1: number | undefined;

      // Match line:num or line:num-num (supports both hyphen - and en dash –)
      const lineMatch = raw.match(/^(.*):(\d+)(?:[-–](\d+))?$/);
      if (lineMatch) {
        rawPath = lineMatch[1].trim();
        startLine1 = parseInt(lineMatch[2], 10);
        endLine1 = parseInt(lineMatch[3] || lineMatch[2], 10);
      }

      const resolvedPath = resolveFilePathForUI(rawPath);
      if (!resolvedPath) return;

      const nodeId = findFileNodeIdForUI(resolvedPath);

      addCodeReference({
        filePath: resolvedPath,
        startLine: startLine1 ? Math.max(0, startLine1 - 1) : undefined,
        endLine: endLine1
          ? Math.max(0, endLine1 - 1)
          : startLine1
            ? Math.max(0, startLine1 - 1)
            : undefined,
        nodeId,
        label: 'File',
        name: resolvedPath.split('/').pop() ?? resolvedPath,
        source: 'ai',
      });
    },
    [addCodeReference, findFileNodeIdForUI, resolveFilePathForUI],
  );

  // Handler for node grounding: [[Class:View]], [[Function:trigger]], etc.
  const handleNodeGroundingClick = useCallback(
    (nodeTypeAndName: string) => {
      const raw = nodeTypeAndName.trim();
      if (!raw || !graph) return;

      // Parse Type:Name format
      const match = raw.match(
        /^(Class|Function|Method|Interface|File|Folder|Variable|Enum|Type|CodeElement):(.+)$/,
      );
      if (!match) return;

      const [, nodeType, nodeName] = match;
      const trimmedName = nodeName.trim();

      // Find node in graph by type + name
      const node = graph.nodes.find(
        (n) => n.label === nodeType && n.properties.name === trimmedName,
      );

      if (!node) {
        console.warn(`Node not found: ${nodeType}:${trimmedName}`);
        return;
      }

      // 1. Highlight in graph (add to AI citation highlights)
      // Note: This requires accessing the state setter from parent context
      // For now, we'll add to code references which triggers the highlight

      // 2. Add to Code Panel (if node has file/line info)
      if (node.properties.filePath) {
        const resolvedPath = resolveFilePathForUI(node.properties.filePath);
        if (resolvedPath) {
          addCodeReference({
            filePath: resolvedPath,
            startLine: node.properties.startLine ? node.properties.startLine - 1 : undefined,
            endLine: node.properties.endLine ? node.properties.endLine - 1 : undefined,
            nodeId: node.id,
            label: node.label,
            name: node.properties.name,
            source: 'ai',
          });
        }
      }
    },
    [graph, resolveFilePathForUI, addCodeReference],
  );

  const handleLinkClick = useCallback(
    (href: string) => {
      if (href.startsWith('code-ref:')) {
        const inner = decodeURIComponent(href.slice('code-ref:'.length));
        handleGroundingClick(inner);
      } else if (href.startsWith('node-ref:')) {
        const inner = decodeURIComponent(href.slice('node-ref:'.length));
        handleNodeGroundingClick(inner);
      }
    },
    [handleGroundingClick, handleNodeGroundingClick],
  );

  // Auto-resize textarea as user types
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to get accurate scrollHeight
    textarea.style.height = 'auto';
    // Set to scrollHeight, capped at max
    const maxHeight = 160; // ~6 lines
    const newHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${newHeight}px`;
    // Show scrollbar if content exceeds max
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  // Adjust height when input changes
  useEffect(() => {
    adjustTextareaHeight();
  }, [chatInput, adjustTextareaHeight]);

  // Chat handlers
  const handleSendMessage = async () => {
    if (!chatInput.trim()) return;
    const text = chatInput.trim();
    setChatInput('');
    // Reset textarea height after sending
    if (textareaRef.current) {
      textareaRef.current.style.height = '36px';
      textareaRef.current.style.overflowY = 'hidden';
    }
    await sendChatMessage(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const chatSuggestions = [
    'Explain the project architecture',
    'What does this project do?',
    'Show me the most important files',
    'Find all API handlers',
  ];

  if (!isRightPanelOpen) return null;

  return (
    <aside className="relative z-30 flex w-[40%] max-w-[600px] min-w-[400px] flex-shrink-0 animate-slide-in flex-col border-l border-border-subtle bg-deep">
      {/* Header with Tabs */}
      <div className="flex items-center justify-between border-b border-border-subtle bg-surface px-4 py-2">
        <div className="flex items-center gap-1">
          {/* Chat Tab */}
          <button
            onClick={() => setActiveTab('chat')}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              activeTab === 'chat'
                ? 'bg-accent/15 text-accent'
                : 'text-text-muted hover:bg-hover hover:text-text-primary'
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>Nexus AI</span>
          </button>

          {/* Processes Tab */}
          <button
            onClick={() => setActiveTab('processes')}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              activeTab === 'processes'
                ? 'bg-accent/15 text-accent'
                : 'text-text-muted hover:bg-hover hover:text-text-primary'
            }`}
          >
            <GitBranch className="h-3.5 w-3.5" />
            <span>Processes</span>
            <span className="rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
              NEW
            </span>
          </button>
        </div>

        {/* Close button */}
        <button
          onClick={() => setRightPanelOpen(false)}
          className="rounded p-1.5 text-text-muted transition-colors hover:bg-hover hover:text-text-primary"
          title="Close Panel"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>

      {/* Processes Tab */}
      {activeTab === 'processes' && (
        <div className="flex flex-1 flex-col overflow-hidden">
          <ProcessesPanel />
        </div>
      )}

      {/* Chat Content - only show when chat tab is active */}
      {activeTab === 'chat' && (
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Status bar */}
          <div className="flex items-center gap-2.5 border-b border-border-subtle bg-elevated/50 px-4 py-3">
            <div className="ml-auto flex items-center gap-2">
              {!isAgentReady && (
                <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-1 text-[11px] text-amber-300">
                  Configure AI
                </span>
              )}
              {isAgentInitializing && (
                <span className="flex items-center gap-1 rounded-full border border-border-subtle bg-surface px-2 py-1 text-[11px] text-text-muted">
                  <Loader2 className="h-3 w-3 animate-spin" /> Connecting
                </span>
              )}
            </div>
          </div>

          {/* Status / errors */}
          {agentError && (
            <div className="flex items-center gap-2 border-b border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
              <AlertTriangle className="h-4 w-4" />
              <span>{agentError}</span>
            </div>
          )}

          {/* Messages */}
          <div className="scrollbar-thin flex-1 overflow-y-auto p-4">
            {chatMessages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center px-4 text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-node-interface text-2xl shadow-glow">
                  🧠
                </div>
                <h3 className="mb-2 text-base font-medium">Ask me anything</h3>
                <p className="mb-5 text-sm leading-relaxed text-text-secondary">
                  I can help you understand the architecture, find functions, or explain
                  connections.
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  {chatSuggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => setChatInput(suggestion)}
                      className="rounded-full border border-border-subtle bg-elevated px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-accent hover:text-text-primary"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                {chatMessages.map((message) => (
                  <div key={message.id} className="animate-fade-in">
                    {/* User message - compact label style */}
                    {message.role === 'user' && (
                      <div className="mb-4">
                        <div className="mb-2 flex items-center gap-2">
                          <User className="h-4 w-4 text-text-muted" />
                          <span className="text-xs font-medium tracking-wide text-text-muted uppercase">
                            You
                          </span>
                        </div>
                        <div className="pl-6 text-sm text-text-primary">{message.content}</div>
                      </div>
                    )}

                    {/* Assistant message - copilot style */}
                    {message.role === 'assistant' && (
                      <div>
                        <div className="mb-3 flex items-center gap-2">
                          <Sparkles className="h-4 w-4 text-accent" />
                          <span className="text-xs font-medium tracking-wide text-text-muted uppercase">
                            Nexus AI
                          </span>
                          {isChatLoading && message === chatMessages[chatMessages.length - 1] && (
                            <Loader2 className="h-3 w-3 animate-spin text-accent" />
                          )}
                        </div>
                        <div className="chat-prose pl-6">
                          {/* Render steps in order (reasoning, tool calls, content interleaved) */}
                          {message.steps && message.steps.length > 0 ? (
                            <div className="space-y-4">
                              {message.steps.map((step, index) => (
                                <div key={step.id}>
                                  {step.type === 'reasoning' && step.content && (
                                    <div className="mb-3 border-l-2 border-text-muted/30 pl-3 text-sm text-text-secondary italic">
                                      <MarkdownRenderer
                                        content={step.content}
                                        onLinkClick={handleLinkClick}
                                      />
                                    </div>
                                  )}
                                  {step.type === 'tool_call' && step.toolCall && (
                                    <div className="mb-3">
                                      <ToolCallCard
                                        toolCall={step.toolCall}
                                        defaultExpanded={false}
                                      />
                                    </div>
                                  )}
                                  {step.type === 'content' && step.content && (
                                    <MarkdownRenderer
                                      content={step.content}
                                      onLinkClick={handleLinkClick}
                                      showCopyButton={index === message.steps!.length - 1}
                                    />
                                  )}
                                </div>
                              ))}
                            </div>
                          ) : (
                            // Fallback: render content + toolCalls separately (old format)
                            <MarkdownRenderer
                              content={message.content}
                              onLinkClick={handleLinkClick}
                              toolCalls={message.toolCalls}
                              showCopyButton={true}
                            />
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {/* Scroll anchor for auto-scroll */}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="border-t border-border-subtle bg-surface p-3">
            <div className="flex items-end gap-2 rounded-xl border border-border-subtle bg-elevated px-3 py-2 transition-all focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
              <textarea
                ref={textareaRef}
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about the codebase..."
                rows={1}
                className="scrollbar-thin min-h-[36px] flex-1 resize-none border-none bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
                style={{ height: '36px', overflowY: 'hidden' }}
              />
              <button
                onClick={clearChat}
                className="px-2 py-1 text-xs text-text-muted transition-colors hover:text-text-primary"
                title="Clear chat"
              >
                Clear
              </button>
              {isChatLoading ? (
                <button
                  onClick={stopChatResponse}
                  className="flex h-9 w-9 items-center justify-center rounded-md bg-red-500/80 text-white transition-all hover:bg-red-500"
                  title="Stop response"
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                </button>
              ) : (
                <button
                  onClick={handleSendMessage}
                  disabled={!chatInput.trim() || isAgentInitializing}
                  className="flex h-9 w-9 items-center justify-center rounded-md bg-accent text-white transition-all hover:bg-accent-dim disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {!isAgentReady && !isAgentInitializing && (
              <div className="mt-2 flex items-center gap-2 text-xs text-amber-200">
                <AlertTriangle className="h-3.5 w-3.5" />
                <span>
                  {isProviderConfigured()
                    ? 'Initializing AI agent...'
                    : 'Configure an LLM provider to enable chat.'}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
};
