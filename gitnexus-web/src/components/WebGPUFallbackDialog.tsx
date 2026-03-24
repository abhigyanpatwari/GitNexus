import { useState, useEffect } from 'react';
import { X, Snail, Rocket, SkipForward } from '@/lib/lucide-icons';

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
        className={`relative bg-surface border border-border-subtle rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden transition-all duration-200 ${isVisible ? 'opacity-100 scale-100' : 'opacity-0 scale-95'}`}
      >
        {/* Header with scratching emoji */}
        <div className="relative bg-gradient-to-r from-amber-500/20 to-orange-500/20 px-6 py-5 border-b border-border-subtle">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-1 text-text-muted hover:text-text-primary transition-colors"
          >
            <X className="w-5 h-5" />
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
                WebGPU said "nope"
              </h2>
              <p className="text-sm text-text-muted mt-0.5">
                Your browser doesn't support GPU acceleration
              </p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="px-6 py-5 space-y-4">
          <p className="text-sm text-text-secondary leading-relaxed">
            Couldn't create embeddings with WebGPU, so semantic search (Graph RAG) 
            won't be as smart. The graph still works fine though! 
          </p>
          
          <div className="bg-elevated/50 rounded-lg p-4 border border-border-subtle">
            <p className="text-sm text-text-secondary">
              <span className="font-medium text-text-primary">Your options:</span>
            </p>
            <ul className="mt-2 space-y-1.5 text-sm text-text-muted">
              <li className="flex items-start gap-2">
                <Snail className="w-4 h-4 mt-0.5 text-amber-400 flex-shrink-0" />
                <span>
                  <strong className="text-text-secondary">Use CPU</strong> — Works but {isSmallCodebase ? 'a bit' : 'way'} slower
                  {nodeCount > 0 && (
                    <span className="text-text-muted"> (~{estimatedMinutes} min for {nodeCount} nodes)</span>
                  )}
                </span>
              </li>
              <li className="flex items-start gap-2">
                <SkipForward className="w-4 h-4 mt-0.5 text-blue-400 flex-shrink-0" />
                <span>
                  <strong className="text-text-secondary">Skip it</strong> — Graph works, just no AI semantic search
                </span>
              </li>
            </ul>
          </div>

          {isSmallCodebase && (
            <p className="text-xs text-node-function flex items-center gap-1.5 bg-node-function/10 px-3 py-2 rounded-lg">
              <Rocket className="w-3.5 h-3.5" />
              Small codebase detected! CPU should be fine.
            </p>
          )}

          <p className="text-xs text-text-muted">
            💡 Tip: Try Chrome or Edge for WebGPU support
          </p>
        </div>

        {/* Actions */}
        <div className="px-6 py-4 bg-elevated/30 border-t border-border-subtle flex gap-3">
          <button
            onClick={onSkip}
            className="flex-1 px-4 py-2.5 text-sm font-medium text-text-secondary bg-surface border border-border-subtle rounded-lg hover:bg-hover hover:text-text-primary transition-all flex items-center justify-center gap-2"
          >
            <SkipForward className="w-4 h-4" />
            Skip Embeddings
          </button>
          <button
            onClick={onUseCPU}
            className={`flex-1 px-4 py-2.5 text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2 ${
              isSmallCodebase
                ? 'bg-node-function text-white hover:bg-node-function/90'
                : 'bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30'
            }`}
          >
            <Snail className="w-4 h-4" />
            Use CPU {isSmallCodebase ? '(Recommended)' : '(Slow)'}
          </button>
        </div>
      </div>
    </div>
  );
};

