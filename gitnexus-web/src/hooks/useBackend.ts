import { useState, useEffect, useCallback, useRef } from 'react';
import {
  probeBackend,
  fetchRepos,
  setBackendUrl as setServiceUrl,
  getBackendUrl,
  type BackendRepo,
} from '../services/backend';
import { BACKEND_URL_DEBOUNCE_MS, DEFAULT_BACKEND_URL } from '../config/ui-constants';

// ── localStorage keys ────────────────────────────────────────────────────────

const LS_URL_KEY = 'gitnexus-backend-url';
const LS_REPO_KEY = 'gitnexus-backend-repo';
const DEFAULT_URL = DEFAULT_BACKEND_URL;

// ── Public interface ─────────────────────────────────────────────────────────

export interface UseBackendResult {
  /** Backend probe succeeded */
  isConnected: boolean;
  /** Currently checking connection */
  isProbing: boolean;
  /** Current backend URL */
  backendUrl: string;

  /** Available repos from the server */
  repos: BackendRepo[];
  /** Currently selected repo name */
  selectedRepo: string | null;

  /** Change the backend URL, persist to localStorage, and re-probe */
  setBackendUrl: (url: string) => void;
  /** Select a repo (persisted to localStorage) */
  selectRepo: (name: string) => void;
  /** Manually re-check the backend connection */
  probe: () => Promise<boolean>;
  /** Clear connection state and go back to browser-only mode */
  disconnect: () => void;
}

// ── Hook implementation ──────────────────────────────────────────────────────

export function useBackend(): UseBackendResult {
  // Read persisted values on first render only
  const [backendUrl, setUrlState] = useState<string>(() => {
    try {
      return localStorage.getItem(LS_URL_KEY) ?? DEFAULT_URL;
    } catch {
      return DEFAULT_URL;
    }
  });

  const [isConnected, setIsConnected] = useState(false);
  const [isProbing, setIsProbing] = useState(false);
  const [repos, setRepos] = useState<BackendRepo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LS_REPO_KEY);
    } catch {
      return null;
    }
  });

  // Race-condition guard: monotonically increasing probe ID
  const probeIdRef = useRef(0);
  // Debounce timer handle
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Core probe logic (not debounced) ─────────────────────────────────────

  const probe = useCallback(async (): Promise<boolean> => {
    const id = ++probeIdRef.current;
    setIsProbing(true);

    try {
      const ok = await probeBackend();

      // If a newer probe was started while we were in-flight, discard this result
      if (id !== probeIdRef.current) return false;

      setIsConnected(ok);

      if (ok) {
        try {
          const repoList = await fetchRepos();
          // Re-check: still the latest probe?
          if (id !== probeIdRef.current) return false;
          setRepos(repoList);
        } catch (err) {
          if (import.meta.env.DEV) {
            console.warn('Failed to fetch repos:', err);
          }
          if (id === probeIdRef.current) {
            setRepos([]);
          }
        }
      } else {
        setRepos([]);
      }

      return ok;
    } catch {
      if (id === probeIdRef.current) {
        setIsConnected(false);
        setRepos([]);
      }
      return false;
    } finally {
      if (id === probeIdRef.current) {
        setIsProbing(false);
      }
    }
  }, []);

  // ── setBackendUrl: persist, update service, trigger debounced re-probe ───

  const setBackendUrl = useCallback(
    (url: string) => {
      setUrlState(url);
      setServiceUrl(url);

      try {
        localStorage.setItem(LS_URL_KEY, url);
      } catch {
        // localStorage may be unavailable (e.g. incognito quota exceeded)
      }

      // Debounce: clear any pending probe, schedule a new one
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void probe();
      }, BACKEND_URL_DEBOUNCE_MS);
    },
    [probe],
  );

  // ── selectRepo: persist and update state ─────────────────────────────────

  const selectRepo = useCallback((name: string) => {
    setSelectedRepo(name);
    try {
      localStorage.setItem(LS_REPO_KEY, name);
    } catch {
      // localStorage may be unavailable
    }
  }, []);

  // ── disconnect: clear connection state (URL stays in localStorage) ───────

  const disconnect = useCallback(() => {
    // Bump probe ID so any in-flight probe is ignored
    probeIdRef.current++;
    setIsConnected(false);
    setIsProbing(false);
    setRepos([]);
    setSelectedRepo(null);
    try {
      localStorage.removeItem(LS_REPO_KEY);
    } catch {
      // localStorage may be unavailable
    }
  }, []);

  // ── Mount: sync service URL + auto-probe ─────────────────────────────────

  useEffect(() => {
    // Ensure the service module is in sync with the persisted URL
    setServiceUrl(backendUrl);
    void probe();

    // Cleanup debounce timer on unmount
    return () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
      }
    };
    // Only run on mount — backendUrl and probe are stable refs from useState/useCallback
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    isConnected,
    isProbing,
    backendUrl,
    repos,
    selectedRepo,
    setBackendUrl,
    selectRepo,
    probe,
    disconnect,
  };
}
