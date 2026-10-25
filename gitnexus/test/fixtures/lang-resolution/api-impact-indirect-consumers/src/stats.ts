import { apiFetch } from './api';

// The request goes through the wrapper, and a helper shares its line again.
export function fetchStats() {
  const pick = (res: Response) => res.json(); return apiFetch('/api/stats').then(pick);
}
