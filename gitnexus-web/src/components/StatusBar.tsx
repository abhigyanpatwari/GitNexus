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
    const languages = graph.nodes.map((n) => n.properties.language).filter(Boolean);
    if (languages.length === 0) return null;

    const counts = languages.reduce(
      (acc, lang) => {
        acc[lang!] = (acc[lang!] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  }, [graph]);

  return (
    <footer className="flex items-center justify-between border-t border-dashed border-border-subtle bg-deep px-5 py-2 text-[11px] text-text-muted">
      {/* Left - Status */}
      <div className="flex items-center gap-4">
        {progress && progress.phase !== 'complete' ? (
          <>
            <div className="h-1 w-28 overflow-hidden rounded-full bg-elevated">
              <div
                className="h-full rounded-full bg-gradient-to-r from-accent to-node-interface transition-all duration-300"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
            <span>{progress.message}</span>
          </>
        ) : (
          <div className="flex items-center gap-1.5" data-testid="status-ready">
            <span className="h-1.5 w-1.5 rounded-full bg-node-function" />
            <span>Ready</span>
          </div>
        )}
      </div>

      {/* Center - Sponsor */}
      <a
        href="https://github.com/sponsors/abhigyanpatwari"
        target="_blank"
        rel="noopener noreferrer"
        className="group flex cursor-pointer items-center gap-2 rounded-full border border-pink-500/20 bg-pink-500/10 px-3 py-1 transition-all duration-200 hover:scale-[1.02] hover:border-pink-500/40 hover:bg-pink-500/20"
      >
        <Heart className="h-3.5 w-3.5 animate-pulse fill-pink-500/40 text-pink-500 transition-all duration-200 group-hover:scale-110 group-hover:fill-pink-500" />
        <span className="text-[11px] font-medium text-pink-400 transition-colors group-hover:text-pink-300">
          Sponsor
        </span>
        <span className="hidden text-[10px] text-pink-300/50 italic transition-colors group-hover:text-pink-300/80 md:inline">
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
