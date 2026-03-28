import React, { useState } from 'react';
import { X, GitBranch, Search, Filter, Zap, Keyboard, BarChart2, HelpCircle } from 'lucide-react';

interface HelpPanelProps {
  isOpen: boolean;
  onClose: () => void;
  nodeCount: number;
  edgeCount: number;
}

type TabId = 'overview' | 'graph' | 'search' | 'ai' | 'shortcuts' | 'status';

interface Tab {
  id: TabId;
  label: string;
  icon: React.ReactNode;
}

const tabs: Tab[] = [
  { id: 'overview', label: 'Overview', icon: <HelpCircle className="h-4 w-4" /> },
  { id: 'graph', label: 'Graph & nodes', icon: <GitBranch className="h-4 w-4" /> },
  { id: 'search', label: 'Search & filter', icon: <Search className="h-4 w-4" /> },
  { id: 'ai', label: 'Nexus AI', icon: <Zap className="h-4 w-4" /> },
  { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard className="h-4 w-4" /> },
  { id: 'status', label: 'Status bar', icon: <BarChart2 className="h-4 w-4" /> },
];

const shortcuts = [
  { label: 'Search nodes', mac: '⌘ K', win: 'Ctrl K' },
  { label: 'Deselect / close', mac: 'Esc', win: 'Esc' },
];

const nodeColors = [
  { color: '#10b981', label: 'Function', desc: 'Function declarations' },
  { color: '#3b82f6', label: 'File', desc: 'Source files' },
  { color: '#f59e0b', label: 'Class', desc: 'Class declarations' },
  { color: '#14b8a6', label: 'Method', desc: 'Class methods' },
  { color: '#ec4899', label: 'Interface', desc: 'TypeScript interfaces' },
  { color: '#6366f1', label: 'Folder', desc: 'Directory nodes' },
];

const getStatusItems = (nodeCount: number, edgeCount: number) => [
  {
    badge: (
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: '#34d399',
          display: 'inline-block',
          flexShrink: 0,
        }}
      />
    ),
    title: 'Ready',
    desc: 'Graph is fully loaded and interactive',
  },
  {
    badge: (
      <span style={{ fontSize: 12, fontWeight: 500, color: '#a78bfa', flexShrink: 0 }}>
        {nodeCount}
      </span>
    ),
    title: 'Nodes count',
    desc: 'Total files and symbols in the graph',
  },
  {
    badge: (
      <span style={{ fontSize: 12, fontWeight: 500, color: '#60a5fa', flexShrink: 0 }}>
        {edgeCount}
      </span>
    ),
    title: 'Edges count',
    desc: 'Import / dependency connections',
  },
  {
    badge: (
      <span
        style={{
          fontSize: 11,
          fontWeight: 500,
          color: '#34d399',
          flexShrink: 0,
          whiteSpace: 'nowrap',
        }}
      >
        Semantic Ready
      </span>
    ),
    title: 'AI index status',
    desc: 'Repo is fully indexed for AI queries',
  },
  // { badge: <span style={{ fontSize: 11, fontWeight: 500, color: '#9ca3af', flexShrink: 0 }}>typescript</span>, title: 'Language', desc: 'Primary language detected in the repo' },
];

const kbdStyle: React.CSSProperties = {
  fontSize: 11,
  background: 'rgba(255,255,255,0.08)',
  borderRadius: 4,
  padding: '2px 8px',
  color: '#e2e2e8',
  fontFamily: 'monospace',
  border: '0.5px solid rgba(255,255,255,0.12)',
  whiteSpace: 'nowrap',
};

const kbdWinStyle: React.CSSProperties = {
  ...kbdStyle,
  color: '#93c5fd',
};

function TabContent({
  active,
  nodeCount,
  edgeCount,
}: {
  active: TabId;
  nodeCount: number;
  edgeCount: number;
}) {
  if (active === 'overview')
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <p
          style={{
            fontSize: 11,
            color: '#6b7280',
            margin: '0 0 4px',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          Getting started
        </p>

        <div
          style={{
            background: 'rgba(255,255,255,0.04)',
            borderRadius: 10,
            padding: '12px 14px',
            borderLeft: '2px solid #a78bfa',
          }}
        >
          <p style={{ fontSize: 13, fontWeight: 500, color: '#e2e2e8', margin: '0 0 4px' }}>
            What is GitNexus?
          </p>
          <p style={{ fontSize: 12, color: '#9ca3af', margin: 0, lineHeight: 1.6 }}>
            An interactive graph explorer for your codebase. Every file, function, and import
            becomes a node you can explore, query, and navigate visually.
          </p>
        </div>

        <div
          style={{
            background: 'rgba(255,255,255,0.04)',
            borderRadius: 10,
            padding: '12px 14px',
            borderLeft: '2px solid #34d399',
          }}
        >
          <p style={{ fontSize: 13, fontWeight: 500, color: '#e2e2e8', margin: '0 0 4px' }}>
            Your current repo
          </p>
          <p style={{ fontSize: 12, color: '#9ca3af', margin: 0, lineHeight: 1.6 }}>
            Loaded: <span style={{ color: '#a78bfa', fontFamily: 'monospace' }}></span> {nodeCount}{' '}
            nodes · {edgeCount} edges
          </p>
        </div>

        <div
          style={{
            background: 'rgba(255,255,255,0.04)',
            borderRadius: 10,
            padding: '12px 14px',
            borderLeft: '2px solid #60a5fa',
          }}
        >
          <p style={{ fontSize: 13, fontWeight: 500, color: '#e2e2e8', margin: '0 0 4px' }}>
            Three ways to explore
          </p>
          <p style={{ fontSize: 12, color: '#9ca3af', margin: 0, lineHeight: 1.6 }}>
            <strong style={{ color: '#e2e2e8', fontWeight: 500 }}>1.</strong> Click nodes to inspect
            <br />
            <strong style={{ color: '#e2e2e8', fontWeight: 500 }}>2.</strong> Search by name or type
            <br />
            <strong style={{ color: '#e2e2e8', fontWeight: 500 }}>3.</strong> Ask Nexus AI a natural
            language question
          </p>
        </div>

        <div
          style={{
            background: 'rgba(255,255,255,0.04)',
            borderRadius: 10,
            padding: '12px 14px',
            borderLeft: '2px solid #fbbf24',
          }}
        >
          <p style={{ fontSize: 13, fontWeight: 500, color: '#e2e2e8', margin: '0 0 4px' }}>
            Navigation
          </p>
          <p style={{ fontSize: 12, color: '#9ca3af', margin: 0, lineHeight: 1.6 }}>
            · Scroll to zoom <br />
            · Click and drag to pan <br />· Double-click a node to focus its subgraph
          </p>
        </div>
      </div>
    );

  if (active === 'graph')
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p
          style={{
            fontSize: 11,
            color: '#6b7280',
            margin: '0 0 4px',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          Node color legend
        </p>

        {nodeColors.map(({ color, label, desc }) => (
          <div key={label} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: color,
                flexShrink: 0,
                marginTop: 2,
              }}
            />
            <div>
              <p style={{ fontSize: 12, fontWeight: 500, color: '#e2e2e8', margin: '0 0 2px' }}>
                {label} nodes
              </p>
              <p style={{ fontSize: 12, color: '#9ca3af', margin: 0 }}>{desc}</p>
            </div>
          </div>
        ))}

        <div style={{ borderTop: '0.5px solid rgba(255,255,255,0.08)', margin: '4px 0' }} />

        <p style={{ fontSize: 12, color: '#9ca3af', margin: 0, lineHeight: 1.6 }}>
          Node <strong style={{ color: '#e2e2e8', fontWeight: 500 }}>size</strong> reflects
          connection count — larger nodes are depended on by more files. Edges point from importer →
          imported.
        </p>

        <div
          style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: '10px 14px' }}
        >
          <p style={{ fontSize: 12, color: '#9ca3af', margin: 0, lineHeight: 1.6 }}>
            Click any node to open its detail panel — showing imports, exports, and reverse
            dependencies.
          </p>
        </div>
      </div>
    );

  if (active === 'search')
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <p
          style={{
            fontSize: 11,
            color: '#6b7280',
            margin: '0 0 4px',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          Search & filter
        </p>

        <div
          style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: '12px 14px' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <kbd style={kbdStyle}>⌘K</kbd>/<kbd style={kbdStyle}>Ctrl K</kbd>
            <p style={{ fontSize: 12, fontWeight: 500, color: '#e2e2e8', margin: 0 }}>
              Search nodes
            </p>
          </div>
          <p style={{ fontSize: 12, color: '#9ca3af', margin: 0, lineHeight: 1.6 }}>
            Search by filename, function name, or import path. Matching nodes are highlighted live
            in the graph.
          </p>
        </div>

        <div
          style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: '12px 14px' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Filter style={{ width: 14, height: 14, color: '#a78bfa', flexShrink: 0 }} />
            <p style={{ fontSize: 12, fontWeight: 500, color: '#e2e2e8', margin: 0 }}>
              Filter panel
            </p>
          </div>
          <p style={{ fontSize: 12, color: '#9ca3af', margin: 0, lineHeight: 1.6 }}>
            Use the filter icon in the left sidebar to isolate specific node types, hide leaf nodes,
            or focus on a depth range from a selected root.
          </p>
        </div>

        <div
          style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: '12px 14px' }}
        >
          <p style={{ fontSize: 12, fontWeight: 500, color: '#e2e2e8', margin: '0 0 6px' }}>
            Search syntax
          </p>
          {[
            { query: 'auth', hint: 'match by name fragment' },
            { query: './utils/', hint: 'match by path prefix' },
            { query: 'type:config', hint: 'filter by node type' },
          ].map(({ query, hint }) => (
            <div
              key={query}
              style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}
            >
              <code
                style={{
                  fontSize: 11,
                  color: '#a78bfa',
                  background: 'rgba(167,139,250,0.1)',
                  borderRadius: 4,
                  padding: '1px 6px',
                  fontFamily: 'monospace',
                  flexShrink: 0,
                }}
              >
                {query}
              </code>
              <span style={{ fontSize: 12, color: '#6b7280' }}>{hint}</span>
            </div>
          ))}
        </div>
      </div>
    );

  if (active === 'ai')
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <p
          style={{
            fontSize: 11,
            color: '#6b7280',
            margin: '0 0 4px',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          Nexus AI
        </p>

        <div
          style={{
            background: 'rgba(167,139,250,0.08)',
            border: '0.5px solid rgba(167,139,250,0.25)',
            borderRadius: 10,
            padding: '12px 14px',
          }}
        >
          <p style={{ fontSize: 12, fontWeight: 500, color: '#a78bfa', margin: '0 0 4px' }}>
            ✓ Semantic Ready
          </p>
          <p style={{ fontSize: 12, color: '#9ca3af', margin: 0, lineHeight: 1.6 }}>
            Your repo is indexed and ready for semantic queries. Nexus AI understands code structure
            and relationships, not just file names.
          </p>
        </div>

        <p style={{ fontSize: 12, color: '#9ca3af', margin: '4px 0 2px' }}>Try asking:</p>
        {[
          '"Which files depend on the auth module?"',
          '"Find circular dependencies in this repo"',
          '"What are the most connected components?"',
          '"Show me all files that import useEffect"',
        ].map((q) => (
          <div
            key={q}
            style={{
              background: 'rgba(255,255,255,0.04)',
              borderRadius: 8,
              padding: '8px 12px',
              fontSize: 12,
              color: '#e2e2e8',
              fontStyle: 'italic',
            }}
          >
            {q}
          </div>
        ))}

        <div style={{ borderTop: '0.5px solid rgba(255,255,255,0.08)', margin: '4px 0' }} />

        <p style={{ fontSize: 12, color: '#6b7280', margin: 0, lineHeight: 1.6 }}>
          Open the prompt via the <span style={{ color: '#e2e2e8' }}>Nexus AI</span> button
          (top-right).
        </p>
      </div>
    );

  if (active === 'shortcuts')
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {/* Column headers */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 80px 88px',
            gap: 8,
            padding: '0 0 8px',
            borderBottom: '0.5px solid rgba(255,255,255,0.08)',
            marginBottom: 4,
          }}
        >
          <span
            style={{
              fontSize: 11,
              color: '#6b7280',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
            }}
          >
            Action
          </span>
          <span
            style={{
              fontSize: 11,
              color: '#6b7280',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              textAlign: 'center',
            }}
          >
            Mac
          </span>
          <span
            style={{
              fontSize: 11,
              color: '#93c5fd',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              textAlign: 'center',
            }}
          >
            Windows
          </span>
        </div>

        {shortcuts.map(({ label, mac, win }, i) => (
          <div
            key={label}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 80px 88px',
              gap: 8,
              alignItems: 'center',
              padding: '8px 0',
              borderBottom:
                i < shortcuts.length - 1 ? '0.5px solid rgba(255,255,255,0.05)' : 'none',
            }}
          >
            <span style={{ fontSize: 12, color: '#9ca3af' }}>{label}</span>
            <span style={{ display: 'flex', justifyContent: 'center' }}>
              <kbd style={kbdStyle}>{mac}</kbd>
            </span>
            <span style={{ display: 'flex', justifyContent: 'center' }}>
              <kbd style={kbdWinStyle}>{win}</kbd>
            </span>
          </div>
        ))}
      </div>
    );

  if (active === 'status')
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p
          style={{
            fontSize: 11,
            color: '#6b7280',
            margin: '0 0 4px',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          Status bar explained
        </p>
        {getStatusItems(nodeCount, edgeCount).map(({ badge, title, desc }) => (
          <div
            key={title}
            style={{
              background: 'rgba(255,255,255,0.04)',
              borderRadius: 10,
              padding: '10px 14px',
              display: 'flex',
              gap: 12,
              alignItems: 'center',
            }}
          >
            {badge}
            <div>
              <p style={{ fontSize: 12, fontWeight: 500, color: '#e2e2e8', margin: '0 0 2px' }}>
                {title}
              </p>
              <p style={{ fontSize: 12, color: '#9ca3af', margin: 0 }}>{desc}</p>
            </div>
          </div>
        ))}
      </div>
    );

  return null;
}

export const HelpPanel = ({ isOpen, onClose, nodeCount, edgeCount }: HelpPanelProps) => {
  const [active, setActive] = useState<TabId>('overview');

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* Backdrop */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(4px)',
        }}
        onClick={onClose}
      />

      {/* Panel */}
      <div
        style={{
          position: 'relative',
          background: '#12121a',
          border: '0.5px solid rgba(255,255,255,0.12)',
          borderRadius: 16,
          boxShadow: '0 25px 60px rgba(0,0,0,0.7)',
          width: '100%',
          maxWidth: 680,
          margin: '0 16px',
          height: '60vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          fontFamily: 'var(--font-mono, monospace)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '0.5px solid rgba(255,255,255,0.08)',
            background: 'rgba(255,255,255,0.02)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 40,
                height: 40,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(167,139,250,0.15)',
                borderRadius: 12,
              }}
            >
              <HelpCircle style={{ width: 20, height: 20, color: '#a78bfa' }} />
            </div>
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 600, color: '#e2e2e8', margin: 0 }}>
                Help & Reference
              </h2>
              <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>GitNexus — graph explorer</p>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              padding: 8,
              color: '#6b7280',
              background: 'transparent',
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'color 0.15s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#e2e2e8')}
            onMouseLeave={(e) => (e.currentTarget.style.color = '#6b7280')}
          >
            <X style={{ width: 20, height: 20 }} />
          </button>
        </div>

        {/* Body: sidebar + content */}
        <div
          style={{ display: 'grid', gridTemplateColumns: '168px 1fr', flex: 1, overflow: 'hidden' }}
        >
          {/* Sidebar nav */}
          <div
            style={{
              borderRight: '0.5px solid rgba(255,255,255,0.08)',
              padding: '12px 8px',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            {tabs.map(({ id, label, icon }) => {
              const isActive = active === id;
              return (
                <button
                  key={id}
                  onClick={() => setActive(id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    textAlign: 'left',
                    background: isActive ? 'rgba(167,139,250,0.12)' : 'transparent',
                    border: 'none',
                    borderRadius: 8,
                    padding: '8px 10px',
                    fontSize: 12,
                    fontFamily: 'inherit',
                    color: isActive ? '#a78bfa' : '#9ca3af',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                    width: '100%',
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.color = '#e2e2e8';
                      e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.color = '#9ca3af';
                      e.currentTarget.style.background = 'transparent';
                    }
                  }}
                >
                  <span
                    style={{
                      color: isActive ? '#a78bfa' : '#6b7280',
                      display: 'flex',
                      flexShrink: 0,
                    }}
                  >
                    {icon}
                  </span>
                  {label}
                </button>
              );
            })}
          </div>

          {/* Content pane */}
          <div style={{ padding: '20px', overflowY: 'auto' }}>
            <TabContent active={active} nodeCount={nodeCount} edgeCount={edgeCount} />
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 20px',
            borderTop: '0.5px solid rgba(255,255,255,0.08)',
            background: 'rgba(255,255,255,0.01)',
          }}
        >
          <span style={{ fontSize: 11, color: '#4b5563' }}>
            GitNexus — open source codebase graph explorer
          </span>
          <a
            href="https://github.com/abhigyanpatwari/GitNexus"
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 11, color: '#a78bfa', textDecoration: 'none' }}
          >
            Docs & GitHub ↗
          </a>
        </div>
      </div>
    </div>
  );
};
