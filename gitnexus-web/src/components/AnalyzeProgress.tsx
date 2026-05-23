import { useState, useEffect } from 'react';
import { X } from '@/lib/lucide-icons';
import type { JobProgress as AnalyzeJobProgress } from '../services/backend-client';
import { useTranslation } from 'react-i18next';
import { translateAnalyzePhase } from '../i18n/progress';

interface AnalyzeProgressProps {
  progress: AnalyzeJobProgress;
  onCancel: () => void;
}

export const AnalyzeProgress = ({ progress, onCancel }: AnalyzeProgressProps) => {
  const { t } = useTranslation('common');
  const [startTime] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setElapsed(Date.now() - startTime), 1000);
    return () => clearInterval(timer);
  }, [startTime]);

  const formatElapsed = (ms: number) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return t('units.elapsedSeconds', { seconds: s });
    return t('units.elapsedMinutesSeconds', { minutes: Math.floor(s / 60), seconds: s % 60 });
  };

  const label = translateAnalyzePhase(progress.phase, progress.message, t);
  const pct = Math.max(0, Math.min(100, progress.percent));

  return (
    <div className="space-y-4">
      {/* Phase label + elapsed */}
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-text-secondary">{label}</span>
        <span className="font-mono text-xs text-text-muted">{formatElapsed(elapsed)}</span>
      </div>

      {/* Progress bar */}
      <div className="h-2 overflow-hidden rounded-full bg-elevated">
        <div
          className="h-full rounded-full bg-accent transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Percent + cancel */}
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs text-text-muted">{pct}%</span>
        <button
          onClick={onCancel}
          className="flex items-center gap-1.5 rounded-lg bg-red-500/10 px-3 py-1.5 text-xs text-red-400 transition-all duration-200 hover:bg-red-500/20"
        >
          <X className="h-3.5 w-3.5" />
          {t('actions.cancel')}
        </button>
      </div>
    </div>
  );
};
