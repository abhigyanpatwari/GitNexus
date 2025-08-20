import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { KnowledgeGraph } from '../../../core/graph/types.ts';
import { LLMService, type LLMProvider, type LLMConfig } from '../../../ai/llm-service.ts';
import { CypherGenerator } from '../../../ai/cypher-generator.ts';
import { ReActAgent, type ReActResult, type ReActOptions } from '../../../ai/react-agent.ts';
import { KuzuQueryEngine } from '../../../core/graph/kuzu-query-engine.ts';
import { sessionManager, type SessionInfo } from '../../../lib/session-manager.ts';
import { ChatSessionManager, LocalStorageChatHistory, type ChatHistoryMetadata } from '../../../lib/chat-history.ts';
import { AIMessage } from '@langchain/core/messages';
import { QueryCacheService } from '../../../lib/query-cache.ts';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  metadata?: {
    cypherQueries?: Array<{ cypher: string; explanation: string; confidence?: number }>;
    sources?: string[];
    confidence?: number;
    reasoning?: Array<{ 
      step: number; 
      thought: string; 
      action: string;
      actionInput?: string;
      observation?: string;
      toolResult?: {
        toolName: string;
        input: string;
        output: string;
        success: boolean;
        error?: string;
      };
    }>;
    debugInfo?: {
      llmConfig: LLMConfig;
      ragOptions: ReActOptions;
      contextInfo: {
        nodeCount: number;
        fileCount: number;
        hasContext: boolean;
      };
      totalExecutionTime?: number;
      queryExecutionTimes?: Array<{ query: string; time: number }>;
    };
    cacheSuggestions?: Array<{
      cypherQuery: string;
      confidence: number;
      similarity: number;
      sourceQuestion: string;
    }>;
  };
}

interface ChatInterfaceProps {
  graph: KnowledgeGraph;
  fileContents: Map<string, string>;
  projectName?: string;
  className?: string;
  style?: React.CSSProperties;
}

interface LLMSettings {
  provider: LLMProvider;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  // Azure OpenAI specific fields
  azureOpenAIEndpoint?: string;
  azureOpenAIDeploymentName?: string;
  azureOpenAIApiVersion?: string;
}

const ChatInterface: React.FC<ChatInterfaceProps> = ({
  graph,
  fileContents,
  projectName = 'Unknown Project',
  className = '',
  style = {}
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [showSessionManager, setShowSessionManager] = useState(false);
  const [chatHistory, setChatHistory] = useState<LocalStorageChatHistory | null>(null);
  const [queryCache] = useState(() => QueryCacheService.getInstance());
  
  // LLM Configuration
  const [llmSettings, setLLMSettings] = useState<LLMSettings>({
    provider: 'openai',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.1,
    maxTokens: 4000,
    azureOpenAIEndpoint: '',
    azureOpenAIDeploymentName: '',
    azureOpenAIApiVersion: '2024-02-01'
  });

  // Services
  const [llmService] = useState(new LLMService());
  const [cypherGenerator] = useState(new CypherGenerator(llmService));
  const [kuzuQueryEngine] = useState(new KuzuQueryEngine());
  const [ragOrchestrator] = useState(new ReActAgent(llmService, cypherGenerator, kuzuQueryEngine));

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Initialize RAG context when graph or fileContents change
  useEffect(() => {
    const initializeOrchestrator = async () => {
      try {
        await ragOrchestrator.initialize();
        
        // Load existing queries from chat history into cache
        await queryCache.loadFromChatHistory();
        
        // Only set context if we have valid graph data
        if (graph && graph.nodes && graph.nodes.length > 0) {
          // Get or create session
          let sessionId = ChatSessionManager.getCurrentSession();
          if (!sessionId) {
            sessionId = ChatSessionManager.createSession(projectName);
          }
          
          // Initialize chat history
          const history = new LocalStorageChatHistory(sessionId);
          setChatHistory(history);
          setCurrentSessionId(sessionId);
          
          // Set context with graph data
          const llmConfig: LLMConfig = {
            provider: llmSettings.provider,
            model: llmSettings.model,
            temperature: llmSettings.temperature,
            maxTokens: llmSettings.maxTokens,
            apiKey: llmSettings.apiKey,
            azureOpenAIEndpoint: llmSettings.azureOpenAIEndpoint,
            azureOpenAIDeploymentName: llmSettings.azureOpenAIDeploymentName,
            azureOpenAIApiVersion: llmSettings.azureOpenAIApiVersion
          };
          
          await ragOrchestrator.setContext({ 
            graph, 
            fileContents, 
            projectName,
            sessionId 
          }, llmConfig);
          
          // Set chat history for conversation context
          ragOrchestrator.setChatHistory(history);
          
          // Load conversation history from chat history
          await loadConversationHistory(history);
          
          // Load sessions list
          refreshSessions();
        } else {
          console.log('No valid graph data available yet, skipping context initialization');
        }
      } catch (error) {
        console.error('Failed to initialize orchestrator:', error);
      }
    };
    
    initializeOrchestrator();
  }, [graph, fileContents, projectName, ragOrchestrator]);

  // Load conversation history from chat history
  const loadConversationHistory = async (history: LocalStorageChatHistory) => {
    try {
      const langchainMessages = await history.getMessages();
      const chatMessages = langchainMessages.map((msg, index) => ({
        id: `history_${index}`,
        role: msg.constructor.name === 'HumanMessage' ? 'user' as const : 'assistant' as const,
        content: msg.content.toString(),
        timestamp: new Date((msg.additional_kwargs?.metadata as ChatHistoryMetadata)?.timestamp || Date.now()),
        metadata: (msg.additional_kwargs?.metadata as ChatHistoryMetadata) || undefined
      }));
      
      setMessages(chatMessages);
    } catch (error) {
      console.error('Failed to load conversation history:', error);
    }
  };

  // Load settings from localStorage on mount
  useEffect(() => {
    const savedProvider = localStorage.getItem('llm_provider') as LLMProvider;
    const savedApiKey = localStorage.getItem('llm_api_key');
    const savedAzureEndpoint = localStorage.getItem('azure_openai_endpoint');
    const savedAzureDeployment = localStorage.getItem('azure_openai_deployment');
    const savedAzureApiVersion = localStorage.getItem('azure_openai_api_version');

    if (savedProvider || savedApiKey || savedAzureEndpoint) {
      setLLMSettings(prev => ({
        ...prev,
        provider: savedProvider || prev.provider,
        apiKey: savedApiKey || prev.apiKey,
        azureOpenAIEndpoint: savedAzureEndpoint || prev.azureOpenAIEndpoint,
        azureOpenAIDeploymentName: savedAzureDeployment || prev.azureOpenAIDeploymentName,
        azureOpenAIApiVersion: savedAzureApiVersion || prev.azureOpenAIApiVersion,
        // For Azure OpenAI, use deployment name as model, otherwise use default model
        model: savedProvider === 'azure-openai' 
          ? (savedAzureDeployment || 'gpt-4.1-mini-v2')
          : (savedProvider ? llmService.getAvailableModels(savedProvider)[0] : prev.model)
      }));
    }
  }, [llmService]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || isLoading || !chatHistory) return;

    // Validate API key
    if (!llmSettings.apiKey.trim()) {
      alert('Please configure your API key in settings');
      setShowSettings(true);
      return;
    }

    if (!llmService.validateApiKey(llmSettings.provider, llmSettings.apiKey)) {
      alert('Invalid API key format. Please check your settings.');
      setShowSettings(true);
      return;
    }

    // Additional validation for Azure OpenAI
    if (llmSettings.provider === 'azure-openai') {
      if (!llmSettings.azureOpenAIEndpoint?.trim()) {
        alert('Please configure your Azure OpenAI endpoint in settings');
        setShowSettings(true);
        return;
      }
      if (!llmSettings.azureOpenAIDeploymentName?.trim()) {
        alert('Please configure your Azure OpenAI deployment name in settings');
        setShowSettings(true);
        return;
      }
    }

    // Check if we have a valid graph context
    if (!graph || !graph.nodes || graph.nodes.length === 0) {
      alert('No codebase loaded yet. Please load a repository first to analyze.');
      return;
    }

    const userMessage: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: inputValue.trim(),
      timestamp: new Date()
    };

    // Check for cached query suggestions
    const cachedSuggestions = queryCache.findSimilarQueries(userMessage.content, {
      minSimilarity: 0.8,
      maxResults: 3,
      minConfidence: 0.7
    });

    // Save user message to chat history
    await chatHistory.addUserMessage(userMessage.content);
    setMessages(prev => [...prev, userMessage]);
    setInputValue('');
    setIsLoading(true);

    try {
      const startTime = Date.now();
      
      const llmConfig: LLMConfig = {
        provider: llmSettings.provider,
        apiKey: llmSettings.apiKey,
        model: llmSettings.model,
        temperature: llmSettings.temperature,
        maxTokens: llmSettings.maxTokens,
        // Azure OpenAI specific fields
        azureOpenAIEndpoint: llmSettings.azureOpenAIEndpoint,
        azureOpenAIDeploymentName: llmSettings.azureOpenAIDeploymentName,
        azureOpenAIApiVersion: llmSettings.azureOpenAIApiVersion
      };

      const ragOptions: ReActOptions = {
        maxIterations: 5,
        includeReasoning: true, // Always include reasoning for better UX
        temperature: llmSettings.temperature,
        enableQueryCaching: true,
        similarityThreshold: 0.8
      };

      const response: ReActResult = await ragOrchestrator.processQuestion(
        userMessage.content,
        llmConfig,
        ragOptions
      );

      const endTime = Date.now();
      const executionTime = endTime - startTime;

      const assistantMessage: ChatMessage = {
        id: generateId(),
        role: 'assistant',
        content: response.answer,
        timestamp: new Date(),
        metadata: {
          cypherQueries: response.cypherQueries.map(q => ({
            cypher: q.cypher,
            explanation: q.explanation,
            confidence: q.confidence
          })),
          sources: response.sources,
          confidence: response.confidence,
          reasoning: response.reasoning.map(r => ({
            step: r.step,
            thought: r.thought,
            action: r.action,
            actionInput: r.actionInput,
            observation: r.observation,
            toolResult: r.toolResult
          })),
          debugInfo: {
            llmConfig,
            ragOptions,
            contextInfo: {
              nodeCount: 0, // TODO: Implement getContextInfo
              fileCount: fileContents.size,
              hasContext: true
            },
            totalExecutionTime: executionTime,
            queryExecutionTimes: response.cypherQueries.map(q => ({
              query: q.cypher,
              time: 0 // We'd need to instrument the query engine for this
            }))
          }
        }
      };

      // Save assistant message with metadata to chat history for learning and caching
      const metadata: ChatHistoryMetadata = {
        cypherQuery: response.cypherQueries.length > 0 ? response.cypherQueries[0].cypher : undefined,
        queryResult: response.cypherQueries.length > 0 ? response.cypherQueries as unknown : undefined,
        executionTime: executionTime,
        timestamp: Date.now(),
        confidence: response.confidence,
        sources: response.sources
      };

      await chatHistory.addMessageWithMetadata(
        new AIMessage(response.answer),
        metadata
      );

      // Learn from this query for future improvements
      if (response.cypherQueries.length > 0) {
        const success = response.confidence > 0.5;
        queryCache.addQuery(
          userMessage.content,
          response.cypherQueries[0].cypher,
          response.confidence,
          executionTime,
          0, // We don't have result count
          success
        );
      }

      // Add cache suggestions to the message if available
      if (cachedSuggestions.length > 0) {
        assistantMessage.metadata = {
          ...assistantMessage.metadata,
          cacheSuggestions: cachedSuggestions.map(s => ({
            cypherQuery: s.cypherQuery,
            confidence: s.confidence,
            similarity: s.similarity,
            sourceQuestion: s.sourceQuestion
          }))
        };
      }

      setMessages(prev => [...prev, assistantMessage]);

    } catch (error) {
      const errorMessage: ChatMessage = {
        id: generateId(),
        role: 'assistant',
        content: `I apologize, but I encountered an error while processing your question: ${error instanceof Error ? error.message : 'Unknown error'}`,
        timestamp: new Date()
      };

      // Save error message to chat history
      await chatHistory.addAIChatMessage(errorMessage.content);
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  // Handle key press in textarea
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as any);
    }
  };

  // Session management functions
  const refreshSessions = () => {
    const allSessions = sessionManager.getAllSessions();
    setSessions(allSessions);
  };

  const createNewSession = () => {
    const sessionId = sessionManager.createSession({ 
      name: `Chat ${new Date().toLocaleString()}`,
      projectName,
      switchToSession: true
    });
    setCurrentSessionId(sessionId);
    setMessages([]);
    refreshSessions();
  };

  const switchSession = async (sessionId: string) => {
    if (sessionManager.switchToSession(sessionId)) {
      setCurrentSessionId(sessionId);
      
      // Initialize new chat history
      const history = new LocalStorageChatHistory(sessionId);
      setChatHistory(history);
      
      // Load conversation history for the new session
      const llmConfig: LLMConfig = {
        provider: llmSettings.provider,
        model: llmSettings.model,
        temperature: llmSettings.temperature,
        maxTokens: llmSettings.maxTokens,
        apiKey: llmSettings.apiKey,
        azureOpenAIEndpoint: llmSettings.azureOpenAIEndpoint,
        azureOpenAIDeploymentName: llmSettings.azureOpenAIDeploymentName,
        azureOpenAIApiVersion: llmSettings.azureOpenAIApiVersion
      };
      
      await ragOrchestrator.setContext({ 
        graph, 
        fileContents, 
        projectName,
        sessionId 
      }, llmConfig);
      
      // Set chat history for conversation context
      ragOrchestrator.setChatHistory(history);
      
      // Load conversation history from chat history
      await loadConversationHistory(history);
      refreshSessions();
    }
  };

  const deleteSession = (sessionId: string) => {
    if (confirm('Are you sure you want to delete this conversation?')) {
      if (sessionManager.deleteSession(sessionId)) {
        if (currentSessionId === sessionId) {
          createNewSession();
        }
        refreshSessions();
      }
    }
  };

  const renameSession = (sessionId: string, newName: string) => {
    if (sessionManager.renameSession(sessionId, newName)) {
      refreshSessions();
    }
  };

  // Clear conversation
  const clearConversation = async () => {
    if (confirm('Are you sure you want to clear this conversation?') && chatHistory) {
      await chatHistory.clear();
      setMessages([]);
    }
  };

  // Reasoning Component for Assistant Messages
  const ReasoningSection: React.FC<{ reasoning: NonNullable<ChatMessage['metadata']>['reasoning'] }> = ({ reasoning }) => {
    const [isExpanded, setIsExpanded] = useState(false);

    if (!reasoning || reasoning.length === 0) {
      return null;
    }

    return (
      <div style={{ 
        marginTop: '12px', 
        borderTop: '1px solid rgba(0,0,0,0.1)', 
        paddingTop: '12px' 
      }}>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          style={{
            background: 'none',
            border: 'none',
            color: '#007bff',
            cursor: 'pointer',
            fontSize: '12px',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '0',
            textDecoration: 'underline'
          }}
        >
          {isExpanded ? '▼' : '▶'} Show thought process ({reasoning.length} steps)
        </button>
        
        {isExpanded && (
          <div style={{ 
            marginTop: '8px',
            padding: '12px',
            backgroundColor: 'rgba(0,123,255,0.05)',
            borderRadius: '6px',
            border: '1px solid rgba(0,123,255,0.2)'
          }}>
            <div style={{ fontSize: '11px', color: '#666', marginBottom: '8px', fontWeight: '500' }}>
              🤔 Reasoning Process:
            </div>
                         {reasoning.map((step, index: number) => (
               <div key={index} style={{ 
                 marginBottom: index < reasoning.length - 1 ? '12px' : '0',
                 padding: '8px',
                 backgroundColor: 'rgba(255,255,255,0.7)',
                 borderRadius: '4px',
                 border: '1px solid rgba(0,0,0,0.1)'
               }}>
                <div style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '8px', 
                  marginBottom: '6px',
                  fontSize: '11px'
                }}>
                  <span style={{ 
                    backgroundColor: '#007bff', 
                    color: 'white', 
                    borderRadius: '50%', 
                    width: '16px', 
                    height: '16px', 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center',
                    fontSize: '10px',
                    fontWeight: 'bold'
                  }}>
                    {step.step}
                  </span>
                  <span style={{ 
                    backgroundColor: step.toolResult?.success 
                      ? 'rgba(40,167,69,0.2)' 
                      : step.toolResult?.success === false
                      ? 'rgba(220,53,69,0.2)'
                      : 'rgba(108,117,125,0.2)',
                    color: step.toolResult?.success 
                      ? '#28a745' 
                      : step.toolResult?.success === false
                      ? '#dc3545'
                      : '#6c757d',
                    padding: '2px 6px',
                    borderRadius: '12px',
                    fontSize: '10px',
                    fontWeight: '500'
                  }}>
                    {step.action}
                  </span>
                </div>
                
                <div style={{ fontSize: '12px', lineHeight: '1.4' }}>
                  <div style={{ marginBottom: '4px' }}>
                    <strong>Thought:</strong> {step.thought}
                  </div>
                  
                  {step.actionInput && (
                    <div style={{ marginBottom: '4px' }}>
                      <strong>Input:</strong> 
                      <code style={{ 
                        backgroundColor: 'rgba(0,0,0,0.1)', 
                        padding: '1px 4px', 
                        borderRadius: '2px',
                        fontSize: '11px',
                        marginLeft: '4px'
                      }}>
                        {step.actionInput}
                      </code>
                    </div>
                  )}
                  
                  {step.observation && (
                    <div style={{ 
                      marginTop: '6px',
                      padding: '6px',
                      backgroundColor: 'rgba(40,167,69,0.1)',
                      borderRadius: '3px',
                      fontSize: '11px'
                    }}>
                      <strong>Result:</strong> {step.observation}
                    </div>
                  )}
                  
                  {step.toolResult && step.toolResult.error && (
                    <div style={{ 
                      marginTop: '6px',
                      padding: '6px',
                      backgroundColor: 'rgba(220,53,69,0.1)',
                      borderRadius: '3px',
                      fontSize: '11px',
                      color: '#dc3545'
                    }}>
                      <strong>Error:</strong> {step.toolResult.error}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  // Generate unique ID
  const generateId = () => {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  };

  // Markdown Content Component
  const MarkdownContent: React.FC<{ content: string; role: 'user' | 'assistant' }> = ({ content, role }) => {
    if (role === 'user') {
      // Don't apply markdown to user messages
      return <div>{content}</div>;
    }

    return (
      <div className="markdown-content">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={{
            // Custom styling for different markdown elements
            h1: ({ children }) => <h1 style={{ fontSize: '18px', fontWeight: 'bold', marginBottom: '12px', color: '#333' }}>{children}</h1>,
            h2: ({ children }) => <h2 style={{ fontSize: '16px', fontWeight: 'bold', marginBottom: '10px', color: '#333' }}>{children}</h2>,
            h3: ({ children }) => <h3 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '8px', color: '#333' }}>{children}</h3>,
            p: ({ children }) => <p style={{ marginBottom: '12px', lineHeight: '1.5' }}>{children}</p>,
            ul: ({ children }) => <ul style={{ marginBottom: '12px', paddingLeft: '20px' }}>{children}</ul>,
            ol: ({ children }) => <ol style={{ marginBottom: '12px', paddingLeft: '20px' }}>{children}</ol>,
            li: ({ children }) => <li style={{ marginBottom: '4px', lineHeight: '1.4' }}>{children}</li>,
            code: ({ children, className, ...props }) => {
              const inline = !className?.includes('language-');
              return inline ? (
                <code 
                  style={{ 
                    backgroundColor: '#f1f3f4', 
                    padding: '2px 4px', 
                    borderRadius: '3px', 
                    fontSize: '13px',
                    fontFamily: 'Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
                  }}
                  {...props}
                >
                  {children}
                </code>
              ) : (
                <pre style={{ 
                  backgroundColor: '#f8f9fa', 
                  padding: '12px', 
                  borderRadius: '6px', 
                  overflow: 'auto',
                  marginBottom: '12px',
                  border: '1px solid #e9ecef'
                }}>
                  <code 
                    style={{ 
                      fontSize: '13px',
                      fontFamily: 'Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
                    }}
                    className={className}
                    {...props}
                  >
                    {children}
                  </code>
                </pre>
              );
            },
            blockquote: ({ children }) => (
              <blockquote style={{ 
                borderLeft: '4px solid #007bff', 
                paddingLeft: '12px', 
                marginLeft: '0',
                marginBottom: '12px',
                fontStyle: 'italic',
                color: '#666'
              }}>
                {children}
              </blockquote>
            ),
            table: ({ children }) => (
              <table style={{ 
                borderCollapse: 'collapse', 
                width: '100%', 
                marginBottom: '12px',
                fontSize: '13px'
              }}>
                {children}
              </table>
            ),
            th: ({ children }) => (
              <th style={{ 
                border: '1px solid #ddd', 
                padding: '8px', 
                backgroundColor: '#f8f9fa',
                fontWeight: 'bold',
                textAlign: 'left'
              }}>
                {children}
              </th>
            ),
            td: ({ children }) => (
              <td style={{ 
                border: '1px solid #ddd', 
                padding: '8px'
              }}>
                {children}
              </td>
            ),
            strong: ({ children }) => <strong style={{ fontWeight: '600' }}>{children}</strong>,
            em: ({ children }) => <em style={{ fontStyle: 'italic' }}>{children}</em>,
            a: ({ children, href }) => (
              <a 
                href={href} 
                target="_blank" 
                rel="noopener noreferrer"
                style={{ 
                  color: '#007bff', 
                  textDecoration: 'none'
                }}
                onMouseOver={(e) => e.currentTarget.style.textDecoration = 'underline'}
                onMouseOut={(e) => e.currentTarget.style.textDecoration = 'none'}
              >
                {children}
              </a>
            )
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  };

  // Get available models for current provider
  const getAvailableModels = () => {
    return llmService.getAvailableModels(llmSettings.provider);
  };

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: '600px',
    border: '1px solid #ddd',
    borderRadius: '8px',
    backgroundColor: '#fff',
    ...style
  };

  const headerStyle: React.CSSProperties = {
    padding: '16px',
    borderBottom: '1px solid #eee',
    backgroundColor: '#f8f9fa',
    borderRadius: '8px 8px 0 0',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center'
  };

  const messagesStyle: React.CSSProperties = {
    flex: 1,
    overflowY: 'auto',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px'
  };

  const inputAreaStyle: React.CSSProperties = {
    padding: '16px',
    borderTop: '1px solid #eee'
  };

  const messageStyle = (role: 'user' | 'assistant'): React.CSSProperties => ({
    padding: '12px 16px',
    borderRadius: '12px',
    maxWidth: '80%',
    alignSelf: role === 'user' ? 'flex-end' : 'flex-start',
    backgroundColor: role === 'user' ? '#007bff' : '#f1f3f4',
    color: role === 'user' ? '#fff' : '#333',
    wordWrap: 'break-word'
  });

  const buttonStyle: React.CSSProperties = {
    padding: '8px 16px',
    border: 'none',
    borderRadius: '4px',
    backgroundColor: '#007bff',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '14px'
  };

  const textareaStyle: React.CSSProperties = {
    width: '100%',
    minHeight: '60px',
    padding: '12px',
    border: '1px solid #ddd',
    borderRadius: '4px',
    resize: 'vertical',
    fontSize: '14px',
    fontFamily: 'inherit'
  };

  return (
    <div className={`chat-interface ${className}`} style={containerStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '18px', fontWeight: '600' }}>💬</span>
          <span style={{ fontSize: '16px', fontWeight: '600' }}>Code Assistant</span>
          <span style={{ 
            fontSize: '12px', 
            color: '#666',
            backgroundColor: '#e9ecef',
            padding: '2px 8px',
            borderRadius: '12px'
          }}>
            {llmService.getProviderDisplayName(llmSettings.provider)}
          </span>
        </div>
        
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={() => setShowSessionManager(!showSessionManager)}
            style={{
              ...buttonStyle,
              backgroundColor: showSessionManager ? '#28a745' : '#6c757d',
              fontSize: '12px',
              padding: '6px 12px'
            }}
            title="Manage chat sessions"
          >
            💬 Sessions ({sessions.length})
          </button>
          <button
            onClick={createNewSession}
            style={{
              ...buttonStyle,
              backgroundColor: '#17a2b8',
              fontSize: '12px',
              padding: '6px 12px'
            }}
            title="Start new conversation"
          >
            ➕ New
          </button>
          <button
            onClick={() => setShowSettings(!showSettings)}
            style={{ ...buttonStyle, fontSize: '12px', padding: '6px 12px' }}
            title="Settings"
          >
            ⚙️
          </button>
          <button
            onClick={clearConversation}
            style={{
              ...buttonStyle,
              backgroundColor: '#dc3545',
              fontSize: '12px',
              padding: '6px 12px'
            }}
            title="Clear conversation"
          >
            🗑️
          </button>
        </div>
      </div>

      {/* Settings Panel */}
      {showSettings && (
        <div style={{
          padding: '16px',
          backgroundColor: '#f8f9fa',
          borderBottom: '1px solid #eee'
        }}>
          <h4 style={{ margin: '0 0 12px 0', fontSize: '14px' }}>LLM Configuration</h4>
          
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
            <div>
              <label style={{ fontSize: '12px', color: '#666' }}>Provider</label>
              <select
                value={llmSettings.provider}
                onChange={(e) => setLLMSettings(prev => ({
                  ...prev,
                  provider: e.target.value as LLMProvider,
                  model: llmService.getAvailableModels(e.target.value as LLMProvider)[0]
                }))}
                style={{ width: '100%', padding: '6px', fontSize: '14px' }}
              >
                <option value="openai">OpenAI</option>
                <option value="azure-openai">Azure OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="gemini">Google Gemini</option>
              </select>
            </div>
            
            <div>
              <label style={{ fontSize: '12px', color: '#666' }}>
                {llmSettings.provider === 'azure-openai' ? 'Deployment Name' : 'Model'}
              </label>
              {llmSettings.provider === 'azure-openai' ? (
                <input
                  type="text"
                  value={llmSettings.model}
                  onChange={(e) => setLLMSettings(prev => ({ ...prev, model: e.target.value }))}
                  placeholder="gpt-4.1-mini-v2"
                  style={{ width: '100%', padding: '6px', fontSize: '14px' }}
                />
              ) : (
                <select
                  value={llmSettings.model}
                  onChange={(e) => setLLMSettings(prev => ({ ...prev, model: e.target.value }))}
                  style={{ width: '100%', padding: '6px', fontSize: '14px' }}
                >
                  {getAvailableModels().map(model => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
              )}
            </div>
          </div>

          <div style={{ marginBottom: '12px' }}>
            <label style={{ fontSize: '12px', color: '#666' }}>API Key</label>
            <input
              type="password"
              value={llmSettings.apiKey}
              onChange={(e) => setLLMSettings(prev => ({ ...prev, apiKey: e.target.value }))}
              placeholder={
                llmSettings.provider === 'azure-openai' ? 'Your Azure OpenAI key...' :
                llmSettings.provider === 'anthropic' ? 'sk-ant-...' :
                llmSettings.provider === 'gemini' ? 'Your Google API key...' : 'sk-...'
              }
              style={{ width: '100%', padding: '6px', fontSize: '14px' }}
            />
          </div>

          {/* Azure OpenAI Specific Fields */}
          {llmSettings.provider === 'azure-openai' && (
            <>
              <div style={{ marginBottom: '12px' }}>
                <label style={{ fontSize: '12px', color: '#666' }}>Azure OpenAI Endpoint</label>
                <input
                  type="text"
                  value={llmSettings.azureOpenAIEndpoint || ''}
                  onChange={(e) => setLLMSettings(prev => ({ ...prev, azureOpenAIEndpoint: e.target.value }))}
                  placeholder="https://your-resource.openai.azure.com"
                  style={{ width: '100%', padding: '6px', fontSize: '14px' }}
                />
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label style={{ fontSize: '12px', color: '#666' }}>API Version</label>
                <input
                  type="text"
                  value={llmSettings.azureOpenAIApiVersion || '2024-02-01'}
                  onChange={(e) => setLLMSettings(prev => ({ ...prev, azureOpenAIApiVersion: e.target.value }))}
                  placeholder="2024-02-01"
                  style={{ width: '100%', padding: '6px', fontSize: '14px' }}
                />
              </div>
            </>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <label style={{ fontSize: '12px', color: '#666' }}>
                Temperature: {llmSettings.temperature}
              </label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={llmSettings.temperature}
                onChange={(e) => setLLMSettings(prev => ({ ...prev, temperature: parseFloat(e.target.value) }))}
                style={{ width: '100%' }}
              />
            </div>
            
            <div>
              <label style={{ fontSize: '12px', color: '#666' }}>Max Tokens</label>
              <input
                type="number"
                min="100"
                max="8000"
                step="100"
                value={llmSettings.maxTokens}
                onChange={(e) => setLLMSettings(prev => ({ ...prev, maxTokens: parseInt(e.target.value) }))}
                style={{ width: '100%', padding: '6px', fontSize: '14px' }}
              />
            </div>
          </div>

          {/* Save Button */}
          <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button
              onClick={() => {
                // Save to localStorage
                localStorage.setItem('llm_provider', llmSettings.provider);
                localStorage.setItem('llm_api_key', llmSettings.apiKey);
                if (llmSettings.azureOpenAIEndpoint) {
                  localStorage.setItem('azure_openai_endpoint', llmSettings.azureOpenAIEndpoint);
                }
                // For Azure OpenAI, the model field contains the deployment name
                if (llmSettings.provider === 'azure-openai' && llmSettings.model) {
                  localStorage.setItem('azure_openai_deployment', llmSettings.model);
                }
                if (llmSettings.azureOpenAIApiVersion) {
                  localStorage.setItem('azure_openai_api_version', llmSettings.azureOpenAIApiVersion);
                }
                setShowSettings(false);
                alert('Settings saved successfully!');
              }}
              style={{
                ...buttonStyle,
                backgroundColor: '#28a745',
                fontSize: '12px',
                padding: '8px 16px'
              }}
            >
              💾 Save Settings
            </button>
            <button
              onClick={() => setShowSettings(false)}
              style={{
                ...buttonStyle,
                backgroundColor: '#6c757d',
                fontSize: '12px',
                padding: '8px 16px'
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Session Manager Panel */}
      {showSessionManager && (
        <div style={{
          padding: '16px',
          backgroundColor: '#f8f9fa',
          borderBottom: '1px solid #eee',
          maxHeight: '300px',
          overflowY: 'auto'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h4 style={{ margin: '0', fontSize: '14px' }}>Chat Sessions</h4>
            <button
              onClick={createNewSession}
              style={{
                ...buttonStyle,
                backgroundColor: '#28a745',
                fontSize: '12px',
                padding: '4px 8px'
              }}
            >
              ➕ New Session
            </button>
          </div>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {sessions.map((session) => (
              <div
                key={session.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px',
                  backgroundColor: session.isActive ? '#e3f2fd' : '#fff',
                  border: session.isActive ? '2px solid #2196f3' : '1px solid #ddd',
                  borderRadius: '4px',
                  cursor: 'pointer'
                }}
                onClick={() => switchSession(session.id)}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ 
                    fontSize: '13px', 
                    fontWeight: session.isActive ? '600' : '400',
                    marginBottom: '2px'
                  }}>
                    {session.name}
                  </div>
                  <div style={{ fontSize: '11px', color: '#666' }}>
                    {session.messageCount} messages • {new Date(session.lastAccessed).toLocaleDateString()}
                    {session.projectName && ` • ${session.projectName}`}
                  </div>
                </div>
                
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const newName = prompt('Enter new name:', session.name);
                      if (newName && newName.trim()) {
                        renameSession(session.id, newName.trim());
                      }
                    }}
                    style={{
                      ...buttonStyle,
                      backgroundColor: '#ffc107',
                      color: '#000',
                      fontSize: '10px',
                      padding: '2px 6px'
                    }}
                    title="Rename session"
                  >
                    ✏️
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteSession(session.id);
                    }}
                    style={{
                      ...buttonStyle,
                      backgroundColor: '#dc3545',
                      fontSize: '10px',
                      padding: '2px 6px'
                    }}
                    title="Delete session"
                  >
                    🗑️
                  </button>
                </div>
              </div>
            ))}
            
            {sessions.length === 0 && (
              <div style={{ 
                textAlign: 'center', 
                color: '#666', 
                fontSize: '12px', 
                padding: '20px' 
              }}>
                No chat sessions yet. Start a new conversation!
              </div>
            )}
          </div>
          
          <div style={{ 
            marginTop: '12px', 
            padding: '8px', 
            backgroundColor: '#e9ecef', 
            borderRadius: '4px',
            fontSize: '11px',
            color: '#666'
          }}>
            💡 Sessions are automatically saved to your browser's local storage. 
            Each session maintains its own conversation history and can cache query results for faster responses.
          </div>
        </div>
      )}

      {/* Messages */}
      <div style={messagesStyle}>
        {messages.length === 0 && (
          <div style={{
            textAlign: 'center',
            color: '#666',
            fontSize: '14px',
            padding: '40px 20px'
          }}>
            <div style={{ fontSize: '48px', marginBottom: '16px', opacity: 0.3 }}>💬</div>
            <div>Ask me anything about the codebase!</div>
            <div style={{ fontSize: '12px', marginTop: '8px', color: '#999' }}>
              I can help you understand functions, classes, dependencies, and more.
            </div>
                         {(!graph || !graph.nodes || graph.nodes.length === 0) && (
               <div style={{ 
                 marginTop: '20px', 
                 padding: '12px', 
                 backgroundColor: '#fff3cd', 
                 border: '1px solid #ffeaa7',
                 borderRadius: '4px',
                 color: '#856404'
               }}>
                 <strong>⚠️ No codebase loaded</strong><br />
                 Please load a repository first to start analyzing code.<br />
                 <small style={{ fontSize: '11px', opacity: 0.8 }}>
                   The knowledge graph is being built in the background. Once complete, you'll be able to ask questions.
                 </small>
               </div>
             )}
          </div>
        )}

        {messages.map((message) => (
          <div key={message.id}>
            <div style={messageStyle(message.role)}>
              <div style={{ marginBottom: message.metadata ? '8px' : '0' }}>
                <MarkdownContent content={message.content} role={message.role} />
              </div>
              
              {/* Reasoning Section for Assistant Messages */}
              {message.role === 'assistant' && message.metadata?.reasoning && (
                <ReasoningSection reasoning={message.metadata.reasoning} />
              )}
              
              {/* Simple Metadata */}
              {message.metadata && (
                <div style={{ fontSize: '12px', opacity: 0.8, marginTop: '8px' }}>
                  {message.metadata.confidence && (
                    <div style={{ marginBottom: '4px' }}>
                      Confidence: {Math.round(message.metadata.confidence * 100)}%
                    </div>
                  )}
                  
                  {message.metadata.sources && message.metadata.sources.length > 0 && (
                    <div style={{ marginBottom: '4px' }}>
                      Sources: {message.metadata.sources.join(', ')}
                    </div>
                  )}
                  
                  {message.metadata.cypherQueries && message.metadata.cypherQueries.length > 0 && (
                    <details style={{ marginTop: '8px' }}>
                      <summary style={{ cursor: 'pointer', fontSize: '11px' }}>
                        View Queries ({message.metadata.cypherQueries.length})
                      </summary>
                      {message.metadata.cypherQueries.map((query, index) => (
                        <div key={index} style={{ 
                          marginTop: '4px', 
                          padding: '8px', 
                          backgroundColor: 'rgba(0,0,0,0.1)', 
                          borderRadius: '4px',
                          fontFamily: 'monospace',
                          fontSize: '11px'
                        }}>
                          <div><strong>Query:</strong> {query.cypher}</div>
                          <div><strong>Explanation:</strong> {query.explanation}</div>
                        </div>
                      ))}
                    </details>
                  )}
                </div>
              )}
            </div>
            
            <div style={{
              fontSize: '11px',
              color: '#999',
              textAlign: message.role === 'user' ? 'right' : 'left',
              marginTop: '4px'
            }}>
              {message.timestamp.toLocaleTimeString()}
            </div>
          </div>
        ))}

        {isLoading && (
          <div style={messageStyle('assistant')}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ 
                width: '16px', 
                height: '16px', 
                border: '2px solid #ccc',
                borderTop: '2px solid #007bff',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite'
              }} />
              Thinking...
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div style={inputAreaStyle}>
        <form onSubmit={handleSubmit} style={{ display: 'flex', gap: '8px' }}>
          <textarea
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Ask a question about the code..."
            style={textareaStyle}
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !inputValue.trim()}
            style={{
              ...buttonStyle,
              minWidth: '80px',
              opacity: (isLoading || !inputValue.trim()) ? 0.5 : 1
            }}
          >
            {isLoading ? '...' : 'Send'}
          </button>
        </form>
      </div>

      {/* CSS for spinner animation and syntax highlighting */}
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }

        /* Syntax highlighting styles */
        .hljs {
          background: #f8f9fa !important;
          color: #333 !important;
        }
        
        .hljs-keyword,
        .hljs-selector-tag,
        .hljs-title,
        .hljs-section,
        .hljs-doctag,
        .hljs-name,
        .hljs-strong {
          color: #d73a49;
        }
        
        .hljs-string,
        .hljs-title,
        .hljs-section,
        .hljs-built_in,
        .hljs-literal,
        .hljs-type,
        .hljs-addition,
        .hljs-tag,
        .hljs-quote,
        .hljs-name,
        .hljs-selector-id,
        .hljs-selector-class {
          color: #032f62;
        }
        
        .hljs-comment,
        .hljs-quote,
        .hljs-variable,
        .hljs-template-variable,
        .hljs-attribute,
        .hljs-tag,
        .hljs-name,
        .hljs-regexp,
        .hljs-link,
        .hljs-name,
        .hljs-selector-id,
        .hljs-selector-class {
          color: #6f42c1;
        }
        
        .hljs-number,
        .hljs-meta,
        .hljs-built_in,
        .hljs-builtin-name,
        .hljs-literal,
        .hljs-type,
        .hljs-params {
          color: #005cc5;
        }
        
        .hljs-attr,
        .hljs-variable,
        .hljs-template-variable,
        .hljs-type,
        .hljs-built_in,
        .hljs-builtin-name,
        .hljs-symbol,
        .hljs-bullet,
        .hljs-link,
        .hljs-meta,
        .hljs-selector-attr,
        .hljs-selector-pseudo {
          color: #e36209;
        }

        /* Custom markdown styles */
        .chat-interface .markdown-content {
          line-height: 1.6;
        }
        
        .chat-interface .markdown-content > *:first-child {
          margin-top: 0;
        }
        
        .chat-interface .markdown-content > *:last-child {
          margin-bottom: 0;
        }
        
        /* Better spacing for lists */
        .chat-interface .markdown-content ul,
        .chat-interface .markdown-content ol {
          margin: 8px 0 12px 0;
        }
        
        .chat-interface .markdown-content li {
          margin-bottom: 2px;
        }
        
        /* Code block improvements */
        .chat-interface .markdown-content pre {
          max-width: 100%;
          overflow-x: auto;
          white-space: pre-wrap;
          word-wrap: break-word;
        }
        
        /* Table improvements */
        .chat-interface .markdown-content table {
          max-width: 100%;
          overflow-x: auto;
          display: block;
          white-space: nowrap;
        }
        
        .chat-interface .markdown-content thead,
        .chat-interface .markdown-content tbody,
        .chat-interface .markdown-content tr {
          display: table;
          width: 100%;
          table-layout: fixed;
        }
      `}</style>
    </div>
  );
};

export default ChatInterface; 
