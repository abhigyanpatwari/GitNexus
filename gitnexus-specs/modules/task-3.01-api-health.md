# ⚙️ SPEC: TASK 3.01 - API HEALTH CHECK

**Scope:** Foundational endpoint to verify server status.
**Pipeline Integrity:**
- Route: `GET /api/health`
- Response Schema (Zod): `{ status: "ok" | "error", timestamp: string }`
**Failure Mode:** If database or external service is unreachable, return `503 Service Unavailable` with explicit error details. Do not fail silently.
