import React, { useState } from 'react';
import {
  X,
  GitBranch,
  Search,
  Filter,
  Zap,
  Keyboard,
  BarChart2,
  HelpCircle,
} from '@/lib/lucide-icons';
import { useTranslation } from 'react-i18next';

interface HelpPanelProps {
  isOpen: boolean;
  onClose: () => void;
  nodeCount: number;
  edgeCount: number;
}

type TabId = 'overview' | 'graph' | 'search' | 'ai' | 'shortcuts' | 'status';

interface Tab {
  id: TabId;
  icon: React.ReactNode;
}

const tabs: Tab[] = [
  { id: 'overview', icon: <HelpCircle className="h-4 w-4" /> },
  { id: 'graph', icon: <GitBranch className="h-4 w-4" /> },
  { id: 'search', icon: <Search className="h-4 w-4" /> },
  { id: 'ai', icon: <Zap className="h-4 w-4" /> },
  { id: 'shortcuts', icon: <Keyboard className="h-4 w-4" /> },
  { id: 'status', icon: <BarChart2 className="h-4 w-4" /> },
];

const shortcuts = [
  { labelKey: 'shortcuts.searchNodes', mac: '⌘ K', win: 'Ctrl K' },
  { labelKey: 'shortcuts.deselectClose', mac: 'Esc', win: 'Esc' },
];

const nodeColors = [
  { color: '#10b981', labelKey: 'nodeTypes.function', descKey: 'nodeTypes.functionDesc' },
  { color: '#3b82f6', labelKey: 'nodeTypes.file', descKey: 'nodeTypes.fileDesc' },
  { color: '#f59e0b', labelKey: 'nodeTypes.class', descKey: 'nodeTypes.classDesc' },
  { color: '#14b8a6', labelKey: 'nodeTypes.method', descKey: 'nodeTypes.methodDesc' },
  { color: '#ec4899', labelKey: 'nodeTypes.interface', descKey: 'nodeTypes.interfaceDesc' },
  { color: '#6366f1', labelKey: 'nodeTypes.folder', descKey: 'nodeTypes.folderDesc' },
];

const getStatusItems = (t: (key: string) => string, nodeCount: number, edgeCount: number) => [
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
    title: t('status.ready'),
    desc: t('status.readyDesc'),
  },
  {
    badge: (
      <span style={{ fontSize: 12, fontWeight: 500, color: '#a78bfa', flexShrink: 0 }}>
        {nodeCount}
      </span>
    ),
    title: t('status.nodesCount'),
    desc: t('status.nodesCountDesc'),
  },
  {
    badge: (
      <span style={{ fontSize: 12, fontWeight: 500, color: '#60a5fa', flexShrink: 0 }}>
        {edgeCount}
      </span>
    ),
    title: t('status.edgesCount'),
    desc: t('status.edgesCountDesc'),
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
        {t('status.semanticReadyBadge')}
      </span>
    ),
    title: t('status.aiIndexStatus'),
    desc: t('status.aiIndexStatusDesc'),
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
  const { t } = useTranslation('help');

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
          {t('overview.gettingStarted')}
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
            {t('overview.whatIsTitle')}
          </p>
          <p style={{ fontSize: 12, color: '#9ca3af', margin: 0, lineHeight: 1.6 }}>
            {t('overview.whatIsDescription')}
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
            {t('overview.currentRepoTitle')}
          </p>
          <p style={{ fontSize: 12, color: '#9ca3af', margin: 0, lineHeight: 1.6 }}>
            {t('overview.loadedCounts', { nodeCount, edgeCount })}
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
            {t('overview.threeWaysTitle')}
          </p>
          <p style={{ fontSize: 12, color: '#9ca3af', margin: 0, lineHeight: 1.6 }}>
            <strong style={{ color: '#e2e2e8', fontWeight: 500 }}>1.</strong>{' '}
            {t('overview.wayInspect')}
            <br />
            <strong style={{ color: '#e2e2e8', fontWeight: 500 }}>2.</strong>{' '}
            {t('overview.waySearch')}
            <br />
            <strong style={{ color: '#e2e2e8', fontWeight: 500 }}>3.</strong> {t('overview.wayAsk')}
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
            {t('overview.navigationTitle')}
          </p>
          <p style={{ fontSize: 12, color: '#9ca3af', margin: 0, lineHeight: 1.6 }}>
            · {t('overview.navZoom')} <br />· {t('overview.navPan')} <br />·{' '}
            {t('overview.navFocus')}
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
          {t('graph.nodeColorLegend')}
        </p>

        {nodeColors.map(({ color, labelKey, descKey }) => {
          const label = t(labelKey);
          return (
            <div key={labelKey} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
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
                  {t('graph.nodeLabel', { label })}
                </p>
                <p style={{ fontSize: 12, color: '#9ca3af', margin: 0 }}>{t(descKey)}</p>
              </div>
            </div>
          );
        })}

        <div style={{ borderTop: '0.5px solid rgba(255,255,255,0.08)', margin: '4px 0' }} />

        <p style={{ fontSize: 12, color: '#9ca3af', margin: 0, lineHeight: 1.6 }}>
          {t('graph.sizeDescription')}
        </p>

        <div
          style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: '10px 14px' }}
        >
          <p style={{ fontSize: 12, color: '#9ca3af', margin: 0, lineHeight: 1.6 }}>
            {t('graph.detailDescription')}
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
          {t('search.title')}
        </p>

        <div
          style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: '12px 14px' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <kbd style={kbdStyle}>⌘K</kbd>/<kbd style={kbdStyle}>Ctrl K</kbd>
            <p style={{ fontSize: 12, fontWeight: 500, color: '#e2e2e8', margin: 0 }}>
              {t('search.searchNodes')}
            </p>
          </div>
          <p style={{ fontSize: 12, color: '#9ca3af', margin: 0, lineHeight: 1.6 }}>
            {t('search.searchDescription')}
          </p>
        </div>

        <div
          style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: '12px 14px' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Filter style={{ width: 14, height: 14, color: '#a78bfa', flexShrink: 0 }} />
            <p style={{ fontSize: 12, fontWeight: 500, color: '#e2e2e8', margin: 0 }}>
              {t('search.filterPanel')}
            </p>
          </div>
          <p style={{ fontSize: 12, color: '#9ca3af', margin: 0, lineHeight: 1.6 }}>
            {t('search.filterDescription')}
          </p>
        </div>

        <div
          style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: '12px 14px' }}
        >
          <p style={{ fontSize: 12, fontWeight: 500, color: '#e2e2e8', margin: '0 0 6px' }}>
            {t('search.syntax')}
          </p>
          {[
            { query: 'auth', hintKey: 'search.hints.nameFragment' },
            { query: './utils/', hintKey: 'search.hints.pathPrefix' },
            { query: 'type:config', hintKey: 'search.hints.nodeType' },
          ].map(({ query, hintKey }) => (
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
              <span style={{ fontSize: 12, color: '#6b7280' }}>{t(hintKey)}</span>
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
          {t('ai.title')}
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
            {t('ai.semanticReady')}
          </p>
          <p style={{ fontSize: 12, color: '#9ca3af', margin: 0, lineHeight: 1.6 }}>
            {t('ai.description')}
          </p>
        </div>

        <p style={{ fontSize: 12, color: '#9ca3af', margin: '4px 0 2px' }}>{t('tryAsking')}</p>
        {[
          t('ai.questions.dependencies'),
          t('ai.questions.circular'),
          t('ai.questions.connected'),
          t('ai.questions.imports'),
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
          {t('ai.openPrompt')}
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
            {t('shortcuts.columns.action')}
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

        {shortcuts.map(({ labelKey, mac, win }, i) => (
          <div
            key={labelKey}
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
            <span style={{ fontSize: 12, color: '#9ca3af' }}>{t(labelKey)}</span>
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
          {t('status.explained')}
        </p>
        {getStatusItems(t, nodeCount, edgeCount).map(({ badge, title, desc }) => (
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
  const { t } = useTranslation('help');
  const [active, setActive] = useState<TabId>('overview');
  const localizedTabs = tabs.map((tab) => ({ ...tab, label: t(`tabs.${tab.id}`) }));

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
                {t('title')}
              </h2>
              <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>{t('footer')}</p>
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
            {localizedTabs.map(({ id, label, icon }) => {
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
          <span style={{ fontSize: 11, color: '#4b5563' }}>{t('footerLong')}</span>
          <a
            href="https://github.com/abhigyanpatwari/GitNexus"
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 11, color: '#a78bfa', textDecoration: 'none' }}
          >
            {t('docsGithub')}
          </a>
        </div>
      </div>
    </div>
  );
};
