const API_BASE = import.meta.env.VITE_API_BASE;

export async function handleUnfinalize(seasonId: string, roundId: string) {
  await fetch(`${API_BASE}/api/v1/admin/seasons/${seasonId}/rounds/${roundId}/unfinalize`, {
    method: 'POST',
  });
}
