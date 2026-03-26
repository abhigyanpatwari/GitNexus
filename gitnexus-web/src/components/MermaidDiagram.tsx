import { useEffect, useRef, useState, memo } from 'react';
import { AlertTriangle, Maximize2 } from 'lucide-react';
import { ProcessFlowModal } from './ProcessFlowModal';
import type { ProcessData } from '../lib/mermaid-generator';

// Lazy-load mermaid (~480KB) — only fetched when first diagram renders
let mermaidInstance: typeof import('mermaid').default | null = null;
let mermaidInitPromise: Promise<typeof import('mermaid').default> | null = null;

const getMermaid = (): Promise<typeof import('mermaid').default> => {
  if (mermaidInstance) return Promise.resolve(mermaidInstance);
  if (mermaidInitPromise) return mermaidInitPromise;

  mermaidInitPromise = import('mermaid').then(mod => {
    const m = mod.default;
    m.initialize({
      startOnLoad: false,
      maxTextSize: 900000,
      theme: 'base',
      themeVariables: {
        primaryColor: '#1e293b',
        primaryTextColor: '#f1f5f9',
        primaryBorderColor: '#22d3ee',
        lineColor: '#94a3b8',
        secondaryColor: '#1e293b',
        tertiaryColor: '#0f172a',
        mainBkg: '#1e293b',
        nodeBorder: '#22d3ee',
        clusterBkg: '#1e293b',
        clusterBorder: '#475569',
        titleColor: '#f1f5f9',
        edgeLabelBackground: '#0f172a',
      },
      flowchart: {
        curve: 'basis',
        padding: 15,
        nodeSpacing: 50,
        rankSpacing: 50,
        htmlLabels: true,
      },
      sequence: {
        actorMargin: 50,
        boxMargin: 10,
        boxTextMargin: 5,
        noteMargin: 10,
        messageMargin: 35,
      },
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 13,
      suppressErrorRendering: true,
    });
    m.parseError = () => {};
    mermaidInstance = m;
    return m;
  });

  return mermaidInitPromise;
};

// SVG cache — avoid re-rendering identical diagrams
const svgCache = new Map<string, string>();

interface MermaidDiagramProps {
  code: string;
}

export const MermaidDiagram = memo(({ code }: MermaidDiagramProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [svg, setSvg] = useState<string>('');

  useEffect(() => {
    const renderDiagram = async () => {
      if (!containerRef.current) return;

      const trimmed = code.trim();

      // Check cache first — avoids expensive re-render of identical diagrams
      const cached = svgCache.get(trimmed);
      if (cached) {
        setSvg(cached);
        setError(null);
        return;
      }

      try {
        const mermaid = await getMermaid();
        const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const { svg: renderedSvg } = await mermaid.render(id, trimmed);
        svgCache.set(trimmed, renderedSvg);
        setSvg(renderedSvg);
        setError(null);
      } catch (err) {
        console.debug('Mermaid render skipped (incomplete):', err);
      }
    };

    // Debounce rendering to prevent "jerking" during high-speed streaming
    const timeoutId = setTimeout(() => {
      renderDiagram();
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [code]);

  // Create a pseudo ProcessData for the modal (with custom rawMermaid property)
  const processData: any = showModal ? {
    id: 'ai-generated',
    label: 'AI Generated Diagram',
    processType: 'intra_community',
    steps: [], // Empty - we'll render raw mermaid
    edges: [],
    clusters: [],
    rawMermaid: code, // Pass raw mermaid code
  } : null;

  if (error) {
    return (
      <div className="my-3 p-4 bg-rose-500/10 border border-rose-500/30 rounded-lg">
        <div className="flex items-center gap-2 text-rose-300 text-sm mb-2">
          <AlertTriangle className="w-4 h-4" />
          <span className="font-medium">Diagram Error</span>
        </div>
        <pre className="text-xs text-rose-200/70 font-mono whitespace-pre-wrap">{error}</pre>
        <details className="mt-2">
          <summary className="text-xs text-text-muted cursor-pointer hover:text-text-secondary">
            Show source
          </summary>
          <pre className="mt-2 p-2 bg-surface rounded text-xs text-text-muted overflow-x-auto">
            {code}
          </pre>
        </details>
      </div>
    );
  }

  return (
    <>
      <div className="my-3 relative group">
        <div className="relative bg-gradient-to-b from-surface to-elevated border border-border-subtle rounded-xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 bg-surface/60 border-b border-border-subtle">
            <span className="text-[10px] text-text-muted uppercase tracking-wider font-medium">
              Diagram
            </span>
            <button
              onClick={() => setShowModal(true)}
              className="p-1 text-text-muted hover:text-text-primary hover:bg-hover rounded transition-colors"
              title="Expand"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Diagram container */}
          <div
            ref={containerRef}
            className="flex items-center justify-center p-4 overflow-auto max-h-[400px]"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>

      {/* Use ProcessFlowModal for expansion */}
      {showModal && processData && (
        <ProcessFlowModal
          process={processData}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
});
MermaidDiagram.displayName = 'MermaidDiagram';
