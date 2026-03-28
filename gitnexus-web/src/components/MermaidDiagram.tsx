import { Suspense, useEffect, useRef, useState, lazy } from 'react';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';
import { AlertTriangle, Maximize2 } from '@/lib/lucide-icons';
import type { ProcessData } from '../lib/mermaid-generator';

const ProcessFlowModal = lazy(() =>
  import('./ProcessFlowModal').then((m) => ({ default: m.ProcessFlowModal })),
);

// Initialize mermaid with cyan theme matching ProcessFlowModal
mermaid.initialize({
  startOnLoad: false,
  maxTextSize: 900000,
  theme: 'base',
  themeVariables: {
    primaryColor: '#1e293b', // node bg - slate
    primaryTextColor: '#f1f5f9',
    primaryBorderColor: '#22d3ee', // cyan
    lineColor: '#94a3b8',
    secondaryColor: '#1e293b',
    tertiaryColor: '#0f172a',
    mainBkg: '#1e293b',
    nodeBorder: '#22d3ee', // cyan
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

// Override the default error handler to prevent it from logging to UI
mermaid.parseError = (_err) => {
  // Silent catch
};

interface MermaidDiagramProps {
  code: string;
}

export const MermaidDiagram = ({ code }: MermaidDiagramProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [svg, setSvg] = useState<string>('');

  useEffect(() => {
    const renderDiagram = async () => {
      if (!containerRef.current) return;

      try {
        // Generate unique ID for this diagram
        const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // Render the diagram
        const { svg: renderedSvg } = await mermaid.render(id, code.trim());
        const sanitizedSvg = DOMPurify.sanitize(renderedSvg, {
          USE_PROFILES: { svg: true, svgFilters: true },
          ADD_TAGS: ['foreignObject'],
        });
        setSvg(sanitizedSvg);
        setError(null);
      } catch (err) {
        // Silent catch for streaming:
        // If render fails (common during partial streaming), we:
        // 1. Log to console for debugging
        // 2. Do NOT set error state (avoids flashing red box)
        // 3. Do NOT clear existing SVG (keeps last valid state visible)
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
  const processData: any = showModal
    ? {
        id: 'ai-generated',
        label: 'AI Generated Diagram',
        processType: 'intra_community',
        steps: [], // Empty - we'll render raw mermaid
        edges: [],
        clusters: [],
        rawMermaid: code, // Pass raw mermaid code
      }
    : null;

  if (error) {
    return (
      <div className="my-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-4">
        <div className="mb-2 flex items-center gap-2 text-sm text-rose-300">
          <AlertTriangle className="h-4 w-4" />
          <span className="font-medium">Diagram Error</span>
        </div>
        <pre className="font-mono text-xs whitespace-pre-wrap text-rose-200/70">{error}</pre>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-text-muted hover:text-text-secondary">
            Show source
          </summary>
          <pre className="mt-2 overflow-x-auto rounded bg-surface p-2 text-xs text-text-muted">
            {code}
          </pre>
        </details>
      </div>
    );
  }

  return (
    <>
      <div className="group relative my-3">
        <div className="relative overflow-hidden rounded-xl border border-border-subtle bg-gradient-to-b from-surface to-elevated">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border-subtle bg-surface/60 px-3 py-2">
            <span className="text-[10px] font-medium tracking-wider text-text-muted uppercase">
              Diagram
            </span>
            <button
              onClick={() => setShowModal(true)}
              className="rounded p-1 text-text-muted transition-colors hover:bg-hover hover:text-text-primary"
              title="Expand"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Diagram container */}
          <div
            ref={containerRef}
            className="flex max-h-[400px] items-center justify-center overflow-auto p-4"
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(svg, {
                USE_PROFILES: { svg: true, svgFilters: true },
                ADD_TAGS: ['foreignObject'],
              }),
            }}
          />
        </div>
      </div>

      {/* Use ProcessFlowModal for expansion */}
      {showModal && processData && (
        <Suspense fallback={<div className="p-4 text-sm text-text-muted">Loading diagram…</div>}>
          <ProcessFlowModal process={processData} onClose={() => setShowModal(false)} />
        </Suspense>
      )}
    </>
  );
};
