import { useEffect, useRef, useState } from 'react';
import {
  BackendError,
  fetchActiveAnalyzeJobs,
  getAnalyzeStatus,
  type ActiveAnalyzeJob,
} from '../services/backend-client';

/** `GET /api/analyze` allows 60 requests/min per IP; 3s is 20/min for the visible tab. */
export const ACTIVE_ANALYZE_POLL_MS = 3_000;

/** Pause after a 429 that carries no Retry-After: the limiter's window length. */
const RATE_LIMIT_FALLBACK_MS = 60_000;

/**
 * Poll the server's running analyze jobs while `enabled` (#1584).
 *
 * `readyRepoIds` collects repos whose job was seen running and then completed,
 * so the repo switcher can mark them ready. Seen jobs and Ready repos survive
 * `enabled` toggling (the dropdown closing), so a job that finishes while the
 * switcher is closed is still marked Ready when it reopens.
 */
export function useActiveAnalyzeJobs(enabled: boolean, onJobComplete?: () => void) {
  const [jobs, setJobs] = useState<ActiveAnalyzeJob[]>([]);
  const [readyRepoIds, setReadyRepoIds] = useState<string[]>([]);
  const onJobCompleteRef = useRef(onJobComplete);
  onJobCompleteRef.current = onJobComplete;
  const seenRef = useRef<ActiveAnalyzeJob[]>([]);
  // Jobs that left the list but whose outcome lookup failed; retried next poll.
  const unconfirmedRef = useRef<ActiveAnalyzeJob[]>([]);
  const pausedUntilRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let inFlight = false;

    const poll = async () => {
      // Background tabs skip polling so several open tabs stay under the route's
      // per-IP limit; the visible tab catches up on its next tick.
      if (inFlight || document.hidden || Date.now() < pausedUntilRef.current) return;
      inFlight = true;
      try {
        const current = await fetchActiveAnalyzeJobs().catch((err) => {
          // On a 429, wait out the server's Retry-After instead of polling into
          // the limit again; the first poll after it refreshes the state.
          if (err instanceof BackendError && err.code === 'rate_limited') {
            pausedUntilRef.current = Date.now() + (err.retryAfterMs ?? RATE_LIMIT_FALLBACK_MS);
          }
          return null;
        });
        if (cancelled || !current) return;
        const finished = [
          ...unconfirmedRef.current,
          ...seenRef.current.filter((job) => !current.some((c) => c.id === job.id)),
        ];
        seenRef.current = current;
        unconfirmedRef.current = [];
        setJobs(current);
        // A job that left the list either completed or failed; only a
        // completed one is "ready".
        for (const [index, job] of finished.entries()) {
          // Closed mid-loop: keep the rest for the next time polling starts.
          if (cancelled) {
            unconfirmedRef.current.push(...finished.slice(index));
            return;
          }
          let final;
          try {
            final = await getAnalyzeStatus(job.id);
          } catch (err) {
            // A 404 means the job is gone (TTL sweep or server restart): drop it.
            if (!(err instanceof BackendError && err.code === 'not_found')) {
              unconfirmedRef.current.push(job);
            }
            continue;
          }
          if (final.status !== 'complete') continue;
          const repoId = final.repoId ?? job.repoId;
          if (repoId) setReadyRepoIds((ids) => (ids.includes(repoId) ? ids : [...ids, repoId]));
          onJobCompleteRef.current?.();
        }
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), ACTIVE_ANALYZE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      setJobs([]);
    };
  }, [enabled]);

  return { jobs, readyRepoIds };
}
