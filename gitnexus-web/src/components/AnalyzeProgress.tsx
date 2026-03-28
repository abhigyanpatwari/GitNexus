import { useState, useEffect } from 'react';
import { X } from '@/lib/lucide-icons';
import type { JobProgress as AnalyzeJobProgress } from '../services/backend-client';

interface AnalyzeProgressProps {
  progress: AnalyzeJobProgress;
  onCancel: () => void;
}

const PHASE_LABELS: Record<string, string> = {
  queued: 'Queued',
  cloning: 'Cloning repository',
  pulling: 'Pulling latest',
  extracting: 'Scanning files',
  structure: 'Building structure',
  parsing: 'Parsing code',
  imports: 'Resolving imports',
  calls: 'Tracing calls',
  heritage: 'Extracting inheritance',
  communities: 'Detecting communities',
  processes: 'Detecting processes',
  complete: 'Pipeline complete',
  lbug: 'Loading into database',
  fts: 'Creating search indexes',
  embeddings: 'Generating embeddings',
  done: 'Done',
  retrying: 'Retrying after crash',
};

export const AnalyzeProgress = ({ progress, onCancel }: AnalyzeProgressProps) => {
  const [startTime] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setElapsed(Date.now() - startTime), 1000);
    return () => clearInterval(timer);
  }, [startTime]);

  const formatElapsed = (ms: number) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  };

  const label = PHASE_LABELS[progress.phase] || progress.message || progress.phase;
  const pct = Math.max(0, Math.min(100, progress.percent));

  return (
    <div className="space-y-4">
      {/* Phase label + elapsed */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-text-secondary font-medium">{label}</span>
        <span className="text-text-muted font-mono text-xs">{formatElapsed(elapsed)}</span>
      </div>

      {/* Progress bar */}
      <div className="h-2 bg-elevated rounded-full overflow-hidden">
        <div
          className="h-full bg-accent rounded-full transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Percent + cancel */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-muted font-mono">{pct}%</span>
        <button
          onClick={onCancel}
          className="
            flex items-center gap-1.5
            px-3 py-1.5
            text-xs text-red-400
            bg-red-500/10 hover:bg-red-500/20
            rounded-lg
            transition-all duration-200
          "
        >
          <X className="w-3.5 h-3.5" />
          Cancel
        </button>
      </div>
    </div>
  );
};
