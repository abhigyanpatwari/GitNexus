/**
 * Process Flow Modal
 * 
 * Displays a Mermaid flowchart for a process in a centered modal popup.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { X, GitBranch, Copy, Focus, Layers, ZoomIn, ZoomOut } from '@/lib/lucide-icons';
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

export const ProcessFlowModal = ({ process, onClose, onFocusInGraph, isFullScreen = false }: ProcessFlowModalProps) => {
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
            setZoom(prev => Math.min(Math.max(0.1, prev + delta), maxZoom));
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
                setZoom(prev => Math.min(prev + 0.2, maxZoom));
            } else if (e.key === '-' || e.key === '_') {
                setZoom(prev => Math.max(prev - 0.2, 0.1));
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [maxZoom]);

    // Zoom in/out handlers
    const handleZoomIn = useCallback(() => {
        setZoom(prev => Math.min(prev + 0.25, maxZoom));
    }, [maxZoom]);

    const handleZoomOut = useCallback(() => {
        setZoom(prev => Math.max(prev - 0.25, 0.1));
    }, []);

    // Handle pan with mouse drag
    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        setIsPanning(true);
        setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }, [pan]);

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (!isPanning) return;
        setPan({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
    }, [isPanning, panStart]);

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
                const mermaidCode = (process as any).rawMermaid
                    ? (process as any).rawMermaid
                    : generateProcessMermaid(process);
                const id = `mermaid-${Date.now()}`;

                // Clear previous content
                diagramRef.current!.innerHTML = '';

                const { svg } = await mermaid.render(id, mermaidCode);
                if (!diagramRef.current) return;
                diagramRef.current!.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
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
              ${isSizeError
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
    const handleBackdropClick = useCallback((e: React.MouseEvent) => {
        if (e.target === containerRef.current) {
            onClose();
        }
    }, [onClose]);

    // Copy mermaid code to clipboard
    const handleCopyMermaid = useCallback(async () => {
        if (!process) return;
        const mermaidCode = generateProcessMermaid(process);
        await navigator.clipboard.writeText(mermaidCode);
    }, [process]);

    // Focus in graph
    const handleFocusInGraph = useCallback(() => {
        if (!process || !onFocusInGraph) return;
        const nodeIds = process.steps.map(s => s.id);
        onFocusInGraph(nodeIds, process.id);
        onClose();
    }, [process, onFocusInGraph, onClose]);

    if (!process) return null;

    return (
        <div
            ref={containerRef}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 animate-fade-in"
            onClick={handleBackdropClick}
        >
            {/* Glassmorphism Modal */}
            <div className={`bg-slate-900/60 backdrop-blur-2xl border border-white/10 rounded-3xl shadow-2xl shadow-cyan-500/10 flex flex-col animate-scale-in overflow-hidden relative ${isFullScreen
                ? 'w-[98%] h-[95vh] max-w-none'
                : 'w-[95%] max-w-5xl max-h-[90vh]'
                }`}>
                {/* Subtle gradient overlay for extra glass feel */}
                <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent pointer-events-none" />

                {/* Header */}
                <div className="px-6 py-5 border-b border-white/10 relative z-10">
                    <h2 className="text-lg font-semibold text-white">
                        Process: {process.label}
                    </h2>
                </div>

                {/* Diagram */}
                <div
                    ref={scrollContainerRef}
                    className={`flex-1 p-8 flex items-center justify-center relative z-10 overflow-hidden ${isFullScreen ? 'min-h-[70vh]' : 'min-h-[400px]'}`}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                    style={{ cursor: isPanning ? 'grabbing' : 'grab' }}
                >
                    <div
                        ref={diagramRef}
                        className="[&_.edgePath_.path]:stroke-slate-400 [&_.edgePath_.path]:stroke-2 [&_.marker]:fill-slate-400 transition-transform origin-center w-fit h-fit"
                        style={{
                            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                        }}
                    />
                </div>

                {/* Footer Actions */}
                <div className="flex items-center justify-center gap-3 px-6 py-4 border-t border-white/10 bg-slate-900/50 relative z-10">
                    {/* Zoom controls */}
                    <div className="flex items-center gap-1 bg-white/5 border border-white/10 rounded-lg p-1">
                        <button
                            onClick={handleZoomOut}
                            className="p-2 text-slate-300 hover:text-white hover:bg-white/10 rounded-md transition-all"
                            title="Zoom out (-)"
                        >
                            <ZoomOut className="w-4 h-4" />
                        </button>
                        <span className="px-2 text-xs text-slate-400 font-mono min-w-[3rem] text-center">
                            {Math.round(zoom * 100)}%
                        </span>
                        <button
                            onClick={handleZoomIn}
                            className="p-2 text-slate-300 hover:text-white hover:bg-white/10 rounded-md transition-all"
                            title="Zoom in (+)"
                        >
                            <ZoomIn className="w-4 h-4" />
                        </button>
                    </div>
                    <button
                        onClick={resetView}
                        className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-300 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg transition-all"
                        title="Reset zoom and pan"
                    >
                        Reset View
                    </button>
                    {onFocusInGraph && (
                        <button
                            onClick={handleFocusInGraph}
                            className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-slate-900 bg-cyan-400 hover:bg-cyan-300 rounded-lg transition-all shadow-lg shadow-cyan-500/20"
                        >
                            <Focus className="w-4 h-4" />
                            Toggle Focus
                        </button>
                    )}
                    <button
                        onClick={handleCopyMermaid}
                        className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-purple-600 hover:bg-purple-500 rounded-lg transition-all shadow-lg shadow-purple-500/20"
                    >
                        <Copy className="w-4 h-4" />
                        Copy Mermaid
                    </button>
                    <button
                        onClick={onClose}
                        className="px-5 py-2.5 text-sm font-medium text-slate-300 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg transition-all"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
};
