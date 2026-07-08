import { useState, useEffect } from 'react';
import { X, Snail, Rocket, SkipForward } from '@/lib/lucide-icons';
import { useTranslation } from 'react-i18next';

interface WebGPUFallbackDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onUseCPU: () => void;
  onSkip: () => void;
  nodeCount: number;
}

/**
 * Fun dialog shown when WebGPU isn't available
 * Lets user choose: CPU fallback (slow) or skip embeddings
 */
export const WebGPUFallbackDialog = ({
  isOpen,
  onClose,
  onUseCPU,
  onSkip,
  nodeCount,
}: WebGPUFallbackDialogProps) => {
  const { t } = useTranslation('graph');
  const [isAnimating, setIsAnimating] = useState(true);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (isOpen) {
      // Trigger animation after mount
      requestAnimationFrame(() => setIsVisible(true));
    } else {
      setIsVisible(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  // Estimate time based on node count (rough: ~50ms per node on CPU)
  const estimatedMinutes = Math.ceil((nodeCount * 50) / 60000);
  const isSmallCodebase = nodeCount < 200;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />

      {/* Dialog */}
      <div
        className={`relative mx-4 w-full max-w-md overflow-hidden rounded-2xl border border-border-subtle bg-surface shadow-2xl transition-all duration-200 ${isVisible ? 'scale-100 opacity-100' : 'scale-95 opacity-0'}`}
      >
        {/* Header with scratching emoji */}
        <div className="relative border-b border-border-subtle bg-gradient-to-r from-amber-500/20 to-orange-500/20 px-6 py-5">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-1 text-text-muted transition-colors hover:text-text-primary"
          >
            <X className="h-5 w-5" />
          </button>

          <div className="flex items-center gap-4">
            {/* Animated emoji */}
            <div
              className={`text-5xl ${isAnimating ? 'animate-bounce' : ''}`}
              onAnimationEnd={() => setIsAnimating(false)}
              onClick={() => setIsAnimating(true)}
            >
              🤔
            </div>
            <div>
              <h2 className="text-lg font-semibold text-text-primary">
                {t('embedding.fallback.title')}
              </h2>
              <p className="mt-0.5 text-sm text-text-muted">{t('embedding.fallback.subtitle')}</p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="space-y-4 px-6 py-5">
          <p className="text-sm leading-relaxed text-text-secondary">
            {t('embedding.fallback.description')}
          </p>

          <div className="rounded-lg border border-border-subtle bg-elevated/50 p-4">
            <p className="text-sm text-text-secondary">
              <span className="font-medium text-text-primary">
                {t('embedding.fallback.options')}
              </span>
            </p>
            <ul className="mt-2 space-y-1.5 text-sm text-text-muted">
              <li className="flex items-start gap-2">
                <Snail className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
                <span>
                  <strong className="text-text-secondary">{t('embedding.fallback.useCpu')}</strong>{' '}
                  —{' '}
                  {isSmallCodebase
                    ? t('embedding.fallback.useCpuDescriptionSmall')
                    : t('embedding.fallback.useCpuDescriptionLarge')}
                  {nodeCount > 0 && (
                    <span className="text-text-muted">
                      {' '}
                      {t('embedding.fallback.estimated', {
                        minutes: estimatedMinutes,
                        count: nodeCount,
                      })}
                    </span>
                  )}
                </span>
              </li>
              <li className="flex items-start gap-2">
                <SkipForward className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-400" />
                <span>
                  <strong className="text-text-secondary">{t('embedding.fallback.skipIt')}</strong>{' '}
                  — {t('embedding.fallback.skipDescription')}
                </span>
              </li>
            </ul>
          </div>

          {isSmallCodebase && (
            <p className="flex items-center gap-1.5 rounded-lg bg-node-function/10 px-3 py-2 text-xs text-node-function">
              <Rocket className="h-3.5 w-3.5" />
              {t('embedding.fallback.smallCodebase')}
            </p>
          )}

          <p className="text-xs text-text-muted">{t('embedding.fallback.tip')}</p>
        </div>

        {/* Actions */}
        <div className="flex gap-3 border-t border-border-subtle bg-elevated/30 px-6 py-4">
          <button
            onClick={onSkip}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface px-4 py-2.5 text-sm font-medium text-text-secondary transition-all hover:bg-hover hover:text-text-primary"
          >
            <SkipForward className="h-4 w-4" />
            {t('embedding.fallback.skipEmbeddings')}
          </button>
          <button
            onClick={onUseCPU}
            className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-all ${
              isSmallCodebase
                ? 'bg-node-function text-white hover:bg-node-function/90'
                : 'border border-amber-500/30 bg-amber-500/20 text-amber-300 hover:bg-amber-500/30'
            }`}
          >
            <Snail className="h-4 w-4" />
            {isSmallCodebase
              ? t('embedding.fallback.useCpuRecommended')
              : t('embedding.fallback.useCpuSlow')}
          </button>
        </div>
      </div>
    </div>
  );
};
