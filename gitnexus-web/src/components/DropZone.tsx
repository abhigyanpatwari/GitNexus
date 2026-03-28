import { useState, useRef, useEffect } from 'react';
import { Loader2, Check, Sparkles } from '@/lib/lucide-icons';
import { connectToServer, fetchRepos, type ConnectResult } from '../services/backend-client';
import { useBackend } from '../hooks/useBackend';
import { OnboardingGuide } from './OnboardingGuide';
import { AnalyzeOnboarding } from './AnalyzeOnboarding';

interface DropZoneProps {
  onServerConnect?: (result: ConnectResult, serverUrl?: string) => void | Promise<void>;
}

// ── Crossfade wrapper ───────────────────────────────────────────────────────
// Captures the outgoing children during fade-out, then swaps to the new children on fade-in.

function Crossfade({ activeKey, children }: { activeKey: string; children: React.ReactNode }) {
  const [displayedKey, setDisplayedKey] = useState(activeKey);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const snapshotRef = useRef<React.ReactNode>(children);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep snapshot up to date when NOT transitioning
  if (!isTransitioning && activeKey === displayedKey) {
    snapshotRef.current = children;
  }

  useEffect(() => {
    if (activeKey !== displayedKey) {
      setIsTransitioning(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        snapshotRef.current = null; // clear snapshot — new children will render
        setDisplayedKey(activeKey);
        setIsTransitioning(false);
      }, 300);
    }
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [activeKey, displayedKey]);

  return (
    <div
      className="transition-[opacity,transform] duration-300 ease-out"
      style={{
        opacity: isTransitioning ? 0 : 1,
        transform: isTransitioning ? 'scale(0.97) translateY(8px)' : 'scale(1) translateY(0)',
      }}
    >
      {isTransitioning ? snapshotRef.current : children}
    </div>
  );
}

// ── Phase cards ─────────────────────────────────────────────────────────────

function SuccessCard() {
  return (
    <div
      className="relative overflow-hidden rounded-3xl border border-emerald-500/20 bg-surface p-7"
      role="status"
      aria-live="polite"
    >
      {/* Success glow */}
      <div className="pointer-events-none absolute -top-20 left-1/2 h-64 w-64 -translate-x-1/2 rounded-full bg-emerald-500/8 blur-3xl" />

      <div className="relative">
        {/* Animated check icon */}
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/20 to-emerald-600/10 shadow-[0_0_30px_rgba(16,185,129,0.15)]">
          <Check className="h-8 w-8 text-emerald-400" />
        </div>

        <h2 className="mb-2 text-center text-lg font-semibold text-emerald-400">
          Server Connected
        </h2>
        <p className="text-center text-sm leading-relaxed text-text-secondary">
          Preparing your code knowledge graph...
        </p>

        {/* Subtle progress hint */}
        <div className="mt-6 flex items-center justify-center gap-2">
          <div className="flex gap-1">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400/60"
                style={{ animationDelay: `${i * 200}ms` }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function LoadingCard({ message }: { message: string }) {
  return (
    <div
      className="relative overflow-hidden rounded-3xl border border-accent/20 bg-surface p-7"
      role="status"
      aria-live="polite"
    >
      {/* Loading glow */}
      <div className="pointer-events-none absolute -top-20 left-1/2 h-64 w-64 -translate-x-1/2 rounded-full bg-accent/8 blur-3xl" />

      <div className="relative">
        {/* Spinner */}
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-accent/30 bg-gradient-to-br from-accent/20 to-accent-dim/10 shadow-glow-soft">
          <Loader2 className="h-8 w-8 animate-spin text-accent" />
        </div>

        <h2 className="mb-2 text-center text-lg font-semibold text-text-primary">
          {message || 'Connecting...'}
        </h2>
        <p className="text-center text-sm leading-relaxed text-text-secondary">
          This may take a moment for large repositories
        </p>

        {/* Decorative sparkle */}
        <div className="mt-5 flex items-center justify-center">
          <Sparkles className="h-4 w-4 text-accent/30" />
        </div>
      </div>
    </div>
  );
}

// ── DropZone ─────────────────────────────────────────────────────────────────

export const DropZone = ({ onServerConnect }: DropZoneProps) => {
  const [error, setError] = useState<string | null>(null);

  // Backend polling for server detection
  const {
    isConnected,
    isProbing,
    startPolling,
    stopPolling,
    isPolling,
    backendUrl: detectedBackendUrl,
  } = useBackend();
  const [initialProbeComplete, setInitialProbeComplete] = useState(false);
  const autoConnectRan = useRef(false);
  const autoConnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Connection state
  // 'analyze' = server up but zero repos indexed — show URL input
  const [phase, setPhase] = useState<'onboarding' | 'analyze' | 'success' | 'loading'>(
    'onboarding',
  );
  const [loadingMessage, setLoadingMessage] = useState('');
  const abortControllerRef = useRef<AbortController | null>(null);

  // Auto-connect to the detected server
  const handleAutoConnect = async () => {
    setPhase('loading');
    setLoadingMessage('Connecting...');
    setError(null);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      // Check if the server has any indexed repos first
      const repos = await fetchRepos();
      if (repos.length === 0) {
        // Server is up but has no repos — transition to the analyze UI
        // instead of showing a generic error string.
        setPhase('analyze');
        autoConnectRan.current = false;
        return;
      }

      const result = await connectToServer(
        detectedBackendUrl,
        (p, downloaded, total) => {
          if (p === 'validating') {
            setLoadingMessage('Validating server...');
          } else if (p === 'downloading') {
            const mb = (downloaded / (1024 * 1024)).toFixed(1);
            const pct = total ? Math.round((downloaded / total) * 100) : null;
            setLoadingMessage(pct ? `Downloading graph... ${pct}%` : `Downloading... ${mb} MB`);
          } else if (p === 'extracting') {
            setLoadingMessage('Processing graph...');
          }
        },
        abortController.signal,
      );

      if (onServerConnect) {
        await onServerConnect(result, detectedBackendUrl);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      const message = err instanceof Error ? err.message : 'Failed to connect';
      setError(message);
      // Show error on the loading card — do NOT reset autoConnectRan while
      // isConnected is still true, or the auto-connect effect will loop.
      // The "server went away" branch handles the reset when isConnected drops.
      setPhase('onboarding');
    } finally {
      abortControllerRef.current = null;
    }
  };

  const handleAutoConnectRef = useRef(handleAutoConnect);
  handleAutoConnectRef.current = handleAutoConnect;

  // Called by AnalyzeOnboarding when a new repo finishes indexing.
  // Connects directly to the newly-analyzed repo by name.
  const handleAnalyzeComplete = (repoName: string) => {
    autoConnectRan.current = true;
    setPhase('loading');
    setLoadingMessage('Loading graph...');
    // Connect to the specific repo that was just analyzed
    (async () => {
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      try {
        const result = await connectToServer(
          detectedBackendUrl,
          (p, downloaded, total) => {
            if (p === 'downloading') {
              const pct = total ? Math.round((downloaded / total) * 100) : null;
              setLoadingMessage(pct ? `Downloading graph... ${pct}%` : 'Downloading graph...');
            } else if (p === 'extracting') {
              setLoadingMessage('Processing graph...');
            }
          },
          abortController.signal,
          repoName,
        );
        if (onServerConnect) {
          await onServerConnect(result, detectedBackendUrl);
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Failed to load graph');
        setPhase('onboarding');
      } finally {
        abortControllerRef.current = null;
      }
    })();
  };

  // Track when the initial probe finishes
  useEffect(() => {
    if (!isProbing && !initialProbeComplete) {
      setInitialProbeComplete(true);
    }
  }, [isProbing, initialProbeComplete]);

  // Start polling once after initial probe fails
  useEffect(() => {
    if (initialProbeComplete && !isConnected && !isPolling && !autoConnectRan.current) {
      startPolling();
    }
  }, [initialProbeComplete, isConnected, isPolling, startPolling]);

  // Auto-connect when server is detected
  useEffect(() => {
    if (isConnected && !autoConnectRan.current) {
      autoConnectRan.current = true;
      stopPolling();
      setPhase('success');
      autoConnectTimerRef.current = setTimeout(() => {
        autoConnectTimerRef.current = null;
        handleAutoConnectRef.current();
      }, 1200); // hold success state long enough to register
    }
    // Server went away — reset to onboarding (or analyze if we were on analyze)
    if (!isConnected && autoConnectRan.current && !isProbing) {
      autoConnectRan.current = false;
      if (autoConnectTimerRef.current !== null) {
        clearTimeout(autoConnectTimerRef.current);
        autoConnectTimerRef.current = null;
      }
      setPhase('onboarding');
      setError(null);
    }
    // NOTE: No cleanup return here. The autoConnectTimerRef must survive effect
    // re-runs (e.g. isProbing flipping false while the 1200ms window is active).
    // The unmount cleanup effect below is the sole owner of timer cancellation.
  }, [isConnected, isProbing, stopPolling]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (autoConnectTimerRef.current !== null) clearTimeout(autoConnectTimerRef.current);
      abortControllerRef.current?.abort();
    };
  }, []);

  // Don't render until initial probe completes
  const displayPhase = !initialProbeComplete ? null : phase;

  return (
    <div className="flex min-h-screen items-center justify-center bg-void p-8">
      {/* Background gradient effects */}
      <div className="pointer-events-none fixed inset-0">
        <div className="absolute top-1/4 left-1/4 h-96 w-96 rounded-full bg-accent/10 blur-3xl" />
        <div className="absolute right-1/4 bottom-1/4 h-96 w-96 rounded-full bg-node-interface/10 blur-3xl" />
      </div>

      <div className="relative w-full max-w-lg">
        {/* Error — floats above the card */}
        {error && (
          <div className="mb-4 animate-fade-in rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-center text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Crossfade between phases */}
        {displayPhase && (
          <Crossfade activeKey={displayPhase}>
            {displayPhase === 'onboarding' && <OnboardingGuide isPolling={isPolling} />}
            {displayPhase === 'analyze' && <AnalyzeOnboarding onComplete={handleAnalyzeComplete} />}
            {displayPhase === 'success' && <SuccessCard />}
            {displayPhase === 'loading' && <LoadingCard message={loadingMessage} />}
          </Crossfade>
        )}
      </div>
    </div>
  );
};
