import axios from 'axios';

const API_BASE = process.env.API_BASE || '';

// A custom HTTP wrapper built on axios — it never calls the bare global
// `fetch()`, so the parse-phase auto-detector cannot flag it. Listing
// "doRequest" in `.gitnexusrc` `fetchWrappers` is what lets the routes phase
// trace its consumers (#1589/#1852 residual).
export async function doRequest(path: string, opts?: Record<string, unknown>) {
  return axios.get(`${API_BASE}${path}`, opts);
}
