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
  Gitlab,
  AzureDevops,
  FolderOpen,
  Loader2,
  Check,
  ArrowRight,
  AlertCircle,
  Sparkles,
  Key,
} from '@/lib/lucide-icons';
import {
  startAnalyze,
  cancelAnalyze,
  streamAnalyzeProgress,
  uploadFolder,
  type JobProgress,
} from '../services/backend-client';
import { AnalyzeProgress } from './AnalyzeProgress';
import { filterRepoFiles } from '@/lib/upload-filter';
import { useTranslation } from 'react-i18next';

// ── Helpers ──────────────────────────────────────────────────────────────────

type InputMode = 'github' | 'gitlab' | 'azure' | 'local';

const GITHUB_RE = /^https?:\/\/(www\.)?github\.com\/[^/\s]+\/[^/\s]+/i;
const GITLAB_RE = /^https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+(\/.*)?$/i;
// One-or-more path segments before `/_git/`, so the legacy single-project
// cloud form (myorg.visualstudio.com/project/_git/repo) is accepted too —
// the backend already supports it (isAzureDevOpsUrl / extractRepoName).
const AZURE_RE = /^https?:\/\/[^/\s]+\/(?:[^/\s]+\/)+_git\/[^/\s]+/i;
const IS_WINDOWS = navigator.userAgent.toLowerCase().includes('win');

function isValidGithubUrl(value: string): boolean {
  return GITHUB_RE.test(value.trim());
}

function isValidGitlabUrl(value: string): boolean {
  return GITLAB_RE.test(value.trim());
}

function isValidAzureUrl(value: string): boolean {
  return AZURE_RE.test(value.trim());
}

// ── Mode tabs ────────────────────────────────────────────────────────────────

function ModeTabs({ mode, onChange }: { mode: InputMode; onChange: (m: InputMode) => void }) {
  const { t } = useTranslation('onboarding');

  return (
    <div
      className="flex gap-1 rounded-lg bg-elevated p-1"
      role="tablist"
      aria-label={t('repoAnalyzer.inputType')}
    >
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
        {t('repoAnalyzer.githubUrl')}
      </button>
      <button
        role="tab"
        aria-selected={mode === 'gitlab'}
        onClick={() => onChange('gitlab')}
        className={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-150 ${
          mode === 'gitlab'
            ? 'bg-accent text-white shadow-sm'
            : 'text-text-muted hover:text-text-secondary'
        } `}
      >
        <Gitlab className="h-3 w-3" />
        {t('repoAnalyzer.gitlabUrl')}
      </button>
      <button
        role="tab"
        aria-selected={mode === 'azure'}
        onClick={() => onChange('azure')}
        className={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-150 ${
          mode === 'azure'
            ? 'bg-accent text-white shadow-sm'
            : 'text-text-muted hover:text-text-secondary'
        } `}
      >
        <AzureDevops className="h-3 w-3" />
        {t('repoAnalyzer.azureDevOpsUrl')}
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
        {t('repoAnalyzer.localFolder')}
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
  const { t } = useTranslation('onboarding');
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
      <span>{isLoading ? t('repoAnalyzer.starting') : t('repoAnalyzer.analyzeRepository')}</span>
      {canSubmit && !isLoading && <ArrowRight className="h-3.5 w-3.5" />}
    </button>
  );
}

// ── Done state ───────────────────────────────────────────────────────────────

function DoneState({ repoName }: { repoName: string }) {
  const { t } = useTranslation('onboarding');

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
        <p className="text-sm font-medium text-emerald-400">{t('repoAnalyzer.complete')}</p>
        <p className="mt-0.5 font-mono text-xs text-text-muted">{repoName}</p>
      </div>
      <p className="text-xs text-text-secondary">{t('repoAnalyzer.loadingGraph')}</p>
    </div>
  );
}

// ── RepoAnalyzer ─────────────────────────────────────────────────────────────

type InternalPhase = 'input' | 'starting' | 'analyzing' | 'done' | 'error';

export interface RepoAnalyzerProps {
  variant: 'onboarding' | 'sheet';
  /**
   * Receives the repo IDENTITY to reconnect with — the analyzed path when the
   * server provides one (`repoPath` on the SSE complete event), otherwise the
   * display name. Never rendered; the done screen shows the display name.
   */
  onComplete: (repoIdentity: string) => void;
  onCancel?: () => void;
}

export const RepoAnalyzer = ({ variant, onComplete, onCancel }: RepoAnalyzerProps) => {
  const { t } = useTranslation(['common', 'errors', 'onboarding']);
  const inputId = useId();
  const [mode, setMode] = useState<InputMode>('github');
  const [uploading, setUploading] = useState(false);
  const [uploadSummary, setUploadSummary] = useState<{ count: number; dropped: number } | null>(
    null,
  );
  const [githubUrl, setGithubUrl] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [gitlabUrl, setGitlabUrl] = useState('');
  const [azureUrl, setAzureUrl] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [phase, setPhase] = useState<InternalPhase>('input');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [progress, setProgress] = useState<JobProgress>({
    phase: 'queued',
    percent: 0,
    message: t('common:analyzePhases.queued'),
  });
  const [completedRepoName, setCompletedRepoName] = useState('');

  const jobIdRef = useRef<string | null>(null);
  const sseControllerRef = useRef<AbortController | null>(null);
  // Owns the in-flight analyze/upload request. The controller doubles as the
  // staleness token: each request captures its own controller in a closure and
  // bails after the await when that controller was aborted, so a resolution
  // arriving after a mode switch / cancel / unmount can never drive state.
  const requestControllerRef = useRef<AbortController | null>(null);
  const completeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      sseControllerRef.current?.abort();
      requestControllerRef.current?.abort();
      if (completeTimerRef.current) clearTimeout(completeTimerRef.current);
    };
  }, []);

  // Abort any in-flight analyze/upload request so its settlement can't drive
  // state. Aborting is load-bearing: once a mode switch resets `uploading`,
  // the `uploading || isLoading` re-entry guard no longer covers the stale
  // request — only its aborted signal does.
  const invalidateRequest = (): void => {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
  };

  // Invalidate the previous request and hand the caller a fresh controller.
  const renewRequestController = (): AbortController => {
    invalidateRequest();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    return controller;
  };

  // An upload that resolved after invalidation has still created a server-side
  // job; cancel it so the single analyze slot isn't held for the job's full
  // duration. Upload-path only: every upload owns a fresh job (the server
  // stages each upload into a unique dir, never dedup-aliasing), whereas URL
  // analyzes dedup-alias by repo — the returned jobId may belong to a job
  // another session (or this user's own resubmit) is actively watching, so
  // cancelling on that path could kill a live analysis. A stale URL job is
  // left to finish: a same-URL resubmit re-attaches to it via dedup, and the
  // server's job timeout/TTL sweep bounds the slot occupancy.
  const cancelStaleUploadJob = (jobId: string): void => {
    void cancelAnalyze(jobId).catch(() => {});
  };

  const handleModeChange = (m: InputMode) => {
    // ModeTabs fires onChange on every click, including the already-active
    // tab — never abort the user's own in-flight request for a no-op click.
    if (m === mode) return;
    invalidateRequest();
    setMode(m);
    setGithubUrl('');
    setGithubToken('');
    setGitlabUrl('');
    setAzureUrl('');
    setLocalPath('');
    setValidationError(null);
    setUploadSummary(null);
    setUploading(false);
    // An aborted request no longer resolves to move `phase` off 'starting';
    // reset so the new mode's form is immediately usable (also clears a stale
    // 'error' phase). Only reachable while showInput is true.
    setPhase('input');
  };

  // Local-folder mode uploads the selected folder's files (the browser never
  // exposes an absolute path, so the old typed-path/browse approach couldn't
  // work — see handleFolderUpload). A typed server path is also still accepted.

  const canSubmit =
    mode === 'github'
      ? isValidGithubUrl(githubUrl) && (phase === 'input' || phase === 'error')
      : mode === 'gitlab'
        ? isValidGitlabUrl(gitlabUrl) && (phase === 'input' || phase === 'error')
        : mode === 'azure'
          ? isValidAzureUrl(azureUrl) && (phase === 'input' || phase === 'error')
          : localPath.trim().length > 1 && (phase === 'input' || phase === 'error');

  const handleAnalyze = async () => {
    if (mode === 'github' && !isValidGithubUrl(githubUrl)) {
      setValidationError(t('errors:invalidGithubUrl'));
      return;
    }
    if (mode === 'gitlab' && !isValidGitlabUrl(gitlabUrl)) {
      setValidationError('Please enter a valid GitLab repository URL.');
      return;
    }
    if (mode === 'azure' && !isValidAzureUrl(azureUrl)) {
      setValidationError(t('errors:invalidAzureDevOpsUrl'));
      return;
    }
    if (mode === 'local' && localPath.trim().length < 2) {
      setValidationError(t('errors:missingFolderPath'));
      return;
    }

    setValidationError(null);
    setPhase('starting');

    // Staleness guard only (no wire abort): the POST is short-lived and
    // self-terminates, but its resolution must not drive state after a mode
    // switch / cancel / unmount invalidated this request.
    const controller = renewRequestController();
    try {
      const request =
        mode === 'github'
          ? {
              url: githubUrl.trim(),
              ...(githubToken.trim() ? { token: githubToken.trim() } : {}),
            }
          : mode === 'gitlab'
            ? { url: gitlabUrl.trim() }
            : mode === 'azure'
              ? { url: azureUrl.trim() }
              : { path: localPath.trim() };
      const { jobId } = await startAnalyze(request);
      // Stale resolution: return without cancelling — URL jobIds may be
      // dedup-aliased to a job another session owns (see cancelStaleUploadJob).
      if (controller.signal.aborted) return;

      const nameSource =
        mode === 'github'
          ? githubUrl.trim()
          : mode === 'gitlab'
            ? gitlabUrl.trim()
            : mode === 'azure'
              ? azureUrl.trim()
              : localPath.trim();
      trackJob(jobId, nameSource);
    } catch (err) {
      // Unmount aborts the controller, so this also covers the unmounted case.
      if (controller.signal.aborted) return;
      setValidationError(err instanceof Error ? err.message : t('errors:startAnalysisFailed'));
      setPhase('error');
    }
  };

  // Drive an already-created analysis job through the SSE progress stream to
  // completion. Shared by the path/URL analyze flow and the folder-upload flow.
  const trackJob = (jobId: string, fallbackNameSource: string | null) => {
    // Callers reach here only with a live (non-aborted) request controller, so
    // the component is mounted — unmount aborts the controller.
    jobIdRef.current = jobId;
    setPhase('analyzing');
    const controller = streamAnalyzeProgress(
      jobId,
      (p) => setProgress(p),
      (data) => {
        // Display vs identity split: the done screen renders the display name
        // (never an absolute path), while onComplete receives the identity —
        // the analyzed path when the server provides it, so the reconnect
        // targets the exact repo even when basenames collide. Old servers omit
        // repoPath and degrade to today's name behavior.
        const displayName =
          data.repoName ??
          (fallbackNameSource
            ? fallbackNameSource.split(/[/\\]/).filter(Boolean).at(-1)
            : undefined) ??
          t('onboarding:repoAnalyzer.defaultRepoName');
        const identity = data.repoPath ?? displayName;
        setCompletedRepoName(displayName);
        setGithubToken('');
        setPhase('done');
        sseControllerRef.current = null;
        completeTimerRef.current = setTimeout(() => {
          completeTimerRef.current = null;
          onComplete(identity);
        }, 1200);
      },
      (errMsg) => {
        setValidationError(errMsg || t('errors:analysisFailed'));
        setPhase('error');
      },
    );
    sseControllerRef.current = controller;
  };

  // Upload a browser-selected folder (webkitdirectory) and start analysis. The
  // upload endpoint returns a jobId, which then joins the normal SSE flow.
  const handleFolderUpload = async (fileList: FileList) => {
    if (uploading || isLoading) return; // guard against a concurrent upload
    const { files, manifest, droppedCount } = filterRepoFiles(fileList);
    if (files.length === 0) {
      setValidationError(t('onboarding:repoAnalyzer.upload.empty'));
      return;
    }
    setValidationError(null);
    setUploadSummary({ count: files.length, dropped: droppedCount });
    setUploading(true);
    setPhase('starting');
    // The selected folder's name (manifest entries are `<folder>/<rest>`) is a
    // sensible fallback if the server's complete event omits repoName.
    const folderName = manifest[0]?.split('/')[0] ?? null;
    const controller = renewRequestController();
    try {
      const { jobId } = await uploadFolder(files, manifest, controller.signal);
      if (controller.signal.aborted) {
        // The abort raced the response: the server already created the job.
        // (Unmount aborts the controller, so this also covers unmounted.)
        cancelStaleUploadJob(jobId);
        return;
      }
      setUploading(false);
      trackJob(jobId, folderName);
    } catch (err) {
      // An abort surfaces in two shapes — BackendError('Request aborted')
      // when it lands during fetch, raw AbortError when it lands during the
      // response-body read — so branch on the closure controller's signal,
      // never on the error identity. In the second shape the server may have
      // already launched a job whose id we never learn; that orphan is bounded
      // by the server's job timeout and terminal-job TTL sweep.
      if (controller.signal.aborted) return;
      setUploading(false);
      setValidationError(err instanceof Error ? err.message : t('errors:startAnalysisFailed'));
      setPhase('error');
    }
  };

  const handleCancel = async () => {
    sseControllerRef.current?.abort();
    sseControllerRef.current = null;
    // Defensive: no UI path can reach handleCancel while a request is in
    // flight (the cancel affordance renders only at phase === 'analyzing'),
    // but invalidate it anyway so the guard topology has no holes.
    invalidateRequest();
    if (jobIdRef.current) {
      try {
        await cancelAnalyze(jobIdRef.current);
      } catch {}
      jobIdRef.current = null;
    }
    setGithubToken('');
    setPhase('input');
    setProgress({ phase: 'queued', percent: 0, message: t('common:analyzePhases.queued') });
    setUploading(false);
    setUploadSummary(null);
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
            {t('onboarding:repoAnalyzer.githubRepositoryUrl')}
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

          {/* Optional GitHub Personal Access Token for private repos */}
          <div className="space-y-1.5 pt-1">
            <label
              htmlFor={`${inputId}-token`}
              className="block text-xs font-medium tracking-wider text-text-secondary uppercase"
            >
              {t('onboarding:repoAnalyzer.githubTokenLabel')}
            </label>
            <div className="flex items-center gap-3 rounded-xl border border-border-default bg-void px-4 py-3 transition-all duration-200 focus-within:border-accent/40">
              <Key className="h-4 w-4 shrink-0 text-text-muted" />
              <input
                id={`${inputId}-token`}
                type="password"
                value={githubToken}
                onChange={(e) => setGithubToken(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canSubmit && !isLoading) {
                    e.preventDefault();
                    handleAnalyze();
                  }
                }}
                disabled={isLoading}
                placeholder={t('onboarding:repoAnalyzer.githubTokenPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                className="flex-1 border-none bg-transparent font-mono text-sm text-text-primary outline-none placeholder:text-text-muted disabled:opacity-50"
              />
            </div>
            <p className="text-xs text-text-muted">
              {t('onboarding:repoAnalyzer.githubTokenHelp')}
            </p>
          </div>
        </div>
      )}

      {/* GitLab URL input */}
      {showInput && mode === 'gitlab' && (
        <div className="space-y-2">
          <label
            htmlFor={inputId}
            className="block text-xs font-medium tracking-wider text-text-secondary uppercase"
          >
            {t('onboarding:repoAnalyzer.gitlabRepositoryUrl')}
          </label>
          <div
            className={`flex items-center gap-3 rounded-xl border bg-void px-4 py-3.5 transition-all duration-200 ${
              validationError && phase === 'error'
                ? 'border-red-500/50'
                : isValidGitlabUrl(gitlabUrl)
                  ? 'border-accent/50 shadow-[0_0_0_3px_rgba(124,58,237,0.08)]'
                  : 'border-border-default focus-within:border-accent/40'
            } `}
          >
            <Gitlab className="h-4 w-4 shrink-0 text-text-muted" />
            <input
              id={inputId}
              type="url"
              value={gitlabUrl}
              onChange={(e) => {
                setGitlabUrl(e.target.value);
                if (validationError) setValidationError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit && !isLoading) {
                  e.preventDefault();
                  handleAnalyze();
                }
              }}
              disabled={isLoading}
              placeholder="https://gitlab.com/owner/repo"
              autoComplete="url"
              spellCheck={false}
              className="flex-1 border-none bg-transparent font-mono text-sm text-text-primary outline-none placeholder:text-text-muted disabled:opacity-50"
            />
            {gitlabUrl.length > 10 && (
              <div className="shrink-0">
                {isValidGitlabUrl(gitlabUrl) ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5 text-text-muted" />
                )}
              </div>
            )}
          </div>
          <p className="text-xs text-text-muted">{t('onboarding:repoAnalyzer.gitlabSupported')}</p>
        </div>
      )}

      {/* Azure DevOps URL input */}
      {showInput && mode === 'azure' && (
        <div className="space-y-2">
          <label
            htmlFor={inputId}
            className="block text-xs font-medium tracking-wider text-text-secondary uppercase"
          >
            {t('onboarding:repoAnalyzer.azureDevOpsRepositoryUrl')}
          </label>
          <div
            className={`flex items-center gap-3 rounded-xl border bg-void px-4 py-3.5 transition-all duration-200 ${
              validationError && phase === 'error'
                ? 'border-red-500/50'
                : isValidAzureUrl(azureUrl)
                  ? 'border-accent/50 shadow-[0_0_0_3px_rgba(124,58,237,0.08)]'
                  : 'border-border-default focus-within:border-accent/40'
            } `}
          >
            <AzureDevops className="h-4 w-4 shrink-0 text-text-muted" />
            <input
              id={inputId}
              type="url"
              value={azureUrl}
              onChange={(e) => {
                setAzureUrl(e.target.value);
                if (validationError) setValidationError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit && !isLoading) {
                  e.preventDefault();
                  handleAnalyze();
                }
              }}
              disabled={isLoading}
              placeholder="http://azuredevops.example.com/Collection/Project/_git/Repo"
              autoComplete="url"
              spellCheck={false}
              className="flex-1 border-none bg-transparent font-mono text-sm text-text-primary outline-none placeholder:text-text-muted disabled:opacity-50"
            />
            {azureUrl.length > 10 && (
              <div className="shrink-0">
                {isValidAzureUrl(azureUrl) ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5 text-text-muted" />
                )}
              </div>
            )}
          </div>
          <p className="text-xs text-text-muted">
            {t('onboarding:repoAnalyzer.azureDevOpsSupported')}
          </p>
        </div>
      )}

      {/* Local folder input */}
      {showInput && mode === 'local' && (
        <div className="space-y-2">
          <label
            htmlFor={`${inputId}-local`}
            className="block text-xs font-medium tracking-wider text-text-secondary uppercase"
          >
            {t('onboarding:repoAnalyzer.localFolderPath')}
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
          {/* Upload a folder from your computer — no server path or mount needed.
              The browser can't expose an absolute path, so we upload the files. */}
          <input
            ref={folderInputRef}
            type="file"
            // @ts-expect-error -- webkitdirectory is non-standard but widely supported
            webkitdirectory=""
            multiple
            className="hidden"
            data-testid="folder-upload-input"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                handleFolderUpload(e.target.files);
              }
              e.target.value = '';
            }}
          />
          <button
            type="button"
            data-testid="upload-folder"
            onClick={() => folderInputRef.current?.click()}
            disabled={isLoading}
            className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-border-subtle bg-elevated px-3 py-2 text-xs font-medium text-text-secondary transition-all duration-150 hover:bg-hover hover:text-text-primary disabled:opacity-50"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {t('onboarding:repoAnalyzer.upload.button')}
          </button>
          {uploading && (
            <div role="status" aria-busy="true" data-testid="upload-progress" className="space-y-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-elevated">
                <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
              </div>
              <p className="text-xs text-text-muted">
                {t('onboarding:repoAnalyzer.upload.uploading')}
              </p>
            </div>
          )}
          {uploadSummary && !uploading && phase !== 'error' && (
            <p className="text-xs text-text-muted" data-testid="upload-summary">
              {t('onboarding:repoAnalyzer.upload.selected', {
                fileCount: uploadSummary.count,
                dropped: uploadSummary.dropped,
              })}
            </p>
          )}
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
            {t('common:actions.tryAgain')}
          </button>
          {onCancel && (
            <button
              onClick={onCancel}
              className="cursor-pointer px-4 py-2.5 text-sm text-text-muted transition-colors hover:text-text-secondary"
            >
              {t('common:actions.dismiss')}
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
          {t('onboarding:repoAnalyzer.hideBackground')}
        </button>
      )}
    </div>
  );
};
