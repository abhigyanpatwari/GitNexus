import { useMemo } from 'react';
import { Heart } from '@/lib/lucide-icons';
import { useAppState } from '../hooks/useAppState';

export const StatusBar = () => {
  const { graph, progress } = useAppState();

  const nodeCount = graph?.nodes.length ?? 0;
  const edgeCount = graph?.relationships.length ?? 0;

  // Detect primary language
  const primaryLanguage = useMemo(() => {
    if (!graph) return null;
    const languages = graph.nodes
      .map(n => n.properties.language)
      .filter(Boolean);
    if (languages.length === 0) return null;

    const counts = languages.reduce((acc, lang) => {
      acc[lang!] = (acc[lang!] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  }, [graph]);

  return (
    <footer className="flex items-center justify-between px-5 py-2 bg-deep border-t border-dashed border-border-subtle text-[11px] text-text-muted">
      {/* Left - Status */}
      <div className="flex items-center gap-4">
        {progress && progress.phase !== 'complete' ? (
          <>
            <div className="w-28 h-1 bg-elevated rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-accent to-node-interface rounded-full transition-all duration-300"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
            <span>{progress.message}</span>
          </>
        ) : (
          <div className="flex items-center gap-1.5" data-testid="status-ready">
            <span className="w-1.5 h-1.5 bg-node-function rounded-full" />
            <span>Ready</span>
          </div>
        )}
      </div>

      {/* Center - Sponsor */}
      <a
        href="https://github.com/sponsors/abhigyanpatwari"
        target="_blank"
        rel="noopener noreferrer"
        className="group flex items-center gap-2 px-3 py-1 rounded-full bg-pink-500/10 border border-pink-500/20 hover:bg-pink-500/20 hover:border-pink-500/40 hover:scale-[1.02] transition-all duration-200 cursor-pointer"
      >
        <Heart className="w-3.5 h-3.5 text-pink-500 fill-pink-500/40 group-hover:fill-pink-500 group-hover:scale-110 transition-all duration-200 animate-pulse" />
        <span className="text-[11px] font-medium text-pink-400 group-hover:text-pink-300 transition-colors">Sponsor</span>
        <span className="text-[10px] text-pink-300/50 group-hover:text-pink-300/80 italic hidden md:inline transition-colors">
          need to buy some API credits to run SWE-bench 😅
        </span>
      </a>

      {/* Right - Stats */}
      <div className="flex items-center gap-3">
        {graph && (
          <>
            <span>{nodeCount} nodes</span>
            <span className="text-border-default">•</span>
            <span>{edgeCount} edges</span>
            {primaryLanguage && (
              <>
                <span className="text-border-default">•</span>
                <span>{primaryLanguage}</span>
              </>
            )}
          </>
        )}
      </div>
    </footer>
  );
};
