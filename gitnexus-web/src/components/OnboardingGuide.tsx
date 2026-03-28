import { useState, useRef, useEffect } from 'react';
import { Check, Copy, Terminal, Server, Zap, Sparkles } from '@/lib/lucide-icons';
import { REQUIRED_NODE_VERSION } from '../config/ui-constants';

// ── Design constants ─────────────────────────────────────────────────────────

const isDev = import.meta.env.DEV;

// ── Copy-to-clipboard button ─────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API requires secure context; localhost qualifies
    }
  };

  return (
    <button
      onClick={handleCopy}
      aria-label={copied ? 'Copied!' : 'Copy to clipboard'}
      className={`
        shrink-0 px-2 py-1 rounded-md cursor-pointer
        transition-all duration-200
        focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none
        ${copied
          ? 'text-emerald-400 bg-emerald-400/10'
          : 'text-text-muted hover:text-text-primary hover:bg-white/5'
        }
      `}
    >
      {copied
        ? <Check className="w-3.5 h-3.5" />
        : <Copy className="w-3.5 h-3.5" />
      }
    </button>
  );
}

// ── Faux terminal window ─────────────────────────────────────────────────────

function TerminalWindow({
  command,
  label,
  isActive = false,
}: {
  command: string;
  label: string;
  isActive?: boolean;
}) {
  return (
    <div
      className={`
        rounded-xl overflow-hidden border transition-all duration-300
        ${isActive
          ? 'border-accent/40 shadow-glow-soft'
          : 'border-border-default hover:border-accent/20 hover:shadow-glow-soft'
        }
      `}
    >
      {/* Title bar */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-deep border-b border-border-subtle">
        <div className="flex gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
          <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/60" />
        </div>
        <span className="flex-1 text-[11px] text-text-muted text-center font-mono">{label}</span>
        <CopyButton text={command} />
      </div>
      {/* Command body */}
      <div className="px-4 py-3.5 bg-void font-mono text-sm flex items-center gap-3">
        <span className="text-accent/60 select-none" aria-hidden="true">$</span>
        <code className="flex-1 overflow-x-auto whitespace-nowrap text-text-primary tracking-wide">
          {command}
        </code>
      </div>
    </div>
  );
}

// ── Step indicator ───────────────────────────────────────────────────────────

type StepState = 'waiting' | 'active' | 'done';

function StepDot({ state, number }: { state: StepState; number: number }) {
  if (state === 'done') {
    return (
      <div className="w-6 h-6 rounded-full bg-emerald-500/20 border border-emerald-500/50 flex items-center justify-center shrink-0">
        <Check className="w-3 h-3 text-emerald-400" />
      </div>
    );
  }
  if (state === 'active') {
    return (
      <div className="relative w-6 h-6 shrink-0 flex items-center justify-center">
        <div className="absolute inset-0 rounded-full border border-accent/30 animate-ping" />
        <div className="w-6 h-6 rounded-full bg-accent/20 border border-accent/60 flex items-center justify-center">
          <span className="text-[10px] font-semibold text-accent leading-none">{number}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="w-6 h-6 rounded-full bg-elevated border border-border-subtle flex items-center justify-center shrink-0">
      <span className="text-[10px] font-semibold text-text-muted leading-none">{number}</span>
    </div>
  );
}

function StepRow({
  state,
  number,
  title,
  description,
  children,
}: {
  state: StepState;
  number: number;
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  const isVisible = state !== 'waiting';

  return (
    <div
      className={`
        transition-all duration-300
        ${state === 'waiting' ? 'opacity-40' : 'opacity-100'}
      `}
    >
      <div className="flex items-start gap-3">
        <StepDot state={state} number={number} />
        <div className="flex-1 min-w-0 pt-0.5">
          <div className="flex items-center gap-2">
            <span
              className={`text-sm font-medium transition-colors duration-200 ${
                state === 'done'
                  ? 'text-emerald-400'
                  : state === 'active'
                  ? 'text-text-primary'
                  : 'text-text-muted'
              }`}
            >
              {title}
            </span>
            {state === 'done' && (
              <span className="text-[10px] text-emerald-400/60 font-mono uppercase tracking-wider animate-fade-in">
                done
              </span>
            )}
          </div>
          {description && (
            <p className="text-xs text-text-muted mt-0.5 leading-relaxed">{description}</p>
          )}
          {isVisible && children && (
            <div className="mt-3 animate-slide-up">{children}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Polling status bar ────────────────────────────────────────────────────────

function PollingBar() {
  return (
    <div
      className="flex items-center gap-3 px-4 py-3 rounded-xl bg-accent/5 border border-accent/15 animate-fade-in"
      aria-live="polite"
      role="status"
    >
      <div className="relative shrink-0">
        <Zap className="w-4 h-4 text-accent/70" />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-5 h-5 rounded-full border border-accent/25 animate-pulse" />
        </div>
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-text-secondary">
          Listening for server
          <span className="inline-flex ml-0.5 text-text-muted">
            <span className="animate-pulse">...</span>
          </span>
        </p>
        <p className="text-[11px] text-text-muted mt-0.5">
          Will auto-connect when detected
        </p>
      </div>
    </div>
  );
}

// ── OnboardingGuide ───────────────────────────────────────────────────────────

interface OnboardingGuideProps {
  isPolling?: boolean;
}

export const OnboardingGuide = ({ isPolling }: OnboardingGuideProps) => {
  const primary    = isDev ? 'cd gitnexus && npm run serve' : 'npx gitnexus@latest serve';
  const termLabel  = isDev ? 'Start backend' : 'Terminal';

  // Step states: step 1 = copy command, step 2 = run/wait, step 3 = auto-connect
  // Once polling starts the user has presumably run the command — mark step 1 done.
  const step1State: StepState = isPolling ? 'done' : 'active';
  const step2State: StepState = isPolling ? 'active' : 'waiting';
  const step3State: StepState = 'waiting';

  return (
    <div className="p-7 bg-surface border border-border-default rounded-3xl animate-fade-in relative overflow-hidden">

      {/* Ambient background glows */}
      <div className="absolute -top-28 -right-28 w-72 h-72 bg-accent/6 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-24 -left-24 w-56 h-56 bg-node-function/6 rounded-full blur-3xl pointer-events-none" />

      {/* ── Headline ─────────────────────────────────────────────── */}
      <div className="relative mb-6">
        <div className="text-center">
          <div className="inline-flex items-center gap-1.5 mb-2">
            <Sparkles className="w-3.5 h-3.5 text-accent/70" />
            <span className="text-[11px] text-accent/80 font-medium uppercase tracking-widest">
              GitNexus
            </span>
          </div>
          <h2 className="text-lg font-semibold text-text-primary leading-snug">
            Start your local server
          </h2>
          <p className="text-sm text-text-secondary mt-1 leading-relaxed max-w-xs mx-auto">
            {isDev
              ? 'Fire up the Express backend in a separate terminal to unlock the full graph.'
              : 'One command is all it takes. The browser connects automatically.'}
          </p>
        </div>
      </div>

      {/* ── Step-by-step flow ───────────────────────────────────────── */}
      <div className="relative space-y-5">

        {/* Vertical connector line behind the dots */}
        <div
          className="absolute left-[11px] top-6 bottom-6 w-px bg-border-subtle pointer-events-none"
          aria-hidden="true"
        />

        {/* Step 1 — Copy the command */}
        <StepRow
          state={step1State}
          number={1}
          title="Copy the command"
          description={isPolling ? undefined : 'Click the icon in the terminal to copy.'}
        >
          <TerminalWindow
            command={primary}
            label={termLabel}
            isActive={step1State === 'active'}
          />

          {/* Secondary global-install option — production only */}
          {!isDev && (
            <>
              <div className="flex items-center gap-3 my-3">
                <div className="flex-1 h-px bg-border-subtle" />
                <span className="text-[11px] text-text-muted uppercase tracking-widest">or install globally</span>
                <div className="flex-1 h-px bg-border-subtle" />
              </div>
              <TerminalWindow
                command="npm install -g gitnexus && gitnexus serve"
                label="Global install"
                isActive={false}
              />
            </>
          )}
        </StepRow>

        {/* Step 2 — Run and wait */}
        <StepRow
          state={step2State}
          number={2}
          title={isPolling ? 'Waiting for server to start' : 'Paste and run in your terminal'}
          description={
            isPolling
              ? undefined
              : 'Open a new terminal window, paste, and hit Enter.'
          }
        >
          {isPolling && <PollingBar />}
        </StepRow>

        {/* Step 3 — Auto-connect */}
        <StepRow
          state={step3State}
          number={3}
          title="Auto-connects and opens the graph"
          description="No refresh needed — the page detects the server automatically."
        />
      </div>

      {/* ── Prerequisite footnote ────────────────────────────────────── */}
      <div className="mt-6 pt-5 border-t border-border-subtle flex items-center justify-center gap-1.5 text-xs text-text-muted">
        <Server className="w-3 h-3 shrink-0" />
        <span>
          Requires{' '}
          <a
            href="https://nodejs.org"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:text-accent/80 hover:underline transition-colors"
          >
            Node.js {REQUIRED_NODE_VERSION}+
          </a>
        </span>
        <span className="text-border-default mx-1">·</span>
        <Terminal className="w-3 h-3 shrink-0" />
        <span>Port 4747</span>
      </div>
    </div>
  );
};
