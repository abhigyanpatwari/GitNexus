import { Server, ArrowRight } from '@/lib/lucide-icons';
import { BackendRepo } from '../services/backend';

interface BackendRepoSelectorProps {
  repos: BackendRepo[];
  onSelectRepo: (repoName: string) => void;
  backendUrl: string;
  isConnected: boolean;
}

export const BackendRepoSelector = ({
  repos,
  onSelectRepo,
  backendUrl,
  isConnected,
}: BackendRepoSelectorProps) => {
  return (
    <div className="p-8 bg-surface border border-border-default rounded-3xl">
      {/* Icon */}
      <div className="mx-auto w-20 h-20 mb-6 flex items-center justify-center bg-gradient-to-br from-accent to-node-interface rounded-2xl shadow-glow">
        <Server className="w-10 h-10 text-white" />
      </div>

      {/* Title */}
      <h2 className="text-xl font-semibold text-text-primary text-center mb-2">
        Local Repositories
      </h2>
      <p className="text-sm text-text-secondary text-center mb-4">
        Select an indexed repository from your local GitNexus server
      </p>

      {/* Connected status badge */}
      {isConnected && (
        <div className="flex items-center justify-center gap-2 mb-6">
          <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
          <span className="text-xs text-green-400">Connected to {backendUrl}</span>
        </div>
      )}

      {/* Repo list or empty state */}
      {repos.length > 0 ? (
        <div className="max-h-80 overflow-y-auto space-y-2">
          {repos.map((repo) => (
            <button
              key={repo.name}
              onClick={() => onSelectRepo(repo.name)}
              className="w-full p-4 bg-elevated border border-border-subtle rounded-xl hover:border-accent/50 hover:bg-hover transition-all text-left group"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium text-text-primary group-hover:text-accent transition-colors">
                  {repo.name}
                </span>
                <ArrowRight className="w-4 h-4 text-text-muted group-hover:text-accent transition-colors" />
              </div>
              <div className="flex items-center gap-3 text-xs text-text-muted">
                {repo.stats?.files != null && <span>{repo.stats.files} files</span>}
                {repo.stats?.nodes != null && <span>{repo.stats.nodes} nodes</span>}
                {repo.stats?.edges != null && <span>{repo.stats.edges} edges</span>}
              </div>
              <div className="text-xs text-text-muted mt-1">
                Indexed {new Date(repo.indexedAt).toLocaleDateString()}
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="text-center text-text-muted py-8">
          <p className="text-sm mb-2">No indexed repositories found</p>
          <p className="text-xs">
            Run{' '}
            <code className="px-1 py-0.5 bg-elevated rounded">gitnexus analyze</code>{' '}
            in a repository
          </p>
        </div>
      )}

      {/* Bottom hints */}
      <div className="mt-4 flex items-center justify-center gap-3 text-xs text-text-muted">
        <span className="px-3 py-1.5 bg-elevated border border-border-subtle rounded-md">
          {repos.length} {repos.length === 1 ? 'repo' : 'repos'}
        </span>
        <span className="px-3 py-1.5 bg-elevated border border-border-subtle rounded-md">
          Pre-indexed
        </span>
      </div>
    </div>
  );
};
