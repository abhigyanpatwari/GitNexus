import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Code, PanelLeftClose, PanelLeft, Trash2, X, Target, FileCode, Sparkles, MousePointerClick } from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useAppState } from '../hooks/useAppState';
import { NODE_COLORS } from '../lib/constants';

/** Map file extension to Prism syntax highlighter language identifier */
const getSyntaxLanguage = (filePath: string | undefined): string => {
  if (!filePath) return 'text';
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'js': case 'jsx': case 'mjs': case 'cjs': return 'javascript';
    case 'ts': case 'tsx': case 'mts': case 'cts': return 'typescript';
    case 'py': case 'pyw': return 'python';
    case 'rb': case 'rake': case 'gemspec': return 'ruby';
    case 'java': return 'java';
    case 'go': return 'go';
    case 'rs': return 'rust';
    case 'c': case 'h': return 'c';
    case 'cpp': case 'cc': case 'cxx': case 'hpp': case 'hxx': case 'hh': return 'cpp';
    case 'cs': return 'csharp';
    case 'php': return 'php';
    case 'kt': case 'kts': return 'kotlin';
    case 'swift': return 'swift';
    case 'json': return 'json';
    case 'yaml': case 'yml': return 'yaml';
    case 'md': case 'mdx': return 'markdown';
    case 'html': case 'htm': case 'erb': return 'markup';
    case 'css': case 'scss': case 'sass': return 'css';
    case 'sh': case 'bash': case 'zsh': return 'bash';
    case 'sql': return 'sql';
    case 'xml': return 'xml';
    default: break;
  }
  // Handle extensionless Ruby files
  const basename = filePath.split('/').pop() || '';
  if (['Rakefile', 'Gemfile', 'Guardfile', 'Vagrantfile', 'Brewfile'].includes(basename)) return 'ruby';
  if (['Makefile'].includes(basename)) return 'makefile';
  if (['Dockerfile'].includes(basename)) return 'docker';
  return 'text';
};

// Match the code theme used elsewhere in the app
const customTheme = {
  ...vscDarkPlus,
  'pre[class*="language-"]': {
    ...vscDarkPlus['pre[class*="language-"]'],
    background: '#0a0a10',
    margin: 0,
    padding: '12px 0',
    fontSize: '13px',
    lineHeight: '1.6',
  },
  'code[class*="language-"]': {
    ...vscDarkPlus['code[class*="language-"]'],
    background: 'transparent',
    fontFamily: '"JetBrains Mono", "Fira Code", monospace',
  },
};

export interface CodeReferencesPanelProps {
  onFocusNode: (nodeId: string) => void;
}

export const CodeReferencesPanel = ({ onFocusNode }: CodeReferencesPanelProps) => {
  const {
    graph,
    fileContents,
    selectedNode,
    codeReferences,
    removeCodeReference,
    clearCodeReferences,
    setSelectedNode,
    codeReferenceFocus,
  } = useAppState();

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [glowRefId, setGlowRefId] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const refCardEls = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const glowTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (glowTimerRef.current) {
        window.clearTimeout(glowTimerRef.current);
        glowTimerRef.current = null;
      }
    };
  }, []);

  const [panelWidth, setPanelWidth] = useState<number>(() => {
    try {
      const saved = window.localStorage.getItem('gitnexus.codePanelWidth');
      const parsed = saved ? parseInt(saved, 10) : NaN;
      if (!Number.isFinite(parsed)) return 560; // increased default
      return Math.max(420, Math.min(parsed, 900));
    } catch {
      return 560;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem('gitnexus.codePanelWidth', String(panelWidth));
    } catch {
      // ignore
    }
  }, [panelWidth]);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { startX: e.clientX, startWidth: panelWidth };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      const state = resizeRef.current;
      if (!state) return;
      const delta = ev.clientX - state.startX;
      const next = Math.max(420, Math.min(state.startWidth + delta, 900));
      setPanelWidth(next);
    };

    const onUp = () => {
      resizeRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [panelWidth]);

  const aiReferences = useMemo(() => codeReferences.filter(r => r.source === 'ai'), [codeReferences]);

  // When the user clicks a citation badge in chat, focus the corresponding snippet card:
  // - expand the panel if collapsed
  // - smooth-scroll the card into view
  // - briefly glow it for discoverability
  useEffect(() => {
    if (!codeReferenceFocus) return;

    // Ensure panel is expanded
    setIsCollapsed(false);

    const { filePath, startLine, endLine } = codeReferenceFocus;
    const target =
      aiReferences.find(r =>
        r.filePath === filePath &&
        r.startLine === startLine &&
        r.endLine === endLine
      ) ??
      aiReferences.find(r => r.filePath === filePath);

    if (!target) return;

    // Double rAF: wait for collapse state + list DOM to render.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = refCardEls.current.get(target.id);
        if (!el) return;

        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setGlowRefId(target.id);

        if (glowTimerRef.current) {
          window.clearTimeout(glowTimerRef.current);
        }
        glowTimerRef.current = window.setTimeout(() => {
          setGlowRefId((prev) => (prev === target.id ? null : prev));
          glowTimerRef.current = null;
        }, 1200);
      });
    });
  }, [codeReferenceFocus?.ts, aiReferences]);

  const refsWithSnippets = useMemo(() => {
    return aiReferences.map((ref) => {
      const content = fileContents.get(ref.filePath);
      if (!content) {
        return { ref, content: null as string | null, start: 0, end: 0, highlightStart: 0, highlightEnd: 0, totalLines: 0 };
      }

      const lines = content.split('\n');
      const totalLines = lines.length;

      const startLine = ref.startLine ?? 0;
      const endLine = ref.endLine ?? startLine;

      const contextBefore = 3;
      const contextAfter = 20;
      const start = Math.max(0, startLine - contextBefore);
      const end = Math.min(totalLines - 1, endLine + contextAfter);

      return {
        ref,
        content: lines.slice(start, end + 1).join('\n'),
        start,
        end,
        highlightStart: Math.max(0, startLine - start),
        highlightEnd: Math.max(0, endLine - start),
        totalLines,
      };
    });
  }, [aiReferences, fileContents]);

  const selectedFilePath = selectedNode?.properties?.filePath;
  const selectedFileContent = selectedFilePath ? fileContents.get(selectedFilePath) : undefined;
  const selectedIsFile = selectedNode?.label === 'File' && !!selectedFilePath;
  const showSelectedViewer = !!selectedNode && !!selectedFilePath;
  const showCitations = aiReferences.length > 0;

  if (isCollapsed) {
    return (
      <aside className="h-full w-12 bg-surface border-r border-border-subtle flex flex-col items-center py-3 gap-2 flex-shrink-0">
        <button
          onClick={() => setIsCollapsed(false)}
          className="p-2 text-text-secondary hover:text-cyan-400 hover:bg-cyan-500/10 rounded transition-colors"
          title="Expand Code Panel"
        >
          <PanelLeft className="w-5 h-5" />
        </button>
        <div className="w-6 h-px bg-border-subtle my-1" />
        {showSelectedViewer && (
          <div className="text-[9px] text-amber-400 rotate-90 whitespace-nowrap font-medium tracking-wide">
            SELECTED
          </div>
        )}
        {showCitations && (
          <div className="text-[9px] text-cyan-400 rotate-90 whitespace-nowrap font-medium tracking-wide mt-4">
            AI • {aiReferences.length}
          </div>
        )}
      </aside>
    );
  }

  return (
    <aside
      ref={(el) => { panelRef.current = el; }}
      className="h-full bg-surface/95 backdrop-blur-md border-r border-border-subtle flex flex-col animate-slide-in relative shadow-2xl"
      style={{ width: panelWidth }}
    >
      {/* Resize handle */}
      <div
        onMouseDown={startResize}
        className="absolute top-0 right-0 h-full w-2 cursor-col-resize bg-transparent hover:bg-cyan-500/25 transition-colors"
        title="Drag to resize"
      />
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border-subtle bg-gradient-to-r from-elevated/60 to-surface/60">
        <div className="flex items-center gap-2">
          <Code className="w-4 h-4 text-cyan-400" />
          <span className="text-sm font-semibold text-text-primary">Code Inspector</span>
        </div>
        <div className="flex items-center gap-1.5">
          {showCitations && (
            <button
              onClick={() => clearCodeReferences()}
              className="p-1.5 text-text-muted hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
              title="Clear AI citations"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={() => setIsCollapsed(true)}
            className="p-1.5 text-text-muted hover:text-text-primary hover:bg-hover rounded transition-colors"
            title="Collapse Panel"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {/* Top: Selected file viewer (when a node is selected) */}
        {showSelectedViewer && (
          <div className={`${showCitations ? 'h-[42%]' : 'flex-1'} min-h-0 flex flex-col`}>
            <div className="px-3 py-2 bg-gradient-to-r from-amber-500/8 to-orange-500/5 border-b border-amber-500/20 flex items-center gap-2">
              <div className="flex items-center gap-1.5 px-2 py-0.5 bg-amber-500/15 rounded-md border border-amber-500/25">
                <MousePointerClick className="w-3 h-3 text-amber-400" />
                <span className="text-[10px] text-amber-300 font-semibold uppercase tracking-wide">Selected</span>
              </div>
              <FileCode className="w-3.5 h-3.5 text-amber-400/70 ml-1" />
              <span className="text-xs text-text-primary font-mono truncate flex-1">
                {selectedNode?.properties?.filePath?.split('/').pop() ?? selectedNode?.properties?.name}
              </span>
              <button
                onClick={() => setSelectedNode(null)}
                className="p-1 text-text-muted hover:text-amber-400 hover:bg-amber-500/10 rounded transition-colors"
                title="Clear selection"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-auto scrollbar-thin">
              {selectedFileContent ? (
                <SyntaxHighlighter
                  language={getSyntaxLanguage(selectedFilePath)}
                  style={customTheme as any}
                  showLineNumbers
                  startingLineNumber={1}
                  lineNumberStyle={{
                    minWidth: '3em',
                    paddingRight: '1em',
                    color: '#5a5a70',
                    textAlign: 'right',
                    userSelect: 'none',
                  }}
                  lineProps={(lineNumber) => {
                    const startLine = selectedNode?.properties?.startLine;
                    const endLine = selectedNode?.properties?.endLine ?? startLine;
                    const isHighlighted =
                      typeof startLine === 'number' &&
                      lineNumber >= startLine + 1 &&
                      lineNumber <= (endLine ?? startLine) + 1;
                    return {
                      style: {
                        display: 'block',
                        backgroundColor: isHighlighted ? 'rgba(6, 182, 212, 0.14)' : 'transparent',
                        borderLeft: isHighlighted ? '3px solid #06b6d4' : '3px solid transparent',
                        paddingLeft: '12px',
                        paddingRight: '16px',
                      },
                    };
                  }}
                  wrapLines
                >
                  {selectedFileContent}
                </SyntaxHighlighter>
              ) : (
                <div className="px-3 py-3 text-sm text-text-muted">
                  {selectedIsFile ? (
                    <>Code not available in memory for <span className="font-mono">{selectedFilePath}</span></>
                  ) : (
                    <>Select a file node to preview its contents.</>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Divider between Selected viewer and AI refs (more visible) */}
        {showSelectedViewer && showCitations && (
          <div className="h-1.5 bg-gradient-to-r from-transparent via-border-subtle to-transparent" />
        )}

        {/* Bottom: AI citations list */}
        {showCitations && (
          <div className="flex-1 min-h-0 flex flex-col">
            {/* AI Citations Section Header */}
            <div className="px-3 py-2 bg-gradient-to-r from-cyan-500/8 to-teal-500/5 border-b border-cyan-500/20 flex items-center gap-2">
              <div className="flex items-center gap-1.5 px-2 py-0.5 bg-cyan-500/15 rounded-md border border-cyan-500/25">
                <Sparkles className="w-3 h-3 text-cyan-400" />
                <span className="text-[10px] text-cyan-300 font-semibold uppercase tracking-wide">AI Citations</span>
              </div>
              <span className="text-xs text-text-muted ml-1">{aiReferences.length} reference{aiReferences.length !== 1 ? 's' : ''}</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-3 space-y-3">
            {refsWithSnippets.map(({ ref, content, start, highlightStart, highlightEnd, totalLines }) => {
          const nodeColor = ref.label ? (NODE_COLORS as any)[ref.label] || '#6b7280' : '#6b7280';
          const hasRange = typeof ref.startLine === 'number';
          const startDisplay = hasRange ? (ref.startLine ?? 0) + 1 : undefined;
          const endDisplay = hasRange ? (ref.endLine ?? ref.startLine ?? 0) + 1 : undefined;
          const language = getSyntaxLanguage(ref.filePath);

          const isGlowing = glowRefId === ref.id;

          return (
            <div
              key={ref.id}
              ref={(el) => { refCardEls.current.set(ref.id, el); }}
              className={[
                'bg-elevated border border-border-subtle rounded-xl overflow-hidden transition-all',
                isGlowing ? 'ring-2 ring-cyan-300/70 shadow-[0_0_0_6px_rgba(34,211,238,0.14)] animate-pulse' : '',
              ].join(' ')}
            >
              <div className="px-3 py-2 border-b border-border-subtle bg-surface/40 flex items-start gap-2">
                <span
                  className="mt-0.5 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide flex-shrink-0"
                  style={{ backgroundColor: nodeColor, color: '#06060a' }}
                  title={ref.label ?? 'Code'}
                >
                  {ref.label ?? 'Code'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-text-primary font-medium truncate">
                    {ref.name ?? ref.filePath.split('/').pop() ?? ref.filePath}
                  </div>
                  <div className="text-[11px] text-text-muted font-mono truncate">
                    {ref.filePath}
                    {startDisplay !== undefined && (
                      <span className="text-text-secondary">
                        {' '}
                        • L{startDisplay}
                        {endDisplay !== startDisplay ? `–${endDisplay}` : ''}
                      </span>
                    )}
                    {totalLines > 0 && <span className="text-text-muted"> • {totalLines} lines</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {ref.nodeId && (
                    <button
                      onClick={() => {
                        const nodeId = ref.nodeId!;
                        // Sync selection + focus graph
                        if (graph) {
                          const node = graph.nodes.find((n) => n.id === nodeId);
                          if (node) setSelectedNode(node);
                        }
                        onFocusNode(nodeId);
                      }}
                      className="p-1.5 text-text-muted hover:text-text-primary hover:bg-hover rounded transition-colors"
                      title="Focus in graph"
                    >
                      <Target className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    onClick={() => removeCodeReference(ref.id)}
                    className="p-1.5 text-text-muted hover:text-text-primary hover:bg-hover rounded transition-colors"
                    title="Remove"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto">
                {content ? (
                  <SyntaxHighlighter
                    language={language}
                    style={customTheme as any}
                    showLineNumbers
                    startingLineNumber={start + 1}
                    lineNumberStyle={{
                      minWidth: '3em',
                      paddingRight: '1em',
                      color: '#5a5a70',
                      textAlign: 'right',
                      userSelect: 'none',
                    }}
                    lineProps={(lineNumber) => {
                      const isHighlighted =
                        hasRange &&
                        lineNumber >= start + highlightStart + 1 &&
                        lineNumber <= start + highlightEnd + 1;
                      return {
                        style: {
                          display: 'block',
                          backgroundColor: isHighlighted ? 'rgba(6, 182, 212, 0.14)' : 'transparent',
                          borderLeft: isHighlighted ? '3px solid #06b6d4' : '3px solid transparent',
                          paddingLeft: '12px',
                          paddingRight: '16px',
                        },
                      };
                    }}
                    wrapLines
                  >
                    {content}
                  </SyntaxHighlighter>
                ) : (
                  <div className="px-3 py-3 text-sm text-text-muted">
                    Code not available in memory for <span className="font-mono">{ref.filePath}</span>
                  </div>
                )}
              </div>
            </div>
          );
            })}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
