/**
 * AnalyzeOnboarding
 *
 * The "empty state" card rendered inside DropZone's Crossfade when the server
 * is connected but zero repos are indexed. Replaces the generic error message
 * with a first-class GitHub URL input flow.
 *
 * Rendering context:
 *   DropZone (Crossfade, phase="analyze")
 *     └─ AnalyzeOnboarding
 *          └─ RepoAnalyzer (variant="onboarding")
 *
 * When the analysis job completes, onComplete fires with the repoName, and
 * DropZone's handleAutoConnect re-runs (now that repos > 0), transitioning
 * the app to the graph explorer.
 */

import { Sparkles, Github } from '@/lib/lucide-icons';
import { RepoAnalyzer } from './RepoAnalyzer';

interface AnalyzeOnboardingProps {
  /** Called when analysis finishes and the repo is ready to load. */
  onComplete: (repoName: string) => void;
}

export const AnalyzeOnboarding = ({ onComplete }: AnalyzeOnboardingProps) => {
  return (
    <div className="relative animate-fade-in overflow-hidden rounded-3xl border border-border-default bg-surface p-7">
      {/* Ambient glows — mirrors OnboardingGuide aesthetic */}
      <div className="pointer-events-none absolute -top-28 -right-28 h-72 w-72 rounded-full bg-accent/6 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -left-24 h-56 w-56 rounded-full bg-node-function/6 blur-3xl" />

      {/* Header */}
      <div className="relative mb-6">
        <div className="text-center">
          {/* Eyebrow */}
          <div className="mb-2 inline-flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-accent/70" />
            <span className="text-[11px] font-medium tracking-widest text-accent/80 uppercase">
              GitNexus
            </span>
          </div>

          {/* Icon */}
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-accent/30 bg-gradient-to-br from-accent/20 to-accent-dim/10 shadow-glow-soft">
            <Github className="h-7 w-7 text-accent" />
          </div>

          <h2 className="text-lg leading-snug font-semibold text-text-primary">
            Analyze your first repository
          </h2>
          <p className="mx-auto mt-1.5 max-w-xs text-sm leading-relaxed text-text-secondary">
            Paste a GitHub URL or an absolute local folder path from the machine running
            GitNexus. GitHub repos are cloned locally by the server, and local folders are
            analyzed in place.
          </p>
        </div>
      </div>

      {/* Analyzer form */}
      <div className="relative">
        <RepoAnalyzer variant="onboarding" onComplete={onComplete} />
      </div>

      {/* Footer hint */}
      <p className="mt-5 text-center text-[11px] leading-relaxed text-text-muted">
        GitHub URLs: public repos only, cloned locally by the server &middot; Local folders:
        analyzed in place from the server path &middot; No data leaves your machine
      </p>
    </div>
  );
};
