/**
 * Process Flow Modal
 *
 * Displays a Mermaid flowchart for a process in a centered modal popup.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { Copy, Focus, ZoomIn, ZoomOut } from 'lucide-react';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';
import { ProcessData, generateProcessMermaid } from '../lib/mermaid-generator';

interface ProcessFlowModalProps {
  process: ProcessData | null;
  onClose: () => void;
  onFocusInGraph?: (nodeIds: string[], processId: string) => void;
  isFullScreen?: boolean;
}

// Initialize mermaid with cyan/purple theme matching GitNexus
// Initialize mermaid with cyan/purple theme matching GitNexus
mermaid.initialize({
  startOnLoad: false,
  suppressErrorRendering: true, // Try to suppress if supported
  maxTextSize: 900000, // Increase from default 50000 to handle large combined diagrams
  theme: 'base',
  themeVariables: {
    primaryColor: '#1e293b', // node bg
    primaryTextColor: '#f1f5f9',
    primaryBorderColor: '#22d3ee',
    lineColor: '#94a3b8',
    secondaryColor: '#1e293b',
    tertiaryColor: '#0f172a',
    mainBkg: '#1e293b', // background
    nodeBorder: '#22d3ee',
    clusterBkg: '#1e293b',
    clusterBorder: '#475569',
    titleColor: '#f1f5f9',
    edgeLabelBackground: '#0f172a',
  },
  flowchart: {
    curve: 'basis',
    padding: 50,
    nodeSpacing: 120,
    rankSpacing: 140,
    htmlLabels: true,
  },
});

// Suppress distinct syntax error overlay
mermaid.parseError = (err) => {
  // Suppress visual error - we handle errors in the render try/catch
  console.debug('Mermaid parse error (suppressed):', err);
};

export const ProcessFlowModal = ({
  process,
  onClose,
  onFocusInGraph,
  isFullScreen = false,
}: ProcessFlowModalProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const diagramRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Full process map gets higher default zoom (667%) and max zoom (3000%)
  const defaultZoom = isFullScreen ? 6.67 : 1;
  const maxZoom = isFullScreen ? 30 : 10;

  const [zoom, setZoom] = useState(defaultZoom);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  // Reset zoom when switching between full screen and regular mode
  useEffect(() => {
    setZoom(defaultZoom);
    setPan({ x: 0, y: 0 });
  }, [isFullScreen, defaultZoom]);

  // Handle zoom with scroll wheel
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY * -0.001;
      setZoom((prev) => Math.min(Math.max(0.1, prev + delta), maxZoom));
    };

    const container = scrollContainerRef.current;
    if (container) {
      container.addEventListener('wheel', handleWheel, { passive: false });
      return () => container.removeEventListener('wheel', handleWheel);
    }
  }, [process, maxZoom]); // Re-attach when process or maxZoom changes

  // Handle keyboard zoom
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === '+' || e.key === '=') {
        setZoom((prev) => Math.min(prev + 0.2, maxZoom));
      } else if (e.key === '-' || e.key === '_') {
        setZoom((prev) => Math.max(prev - 0.2, 0.1));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [maxZoom]);

  // Zoom in/out handlers
  const handleZoomIn = useCallback(() => {
    setZoom((prev) => Math.min(prev + 0.25, maxZoom));
  }, [maxZoom]);

  const handleZoomOut = useCallback(() => {
    setZoom((prev) => Math.max(prev - 0.25, 0.1));
  }, []);

  // Handle pan with mouse drag
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      setIsPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    },
    [pan],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isPanning) return;
      setPan({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
    },
    [isPanning, panStart],
  );

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  const resetView = useCallback(() => {
    setZoom(defaultZoom);
    setPan({ x: 0, y: 0 });
  }, [defaultZoom]);

  // Render mermaid diagram
  useEffect(() => {
    if (!process || !diagramRef.current) return;

    const renderDiagram = async () => {
      try {
        // Check if we have raw mermaid code (from AI chat) or need to generate it
        const mermaidCode = process.rawMermaid
          ? process.rawMermaid
          : generateProcessMermaid(process);
        const id = `mermaid-${Date.now()}`;

        // Clear previous content
        diagramRef.current!.innerHTML = '';

        const { svg } = await mermaid.render(id, mermaidCode);
        if (!diagramRef.current) return;
        diagramRef.current!.innerHTML = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
          ADD_TAGS: ['foreignObject'],
        });
      } catch (error) {
        console.error('Mermaid render error:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isSizeError = errorMessage.includes('Maximum') || errorMessage.includes('exceeded');

        diagramRef.current!.innerHTML = `
          <div class="text-center p-8">
            <div class="text-red-400 text-sm font-medium mb-2">
              ${isSizeError ? '📊 Diagram Too Large' : '⚠️ Render Error'}
            </div>
            <div class="text-slate-400 text-xs max-w-md">
              ${
                isSizeError
                  ? `This diagram has ${process.steps?.length || 0} steps and is too complex to render. Try viewing individual processes instead of "All Processes".`
                  : `Unable to render diagram. Steps: ${process.steps?.length || 0}`
              }
            </div>
          </div>
        `;
      }
    };

    renderDiagram();
  }, [process]);

  // Close on escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  // Close on backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === containerRef.current) {
        onClose();
      }
    },
    [onClose],
  );

  // Copy mermaid code to clipboard
  const handleCopyMermaid = useCallback(async () => {
    if (!process) return;
    const mermaidCode = generateProcessMermaid(process);
    await navigator.clipboard.writeText(mermaidCode);
  }, [process]);

  // Focus in graph
  const handleFocusInGraph = useCallback(() => {
    if (!process || !onFocusInGraph) return;
    const nodeIds = process.steps.map((s) => s.id);
    onFocusInGraph(nodeIds, process.id);
    onClose();
  }, [process, onFocusInGraph, onClose]);

  if (!process) return null;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/20"
      onClick={handleBackdropClick}
      data-testid="process-modal"
    >
      {/* Glassmorphism Modal */}
      <div
        className={`animate-scale-in relative flex flex-col overflow-hidden rounded-3xl border border-white/10 bg-slate-900/60 shadow-2xl shadow-cyan-500/10 backdrop-blur-2xl ${
          isFullScreen ? 'h-[95vh] w-[98%] max-w-none' : 'max-h-[90vh] w-[95%] max-w-5xl'
        }`}
      >
        {/* Subtle gradient overlay for extra glass feel */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/5 to-transparent" />

        {/* Header */}
        <div className="relative z-10 border-b border-white/10 px-6 py-5">
          <h2 className="text-lg font-semibold text-white">Process: {process.label}</h2>
        </div>

        {/* Diagram */}
        <div
          ref={scrollContainerRef}
          className={`relative z-10 flex flex-1 items-center justify-center overflow-hidden p-8 ${isFullScreen ? 'min-h-[70vh]' : 'min-h-[400px]'}`}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{ cursor: isPanning ? 'grabbing' : 'grab' }}
        >
          <div
            ref={diagramRef}
            className="h-fit w-fit origin-center transition-transform [&_.edgePath_.path]:stroke-slate-400 [&_.edgePath_.path]:stroke-2 [&_.marker]:fill-slate-400"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            }}
          />
        </div>

        {/* Footer Actions */}
        <div className="relative z-10 flex items-center justify-center gap-3 border-t border-white/10 bg-slate-900/50 px-6 py-4">
          {/* Zoom controls */}
          <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 p-1">
            <button
              onClick={handleZoomOut}
              className="rounded-md p-2 text-slate-300 transition-all hover:bg-white/10 hover:text-white"
              title="Zoom out (-)"
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <span className="min-w-[3rem] px-2 text-center font-mono text-xs text-slate-400">
              {Math.round(zoom * 100)}%
            </span>
            <button
              onClick={handleZoomIn}
              className="rounded-md p-2 text-slate-300 transition-all hover:bg-white/10 hover:text-white"
              title="Zoom in (+)"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
          </div>
          <button
            onClick={resetView}
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-slate-300 transition-all hover:bg-white/10 hover:text-white"
            title="Reset zoom and pan"
          >
            Reset View
          </button>
          {onFocusInGraph && (
            <button
              onClick={handleFocusInGraph}
              className="flex items-center gap-2 rounded-lg bg-cyan-400 px-5 py-2.5 text-sm font-medium text-slate-900 shadow-lg shadow-cyan-500/20 transition-all hover:bg-cyan-300"
            >
              <Focus className="h-4 w-4" />
              Toggle Focus
            </button>
          )}
          <button
            onClick={handleCopyMermaid}
            className="flex items-center gap-2 rounded-lg bg-purple-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-purple-500/20 transition-all hover:bg-purple-500"
          >
            <Copy className="h-4 w-4" />
            Copy Mermaid
          </button>
          <button
            onClick={onClose}
            className="rounded-lg border border-white/10 bg-white/5 px-5 py-2.5 text-sm font-medium text-slate-300 transition-all hover:bg-white/10 hover:text-white"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
