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
    <div className="p-7 bg-surface border border-border-default rounded-3xl animate-fade-in relative overflow-hidden">

      {/* Ambient glows — mirrors OnboardingGuide aesthetic */}
      <div className="absolute -top-28 -right-28 w-72 h-72 bg-accent/6 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-24 -left-24 w-56 h-56 bg-node-function/6 rounded-full blur-3xl pointer-events-none" />

      {/* Header */}
      <div className="relative mb-6">
        <div className="text-center">

          {/* Eyebrow */}
          <div className="inline-flex items-center gap-1.5 mb-2">
            <Sparkles className="w-3.5 h-3.5 text-accent/70" />
            <span className="text-[11px] text-accent/80 font-medium uppercase tracking-widest">
              GitNexus
            </span>
          </div>

          {/* Icon */}
          <div className="mx-auto w-14 h-14 mb-4 flex items-center justify-center rounded-2xl bg-gradient-to-br from-accent/20 to-accent-dim/10 border border-accent/30 shadow-glow-soft">
            <Github className="w-7 h-7 text-accent" />
          </div>

          <h2 className="text-lg font-semibold text-text-primary leading-snug">
            Analyze your first repository
          </h2>
          <p className="text-sm text-text-secondary mt-1.5 leading-relaxed max-w-xs mx-auto">
            Paste a GitHub URL and GitNexus will clone it, parse the code, and
            build a live knowledge graph — right in your browser.
          </p>
        </div>
      </div>

      {/* Analyzer form */}
      <div className="relative">
        <RepoAnalyzer
          variant="onboarding"
          onComplete={onComplete}
        />
      </div>

      {/* Footer hint */}
      <p className="mt-5 text-[11px] text-text-muted text-center leading-relaxed">
        Public repos only &middot; Cloned locally by the server &middot; No data leaves your machine
      </p>
    </div>
  );
};
