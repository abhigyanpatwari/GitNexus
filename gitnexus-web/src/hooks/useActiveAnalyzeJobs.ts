import { useEffect, useRef, useState } from 'react';
import {
  fetchActiveAnalyzeJobs,
  getAnalyzeStatus,
  type ActiveAnalyzeJob,
} from '../services/backend-client';

/** `GET /api/analyze` allows 60 requests/min per IP; 3s leaves room for other tabs. */
export const ACTIVE_ANALYZE_POLL_MS = 3_000;

/**
 * Poll the server's running analyze jobs while `enabled` (#1584).
 *
 * `readyRepoIds` collects repos whose job was seen running and then completed,
 * so the repo switcher can mark them ready. Both lists reset when disabled.
 */
export function useActiveAnalyzeJobs(enabled: boolean, onJobComplete?: () => void) {
  const [jobs, setJobs] = useState<ActiveAnalyzeJob[]>([]);
  const [readyRepoIds, setReadyRepoIds] = useState<string[]>([]);
  const onJobCompleteRef = useRef(onJobComplete);
  onJobCompleteRef.current = onJobComplete;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let inFlight = false;
    let previous: ActiveAnalyzeJob[] = [];

    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const current = await fetchActiveAnalyzeJobs().catch(() => null);
        if (cancelled || !current) return;
        const finished = previous.filter((job) => !current.some((c) => c.id === job.id));
        previous = current;
        setJobs(current);
        // A job that left the list either completed or failed; only a
        // completed one is "ready".
        for (const job of finished) {
          const final = await getAnalyzeStatus(job.id).catch(() => null);
          if (cancelled || final?.status !== 'complete') continue;
          const repoId = job.repoId;
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
      setReadyRepoIds([]);
    };
  }, [enabled]);

  return { jobs, readyRepoIds };
}
