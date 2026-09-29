import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  connectHeartbeat,
  fetchOpsSnapshot,
  getAuthToken,
  getBackendUrl,
  normalizeServerUrl,
  probeBackendStatus,
  setBackendUrl,
  streamOpsSnapshot,
  type OpsJobView,
  type OpsLaneMetrics,
  type OpsSnapshot,
} from '../services/backend-client';
import { DEFAULT_BACKEND_URL } from '../config/ui-constants';

/** GET /api/ops is 60/min; safety REST + immediate tick + 1s would 429. */
const OPS_POLL_INTERVAL_MS = 2_000;

const STATUS_COLORS: Record<OpsJobView['status'], string> = {
  queued: 'text-text-muted',
  cloning: 'text-sky-400',
  analyzing: 'text-amber-400',
  loading: 'text-violet-400',
  complete: 'text-emerald-400',
  failed: 'text-red-400',
};

const TONE_CLASS: Record<'default' | 'ok' | 'warn' | 'bad', string> = {
  default: 'border-border-default text-text-primary',
  ok: 'border-emerald-500/30 text-emerald-300',
  warn: 'border-amber-500/30 text-amber-300',
  bad: 'border-red-500/30 text-red-300',
};

const EMPTY_LANE_METRICS: OpsLaneMetrics = {
  total: 0,
  active: 0,
  queued: 0,
  complete: 0,
  failed: 0,
  byStatus: {
    queued: 0,
    cloning: 0,
    analyzing: 0,
    loading: 0,
    complete: 0,
    failed: 0,
  },
  avgDurationMs: null,
  maxDurationMs: null,
  activeProgressSum: 0,
};

const formatDuration = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
};

const formatClock = (ts: number): string =>
  new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

const MetricCard = ({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'ok' | 'warn' | 'bad';
}) => {
  const toneClass = TONE_CLASS[tone];
  return (
    <div className={`rounded-xl border bg-surface/80 px-4 py-3 ${toneClass}`}>
      <div className="text-[11px] tracking-wide text-text-muted uppercase">{label}</div>
      <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">{value}</div>
      {hint ? <div className="mt-1 text-xs text-text-secondary">{hint}</div> : null}
    </div>
  );
};

const JobRow = ({ job }: { job: OpsJobView }) => {
  const pct = Math.max(0, Math.min(100, job.progress.percent));
  return (
    <div
      className="rounded-lg border border-border-subtle bg-elevated/60 px-3 py-2.5"
      data-testid="ops-job"
      data-job-id={job.id}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-text-primary">
            {job.repoName || job.id.slice(0, 8)}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-text-muted">
            {job.lane} · {job.id.slice(0, 8)}
            {job.branch ? ` · ${job.branch}` : ''}
            {job.retryCount > 0 ? ` · retry ${job.retryCount}` : ''}
          </div>
        </div>
        <div className="flex items-center gap-3 text-right">
          <span
            className={`font-mono text-xs font-semibold uppercase ${STATUS_COLORS[job.status]}`}
          >
            {job.status}
          </span>
          <span className="font-mono text-xs text-text-muted">
            {formatDuration(job.durationMs)}
          </span>
        </div>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-void">
        <div
          className="h-full rounded-full bg-accent transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1.5 flex justify-between gap-2 text-[11px] text-text-secondary">
        <span className="truncate">{job.progress.message || job.progress.phase}</span>
        <span className="shrink-0 font-mono">{pct}%</span>
      </div>
      {job.error ? <div className="mt-1 truncate text-[11px] text-red-400">{job.error}</div> : null}
    </div>
  );
};

const LanePanel = ({
  title,
  jobs,
  metrics,
}: {
  title: string;
  jobs: OpsJobView[];
  metrics: OpsSnapshot['analyze']['metrics'];
}) => (
  <section className="flex min-h-0 flex-1 flex-col rounded-2xl border border-border-default bg-deep/80">
    <header className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
      <div>
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        <p className="text-xs text-text-muted">
          {metrics.active} active · {metrics.queued} queued · {metrics.complete} done ·{' '}
          {metrics.failed} failed
        </p>
      </div>
      <div className="text-right font-mono text-[11px] text-text-muted">
        <div>avg {metrics.avgDurationMs != null ? formatDuration(metrics.avgDurationMs) : '—'}</div>
        <div>max {metrics.maxDurationMs != null ? formatDuration(metrics.maxDurationMs) : '—'}</div>
      </div>
    </header>
    <div className="flex-1 space-y-2 overflow-y-auto p-3">
      {jobs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-subtle px-3 py-8 text-center text-sm text-text-muted">
          No jobs in this lane yet
        </div>
      ) : (
        jobs.map((job) => <JobRow key={`${job.lane}-${job.id}`} job={job} />)
      )}
    </div>
  </section>
);

export const ExecutionDashboard = () => {
  const [backendInput, setBackendInput] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('server') || getBackendUrl() || DEFAULT_BACKEND_URL;
  });
  // Applied URL the connection effect binds to — distinct from the input so
  // keystrokes do not restart SSE/heartbeat, and Connect always reconnects.
  const [connectedServer, setConnectedServer] = useState<string | null>(null);
  const [connectNonce, setConnectNonce] = useState(0);
  const [snapshot, setSnapshot] = useState<OpsSnapshot | null>(null);
  const [live, setLive] = useState(false);
  const [streamMode, setStreamMode] = useState<'sse' | 'poll' | 'offline'>('offline');
  const [error, setError] = useState<string | null>(null);
  const [lastTick, setLastTick] = useState<number | null>(null);
  const validationErrorRef = useRef(false);

  const applyBackend = useCallback((raw: string) => {
    try {
      const url = normalizeServerUrl(raw.trim() || DEFAULT_BACKEND_URL);
      setBackendUrl(url);
      setBackendInput(url);
      setConnectedServer(url);
      setSnapshot(null);
      setLastTick(null);
      setConnectNonce((n) => n + 1);
      const next = new URL(window.location.href);
      next.searchParams.set('view', 'ops');
      next.searchParams.set('server', url);
      window.history.replaceState({}, '', next.toString());
      validationErrorRef.current = false;
      setError(null);
    } catch (err) {
      validationErrorRef.current = true;
      setLive(false);
      setStreamMode('offline');
      setError(err instanceof Error ? err.message : 'Invalid backend URL');
    }
  }, []);

  useEffect(() => {
    // A `?server=` link must not carry the session's deploy token to another
    // origin on its own: prefill it and wait for Connect when a token is held.
    const linked = new URLSearchParams(window.location.search).get('server');
    if (linked && getAuthToken()) {
      let foreign: boolean;
      try {
        foreign = normalizeServerUrl(linked) !== getBackendUrl();
      } catch {
        // Invalid input: applyBackend below reports it without connecting.
        foreign = false;
      }
      if (foreign) return;
    }
    applyBackend(backendInput);
    // Mount-only: wire ?server= into the client once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!connectedServer) return;

    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let streamAbort: AbortController | undefined;
    let stopHeartbeat: (() => void) | undefined;

    const ingest = (next: OpsSnapshot) => {
      if (cancelled) return;
      setSnapshot(next);
      setLastTick(Date.now());
      // A failed Connect leaves this stream running; do not wipe its error.
      if (!validationErrorRef.current) setError(null);
      setLive(true);
    };

    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    };

    const startPolling = () => {
      if (cancelled) return;
      stopPolling();
      setStreamMode('poll');
      let polling = false;
      const tick = async () => {
        if (polling || cancelled) return;
        polling = true;
        try {
          const status = await probeBackendStatus();
          if (cancelled) return;
          if (status !== 'ok') {
            setLive(false);
            setError(status === 'unauthorized' ? 'Backend requires auth' : 'Backend unreachable');
            return;
          }
          ingest(await fetchOpsSnapshot());
        } catch (err) {
          if (cancelled) return;
          setLive(false);
          setError(err instanceof Error ? err.message : 'Failed to fetch ops snapshot');
        } finally {
          polling = false;
        }
      };
      void tick();
      pollTimer = setInterval(() => void tick(), OPS_POLL_INTERVAL_MS);
    };

    const start = async () => {
      const status = await probeBackendStatus();
      if (cancelled) return;
      if (status !== 'ok') {
        setLive(false);
        setError(status === 'unauthorized' ? 'Backend requires auth' : 'Backend unreachable');
        startPolling();
        return;
      }

      stopHeartbeat = connectHeartbeat(
        () => setLive(true),
        () => setLive(false),
      );

      streamAbort = streamOpsSnapshot(
        (next) => {
          // Safety poll may already be running after a transient REST miss.
          stopPolling();
          setStreamMode('sse');
          ingest(next);
        },
        () => {
          // Fall back to polling if SSE cannot stay up.
          streamAbort?.abort();
          streamAbort = undefined;
          startPolling();
        },
      );

      // Safety poll in case the first SSE frame is delayed.
      try {
        ingest(await fetchOpsSnapshot());
        if (cancelled) return;
        setStreamMode((mode) => (mode === 'offline' ? 'poll' : mode));
      } catch {
        // REST snapshot failed — do not abort a live SSE handshake. Polling
        // covers the gap until the stream opens or its own onError fires.
        startPolling();
      }
    };

    void start();

    return () => {
      cancelled = true;
      stopPolling();
      streamAbort?.abort();
      stopHeartbeat?.();
    };
  }, [connectedServer, connectNonce]);

  const allJobs = useMemo(() => {
    if (!snapshot) return [] as OpsJobView[];
    return [...snapshot.analyze.jobs, ...snapshot.embed.jobs].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }, [snapshot]);

  return (
    <div
      className="flex min-h-screen flex-col bg-void text-text-primary"
      data-testid="ops-dashboard"
    >
      <header className="border-b border-border-subtle bg-deep/90 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs tracking-[0.2em] text-accent uppercase">GitNexus</div>
            <h1 className="text-lg font-semibold">Execution Ops</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                live
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-red-500/40 bg-red-500/10 text-red-300'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-emerald-400' : 'bg-red-400'}`}
              />
              {live ? 'live' : 'offline'} · {streamMode}
            </span>
            {snapshot ? (
              <span className="font-mono text-[11px] text-text-muted">
                up {formatDuration(snapshot.uptimeMs)} · tick{' '}
                {lastTick ? formatClock(lastTick) : '—'}
              </span>
            ) : null}
          </div>
        </div>
        <form
          className="mx-auto mt-3 flex max-w-7xl gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            applyBackend(backendInput);
          }}
        >
          <input
            value={backendInput}
            onChange={(e) => setBackendInput(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-border-default bg-surface px-3 py-2 font-mono text-sm outline-none focus:border-accent"
            placeholder="http://localhost:4747"
            spellCheck={false}
          />
          <button
            type="submit"
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-dim"
          >
            Connect
          </button>
        </form>
        {error ? <p className="mx-auto mt-2 max-w-7xl text-sm text-red-400">{error}</p> : null}
      </header>

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 p-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <MetricCard
            label="Active jobs"
            value={snapshot?.totals.active ?? 0}
            tone={snapshot && snapshot.totals.active > 0 ? 'warn' : 'default'}
          />
          <MetricCard label="Completed" value={snapshot?.totals.complete ?? 0} tone="ok" />
          <MetricCard
            label="Failed"
            value={snapshot?.totals.failed ?? 0}
            tone={snapshot && snapshot.totals.failed > 0 ? 'bad' : 'default'}
          />
          <MetricCard
            label="Server"
            value={snapshot?.server.version ?? '—'}
            hint={
              snapshot
                ? `${snapshot.server.launchContext} · ${snapshot.server.nodeVersion}`
                : undefined
            }
          />
        </div>

        <div className="grid min-h-[28rem] flex-1 gap-4 lg:grid-cols-2">
          <LanePanel
            title="Analyze lane"
            jobs={snapshot?.analyze.jobs ?? []}
            metrics={snapshot?.analyze.metrics ?? EMPTY_LANE_METRICS}
          />
          <LanePanel
            title="Embed lane"
            jobs={snapshot?.embed.jobs ?? []}
            metrics={snapshot?.embed.metrics ?? EMPTY_LANE_METRICS}
          />
        </div>

        <section className="rounded-2xl border border-border-default bg-deep/80">
          <header className="border-b border-border-subtle px-4 py-3">
            <h2 className="text-sm font-semibold">Recent activity</h2>
            <p className="text-xs text-text-muted">Both lanes, newest first</p>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="text-[11px] tracking-wide text-text-muted uppercase">
                <tr className="border-b border-border-subtle">
                  <th className="px-4 py-2 font-medium">Lane</th>
                  <th className="px-4 py-2 font-medium">Repo</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Phase</th>
                  <th className="px-4 py-2 font-medium">%</th>
                  <th className="px-4 py-2 font-medium">Duration</th>
                  <th className="px-4 py-2 font-medium">Started</th>
                </tr>
              </thead>
              <tbody>
                {allJobs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-text-muted">
                      Waiting for analyze / embed jobs on the connected server…
                    </td>
                  </tr>
                ) : (
                  allJobs.map((job) => (
                    <tr key={`${job.lane}-${job.id}`} className="border-b border-border-subtle/60">
                      <td className="px-4 py-2 font-mono text-xs text-text-secondary">
                        {job.lane}
                      </td>
                      <td className="max-w-[14rem] truncate px-4 py-2">{job.repoName || '—'}</td>
                      <td
                        className={`px-4 py-2 font-mono text-xs uppercase ${STATUS_COLORS[job.status]}`}
                      >
                        {job.status}
                      </td>
                      <td className="max-w-[16rem] truncate px-4 py-2 text-text-secondary">
                        {job.progress.phase}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs">{job.progress.percent}%</td>
                      <td className="px-4 py-2 font-mono text-xs">
                        {formatDuration(job.durationMs)}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-text-muted">
                        {formatClock(job.startedAt)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
};
