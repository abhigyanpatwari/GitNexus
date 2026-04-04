import { useAppState } from '../hooks/useAppState';
import { useMemo, useCallback } from 'react';

export const RepoLegend = () => {
  const { graph, groupMode, highlightedRepos, setHighlightedRepos } = useAppState();

  const repos = useMemo(() => {
    if (!groupMode || !graph) return [];

    const repoMap = new Map<string, { color: string; count: number }>();
    for (const node of graph.nodes) {
      const repo = (node.properties as Record<string, unknown>)._repo as string | undefined;
      if (!repo) continue;
      const existing = repoMap.get(repo);
      if (existing) {
        existing.count++;
      } else {
        repoMap.set(repo, { color: '#9ca3af', count: 1 });
      }
    }
    return [...repoMap.entries()].map(([name, info]) => ({ name, ...info }));
  }, [graph, groupMode]);

  const toggleRepo = useCallback(
    (repoName: string) => {
      const next = new Set(highlightedRepos);
      if (next.has(repoName)) {
        next.delete(repoName);
      } else {
        next.add(repoName);
      }
      setHighlightedRepos(next);
    },
    [highlightedRepos, setHighlightedRepos],
  );

  if (!groupMode || repos.length === 0) return null;

  return (
    <div className="absolute top-4 left-4 z-10 rounded-lg border border-border-subtle bg-elevated/90 px-3 py-2 backdrop-blur-sm">
      <div className="mb-1.5 text-[10px] font-medium tracking-wider text-text-muted uppercase">
        Repos
      </div>
      <div className="space-y-1">
        {repos.map((repo) => {
          const isHighlighted = highlightedRepos.has(repo.name);
          return (
            <button
              key={repo.name}
              onClick={() => toggleRepo(repo.name)}
              className="flex w-full cursor-pointer items-center gap-2 rounded px-1 py-0.5 transition-colors hover:bg-hover"
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full transition-colors"
                style={{ backgroundColor: isHighlighted ? '#f59e0b' : '#4b5563' }}
              />
              <span
                className={`text-xs transition-colors ${isHighlighted ? 'text-text-secondary' : 'text-text-muted'}`}
              >
                {repo.name}
              </span>
              <span className="text-[10px] text-text-muted">{repo.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
