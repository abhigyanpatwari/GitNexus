/**
 * RepoAnalyzer
 *
 * Two input modes:
 *   - "github"  → GitHub URL (https://github.com/owner/repo)
 *   - "local"   → Select a local folder via the browser's native directory picker
 */

import { useState, useRef, useEffect, useId } from 'react';
import {
  Github,
  FolderOpen,
  Loader2,
  Check,
  ArrowRight,
  AlertCircle,
  Sparkles,
} from '@/lib/lucide-icons';
import {
  startAnalyze,
  cancelAnalyze,
  streamAnalyzeProgress,
  type JobProgress,
} from '../services/backend-client';
import { AnalyzeProgress } from './AnalyzeProgress';

// ── Helpers ──────────────────────────────────────────────────────────────────

type InputMode = 'github' | 'local';

const GITHUB_RE = /^https?:\/\/(www\.)?github\.com\/[^/\s]+\/[^/\s]+/i;
const IS_WINDOWS = navigator.userAgent.toLowerCase().includes('win');

function isValidGithubUrl(value: string): boolean {
  return GITHUB_RE.test(value.trim());
}

// ── Mode tabs ────────────────────────────────────────────────────────────────

function ModeTabs({ mode, onChange }: { mode: InputMode; onChange: (m: InputMode) => void }) {
  return (
    <div className="flex gap-1 rounded-lg bg-elevated p-1" role="tablist" aria-label="Input type">
      <button
        role="tab"
        aria-selected={mode === 'github'}
        onClick={() => onChange('github')}
        className={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-150 ${
          mode === 'github'
            ? 'bg-accent text-white shadow-sm'
            : 'text-text-muted hover:text-text-secondary'
        } `}
      >
        <Github className="h-3 w-3" />
        GitHub URL
      </button>
      <button
        role="tab"
        aria-selected={mode === 'local'}
        onClick={() => onChange('local')}
        className={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-150 ${
          mode === 'local'
            ? 'bg-accent text-white shadow-sm'
            : 'text-text-muted hover:text-text-secondary'
        } `}
      >
        <FolderOpen className="h-3 w-3" />
        Local Folder
      </button>
    </div>
  );
}

// ── Analyze button ───────────────────────────────────────────────────────────

function AnalyzeButton({
  canSubmit,
  isLoading,
  onClick,
  variant,
}: {
  canSubmit: boolean;
  isLoading: boolean;
  onClick: () => void;
  variant: 'onboarding' | 'sheet';
}) {
  const sizeClass =
    variant === 'onboarding' ? 'w-full px-5 py-3.5 text-sm' : 'w-full px-4 py-3 text-sm';
  return (
    <button
      onClick={onClick}
      disabled={!canSubmit || isLoading}
      className={` ${sizeClass} flex items-center justify-center gap-2.5 rounded-xl font-medium transition-all duration-200 ${
        canSubmit && !isLoading
          ? 'cursor-pointer bg-accent text-white shadow-glow-soft hover:-translate-y-0.5 hover:bg-accent/90 hover:shadow-glow'
          : 'cursor-not-allowed border border-border-subtle bg-elevated text-text-muted'
      } `}
    >
      {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
      <span>{isLoading ? 'Starting analysis...' : 'Analyze Repository'}</span>
      {canSubmit && !isLoading && <ArrowRight className="h-3.5 w-3.5" />}
    </button>
  );
}

// ── Done state ───────────────────────────────────────────────────────────────

function DoneState({ repoName }: { repoName: string }) {
  return (
    <div
      className="flex animate-fade-in flex-col items-center gap-3 py-4"
      role="status"
      aria-live="polite"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/15 shadow-[0_0_20px_rgba(16,185,129,0.15)]">
        <Check className="h-6 w-6 text-emerald-400" />
      </div>
      <div className="text-center">
        <p className="text-sm font-medium text-emerald-400">Analysis complete</p>
        <p className="mt-0.5 font-mono text-xs text-text-muted">{repoName}</p>
      </div>
      <p className="text-xs text-text-secondary">Loading graph...</p>
    </div>
  );
}

// ── RepoAnalyzer ─────────────────────────────────────────────────────────────

type InternalPhase = 'input' | 'starting' | 'analyzing' | 'done' | 'error';

export interface RepoAnalyzerProps {
  variant: 'onboarding' | 'sheet';
  onComplete: (repoName: string) => void;
  onCancel?: () => void;
}

export const RepoAnalyzer = ({ variant, onComplete, onCancel }: RepoAnalyzerProps) => {
  const inputId = useId();
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<InputMode>('github');
  const [githubUrl, setGithubUrl] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [phase, setPhase] = useState<InternalPhase>('input');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [progress, setProgress] = useState<JobProgress>({
    phase: 'queued',
    percent: 0,
    message: 'Queued',
  });
  const [completedRepoName, setCompletedRepoName] = useState('');

  const jobIdRef = useRef<string | null>(null);
  const sseControllerRef = useRef<AbortController | null>(null);
  const completeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      sseControllerRef.current?.abort();
      if (completeTimerRef.current) clearTimeout(completeTimerRef.current);
    };
  }, []);

  const handleModeChange = (m: InputMode) => {
    setMode(m);
    setGithubUrl('');
    setLocalPath('');
    setValidationError(null);
  };

  // Use the browser's native directory picker (webkitdirectory doesn't give paths,
  // so we use a text input + a "Browse" button that opens a standard file input
  // to let users pick files from the folder — the path is typed manually since
  // browsers don't expose absolute paths for security reasons).
  // For local paths, the user types or pastes the absolute path.

  const canSubmit =
    mode === 'github'
      ? isValidGithubUrl(githubUrl) && (phase === 'input' || phase === 'error')
      : localPath.trim().length > 1 && (phase === 'input' || phase === 'error');

  const handleAnalyze = async () => {
    if (mode === 'github' && !isValidGithubUrl(githubUrl)) {
      setValidationError('Please enter a valid GitHub repository URL.');
      return;
    }
    if (mode === 'local' && localPath.trim().length < 2) {
      setValidationError('Please enter a folder path.');
      return;
    }

    setValidationError(null);
    setPhase('starting');

    try {
      const request = mode === 'github' ? { url: githubUrl.trim() } : { path: localPath.trim() };
      const { jobId } = await startAnalyze(request);
      jobIdRef.current = jobId;
      setPhase('analyzing');

      const nameSource = mode === 'github' ? githubUrl.trim() : localPath.trim();
      const controller = streamAnalyzeProgress(
        jobId,
        (p) => setProgress(p),
        (data) => {
          const name =
            data.repoName ?? nameSource.split(/[/\\]/).filter(Boolean).at(-1) ?? 'repository';
          setCompletedRepoName(name);
          setPhase('done');
          sseControllerRef.current = null;
          completeTimerRef.current = setTimeout(() => {
            completeTimerRef.current = null;
            onComplete(name);
          }, 1200);
        },
        (errMsg) => {
          setValidationError(errMsg || 'Analysis failed. Check server logs.');
          setPhase('error');
        },
      );
      sseControllerRef.current = controller;
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : 'Failed to start analysis');
      setPhase('error');
    }
  };

  const handleCancel = async () => {
    sseControllerRef.current?.abort();
    sseControllerRef.current = null;
    if (jobIdRef.current) {
      try {
        await cancelAnalyze(jobIdRef.current);
      } catch {}
      jobIdRef.current = null;
    }
    setPhase('input');
    setProgress({ phase: 'queued', percent: 0, message: 'Queued' });
  };

  const isLoading = phase === 'starting';
  const showInput = phase !== 'analyzing' && phase !== 'done';
  const isWindows = IS_WINDOWS;

  return (
    <div className="space-y-4">
      {/* Mode tabs */}
      {showInput && <ModeTabs mode={mode} onChange={handleModeChange} />}

      {/* GitHub URL input */}
      {showInput && mode === 'github' && (
        <div className="space-y-2">
          <label
            htmlFor={inputId}
            className="block text-xs font-medium tracking-wider text-text-secondary uppercase"
          >
            GitHub Repository URL
          </label>
          <div
            className={`flex items-center gap-3 rounded-xl border bg-void px-4 py-3.5 transition-all duration-200 ${
              validationError && phase === 'error'
                ? 'border-red-500/50'
                : isValidGithubUrl(githubUrl)
                  ? 'border-accent/50 shadow-[0_0_0_3px_rgba(124,58,237,0.08)]'
                  : 'border-border-default focus-within:border-accent/40'
            } `}
          >
            <Github className="h-4 w-4 shrink-0 text-text-muted" />
            <input
              id={inputId}
              type="url"
              value={githubUrl}
              onChange={(e) => {
                setGithubUrl(e.target.value);
                if (validationError) setValidationError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit && !isLoading) {
                  e.preventDefault();
                  handleAnalyze();
                }
              }}
              disabled={isLoading}
              placeholder="https://github.com/owner/repo"
              autoComplete="url"
              spellCheck={false}
              className="flex-1 border-none bg-transparent font-mono text-sm text-text-primary outline-none placeholder:text-text-muted disabled:opacity-50"
            />
            {githubUrl.length > 10 && (
              <div className="shrink-0">
                {isValidGithubUrl(githubUrl) ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5 text-text-muted" />
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Local folder input */}
      {showInput && mode === 'local' && (
        <div className="space-y-2">
          <label
            htmlFor={`${inputId}-local`}
            className="block text-xs font-medium tracking-wider text-text-secondary uppercase"
          >
            Local Folder Path
          </label>
          <div
            className={`flex items-center gap-3 rounded-xl border bg-void px-4 py-3.5 transition-all duration-200 ${
              validationError && phase === 'error'
                ? 'border-red-500/50'
                : localPath.trim().length > 1
                  ? 'border-accent/50 shadow-[0_0_0_3px_rgba(124,58,237,0.08)]'
                  : 'border-border-default focus-within:border-accent/40'
            } `}
          >
            <FolderOpen className="h-4 w-4 shrink-0 text-text-muted" />
            <input
              id={`${inputId}-local`}
              type="text"
              value={localPath}
              onChange={(e) => {
                setLocalPath(e.target.value);
                if (validationError) setValidationError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit && !isLoading) {
                  e.preventDefault();
                  handleAnalyze();
                }
              }}
              disabled={isLoading}
              placeholder={isWindows ? 'C:\\Users\\you\\project' : '/home/you/project'}
              autoComplete="off"
              spellCheck={false}
              className="flex-1 border-none bg-transparent font-mono text-sm text-text-primary outline-none placeholder:text-text-muted disabled:opacity-50"
            />
            {localPath.trim().length > 1 && (
              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
            )}
          </div>
          {/* Native folder picker + Browse button — below the input */}
          <input
            ref={folderInputRef}
            type="file"
            // @ts-expect-error -- webkitdirectory is non-standard but widely supported
            webkitdirectory=""
            className="hidden"
            onChange={(e) => {
              const files = e.target.files;
              if (files && files.length > 0) {
                const rel = files[0].webkitRelativePath;
                const folderName = rel.split('/')[0];
                if (folderName) {
                  setLocalPath(folderName);
                  setValidationError(null);
                }
              }
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => folderInputRef.current?.click()}
            disabled={isLoading}
            className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-border-subtle bg-elevated px-3 py-2 text-xs font-medium text-text-secondary transition-all duration-150 hover:bg-hover hover:text-text-primary disabled:opacity-50"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Browse for folder
          </button>
        </div>
      )}

      {/* Error message */}
      {(phase === 'error' || (phase === 'input' && validationError)) && validationError && (
        <p className="flex animate-fade-in items-center gap-1.5 text-xs text-red-400">
          <AlertCircle className="h-3 w-3 shrink-0" />
          {validationError}
        </p>
      )}

      {/* Live progress */}
      {phase === 'analyzing' && (
        <div className="animate-slide-up">
          <AnalyzeProgress progress={progress} onCancel={handleCancel} />
        </div>
      )}

      {/* Done */}
      {phase === 'done' && <DoneState repoName={completedRepoName} />}

      {/* CTA button */}
      {(phase === 'input' || phase === 'starting') && (
        <AnalyzeButton
          canSubmit={canSubmit}
          isLoading={isLoading}
          onClick={handleAnalyze}
          variant={variant}
        />
      )}

      {/* Error retry */}
      {phase === 'error' && (
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              setValidationError(null);
              setPhase('input');
            }}
            className="flex-1 cursor-pointer rounded-xl border border-border-subtle bg-elevated px-4 py-2.5 text-sm text-text-secondary transition-all duration-200 hover:bg-hover hover:text-text-primary"
          >
            Try again
          </button>
          {onCancel && (
            <button
              onClick={onCancel}
              className="cursor-pointer px-4 py-2.5 text-sm text-text-muted transition-colors hover:text-text-secondary"
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      {/* Dismiss for sheet variant while analyzing */}
      {phase === 'analyzing' && variant === 'sheet' && onCancel && (
        <button
          onClick={onCancel}
          className="w-full cursor-pointer py-1 text-xs text-text-muted transition-colors hover:text-text-secondary"
        >
          Hide (analysis continues in background)
        </button>
      )}
    </div>
  );
};
