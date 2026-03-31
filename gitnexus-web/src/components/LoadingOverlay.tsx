import { PipelineProgress } from "../types/pipeline";

interface LoadingOverlayProps {
  progress: PipelineProgress;
}

export const LoadingOverlay = ({ progress }: LoadingOverlayProps) => {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-void z-50">
      {/* Background gradient effects */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/3 left-1/3 w-96 h-96 bg-accent/10 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-1/3 right-1/3 w-96 h-96 bg-node-interface/10 rounded-full blur-3xl animate-pulse" />
      </div>

      {/* Pulsing orb */}
      <div className="relative mb-10">
        <div className="w-28 h-28 bg-gradient-to-br from-accent to-node-interface rounded-full animate-pulse-glow" />
        <div className="absolute inset-0 w-28 h-28 bg-gradient-to-br from-accent to-node-interface rounded-full blur-xl opacity-50" />
      </div>

      {/* Progress bar */}
      <div className="w-80 mb-4">
        <div className="h-1.5 bg-elevated rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-accent to-node-interface rounded-full transition-all duration-300 ease-out"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      </div>

      {/* Status text */}
      <div className="text-center">
        <p className="font-mono text-sm text-text-secondary mb-1">
          {progress.message}
          <span className="animate-pulse">|</span>
        </p>
        {progress.detail && (
          <p className="font-mono text-xs text-text-muted truncate max-w-md">
            {progress.detail}
          </p>
        )}
      </div>

      {/* Stats */}
      {progress.stats && (
        <div className="mt-8 flex items-center gap-6 text-xs text-text-muted">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 bg-node-file rounded-full" />
            <span>
              {progress.stats.filesProcessed} / {progress.stats.totalFiles}{" "}
              files
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 bg-node-function rounded-full" />
            <span>{progress.stats.nodesCreated} nodes</span>
          </div>
        </div>
      )}

      {/* Percent */}
      <p className="mt-4 font-mono text-3xl font-semibold text-text-primary">
        {progress.percent}%
      </p>
    </div>
  );
};
